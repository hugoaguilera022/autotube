const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const jobs = new Map();
const jobDir = path.join(os.tmpdir(), 'autotube-safe-renders');
fsp.mkdir(jobDir, { recursive: true }).catch(() => {});

const originalPost = express.application.post;
let originalRenderHandler = null;

express.application.post = function(route, ...handlers) {
  if (route !== '/api/render') return originalPost.call(this, route, ...handlers);

  originalRenderHandler = handlers[handlers.length - 1];
  const app = this;

  const wrapped = async (req, res) => {
    const jobId = 'render_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const outputPath = path.join(jobDir, jobId + '.mp4');
    jobs.set(jobId, { status: 'processing', progress: 1, outputPath, error: null, createdAt: Date.now() });

    // Respond before FFmpeg starts so Render's web proxy never waits for the video render.
    res.status(202).json({ ok: true, jobId, status: 'processing' });

    setImmediate(async () => {
      const job = jobs.get(jobId);
      const fakeRes = {
        _status: 200,
        headersSent: false,
        status(code) { this._status = code; return this; },
        set() { return this; },
        json(payload) {
          if (this._status >= 400 || payload?.error) {
            job.status = 'error';
            job.error = payload?.error || ('Render HTTP ' + this._status);
            job.progress = 0;
          }
          return this;
        },
        send(payload) {
          try {
            if (!Buffer.isBuffer(payload)) throw new Error('El render no devolvió un MP4 válido.');
            fs.writeFileSync(outputPath, payload);
            job.status = 'done';
            job.progress = 100;
            job.size = payload.length;
            job.finishedAt = Date.now();
          } catch (err) {
            job.status = 'error';
            job.error = err.message;
            job.progress = 0;
          }
          return this;
        }
      };

      try {
        await originalRenderHandler(req, fakeRes);
        if (job.status === 'processing') {
          job.status = 'error';
          job.error = 'El render terminó sin generar un MP4.';
          job.progress = 0;
        }
      } catch (err) {
        job.status = 'error';
        job.error = err?.message || 'No se pudo renderizar el vídeo.';
        job.progress = 0;
        console.error('AutoTube render job error:', job.error);
      }
    });
  };

  const result = originalPost.call(app, route, wrapped);

  // Status endpoint expected by the existing frontend.
  express.application.get.call(app, '/api/render/:jobId', async (req, res) => {
    const job = jobs.get(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ error: 'Render no encontrado o ya ha expirado.' });
    if (job.status === 'processing') return res.json({ ok: true, status: 'processing', progress: job.progress || 0 });
    if (job.status === 'error') return res.json({ ok: false, status: 'error', error: job.error });
    try {
      const stat = await fsp.stat(job.outputPath);
      return res.json({ ok: true, status: 'done', progress: 100, size: stat.size, downloadUrl: '/api/render/' + encodeURIComponent(req.params.jobId) + '/download' });
    } catch {
      return res.status(404).json({ error: 'El vídeo renderizado ya no está disponible.' });
    }
  });

  express.application.get.call(app, '/api/render/:jobId/download', async (req, res) => {
    const job = jobs.get(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ error: 'Render no encontrado o ya ha expirado.' });
    if (job.status !== 'done') return res.status(409).json({ error: 'El render todavía no está listo.' });
    try {
      const stat = await fsp.stat(job.outputPath);
      res.set({
        'Content-Type': 'video/mp4',
        'Content-Length': String(stat.size),
        'Content-Disposition': 'attachment; filename="autotube-final.mp4"',
        'Cache-Control': 'no-store'
      });
      return res.sendFile(job.outputPath);
    } catch {
      return res.status(404).json({ error: 'El vídeo renderizado ya no está disponible.' });
    }
  });

  return result;
};
