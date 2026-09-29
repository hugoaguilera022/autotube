const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function falConfigured() {
  return Boolean(String(process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim());
}

function falKey() {
  return String(process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim();
}

function configureFal() {
  if (!falConfigured()) throw new Error('FAL_KEY no configurada.');
  const { fal } = require('@fal-ai/client');
  fal.config({ credentials: falKey() });
  return fal;
}

function firstUrl(value, kind) {
  const preferred = kind === 'video' ? /video|mp4/i : kind === 'audio' ? /audio|mp3|wav|m4a/i : /image|png|jpg|jpeg|webp/i;
  const walk = (v, key='') => {
    if (!v) return null;
    if (typeof v === 'string' && /^https?:\/\//i.test(v) && (preferred.test(key) || /\.(mp4|mov|webm|mp3|wav|m4a|png|jpg|jpeg|webp)(?:\?|$)/i.test(v))) return v;
    if (Array.isArray(v)) {
      for (const item of v) { const found = walk(item, key); if (found) return found; }
    } else if (typeof v === 'object') {
      const entries = Object.entries(v).sort(([a],[b]) => {
        const score = x => /(url|video|audio|image|file|output)/i.test(x) ? 0 : 1;
        return score(a)-score(b);
      });
      for (const [k,item] of entries) { const found = walk(item, k); if (found) return found; }
    }
    return null;
  };
  return walk(value);
}

async function falSubscribe(model, input, timeoutMs=300000) {
  const fal = configureFal();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // fal's SDK manages the queue lifecycle; timeout is enforced by AutoTube.
    const result = await fal.subscribe(model, { input, logs: false });
    return result?.data ?? result;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadUrl(url, outputPath, timeoutMs=120000) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: {'User-Agent':'AutoTube/1.0'} });
  if (!r.ok) throw new Error('Proveedor devolvió '+r.status+' al descargar el resultado.');
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!bytes.length) throw new Error('Proveedor devolvió un archivo vacío.');
  await fs.writeFile(outputPath, bytes);
  return { outputPath, bytes: bytes.length };
}

function imageDataUri(fileBytes, mime='image/png') {
  return 'data:'+mime+';base64,'+Buffer.from(fileBytes).toString('base64');
}

async function falImage(prompt, dir, options={}) {
  const models = [
    String(process.env.AUTOTUBE_FAL_IMAGE_MODEL || '').trim(),
    'fal-ai/flux/schnell'
  ].filter(Boolean);
  let last;
  for (const model of [...new Set(models)]) {
    try {
      const data = await falSubscribe(model, {
        prompt: String(prompt || '').trim(),
        ...(model.endsWith('/schnell') ? { num_inference_steps: 4 } : {})
      }, 120000);
      const url = firstUrl(data, 'image');
      if (!url) throw new Error('FAL '+model+' no devolvió una URL de imagen.');
      const outputPath = path.join(dir, 'fal-image-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.png');
      const result = await downloadUrl(url, outputPath);
      return { ...result, provider:'fal.ai', model, status:'complete' };
    } catch (err) { last = err; }
  }
  throw last || new Error('FAL image exhausted.');
}

async function falVideo(prompt, dir, options={}) {
  const imagePath = String(options.firstFramePath || '').trim();
  const i2vModel = String(process.env.AUTOTUBE_FAL_I2V_MODEL || 'bytedance/seedance-2.5/image-to-video').trim();
  const t2vModel = String(process.env.AUTOTUBE_FAL_T2V_MODEL || 'bytedance/seedance-2.5/text-to-video').trim();
  const duration = String(Math.max(4, Math.min(30, Math.round(Number(options.durationSeconds) || 5))));
  const aspectRatio = String(options.aspectRatio || '16:9');
  const candidates = imagePath ? [
    { model:i2vModel, i2v:true },
    { model:t2vModel, i2v:false }
  ] : [{ model:t2vModel, i2v:false }];
  let last;
  for (const candidate of candidates) {
    try {
      const input = {
        prompt: String(prompt || '').trim(),
        duration,
        resolution: String(options.resolution || '480p'),
        aspect_ratio: aspectRatio,
        generate_audio: Boolean(options.generateAudio)
      };
      if (candidate.i2v) {
        const bytes = await fs.readFile(imagePath);
        input.image_url = imageDataUri(bytes, 'image/png');
      }
      const data = await falSubscribe(candidate.model, input, 330000);
      const url = firstUrl(data, 'video');
      if (!url) throw new Error('FAL '+candidate.model+' no devolvió una URL de vídeo.');
      const outputPath = path.join(dir, 'fal-video-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
      const result = await downloadUrl(url, outputPath, 180000);
      return { ...result, provider:'fal.ai', model:candidate.model, durationSeconds:Number(duration), status:'complete', routeMode:candidate.i2v?'I2V':'T2V' };
    } catch (err) { last = err; }
  }
  throw last || new Error('FAL video exhausted.');
}

async function falTts(text, dir) {
  const models = [
    String(process.env.AUTOTUBE_FAL_TTS_MODEL || '').trim(),
    'fal-ai/minimax/preview/speech-2.5-turbo',
    'fal-ai/minimax/preview/speech-2.5-hd'
  ].filter(Boolean);
  let last;
  for (const model of [...new Set(models)]) {
    try {
      const data = await falSubscribe(model, { text:String(text || '').trim() }, 120000);
      const url = firstUrl(data, 'audio');
      if (!url) throw new Error('FAL '+model+' no devolvió audio.');
      const outputPath = path.join(dir, 'fal-tts-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp3');
      const result = await downloadUrl(url, outputPath);
      return { ...result, provider:'fal.ai', model, status:'complete' };
    } catch (err) { last = err; }
  }
  throw last || new Error('FAL TTS exhausted.');
}

async function falMusic(prompt, dir, options={}) {
  const models = [
    String(process.env.AUTOTUBE_FAL_MUSIC_MODEL || '').trim(),
    'fal-ai/minimax-music/v2',
    'fal-ai/stable-audio'
  ].filter(Boolean);
  let last;
  for (const model of [...new Set(models)]) {
    try {
      const data = await falSubscribe(model, { prompt:String(prompt || '').trim() }, 180000);
      const url = firstUrl(data, 'audio');
      if (!url) throw new Error('FAL '+model+' no devolvió música.');
      const outputPath = path.join(dir, 'fal-music-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp3');
      const result = await downloadUrl(url, outputPath, 180000);
      return { ...result, provider:'fal.ai', model, durationSeconds:Number(options.durationSeconds)||0, status:'complete' };
    } catch (err) { last = err; }
  }
  throw last || new Error('FAL music exhausted.');
}

function capabilityCatalog() {
  return {
    aggregator: {
      fal: {
        configured: falConfigured(),
        models: {
          image: ['fal-ai/flux/schnell'],
          video: ['bytedance/seedance-2.5/image-to-video','bytedance/seedance-2.5/text-to-video'],
          voice: ['fal-ai/minimax/preview/speech-2.5-turbo','fal-ai/minimax/preview/speech-2.5-hd'],
          music: ['fal-ai/minimax-music/v2','fal-ai/stable-audio']
        }
      },
      replicate: {
        configured: Boolean(String(process.env.REPLICATE_API_TOKEN||'').trim()),
        models: {
          image: ['openai/gpt-image-2','google/nano-banana-2','black-forest-labs/flux-schnell'],
          video: ['alibaba/wan-3','xai/grok-imagine-video-1.5','bytedance/seedance-2.0'],
          voice: ['google/gemini-3.1-flash-tts','inworld/realtime-tts-2'],
          music: ['elevenlabs/music','minimax/music-2.5']
        }
      }
    },
    firstParty: {
      google: {
        configured: Boolean(String(process.env.GEMINI_API_KEY||'').trim()),
        image:['gemini-3.1-flash-image','gemini-3-pro-image','gemini-2.5-flash-image'],
        video:['veo-3.1-generate-preview','veo-3.1-lite-generate-preview','gemini-omni-1.1-flash'],
        music:['lyria-3.5','lyria-3-clip-preview','lyria-3-pro-preview','lyria-realtime-exp']
      },
      openai: { configured:Boolean(String(process.env.OPENAI_API_KEY||'').trim()), image:['gpt-image-2'] },
      elevenlabs: { configured:Boolean(String(process.env.ELEVENLABS_API_KEY||'').trim()), video:['kling-3.0','veo-3.1','runway-gen-4.5'], voice:['elevenlabs-tts'], music:['elevenmusic'] }
    },
    local: {
      ffmpeg:true,
      kokoro:Boolean(String(process.env.KOKORO_TTS_URL||'').trim()),
      aceStep:Boolean(String(process.env.ACE_STEP_URL||'').trim())
    }
  };
}

module.exports = { falConfigured, falImage, falVideo, falTts, falMusic, capabilityCatalog };
