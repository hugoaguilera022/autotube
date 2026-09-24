const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const ffmpegPath = require('ffmpeg-static');
const originalExpress = require('express');
const expressPath = require.resolve('express');

const jobs = new Map();
const root = path.join(os.tmpdir(), 'autotube-render-jobs');
fs.mkdir(root, { recursive: true }).catch(() => {});

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', b => { err += b.toString(); if (err.length > 12000) err = err.slice(-12000); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg '+code+': '+err.slice(-3500))));
  });
}

async function download(url, file) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const r = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error('No se pudo descargar el visual ('+r.status+').');
    const out = fsSync.createWriteStream(file);
    await Readable.fromWeb(r.body).pipe(out);
    const st = await fs.stat(file);
    if (!st.size) throw new Error('El visual descargado está vacío.');
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Tiempo de espera agotado descargando un visual.');
    throw e;
  } finally { clearTimeout(timer); }
}

function install(app) {
  if (app.__autotubeRenderInstalled) return;
  app.__autotubeRenderInstalled = true;

  app.post('/api/render', async (req, res) => {
    const scenes = Array.isArray(req.body?.scenes) ? req.body.scenes : [];
    const mediaResults = Array.isArray(req.body?.mediaResults) ? req.body.mediaResults : [];
    if (!scenes.length || !mediaResults.length) return res.status(400).json({ error: 'Genera las escenas y busca los visuales antes de renderizar.' });

    const id = 'render_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10);
    const dir = path.join(root, id);
    const output = path.join(dir, 'autotube-final.mp4');
    jobs.set(id, { status:'processing', progress:0, output, dir, createdAt:Date.now(), error:null });
    await fs.mkdir(dir, { recursive:true });

    // Return immediately. The browser never waits for FFmpeg, preventing web-service 502s.
    res.status(202).json({ ok:true, jobId:id, status:'processing' });

    (async () => {
      const job = jobs.get(id);
      try {
        const usable = scenes.map((scene, i) => {
          const group = mediaResults.find(x => String(x.number) === String(scene.number)) || mediaResults[i];
          const asset = group?.media?.find(x => x?.downloadUrl)?.downloadUrl;
          return { scene, asset };
        }).filter(x => x.asset);
        if (!usable.length) throw new Error('No hay vídeos descargables para las escenas.');

        const clips = [];
        for (let i=0; i<usable.length; i++) {
          const {scene, asset} = usable[i];
          const input = path.join(dir, 'source-'+i+'.mp4');
          const clip = path.join(dir, 'clip-'+i+'.mp4');
          const duration = Math.max(2, Math.min(180, Number(scene.duration) || 8));
          await download(asset, input);
          await ffmpeg([
            '-y','-hide_banner','-loglevel','error','-i',input,
            '-t',String(duration),
            '-vf','scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=24,format=yuv420p',
            '-an','-c:v','libx264','-preset','veryfast','-crf','27','-pix_fmt','yuv420p','-threads','1','-movflags','+faststart',clip
          ]);
          clips.push(clip);
          job.progress = Math.round(((i+1)/usable.length)*85);
          await fs.rm(input,{force:true}).catch(()=>{});
        }

        const list = path.join(dir,'concat.txt');
        await fs.writeFile(list, clips.map(f => "file '"+f.replace(/'/g,"'\\''")+"'").join('\n'));
        try {
          await ffmpeg(['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',output]);
        } catch {
          await ffmpeg(['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list,'-c:v','libx264','-preset','veryfast','-crf','27','pix_fmt','yuv420p','-threads','1','-movflags','+faststart',output]);
        }
        const st = await fs.stat(output);
        if (!st.size) throw new Error('FFmpeg terminó sin crear un MP4 válido.');
        job.status='done'; job.progress=100; job.size=st.size; job.finishedAt=Date.now();
      } catch (e) {
        console.error('AutoTube render error', id, e);
        job.status='error'; job.progress=0; job.error=e.message || 'No se pudo renderizar el MP4.';
      }
    })();
  });

  app.get('/api/render/:jobId', async (req,res) => {
    const job=jobs.get(String(req.params.jobId||''));
    if(!job) return res.status(404).json({error:'Render no encontrado.'});
    if(job.status==='processing') return res.json({ok:true,status:'processing',progress:job.progress||0});
    if(job.status==='error') return res.json({ok:false,status:'error',error:job.error});
    const st=await fs.stat(job.output).catch(()=>null);
    if(!st) return res.status(404).json({error:'El MP4 ya no está disponible.'});
    res.json({ok:true,status:'done',progress:100,size:st.size,downloadUrl:'/api/render/'+encodeURIComponent(req.params.jobId)+'/download'});
  });

  app.get('/api/render/:jobId/download', async (req,res) => {
    const job=jobs.get(String(req.params.jobId||''));
    if(!job) return res.status(404).json({error:'Render no encontrado.'});
    if(job.status!=='done') return res.status(409).json({error:'El MP4 todavía no está listo.'});
    const st=await fs.stat(job.output).catch(()=>null);
    if(!st) return res.status(404).json({error:'El MP4 ya no está disponible.'});
    res.set({'Content-Type':'video/mp4','Content-Length':String(st.size),'Content-Disposition':'attachment; filename="autotube-final.mp4"','Cache-Control':'no-store'});
    res.sendFile(job.output);
  });
}

function wrappedExpress(...args){ const app=originalExpress(...args); install(app); return app; }
Object.setPrototypeOf(wrappedExpress, originalExpress);
Object.assign(wrappedExpress, originalExpress);
require.cache[expressPath].exports = wrappedExpress;
