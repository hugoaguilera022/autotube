require('dotenv').config();
const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
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
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY)
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
    // Production TODO: persist encrypted tokens in a database keyed to the authenticated AutoTube user.
    res.send(`<script>window.opener?.postMessage({type:'youtube_connected'}, '*'); window.close();</script><p>YouTube conectado. Puedes cerrar esta ventana.</p>`);
    console.log('YouTube OAuth completed. Token received:', Boolean(tokens.access_token));
  } catch (err) {
    console.error(err);
    res.status(500).send('No se pudo completar la conexión con YouTube.');
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
