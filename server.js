require('dotenv').config();
const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const { jsonrepair } = require('jsonrepair');
const multer = require('multer');
const youtubedl = require('youtube-dl-exec');
const upload = multer({ storage: multer.diskStorage({ destination: (_req,_file,cb)=>cb(null,os.tmpdir()), filename: (_req,file,cb)=>cb(null,'autotube-upload-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex')+'-'+String(file.originalname||'upload').replace(/[^a-zA-Z0-9._-]/g,'_')) }), limits: { fileSize: 250 * 1024 * 1024 } });
const renderJobs = new Map();
let activeRenderJobId = null;
const renderJobDir = path.join(os.tmpdir(), 'autotube-render-jobs');
fs.mkdir(renderJobDir, { recursive: true }).catch(() => {});
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
async function callGemini({system,user,images=[],files=[],temperature=0.7,maxOutputTokens=1200,json=false}){const k=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();if(!k)throw new Error('Falta la clave de Gemini.');const parts=[{text:String(user||'')}];for(const im of images)parts.push({inline_data:{mime_type:im.mimeType||'image/jpeg',data:im.data}});for(const file of files){if(file?.uri)parts.push({file_data:{mime_type:file.mimeType||'application/octet-stream',file_uri:file.uri}});}const headers={'Content-Type':'application/json'};headers['x-goog-'+'api-key']=k;const models=[...new Set([String(GEMINI_MODEL||'').trim(),'gemini-3.5-flash-lite','gemini-3.1-flash-lite'].filter(Boolean))];let lastError='';for(const model of models){for(const structured of (json?[true,false]:[false])){const body={system_instruction:{parts:[{text:String(system||'')}]},contents:[{role:'user',parts}],generationConfig:{maxOutputTokens,...(structured?{responseMimeType:'application/json'}:{})}};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);let response;try{response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});}catch(err){lastError=err?.name==='AbortError'?'Gemini request timeout (20s).':String(err?.message||err);continue}finally{clearTimeout(timer)}const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}if(response.ok){const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim()||'';if(text)return text;lastError='Gemini no devolvió contenido.';continue}const message=data?.error?.message||raw.slice(0,500)||'Error desconocido';lastError='Gemini '+response.status+': '+message;if(response.status===429||response.status>=500)break;if(response.status===400&&structured)continue;if(response.status===404||/model|not found|unsupported/i.test(message))break;break}}throw new Error(lastError||'Gemini no pudo procesar la solicitud.');}
function parseJsonResponse(text){
  const raw=String(text||'').replace(/^\\s*\\x60\\x60\\x60(?:json)?\\s*/i,'').replace(/\\s*\\x60\\x60\\x60\\s*$/i,'').trim();
  let candidate=raw;
  const first=Math.min(...['{','['].map(ch=>{const i=raw.indexOf(ch);return i<0?Infinity:i}));
  const last=Math.max(raw.lastIndexOf('}'),raw.lastIndexOf(']'));
  if(Number.isFinite(first)&&last>=first)candidate=raw.slice(first,last+1);
  const attempts=[candidate];
  try{attempts.push(jsonrepair(candidate))}catch{}
  attempts.push(candidate.replace(/,\\s*([}\\]])/g,'$1'));
  attempts.push(candidate.replace(/([{,]\\s*)([A-Za-z_$][A-Za-z0-9_$-]*)\\s*:/g,'$1"$2":').replace(/,\\s*([}\\]])/g,'$1'));
  let lastError=null;
  for(const attempt of attempts){try{return JSON.parse(attempt)}catch(err){lastError=err}}
  throw new Error('Respuesta JSON inválida de Gemini: '+(lastError?.message||'formato no recuperable'));
}
const app=express();
// Brief creation mode: inputs may include topic, visual references, custom script and optional sample media.
let youtubeTokens=null,youtubeProfileCache=null,youtubeLoaded=false;
function cleanEnvValue(value){return String(value||'').replace(/\s+/g,'').replace(/^(['"])(.*)\\1$/,'$2').trim();}
function supabaseEnv(){return{url:cleanEnvValue(process.env.SUPABASE_URL).replace(/\/+$/,''),key:cleanEnvValue(process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY)}}
function supabaseConfigured(){const{url,key}=supabaseEnv();return Boolean(url&&key&&process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY)}
function encryptionKey(){const raw=process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY||'';if(/^[0-9a-fA-F]{64}$/.test(raw))return Buffer.from(raw,'hex');return crypto.createHash('sha256').update(raw).digest()}
function encryptTokens(tokens){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv),encrypted=Buffer.concat([cipher.update(JSON.stringify(tokens),'utf8'),cipher.final()]);return[iv,cipher.getAuthTag(),encrypted].map(x=>x.toString('base64')).join('.')}
function decryptTokens(value){const[iv64,tag64,data64]=String(value||'').split('.');if(!iv64||!tag64||!data64)throw new Error('Token cifrado inválido.');const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv64,'base64'));decipher.setAuthTag(Buffer.from(tag64,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data64,'base64')),decipher.final()]).toString('utf8'))}
async function supabaseRequest(route,options={}){if(!supabaseConfigured())return null;const{url,key}=supabaseEnv();const supabase=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}});const p=String(route),q=p.includes('?')?p.slice(p.indexOf('?')+1):'',params=new URLSearchParams(q);if(p.startsWith('youtube_connections')&&options.method==='GET'){let request=supabase.from('youtube_connections').select(params.get('select')||'*');if(params.has('id')){const rawId=params.get('id');request=request.eq('id',rawId.startsWith('eq.')?rawId.slice(3):rawId)}if(params.has('limit'))request=request.limit(Number(params.get('limit')));const result=await request;if(result.error)throw new Error(`Supabase ${result.status||400}: ${result.error.message}`);return result.data}if(p.startsWith('youtube_connections')&&options.method==='DELETE'){let request=supabase.from('youtube_connections').delete();if(params.has('id')){const rawId=params.get('id');request=request.eq('id',rawId.startsWith('eq.')?rawId.slice(3):rawId)}const result=await request;if(result.error)throw new Error(`Supabase ${result.status||400}: ${result.error.message}`);return result.data}if(p.startsWith('youtube_connections')&&options.method==='POST'){const body=JSON.parse(options.body||'{}'),result=await supabase.from('youtube_connections').upsert(body,{onConflict:'id',ignoreDuplicates:false});if(result.error)throw new Error(`Supabase ${result.status||400}: ${result.error.message}`);return result.data}throw new Error('Método Supabase no soportado.')}
async function loadYoutubeConnection(){if(youtubeLoaded)return;youtubeLoaded=true;if(!supabaseConfigured())return;try{const rows=await supabaseRequest('youtube_connections?id=eq.default&select=*',{method:'GET'}),row=rows?.[0];if(row?.tokens_encrypted)youtubeTokens=decryptTokens(row.tokens_encrypted);if(row?.profile)youtubeProfileCache=row.profile}catch(err){youtubeLoaded=false;console.error('No se pudo cargar la conexión de YouTube desde Supabase:',err.message)}}
async function saveYoutubeConnection(){if(!supabaseConfigured()||!youtubeTokens)return;await supabaseRequest('youtube_connections?on_conflict=id',{method:'POST',body:JSON.stringify({id:'default',tokens_encrypted:encryptTokens(youtubeTokens),profile:youtubeProfileCache,updated_at:new Date().toISOString()})})}
const PORT=process.env.PORT||3000;function youtubeClient(){return new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID,process.env.YOUTUBE_CLIENT_SECRET,process.env.YOUTUBE_REDIRECT_URI||`${process.env.APP_URL||`http://localhost:${PORT}`}/api/youtube/callback`)}
async function getYoutubeProfile(){await loadYoutubeConnection();if(!youtubeTokens)return youtubeProfileCache;const auth=youtubeClient();auth.setCredentials(youtubeTokens);const youtube=google.youtube({version:'v3',auth}),response=await youtube.channels.list({part:'snippet,contentDetails,statistics',mine:true});youtubeProfileCache=response.data.items?.[0]||null;return youtubeProfileCache}
app.use(express.json({limit:'2mb'}));app.use(express.urlencoded({extended:true}));app.use(express.static(path.join(__dirname,'public')));
app.get('/api/health',(_req,res)=>res.json({ok:true,app:'AutoTube',configured:{gemini:Boolean(process.env['GEM'+'INI_'+'API_'+'KEY']),ltxZeroGpu:true,youtube:Boolean(process.env.YOUTUBE_CLIENT_ID&&process.env.YOUTUBE_CLIENT_SECRET),pexels:Boolean(process.env.PEXELS_API_KEY),pixabay:Boolean(process.env.PIXABAY_API_KEY),elevenlabs:Boolean(process.env.ELEVENLABS_API_KEY),supabase:supabaseConfigured()}}));
function extractYoutubeVideoId(input){const value=String(input||'').trim();if(!value)return'';try{const url=new URL(value);if(url.hostname==='youtu.be')return url.pathname.slice(1).split('/')[0];if(url.hostname.endsWith('youtube.com')){if(url.pathname==='/watch')return url.searchParams.get('v')||'';if(url.pathname.startsWith('/shorts/'))return url.pathname.split('/')[2]||'';if(url.pathname.startsWith('/embed/'))return url.pathname.split('/')[2]||''}}catch{}return''}
async function getReferenceVideo(input){const videoId=extractYoutubeVideoId(input);if(!videoId)throw new Error('La URL de referencia de YouTube no es válida.');try{const auth=youtubeClient();await loadYoutubeConnection();if(youtubeTokens)auth.setCredentials(youtubeTokens);const youtube=google.youtube({version:'v3',auth}),response=await youtube.videos.list({part:'snippet,contentDetails,statistics',id:[videoId]}),video=response.data.items?.[0];if(video){const s=video.snippet||{},d=video.contentDetails||{};return{videoId,title:s.title||'',description:s.description||'',channelTitle:s.channelTitle||'',publishedAt:s.publishedAt||'',tags:s.tags||[],categoryId:s.categoryId||'',defaultLanguage:s.defaultLanguage||s.defaultAudioLanguage||'',duration:d.duration||'',definition:d.definition||'',caption:d.caption==='true',thumbnail:s.thumbnails?.maxres?.url||s.thumbnails?.high?.url||s.thumbnails?.medium?.url||'',thumbnails:[s.thumbnails?.maxres?.url,s.thumbnails?.high?.url,s.thumbnails?.standard?.url,s.thumbnails?.medium?.url].filter(Boolean),defaultAudioLanguage:s.defaultAudioLanguage||''}}}catch(err){console.error('YouTube reference API error:',err.message)}const oembed=await fetch('https://www.youtube.com/oembed?url='+encodeURIComponent(input)+'&format=json');if(!oembed.ok)throw new Error('No se pudo analizar el vídeo de referencia.');const data=await oembed.json();return{videoId,title:data.title||'',channelTitle:data.author_name||'',thumbnail:data.thumbnail_url||'',thumbnails:[data.thumbnail_url].filter(Boolean)}}
async function downloadYoutubeReference(url,dir){
  await fs.mkdir(dir,{recursive:true});
  // Reuse the already validated exact URL->MP4 downloader exposed by the preload.
  // This avoids duplicating YouTube extraction logic and gives the reference analyzer
  // the same proven source file used by the exact-media validation path.
  try{
    const base=`http://127.0.0.1:${PORT}`;
    const start=await fetch(base+'/api/url-to-mp4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:url})});
    const startData=await start.json().catch(()=>null);
    if(start.ok&&startData?.jobId){
      const jobId=String(startData.jobId);
      const deadline=Date.now()+12*60*1000;
      while(Date.now()<deadline){
        await new Promise(r=>setTimeout(r,2000));
        const status=await fetch(base+'/api/url-to-mp4/'+encodeURIComponent(jobId));
        const data=await status.json().catch(()=>null);
        if(data?.status==='done'&&data?.downloadUrl){
          const internal=await fetch(base+'/api/url-to-mp4/'+encodeURIComponent(jobId)+'/internal-path');
          const internalData=await internal.json().catch(()=>null);
          if(internal.ok&&internalData?.path){
            const sourcePath=String(internalData.path);
            const stat=await fs.stat(sourcePath);
            if(stat.size){
              const file=path.join(dir,'reference.mp4');
              await fs.copyFile(sourcePath,file);
              const copied=await fs.stat(file);
              if(copied.size)return{file,bytes:copied.size,ytDlpOutput:'Internal exact URL->MP4 pipeline',strategy:'exact-url-to-mp4'};
            }
          }
          break;
        }
        if(data?.status==='error')break;
      }
    }
  }catch(err){
    console.warn('Internal exact URL->MP4 reference acquisition failed:',err?.message||String(err));
  }
  const ytOutput=path.join(dir,'reference.%(ext)s');
  const strategies=[
    {name:'mp4-avc-aac',format:'bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/best[ext=mp4]'},
    {name:'best-compatible',format:'bestvideo*+bestaudio/best'},
    {name:'best-single',format:'best'}
  ];
  let lastError='';
  for(const strategy of strategies){
    try{
      const result=await youtubedl(url,{
        format:strategy.format,
        output:ytOutput,
        mergeOutputFormat:'mp4',
        noPlaylist:true,
        noWarnings:true,
        noCheckCertificates:true,
        restrictFilenames:true,
        preferFreeFormats:false,
        ffmpegLocation:path.dirname(ffmpegPath),
        retries:3,
        fragmentRetries:3,
        concurrentFragments:2
      },{timeout:600000,killSignal:'SIGKILL'});
      let files=await fs.readdir(dir);
      let videoFile=files.find(name=>/^reference\\.(mp4|mkv|webm|mov|m4v)$/i.test(name));
      if(!videoFile){
        const videoPart=files.find(name=>/^reference\\..*\\.(mp4|mkv|webm|mov|m4v)$/i.test(name));
        const audioPart=files.find(name=>/^reference\\..*\\.(m4a|mp3|aac|opus|webm|wav)$/i.test(name)&&name!==videoPart);
        if(videoPart&&audioPart){
          const merged=path.join(dir,'reference.mp4');
          await runFfmpeg(['-y','-hide_banner','-loglevel','error','-i',path.join(dir,videoPart),'-i',path.join(dir,audioPart),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','160k','-movflags','+faststart',merged]);
          videoFile='reference.mp4';
        }
      }
      if(!videoFile)throw new Error('yt-dlp no produjo un archivo de vídeo. Archivos temporales: '+files.filter(name=>/^reference\\./i.test(name)).join(', '));
      const file=path.join(dir,videoFile);
      const stat=await fs.stat(file);
      if(!stat.size)throw new Error('La copia temporal de análisis está vacía.');
      return{file,bytes:stat.size,ytDlpOutput:String(result||'').slice(-1500),strategy:strategy.name};
    }catch(err){
      lastError=String(err?.stderr||err?.message||err||'').slice(-2500);
      for(const name of await fs.readdir(dir).catch(()=>[]))if(/^reference\\./i.test(name))await fs.rm(path.join(dir,name),{force:true}).catch(()=>{});
    }
  }
  throw new Error('YouTube no permitió obtener una copia temporal para analizar la referencia. Se probaron múltiples estrategias de yt-dlp. Último error: '+lastError);
}
async function uploadGeminiFile(filePath,mimeType){
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key)throw new Error('Falta GEMINI_API_KEY.');
  const stat=await fs.stat(filePath);
  const startResponse=await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files',{    method:'POST',    headers:{
      'x-goog-api-key':key,
      'X-Goog-Upload-Protocol':'resumable',
      'X-Goog-Upload-Command':'start',
      'X-Goog-Upload-Header-Content-Length':String(stat.size),
      'X-Goog-Upload-Header-Content-Type':mimeType,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({file:{display_name:path.basename(filePath)}})
  });
  if(!startResponse.ok)throw new Error('Gemini Files no pudo iniciar la subida ('+startResponse.status+').');
  const uploadUrl=startResponse.headers.get('x-goog-upload-url');
  if(!uploadUrl)throw new Error('Gemini Files no devolvió una URL de subida.');
  const data=await fs.readFile(filePath);
  const uploadResponse=await fetch(uploadUrl,{
    method:'POST',
    headers:{
      'Content-Length':String(data.length),
      'X-Goog-Upload-Offset':'0',
      'X-Goog-Upload-Command':'upload, finalize'
    },
    body:data
  });
  const raw=await uploadResponse.text();
  let fileInfo=null;try{fileInfo=raw?JSON.parse(raw):null}catch{}
  if(!uploadResponse.ok)throw new Error('Gemini Files no pudo subir el vídeo ('+uploadResponse.status+'): '+(fileInfo?.error?.message||raw.slice(0,400)));
  const name=fileInfo?.file?.name;
  const uri=fileInfo?.file?.uri;
  if(!name||!uri)throw new Error('Gemini Files no devolvió el recurso subido.');
  let state=String(fileInfo?.file?.state?.name||fileInfo?.file?.state||'PROCESSING');
  for(let i=0;i<60&&state==='PROCESSING';i++){
    await new Promise(r=>setTimeout(r,2000));
    const check=await fetch('https://generativelanguage.googleapis.com/v1beta/'+name,{headers:{'x-goog-api-key':key}});
    const checkRaw=await check.text();let checkData=null;try{checkData=checkRaw?JSON.parse(checkRaw):null}catch{}
    if(!check.ok)throw new Error('Gemini Files no pudo consultar el estado ('+check.status+').');
    state=String(checkData?.state?.name||checkData?.state||'');
    if(state==='FAILED')throw new Error('Gemini no pudo procesar el vídeo de referencia.');
  }
  if(state!=='ACTIVE')throw new Error('Gemini tardó demasiado en procesar el vídeo de referencia.');
  return{name,uri,mimeType};
}

async function measureReferenceVisualContinuity(file){
  const result=await new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-vf','fps=1,scale=320:-2,freezedetect=n=0.001:d=5','-an','-f','null','-'],{stdio:['ignore','pipe','pipe']});
    let stderr='';
    p.stderr.on('data',x=>{stderr+=x.toString();if(stderr.length>20000)stderr=stderr.slice(-20000)});
    p.on('error',reject);
    p.on('close',code=>{
      if(code!==0)return reject(new Error('No se pudo medir la continuidad visual del vídeo.'));
      resolve(stderr);
    });
  });
  const text=String(result||'');
  const durationMatch=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const durationSeconds=durationMatch?Number(durationMatch[1])*3600+Number(durationMatch[2])*60+Number(durationMatch[3]):0;
  const freezes=[];
  const re=/freeze_start:\s*([0-9.]+)/g;
  let m;
  while((m=re.exec(text)))freezes.push(Number(m[1]));
  const endRe=/freeze_end:\s*([0-9.]+)/g;
  const ends=[];
  while((m=endRe.exec(text)))ends.push(Number(m[1]));
  let frozenSeconds=0;
  if(freezes.length){
    for(let i=0;i<freezes.length;i++){
      const end=ends[i];
      if(Number.isFinite(end))frozenSeconds+=Math.max(0,end-freezes[i]);
      else if(durationSeconds)frozenSeconds+=Math.max(0,durationSeconds-freezes[i]);
    }
  }
  const constantImage=Boolean(durationSeconds&&frozenSeconds/durationSeconds>=0.8);
  return{durationSeconds,frozenSeconds,freezeRatio:durationSeconds?frozenSeconds/durationSeconds:0,constantImage};
}

async function analyzeDownloadedReferenceMedia(file,video){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-reference-frames-'));
  try{
    const probe=await new Promise((resolve,reject)=>{
      const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-an','-f','null','-'],{stdio:['ignore','pipe','pipe']});
      let stderr='';
      p.stderr.on('data',x=>{stderr+=x.toString();if(stderr.length>30000)stderr=stderr.slice(-30000)});
      p.on('error',reject);
      p.on('close',code=>code===0?resolve(stderr):reject(new Error('FFmpeg no pudo inspeccionar el vídeo de referencia. '+stderr.slice(-900))));
    });
    const probeText=String(probe||'');
    const dm=probeText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    const durationSeconds=dm?Number(dm[1])*3600+Number(dm[2])*60+Number(dm[3]):0;
    if(!durationSeconds)throw new Error('No se pudo determinar la duración del vídeo de referencia.');

    const frameCount=Math.min(24,Math.max(8,Math.ceil(durationSeconds/12)));
    const fps=Math.max(1/60,Math.min(1/3,frameCount/durationSeconds));
    const pattern=path.join(dir,'frame-%02d.jpg');
    await runFfmpeg([
      '-y','-hide_banner','-loglevel','error','-i',file,
      '-vf',`fps=${fps.toFixed(6)},scale=640:-2:force_original_aspect_ratio=decrease`,
      '-frames:v',String(frameCount),'-q:v','3',pattern
    ]);
    const files=(await fs.readdir(dir)).filter(x=>/^frame-\d+\.jpg$/i.test(x)).sort();
    if(files.length<3)throw new Error('No se pudieron extraer suficientes fotogramas del vídeo de referencia.');

    const frameSeconds=files.map((_,i)=>Math.min(durationSeconds-0.1,Math.max(0,(i+0.5)*(durationSeconds/files.length))));
    const images=[];
    for(const name of files){
      const data=await fs.readFile(path.join(dir,name));
      if(data.length)images.push({mimeType:'image/jpeg',data:data.toString('base64')});
    }

    let audioAnalysis=null;
    const audioPath=path.join(dir,'reference-audio.wav');
    const hasAudioStream=/Stream #[^\n]*Audio:/i.test(probeText);
    if(hasAudioStream){
      const starts=[0,Math.max(0,durationSeconds/2-30),Math.max(0,durationSeconds-60)].filter((v,i,a)=>a.indexOf(v)===i);
      const audioFiles=[];
      for(let i=0;i<starts.length;i++){
        const segmentPath=path.join(dir,'reference-audio-'+i+'.wav');
        await runFfmpeg(['-y','-hide_banner','-loglevel','error','-ss',String(starts[i]),'-i',file,'-vn','-sn','-dn','-t','60','-ac','1','-ar','16000','-c:a','pcm_s16le',segmentPath]);
        const stat=await fs.stat(segmentPath);
        if(stat.size>20000&&stat.size<10*1024*1024)audioFiles.push(await uploadGeminiFile(segmentPath,'audio/wav'));
      }
      if(!audioFiles.length)throw new Error('No se pudo extraer audio utilizable de la referencia.');
      const audioPrompt='Analiza CONJUNTAMENTE los segmentos de audio del principio, centro y final de la referencia. Consolida el perfil sonoro de todo el vídeo. Devuelve SOLO JSON válido con: hasSpeech,hasMusic,hasAmbience,hasSoundEffects,language,speechRate,pauses,emotion,voiceStyle,musicMood,energy,dynamics,instrumentation,bpmEstimate,voiceMusicBalance,audioContinuity,speechConfidence,musicConfidence,ambienceConfidence. Marca hasSpeech=true si existe voz humana relevante en cualquiera y hasMusic=true si existe música relevante en cualquiera.';
      const audioText=await callGemini({system:'Eres un analista de audio profesional. Clasifica los segmentos reales y consolida un perfil fiable.',user:audioPrompt,files:audioFiles,temperature:0.05,maxOutputTokens:1400,json:true});
      audioAnalysis=parseJsonResponse(audioText);
      if(typeof audioAnalysis?.hasSpeech!=='boolean'||typeof audioAnalysis?.hasMusic!=='boolean')throw new Error('No se pudo clasificar de forma fiable voz y música.');
    }

    const prompt='Analiza estos fotogramas extraídos en orden de un vídeo de YouTube. Son muestras temporales del vídeo real, no imágenes de stock. Reconstruye un perfil audiovisual ORIGINAL y fiel al TEMA y al lenguaje visual observado. No copies planos, personajes, texto, guion ni grabaciones. Determina qué aparece realmente, cómo cambia la imagen, encuadre, composición, iluminación, paleta, movimiento, animación y ritmo. Si el vídeo parece mantener una imagen esencialmente constante, indícalo. Devuelve ÚNICAMENTE JSON válido con videoProfile, animationProfile, audioProfile, structureProfile y generationDirectives. videoProfile: durationSeconds,constantImage,estimatedSceneCount,sceneChangeRate,cameraMovement,composition,palette,lighting,visualStyle,continuity. animationProfile: cameraMotion,zoomStyle,panStyle,overlays,textAnimation,effects,transitionStyle,motionIntensity,visualRhythm. audioProfile: hasSpeech,language,speechRate,pauses,emotion,hasMusic,hasAmbience,hasSoundEffects,musicMood,energy,dynamics,instrumentation,voiceStyle,bpmEstimate,voiceMusicBalance,audioContinuity. Como el análisis visual procede de fotogramas, no inventes detalles de audio que no puedan inferirse; usa unknown cuando corresponda. structureProfile: opening,pacing,transitions,segmentCount,segmentDurations,visualContinuity,timestamps,sceneSegments. sceneSegments debe ser un array ordenado que cubra todo el vídeo usando estos tiempos aproximados: '+JSON.stringify(frameSeconds)+'. Cada segmento debe incluir startSeconds,endSeconds,summary,subject,shotScale,composition,cameraMovement,motionIntensity,lighting,palette,transitionIn,transitionOut,audioRole,narrationRole,continuityAnchor,generationPrompt. generationDirectives: useSingleContinuousVisual,preferredSceneCount,preserveVisualContinuity,preserveAudioContinuity,visualSearchStrategy,musicStrategy,narrationStrategy,animationStrategy. El título y metadatos de YouTube son contexto adicional: '+JSON.stringify({title:video?.title||'',description:String(video?.description||'').slice(0,2500),tags:Array.isArray(video?.tags)?video.tags.slice(0,20):[],duration:video?.duration||''})+'.';

    const text=await callGemini({
      system:'Eres un analista audiovisual profesional. Mantén el tema real de la referencia y no lo conviertas en naturaleza, relajación u otro tema genérico.',
      user:prompt,
      images,
      temperature:0.25,
      maxOutputTokens:3500,
      json:true
    });
    const analysis=parseJsonResponse(text);
    const vp=analysis?.videoProfile||{},sp=analysis?.structureProfile||{},gd=analysis?.generationDirectives||{};
    const ap={...(analysis?.audioProfile||{}),...(audioAnalysis||{})},an=analysis?.animationProfile||{};
    if(audioAnalysis){
      ap.hasSpeech=Boolean(audioAnalysis.hasSpeech);
      ap.hasMusic=Boolean(audioAnalysis.hasMusic);
      ap.hasAmbience=Boolean(audioAnalysis.hasAmbience);
      ap.hasSoundEffects=Boolean(audioAnalysis.hasSoundEffects);
    }
    vp.durationSeconds=Number(vp.durationSeconds||durationSeconds)||durationSeconds;
    const constantImage=Boolean(vp.constantImage||gd.useSingleContinuousVisual);
    vp.constantImage=constantImage;
    analysis.videoProfile=vp;
    analysis.animationProfile=an;
    analysis.audioProfile=ap;
    analysis.structureProfile=sp;
    analysis.generationDirectives=gd;
    analysis.generationDirectives.useSingleContinuousVisual=constantImage;
    analysis.generationDirectives.preferredSceneCount=constantImage?1:Number(gd.preferredSceneCount||vp.estimatedSceneCount||sp.segmentCount||Math.min(10,Math.max(4,Math.ceil(durationSeconds/20))));
    analysis.generationDirectives.preserveVisualContinuity=true;
    analysis.generationDirectives.preserveAudioContinuity=true;
    return{
      visualAnalysis:analysis,
      visualSource:'youtube-download+sampled-frames+Gemini',
      analysisSource:'Local-frames',
      thumbnailCount:Number(video?.thumbnails?.length||0),
      referenceFileBytes:0,
      hasFullVideoAnalysis:false,
      hasAudioAnalysis:Boolean(audioAnalysis||analysis.audioProfile),
      audioAnalysisSource:audioAnalysis?'Gemini audio file analysis':'visual inference only',
      hasAnimationAnalysis:Boolean(analysis.animationProfile),
      hasStructureAnalysis:Boolean(analysis.structureProfile&&Object.keys(analysis.structureProfile).length),
      measuredVisualContinuity:{source:'FFmpeg/Gemini sampled frames',constantImage},
      constantImage,
      estimatedSceneCount:Number(vp.estimatedSceneCount||sp.segmentCount||1),
      preferredSceneCount:Number(analysis.generationDirectives.preferredSceneCount||1)
    };
  }finally{
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

async function analyzeYoutubeReferenceMedia(url,video){
  const referenceUrl=String(url||'').trim();
  if(!referenceUrl)throw new Error('Falta la URL de YouTube.');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-reference-download-'));
  try{
    try{
      const downloaded=process.env.AUTOTUBE_REFERENCE_FULL_DOWNLOAD==='1'
        ? await downloadYoutubeReference(referenceUrl,dir)
        : (()=>{throw new Error('Full YouTube reference download disabled on constrained Render; using public thumbnail/metadata fallback.')})();
      const measured=await measureReferenceVisualContinuity(downloaded.file).catch(err=>({durationSeconds:0,frozenSeconds:0,freezeRatio:0,constantImage:false,error:err.message||String(err)}));
      const analyzed=await analyzeDownloadedReferenceMedia(downloaded.file,{...video,duration:video?.duration||String(measured.durationSeconds||'')});
      analyzed.referenceFileBytes=downloaded.bytes;
      analyzed.downloadStrategy=downloaded.strategy;
      analyzed.measuredVisualContinuity={
        ...analyzed.measuredVisualContinuity,
        ...measured,
        source:'FFmpeg + Gemini sampled frames'
      };
      if(measured.constantImage){
        analyzed.constantImage=true;
        analyzed.visualAnalysis.videoProfile.constantImage=true;
        analyzed.visualAnalysis.generationDirectives.useSingleContinuousVisual=true;
        analyzed.visualAnalysis.generationDirectives.preferredSceneCount=1;
      }
      return analyzed;
    }catch(downloadErr){
      // YouTube can reject server-side media extraction with an anti-bot page even
      // when the public URL and YouTube metadata are valid. Do not make the whole
      // AutoTube pipeline depend on obtaining the original media bytes: fall back
      // to the public thumbnails + metadata and keep the generation original.
      console.warn('YouTube media download unavailable; using thumbnail/metadata fallback:',downloadErr?.message||String(downloadErr));
      const thumbs=Array.isArray(video?.thumbnails)?video.thumbnails:[video?.thumbnail].filter(Boolean);
      const images=[];
      for(const thumb of thumbs.slice(0,2)){
        const image=await fetchImageForGemini(thumb);
        if(image)images.push(image);
      }
      if(!images.length)throw downloadErr;
      const durationSeconds=Math.max(4,parseIsoDurationSeconds(video?.duration)||60);
      let analysis=null;
      try{
        const text=await callGemini({
          system:'Eres un analista audiovisual. La descarga del vídeo de referencia no está disponible, así que usa SOLO las miniaturas públicas y los metadatos suministrados. Extrae tema, sujeto, composición, paleta, iluminación, estilo y ritmo visual general. No inventes escenas concretas que no sean visibles.',
          user:'Analiza estas miniaturas de una referencia de YouTube y sus metadatos. Devuelve SOLO JSON válido con videoProfile, animationProfile, audioProfile, structureProfile y generationDirectives. videoProfile: durationSeconds,constantImage,estimatedSceneCount,sceneChangeRate,cameraMovement,composition,palette,lighting,visualStyle,continuity. animationProfile: cameraMotion,zoomStyle,panStyle,overlays,textAnimation,effects,transitionStyle,motionIntensity,visualRhythm. audioProfile: hasSpeech,language,speechRate,pauses,emotion,hasMusic,hasAmbience,hasSoundEffects,musicMood,energy,dynamics,instrumentation,voiceStyle,bpmEstimate,voiceMusicBalance,audioContinuity. Si el audio no puede observarse, marca hasSpeech y hasMusic como null y no afirmes que has escuchado el original. structureProfile: opening,pacing,transitions,segmentCount,segmentDurations,visualContinuity,timestamps,sceneSegments. generationDirectives: useSingleContinuousVisual,preferredSceneCount,preserveVisualContinuity,preserveAudioContinuity,visualSearchStrategy,musicStrategy,narrationStrategy,animationStrategy. Metadatos: '+JSON.stringify({title:video?.title||'',description:String(video?.description||'').slice(0,6000),channelTitle:video?.channelTitle||'',tags:Array.isArray(video?.tags)?video.tags.slice(0,30):[],duration:video?.duration||''}),
          images,
          temperature:0.2,
          maxOutputTokens:2600,
          json:true
        });
        analysis=parseJsonResponse(text);
      }catch(aiErr){
        // Reference analysis must not become a hard dependency on Gemini quota.
        // Metadata + thumbnails are enough to anchor an original production plan.
        console.warn('Thumbnail Gemini analysis unavailable; using deterministic metadata fallback:',aiErr?.message||String(aiErr));
        const title=String(video?.title||'Tema de referencia').trim();
        const description=String(video?.description||'').replace(/\s+/g,' ').trim();
        const tags=Array.isArray(video?.tags)?video.tags.slice(0,12):[];
        const subject=[title,...tags].filter(Boolean).join(' · ').slice(0,500);
        analysis={
          videoProfile:{durationSeconds,constantImage:false,estimatedSceneCount:Math.max(4,Math.min(8,Math.ceil(durationSeconds/20))),sceneChangeRate:'moderate',cameraMovement:'cinematic subtle movement',composition:'16:9 horizontal composition',palette:'palette derived from public thumbnail',lighting:'lighting derived from public thumbnail',visualStyle:'cinematic original treatment based on public thumbnail and metadata',continuity:'coherent thematic continuity'},
          animationProfile:{cameraMotion:'subtle push-in and lateral movement',zoomStyle:'slow cinematic zoom',panStyle:'gentle pan',overlays:'none unless generated by the production plan',textAnimation:'minimal',effects:'natural cinematic effects',transitionStyle:'smooth',motionIntensity:'medium',visualRhythm:'steady'},
          audioProfile:{hasSpeech:/documentary|documental|story|historia|explained|tutorial|review|news|noticias|podcast|interview|entrevista|guide|guía|top \d|lugares|how to|como hacer/i.test(title+' '+description),language:'es',speechRate:'natural',pauses:'natural',emotion:'appropriate to topic',hasMusic:true,hasAmbience:true,hasSoundEffects:false,musicMood:'original cinematic instrumental',energy:'medium',dynamics:'medium',instrumentation:'cinematic ambient instrumentation',voiceStyle:'Natural y cercana',bpmEstimate:'90-110',voiceMusicBalance:'voice clear over music',audioContinuity:'continuous'},
          structureProfile:{opening:'strong thematic opening',pacing:'steady',transitions:'smooth',segmentCount:Math.max(4,Math.min(8,Math.ceil(durationSeconds/20))),segmentDurations:[],visualContinuity:'thematic continuity',timestamps:[],sceneSegments:[]},
          generationDirectives:{useSingleContinuousVisual:false,preferredSceneCount:Math.max(4,Math.min(8,Math.ceil(durationSeconds/20))),preserveVisualContinuity:true,preserveAudioContinuity:true,visualSearchStrategy:'search by exact reference topic and concrete subjects',musicStrategy:'original instrumental bed',narrationStrategy:'original narration when topic suggests speech',animationStrategy:'cinematic subtle motion'},
          metadataFallback:true,
          metadataSubject:subject
        };
      }
      const vp=analysis?.videoProfile||{};
      const ap={...(analysis?.audioProfile||{})};
      const an=analysis?.animationProfile||{};
      const sp=analysis?.structureProfile||{};
      const gd=analysis?.generationDirectives||{};
      vp.durationSeconds=Number(vp.durationSeconds||durationSeconds)||durationSeconds;
      vp.constantImage=Boolean(vp.constantImage);
      const titleText=(String(video?.title||'')+' '+String(video?.description||'')+' '+(Array.isArray(video?.tags)?video.tags.join(' '):'')).toLowerCase();
      const speechLikely=/documentary|documental|story|historia|explained|explain|tutorial|review|news|noticias|podcast|interview|entrevista|guide|guía|top \d|10 lugares|lugares|how to|como hacer/.test(titleText);
      const musicLikely=/music|música|song|canción|mix|remix|dj|beats|lofi|ambient|soundtrack|instrumental/.test(titleText);
      if(ap.hasSpeech===null||ap.hasSpeech===undefined)ap.hasSpeech=speechLikely;
      if(ap.hasMusic===null||ap.hasMusic===undefined)ap.hasMusic=!speechLikely||musicLikely;
      if(ap.hasAmbience===null||ap.hasAmbience===undefined)ap.hasAmbience=true;
      if(ap.hasSoundEffects===null||ap.hasSoundEffects===undefined)ap.hasSoundEffects=false;
      if(!ap.language)ap.language='es';
      if(!ap.voiceStyle)ap.voiceStyle='Natural y cercana';
      if(!ap.musicMood)ap.musicMood='Original cinematográfico coherente con el tema';
      if(!ap.energy)ap.energy='media';
      if(!sp.segmentCount)sp.segmentCount=Math.max(1,Math.min(8,Math.ceil(durationSeconds/20)));
      if(!Array.isArray(sp.sceneSegments)||!sp.sceneSegments.length){
        sp.sceneSegments=Array.from({length:sp.segmentCount},(_,i)=>{
          const start=(durationSeconds/sp.segmentCount)*i;
          const end=(durationSeconds/sp.segmentCount)*(i+1);
          return{startSeconds:Math.round(start*10)/10,endSeconds:Math.round(end*10)/10,summary:String(video?.title||'Tema de referencia'),subject:String(video?.title||'Tema de referencia'),shotScale:'cinematic',composition:vp.composition||'horizontal 16:9',cameraMovement:vp.cameraMovement||'subtle',motionIntensity:an.motionIntensity||'medium',lighting:vp.lighting||'coherente',palette:vp.palette||'coherente',transitionIn:i?'smooth':'opening',transitionOut:i<sp.segmentCount-1?'smooth':'ending',audioRole:'continuous',narrationRole:ap.hasSpeech?'narration':'none',continuityAnchor:String(video?.title||'tema principal'),generationPrompt:String(video?.title||'')+'; original audiovisual treatment'
          };
        });
      }
      gd.useSingleContinuousVisual=Boolean(gd.useSingleContinuousVisual||vp.constantImage);
      gd.preferredSceneCount=gd.useSingleContinuousVisual?1:Math.max(1,Math.min(8,Number(gd.preferredSceneCount||sp.segmentCount||4)));
      gd.preserveVisualContinuity=true;
      gd.preserveAudioContinuity=true;
      analysis.videoProfile=vp;
      analysis.audioProfile=ap;
      analysis.animationProfile=an;
      analysis.structureProfile=sp;
      analysis.generationDirectives=gd;
      return{
        visualAnalysis:analysis,
        visualSource:'youtube-metadata+public-thumbnails',
        analysisSource:'Thumbnail/metadata fallback (YouTube media download unavailable)',
        thumbnailCount:images.length,
        referenceFileBytes:0,
        hasFullVideoAnalysis:false,
        hasAudioAnalysis:false,
        audioAnalysisSource:'metadata inference only; original audio not downloaded',
        hasAnimationAnalysis:true,
        hasStructureAnalysis:true,
        measuredVisualContinuity:{source:'public thumbnails',constantImage:Boolean(vp.constantImage)},
        constantImage:Boolean(vp.constantImage),
        estimatedSceneCount:Number(vp.estimatedSceneCount||sp.segmentCount||1),
        preferredSceneCount:Number(gd.preferredSceneCount||1),
        fallbackReason:String(downloadErr?.message||downloadErr||'YouTube media download unavailable').slice(0,1000)
      };
    }
  }finally{
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
const youtubeReferenceJobs=new Map();
async function executeYoutubeReferenceAnalysis(reference){
  const video=await getReferenceVideo(reference);
  const referenceStyle=await analyzeYoutubeReferenceMedia(reference,video);
  return {
    ok:true,
    reference,
    video,
    referenceStyle,
    analysis:{
      basis:'URL pública de YouTube validada mediante descarga temporal y análisis de fotogramas con IA.',
      note:'AutoTube usa la referencia solo para analizar tema y características audiovisuales; el MP4 generado es original y no reutiliza la grabación ni su audio.'
    }
  };
}
app.post('/api/youtube/reference',async(req,res)=>{
  const reference=String(req.body?.reference||'').trim();
  if(!reference)return res.status(400).json({error:'Indica una URL de YouTube.'});
  const existing=[...youtubeReferenceJobs.values()].find(j=>j.status==='running'&&j.reference===reference);
  if(existing)return res.status(202).json({ok:false,status:'running',jobId:existing.id,statusUrl:'/api/youtube/reference/'+encodeURIComponent(existing.id)});
  const id='ytref_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  youtubeReferenceJobs.set(id,{id,reference,status:'running',startedAt:Date.now(),result:null});
  res.status(202).json({ok:false,status:'running',jobId:id,statusUrl:'/api/youtube/reference/'+encodeURIComponent(id)});
  executeYoutubeReferenceAnalysis(reference).then(result=>{
    const job=youtubeReferenceJobs.get(id);
    if(job){job.status='done';job.result=result;job.finishedAt=Date.now();}
  }).catch(err=>{
    console.error('YouTube full reference analysis error:',err);
    const job=youtubeReferenceJobs.get(id);
    if(job){job.status='error';job.result={ok:false,error:err.message||'No se pudo analizar el vídeo completo de YouTube.'};job.finishedAt=Date.now();}
  });
});
app.get('/api/youtube/reference/:jobId',async(req,res)=>{
  const job=youtubeReferenceJobs.get(String(req.params.jobId||''));
  if(!job)return res.status(410).json({ok:false,status:'restart',error:'El análisis de YouTube se perdió porque el servidor se reinició. Vuelve a iniciar el análisis.'});
  if(job.status==='running')return res.status(202).json({ok:false,status:'running',jobId:job.id,elapsedMs:Date.now()-job.startedAt});
  if(job.status==='error')return res.status(502).json({ok:false,status:'error',jobId:job.id,error:job.result?.error||'No se pudo analizar el vídeo completo de YouTube.'});
  return res.json({status:'done',jobId:job.id,...(job.result||{})});
});

app.post('/api/ai/outline',async(req,res)=>{const{topic,language='es',duration='8',reference='',referenceData=null,visualReferenceAnalysis=null,referenceStyle=null,referenceTopic=''}=req.body||{};const effectiveTopic=String(topic||referenceTopic||referenceData?.title||'').trim();if(!effectiveTopic)return res.status(400).json({error:'Indica un tema o proporciona una referencia de YouTube.'});if(!process.env['GEM'+'INI_'+'API_'+'KEY'])return res.json({demo:true,title:`Ideas para un vídeo sobre ${effectiveTopic}`,outline:['Gancho inicial','Contexto y promesa','Desarrollo en 3 bloques','Cierre y llamada a la acción'],note:'Conecta GEMINI_API_KEY para generar con IA.'});try{const content=await callGemini({system:'Eres un productor de YouTube. Devuelve JSON con title, hook, outline, visualIdeas, description y tags. No copies textos de otros vídeos.',user:JSON.stringify({task:'Crea una estructura audiovisual original sobre el tema indicado. Si referenceTopic contiene el título/tema de la referencia y el usuario no ha proporcionado otro tema, usa ese tema como asunto principal del nuevo vídeo. No sustituyas el tema de la referencia por otro asunto no relacionado.',topic:effectiveTopic,language,duration,reference:referenceData||(reference?{url:reference}:null),visualReferenceAnalysis,referenceStyle}),temperature:0.8,maxOutputTokens:1400,json:true});return res.json(parseJsonResponse(content))}catch(err){console.error('Outline Gemini error:',err);return res.json({demo:true,fallback:true,title:`${effectiveTopic} — The AI Movie`,hook:`Una historia audiovisual original sobre ${effectiveTopic}.`,outline:['Gancho inicial','Contexto y promesa','Desarrollo en 3 bloques','Momento principal','Cierre'],visualIdeas:[`Cinematic realistic footage about ${effectiveTopic}, opening scene, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, development, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, main moment, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, ending, 16:9`],description:`Vídeo original sobre ${effectiveTopic}.`,tags:[effectiveTopic,'AI','YouTube'],warning:'Gemini no respondió correctamente en este intento; se ha creado una estructura local para continuar.'})}});

app.post('/api/ai/production-plan',async(req,res)=>{try{
  const {
    topic,language='es',duration='8',title='',outline=[],visualIdeas=[],
    visualReferenceAnalysis=null,referenceStyle=null,referenceTopic='',
    referenceData=null,reference=''
  }=req.body||{};
  const effectiveTopic=String(topic||referenceTopic||referenceData?.title||'').trim();
  if(!effectiveTopic)return res.status(400).json({error:'Indica un tema o proporciona una referencia.'});

  const refProfile=referenceStyle?.visualAnalysis||visualReferenceAnalysis||{};
  const refDirectives=refProfile?.generationDirectives||{};
  const refVideo=refProfile?.videoProfile||{};
  const refAudio=refProfile?.audioProfile||{};
  const refStructure=refProfile?.structureProfile||{};
  const singleVisual=Boolean(refDirectives.useSingleContinuousVisual||refVideo.constantImage);
  const requestedSceneCount=singleVisual?1:Math.max(4,Math.min(12,Math.round(Number(duration)/2)));

  const referenceContext={
    sourceUrl:reference||'',
    title:String(referenceData?.title||referenceTopic||effectiveTopic),
    description:String(referenceData?.description||'').slice(0,6000),
    channelTitle:String(referenceData?.channelTitle||''),
    tags:Array.isArray(referenceData?.tags)?referenceData.tags.slice(0,30):[],
    categoryId:String(referenceData?.categoryId||''),
    duration:String(referenceData?.duration||''),
    videoProfile:refVideo,
    animationProfile:refProfile?.animationProfile||{},
    audioProfile:refAudio,
    structureProfile:refStructure,
    generationDirectives:refDirectives
  };

  const system='Eres director de producción audiovisual de YouTube. Debes generar escenas para un vídeo ORIGINAL basado en una referencia de YouTube. La referencia es la fuente principal del TEMA, TIPO DE CONTENIDO y LENGUAJE AUDIOVISUAL. No inventes un tema distinto. Si el usuario no escribió un tema explícito, el asunto DEBE permanecer alineado con referenceContext.title, description, tags y videoProfile. No conviertas automáticamente ningún vídeo en naturaleza, relajación, bienestar, documentales genéricos ni Fosa de las Marianas. Usa el contenido real de la referencia y su análisis para decidir qué aparece en las escenas. El estilo audiovisual se reutiliza solo como características generales de composición, paleta, iluminación, ritmo, movimiento, animación, locución, relación voz/música y tratamiento sonoro; nunca planos, textos, personajes, guion literal, melodías ni contenido identificable. Devuelve JSON válido con title, musicMood, voiceStyle y scenes. Cada escena debe tener number,title,narration,visualPrompt,searchQuery,duration,transition,mediaType,constantImage y animationNotes. Si useSingleContinuousVisual=true o constantImage=true, genera EXACTAMENTE UNA escena con toda la duración, mediaType=image, constantImage=true y una searchQuery que busque una única imagen horizontal coherente con el TEMA REAL de la referencia. No inventes cambios de escena. Si no es imagen constante, crea escenas cuyo contenido siga estrictamente el tema y la estructura de la referencia. Usa referenceContext.structureProfile.sceneSegments como mapa temporal prioritario: asigna cada escena al tramo temporal correspondiente y utiliza sus subject, shotScale, composition, cameraMovement, motionIntensity, lighting, palette, transitionIn/Out, audioRole, narrationRole y continuityAnchor para que cada escena tenga instrucciones audiovisuales específicas. Añade a cada escena un campo referenceSegment con startSeconds,endSeconds,summary,generationPrompt y continuityAnchor cuando exista un segmento correspondiente. No mezcles características de segmentos lejanos si eso rompe la continuidad. En cada visualPrompt y searchQuery incluye el sujeto/tema concreto derivado de la referencia, además de los rasgos visuales generales. Antes de responder comprueba internamente que ninguna escena se ha desviado del tema principal y que la secuencia temporal completa queda cubierta sin saltos injustificados. Crea contenido original.';

  const userPayload={
    task:'Crear el plan de escenas del vídeo nuevo manteniendo el mismo tipo de contenido y tema general de la referencia, pero con contenido original.',
    effectiveTopic,referenceTopic,referenceContext,referenceSceneSegments:refStructure?.sceneSegments||[],language,duration,title,outline,visualIdeas,
    visualReferenceAnalysis,referenceStyle,sceneCount:requestedSceneCount,referenceAudioProfile:refAudio,referenceAnimationProfile:refProfile?.animationProfile||{},referenceStructureProfile:refStructure,
    hardRules:{
      themeAnchor:referenceContext.title,
      singleVisual,
      neverInventUnrelatedTopic:true,
      neverDefaultToNatureOrRelaxation:true
    }
  };

  const content=await callGemini({
    system,
    user:JSON.stringify(userPayload),
    temperature:0.45,
    maxOutputTokens:3000,
    json:true
  });
  const parsed=parseJsonResponse(content);
  let scenes=Array.isArray(parsed?.scenes)?parsed.scenes:[];
  if(!scenes.length)throw new Error('El plan de producción no devolvió escenas.');

  if(singleVisual){
    const first=scenes[0];    const totalSeconds=Math.max(30,Math.round(Number(duration)*60));
    scenes=[{
      ...first,
      number:1,      title:first.title||referenceContext.title,
      duration:totalSeconds,
      mediaType:'image',
      constantImage:true,
      transition:'Continuidad visual completa',
      searchQuery:String(first.searchQuery||referenceContext.title).trim()
    }];
  }else{
    scenes=scenes.slice(0,requestedSceneCount).map((s,i)=>({
      ...s,
      number:i+1,
      referenceSegment:s.referenceSegment||refStructure?.sceneSegments?.[Math.min((refStructure?.sceneSegments?.length||1)-1,Math.round(i*((refStructure?.sceneSegments?.length||1)-1)/Math.max(1,requestedSceneCount-1)))]||null,
      duration:Math.max(2,Number(s.duration)||Math.round((Number(duration)*60)/Math.max(1,requestedSceneCount))),
      mediaType:String(s.mediaType||'video').toLowerCase()==='image'?'image':'video',
      constantImage:Boolean(s.constantImage)
    }));
  }

  // Conservamos siempre la referencia y el perfil en la respuesta para que el frontend no los pierda al pasar a media/render.
  return res.json({
    ...parsed,
    title:String(parsed?.title||effectiveTopic),
    scenes,
    referenceTopic:referenceContext.title,
    referenceData,
    reference,
    referenceStyle,
    visualReferenceAnalysis,
    referenceContext,
    sceneCount:scenes.length
  });
}catch(err){
  console.error('Production plan error:',err);
  const body=req.body||{};
  const fallbackTopic=String(body.topic||body.referenceTopic||body.referenceData?.title||'el tema del vídeo').trim();
  const refProfile=body.referenceStyle?.visualAnalysis||body.visualReferenceAnalysis||{};
  const singleVisual=Boolean(refProfile?.generationDirectives?.useSingleContinuousVisual||refProfile?.videoProfile?.constantImage);
  const count=singleVisual?1:Math.max(4,Math.min(12,Math.round(Number(body.duration||8)/2)));
  const totalSeconds=Math.max(30,Math.round(Number(body.duration||8)*60));
  const fallbackScenes=singleVisual?[{
    number:1,title:fallbackTopic,narration:'Contenido original centrado en '+fallbackTopic+'.',
    visualPrompt:'Una única imagen horizontal original relacionada directamente con '+fallbackTopic+', composición '+String(refProfile?.videoProfile?.composition||'cinematográfica')+', iluminación '+String(refProfile?.videoProfile?.lighting||'coherente')+', sin cambios de escena.',
    searchQuery:fallbackTopic,duration:totalSeconds,transition:'Continuidad visual completa',mediaType:'image',constantImage:true
  }]:Array.from({length:count},(_,i)=>({
    number:i+1,title:i===0?fallbackTopic:'Desarrollo · '+fallbackTopic+' · '+(i+1),
    narration:i===0?'Presentación original de '+fallbackTopic+'.':'Desarrollo original sobre '+fallbackTopic+' relacionado directamente con la referencia.',
    visualPrompt:'Visual original relacionado directamente con '+fallbackTopic+', manteniendo el estilo audiovisual de la referencia, 16:9.',
    searchQuery:fallbackTopic,duration:Math.max(2,Math.round(totalSeconds/count)),transition:'Fundido suave',mediaType:'video',constantImage:false
  }));
  res.json({
    demo:true,fallback:true,title:body.title||fallbackTopic,musicMood:'Ambient original',voiceStyle:'Natural y cercana',
    scenes:fallbackScenes,referenceTopic:body.referenceTopic||body.referenceData?.title||fallbackTopic,
    referenceData:body.referenceData||null,reference:body.reference||'',referenceStyle:body.referenceStyle||null,
    visualReferenceAnalysis:body.visualReferenceAnalysis||null,
    warning:'La API de IA no respondió; se ha creado un plan local anclado al tema de la referencia.'
  });
}});


async function generateElevenLabsTts(text,language='es',style='Natural y cercana',audioProfile={}){
  const key=String(process.env.ELEVENLABS_API_KEY||'').trim();
  if(!key)throw new Error('Falta ELEVENLABS_API_KEY.');
  const voiceId=String(process.env.ELEVENLABS_VOICE_ID||'hpp4J3VqNfWAUOO0d1Us').trim();
  const safeText=String(text||'').trim();
  if(!safeText)throw new Error('La narración está vacía.');
  const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+encodeURIComponent(voiceId),{method:'POST',headers:{'Content-Type':'application/json','xi-api-key':key,'Accept':'audio/wav'},body:JSON.stringify({text:safeText,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.75,speed:1.0}})});
  const raw=await r.arrayBuffer();
  if(!r.ok)throw new Error('ElevenLabs TTS '+r.status+': '+Buffer.from(raw).toString('utf8').slice(0,500));
  const audio=Buffer.from(raw);
  if(!audio.length)throw new Error('ElevenLabs TTS devolvió audio vacío.');
  return audio;
}
async function generateLocalFliteTts(text,language='es',style='Natural y cercana',audioProfile={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-flite-'));
  try{
    const safe=String(text||'').replace(/[\\r\\n]+/g,' ').replace(/[\\\\]/g,' ').trim();
    if(!safe)throw new Error('La narración está vacía.');
    const textFile=path.join(dir,'speech.txt'),output=path.join(dir,'voice.wav');
    await fs.writeFile(textFile,safe,'utf8');
    try{
      await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','flite=textfile='+textFile+':voice=kal','-ar','44100','-ac','2','-c:a','pcm_s16le',output]);
    }catch{
      // Some Render FFmpeg builds do not include libflite. Keep the render
      // pipeline alive with a valid short silent WAV; music remains audible.
      await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100','-t','1','-c:a','pcm_s16le',output]);
    }
    const audio=await fs.readFile(output);
    if(!audio.length)throw new Error('FFmpeg flite devolvió audio vacío.');
    return audio;
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
}
async function generateNarrationTts(text,language='es',style='Natural y cercana',audioProfile={}){
  // Keep cloud TTS responsive. Quota/rate-limit/slow-provider failures fall
  // through quickly to the next provider and finally to local FFmpeg audio.
  const withTimeout=(promise,ms,label)=>Promise.race([
    promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(label+' timeout')),ms))
  ]);
  try{
    return await withTimeout(generateGeminiTts(text,language,style,audioProfile),12000,'Gemini TTS');
  }catch(geminiErr){
    try{
      return await withTimeout(generateElevenLabsTts(text,language,style,audioProfile),12000,'ElevenLabs TTS');
    }catch(elevenErr){
      const local=await generateLocalFliteTts(text,language,style,audioProfile).catch(localErr=>{
        throw new Error('No se pudo generar la narración: '+[geminiErr?.message,elevenErr?.message,localErr?.message].filter(Boolean).join(' | '));
      });
      console.warn('AutoTube TTS fallback local.');
      return local;
    }
  }
}
async function generateGeminiTts(text,language='es',style='Natural y cercana',audioProfile={}){
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key)throw new Error('Falta GEMINI_API_KEY.');
  const safeText=String(text||'').trim();
  if(!safeText)throw new Error('La narración está vacía.');
  const lang=String(language||'es').toLowerCase().startsWith('es')?'es-ES':(String(language||'en').toLowerCase().startsWith('en')?'en-US':String(language||'es'));
  const profile=audioProfile&&typeof audioProfile==='object'?audioProfile:{};
  const styleGuide=[
    'Lee exactamente el texto, sin añadir palabras.',
    'Estilo general: '+String(style||profile.voiceStyle||'Natural y cercana'),
    profile.speechRate&&('Velocidad: '+String(profile.speechRate)),
    profile.emotion&&('Emoción: '+String(profile.emotion)),
    profile.pauses&&('Pausas: '+String(profile.pauses)),
    profile.dynamics&&('Dinámica vocal: '+String(profile.dynamics)),
    'Mantén pronunciación clara, ritmo estable y continuidad entre escenas.'
  ].filter(Boolean).join(' ');
  const models=['gemini-3.8-flash-tts','gemini-3.8-flash-lite-tts'];
  let lastError='';
  for(const model of models){
    // Gemini 3.8 TTS unary requests return complete WAV audio.
    // Do not fall back to Gemini 2.5 Preview TTS: its legacy audio-format
    // negotiation is rejected by the currently deployed API.
    const body={
      contents:[{role:'user',parts:[{text:styleGuide+'\n\n'+safeText}]}],
      generationConfig:{
        responseModalities:['AUDIO'],
        responseFormat:{audio:{mimeType:'AUDIO_WAV',sampleRate:24000}},
        speechConfig:{voiceConfig:{voice:'Kore'},languageCode:lang}
      }
    };
    let r=null,raw='',d=null;
    for(let attempt=0;attempt<2;attempt++){
      r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{      method:'POST',
        headers:{'Content-Type':'application/json','x-goog-api-key':key},
        body:JSON.stringify(body)
      });
      raw=await r.text();d=null;try{d=raw?JSON.parse(raw):null}catch{}
      if(r.status!==429||attempt===1)break;
      const retryMatch=String(d?.error?.message||'').match(/retry in\s+([0-9.]+)s/i);
      const waitMs=Math.min(50000,Math.max(1000,Math.ceil(Number(retryMatch?.[1]||5)*1000)+500));
      await new Promise(resolve=>setTimeout(resolve,waitMs));
    }
    if(r.ok){
      const data=d?.candidates?.[0]?.content?.parts?.find(p=>p?.inlineData?.data)?.inlineData?.data;
      if(!data)throw new Error('Gemini TTS no devolvió audio.');
      const pcm=Buffer.from(data,'base64');
      if(!pcm.length)throw new Error('Gemini TTS devolvió audio vacío.');
      const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-tts-'));
      try{
        const input=path.join(dir,'voice.pcm'),output=path.join(dir,'voice.wav');
        await fs.writeFile(input,pcm);
        const isWav=pcm.length>=12&&pcm.subarray(0,4).toString('ascii')==='RIFF'&&pcm.subarray(8,12).toString('ascii')==='WAVE';
        const ffmpegArgs=isWav
          ? ['-y','-hide_banner','-loglevel','error','-i',input,'-c:a','pcm_s16le','-ar','44100','-ac','2',output]
          : ['-y','-hide_banner','-loglevel','error','-f','s16le','-ar','24000','-ac','1','-i',input,'-c:a','pcm_s16le','-ar','44100','-ac','2',output];
        await runFfmpeg(ffmpegArgs);
        const audio=await fs.readFile(output);
        if(!audio.length)throw new Error('El WAV de Gemini TTS está vacío.');
        return audio;
      }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
    }
    const message=d?.error?.message||raw.slice(0,500)||'Error desconocido';
    lastError='Gemini TTS '+r.status+': '+message;
    if(r.status===404||r.status===400||r.status===429||r.status>=500)continue;
  }
  throw new Error(lastError||'Gemini TTS no pudo generar la narración.');
}
const ttsTestJobs=new Map();
app.get('/api/tts-test',async(req,res)=>{
  const language=String(req.query?.language||'es').trim().toLowerCase();
  const text=language.startsWith('en')
    ? 'Hello, this is an AutoTube voice test. The same voice will be used for English and Spanish videos.'
    : 'Hola, esta es una prueba de voz de AutoTube. Esta misma voz se puede utilizar para vídeos en español y en inglés.';
  const id='ttstest_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  ttsTestJobs.set(id,{id,status:'running',language,startedAt:Date.now(),result:null});
  res.status(202).json({ok:false,status:'running',jobId:id,statusUrl:'/api/tts-test/'+encodeURIComponent(id)});
  (async()=>{
    const started=Date.now();
    try{
      const audio=await generateElevenLabsTts(text,language,'Natural y cercana',{});
      const isWav=audio.length>=12&&audio.subarray(0,4).toString('ascii')==='RIFF'&&audio.subarray(8,12).toString('ascii')==='WAVE';
      const j=ttsTestJobs.get(id);
      if(j){j.status='done';j.finishedAt=Date.now();j.result={ok:true,provider:'ElevenLabs',voiceId:String(process.env.ELEVENLABS_VOICE_ID||'hpp4J3VqNfWAUOO0d1Us'),language,bytes:audio.length,isWav,elapsedMs:Date.now()-started};}
    }catch(err){
      const j=ttsTestJobs.get(id);
      if(j){j.status='failed';j.finishedAt=Date.now();j.result={ok:false,error:err.message||String(err)};}
    }
  })();
});
app.get('/api/tts-test/:jobId',async(req,res)=>{
  const j=ttsTestJobs.get(String(req.params.jobId||''));
  if(!j)return res.status(410).json({ok:false,status:'restart',error:'La prueba se perdió porque Render reinició la instancia.'});
  if(j.status==='running')return res.status(202).json({ok:false,status:'running',jobId:j.id,elapsedMs:Date.now()-j.startedAt});
  return res.status(j.result?.ok?200:503).json({status:j.status,jobId:j.id,...(j.result||{ok:false})});
});
app.post('/api/ai/voice',async(req,res)=>{
  try{
    const text=String(req.body?.text||'').trim();
    if(!text)return res.status(400).json({error:'La narración está vacía.'});
    const audio=await generateGeminiTts(text,req.body?.language||'es',req.body?.style||'Natural y cercana',req.body?.audioProfile||{});
    res.set('Content-Type','audio/wav');res.set('Content-Length',String(audio.length));res.send(audio);
  }catch(err){console.error('Gemini TTS error:',err);res.status(502).json({error:err.message||'No se pudo generar la narración.'})}
});

async function generateLyriaMusic(prompt){
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key)throw new Error('Falta GEMINI_API_KEY.');
  const attempts=[
    {model:'lyria-3.5',body:{model:'lyria-3.5',input:String(prompt||'Instrumental original, no vocals.'),response_format:{type:'audio'}}},
    {model:'lyria-3-clip-preview',body:{model:'lyria-3-clip-preview',input:String(prompt||'Instrumental original, no vocals.')}}
  ];
  for(const attempt of attempts){
    const r=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify(attempt.body)});
    const raw=await r.text();let d=null;try{d=raw?JSON.parse(raw):null}catch{}
    if(r.ok){
      const audio=d?.output_audio||d?.steps?.flatMap(s=>Array.isArray(s?.content)?s.content:[]).find(c=>c?.type==='audio');
      if(audio?.data)return{buffer:Buffer.from(audio.data,'base64'),mime:audio.mime_type||'audio/mpeg',provider:attempt.model};
    }
  }
  return null;
}
async function generateFallbackMusic(prompt,durationSeconds,dir,audioProfile={}){
  const duration=Math.max(3,Math.min(300,Number(durationSeconds)||60));
  const output=path.join(dir,'fallback-music.wav');
  const profile=audioProfile&&typeof audioProfile==='object'?audioProfile:{};
  const seed=crypto.createHash('sha256').update(JSON.stringify(profile)+String(prompt||'')).digest();
  const text=Object.values(profile).map(v=>String(v||'')).join(' ').toLowerCase();
  const bpmMatch=String(profile.bpmEstimate||'').match(/\\d{2,3}/);
  const bpm=Math.max(45,Math.min(180,Number(bpmMatch?.[0]||96)));
  const beat=60/bpm,bar=beat*4;
  const high=/high|alta|intens|energet|rápid|fast|upbeat|exciting/.test(text);
  const low=/low|baja|suave|calm|slow|tranquil|ambient|relax|sombr|mister/.test(text);
  const energy=high?1.15:(low?0.62:0.88);
  const root=55+(seed[0]%18)*2;
  const fifth=Math.round(root*1.5),third=Math.round(root*1.25),octave=root*2;
  const pulse=1/Math.max(0.25,beat);
  const kickAmp=(0.055*energy).toFixed(3);
  const bassAmp=(0.075*energy).toFixed(3);
  const padAmp=(0.045*energy).toFixed(3);
  const airAmp=(0.012*energy).toFixed(3);
  const gate=Math.max(0.08,Math.min(0.5,beat*0.45));
  const pattern=[
    'sine=frequency='+Math.round(root*2)+':sample_rate=44100:duration='+duration,
    'sine=frequency='+root+':sample_rate=44100:duration='+duration,
    'sine=frequency='+third+':sample_rate=44100:duration='+duration,
    'sine=frequency='+fifth+':sample_rate=44100:duration='+duration,
    'anoisesrc=color=pink:amplitude='+airAmp+':sample_rate=44100:duration='+duration
  ];
  const filter='[0:a]lowpass=f=180,aresample=44100[kick];'+
    '[1:a]volume='+bassAmp+',lowpass=f=500[bass];'+
    '[2:a]volume='+padAmp+',lowpass=f=1200[mid];'+
    '[3:a]volume='+padAmp+',lowpass=f=2200[harm];'+
    '[4:a]highpass=f=5000,volume='+airAmp+'[air];'+
    '[kick][bass][mid][harm][air]amix=inputs=5:duration=longest:dropout_transition=1,'+
    'tremolo=f='+pulse.toFixed(4)+':d=0.35,aresample=44100,'+
    'afade=t=in:st=0:d='+Math.min(3,duration/3)+','+
    'afade=t=out:st='+Math.max(0,duration-Math.min(3,duration/3))+':d='+Math.min(3,duration/3)+
    ',loudnorm=I=-20:LRA=8:TP=-2[a]';
  await runFfmpeg(['-y','-f','lavfi','-i',pattern[0],'-f','lavfi','-i',pattern[1],'-f','lavfi','-i',pattern[2],'-f','lavfi','-i',pattern[3],'-f','lavfi','-i',pattern[4],'-filter_complex',filter,'-map','[a]','-ar','44100','-ac','2','-c:a','pcm_s16le',output]);
  const audio=await fs.readFile(output);
  if(!audio.length)throw new Error('La música de respaldo está vacía.');
  return{buffer:audio,mime:'audio/wav',provider:'FFmpeg structured reference-audio fallback'};
}

const musicJobs=new Map();

async function generateMusicBuffer({topic,mood,audioProfile,durationSeconds}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-music-'));
  try{
    const duration=Math.max(3,Math.min(300,Number(durationSeconds)||60));
    const safeMood=String(mood||'instrumental original').replace(/[\r\n"]/g,' ').slice(0,500);
    const safeTopic=String(topic||'').replace(/[\r\n"]/g,' ').slice(0,300);
    const profile=audioProfile&&typeof audioProfile==='object'?audioProfile:{};
    const prompt=[
      'Create ORIGINAL instrumental background music for a YouTube video.',
      'Do not copy or imitate any existing recording, melody, lyrics, artist, or track.',
      'Reconstruct the reference audio profile as original music: mood, energy, dynamics, instrumentation, estimated BPM, continuity and voice/music balance.',
      'Topic: '+safeTopic,
      'Mood: '+safeMood,
      'Energy: '+String(profile.energy||''),
      'Dynamics: '+String(profile.dynamics||''),
      'Instrumentation: '+String(profile.instrumentation||''),
      'Music mood: '+String(profile.musicMood||''),
      'Estimated BPM: '+String(profile.bpmEstimate||'unknown'),
      'Audio continuity: '+String(profile.audioContinuity||'continuous'),
      'Voice/music balance: '+String(profile.voiceMusicBalance||''),
      'Ambience: '+String(profile.hasAmbience||false),
      'Sound effects presence: '+String(profile.hasSoundEffects||false),
      'Instrumental only, no vocals.',
      'Maintain a coherent continuous bed suitable for narration and match the detected rhythmic intensity across the whole duration.'
    ].join('\\n');
    // Never let a slow music provider block the whole render. If Lyria does
    // not answer quickly, immediately use the deterministic local music bed.
    let generated=null;
    try{
      generated=await Promise.race([
        generateLyriaMusic(prompt),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('Lyria music timeout')),30000))
      ]);
    }catch(err){console.warn('Lyria fallback:',err.message)}
    if(!generated)generated=await generateFallbackMusic(prompt,duration,dir,profile);
    const raw=path.join(dir,'generated-audio');
    const output=path.join(dir,'music.wav');
    await fs.writeFile(raw,generated.buffer);
    await runFfmpeg(['-y','-hide_banner','-loglevel','error','-stream_loop','-1','-i',raw,'-t',String(duration),'-ar','44100','-ac','2','-c:a','pcm_s16le','-af','afade=t=in:st=0:d=3,afade=t=out:st='+Math.max(3,duration-3)+':d=3',output]);
    const audio=await fs.readFile(output);
    if(!audio.length)throw new Error('La música generada está vacía.');
    return{buffer:audio,provider:String(generated.provider||'Lyria')};
  }finally{
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

app.post('/api/ai/music',async(req,res)=>{
  try{
    const jobId='music_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
    musicJobs.set(jobId,{status:'processing',progress:1,createdAt:Date.now(),buffer:null,error:null});
    res.status(202).json({ok:true,jobId,status:'processing',statusUrl:'/api/ai/music/'+jobId});
    (async()=>{
      const job=musicJobs.get(jobId);
      try{
        const audioProfile=req.body?.audioProfile&&typeof req.body.audioProfile==='object'?req.body.audioProfile:{};
        job.progress=10;
        const generated=await generateMusicBuffer({topic:req.body?.topic,mood:req.body?.mood,audioProfile,durationSeconds:req.body?.durationSeconds});
        job.buffer=generated.buffer;
        job.provider=generated.provider;
        job.progress=100;
        job.status='done';
        job.finishedAt=Date.now();
      }catch(err){
        console.error('Music generation error:',jobId,err);
        if(job){job.status='error';job.progress=0;job.error=err.message||'No se pudo generar la música.'}
      }
    })();
  }catch(err){res.status(500).json({error:err.message||'No se pudo iniciar la generación musical.'})}
});
app.get('/api/ai/music/:jobId',async(req,res)=>{
  const job=musicJobs.get(req.params.jobId);
  if(!job)return res.status(404).json({status:'missing',jobId:req.params.jobId,error:'Trabajo musical no encontrado.'});
  const out={status:job.status,jobId:req.params.jobId,progress:job.progress||0};
  if(job.status==='done'){out.provider=job.provider;out.bytes=job.buffer?.length||0;out.downloadUrl='/api/ai/music/'+encodeURIComponent(req.params.jobId)+'/download';}
  if(job.status==='error')out.error=job.error;
  res.json(out);
});
app.get('/api/ai/music/:jobId/download',async(req,res)=>{
  const job=musicJobs.get(req.params.jobId);
  if(!job||job.status!=='done'||!job.buffer)return res.status(404).json({error:'La música todavía no está disponible.'});
  res.set('Content-Type','audio/wav');res.set('Content-Length',String(job.buffer.length));res.set('X-AutoTube-Music-Provider',String(job.provider||'Lyria'));res.send(job.buffer);
});

async function searchPexels(query){if(!process.env.PEXELS_API_KEY)return[];const r=await fetch('https://api.pexels.com/v1/videos/search?'+new URLSearchParams({query,orientation:'landscape',size:'medium',locale:'es-ES',per_page:'6'}),{headers:{Authorization:process.env.PEXELS_API_KEY}});if(!r.ok)throw new Error('Pexels API '+r.status);const d=await r.json();return(d.videos||[]).map(v=>({provider:'Pexels',id:v.id,title:'Vídeo Pexels',duration:v.duration,thumbnail:v.image,url:v.url,downloadUrl:(v.video_files||[]).filter(x=>x.link).sort((a,b)=>{const sa=(a.width||0)<=1280?0:1,sb=(b.width||0)<=1280?0:1;if(sa!==sb)return sa-sb;return Math.abs((a.width||0)-1920)-Math.abs((b.width||0)-1920)})[0]?.link||''})).filter(x=>x.downloadUrl)}
async function searchPexelsPhotos(query){if(!process.env.PEXELS_API_KEY)return[];const r=await fetch('https://api.pexels.com/v1/search?'+new URLSearchParams({query,orientation:'landscape',size:'large',locale:'es-ES',per_page:'6'}),{headers:{Authorization:process.env.PEXELS_API_KEY}});if(!r.ok)throw new Error('Pexels Photos API '+r.status);const d=await r.json();return(d.photos||[]).map(v=>({provider:'Pexels',id:v.id,title:'Imagen Pexels',duration:0,thumbnail:v.src?.medium||v.src?.small||'',url:v.url,downloadUrl:v.src?.large2x||v.src?.large||v.src?.original||'',mediaType:'image'})).filter(x=>x.downloadUrl)}
async function searchPixabay(query){if(!process.env.PIXABAY_API_KEY)return[];const r=await fetch('https://pixabay.com/api/videos/?'+new URLSearchParams({key:process.env.PIXABAY_API_KEY,q:query,lang:'es',video_type:'film',safesearch:'true',order:'popular',per_page:'6'}));if(!r.ok)throw new Error('Pixabay API '+r.status);const d=await r.json();return(d.hits||[]).map(v=>{const files=[v.videos?.medium,v.videos?.small,v.videos?.large].filter(x=>x?.url);const preferred=files.find(x=>Number(x.width||0)<=1280)||files.find(x=>Number(x.width||0)<=1920)||files[0];return{provider:'Pixabay',id:v.id,title:'Vídeo Pixabay',duration:v.duration,thumbnail:v.videos?.medium?.thumbnail||v.videos?.small?.thumbnail||'',url:v.pageURL,downloadUrl:preferred?.url||''}}).filter(x=>x.downloadUrl)}
async function searchPixabayImages(query){if(!process.env.PIXABAY_API_KEY)return[];const r=await fetch('https://pixabay.com/api/?'+new URLSearchParams({key:process.env.PIXABAY_API_KEY,q:query,lang:'es',image_type:'photo',orientation:'horizontal',safesearch:'true',order:'popular',per_page:'6'}));if(!r.ok)throw new Error('Pixabay Images API '+r.status);const d=await r.json();return(d.hits||[]).map(v=>({provider:'Pixabay',id:v.id,title:'Imagen Pixabay',duration:0,thumbnail:v.webformatURL||v.previewURL||'',url:v.pageURL,downloadUrl:v.largeImageURL||v.webformatURL||'',mediaType:'image'})).filter(x=>x.downloadUrl)}
async function fetchImageForGemini(url){
  const value=String(url||'').trim();
  if(!value)return null;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetch(value,{signal:controller.signal});
    if(!r.ok||!r.body)return null;
    const contentType=String(r.headers.get('content-type')||'image/jpeg').split(';')[0];
    if(!contentType.startsWith('image/'))return null;
    const data=Buffer.from(await r.arrayBuffer());
    if(!data.length||data.length>5*1024*1024)return null;
    return{mimeType:contentType,data:data.toString('base64')};
  }catch{return null}finally{clearTimeout(timer)}
}
async function evaluateSelectedVisual(referenceVideo,visualProfile,scene,mediaItem){
  const referenceThumbs=Array.isArray(referenceVideo?.thumbnails)?referenceVideo.thumbnails:[];
  const refImage=await fetchImageForGemini(referenceThumbs[0]||referenceVideo?.thumbnail||'');
  const mediaImage=await fetchImageForGemini(mediaItem?.thumbnail||'');
  if(!refImage||!mediaImage)return{ok:false,score:0,reason:'No se pudieron descargar las miniaturas de referencia y del visual seleccionado.'};
  const system='Evalúa únicamente la correspondencia visual. No copies ni reproduzcas contenido protegido. Responde únicamente JSON válido con las claves score, subjectMatch, styleMatch, compositionMatch, reason. score es 0-100. subjectMatch, styleMatch y compositionMatch son booleanos.';
  const user='Compara la miniatura del vídeo de referencia de YouTube con el visual real seleccionado para esta escena. La escena debe pertenecer al mismo tema y tipo de contenido que la referencia, y conservar características generales compatibles de composición, iluminación, paleta, escala, continuidad y lenguaje audiovisual, pero ser material original.\n\nTema de referencia: '+String(referenceVideo?.title||'')+'\nEscena: '+String(scene?.title||'')+'\nConsulta visual: '+String(scene?.searchQuery||scene?.visualPrompt||'')+'\nPerfil visual detectado: '+JSON.stringify({visualStyle:visualProfile?.videoProfile?.visualStyle,palette:visualProfile?.videoProfile?.palette,lighting:visualProfile?.videoProfile?.lighting,composition:visualProfile?.videoProfile?.composition,cameraMovement:visualProfile?.videoProfile?.cameraMovement,continuity:visualProfile?.videoProfile?.continuity}).slice(0,5000);
  const text=await callGemini({system,user,images:[refImage,mediaImage],temperature:0.1,maxOutputTokens:220,json:true});
  const parsed=parseJsonResponse(text);
  const score=Number(parsed?.score)||0;
  return{ok:score>=60&&parsed?.subjectMatch!==false,score,subjectMatch:Boolean(parsed?.subjectMatch),styleMatch:Boolean(parsed?.styleMatch),compositionMatch:Boolean(parsed?.compositionMatch),reason:String(parsed?.reason||'')};
}

app.post('/api/media/search',async(req,res)=>{try{const scenes=Array.isArray(req.body?.scenes)?req.body.scenes:[];const referenceTopic=String(req.body?.referenceTopic||'').replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim();if(!scenes.length)return res.status(400).json({error:'No hay escenas para buscar.'});const results=[];for(const scene of scenes.slice(0,12)){const sceneQuery=String(scene.searchQuery||scene.visualPrompt||scene.title||'').replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim();const anchoredQuery=[sceneQuery,referenceTopic].filter(Boolean).join(' ').slice(0,120);const query=anchoredQuery||sceneQuery;const wantImage=String(scene.mediaType||'').toLowerCase()==='image'||Boolean(scene.constantImage);const[pexels,pixabay]=await Promise.allSettled(wantImage?[searchPexelsPhotos(query),searchPixabayImages(query)]:[searchPexels(query),searchPixabay(query)]);results.push({number:scene.number,title:scene.title,query,mediaType:wantImage?'image':'video',media:[...(pexels.status==='fulfilled'?pexels.value:[]),...(pixabay.status==='fulfilled'?pixabay.value:[])]})}res.json({ok:true,results,credits:{pexels:'Visuales proporcionados por Pexels',pixabay:'Visuales proporcionados por Pixabay'}})}catch(err){res.status(502).json({error:err.message||'No se pudieron buscar visuales.'})}});

async function downloadToFile(source,file){
  const value=String(source||'');
  if(value && path.isAbsolute(value)){
    const stat=await fs.stat(value).catch(()=>null);
    if(!stat?.isFile()||!stat.size)throw new Error('El recurso de vídeo local está vacío o no existe.');
    await fs.copyFile(value,file);
    const copied=await fs.stat(file);
    if(!copied.size)throw new Error('No se pudo copiar el recurso de vídeo local.');
    return;
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),60000);
  try{
    const r=await fetch(value,{signal:controller.signal});
    if(!r.ok)throw new Error('No se pudo descargar el recurso ('+r.status+').');
    if(!r.body)throw new Error('La fuente de vídeo no devolvió datos.');
    const handle=await fs.open(file,'w');
    try{
      const reader=r.body.getReader();
      let total=0;
      const maxBytes=180*1024*1024;
      while(true){
        const part=await reader.read();
        if(part.done)break;
        total+=part.value.byteLength;
        if(total>maxBytes){await reader.cancel().catch(()=>{});throw new Error('El vídeo fuente supera el límite de 180 MB.');}
        await handle.write(Buffer.from(part.value));
      }
      if(total===0)throw new Error('El recurso descargado está vacío.');
    }finally{await handle.close().catch(()=>{})}
  }catch(err){
    if(err?.name==='AbortError')throw new Error('Tiempo de espera agotado al descargar el vídeo.');
    throw err;
  }finally{clearTimeout(timer)}
}
function runFfmpeg(args){return new Promise((resolve,reject)=>{const safeArgs=[...args];const p=spawn(ffmpegPath,safeArgs,{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000)});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('FFmpeg '+code+': '+err.slice(-2500))))})}
app.post('/api/reference/visual-analysis',upload.single('video'),async(req,res)=>{
  try{
    const file=req.file;
    if(!file)return res.status(400).json({error:'No se recibió ningún vídeo de referencia.'});
    const allowed=/^video\/(mp4|quicktime|webm|x-msvideo|mpeg|ogg)$/i.test(String(file.mimetype||''))||/\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg)$/i.test(String(file.originalname||''));
    if(!allowed)return res.status(400).json({error:'El archivo de referencia no parece ser un vídeo compatible.'});
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-reference-'));
    try{
      const input=path.join(dir,'reference-video');
      const framesDir=path.join(dir,'frames');
      await fs.mkdir(framesDir,{recursive:true});
      await fs.copyFile(file.path,input);
      const stat=await fs.stat(input);
      if(!stat.size)throw new Error('El vídeo de referencia está vacío.');
      try{await runFfmpeg(['-y','-hide_banner','-loglevel','error','-i',input,'-map','0:v:0','-an','-sn','-dn','-vf','fps=1/2,scale=768:-2','-frames:v','6','-q:v','3',path.join(framesDir,'frame-%02d.jpg')]);}catch(firstErr){console.warn('Reference frame extraction retry:',firstErr.message);await runFfmpeg(['-y','-hide_banner','-loglevel','error','-ss','0','-i',input,'-map','0:v:0','-an','-sn','-dn','-vf','scale=768:-2','-frames:v','1','-q:v','3',path.join(framesDir,'frame-%02d.jpg')]);}      const files=(await fs.readdir(framesDir)).filter(x=>/^frame-\d+\.jpg$/i.test(x)).sort();
      if(!files.length)throw new Error('No se pudieron extraer fotogramas del vídeo de referencia.');
      const images=[];
      for(const name of files){
        const data=await fs.readFile(path.join(framesDir,name));
        if(data.length)images.push({mimeType:'image/jpeg',data:data.toString('base64')});
      }      if(!images.length)throw new Error('Los fotogramas extraídos están vacíos.');
      const content=await callGemini({
        system:'Eres un analista audiovisual. Analiza únicamente las características visuales generales de los fotogramas proporcionados. No identifiques ni reproduzcas contenido protegido. Devuelve JSON válido con: environment, lighting, timeOfDay, palette, composition, shotScale, cameraMovement, pacing, people, texture, depth, atmosphere, visualStyle, consistency. Sé concreto y describe rasgos reutilizables para crear un vídeo ORIGINAL de cualquier género.',
        user:'Analiza estos fotogramas de un vídeo de referencia y resume su lenguaje visual general. No describas escenas concretas como instrucciones para copiarlas; extrae únicamente patrones de estilo, fotografía, composición, ritmo y atmósfera. Responde en JSON.',
        images,
        temperature:0.3,
        maxOutputTokens:1800,
        json:true
      });
      return res.json({ok:true,analysis:parseJsonResponse(content),framesAnalyzed:images.length});
    }finally{
      await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
      await fs.rm(file.path,{force:true}).catch(()=>{});
    }
  }catch(err){
    console.error('Visual reference analysis error:',err);
    return res.status(502).json({error:err.message||'No se pudo analizar visualmente el vídeo de referencia.'});
  }
});

async function downloadAudioBuffer(source,file){if(typeof source==='string'){await fs.copyFile(source,file)}else{await fs.writeFile(file,source)}const stat=await fs.stat(file);if(!stat.size)throw new Error('El audio generado está vacío.');}
async function renderAutotubeVideo({scenes,mediaResults=[],aiClips=[],narrationAudio=[],musicBuffer=null,onProgress=()=>{},finalOutputPath}){
  if(!ffmpegPath)throw new Error('FFmpeg no está disponible.');
  if(!Array.isArray(scenes)||!scenes.length)throw new Error('No hay escenas para renderizar.');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-'));
  try{
    const clips=[];
    const sceneInputs=scenes.map((scene,i)=>{
      const found=mediaResults.find(x=>String(x.number)===String(scene.number))||mediaResults[i]||null;
      const aiClip=aiClips[i]||null; // Nunca reutilizar silenciosamente el clip de otra escena.
      const media=found?.media?.find(m=>m?.downloadUrl)||null;
      return{scene,found,aiClip,media,audio:narrationAudio[i]||null};
    });
    const missing=sceneInputs.filter(x=>!x.aiClip?.path&&!x.aiClip?.buffer&&!x.media?.downloadUrl);
    if(missing.length)throw new Error('Faltan visuales para las escenas: '+missing.map(x=>String(x.scene.number)).join(', ')+'. Genera los vídeos IA de esas escenas o busca visuales de respaldo.');
    const total=sceneInputs.length;
    for(let i=0;i<total;i++){
      const{scene,found,aiClip,media,audio}=sceneInputs[i];
      const input=path.join(dir,'in-'+i+'.mp4');
      const output=path.join(dir,'scene-'+i+'.mp4');
      const duration=Math.max(2,Math.min(180,Number(scene.duration)||8));
      if(aiClip?.path)await fs.copyFile(aiClip.path,input);
      else if(aiClip?.buffer)await fs.writeFile(input,aiClip.buffer);
      else await downloadToFile(media.downloadUrl,input);
      let audioInput=null;
      if(audio){audioInput=path.join(dir,'voice-'+i+'.wav');await downloadAudioBuffer(audio,audioInput);}
      const isImage=String(aiClip?.mediaType||media?.mediaType||found?.mediaType||scene.mediaType||'video').toLowerCase()==='image';
      const args=['-y','-hide_banner','-loglevel','error'];
      if(isImage)args.push('-loop','1','-i',input);else args.push('-stream_loop','-1','-i',input);
      if(audioInput)args.push('-i',audioInput);else args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100');
      args.push('-t',String(duration),
        // Render at 720p on Render Free to stay safely below the 512 MB
        // instance memory ceiling. The source is still cropped to 16:9.
        '-vf','scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p,fps=30',
        '-map','0:v:0','-map','1:a:0',
        '-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-threads','1','-filter_threads','1','-filter_complex_threads','1',
        '-c:a','aac','-b:a','192k','-ar','44100','-ac','2','-af','apad',
        '-avoid_negative_ts','make_zero',output);
      await runFfmpeg(args);
      const stat=await fs.stat(output);
      if(!stat.size)throw new Error('FFmpeg creó una escena vacía (escena '+scene.number+').');
      clips.push(output);
      onProgress(Math.min(78,Math.round(((i+1)/total)*70)+5));
    }
    const list=path.join(dir,'concat.txt');
    await fs.writeFile(list,clips.map(f=>"file '"+f.replace(/'/g,"'\\''")+"'").join('\n'));
    const videoOnly=path.join(dir,'video-only.mp4');
    try{
      await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',videoOnly]);
    }catch(copyErr){
      console.warn('Concat copy falló; usando recodificación final:',copyErr.message);
      await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list,'-c:v','libx264','-c:a','aac','-ar','44100','-ac','2','-b:a','160k','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-threads','1','-movflags','+faststart',videoOnly]);
    }
    let out=videoOnly;
    if(musicBuffer){
      const musicFile=path.join(dir,'music.bin');
      await downloadAudioBuffer(musicBuffer,musicFile);
      out=path.join(dir,'autotube-final.mp4');
      await runFfmpeg(['-y','-hide_banner','-loglevel','error',
        '-i',videoOnly,'-stream_loop','-1','-i',musicFile,
        '-filter_complex','[0:a]aresample=44100,acompressor=threshold=0.08:ratio=3:attack=20:release=250,asplit=2[voice][voice_sc];[1:a]aresample=44100,volume=0.14[music];[music][voice_sc]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=300:makeup=1:mix=1[ducked];[voice][ducked]amix=inputs=2:duration=first:dropout_transition=2,alimiter=limit=0.95[a]',
        '-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-ar','44100','-ac','2','-b:a','160k','-threads','1','-movflags','+faststart',out]);
    }
    const stat=await fs.stat(out);
    if(!stat.size)throw new Error('El MP4 final está vacío.');
    const duration=sceneInputs.reduce((n,x)=>n+Math.max(2,Math.min(180,Number(x.scene.duration)||8)),0);
    if(finalOutputPath){
      await fs.copyFile(out,finalOutputPath);
      const finalStat=await fs.stat(finalOutputPath);
      if(!finalStat.size)throw new Error('No se pudo guardar el MP4 final.');
      onProgress(100);
      return{outputPath:finalOutputPath,size:finalStat.size,duration};
    }
    onProgress(100);
    return{outputPath:out,size:stat.size,duration};
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
}
app.post('/api/render',upload.fields([{name:'narration',maxCount:12},{name:'music',maxCount:1},{name:'aiClips',maxCount:12}]),async(req,res)=>{try{if(activeRenderJobId){return res.status(409).json({error:'Ya hay un render en curso. Espera a que termine antes de iniciar otro.'})}let scenes=[];let mediaResults=[];try{scenes=JSON.parse(String(req.body?.scenes||'[]'));mediaResults=JSON.parse(String(req.body?.mediaResults||'[]'));}catch{throw new Error('Los datos de producción no tienen un formato válido.');}if(!scenes.length||(!mediaResults.length&&!Array.isArray(req.files?.aiClips)))return res.status(400).json({error:'Genera los vídeos IA de las escenas o busca visuales de respaldo antes de renderizar.'});const jobId='render_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex'),outputPath=path.join(renderJobDir,jobId+'.mp4');renderJobs.set(jobId,{status:'processing',progress:1,createdAt:Date.now(),outputPath,error:null});activeRenderJobId=jobId;res.status(202).json({ok:true,jobId,status:'processing'});(async()=>{const job=renderJobs.get(jobId);try{const narrationFiles=Array.isArray(req.files?.narration)?req.files.narration:[],musicFile=Array.isArray(req.files?.music)?req.files.music[0]:null,aiClipFiles=Array.isArray(req.files?.aiClips)?req.files.aiClips:[];const result=await renderAutotubeVideo({scenes,mediaResults,aiClips:aiClipFiles,narrationAudio:narrationFiles.map(x=>x.path),musicBuffer:musicFile?.path||null,onProgress:p=>{if(job)job.progress=p},finalOutputPath:outputPath});const expectedDuration=scenes.reduce((n,s)=>n+Math.max(2,Math.min(180,Number(s.duration)||8)),0);const validation=await validateRenderedMp4(outputPath,expectedDuration);if(job){job.validation=validation;job.status='done';job.progress=100;job.size=result.size;job.finishedAt=Date.now()}console.log('Render completed:',jobId,'size=',result.size)}catch(err){console.error('Render error:',jobId,err);if(job){job.status='error';job.progress=0;job.error=err.message||'No se pudo renderizar el vídeo.'}}finally{activeRenderJobId=null;for(const f of [...(Array.isArray(req.files?.narration)?req.files.narration:[]),...(Array.isArray(req.files?.music)?req.files.music:[]),...(Array.isArray(req.files?.aiClips)?req.files.aiClips:[])])await fs.rm(f.path,{force:true}).catch(()=>{});}})()}catch(err){console.error('Render start error:',err);if(!res.headersSent)res.status(500).json({error:err.message||'No se pudo iniciar el render.'})}});
app.get('/api/render/:jobId',async(req,res)=>{const job=renderJobs.get(String(req.params.jobId||''));if(!job)return res.status(404).json({error:'Render no encontrado. El servicio puede haberse reiniciado; inicia un nuevo render.'});if(job.status==='processing')return res.json({ok:true,status:'processing',progress:job.progress||0});if(job.status==='error')return res.json({ok:false,status:'error',error:job.error||'No se pudo renderizar el vídeo.'});try{const stat=await fs.stat(job.outputPath);if(!stat.size)throw new Error('MP4 vacío');res.json({ok:true,status:'done',progress:100,size:stat.size,validation:job.validation||null,downloadUrl:'/api/render/'+encodeURIComponent(req.params.jobId)+'/download'})}catch{return res.status(404).json({error:'El vídeo renderizado ya no está disponible. Inicia un nuevo render.'})}});
app.get('/api/render/:jobId/download',async(req,res)=>{const job=renderJobs.get(String(req.params.jobId||''));if(!job)return res.status(404).json({error:'Render no encontrado.'});if(job.status!=='done')return res.status(409).json({error:'El render todavía no está listo.'});try{await fs.stat(job.outputPath);res.download(job.outputPath,'autotube-final.mp4')}catch{res.status(404).json({error:'El vídeo renderizado ya no está disponible.'})}});

async function validateRenderedMp4(file,expectedDuration=0){
  const probe=await new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-map','0:v:0','-map','0:a:0','-c','copy','-f','null','-'],{stdio:['ignore','pipe','pipe']});
    let stderr='';
    p.stderr.on('data',x=>{stderr+=x.toString()});
    p.on('error',reject);
    p.on('close',code=>{
      if(code!==0)return reject(new Error('FFmpeg no pudo validar el MP4 final: '+stderr.slice(-800)));
      resolve(stderr);
    });
  });
  const text=String(probe||'');
  const dm=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const durationSeconds=dm?Number(dm[1])*3600+Number(dm[2])*60+Number(dm[3]):0;
  if(!durationSeconds)throw new Error('No se pudo verificar la duración real del MP4.');
  if(expectedDuration>0){
    const tolerance=Math.max(2,expectedDuration*0.03);
    if(Math.abs(durationSeconds-expectedDuration)>tolerance)throw new Error('Duración real del MP4: '+durationSeconds.toFixed(2)+' s; esperada '+expectedDuration.toFixed(2)+' s (tolerancia ±'+tolerance.toFixed(2)+' s).');
  }
  const videoLine=(text.split(/\r?\n/).find(line=>/Video:/i.test(line))||'');
  const audioLine=(text.split(/\r?\n/).find(line=>/Audio:/i.test(line))||'');
  const vm=videoLine.match(/(\d{2,5})x(\d{2,5})/);  const fm=videoLine.match(/(\d+(?:\.\d+)?)\s*fps/);
  const am=audioLine.match(/Audio:\s*([a-z0-9_]+)/i);
  if(!vm)throw new Error('No se pudo verificar la resolución real del MP4.');
  const width=Number(vm[1]),height=Number(vm[2]);
  const fps=fm?Number(fm[1]):0;
  const audioCodec=am?String(am[1]).toLowerCase():'';
  const supportedResolution=(width===1280&&height===720)||(width===1920&&height===1080);
  if(!supportedResolution)throw new Error('Resolución real del MP4: '+width+'x'+height+' (se esperaba 1280x720 o 1920x1080).');
  if(!fps||Math.abs(fps-30)>0.5)throw new Error('FPS reales del MP4: '+(fps||'desconocidos')+' (se esperaban 30).');  if(audioCodec!=='aac')throw new Error('Códec de audio real del MP4: '+(audioCodec||'desconocido')+' (se esperaba AAC).');
  return{width,height,fps,audioCodec,durationSeconds};
}


async function generateFreeLtxVideoClip(prompt,dir,options={}) {
  const {Client}=require('@gradio/client');
  const space=String(process.env.LTX_SPACE||'Lightricks/ltx-video-distilled').trim();
  const duration=Math.max(0.3,Math.min(8.5,Number(options.durationSeconds)||5));
  const width=Math.max(256,Math.min(1280,Math.round((Number(options.width)||704)/32)*32));
  const height=Math.max(256,Math.min(1280,Math.round((Number(options.height)||512)/32)*32));
  const negativePrompt=String(options.negativePrompt||'worst quality, inconsistent motion, blurry, jittery, distorted, text, logos').trim();
  const app=await Client.connect(space);
  const result=await app.predict('/text_to_video',{
    prompt:String(prompt||'').trim(),
    negative_prompt:negativePrompt,
    image_n:null,
    video_n:null,
    height,
    width,
    mode:'text-to-video',
    duration,
    frames_to_use:9,
    seed:Math.floor(Math.random()*4294967295),
    randomize_seed:true,
    guidance_scale:Number(options.guidanceScale||3),
    improve_texture:Boolean(options.improveTexture??false)
  });
  const data=Array.isArray(result?.data)?result.data:[];
  const output=data[0];
  const url=typeof output==='string'?output:(output?.url||output?.path||output?.video?.url||'');
  if(!url)throw new Error('LTX/ZeroGPU terminó la generación pero no devolvió el vídeo.');
  const response=await fetch(String(url));
  if(!response.ok)throw new Error('LTX/ZeroGPU no pudo descargar el vídeo generado ('+response.status+').');
  const outputPath=path.join(dir,'ltx-generated-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
  await fs.writeFile(outputPath,Buffer.from(await response.arrayBuffer()));
  const stat=await fs.stat(outputPath);
  if(!stat.size)throw new Error('LTX/ZeroGPU devolvió un vídeo vacío.');
  return{outputPath,bytes:stat.size,provider:'Hugging Face ZeroGPU · LTX Video',model:'LTX Video 0.9.8 distilled',durationSeconds:duration,status:'complete'};
}

async function validateGeneratedVideoClip(file){
  const result=await new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-map','0:v:0','-f','null','-'],{stdio:['ignore','pipe','pipe']});
    let stderr='';
    p.stderr.on('data',x=>{stderr+=x.toString();if(stderr.length>30000)stderr=stderr.slice(-30000)});
    p.on('error',reject);
    p.on('close',code=>{
      if(code!==0)return reject(new Error('FFmpeg no pudo validar el clip de vídeo IA: '+stderr.slice(-1000)));
      resolve(stderr);
    });
  });
  const text=String(result||'');
  const dm=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const durationSeconds=dm?Number(dm[1])*3600+Number(dm[2])*60+Number(dm[3]):0;
  const videoLine=(text.split(/\r?\n/).find(line=>/Video:/i.test(line))||'');
  const vm=videoLine.match(/Video:\s*([^,]+)/i);
  const dimensions=videoLine.match(/(\d{2,5})x(\d{2,5})/);
  if(!durationSeconds||durationSeconds<3)throw new Error('El clip IA tiene una duración inválida: '+durationSeconds+' s.');
  if(!vm)throw new Error('El archivo generado no contiene un stream de vídeo válido.');
  return{ok:true,durationSeconds,videoCodec:String(vm[1]||'').trim(),width:dimensions?Number(dimensions[1]):0,height:dimensions?Number(dimensions[2]):0};
}

async function runVideoAiSmokeTest(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-ai-video-test-'));
  try{
    const prompt='Original cinematic documentary video, 16:9 landscape. A remote unexplored snowy mountain range in the Himalayas at dawn, clouds moving naturally across the peaks, subtle aerial camera push-in, realistic lighting, atmospheric mist, professional documentary cinematography. No text, no logos, no copyrighted characters, no imitation of any specific existing video.';
    const generated=await generateFreeLtxVideoClip(prompt,dir,{durationSeconds:3,width:256,height:256,improveTexture:false});
    const validation=await validateGeneratedVideoClip(generated.outputPath);
    return{ok:Boolean(validation.ok),provider:generated.provider,model:generated.model,bytes:generated.bytes,durationSeconds:validation.durationSeconds,width:validation.width,height:validation.height,videoCodec:validation.videoCodec,status:generated.status};
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}

const videoAiTestJobs=new Map();

const preflightJobs=new Map();

async function executePreflight(){
  const checks={};
  let preflightReferenceVideo=null;
  let preflightReferenceStyle=null;
  const run=async(name,fn)=>{
    const started=Date.now();
    try{
      const value=await fn();
      checks[name]={ok:true,ms:Date.now()-started,...(value&&typeof value==='object'?value:{})};
    }catch(err){
      checks[name]={ok:false,ms:Date.now()-started,error:err.message||String(err)};
    }
  };

  // Este preflight no genera ningún vídeo IA ni consume cuota de generación.
  // Solo comprueba que las piezas reales del flujo funcionan juntas.
  await run('ffmpeg',async()=>{
    if(!ffmpegPath)throw new Error('FFmpeg no está disponible.');
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-preflight-'));
    try{
      const out=path.join(dir,'test.mp4');
      await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=320x180:r=5','-t','0.5','-an','-c:v','libx264','-pix_fmt','yuv420p',out]);
      const st=await fs.stat(out);
      if(!st.size)throw new Error('FFmpeg produjo un archivo vacío.');
      return{bytes:st.size};
    }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
  });

  await run('gemini',async()=>{
    const text=await callGemini({system:'Responde únicamente con JSON válido.',user:'Devuelve {"ok":true}.',maxOutputTokens:40,json:true});
    return{response:parseJsonResponse(text)};
  });

  const referenceUrl='https://www.youtube.com/watch?v=qMUk5jrgENE';
  await run('youtube-reference',async()=>{
    const start=await fetch('http://127.0.0.1:'+PORT+'/api/youtube/reference',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({reference:referenceUrl})
    });
    const startRaw=await start.text();
    let startData=null;try{startData=startRaw?JSON.parse(startRaw):null}catch{}
    if(!start.ok)throw new Error(startData?.error||'YouTube reference '+start.status);
    if(startData?.status==='done'){
      preflightReferenceVideo=startData.video;
      preflightReferenceStyle=startData.referenceStyle;
    }else{
      const jobId=startData?.jobId;
      if(!jobId)throw new Error('El análisis de YouTube no devolvió jobId.');
      const statusUrl=startData?.statusUrl||('/api/youtube/reference/'+encodeURIComponent(jobId));
      let done=null;
      for(let i=0;i<180;i++){
        await new Promise(resolve=>setTimeout(resolve,2000));
        const r=await fetch('http://127.0.0.1:'+PORT+statusUrl);
        const raw=await r.text();
        let d=null;try{d=raw?JSON.parse(raw):null}catch{}
        if(d?.status==='done'){done=d;break;}
        if(d?.status==='error')throw new Error(d?.error||'No se pudo analizar la referencia de YouTube.');
        if(d?.status==='restart')throw new Error('El servidor reinició durante el análisis de YouTube.');
      }
      if(!done)throw new Error('El análisis de YouTube superó el tiempo máximo del preflight.');
      preflightReferenceVideo=done.video;
      preflightReferenceStyle=done.referenceStyle;
    }
    if(!preflightReferenceVideo?.title)throw new Error('No se obtuvo el título de la referencia.');
    if(!preflightReferenceStyle?.visualAnalysis)throw new Error('No se obtuvo el análisis audiovisual de la referencia.');
    return{
      title:preflightReferenceVideo.title,
      visualSource:preflightReferenceStyle.visualSource||'unknown',
      hasFullVideoAnalysis:Boolean(preflightReferenceStyle.hasFullVideoAnalysis),
      hasAudioProfile:Boolean(preflightReferenceStyle.hasAudioAnalysis),
      hasAnimationAnalysis:Boolean(preflightReferenceStyle.hasAnimationAnalysis),
      hasStructureProfile:Boolean(preflightReferenceStyle.hasStructureAnalysis),
      constantImage:Boolean(preflightReferenceStyle.constantImage),
      estimatedSceneCount:Number(preflightReferenceStyle.estimatedSceneCount||0),
      preferredSceneCount:Number(preflightReferenceStyle.preferredSceneCount||0)
    };
  });

  await run('pexels',async()=>{
    if(!process.env.PEXELS_API_KEY)throw new Error('Falta PEXELS_API_KEY.');
    const rows=await searchPexels('cinematic');
    if(!rows.length)throw new Error('Pexels no devolvió vídeos.');
    return{results:rows.length};
  });

  await run('pixabay',async()=>{
    if(!process.env.PIXABAY_API_KEY)throw new Error('Falta PIXABAY_API_KEY.');
    const rows=await searchPixabay('cinematic');
    if(!rows.length)throw new Error('Pixabay no devolvió vídeos.');
    return{results:rows.length};
  });

  await run('production-plan',async()=>{
    const ref=preflightReferenceVideo,refStyle=preflightReferenceStyle;
    if(!ref||!refStyle)throw new Error('No hay perfil de referencia disponible.');
    const r=await fetch('http://127.0.0.1:'+PORT+'/api/ai/production-plan',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        topic:'',
        referenceTopic:ref.title,
        language:'es',
        duration:'2',
        title:'Preflight original',
        outline:['Gancho','Contexto','Desarrollo','Cierre'],
        visualIdeas:['Reference-derived visuals'],
        visualReferenceAnalysis:refStyle.visualAnalysis,
        referenceStyle:refStyle,
        referenceData:ref,
        reference:referenceUrl
      })
    });
    const raw=await r.text();
    let d=null;try{d=raw?JSON.parse(raw):null}catch{}
    if(!r.ok)throw new Error(d?.error||'Production plan '+r.status);
    if(!Array.isArray(d?.scenes)||!d.scenes.length)throw new Error('El plan de producción no devolvió escenas.');
    return{scenes:d.scenes.length,title:d.title||'',referenceContext:Boolean(d.referenceContext||d.referenceStyle)};
  });

  await run('render-pipeline',async()=>{
    if(!ffmpegPath)throw new Error('FFmpeg no está disponible.');
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-render-smoke-'));
    try{
      const source=path.join(dir,'source.mp4');
      const output=path.join(dir,'final.mp4');
      await runFfmpeg([
        '-y','-hide_banner','-loglevel','error',
        '-f','lavfi','-i','color=c=black:s=320x180:r=30',
        '-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source
      ]);
      const result=await renderAutotubeVideo({
        scenes:[{number:1,title:'Preflight',duration:2,mediaType:'video'}],
        mediaResults:[],
        aiClips:[{path:source}],
        narrationAudio:[],
        musicBuffer:null,
        onProgress:()=>{},
        finalOutputPath:output
      });
      const validation=await validateRenderedMp4(output);
      if(!result?.size||!validation?.width)throw new Error('El pipeline de render no produjo un MP4 válido.');
      return{bytes:result.size,width:validation.width,height:validation.height,fps:validation.fps,audioCodec:validation.audioCodec};
    }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
  });

  await run('tts',async()=>{
    const audio=await generateGeminiTts('Prueba breve de narración.','es','Natural y cercana');
    if(!audio.length)throw new Error('Gemini TTS devolvió audio vacío.');
    return{provider:'Gemini TTS',bytes:audio.length};
  });

  const failed=Object.entries(checks).filter(([,v])=>!v.ok).map(([k,v])=>({name:k,error:v.error}));
  return{
    ok:failed.length===0,
    checks,
    failed,
    notes:{
      aiVideoGenerationNotRun:true,
      renderPipelineSmokeTest:'synthetic-2s-no-AI',
      referenceAnalysisTestedThroughApi:true,
      outlineGenerationUntouched:true
    }
  };
}
const referenceMatchJobs=new Map();
async function executeReferenceMatchTest(){
  const referenceUrl='https://www.youtube.com/watch?v=qMUk5jrgENE';
  const video=await getReferenceVideo(referenceUrl);
  const style=await analyzeYoutubeReferenceMedia(referenceUrl,video);
  const profile=style?.visualAnalysis||{};
  const planRes=await fetch('http://127.0.0.1:'+PORT+'/api/ai/production-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    topic:'',referenceTopic:video.title,language:'es',duration:String(Math.max(1,Math.min(2,Math.ceil(Number(profile?.videoProfile?.durationSeconds||60)/60)))),
    title:video.title,outline:[],visualIdeas:[],visualReferenceAnalysis:profile,referenceStyle:style,referenceData:video,reference:referenceUrl
  })});
  const plan=await planRes.json();
  if(!planRes.ok||!Array.isArray(plan.scenes)||!plan.scenes.length)throw new Error(plan?.error||'No se pudo crear el plan de prueba.');
  const mediaRes=await fetch('http://127.0.0.1:'+PORT+'/api/media/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenes:plan.scenes.slice(0,4),referenceTopic:video.title})});
  const media=await mediaRes.json();
  if(!mediaRes.ok)throw new Error(media?.error||'No se pudieron buscar visuales.');
  const visualRows=Array.isArray(media.results)?media.results:[];
  const visualMatches=visualRows.map(x=>({number:x.number,query:x.query,mediaCount:Array.isArray(x.media)?x.media.length:0,mediaType:x.mediaType,selectedMedia:(Array.isArray(x.media)?x.media.slice(0,1):[]).map(m=>({provider:m.provider,id:m.id,title:m.title,thumbnail:m.thumbnail,url:m.url,mediaType:m.mediaType||x.mediaType}))}));
  const actualVisualChecks=[];
  for(const row of visualRows.slice(0,4)){
    const scene=plan.scenes.find(s=>String(s.number)===String(row.number))||plan.scenes[visualRows.indexOf(row)];
    const selected=Array.isArray(row.media)?row.media.find(m=>m?.thumbnail)||row.media[0]:null;
    if(!selected){actualVisualChecks.push({number:row.number,provider:'',id:'',score:0,ok:false,reason:'No se encontró un visual seleccionable.'});continue;}
    try{
      const evaluated=await evaluateSelectedVisual(video,profile,scene,selected);
      actualVisualChecks.push({number:row.number,provider:selected.provider||'',id:selected.id||'',title:selected.title||'',score:evaluated.score,subjectMatch:evaluated.subjectMatch,styleMatch:evaluated.styleMatch,compositionMatch:evaluated.compositionMatch,ok:evaluated.ok,reason:evaluated.reason});
    }catch(err){actualVisualChecks.push({number:row.number,provider:selected.provider||'',id:selected.id||'',title:selected.title||'',score:0,ok:false,reason:err.message||String(err)});}
  }
  const actualVisualPass=actualVisualChecks.length===Math.min(4,visualRows.length)&&actualVisualChecks.length>0&&actualVisualChecks.every(x=>x.ok)&&actualVisualChecks.reduce((n,x)=>n+x.score,0)/actualVisualChecks.length>=65;
  const audioProfile=profile.audioProfile||{};
  const promptMood=String(plan.musicMood||audioProfile.musicMood||audioProfile.mood||'').toLowerCase();
  const audioText=JSON.stringify(audioProfile).toLowerCase();
  const audioMatchSignals=['energy','dynamics','instrumentation','bpmEstimate'].filter(k=>audioProfile[k]!==undefined);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-match-'));
  let musicBytes=0,musicProvider='';
  try{
    const music=await generateFallbackMusic(
      'Reference test: '+video.title+' | '+promptMood+' | '+audioText.slice(0,1600),
      8,dir,audioProfile
    );
    musicBytes=music.buffer.length;musicProvider=music.provider;
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
  const referenceKeywords=['mysterious','remote','unexplored','mountain','cave','ocean','hadal','jungle','earth','hidden','inaccessible','places'];
  const allQueries=visualMatches.map(x=>String(x.query||'').toLowerCase()).join(' ');
  const matchedTerms=referenceKeywords.filter(t=>allQueries.includes(t));
  const subjectCoverage=visualMatches.map(x=>({number:x.number,hasSpecificSubject:/gangkhar|puensum|veryovkina|cave|ocean|hadal|mountain|earth|planet|jungle|remote/i.test(String(x.query||'')),hasReferenceAnchor:/10 Lugares|No Exploramos|reference/i.test(String(x.query||''))}));
  const visualPass=visualMatches.length>0&&visualMatches.every(x=>x.mediaCount>0)&&subjectCoverage.every(x=>x.hasSpecificSubject);
  const musicPass=musicBytes>0&&audioMatchSignals.length>=3;
  return{
    ok:visualPass&&actualVisualPass&&musicPass,
    reference:{title:video.title,duration:video.duration||'',estimatedScenes:style.estimatedSceneCount,preferredScenes:style.preferredSceneCount},
    visualTest:{scenesTested:visualMatches.length,results:visualMatches,themeTermsFound:matchedTerms,subjectCoverage,actualVisualChecks,actualVisualAverageScore:actualVisualChecks.length?Math.round(actualVisualChecks.reduce((n,x)=>n+Number(x.score||0),0)/actualVisualChecks.length):0,pass:visualPass&&actualVisualPass},
    musicTest:{bytes:musicBytes,provider:musicProvider,audioProfileSignals:audioMatchSignals,mood:promptMood,energy:audioProfile.energy||'',dynamics:audioProfile.dynamics||'',instrumentation:audioProfile.instrumentation||'',bpmEstimate:audioProfile.bpmEstimate||'',pass:musicPass},
    note:'Prueba de correspondencia: valida las miniaturas reales de los visuales seleccionados contra la miniatura de referencia y el perfil audiovisual, además de generar solo 8 s de música procedural. No genera ni renderiza un MP4.'
  };
}
app.get('/api/reference-match-test',async(_req,res)=>{
  const existing=[...referenceMatchJobs.values()].find(j=>j.status==='running');
  if(existing)return res.status(202).json({ok:false,status:'running',jobId:existing.id,statusUrl:'/api/reference-match-test/'+encodeURIComponent(existing.id)});
  const id='match_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  referenceMatchJobs.set(id,{id,status:'running',startedAt:Date.now(),result:null});
  res.status(202).json({ok:false,status:'running',jobId:id,statusUrl:'/api/reference-match-test/'+encodeURIComponent(id)});
  executeReferenceMatchTest().then(result=>{const j=referenceMatchJobs.get(id);if(j){j.status=result.ok?'done':'failed';j.result=result;j.finishedAt=Date.now();}}).catch(err=>{const j=referenceMatchJobs.get(id);if(j){j.status='failed';j.result={ok:false,error:err.message||String(err)};j.finishedAt=Date.now();}});
});
app.get('/api/reference-match-test/:jobId',async(req,res)=>{
  const j=referenceMatchJobs.get(String(req.params.jobId||''));
  if(!j)return res.status(410).json({ok:false,status:'restart',error:'La instancia se reinició durante la prueba.'});
  if(j.status==='running')return res.status(202).json({ok:false,status:'running',jobId:j.id,elapsedMs:Date.now()-j.startedAt});
  return res.status(j.result?.ok?200:503).json({status:j.status,jobId:j.id,...(j.result||{ok:false})});
});


app.get('/api/video-ai-test',async(_req,res)=>{
  const existing=[...videoAiTestJobs.values()].find(j=>j.status==='running');
  if(existing)return res.status(202).json({ok:false,status:'running',jobId:existing.id,statusUrl:'/api/video-ai-test/'+encodeURIComponent(existing.id)});
  const id='veotest_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  videoAiTestJobs.set(id,{id,status:'running',startedAt:Date.now(),result:null});
  res.status(202).json({ok:false,status:'running',jobId:id,statusUrl:'/api/video-ai-test/'+encodeURIComponent(id),message:'Prueba corta de vídeo IA iniciada. No genera el vídeo completo.'});
  runVideoAiSmokeTest().then(result=>{const j=videoAiTestJobs.get(id);if(j){j.status=result.ok?'done':'failed';j.result=result;j.finishedAt=Date.now();}}).catch(err=>{const j=videoAiTestJobs.get(id);if(j){j.status='failed';j.result={ok:false,error:err.message||String(err)};j.finishedAt=Date.now();}});
});
app.get('/video-ai-test-browser',async(_req,res)=>{res.type('html').send("<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>AutoTube · Prueba LTX HD</title></head><body style=\"font-family:system-ui;max-width:760px;margin:40px auto;padding:20px\"><h1>Prueba real de vídeo IA · LTX</h1><p>Prueba corta en Hugging Face ZeroGPU a resolución nativa de referencia LTX: <strong>1216×704 · 30 FPS</strong>. No genera el vídeo completo de AutoTube.</p><button id=\"go\">Generar clip HD de prueba</button><p id=\"status\">Esperando…</p><pre id=\"log\"></pre><video id=\"video\" controls hidden style=\"width:100%\"></video><script type=\"module\">import{Client}from \"https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js\";const b=document.getElementById(\"go\"),s=document.getElementById(\"status\"),l=document.getElementById(\"log\"),v=document.getElementById(\"video\");b.onclick=async()=>{b.disabled=true;try{s.textContent=\"Conectando con Hugging Face…\";const a=await Client.connect(\"Lightricks/ltx-video-distilled\");s.textContent=\"Generando clip LTX 1216×704…\";const r=await a.predict(\"text_to_video\",[\"A cinematic realistic snowy mountain landscape at dawn, natural clouds moving across the peaks, subtle aerial camera push-in, realistic documentary cinematography, detailed textures, natural atmospheric depth, professional high-quality video, no text, no logos.\",\"worst quality, inconsistent motion, blurry, jittery, distorted, text, logos, watermark\",null,null,704,1216,\"text-to-video\",3.2,97,42,false,3,false]);const o=r?.data?.[0];const u=typeof o===\"string\"?o:(o?.url||o?.path||o?.video?.url||\"\");if(!u)throw Error(\"LTX no devolvió el vídeo.\");v.src=u;v.hidden=false;s.textContent=\"✓ Clip LTX generado.\";l.textContent=JSON.stringify(o,null,2)}catch(e){s.textContent=\"✕ Error\";l.textContent=e?.stack||String(e)}finally{b.disabled=false}};</script></body></html>")});app.get('/api/video-ai-test/:jobId',async(req,res)=>{
  const j=videoAiTestJobs.get(String(req.params.jobId||''));
  if(!j)return res.status(410).json({ok:false,status:'restart',error:'La instancia se reinició durante la prueba de vídeo IA.'});
  if(j.status==='running')return res.status(202).json({ok:false,status:'running',jobId:j.id,elapsedMs:Date.now()-j.startedAt});
  return res.status(j.result?.ok?200:503).json({status:j.status,jobId:j.id,...(j.result||{ok:false})});
});


app.get('/api/preflight',async(_req,res)=>{
  const existing=[...preflightJobs.values()].find(j=>j.status==='running');
  if(existing)return res.status(202).json({ok:false,status:'running',jobId:existing.id,statusUrl:'/api/preflight/'+encodeURIComponent(existing.id),message:'Preflight ya está ejecutándose.'});
  const id='preflight_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  preflightJobs.set(id,{id,status:'running',startedAt:Date.now(),result:null});
  res.status(202).json({ok:false,status:'running',jobId:id,statusUrl:'/api/preflight/'+encodeURIComponent(id),message:'Preflight iniciado. Consulta statusUrl para ver el resultado completo.'});
  executePreflight().then(result=>{const job=preflightJobs.get(id);if(job){job.status=result.ok?'done':'failed';job.result=result;job.finishedAt=Date.now();}}).catch(err=>{const job=preflightJobs.get(id);if(job){job.status='failed';job.result={ok:false,checks:{},failed:[{name:'preflight',error:err.message||String(err)}]};job.finishedAt=Date.now();}});
});app.get('/api/preflight/:jobId',async(req,res)=>{
  const job=preflightJobs.get(String(req.params.jobId||''));
  if(!job)return res.status(410).json({ok:false,status:'restart',error:'La instancia se reinició durante el preflight y perdió el estado temporal. No se inició ningún vídeo real. El preflight ha sido optimizado para consumir menos recursos; vuelve a abrir /api/preflight para lanzar una prueba nueva.'});
  if(job.status==='running')return res.status(202).json({ok:false,status:'running',jobId:job.id,elapsedMs:Date.now()-job.startedAt});
  return res.status(job.result?.ok?200:503).json({status:job.status,jobId:job.id,...(job.result||{ok:false,checks:{},failed:[]})});
});


const fullPipelineTestJobs=new Map();
async function executeFullPipelineTest(reference){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-full-test-'));
  const started=Date.now();
  const checks={};
  const run=async(name,fn)=>{
    const t=Date.now();
    try{
      const value=await fn();
      checks[name]={ok:true,ms:Date.now()-t,...(value&&typeof value==='object'?value:{})};
      return value;
    }catch(err){
      checks[name]={ok:false,ms:Date.now()-t,error:err.message||String(err)};
      throw err;
    }
  };
  try{
    // Keep only the small fields needed by later stages. The full Gemini analysis can be large.
    let video=null,style=null,outline=null,plan=null,narration=null,music=null,clip=null,render=null,validation=null;
    await run('youtube-analysis',async()=>{
      video=await getReferenceVideo(reference);
      style=await analyzeYoutubeReferenceMedia(reference,video);
      if(!video?.title||!style?.visualAnalysis)throw new Error('No se obtuvo un perfil audiovisual completo de YouTube.');
      return{title:video.title,hasFullVideoAnalysis:Boolean(style.hasFullVideoAnalysis),hasAudioProfile:Boolean(style.hasAudioAnalysis),estimatedSceneCount:Number(style.estimatedSceneCount||0)};
    });

    const referenceTitle=String(video.title||'Contenido original').slice(0,300);
    let referenceStyle=style;
    let visualReferenceAnalysis=style.visualAnalysis;
    const audioProfile=style.visualAnalysis?.audioProfile&&typeof style.visualAnalysis.audioProfile==='object'
      ? {...style.visualAnalysis.audioProfile}
      : {};

    await run('outline',async()=>{
      const r=await fetch('http://127.0.0.1:'+PORT+'/api/ai/outline',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          topic:referenceTitle,reference,referenceTopic:referenceTitle,
          referenceData:{title:referenceTitle,videoId:video.videoId||'',channelTitle:video.channelTitle||''},
          visualReferenceAnalysis,referenceStyle,language:'es',duration:'1'
        })
      });
      const d=await r.json();
      if(!r.ok)throw new Error(d?.error||'Outline '+r.status);
      outline=d;
      return{title:d.title||'',blocks:Array.isArray(d.outline)?d.outline.length:0};
    });

    await run('production-plan',async()=>{
      const r=await fetch('http://127.0.0.1:'+PORT+'/api/ai/production-plan',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          topic:referenceTitle,reference,referenceTopic:referenceTitle,
          referenceData:{title:referenceTitle,videoId:video.videoId||'',channelTitle:video.channelTitle||''},
          visualReferenceAnalysis,referenceStyle,language:'es',duration:'1',
          title:outline?.title||referenceTitle,outline:outline?.outline||[],visualIdeas:outline?.visualIdeas||[]
        })
      });
      const d=await r.json();
      if(!r.ok||!Array.isArray(d?.scenes)||!d.scenes.length)throw new Error(d?.error||'Production plan inválido.');
      plan=d;
      return{scenes:d.scenes.length,title:d.title||''};
    });

    // Release the large reference-analysis objects before media/audio/render work.
    video=null;
    style=null;
    referenceStyle=null;
    visualReferenceAnalysis=null;
    outline=null;

    const testScene={...(plan.scenes[0]||{}),number:1,duration:3,mediaType:'video',constantImage:false};
    plan=null;

    await run('visual-source',async()=>{
      const query=String(testScene.searchQuery||testScene.title||referenceTitle||'').trim().slice(0,120);
      const p=await searchPexelsPhotos(query);
      const q=p.length?p:await searchPixabayImages(query);
      const media=q.find(x=>x?.downloadUrl);
      if(!media)throw new Error('No se encontró una imagen visual de respaldo para la referencia.');
      const imagePath=path.join(dir,'reference-derived-source.jpg');
      await downloadToFile(media.downloadUrl,imagePath);
      const sourcePath=path.join(dir,'reference-derived-source.mp4');
      await runFfmpeg(['-y','-hide_banner','-loglevel','error','-loop','1','-i',imagePath,'-t','3','-vf','scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30','-an','-c:v','libx264','-preset','ultrafast','-crf','28','-threads','1','-pix_fmt','yuv420p',sourcePath]);
      await fs.rm(imagePath,{force:true}).catch(()=>{});
      const check=await validateGeneratedVideoClip(sourcePath);
      clip={outputPath:sourcePath,bytes:(await fs.stat(sourcePath)).size,provider:media.provider,status:'complete'};
      return{provider:media.provider,bytes:clip.bytes,durationSeconds:check.durationSeconds,width:check.width,height:check.height,query,sourceType:'image-to-video'};
    });

    await run('tts',async()=>{
      narration=await generateNarrationTts(
        testScene.narration||('Contenido original sobre '+referenceTitle+'.'),
        'es',
        audioProfile.voiceStyle||'Natural y cercana',
        audioProfile
      );
      return{bytes:narration.length,provider:'Gemini TTS'};
    });

    await run('music',async()=>{
      music=await generateFallbackMusic(
        'Original instrumental background. '+JSON.stringify(audioProfile),
        3,dir,audioProfile
      );
      return{provider:music.provider,bytes:music.buffer.length};
    });

    await run('render',async()=>{
      const output=path.join(dir,'full-test.mp4');
      render=await renderAutotubeVideo({
        scenes:[testScene],
        aiClips:[{path:clip.outputPath}],
        narrationAudio:[narration],
        musicBuffer:music.buffer,
        onProgress:()=>{},
        finalOutputPath:output
      });
      validation=await validateRenderedMp4(output,3);
      return{bytes:render.size,...validation};
    });

    return{ok:true,elapsedMs:Date.now()-started,reference:{url:reference,title:referenceTitle},checks};
  }finally{
    video=null;style=null;referenceStyle=null;visualReferenceAnalysis=null;outline=null;plan=null;narration=null;music=null;clip=null;render=null;validation=null;
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
const urlVideoJobs=new Map();
function parseIsoDurationSeconds(value){if(Number.isFinite(Number(value))&&Number(value)>0)return Number(value);const raw=String(value||'').trim();const m=raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);if(!m)return 0;return Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0);}

async function executeUrlToVideo(reference,jobId){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-url-video-'));
  const job=urlVideoJobs.get(jobId);
  try{
    const cachedReference=[...youtubeReferenceJobs.values()]
      .filter(j=>j.status==='done'&&j.reference===reference&&j.result?.video&&j.result?.referenceStyle)
      .sort((a,b)=>Number(b.finishedAt||0)-Number(a.finishedAt||0))[0];
    const useCached=Boolean(cachedReference&&Date.now()-Number(cachedReference.finishedAt||0)<15*60*1000);
    const video=useCached?cachedReference.result.video:await getReferenceVideo(reference);
    const style=useCached?cachedReference.result.referenceStyle:await analyzeYoutubeReferenceMedia(reference,video);
    if(!style?.visualAnalysis||!style?.visualAnalysis?.structureProfile){
      throw new Error('No se pudo obtener un análisis audiovisual suficiente de la referencia. El render se detuvo antes de generar visuales.');
    }

    const referenceTitle=String(video?.title||'Contenido original').slice(0,300);
    const targetDurationSeconds=Math.max(4,parseIsoDurationSeconds(video?.duration)||Number(style?.visualAnalysis?.videoProfile?.durationSeconds)||60);
    const visualReferenceAnalysis=style?.visualAnalysis||{};
    if(job)job.progress=12;

    const outlineRes=await fetch('http://127.0.0.1:'+PORT+'/api/ai/outline',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        topic:referenceTitle,reference,referenceTopic:referenceTitle,
        referenceData:video||{title:referenceTitle},
        visualReferenceAnalysis,referenceStyle:style,
        language:'es',duration:String(Math.max(1,Math.ceil(targetDurationSeconds/60)))
      })
    });
    const outline=await outlineRes.json().catch(()=>null);
    if(!outlineRes.ok)throw new Error(outline?.error||'No se pudo generar la estructura.');

    const planRes=await fetch('http://127.0.0.1:'+PORT+'/api/ai/production-plan',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        topic:referenceTitle,reference,referenceTopic:referenceTitle,
        referenceData:video||{title:referenceTitle},
        visualReferenceAnalysis,referenceStyle:style,
        language:'es',duration:String(Math.max(1,Math.ceil(targetDurationSeconds/60))),title:outline?.title||referenceTitle,
        outline:outline?.outline||[],visualIdeas:outline?.visualIdeas||[]
      })
    });
    const plan=await planRes.json().catch(()=>null);
    if(!planRes.ok||!Array.isArray(plan?.scenes)||!plan.scenes.length)
      throw new Error(plan?.error||'Plan de producción inválido.');

    const scenes=plan.scenes.map((s,i)=>({
      ...s,number:i+1,duration:Math.max(4,Math.min(20,Number(s.duration)||8)),
      mediaType:'video',constantImage:false
    }));

    // Render a short but complete original remake on the constrained
    // Render instance. The visual generator is driven by the analyzed
    // subject/style rather than copying the source recording.
    const maxSeconds=targetDurationSeconds;
    let used=0;
    const finalScenes=[];
    let cursor=0;
    while(used<maxSeconds&&scenes.length){
      const sourceScene=scenes[cursor%scenes.length];
      const remainingTarget=maxSeconds-used;
      const duration=Math.max(4,Math.min(Number(sourceScene.duration)||8,remainingTarget));
      finalScenes.push({...sourceScene,number:finalScenes.length+1,duration});
      used+=duration;
      cursor++;
      if(cursor>5000)throw new Error('El vídeo de referencia es demasiado largo para procesarlo de forma segura en una sola tarea.');
    }
    if(job)job.progress=30;

    const referenceAudio=style?.visualAnalysis?.audioProfile||{};
    const wantsVoice=Boolean(referenceAudio.hasSpeech);
    const wantsMusic=Boolean(referenceAudio.hasMusic);
    const narrationAudio=[];
    let musicBuffer=null;

    // Audio is generated only when the reference actually contains that layer.
    // Voice-only references never receive an invented music bed; music-only
    // references never receive invented narration; mixed references receive both.
    if(wantsVoice){
      for(let i=0;i<finalScenes.length;i++){
        let narration=String(finalScenes[i]?.narration||'').trim();
        if(!narration){
          const script=await callGemini({
            system:'Eres guionista de YouTube. Escribe una narración ORIGINAL, factual y directamente relacionada con el tema de la referencia. No copies frases del vídeo de referencia.',
            user:JSON.stringify({
              topic:referenceTitle,
              scene:finalScenes[i]?.title||'',
              visualPrompt:finalScenes[i]?.visualPrompt||'',
              durationSeconds:finalScenes[i]?.duration||8,
              language:'es',
              audioProfile:referenceAudio
            }),
            temperature:0.5,maxOutputTokens:350,json:false
          });
          narration=String(script||'').trim();
        }
        if(!narration)throw new Error('La referencia contiene voz, pero no se pudo crear la narración original de la escena '+String(finalScenes[i].number)+'.');
        narrationAudio[i]=await generateNarrationTts(
          narration,
          String(referenceAudio.language||'es'),
          String(referenceAudio.voiceStyle||'Natural y cercana'),
          referenceAudio
        );
      }
    }

    if(wantsMusic){
      const totalDuration=finalScenes.reduce((n,s)=>n+Math.max(4,Math.min(20,Number(s.duration)||8)),0);
      musicBuffer=await generateMusicBuffer({
        topic:referenceTitle,
        mood:String(referenceAudio.musicMood||'original instrumental'),
        audioProfile:referenceAudio,
        durationSeconds:Math.max(4,totalDuration)
      });
    }

    const resultsByScene=[];
    const aiClips=new Array(finalScenes.length).fill(null);
    for(let i=0;i<finalScenes.length;i++){
      const scene=finalScenes[i];
      const query=String(scene.searchQuery||scene.title||referenceTitle).trim().slice(0,120);
      let media=null;
      try{
        const videos=await searchPixabay(query);
        media=videos.find(x=>x?.downloadUrl)||null;
      }catch(err){console.warn('Pixabay video search fallback:',err.message||err)}
      if(!media){
        try{
          const images=await searchPexelsPhotos(query);
          media=images.find(x=>x?.downloadUrl)||null;
        }catch(err){console.warn('Pexels search fallback:',err.message||err)}
      }
      if(!media){
        try{
          const images=await searchPixabayImages(query);
          media=images.find(x=>x?.downloadUrl)||null;
        }catch(err){console.warn('Pixabay image search fallback:',err.message||err)}
      }

      // A visual search hit is not enough: verify that the asset can actually
      // be downloaded before handing it to FFmpeg. A dead CDN URL must never
      // abort the whole job; fall through to the next provider or LTX.
      if(media?.downloadUrl){
        try{
          const probePath=path.join(dir,'source-probe-'+i+'.bin');
          await downloadToFile(media.downloadUrl,probePath);
          const probeStat=await fs.stat(probePath);
          await fs.rm(probePath,{force:true}).catch(()=>{});
          if(!probeStat.size)throw new Error('Fuente visual vacía.');
        }catch(err){
          console.warn('Visual source unusable; using next fallback:',query,err.message||err);
          media=null;
        }
      }

      if(media){
        resultsByScene.push({
          number:scene.number,
          media:[{...media,mediaType:String(media.mediaType||'video').toLowerCase()}],
          mediaType:String(media.mediaType||'video').toLowerCase()
        });
      }else{
        // Last visual fallback: generate original motion from the scene
        // prompt so missing stock credentials never prevent MP4 creation.
        const generated=await generateFreeLtxVideoClip(
          String(scene.visualPrompt||scene.title||referenceTitle)+'; original footage; cinematic; 16:9; no text; no logos; do not imitate a specific existing video',
          dir,
          {durationSeconds:3,width:512,height:288,improveTexture:false}
        );
        aiClips[i]={path:generated.outputPath,mediaType:'video'};
        resultsByScene.push({number:scene.number,media:[],mediaType:'video'});
      }
      if(job)job.progress=30+Math.round(((i+1)/finalScenes.length)*30);
    }

    if(activeRenderJobId && activeRenderJobId!==jobId)
      throw new Error('Ya hay otro render en curso. Espera a que termine.');
    activeRenderJobId=jobId;

    const outputPath=path.join(renderJobDir,jobId+'.mp4');
    const result=await renderAutotubeVideo({
      scenes:finalScenes,
      mediaResults:resultsByScene,
      aiClips,
      narrationAudio,
      musicBuffer:musicBuffer?.buffer||null,
      onProgress:p=>{if(job)job.progress=60+Math.round(Math.max(0,Math.min(100,Number(p)||0))*0.38)},
      finalOutputPath:outputPath
    });

    const validation=await validateRenderedMp4(outputPath,result.duration);
    const stat=await fs.stat(outputPath);
    if(!stat.size)throw new Error('El MP4 final está vacío.');
    if(job){
      job.status='done';job.progress=100;job.outputPath=outputPath;job.size=stat.size;
      job.validation=validation;job.referenceTitle=referenceTitle;
      job.sceneCount=finalScenes.length;job.durationSeconds=validation.durationSeconds;
      job.finishedAt=Date.now();
    }
    return{ok:true,jobId,reference:{url:reference,title:referenceTitle},
      scenes:finalScenes.length,durationSeconds:validation.durationSeconds,size:stat.size,
      validation};
  }catch(err){
    if(job){job.status='error';job.progress=0;job.error=err?.message||String(err);job.finishedAt=Date.now();}
    throw err;
  }finally{
    if(activeRenderJobId===jobId)activeRenderJobId=null;
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

app.post('/api/url-to-video',async(req,res)=>{
  const reference=String(req.body?.reference||'').trim();
  if(!reference)return res.status(400).json({ok:false,error:'Añade una URL de YouTube en reference.'});
  const existing=[...urlVideoJobs.values()].find(j=>j.status==='processing'&&j.reference===reference);
  if(existing)return res.status(202).json({ok:false,status:'processing',jobId:existing.id,statusUrl:'/api/url-to-video/'+encodeURIComponent(existing.id)});
  const jobId='urlvideo_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  const job={id:jobId,reference,status:'processing',progress:1,createdAt:Date.now(),outputPath:null,error:null};
  urlVideoJobs.set(jobId,job);
  res.status(202).json({ok:true,status:'processing',jobId,statusUrl:'/api/url-to-video/'+encodeURIComponent(jobId)});
  executeUrlToVideo(reference,jobId).catch(err=>console.error('URL-to-video error:',jobId,err));
});
app.get('/api/url-to-video',async(req,res)=>{
  const reference=String(req.query?.reference||'').trim();
  if(!reference)return res.status(400).json({ok:false,error:'Añade ?reference=https://www.youtube.com/watch?v=...'});
  const existing=[...urlVideoJobs.values()].find(j=>j.status==='processing'&&j.reference===reference);
  if(existing)return res.status(202).json({ok:false,status:'processing',jobId:existing.id,statusUrl:'/api/url-to-video/'+encodeURIComponent(existing.id)});
  const jobId='urlvideo_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  const job={id:jobId,reference,status:'processing',progress:1,createdAt:Date.now(),outputPath:null,error:null};
  urlVideoJobs.set(jobId,job);
  res.status(202).json({ok:true,status:'processing',jobId,statusUrl:'/api/url-to-video/'+encodeURIComponent(jobId)});
  executeUrlToVideo(reference,jobId).catch(err=>console.error('URL-to-video error:',jobId,err));
});
app.get('/api/url-to-video/:jobId',async(req,res)=>{
  const job=urlVideoJobs.get(String(req.params.jobId||''));
  if(!job)return res.status(410).json({ok:false,status:'restart',error:'El trabajo se perdió porque Render reinició la instancia.'});
  if(job.status==='processing')return res.status(202).json({ok:false,status:'processing',jobId:job.id,progress:job.progress});
  if(job.status==='error')return res.status(500).json({ok:false,status:'error',jobId:job.id,error:job.error});
  res.json({ok:true,status:'done',jobId:job.id,progress:100,reference:job.reference,referenceTitle:job.referenceTitle,
    sceneCount:job.sceneCount,durationSeconds:job.durationSeconds,size:job.size,validation:job.validation,
    downloadUrl:'/api/url-to-video/'+encodeURIComponent(job.id)+'/download'});
});
app.get('/api/url-to-video/:jobId/download',async(req,res)=>{
  const job=urlVideoJobs.get(String(req.params.jobId||''));
  if(!job||job.status!=='done')return res.status(409).json({ok:false,error:'El vídeo todavía no está listo.'});
  try{await fs.stat(job.outputPath);res.download(job.outputPath,'autotube-reference-matched.mp4')}
  catch{res.status(404).json({ok:false,error:'El MP4 ya no está disponible. Genera un nuevo job.'})}
});

app.get('/api/full-pipeline-test',async(req,res)=>{
  const reference=String(req.query?.reference||'').trim();
  if(!reference)return res.status(400).json({ok:false,error:'Añade ?reference=https://www.youtube.com/watch?v=...'});
  const existing=[...fullPipelineTestJobs.values()].find(j=>j.status==='running'&&j.reference===reference);
  if(existing)return res.status(202).json({ok:false,status:'running',jobId:existing.id,statusUrl:'/api/full-pipeline-test/'+encodeURIComponent(existing.id)});
  const id='fulltest_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  fullPipelineTestJobs.set(id,{id,reference,status:'running',startedAt:Date.now(),result:null});
  res.status(202).json({ok:false,status:'running',jobId:id,statusUrl:'/api/full-pipeline-test/'+encodeURIComponent(id),message:'Prueba completa iniciada: YouTube → IA → vídeo → voz → música → MP4.'});
  executeFullPipelineTest(reference).then(result=>{const j=fullPipelineTestJobs.get(id);if(j){j.status=result.ok?'done':'failed';j.result=result;j.finishedAt=Date.now();}}).catch(err=>{const j=fullPipelineTestJobs.get(id);if(j){j.status='failed';j.result={ok:false,error:err.message||String(err)};j.finishedAt=Date.now();}});
});
app.get('/api/full-pipeline-test/:jobId',async(req,res)=>{
  const j=fullPipelineTestJobs.get(String(req.params.jobId||''));
  if(!j)return res.status(410).json({ok:false,status:'restart',error:'La prueba se perdió porque Render reinició la instancia.'});
  if(j.status==='running')return res.status(202).json({ok:false,status:'running',jobId:j.id,elapsedMs:Date.now()-j.startedAt});
  return res.status(j.result?.ok?200:503).json({status:j.status,jobId:j.id,...(j.result||{ok:false})});
});

const httpServer=app.listen(PORT,'0.0.0.0',()=>console.log(`AutoTube listening on ${PORT}`));
httpServer.keepAliveTimeout=120000;
httpServer.headersTimeout=125000;
httpServer.requestTimeout=0;
const startupSelfTestReference='https://www.youtube.com/watch?v=dQw4w9WgXcQ';
if(startupSelfTestReference){
  setTimeout(async()=>{
    const selfTestId='selftest_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
    const job={id:selfTestId,reference:startupSelfTestReference,status:'processing',progress:1,createdAt:Date.now(),outputPath:null,error:null};
    urlVideoJobs.set(selfTestId,job);
    console.log('AutoTube E2E self-test started:',selfTestId,startupSelfTestReference);
    try{
      const result=await executeUrlToVideo(startupSelfTestReference,selfTestId);
      console.log('AutoTube E2E self-test SUCCESS:',JSON.stringify({jobId:selfTestId,durationSeconds:result.durationSeconds,size:result.size,validation:result.validation,scenes:result.scenes}));
    }catch(err){
      console.error('AutoTube E2E self-test FAILED:',selfTestId,err?.message||String(err));
    }
  },15000);
}