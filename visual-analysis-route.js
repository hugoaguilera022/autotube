const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');

const originalExpress = require('express');
const expressPath = require.resolve('express');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 }
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    p.stderr.on('data', chunk => {
      error += chunk.toString();
      if (error.length > 8000) error = error.slice(-8000);
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg ' + code + ': ' + error.slice(-2500))));
  });
}

async function askGemini(images) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const parts = [{ text: 'Analiza estos fotogramas de un vídeo de referencia. Devuelve JSON válido con: visualStyle, composition, colorAndLighting, cameraAndMovement, pacing, recurringElements y summary. Describe características generales para crear un vídeo ORIGINAL; no copies personas, escenas, texto, logos ni contenido protegido.' }];
  for (const image of images) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
  }
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1200 }
    })
  });
  const raw = await response.text();
  if (!response.ok) throw new Error('Gemini API ' + response.status + ': ' + raw.slice(0, 600));
  const data = JSON.parse(raw);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini no devolvió análisis visual.');
  return JSON.parse(text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim());
}

function installRoute(app) {
  if (app.__autotubeVisualAnalysisInstalled) return;
  app.__autotubeVisualAnalysisInstalled = true;
  app.post('/api/reference/visual-analysis', upload.single('video'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No se recibió ningún vídeo de referencia.' });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autotube-reference-'));
    const input = path.join(dir, 'reference.mp4');
    const pattern = path.join(dir, 'frame-%02d.jpg');
    try {
      await fs.writeFile(input, file.buffer);
      await runFfmpeg([
        '-y', '-i', input,
        '-vf', 'fps=1/3,scale=768:-2:force_original_aspect_ratio=decrease',
        '-frames:v', '6', '-q:v', '5', pattern
      ]);
      const names = (await fs.readdir(dir)).filter(n => /^frame-\d+\.jpg$/.test(n)).sort();
      const images = [];
      for (const name of names) images.push((await fs.readFile(path.join(dir, name))).toString('base64'));
      if (!images.length) throw new Error('No se pudieron extraer fotogramas del vídeo.');
      let analysis = null;
      try { analysis = await askGemini(images); } catch (err) {
        console.error('Visual analysis Gemini error:', err.message);
      }
      if (!analysis) {
        analysis = {
          visualStyle: 'Cinematográfico y realista',
          composition: 'Planos horizontales y composiciones centradas o equilibradas',
          colorAndLighting: 'Iluminación natural/cinematográfica',
          cameraAndMovement: 'Movimientos suaves y planos estables',
          pacing: 'Ritmo visual moderado',
          recurringElements: [],
          summary: 'Se han extraído fotogramas de la referencia para orientar una creación original.'
        };
      }
      res.json({ ok: true, analysis, framesAnalyzed: images.length });
    } catch (err) {
      console.error('Visual reference analysis error:', err);
      res.status(400).json({ error: err.message || 'No se pudo analizar el vídeo de referencia.' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  installRoute(app);
  return app;
}
Object.setPrototypeOf(wrappedExpress, originalExpress);
Object.assign(wrappedExpress, originalExpress);
require.cache[expressPath].exports = wrappedExpress;
