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

function replicateConfigured(){return Boolean(String(process.env.REPLICATE_API_TOKEN||'').trim());}
function replicateClient(){if(!replicateConfigured())throw new Error('REPLICATE_API_TOKEN no configurada.');const Replicate=require('replicate');return new Replicate({auth:process.env.REPLICATE_API_TOKEN});}
async function replicateVideo(prompt,dir,options={}){
  const imagePath=String(options.firstFramePath||'').trim();
  const models=imagePath
    ? [String(process.env.AUTOTUBE_REPLICATE_I2V_MODEL||'wan-video/wan-2.7-i2v'), 'bytedance/seedance-2.5']
    : [String(process.env.AUTOTUBE_REPLICATE_T2V_MODEL||'wan-video/wan-2.7-t2v'), 'bytedance/seedance-2.5'];
  let last;
  for(const model of [...new Set(models)]){
    try{
      const input={prompt:String(prompt||'').trim(),duration:Math.max(2,Math.min(15,Math.round(Number(options.durationSeconds)||5))),resolution:String(options.resolution||'720p'),aspect_ratio:String(options.aspectRatio||'16:9'),generate_audio:Boolean(options.generateAudio),watermark:false};
      if(model.includes('wan-2.7-i2v')){
        input.first_frame=imageDataUri(await fs.readFile(imagePath),'image/png');
        input.enable_prompt_expansion=true;
      } else if(model==='bytedance/seedance-2.5'){
        if(imagePath) input.image=imageDataUri(await fs.readFile(imagePath),'image/png');
        input.duration=Math.max(4,Math.min(30,Math.round(Number(options.durationSeconds)||5)));
        input.output_format='mp4';
      }
      const output=await replicateClient().run(model,{input});
      let url=typeof output==='string'?output:(output&&typeof output.url==='function'?output.url():firstUrl(output,'video'));
      if(!url)throw new Error('Replicate '+model+' no devolvió vídeo.');
      const outputPath=path.join(dir,'replicate-video-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
      const result=await downloadUrl(url,outputPath,240000);
      return {...result,provider:'replicate',model,status:'complete',durationSeconds:input.duration,routeMode:imagePath?'I2V':'T2V'};
    }catch(err){last=err;}
  }
  throw last||new Error('Replicate video exhausted.');
}
async function elevenTts(text,dir,options={}){
  const key=String(process.env.ELEVENLABS_API_KEY||'').trim();
  const voice=String(options.voiceId||process.env.ELEVENLABS_VOICE_ID||'').trim();
  if(!key||!voice)throw new Error('ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID no configuradas.');
  const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+encodeURIComponent(voice)+'?output_format=mp3_44100_128',{method:'POST',headers:{'xi-api-key':key,'content-type':'application/json'},body:JSON.stringify({text:String(text||''),model_id:String(process.env.ELEVENLABS_TTS_MODEL||'eleven_multilingual_v2')})});
  if(!r.ok)throw new Error('ElevenLabs TTS HTTP '+r.status);
  const outputPath=path.join(dir,'eleven-tts-'+Date.now()+'.mp3');await fs.writeFile(outputPath,Buffer.from(await r.arrayBuffer()));
  return {outputPath,bytes:(await fs.stat(outputPath)).size,provider:'elevenlabs',model:String(process.env.ELEVENLABS_TTS_MODEL||'eleven_multilingual_v2'),status:'complete'};
}
async function stabilityMusic(prompt,dir,options={}){
  const key=String(process.env.STABILITY_API_KEY||'').trim();if(!key)throw new Error('STABILITY_API_KEY no configurada.');
  const duration=Math.max(1,Math.min(180,Math.round(Number(options.durationSeconds)||30)));
  const form=new FormData();form.append('prompt',String(prompt||''));form.append('output_format','mp3');form.append('duration',String(duration));form.append('model',String(process.env.STABILITY_AUDIO_MODEL||'stable-audio-2.5'));
  const r=await fetch('https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio',{method:'POST',headers:{authorization:'Bearer '+key,accept:'audio/*'},body:form});
  if(!r.ok)throw new Error('Stability Audio HTTP '+r.status);
  const outputPath=path.join(dir,'stability-music-'+Date.now()+'.mp3');await fs.writeFile(outputPath,Buffer.from(await r.arrayBuffer()));
  return {outputPath,bytes:(await fs.stat(outputPath)).size,provider:'stability',model:String(process.env.STABILITY_AUDIO_MODEL||'stable-audio-2.5'),durationSeconds:duration,status:'complete'};
}
function capabilityCatalog(){
  return {
    image:{primary:'fal.ai/FLUX.1 schnell',fallbacks:['Replicate/FLUX.1 schnell','Google Gemini Image','OpenAI GPT Image 2','Stability Image']},
    video:{primary:'fal.ai/Seedance 2.5 I2V/T2V',fallbacks:['Replicate/Wan 2.7 I2V/T2V','Replicate/Seedance 2.5','Google Veo 3.1','OpenAI Sora 2','Runway','Kling']},
    voice:{primary:'Google Gemini TTS',fallbacks:['ElevenLabs Multilingual v2/v3','fal.ai MiniMax Speech 2.5','local Kokoro']},
    music:{primary:'Stability Stable Audio 2.5/3.0',fallbacks:['ElevenLabs Music','fal.ai MiniMax Music 2.0','royalty-free library']},
    editing:{primary:'FFmpeg local',fallbacks:['Remotion for programmable composition']},
    configured:{fal:falConfigured(),replicate:replicateConfigured(),elevenlabs:Boolean(String(process.env.ELEVENLABS_API_KEY||'').trim()),stability:Boolean(String(process.env.STABILITY_API_KEY||'').trim()),gemini:Boolean(String(process.env.GEMINI_API_KEY||'').trim()),openai:Boolean(String(process.env.OPENAI_API_KEY||'').trim())}
  };
}
module.exports={falConfigured,falImage,falVideo,falTts,falMusic,replicateConfigured,replicateVideo,elevenTts,stabilityMusic,capabilityCatalog};
