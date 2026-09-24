require('dotenv').config();
const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const OpenAI = require('openai');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });

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


function extractYoutubeVideoId(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || '';
      if (url.pathname.startsWith('/embed/')) return url.pathname.split('/')[2] || '';
    }
  } catch {}
  return '';
}

async function getReferenceVideo(input) {
  const videoId = extractYoutubeVideoId(input);
  if (!videoId) throw new Error('La URL de referencia de YouTube no es válida.');
  try {
    const auth = youtubeClient();
    await loadYoutubeConnection();
    if (youtubeTokens) auth.setCredentials(youtubeTokens);
    const youtube = google.youtube({ version: 'v3', auth });
    const response = await youtube.videos.list({
      part: 'snippet,contentDetails,statistics',
      id: [videoId]
    });
    const video = response.data.items?.[0];
    if (video) {
      const snippet = video.snippet || {};
      const details = video.contentDetails || {};
      return {
        videoId,
        title: snippet.title || '',
        description: snippet.description || '',
        channelTitle: snippet.channelTitle || '',
        publishedAt: snippet.publishedAt || '',
        tags: snippet.tags || [],
        categoryId: snippet.categoryId || '',
        defaultLanguage: snippet.defaultLanguage || snippet.defaultAudioLanguage || '',
        duration: details.duration || '',
        definition: details.definition || '',
        caption: details.caption === 'true',
        thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || ''
      };
    }
  } catch (err) {
    console.error('YouTube reference API error:', err.message);
  }

  const oembed = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(input) + '&format=json');
  if (!oembed.ok) throw new Error('No se pudo analizar el vídeo de referencia.');
  const data = await oembed.json();
  return {
    videoId,
    title: data.title || '',
    channelTitle: data.author_name || '',
    thumbnail: data.thumbnail_url || ''
  };
}

app.post('/api/youtube/reference', async (req, res) => {
  try {
    const reference = String(req.body?.reference || '').trim();
    if (!reference) return res.status(400).json({ error: 'Indica una URL de YouTube.' });
    const video = await getReferenceVideo(reference);
    res.json({
      ok: true,
      reference,
      video,
      analysis: {
        basis: 'Metadatos públicos del vídeo de referencia',
        note: 'La referencia se utiliza para extraer características de formato y temática. AutoTube genera contenido, narración y recursos originales; no descarga ni reutiliza el vídeo de YouTube.'
      }
    });
  } catch (err) {
    console.error('Reference analysis error:', err);
    res.status(400).json({ error: err.message || 'No se pudo analizar la referencia.' });
  }
});



async function analyzeReferenceVideoBuffer(fileBuffer, originalName = 'reference.mp4') {
  if (!process.env.OPENAI_API_KEY) {
    return {
      demo: true,
      summary: 'Análisis visual no disponible sin OPENAI_API_KEY.',
      visualStyle: [],
      pacing: 'No disponible',
      composition: 'No disponible',
      lighting: 'No disponible',
      color: 'No disponible'
    };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autotube-reference-'));
  const input = path.join(dir, 'reference' + path.extname(originalName || '.mp4') || '.mp4');
  const framesDir = path.join(dir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  try {
    await fs.writeFile(input, fileBuffer);

    await new Promise((resolve, reject) => {
      const args = [
        '-y', '-i', input,
        '-vf', 'fps=1/15,scale=768:-2',
        '-frames:v', '8',
        path.join(framesDir, 'frame-%02d.jpg')
      ];
      const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => {
        err += d.toString();
        if (err.length > 8000) err = err.slice(-8000);
      });
      p.on('error', reject);
      p.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg ' + code + ': ' + err.slice(-2000))));
    });

    const names = (await fs.readdir(framesDir)).filter(x => x.endsWith('.jpg')).sort();
    if (!names.length) throw new Error('No se pudieron extraer fotogramas del vídeo.');

    const images = [];
    for (const name of names) {
      const data = await fs.readFile(path.join(framesDir, name));
      images.push({
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,' + data.toString('base64'), detail: 'low' }
      });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        {
          role: 'system',
          content: 'Analiza únicamente características visuales generales de un vídeo de referencia. No identifiques ni reproduzcas contenido protegido. Devuelve JSON válido con summary, visualStyle (array), pacing, composition, lighting, color, camera, recurringElements (array) y generationGuidance (array). La finalidad es crear contenido audiovisual nuevo y diferenciado.'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analiza estos fotogramas como referencia visual. Describe estilo, composición, ritmo aparente, iluminación, color, cámara y elementos recurrentes. No describas ni copies personas, textos, logotipos, escenas concretas o contenido identificable. Convierte las observaciones en pautas generales para generar un vídeo original.' },
            ...images
          ]
        }
      ]
    });

    const content = response.choices?.[0]?.message?.content || '{}';
    try {
      return JSON.parse(content);
    } catch {
      return {
        summary: content.slice(0, 2000),
        visualStyle: [],
        pacing: '',
        composition: '',
        lighting: '',
        color: '',
        camera: '',
        recurringElements: [],
        generationGuidance: []
      };
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

app.post('/api/reference/visual-analysis', upload.single('video'), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Sube un vídeo de referencia.' });
    }
    const analysis = await analyzeReferenceVideoBuffer(req.file.buffer, req.file.originalname);
    res.json({
      ok: true,
      analysis,
      note: 'Se han analizado fotogramas del archivo subido para obtener características visuales generales. El contenido generado por AutoTube es original.'
    });
  } catch (err) {
    console.error('Reference visual analysis error:', err);
    res.status(502).json({ error: err.message || 'No se pudo analizar visualmente el vídeo.' });
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
    const { topic, language = 'es', duration = '8', reference = '', referenceData = null, visualReferenceAnalysis = null } = req.body || {};
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
        { role: 'user', content: JSON.stringify({
  task: 'Crea una estructura audiovisual original inspirada en las características del vídeo de referencia, sin copiar su guion, frases, escenas, audio, imágenes ni secuencia exacta.',
  topic, language, duration,
  reference: referenceData || (reference ? { url: reference } : null),
  visualReferenceAnalysis,
  requirements: [
    'Detecta y reproduce solo rasgos generales de formato: temática, ritmo aproximado, tono, tipo de apertura, estructura narrativa, densidad visual y estilo de presentación.',
    'Transforma esas características en una propuesta nueva y diferenciada.',
    'Devuelve title, hook, outline, visualIdeas, description y tags.'
  ]
}) }]
    });
    res.json(JSON.parse(response.choices[0].message.content));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generando el esquema con IA.' });
  }
});

app.post('/api/ai/production-plan', async (req, res) => {
  try {
    const { topic, language = 'es', duration = '8', title = '', outline = [], visualIdeas = [], visualReferenceAnalysis = null } = req.body || {};
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
        { role: 'system', content: 'Eres director de producción de YouTube. Crea un plan audiovisual ORIGINAL. Devuelve JSON válido con title, musicMood, voiceStyle y scenes. scenes debe ser un array con number, title, narration, visualPrompt, searchQuery, duration y transition. searchQuery debe ser una consulta corta y concreta para encontrar vídeo de stock horizontal relacionado con la escena. Los visualPrompt deben describir imágenes o vídeo originales y no pedir que se copie material protegido.' },
        { role: 'user', content: JSON.stringify({ topic, language, duration, title, outline, visualIdeas,
  visualReferenceAnalysis, sceneCount }) }
      ]
    });
    res.json(JSON.parse(response.choices[0].message.content));
  } catch (err) {
    console.error('Production plan error:', err);
    const fallbackCount = Math.max(4, Math.min(12, Math.round(Number(req.body?.duration || 8) / 2)));
    const fallbackTopic = req.body?.topic || 'el tema del vídeo';
    const fallbackScenes = Array.from({ length: fallbackCount }, (_, i) => ({
      number: i + 1,
      title: i === 0 ? 'Introducción' : 'Desarrollo · escena ' + (i + 1),
      narration: i === 0
        ? 'Presentación del tema y promesa principal del vídeo.'
        : 'Desarrollo del contenido con una explicación clara y visual.',
      visualPrompt: 'Realistic cinematic footage about ' + fallbackTopic + ', scene ' + (i + 1) + ', natural light, detailed, 16:9, original composition',
      duration: Math.round((Number(req.body?.duration || 8) * 60) / fallbackCount),
      transition: 'Fundido suave'
    }));
    res.json({
      demo: true,
      fallback: true,
      title: req.body?.title || 'Vídeo sobre ' + fallbackTopic,
      musicMood: 'Ambient cinematográfico',
      voiceStyle: 'Natural y cercana',
      scenes: fallbackScenes,
      warning: 'La API de IA no respondió. Se ha creado un plan local para que puedas continuar.'
    });
  }
});


async function generateElevenMusic({ prompt, durationSeconds = 180 }) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY no está configurada.');
  }
  const seconds = Math.max(3, Math.min(300, Number(durationSeconds) || 180));
  const response = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: String(prompt || 'Instrumental ambient cinematic background music for a calm YouTube video, no vocals'),
      music_length_ms: Math.round(seconds * 1000),
      model_id: 'music_v2_5',
      force_instrumental: true,
      output_format: 'mp3_48000_192'
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error('ElevenLabs Music API ' + response.status + ': ' + detail.slice(0, 500));
  }
  return Buffer.from(await response.arrayBuffer());
}

function normalizeSearchQuery(value){
  return String(value||'').replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,100);
}
function pickPexelsFile(video){
  const files=(video?.video_files||[]).filter(x=>x?.link);
  return files.sort((a,b)=>((b.width||0)*(b.height||0))-((a.width||0)*(a.height||0)))[0]?.link||'';
}
async function searchPexels(query){
  if(!process.env.PEXELS_API_KEY)return [];
  const url='https://api.pexels.com/v1/videos/search?'+new URLSearchParams({query,orientation:'landscape',size:'medium',locale:'es-ES',per_page:'8'}).toString();
  const r=await fetch(url,{headers:{Authorization:process.env.PEXELS_API_KEY}});
  if(!r.ok)throw new Error('Pexels API '+r.status);
  const d=await r.json();
  return (d.videos||[]).map(v=>({provider:'Pexels',id:v.id,title:'Vídeo Pexels',duration:v.duration,thumbnail:v.image,url:v.url,downloadUrl:pickPexelsFile(v)})).filter(x=>x.downloadUrl);
}
async function searchPixabay(query){
  if(!process.env.PIXABAY_API_KEY)return [];
  const url='https://pixabay.com/api/videos/?'+new URLSearchParams({key:process.env.PIXABAY_API_KEY,q:query,lang:'es',video_type:'film',safesearch:'true',order:'popular',per_page:'8'}).toString();
  const r=await fetch(url);
  if(!r.ok)throw new Error('Pixabay API '+r.status);
  const d=await r.json();
  return (d.hits||[]).map(v=>({provider:'Pixabay',id:v.id,title:'Vídeo Pixabay',duration:v.duration,thumbnail:v.videos?.medium?.thumbnail||v.videos?.small?.thumbnail||'',url:v.pageURL,downloadUrl:v.videos?.medium?.url||v.videos?.small?.url||''})).filter(x=>x.downloadUrl);
}
app.post('/api/media/search',async(req,res)=>{
  try{
    const scenes=Array.isArray(req.body?.scenes)?req.body.scenes:[];
    if(!scenes.length)return res.status(400).json({error:'No hay escenas para buscar.'});
    const results=[];
    for(const scene of scenes.slice(0,12)){
      const query=normalizeSearchQuery(scene.searchQuery||scene.visualPrompt||scene.title||'nature');
      const [pexels,pixabay]=await Promise.allSettled([searchPexels(query),searchPixabay(query)]);
      const media=[
        ...(pexels.status==='fulfilled'?pexels.value:[]),
        ...(pixabay.status==='fulfilled'?pixabay.value:[])
      ];
      results.push({number:scene.number,title:scene.title,query,media,errors:{
        pexels:pexels.status==='rejected'?pexels.reason.message:null,
        pixabay:pixabay.status==='rejected'?pixabay.reason.message:null
      }});
    }
    res.json({ok:true,results,credits:{pexels:'Vídeos proporcionados por Pexels',pixabay:'Vídeos proporcionados por Pixabay'}});
  }catch(err){console.error('Media search error:',err);res.status(502).json({error:err.message||'No se pudieron buscar visuales.'});}
});

async function downloadToFile(url,file){
  const r=await fetch(url);
  if(!r.ok)throw new Error('No se pudo descargar el recurso ('+r.status+').');
  const buf=Buffer.from(await r.arrayBuffer());
  await fs.writeFile(file,buf);
}
function runFfmpeg(args){
  return new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});
    let err='';p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000)});
    p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('FFmpeg '+code+': '+err.slice(-2500))));
  });
}
async function renderAutotubeVideo({scenes,mediaResults,narrationBuffers=[],musicBuffer=null}){
  if(!ffmpegPath)throw new Error('FFmpeg no está disponible.');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-'));
  try{
    const clips=[],voiceFiles=[];
    for(let i=0;i<scenes.length;i++){
      const scene=scenes[i],found=mediaResults.find(x=>String(x.number)===String(scene.number))||mediaResults[i],asset=found?.media?.find(x=>x.downloadUrl)?.downloadUrl;
      if(!asset)continue;
      const input=path.join(dir,'in-'+i+'.mp4'),output=path.join(dir,'scene-'+i+'.mp4');
      await downloadToFile(asset,input);
      const duration=Math.max(2,Math.min(120,Number(scene.duration)||8));
      await runFfmpeg(['-y','-stream_loop','-1','-i',input,'-t',String(duration),'-vf',"scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p,fps=30",'-an','-c:v','libx264','-preset','veryfast','-crf','23','-movflags','+faststart',output]);
      clips.push(output);
      if(narrationBuffers[i]){const vf=path.join(dir,'voice-'+i+'.mp3');await fs.writeFile(vf,narrationBuffers[i]);voiceFiles.push({file:vf,delay:scenes.slice(0,i).reduce((n,x)=>n+(Number(x.duration)||8),0)});}
    }
    if(!clips.length)throw new Error('No hay clips de vídeo disponibles para las escenas.');
    const list=path.join(dir,'concat.txt');await fs.writeFile(list,clips.map(f=>"file '"+f.replace(/'/g,"'\\''")+"'").join('\n'));
    const silent=path.join(dir,'silent.mp4');await runFfmpeg(['-y','-f','concat','-safe','0','-i',list,'-c','copy',silent]);
    const music=path.join(dir,'music.mp3');
    if(musicBuffer)await fs.writeFile(music,musicBuffer);else{
      const total=Math.min(300,Math.max(30,scenes.reduce((n,x)=>n+(Number(x.duration)||8),0)));
      await fs.writeFile(music,await generateElevenMusic({prompt:'Instrumental ambient cinematic background music, calm, immersive, subtle evolution, no vocals.',durationSeconds:total}));
    }
    const inputs=['-i',silent,'-stream_loop','-1','-i',music],filters=[],voiceLabels=[];
    voiceFiles.forEach((v,i)=>{inputs.push('-i',v.file);const delay=Math.round(v.delay*1000);filters.push('['+(i+2)+':a]adelay='+delay+'|'+delay+'[v'+i+']');voiceLabels.push('[v'+i+']');});
    if(voiceFiles.length){filters.push(voiceLabels.join('')+'amix=inputs='+voiceFiles.length+':duration=longest[narr]');filters.push('[1:a][narr]amix=inputs=2:duration=first:weights=0.2 1[aout]');}
    else filters.push('[1:a]anull[aout]');
    const out=path.join(dir,'autotube-final.mp4');
    await runFfmpeg(['-y',...inputs,'-filter_complex',filters.join(';'),'-map','0:v:0','-map','[aout]','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',out]);
    return {buffer:await fs.readFile(out),duration:clips.length};
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
app.post('/api/render',async(req,res)=>{
  try{
    const scenes=Array.isArray(req.body?.scenes)?req.body.scenes:[];
    const mediaResults=Array.isArray(req.body?.mediaResults)?req.body.mediaResults:[];
    if(!scenes.length||!mediaResults.length)return res.status(400).json({error:'Genera las escenas y busca los visuales antes de renderizar.'});
    const narrationBuffers=[];
    for(const scene of scenes){const text=String(scene.narration||scene.script||'').trim();narrationBuffers.push(text?await generateElevenVoice({text,language:req.body?.language||'es'}):null);}
    const result=await renderAutotubeVideo({scenes,mediaResults,narrationBuffers});
    res.set({'Content-Type':'video/mp4','Content-Length':String(result.buffer.length),'Content-Disposition':'attachment; filename="autotube-final.mp4"','Cache-Control':'no-store'});res.send(result.buffer);
  }catch(err){console.error('Render error:',err);res.status(502).json({error:err.message||'No se pudo renderizar el vídeo.'});}
});
async function generateElevenVoice({text,voiceId,language='es'}){
  if(!process.env.ELEVENLABS_API_KEY)throw new Error('ELEVENLABS_API_KEY no está configurada.');
  const id=String(voiceId||process.env.ELEVENLABS_VOICE_ID||'JBFqnCBsd6RMkjVDRZzb').trim();
  const response=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+encodeURIComponent(id)+'?output_format=mp3_44100_128',{
    method:'POST',
    headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({text:String(text||''),model_id:'eleven_multilingual_v2',language_code:language==='es'?'es':undefined,voice_settings:{stability:0.45,similarity_boost:0.75,style:0.2,use_speaker_boost:true}})
  });
  if(!response.ok){const detail=await response.text();throw new Error('ElevenLabs TTS '+response.status+': '+detail.slice(0,500));}
  return Buffer.from(await response.arrayBuffer());
}
app.post('/api/ai/voice',async(req,res)=>{
  try{
    const {text='',language='es',voiceId=''}=req.body||{};
    if(!String(text).trim())return res.status(400).json({error:'No hay texto para narrar.'});
    const audio=await generateElevenVoice({text,language,voiceId});
    res.set({'Content-Type':'audio/mpeg','Content-Length':String(audio.length),'Content-Disposition':'inline; filename="autotube-voice.mp3"','Cache-Control':'no-store'});
    res.send(audio);
  }catch(err){console.error('ElevenLabs voice error:',err);res.status(502).json({error:err.message||'No se pudo generar la voz.'});}
});

app.post('/api/ai/music', async (req, res) => {
  try {
    const { mood = 'ambient cinematográfico relajante', topic = 'naturaleza y relajación', durationSeconds = 180 } = req.body || {};
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({ error: 'ELEVENLABS_API_KEY no está configurada en Render.' });
    }
    const prompt = [
      'Instrumental background music for an original YouTube video.',
      'Mood: ' + mood + '.',
      'Topic: ' + topic + '.',
      'Cinematic, calm, immersive, subtle evolution, soft textures, no vocals, no spoken words.',
      'Designed to sit underneath narration without masking speech.'
    ].join(' ');
    const audio = await generateElevenMusic({ prompt, durationSeconds });
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(audio.length),
      'Content-Disposition': 'inline; filename="autotube-music.mp3"',
      'Cache-Control': 'no-store'
    });
    res.send(audio);
  } catch (err) {
    console.error('ElevenLabs music error:', err);
    res.status(502).json({ error: err.message || 'No se pudo generar la música.' });
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
