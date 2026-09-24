require('dotenv').config();
const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const OpenAI = require('openai');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// YouTube OAuth is persisted in Supabase so Render restarts/redeploys do not disconnect the channel.
// Tokens are encrypted server-side with AES-256-GCM before being stored.
let youtubeTokens = null;
let youtubeProfileCache = null;
let youtubeLoaded = false;

function cleanEnvValue(value) {
  return String(value || '').replace(/\s+/g, '').replace(/^(['"])(.*)\\1$/, '$2').trim();
}

function supabaseEnv() {
  return {
    url: cleanEnvValue(process.env.SUPABASE_URL).replace(/\/+$/, ''),
    key: cleanEnvValue(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

function supabaseConfigured() {
  const { url, key } = supabaseEnv();
  return Boolean(url && key && process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
}

function encryptionKey() {
  const raw = process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptTokens(tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(x => x.toString('base64')).join('.');
}

function decryptTokens(value) {
  const [iv64, tag64, data64] = String(value || '').split('.');
  if (!iv64 || !tag64 || !data64) throw new Error('Token cifrado inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8'));
}

async function supabaseRequest(route, options = {}) {
  if (!supabaseConfigured()) return null;
  const { url, key } = supabaseEnv();

  const supabase = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });

  const path = String(route);
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);

  if (path.startsWith('youtube_connections') && options.method === 'GET') {
    let request = supabase.from('youtube_connections').select(params.get('select') || '*');
    if (params.has('id')) {
      const rawId = params.get('id');
      request = request.eq('id', rawId.startsWith('eq.') ? rawId.slice(3) : rawId);
    }
    if (params.has('limit')) request = request.limit(Number(params.get('limit')));
    const result = await request;
    if (result.error) throw new Error(`Supabase ${result.status || 400}: ${result.error.message}`);
    return result.data;
  }

  if (path.startsWith('youtube_connections') && options.method === 'DELETE') {
    let request = supabase.from('youtube_connections').delete();
    if (params.has('id')) {
      const rawId = params.get('id');
      request = request.eq('id', rawId.startsWith('eq.') ? rawId.slice(3) : rawId);
    }
    const result = await request;
    if (result.error) throw new Error(`Supabase ${result.status || 400}: ${result.error.message}`);
    return result.data;
  }

  if (path.startsWith('youtube_connections') && options.method === 'POST') {
    const body = JSON.parse(options.body || '{}');
    const result = await supabase.from('youtube_connections').upsert(body, {
      onConflict: 'id',
      ignoreDuplicates: false
    });
    if (result.error) throw new Error(`Supabase ${result.status || 400}: ${result.error.message}`);
    return result.data;
  }

  throw new Error('Método Supabase no soportado.');
}

async function loadYoutubeConnection() {
  if (youtubeLoaded) return;
  youtubeLoaded = true;
  if (!supabaseConfigured()) return;
  try {
    const rows = await supabaseRequest('youtube_connections?id=eq.default&select=*', { method: 'GET' });
    const row = rows?.[0];
    if (row?.tokens_encrypted) youtubeTokens = decryptTokens(row.tokens_encrypted);
    if (row?.profile) youtubeProfileCache = row.profile;
  } catch (err) {
    youtubeLoaded = false;
    console.error('No se pudo cargar la conexión de YouTube desde Supabase:', err.message);
  }
}

async function saveYoutubeConnection() {
  if (!supabaseConfigured() || !youtubeTokens) return;
  await supabaseRequest('youtube_connections?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: 'default',
      tokens_encrypted: encryptTokens(youtubeTokens),
      profile: youtubeProfileCache,
      updated_at: new Date().toISOString()
    })
  });
}

async function getYoutubeProfile() {
  await loadYoutubeConnection();
  if (!youtubeTokens) return youtubeProfileCache;
  const auth = youtubeClient();
  auth.setCredentials(youtubeTokens);
  auth.on('tokens', async (newTokens) => {
    youtubeTokens = { ...youtubeTokens, ...newTokens };
    try { await saveYoutubeConnection(); } catch (err) { console.error('No se pudo guardar el token actualizado:', err.message); }
  });
  const youtube = google.youtube({ version: 'v3', auth });
  const response = await youtube.channels.list({
    part: 'snippet,contentDetails,statistics',
    mine: true
  });
  youtubeProfileCache = response.data.items?.[0] || null;
  return youtubeProfileCache;
}

const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function youtubeClient() {
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI || `${process.env.APP_URL || `http://localhost:${PORT}`}/api/youtube/callback`
  );
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'AutoTube', configured: {
    openai: Boolean(process.env.OPENAI_API_KEY),
    youtube: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET),
    pexels: Boolean(process.env.PEXELS_API_KEY),
    pixabay: Boolean(process.env.PIXABAY_API_KEY),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    supabase: supabaseConfigured()
  }});
});

app.get('/api/supabase/status', async (_req, res) => {
  if (!supabaseConfigured()) {
    return res.status(503).json({
      configured: false,
      error: 'Faltan SUPABASE_URL, SUPABASE_SECRET_KEY y/o YOUTUBE_TOKEN_ENCRYPTION_KEY.'
    });
  }
  const { url, key } = supabaseEnv();
  try {
    const rows = await supabaseRequest('youtube_connections?select=id&limit=1', { method: 'GET' });
    res.json({
      configured: true,
      ok: true,
      host: new URL(url).host,
      keyType: key.startsWith('sb_secret_') ? 'secret' : key.startsWith('sb_publishable_') ? 'publishable' : 'legacy/unknown',
      rows: rows?.length || 0
    });
  } catch (err) {
    res.status(502).json({
      configured: true,
      ok: false,
      host: new URL(url).host,
      keyType: key.startsWith('sb_secret_') ? 'secret' : key.startsWith('sb_publishable_') ? 'publishable' : 'legacy/unknown',
      error: err.message
    });
  }
});

app.get('/api/youtube/auth', (_req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    return res.status(503).send('YouTube no está configurado en el servidor.');
  }
  const url = youtubeClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']
  });
  // Redirect directly to Google. This avoids popup/fetch restrictions in Safari and Chrome.
  res.redirect(url);
});

app.get('/api/youtube/callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).send('Falta el código OAuth.');
    const { tokens } = await youtubeClient().getToken(req.query.code);
    youtubeTokens = tokens;
    youtubeProfileCache = null;
    youtubeLoaded = true;
    await getYoutubeProfile();

    // OAuth with Google must not fail just because persistence in Supabase is unavailable.
    // Keep the connection active in memory and report persistence separately.
    let persistenceError = null;
    try {
      await saveYoutubeConnection();
    } catch (err) {
      persistenceError = err.message;
      console.error('YouTube conectado, pero no se pudo guardar en Supabase:', err.message);
    }

    // Always return to the actual AutoTube origin. APP_URL is optional; when Render is
    // behind a proxy, use the forwarded protocol + host so OAuth never gets stuck on callback.
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'https';
    const host = req.get('host');
    const appOrigin = (process.env.APP_URL || (host ? `${protocol}://${host}` : '')).replace(/\/+$/, '');
    const safeOrigin = JSON.stringify(appOrigin);
    const persistenceNote = persistenceError
      ? '<p style="font-family:system-ui">La cuenta de YouTube está conectada. La persistencia está pendiente de Supabase.</p>'
      : '';
    res.send('<script>' +
      'const target=' + safeOrigin + '+"/";' +
      'if(window.opener){window.opener.postMessage({type:"youtube_connected"},' + safeOrigin + ');window.opener.location.href=target;window.close();}' +
      'else{window.location.replace(target);}' +
      '</script><p style="font-family:system-ui">YouTube conectado. Volviendo a AutoTube…</p>' +
      persistenceNote);
    console.log('YouTube OAuth completed. Token received:', Boolean(tokens.access_token), 'Persisted:', !persistenceError);
  } catch (err) {
    console.error('YouTube OAuth callback error:', err);
    const detail = err?.response?.data?.error_description || err?.response?.data?.error?.message || err?.message || 'Error desconocido';
    res.status(500).send('No se pudo completar la conexión con YouTube.<br><small>' + String(detail).replace(/[<>]/g, '') + '</small>');
  }
});

app.get('/api/youtube/profile', async (_req, res) => {
  try {
    const profile = await getYoutubeProfile();
    if (!profile) return res.status(404).json({ connected: false });
    const snippet = profile.snippet || {};
    const statistics = profile.statistics || {};
    res.json({
      connected: true,
      channelId: profile.id,
      title: snippet.title || 'Canal de YouTube',
      description: snippet.description || '',
      handle: snippet.customUrl || '',
      avatar: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
      subscribers: statistics.subscriberCount || '0',
      videos: statistics.videoCount || '0',
      views: statistics.viewCount || '0'
    });
  } catch (err) {
    console.error(err);
    res.status(401).json({ connected: false, error: 'No se pudo obtener el perfil de YouTube.' });
  }
});

app.post('/api/youtube/disconnect', async (_req, res) => {
  try {
    await loadYoutubeConnection();
    if (supabaseConfigured()) {
      await supabaseRequest('youtube_connections?id=eq.default', { method: 'DELETE' });
    }
    youtubeTokens = null;
    youtubeProfileCache = null;
    youtubeLoaded = true;
    res.json({ connected: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo desconectar YouTube.' });
  }
});

app.post('/api/ai/outline', async (req, res) => {
  try {
    const { topic, language = 'es', duration = '8' } = req.body || {};
    if (!topic) return res.status(400).json({ error: 'Indica un tema.' });
    if (!process.env.OPENAI_API_KEY) {
      return res.json({ demo: true, title: `Ideas para un vídeo sobre ${topic}`, outline: [
        'Gancho inicial', 'Contexto y promesa', 'Desarrollo en 3 bloques', 'Cierre y llamada a la acción'
      ], note: 'Conecta OPENAI_API_KEY para generar con IA.' });
    }
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'Eres un productor de YouTube. Devuelve JSON con title, hook, outline (array), visualIdeas (array), description y tags (array). No copies textos de otros vídeos.' },
        { role: 'user', content: `Crea una estructura original para un vídeo de ${duration} minutos sobre: ${topic}. Idioma: ${language}.` }]
    });
    res.json(JSON.parse(response.choices[0].message.content));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generando el esquema con IA.' });
  }
});

app.post('/api/ai/production-plan', async (req, res) => {
  try {
    const { topic, language = 'es', duration = '8', title = '', outline = [], visualIdeas = [] } = req.body || {};
    if (!topic) return res.status(400).json({ error: 'Indica un tema.' });

    const sceneCount = Math.max(4, Math.min(12, Math.round(Number(duration) / 2)));
    if (!process.env.OPENAI_API_KEY) {
      const scenes = Array.from({ length: sceneCount }, (_, i) => ({
        number: i + 1,
        title: i === 0 ? 'Introducción' : 'Escena ' + (i + 1),
        narration: i === 0 ? 'Introducción al vídeo sobre ' + topic + '.' : 'Desarrollo visual relacionado con ' + topic + '.',
        visualPrompt: 'Cinematic realistic footage related to ' + topic + ', scene ' + (i + 1) + ', natural lighting, 16:9',
        duration: Math.round((Number(duration) * 60) / sceneCount),
        transition: 'Fundido suave'
      }));
      return res.json({ demo: true, title: title || 'Vídeo sobre ' + topic, scenes, musicMood: 'Ambient relajante', voiceStyle: 'Natural y cercana' });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.75,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Eres director de producción de YouTube. Crea un plan audiovisual ORIGINAL. Devuelve JSON válido con title, musicMood, voiceStyle y scenes. scenes debe ser un array con number, title, narration, visualPrompt, duration y transition. Los visualPrompt deben describir imágenes o vídeo originales y no pedir que se copie material protegido.' },
        { role: 'user', content: JSON.stringify({ topic, language, duration, title, outline, visualIdeas, sceneCount }) }
      ]
    });
    res.json(JSON.parse(response.choices[0].message.content));
  } catch (err) {
    console.error('Production plan error:', err);
    res.status(500).json({ error: 'Error generando el plan de producción.' });
  }
});

app.post('/api/project', (req, res) => {
  const project = { id: `p_${Date.now()}`, createdAt: new Date().toISOString(), status: 'draft', ...req.body };
  res.json(project);
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
async function verifySupabaseConnection() {
  if (!supabaseConfigured()) {
    console.log('Supabase persistence not configured.');
    return;
  }
  const { url, key } = supabaseEnv();
  try {
    await supabaseRequest('youtube_connections?select=id&limit=1', { method: 'GET' });
    console.log('Supabase connection OK:', {
      host: new URL(url).host,
      keyType: key.startsWith('sb_secret_') ? 'secret' : key.startsWith('sb_publishable_') ? 'publishable' : 'legacy/unknown'
    });
  } catch (err) {
    console.error('Supabase connection FAILED:', err.message);
    console.error('Supabase config:', {
      host: new URL(url).host,
      keyType: key.startsWith('sb_secret_') ? 'secret' : key.startsWith('sb_publishable_') ? 'publishable' : 'legacy/unknown',
      keyLength: key.length
    });
  }
}

app.listen(PORT, () => {
  console.log(`AutoTube running on port ${PORT}`);
  verifySupabaseConnection();
});
