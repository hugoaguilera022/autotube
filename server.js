require('dotenv').config();
const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const OpenAI = require('openai');
const crypto = require('crypto');

const app = express();

// YouTube OAuth is persisted in Supabase so Render restarts/redeploys do not disconnect the channel.
// Tokens are encrypted server-side with AES-256-GCM before being stored.
let youtubeTokens = null;
let youtubeProfileCache = null;
let youtubeLoaded = false;

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
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

async function supabaseRequest(path, options = {}) {
  if (!supabaseConfigured()) return null;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
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

app.get('/api/youtube/auth', (_req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Configura YOUTUBE_CLIENT_ID y YOUTUBE_CLIENT_SECRET en Render.' });
  }
  const url = youtubeClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']
  });
  res.json({ url });
});

app.get('/api/youtube/callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).send('Falta el código OAuth.');
    const { tokens } = await youtubeClient().getToken(req.query.code);
    youtubeTokens = tokens;
    youtubeProfileCache = null;
    youtubeLoaded = true;
    await getYoutubeProfile();
    await saveYoutubeConnection();
    const appOrigin = process.env.APP_URL || '*';
    res.send(`<script>window.opener?.postMessage({type:'youtube_connected'}, '${appOrigin}'); window.close();</script><p>YouTube conectado. Puedes cerrar esta ventana.</p>`);
    console.log('YouTube OAuth completed. Token received:', Boolean(tokens.access_token));
  } catch (err) {
    console.error(err);
    res.status(500).send('No se pudo completar la conexión con YouTube.');
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

app.post('/api/project', (req, res) => {
  const project = { id: `p_${Date.now()}`, createdAt: new Date().toISOString(), status: 'draft', ...req.body };
  res.json(project);
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`AutoTube running on port ${PORT}`));
