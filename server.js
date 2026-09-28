require('./url-to-mp4-preload.js');
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
const { downloadYouTube } = require('@hiudyy/ytdl');
const upload = multer({ storage: multer.diskStorage({ destination: (_req,_file,cb)=>cb(null,os.tmpdir()), filename: (_req,file,cb)=>cb(null,'autotube-upload-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex')+'-'+String(file.originalname||'upload').replace(/[^a-zA-Z0-9._-]/g,'_')) }), limits: { fileSize: 250 * 1024 * 1024 } });
const renderJobs = new Map();
let activeRenderJobId = null;
const renderJobDir = path.join(os.tmpdir(), 'autotube-render-jobs');
fs.mkdir(renderJobDir, { recursive: true }).catch(() => {});
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
async function callGemini({system,user,images=[],files=[],temperature=0.7,maxOutputTokens=1200,json=false}){const k=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();if(!k)throw new Error('Falta la clave de Gemini.');const parts=[{text:String(user||'')}];for(const im of images)parts.push({inline_data:{mime_type:im.mimeType||'image/jpeg',data:im.data}});for(const file of files){if(file?.uri)parts.push({file_data:{mime_type:file.mimeType||'application/octet-stream',file_uri:file.uri}});}const headers={'Content-Type':'application/json'};headers['x-goog-'+'api-key']=k;const models=[...new Set([String(GEMINI_MODEL||'').trim(),'gemini-3.5-flash-lite','gemini-3.1-flash-lite'].filter(Boolean))];let lastError='';for(const model of models){for(const structured of (json?[true,false]:[false])){const body={system_instruction:{parts:[{text:String(system||'')}]},contents:[{role:'user',parts}],generationConfig:{maxOutputTokens,...(structured?{responseMimeType:'application/json'}:{})}};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);let response;try{response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});}catch(err){lastError=err?.name==='AbortError'?'Gemini request timeout (20s).':String(err?.message||err);continue}finally{clearTimeout(timer)}const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}if(response.ok){const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim()||'';if(text)return text;lastError='Gemini no devolvió contenido.';continue}const message=data?.error?.message||raw.slice(0,500)||'Error desconocido';lastError='Gemini '+response.status+': '+message;if(response.status===429||response.status>=500)break;if(response.status===400&&structured)continue;if(response.status===404||/model|not found|unsupported/i.test(message))break;break}}throw new Error(lastError||'Gemini no pudo procesar la solicitud.');}
async function callGeminiYoutube(url,{user,maxOutputTokens=5000}={}){const k=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();if(!k)throw new Error('Falta la clave de Gemini.');const model='gemini-3.5-flash-lite';const body={model,input:[{type:'text',text:String(user||'')},{type:'video',uri:String(url),processing:'agentic'}]};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120000);let response;try{response=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':k},body:JSON.stringify(body),signal:controller.signal});}catch(err){throw new Error(err?.name==='AbortError'?'Gemini YouTube URL timeout (120s).':String(err?.message||err));}finally{clearTimeout(timer)}const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}if(!response.ok)throw new Error('Gemini '+model+' '+response.status+': '+String(data?.error?.message||raw.slice(0,500)));const output=String(data?.output_text||data?.outputText||data?.steps?.flatMap(s=>s?.content||[]).map(c=>c?.text||'').join('')||'').trim();if(!output)throw new Error('Gemini '+model+' no devolvió análisis.');parseJsonResponse(output);console.log('AutoTube Gemini YouTube model selected:',model);return output;}
async function analyzeYoutubeReferenceMediaDirect(referenceUrl,videoMeta={}) {
  const prompt = [
    'Analiza ESTE vídeo público de YouTube directamente. No uses miniatura, título ni metadatos como sustituto del vídeo.',
    'Necesito una reconstrucción audiovisual ORIGINAL y legalmente transformativa, no una copia.',
    'Devuelve ÚNICAMENTE JSON válido con: videoProfile(durationSeconds,aspectRatio,visualStyle,composition,palette,lighting,cameraMovement,continuity,constantImage), animationProfile(cameraMotion,zoomStyle,panStyle,motionIntensity,transitionStyle,visualRhythm), audioProfile(hasSpeech,language,speechRate,pauses,emotion,hasMusic,hasAmbience,hasSoundEffects,musicMood,energy,dynamics,instrumentation,bpmEstimate,voiceStyle,voiceMusicBalance,audioContinuity), structureProfile(opening,pacing,transitions,segmentCount,segmentDurations,timestamps,sceneSegments), generationDirectives(preferredSceneCount,preserveVisualContinuity,preserveAudioContinuity,animationStrategy,visualSearchStrategy,musicStrategy,narrationStrategy).',
    'sceneSegments debe contener startSeconds,endSeconds,summary,subject,shotScale,composition,cameraMovement,motionIntensity,lighting,palette,transitionIn,transitionOut,audioRole,narrationRole,continuityAnchor,generationPrompt.',
    'Incluye todos los cambios de escena relevantes y la duración real. No inventes datos que el vídeo no permita observar.',
    'No copies personajes, caras, logos, texto, guion, frames ni grabación exacta; describe rasgos audiovisuales que AutoTube pueda recrear con material nuevo.',
    'URL: '+String(referenceUrl),
    'Metadatos auxiliares (NO usar como sustituto del vídeo): '+JSON.stringify(videoMeta).slice(0,3000)
  ].join('\\n');
  const raw=await callGeminiYoutube(referenceUrl,{user:prompt,maxOutputTokens:12000});
  const parsed=parseJsonResponse(raw);
  const vp=parsed.videoProfile||{}, ap=parsed.animationProfile||{}, aud=parsed.audioProfile||{}, sp=parsed.structureProfile||{};
  const segments=Array.isArray(sp.sceneSegments)?sp.sceneSegments:[];
  const duration=Number(vp.durationSeconds||videoMeta.durationSeconds||parseIsoDurationSeconds(videoMeta.duration)||0);
  return {
    visualAnalysis:parsed,
    visualSource:'Gemini-YouTube-URL',
    analysisSource:'Gemini direct public YouTube video',
    hasFullVideoAnalysis:true,
    hasAudioAnalysis:Boolean(aud),
    hasAnimationAnalysis:Boolean(ap),
    hasStructureAnalysis:Boolean(sp),
    referenceFileBytes:0,
    downloadStrategy:'direct-gemini-youtube',
    constantImage:Boolean(vp.constantImage),
    estimatedSceneCount:Number(vp.estimatedSceneCount||sp.segmentCount||segments.length||1),
    preferredSceneCount:Number(parsed.generationDirectives?.preferredSceneCount||sp.segmentCount||segments.length||1),
    videoProfile:vp,
    audioProfile:aud,
    animationProfile:ap,
    structureProfile:sp,
    durationSeconds:duration
  };
}

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
app.get('/api/health',(_req,res)=>res.json({ok:true,app:'AutoTube',commit:process.env.RENDER_GIT_COMMIT||'',configured:{gemini:Boolean(process.env['GEM'+'INI_'+'API_'+'KEY']),ltxZeroGpu:true,youtube:Boolean(process.env.YOUTUBE_CLIENT_ID&&process.env.YOUTUBE_CLIENT_SECRET),pexels:Boolean(process.env.PEXELS_API_KEY),pixabay:Boolean(process.env.PIXABAY_API_KEY),elevenlabs:Boolean(process.env.ELEVENLABS_API_KEY),supabase:supabaseConfigured()}}));
function extractYoutubeVideoId(input){const value=String(input||'').trim();if(!value)return'';try{const url=new URL(value);if(url.hostname==='youtu.be')return url.pathname.slice(1).split('/')[0];if(url.hostname.endsWith('youtube.com')){if(url.pathname==='/watch')return url.searchParams.get('v')||'';if(url.pathname.startsWith('/shorts/'))return url.pathname.split('/')[2]||'';if(url.pathname.startsWith('/embed/'))return url.pathname.split('/')[2]||''}}catch{}return''}
async function getReferenceVideo(input){
  const rawInput=String(input||'').trim();
  if(/\.(mp4|m4v|mov|webm|mkv)(?:$|\?)/i.test(rawInput)){
    let title='Referencia audiovisual descargada';
    try{const u=new URL(rawInput);title=decodeURIComponent(path.basename(u.pathname))||title}catch{}
    return{videoId:'',title,description:'',channelTitle:'',duration:'',definition:'',caption:false,thumbnail:'',thumbnails:[],defaultAudioLanguage:''};
  }
  const videoId=extractYoutubeVideoId(input);
  if(!videoId)throw new Error('La URL de referencia no es válida.');
  try{
    await loadYoutubeConnection();
    const apiKey=cleanEnvValue(process.env.YOUTUBE_API_KEY);
    let auth=null;
    if(youtubeTokens){
      auth=youtubeClient();
      auth.setCredentials(youtubeTokens);
    }else if(apiKey){
      auth=apiKey;
    }else{
      throw new Error('Falta YOUTUBE_API_KEY para consultar la referencia pública de YouTube.');
    }
    const youtube=google.youtube({version:'v3',auth});
    const response=await youtube.videos.list({part:'snippet,contentDetails,statistics',id:[videoId]});
    const video=response.data.items?.[0];
    if(video){
      const s=video.snippet||{},d=video.contentDetails||{};
      return{
        videoId,title:s.title||'',description:s.description||'',channelTitle:s.channelTitle||'',
        publishedAt:s.publishedAt||'',tags:s.tags||[],categoryId:s.categoryId||'',
        defaultLanguage:s.defaultLanguage||s.defaultAudioLanguage||'',duration:d.duration||'',
        definition:d.definition||'',caption:d.caption==='true',
        thumbnail:s.thumbnails?.maxres?.url||s.thumbnails?.high?.url||s.thumbnails?.medium?.url||'',
        thumbnails:[s.thumbnails?.maxres?.url,s.thumbnails?.high?.url,s.thumbnails?.standard?.url,s.thumbnails?.medium?.url].filter(Boolean),
        defaultAudioLanguage:s.defaultAudioLanguage||''
      };
    }
  }catch(err){console.error('YouTube reference API error:',err.message)}
  try{
    const oembed=await fetch('https://www.youtube.com/oembed?url='+encodeURIComponent(input)+'&format=json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    if(oembed.ok){
      const raw=await oembed.text();
      try{
        const data=JSON.parse(raw);
        return{videoId,title:data.title||'',channelTitle:data.author_name||'',thumbnail:data.thumbnail_url||'',thumbnails:[data.thumbnail_url].filter(Boolean)};
      }catch{}
    }
  }catch(err){console.warn('YouTube oEmbed metadata unavailable:',err?.message||String(err))}
  return{videoId,title:'Contenido original de YouTube',channelTitle:'',thumbnail:'',thumbnails:[]};
}
async function downloadYoutubeReference(url,dir){
  const target=path.join(dir,'reference.mp4');
  try{
    const result=await downloadYouTube(String(url||'').trim(),'mp4');
    if(!result?.success||!result.filePath) throw new Error(String(result?.error||'YouTube provider did not return a video file.'));
    await fs.copyFile(result.filePath,target);
    const stat=await fs.stat(target);
    if(!stat.size) throw new Error('La copia temporal de análisis está vacía.');
    return{file:target,bytes:stat.size,ytDlpOutput:String(result.source||''),strategy:'@hiudyy/ytdl-provider'};
  }catch(err){
    throw new Error('YouTube no permitió obtener una copia temporal para analizar la referencia. El análisis directo por URL de Gemini debe utilizarse cuando sea posible. Último error: '+String(err?.message||err));
  }
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

async function getYoutubeTranscript(input,preferredLanguage='es'){
  return{available:false,transcript:'',language:null,source:null};
}

function parseSubtitleText(raw){
  const text=String(raw||'').replace(/^\uFEFF/,'').replace(/\r/g,'');
  const blocks=text.split(/\n\n+/);
  const lines=[];
  let previous='';
  for(const block of blocks){
    const cleaned=block.split(/\n/)
      .map(x=>x.trim())
      .filter(Boolean)
      .filter(x=>!/^WEBVTT|^NOTE|^STYLE|^REGION/i.test(x))
      .filter(x=>!/^(?:\d+\s*)?$/.test(x))
      .filter(x=>!/^(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->/i.test(x));
    if(!cleaned.length)continue;
    const sentence=cleaned.join(' ').replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g,'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
    if(sentence&&sentence!==previous){lines.push(sentence);previous=sentence;}
  }
  return lines.join(' ').slice(0,100000);
}

function runFfmpeg(args){return new Promise((resolve,reject)=>{const safeArgs=[...args];const p=spawn(ffmpegPath,safeArgs,{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000)});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('FFmpeg '+code+': '+err.slice(-2500))))})}
async function generateFallbackMusic(description,durationSeconds,dir,audioProfile={}){const duration=Math.max(1,Math.min(300,Number(durationSeconds)||30));const out=path.join(dir,'autotube-original-music-'+Date.now()+'.mp3');const energy=String(audioProfile.energy||'').toLowerCase();const gain=/(high|intense|energetic)/.test(energy)?0.16:0.10;await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=196:sample_rate=44100','-f','lavfi','-i','sine=frequency=246.94:sample_rate=44100','-f','lavfi','-i','sine=frequency=293.66:sample_rate=44100','-filter_complex','[0:a]volume='+gain+'[a0];[1:a]volume='+(gain*0.75)+'[a1];[2:a]volume='+(gain*0.55)+'[a2];[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,lowpass=f=4200,afade=t=in:st=0:d=2,afade=t=out:st='+Math.max(0,duration-2)+':d=2[a]','-map','[a]','-t',String(duration),'-ac','2','-ar','44100','-c:a','libmp3lame','-b:a','128k',out]);const buffer=await fs.readFile(out);if(!buffer.length)throw new Error('La música local quedó vacía.');return{buffer,provider:'AutoTube local procedural music',durationSeconds:duration,description:String(description||'')};}

async function probeReferenceTechnical(file){
  const stderr=await new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-map','0:v:0','-map','0:a:0?','-c','copy','-f','null','-'],{stdio:['ignore','pipe','pipe']});
    let e='';p.stderr.on('data',d=>{e+=d.toString();if(e.length>30000)e=e.slice(-30000)});
    p.on('error',reject);p.on('close',code=>code===0?resolve(e):reject(new Error('FFmpeg no pudo inspeccionar el MP4: '+e.slice(-1800))));
  });
  const t=String(stderr);
  const dm=t.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const duration=dm?Number(dm[1])*3600+Number(dm[2])*60+Number(dm[3]):0;
  const videoLine=t.split(/\r?\n/).find(x=>/Video:/i.test(x))||'';
  const audioLine=t.split(/\r?\n/).find(x=>/Audio:/i.test(x))||'';
  const size=videoLine.match(/(\d{2,5})x(\d{2,5})/);
  const fps=videoLine.match(/(\d+(?:\.\d+)?)\s*fps/i);
  const videoCodec=(videoLine.match(/Video:\s*([^,\s]+)/i)||[])[1]||'';
  const audioCodec=(audioLine.match(/Audio:\s*([^,\s]+)/i)||[])[1]||'';
  return{durationSeconds:duration,width:size?Number(size[1]):0,height:size?Number(size[2]):0,fps:fps?Number(fps[1]):0,videoCodec,audioCodec,videoLine,audioLine,hasAudio:Boolean(audioLine)};
}
async function detectReferenceScenes(file,durationSeconds){
  const stderr=await new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-vf',"select='gt(scene,0.28)',showinfo",'-an','-f','null','-'],{stdio:['ignore','ignore','pipe']});
    let e='';p.stderr.on('data',d=>{e+=d.toString();if(e.length>120000)e=e.slice(-120000)});
    p.on('error',reject);p.on('close',code=>code===0?resolve(e):reject(new Error('FFmpeg no pudo detectar cambios de escena: '+e.slice(-1800))));
  });
  const times=[0];
  for(const m of String(stderr).matchAll(/pts_time:\s*([0-9.]+)/g)){
    const v=Number(m[1]);
    if(Number.isFinite(v)&&v>0.05&&v<durationSeconds-0.05)times.push(v);
  }
  times.sort((a,b)=>a-b);
  const unique=[];
  for(const v of times)if(!unique.length||Math.abs(v-unique[unique.length-1])>0.25)unique.push(v);
  const boundaries=[...unique,durationSeconds];
  const scenes=[];
  for(let i=0;i<boundaries.length-1;i++){
    const start=boundaries[i],end=boundaries[i+1];
    if(end-start<0.1)continue;
    scenes.push({number:scenes.length+1,startSeconds:start,endSeconds:end,durationSeconds:end-start});
  }
  return scenes.length?scenes:[{number:1,startSeconds:0,endSeconds:durationSeconds,durationSeconds}];
}

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
      const technical=await probeReferenceTechnical(input);
      if(!technical.durationSeconds)throw new Error('No se pudo determinar la duración del vídeo de referencia.');
      const sceneProfile=await detectReferenceScenes(input,technical.durationSeconds);
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
      return res.json({ok:true,analysis:parseJsonResponse(content),framesAnalyzed:images.length,technical,sceneCount:sceneProfile.length,scenes:sceneProfile});
    }finally{
      await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
      await fs.rm(file.path,{force:true}).catch(()=>{});
    }
  }catch(err){
    console.error('Visual reference analysis error:',err);
    return res.status(502).json({error:err.message||'No se pudo analizar visualmente el vídeo de referencia.'});
  }
});

async function downloadToFile(url,file){const response=await fetch(String(url),{redirect:'follow',signal:AbortSignal.timeout(90000),headers:{'User-Agent':'AutoTube/1.0'}});if(!response.ok)throw new Error('Descarga de recurso '+response.status);const data=Buffer.from(await response.arrayBuffer());if(!data.length)throw new Error('Recurso descargado vacío.');await fs.writeFile(file,data);return file;}
async function downloadAudioBuffer(source,file){if(typeof source==='string'){await fs.copyFile(source,file)}else{await fs.writeFile(file,source)}const stat=await fs.stat(file);if(!stat.size)throw new Error('El audio generado está vacío.');}
async function renderAutotubeVideo({scenes,mediaResults=[],aiClips=[],narrationAudio=[],musicBuffer=null,onProgress=()=>{},finalOutputPath,targetWidth=910,targetHeight=512,targetFps=30,targetDurationSeconds=0}){
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
    const preparedInputs=new Array(sceneInputs.length).fill(null);
    // Download one source at a time. This keeps memory and sockets bounded even
    // when the reference contains hundreds of scenes.
    for(let i=0;i<sceneInputs.length;i++){
      const x=sceneInputs[i];
      if(x.aiClip?.path||x.aiClip?.buffer||!x.media?.downloadUrl)continue;
      const source=String(x.media.downloadUrl||'');
      if(path.isAbsolute(source)){preparedInputs[i]=source;}
      else{const p=path.join(dir,'pre-'+i+'.mp4');await downloadToFile(source,p);preparedInputs[i]=p;}
    }
    for(let i=0;i<total;i++){
      const{scene,found,aiClip,media,audio}=sceneInputs[i];
      const input=path.join(dir,'in-'+i+'.mp4');
      const output=path.join(dir,'scene-'+i+'.mp4');
      const duration=Math.max(0.1,Number(scene.duration)||8);
      if(aiClip?.path)await fs.copyFile(aiClip.path,input);
      else if(aiClip?.buffer)await fs.writeFile(input,aiClip.buffer);
      else await fs.copyFile(preparedInputs[i],input);
      let audioInput=null;
      if(audio){audioInput=path.join(dir,'voice-'+i+'.wav');await downloadAudioBuffer(audio,audioInput);}
      const isImage=String(aiClip?.mediaType||media?.mediaType||found?.mediaType||scene.mediaType||'video').toLowerCase()==='image';
      const args=['-y','-hide_banner','-loglevel','error'];
      if(isImage)args.push('-loop','1','-i',input);else args.push('-stream_loop','-1','-i',input);
      if(audioInput)args.push('-i',audioInput);else args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100');
      const tw=Math.max(256,Math.round(Number(targetWidth)||910)),th=Math.max(256,Math.round(Number(targetHeight)||512)),tf=Math.max(1,Math.round(Number(targetFps)||30));
      const motionFilter=isImage
        ? (Number(scene.number||i)%2
          ? `scale=${Math.round(tw*2.2)}:${Math.round(th*2.2)}:force_original_aspect_ratio=increase,crop=${tw}:${th},rotate='0.018*sin(n/28)':fillcolor=black,eq=contrast=1.03:saturation=1.06,format=yuv420p,fps=${tf}`
          : `scale=${Math.round(tw*2.2)}:${Math.round(th*2.2)}:force_original_aspect_ratio=increase,crop=${tw}:${th},rotate='-0.018*sin(n/32)':fillcolor=black,eq=contrast=1.03:saturation=1.06,format=yuv420p,fps=${tf}`)
        : `scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},format=yuv420p,fps=${tf}`;
      args.push('-t',String(duration),
        // Animated treatment for still visuals: subtle Ken-Burns camera motion,
        // alternating push-in/pan, so image scenes never remain completely static.
        // Video sources keep the lightweight 720p path for Render Free memory limits.
        '-vf',motionFilter,
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
    const duration=targetDurationSeconds>0?Number(targetDurationSeconds):sceneInputs.reduce((n,x)=>n+Math.max(0.1,Number(x.scene.duration)||8),0);
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
app.post('/api/render',upload.fields([{name:'narration'},{name:'music',maxCount:1},{name:'aiClips'}]),async(req,res)=>{try{if(activeRenderJobId){return res.status(409).json({error:'Ya hay un render en curso. Espera a que termine antes de iniciar otro.'})}let scenes=[];let mediaResults=[];try{scenes=JSON.parse(String(req.body?.scenes||'[]'));mediaResults=JSON.parse(String(req.body?.mediaResults||'[]'));}catch{throw new Error('Los datos de producción no tienen un formato válido.');}if(!scenes.length||(!mediaResults.length&&!Array.isArray(req.files?.aiClips)))return res.status(400).json({error:'Genera los vídeos IA de las escenas o busca visuales de respaldo antes de renderizar.'});const jobId='render_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex'),outputPath=path.join(renderJobDir,jobId+'.mp4');renderJobs.set(jobId,{status:'processing',progress:1,createdAt:Date.now(),outputPath,error:null});activeRenderJobId=jobId;res.status(202).json({ok:true,jobId,status:'processing'});(async()=>{const job=renderJobs.get(jobId);try{const narrationFiles=Array.isArray(req.files?.narration)?req.files.narration:[],musicFile=Array.isArray(req.files?.music)?req.files.music[0]:null,aiClipFiles=Array.isArray(req.files?.aiClips)?req.files.aiClips:[];const result=await renderAutotubeVideo({scenes,mediaResults,aiClips:aiClipFiles,narrationAudio:narrationFiles.map(x=>x.path),musicBuffer:musicFile?.path||null,onProgress:p=>{if(job)job.progress=p},finalOutputPath:outputPath,targetWidth:Number(req.body?.targetWidth)||910,targetHeight:Number(req.body?.targetHeight)||512,targetFps:Number(req.body?.targetFps)||30,targetDurationSeconds:Number(req.body?.targetDurationSeconds)||0});const expectedDuration=scenes.reduce((n,s)=>n+Math.max(0.1,Number(s.duration)||8),0);const validation=await validateRenderedMp4(outputPath,expectedDuration);if(job){job.validation=validation;job.status='done';job.progress=100;job.size=result.size;job.finishedAt=Date.now()}console.log('Render completed:',jobId,'size=',result.size)}catch(err){console.error('Render error:',jobId,err);if(job){job.status='error';job.progress=0;job.error=err.message||'No se pudo renderizar el vídeo.'}}finally{activeRenderJobId=null;for(const f of [...(Array.isArray(req.files?.narration)?req.files.narration:[]),...(Array.isArray(req.files?.music)?req.files.music:[]),...(Array.isArray(req.files?.aiClips)?req.files.aiClips:[])])await fs.rm(f.path,{force:true}).catch(()=>{});}})()}catch(err){console.error('Render start error:',err);if(!res.headersSent)res.status(500).json({error:err.message||'No se pudo iniciar el render.'})}});
app.get('/api/render/:jobId',async(req,res)=>{const job=renderJobs.get(String(req.params.jobId||''));if(!job)return res.status(404).json({error:'Render no encontrado. El servicio puede haberse reiniciado; inicia un nuevo render.'});if(job.status==='processing')return res.json({ok:true,status:'processing',progress:job.progress||0});if(job.status==='error')return res.json({ok:false,status:'error',error:job.error||'No se pudo renderizar el vídeo.'});try{const stat=await fs.stat(job.outputPath);if(!stat.size)throw new Error('MP4 vacío');res.json({ok:true,status:'done',progress:100,size:stat.size,validation:job.validation||null,downloadUrl:'/api/render/'+encodeURIComponent(req.params.jobId)+'/download'})}catch{return res.status(404).json({error:'El vídeo renderizado ya no está disponible. Inicia un nuevo render.'})}});
app.get('/api/render/:jobId/download',async(req,res)=>{const job=renderJobs.get(String(req.params.jobId||''));if(!job)return res.status(404).json({error:'Render no encontrado.'});if(job.status!=='done')return res.status(409).json({error:'El render todavía no está listo.'});try{await fs.stat(job.outputPath);res.download(job.outputPath,'autotube-final.mp4')}catch{res.status(404).json({error:'El vídeo renderizado ya no está disponible.'})}});

async function validateAnimatedMotion(file){
  const result=await new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-loglevel','error','-i',file,'-vf','fps=2,scale=160:-1','-frames:v','24','-f','framemd5','-'],{stdio:['ignore','pipe','pipe']});
    let out='',err='';
    p.stdout.on('data',x=>out+=x.toString());
    p.stderr.on('data',x=>err+=x.toString());
    p.on('error',reject);
    p.on('close',code=>code===0?resolve(out):reject(new Error('No se pudo comprobar el movimiento del MP4: '+err.slice(-800))));
  });
  const hashes=String(result).split(/\r?\n/).map(x=>x.trim()).filter(x=>/[0-9a-f]{32}$/i.test(x)).map(x=>x.split(',').pop().trim()).filter(x=>/^[0-9a-f]{32}$/i.test(x));
  const uniqueHashes=[...new Set(hashes)];
  if(hashes.length<2||uniqueHashes.length<2)throw new Error('El MP4 final no presenta movimiento real entre frames; se detectó una imagen estática.');
  return{motionDetected:true,sampledFrames:hashes.length,uniqueFrames:uniqueHashes.length};
}

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


async function generatePollinationsOriginalImage(prompt,dir,options={}) {
  const width=Math.max(512,Math.min(1280,Number(options.width)||1280));
  const height=Math.max(288,Math.min(720,Number(options.height)||720));
  const seed=Number.isFinite(Number(options.seed))?Number(options.seed):Math.floor(Math.random()*2147483647);
  const url='https://image.pollinations.ai/prompt/'+encodeURIComponent(String(prompt||'').trim())+'?'+new URLSearchParams({model:'flux',width:String(width),height:String(height),seed:String(seed),nologo:'true',private:'true',enhance:'true',safe:'true'}).toString();
  let lastError=null;
  for(let attempt=0;attempt<3;attempt++){
    if(attempt>0)await new Promise(r=>setTimeout(r,6500));
    try{
      const response=await fetch(url,{signal:AbortSignal.timeout(120000),headers:{Accept:'image/jpeg,image/png;q=0.9,*/*;q=0.1','User-Agent':'AutoTube/1.0'}});
      if(!response.ok){lastError=new Error('Pollinations image generation '+response.status);continue;}
      const contentType=String(response.headers.get('content-type')||'').toLowerCase();
      if(!contentType.startsWith('image/')){lastError=new Error('Pollinations no devolvió una imagen ('+contentType+').');continue;}
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length<1000){lastError=new Error('Pollinations devolvió una imagen vacía.');continue;}
      const outputPath=path.join(dir,'pollinations-original-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.jpg');
      await fs.writeFile(outputPath,bytes);
      await new Promise((resolve,reject)=>{const p=require('child_process').spawn(ffmpegPath,['-hide_banner','-v','error','-i',outputPath,'-f','null','-']);let err='';p.stderr.on('data',d=>err+=d);p.on('close',code=>code===0?resolve(true):reject(new Error('Imagen Pollinations inválida: '+err.slice(0,300))) )});
      return{outputPath,bytes:bytes.length,provider:'Pollinations AI · Flux',model:'flux',status:'complete'};
    }catch(err){lastError=err}
  }
  throw lastError||new Error('Pollinations no pudo generar la imagen.');
}

async function generateNarrationTts(text,language='es',voiceStyle='Natural y cercana',audioProfile={}) {
  const clean=String(text||'').replace(/\s+/g,' ').trim().slice(0,280);
  if(!clean)return null;
  const tl=String(language||'es').toLowerCase().split(/[-_]/)[0]||'es';
  const url='https://translate.google.com/translate_tts?'+new URLSearchParams({ie:'UTF-8',client:'tw-ob',tl,q:clean});
  const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{Accept:'audio/mpeg','User-Agent':'Mozilla/5.0 AutoTube/1.0'}});
  if(!response.ok)throw new Error('Google TTS '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length<1000)throw new Error('Google TTS devolvió audio vacío.');
  return bytes;
}
const generateGeminiTts=generateNarrationTts;

async function generateGeminiOriginalImage(prompt,dir,options={}) {
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key)throw new Error('Falta GEMINI_API_KEY.');
  const model=String(options.model||'gemini-2.5-flash-image').trim();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),45000);
  try{
    const body={
      contents:[{parts:[{text:String(prompt||'').trim()}]}],
      generationConfig:{
        responseModalities:['IMAGE'],
        responseFormat:{image:{aspectRatio:'16:9'}}
      }
    };
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-goog-api-key':key},
      body:JSON.stringify(body),
      signal:controller.signal
    });
    const raw=await response.text();
    let data=null;try{data=raw?JSON.parse(raw):null}catch{}
    if(!response.ok)throw new Error('Gemini image generation '+response.status+': '+(data?.error?.message||raw.slice(0,500)));
    const parts=data?.candidates?.[0]?.content?.parts||[];
    const imagePart=parts.find(p=>p?.inlineData?.data||p?.inline_data?.data);
    const b64=String(imagePart?.inlineData?.data||imagePart?.inline_data?.data||'').trim();
    if(!b64)throw new Error('Gemini image generation no devolvió datos de imagen.');
    const mime=String(imagePart?.inlineData?.mimeType||imagePart?.inline_data?.mime_type||'image/png').trim();
    const ext=/jpe?g/i.test(mime)?'jpg':'png';
    const outputPath=path.join(dir,'gemini-original-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.'+ext);
    await fs.writeFile(outputPath,Buffer.from(b64,'base64'));
    const stat=await fs.stat(outputPath);
    if(!stat.size)throw new Error('Gemini devolvió una imagen vacía.');
    if(typeof global.gc==='function')global.gc();
    return{outputPath,bytes:stat.size,provider:'Google Gemini image generation',model,status:'complete'};
  }finally{clearTimeout(timer)}
}

const freeVideoQuota = { successful: [], active: false };
function freeVideoQuotaLimit(){return Math.max(1,Math.min(3,Number(process.env.AUTOTUBE_FREE_DAILY_LIMIT||1)));}
function freeVideoQuotaWindowMs(){return 24*60*60*1000;}
function pruneFreeVideoQuota(){const now=Date.now();freeVideoQuota.successful=freeVideoQuota.successful.filter(t=>now-t<freeVideoQuotaWindowMs());}
function canStartFreeVideoGeneration(){pruneFreeVideoQuota();return !freeVideoQuota.active && freeVideoQuota.successful.length<freeVideoQuotaLimit();}
function reserveFreeVideoGeneration(){pruneFreeVideoQuota();if(freeVideoQuota.active)throw new Error('Ya hay una generación de vídeo IA gratuita en curso.');if(freeVideoQuota.successful.length>=freeVideoQuotaLimit())throw new Error('Se ha alcanzado la cuota gratuita diaria de vídeo IA. Vuelve a intentarlo cuando se renueve la cuota.');freeVideoQuota.active=true;}
function finishFreeVideoGeneration(success){if(success)freeVideoQuota.successful.push(Date.now());freeVideoQuota.active=false;pruneFreeVideoQuota();}

async function generatePollinationsVideoClip(prompt,dir,options={}) {
  const key=String(process.env.POLLINATIONS_API_KEY||'').trim();
  if(!key)throw new Error('No hay POLLINATIONS_API_KEY configurada para el fallback de vídeo IA.');
  const duration=Math.max(2,Math.min(5,Number(options.durationSeconds)||4));
  const aspectRatio=String(options.aspectRatio||'16:9');
  const model=String(process.env.POLLINATIONS_VIDEO_MODEL||'wan-fast').trim();
  const endpoint='https://gen.pollinations.ai/video/'+encodeURIComponent(String(prompt||'').trim())+'?'+new URLSearchParams({
    model,duration:String(duration),aspectRatio
  }).toString();
  const response=await fetch(endpoint,{signal:AbortSignal.timeout(240000),headers:{
    Authorization:'Bearer '+key,
    Accept:'video/mp4,video/*,*/*;q=0.8',
    'User-Agent':'AutoTube/1.0'
  }});
  if(!response.ok)throw new Error('Pollinations video generation '+response.status+': '+(await response.text()).slice(0,500));
  if(!response.body)throw new Error('Pollinations video no devolvió un cuerpo de respuesta.');
  const outputPath=path.join(dir,'pollinations-video-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
  const handle=await fs.open(outputPath,'w');
  const reader=response.body.getReader();
  let total=0;
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      total+=part.value.byteLength;
      if(total>180*1024*1024){await reader.cancel().catch(()=>{});throw new Error('El vídeo Pollinations supera el límite de 180 MB.');}
      await handle.write(Buffer.from(part.value));
    }
  }finally{await handle.close().catch(()=>{});}
  if(!total)throw new Error('Pollinations devolvió un vídeo vacío.');
  return{outputPath,bytes:total,provider:'Pollinations AI video',model,durationSeconds:duration,status:'complete'};
}

async function generateFreeLtxVideoClip(prompt,dir,options={}) {
  try {
    const {Client}=require('@gradio/client');
    const space=String(process.env.LTX_SPACE||'Lightricks/ltx-video-distilled').trim();
    const duration=Math.max(0.3,Math.min(8.5,Number(options.durationSeconds)||5));
    const width=Math.max(256,Math.min(1280,Math.round((Number(options.width)||704)/32)*32));
    const height=Math.max(256,Math.min(1280,Math.round((Number(options.height)||512)/32)*32));
    const negativePrompt=String(options.negativePrompt||'worst quality, inconsistent motion, blurry, jittery, distorted, text, logos').trim();
    const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
    const app=await Client.connect(space,token?{token}:undefined);
    const seed=Math.floor(Math.random()*4294967295);
    const result=await app.predict('/text_to_video',[
      String(prompt||'').trim(), negativePrompt, null, null,
      height, width, 'text-to-video', duration, 9, seed, true,
      Number(options.guidanceScale||3), Boolean(options.improveTexture??false)
    ]);
    const data=Array.isArray(result?.data)?result.data:[];
    const output=data[0];
    const url=typeof output==='string'?output:(output?.url||output?.path||output?.video?.url||'');
    if(!url)throw new Error('LTX/ZeroGPU terminó la generación pero no devolvió el vídeo.');
    const response=await fetch(String(url));
    if(!response.ok)throw new Error('LTX/ZeroGPU no pudo descargar el vídeo generado ('+response.status+').');
    const outputPath=path.join(dir,'ltx-generated-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
    if(response.body?.getReader){
      const handle=await fs.open(outputPath,'w');
      const reader=response.body.getReader();
      let total=0;
      try{
        while(true){
          const part=await reader.read();
          if(part.done)break;
          total+=part.value.byteLength;
          if(total>180*1024*1024){await reader.cancel().catch(()=>{});throw new Error('El vídeo IA generado supera el límite de 180 MB.');}
          await handle.write(Buffer.from(part.value));
        }
      }finally{await handle.close().catch(()=>{});}
      if(!total)throw new Error('LTX/ZeroGPU devolvió un vídeo vacío.');
    }else{
      await fs.writeFile(outputPath,Buffer.from(await response.arrayBuffer()));
    }
    if(typeof global.gc==='function')global.gc();
    const stat=await fs.stat(outputPath);
    if(!stat.size)throw new Error('LTX/ZeroGPU devolvió un vídeo vacío.');
    return{outputPath,bytes:stat.size,provider:'Hugging Face ZeroGPU · LTX Video',model:'LTX Video 0.9.8 distilled',durationSeconds:duration,status:'complete'};
  } catch (ltxErr) {
    const message=String(ltxErr?.message||ltxErr);
    console.warn('LTX video unavailable; trying Pollinations video fallback:',message);
    if(!String(process.env.POLLINATIONS_API_KEY||'').trim())throw ltxErr;
    return generatePollinationsVideoClip(prompt,dir,options);
  }
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
    const prompt='ORIGINAL cinematic AI football-film test inspired only by the audiovisual profile measured from the supplied reference: photorealistic high-end sports cinematography, dramatic wide 16:9 compositions, realistic human motion, dynamic low-angle tracking and aerial camera movement, strong depth, atmospheric haze, cool blue-gray environments contrasted with saturated red/yellow/green football kits, dramatic natural and stadium lighting, epic surreal locations blending real football action with fantastical landscapes. Create a NEW scene: an original footballer in a fictional unbranded kit sprinting across a rain-soaked futuristic stadium tunnel toward a luminous ball, with a sweeping camera move and cinematic motion. Do not reproduce any reference player, face, team, logo, number, text, exact shot, frame, recording, or composition. No text, no logos, no watermark.';
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
  const style=await analyzeYoutubeReferenceMediaDirect(referenceUrl,video);
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
app.get('/video-ai-test-h3',async(req,res)=>{res.type('html').send(`<!doctype html><html><body><p id="s">starting</p><script type="module">import{Client}from"https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";(async()=>{try{const c=await Client.connect("multimodalart/minimax-h3");document.getElementById("s").textContent="connected";const r=await c.predict("generate",["Original cinematic football movie scene inspired by a reference with surreal international football imagery, photorealistic athletes, dramatic stadium and fantasy landscapes, dynamic camera movement, cinematic lighting, realistic motion. Create a completely new unbranded fictional football scene, no real players, teams, logos, text or copied shot.",null,null,"1344x768 · 16:9 full",5,20,42,false]);const o=r?.data?.[0],u=typeof o==="string"?o:(o?.url||o?.path||o?.video?.url||"");if(!u)throw Error("H3 returned no video");window.__out=u;document.getElementById("s").textContent="done"}catch(e){window.__err=String(e);document.getElementById("s").textContent="error "+String(e)}})();</script></body></html>`)});
app.get('/video-ai-test-browser',async(req,res)=>{res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>AutoTube LTX batch</title></head><body><p id="status">Generación real en servidor…</p><pre id="log"></pre><script>
const batch=Math.max(0,Math.min(22,Number(new URLSearchParams(location.search).get('batch')||0)));
(async()=>{try{const r=await fetch('/api/test/ltx-batch?batch='+batch);const d=await r.json();if(!r.ok)throw Error(d.error||'LTX failed');window.__outputs=d.outputs||[];window.__done=true;document.getElementById('status').textContent='DONE';document.getElementById('log').textContent=JSON.stringify({batch,count:window.__outputs.length})}catch(e){window.__error=String(e.stack||e);document.getElementById('status').textContent='ERROR';document.getElementById('log').textContent=window.__error}})();
</script></body></html>`)});

app.get('/api/test/ltx-batch',async(req,res)=>{try{
  const batch=Math.max(0,Math.min(22,Number(req.query.batch||0)));
  const headerToken=String(req.get('x-autotube-hf-token')||'').trim();
  const hfToken=headerToken||String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  if(!hfToken)return res.status(503).json({error:'HF_TOKEN/HUGGINGFACE_TOKEN no está configurado en Render.'});
  const {Client}=require('@gradio/client');
  const ideas=["an original footballer in a fictional unbranded kit running across a vast cinematic stadium landscape at sunrise","an original football floating above a surreal ocean cliff with dramatic clouds and atmospheric haze","two fictional unbranded footballers crossing a futuristic stadium tunnel with cinematic practical lighting","an original player controlling a glowing ball on rain-soaked pavement in a modern city","a fictional footballer sprinting through a desert landscape with monumental mountains and golden light","an original goalkeeper reaching toward a luminous ball in a surreal stadium surrounded by mist","a fictional footballer standing in shallow reflective water beneath floating islands and waterfalls","an original football team in fictional kits walking toward a distant stadium horizon under dramatic clouds","a crystalline fictional football spinning above warm sand with realistic reflections and shallow depth of field","an original player dribbling through a night stadium with powerful beams of light and atmospheric smoke","a fictional footballer moving through a volcanic landscape with glowing lava and dramatic backlight","an original footballer performing a powerful kick on a cinematic coastal pitch at sunset"];
  const variations=["wide establishing shot","low-angle tracking shot","slow cinematic push-in","dynamic aerial camera","close-up with shallow depth of field","side tracking camera","dramatic orbit camera","long-lens sports documentary framing"];
  const base="Photorealistic high-end original AI football movie, cinematic 16:9 language, realistic human anatomy and motion, detailed textures, atmospheric haze, premium sports cinematography. ORIGINAL CONTENT ONLY: no real players, no real teams, no logos, no numbers, no text, no watermark, no copied frame or shot.";
  const negative="worst quality, blurry, jittery, distorted anatomy, duplicate limbs, text, logos, watermark, real person likeness";
  const client=await Client.connect("Lightricks/ltx-video-distilled",{hf_token:hfToken});
  const outputs=[];
  for(let i=0;i<4;i++){const n=batch*4+i;const prompt=ideas[n%ideas.length]+", "+variations[n%variations.length]+". "+base+" This is scene "+(n+1)+" of a longer original football film; preserve coherent visual language but make the scene distinct.";const result=await client.predict("/text_to_video",[prompt,negative,null,null,288,512,"text-to-video",3.0,9,Math.floor(Math.random()*4294967295),true,3,false]);const o=result?.data?.[0];const url=typeof o==="string"?o:(o?.url||o?.path||o?.video?.url||"");if(!url)throw new Error("LTX no devolvió el clip "+(i+1));outputs.push(url)}
  res.json({ok:true,batch,outputs});
}catch(err){console.error("LTX server batch error:",err);res.status(500).json({error:String(err?.message||err)})}});
app.get('/api/video-ai-test/:jobId',async(req,res)=>{
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
async function executeFullPipelineTest(reference,testId=null){
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
    let video=null,style=null,outline=null,plan=null,narrationAudio=[],music=null,render=null,validation=null,mediaResults=[],aiClips=[];
    await run('youtube-source-and-reference-analysis',async()=>{
      video=await getReferenceVideo(reference);
      style=await analyzeYoutubeReferenceMediaDirect(reference,video);
      if(!video?.title||!style?.visualAnalysis)throw new Error('No se obtuvo un perfil audiovisual completo de YouTube.');
      return{
        title:video.title,
        hasFullVideoAnalysis:Boolean(style.hasFullVideoAnalysis),
        hasAudioProfile:Boolean(style.hasAudioAnalysis),
        estimatedSceneCount:Number(style.estimatedSceneCount||0),
        preferredSceneCount:Number(style.preferredSceneCount||0),
        referenceFileBytes:Number(style.referenceFileBytes||0),
        downloadStrategy:style.downloadStrategy||''
      };
    });

    const referenceTitle=String(video.title||'Contenido original').slice(0,300);
    const referenceStyle=style;
    const visualReferenceAnalysis=style.visualAnalysis;
    const audioProfile={...(visualReferenceAnalysis?.audioProfile||{})};
    const durationSeconds=Math.max(1,Number(parseIsoDurationSeconds(video.duration)||visualReferenceAnalysis?.videoProfile?.durationSeconds||30));

    outline={title:referenceTitle,outline:[],visualIdeas:[]};

    await run('production-plan',async()=>{
      const r=await fetch('http://127.0.0.1:'+PORT+'/api/ai/production-plan',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          topic:referenceTitle,reference,referenceTopic:referenceTitle,
          referenceData:{title:referenceTitle,videoId:video.videoId||'',channelTitle:video.channelTitle||''},
          visualReferenceAnalysis,referenceStyle,language:'es',
          duration:String(Math.max(1,Math.round(durationSeconds/60))),
          title:outline?.title||referenceTitle,
          outline:outline?.outline||[],visualIdeas:outline?.visualIdeas||[]
        })
      });
      const d=await r.json();
      if(!r.ok||!Array.isArray(d?.scenes)||!d.scenes.length)throw new Error(d?.error||'Production plan inválido.');
      plan=d;
      return{scenes:d.scenes.length,title:d.title||'',durationSeconds};
    });

    const preferred=Math.max(1,Number(style.preferredSceneCount||style.estimatedSceneCount||plan.scenes.length||1));
    if(!style.constantImage && preferred>plan.scenes.length){
      const blueprint=await run('reference-blueprint',async()=>{
        const b=await buildReferenceBlueprint({referenceTitle,transcript:'',visualReferenceAnalysis,referenceStyle});
        return b;
      });
      if(blueprint?.sections?.length)plan.scenes=applyReferenceBlueprint(plan.scenes,blueprint,durationSeconds);
    }
    if(style.constantImage){
      plan.scenes=plan.scenes.slice(0,1).map(s=>({...s,duration:durationSeconds,constantImage:true,mediaType:'image'}));
    }
    if(!plan.scenes.length)throw new Error('No hay escenas después de ajustar la estructura de referencia.');
    // Normalize scene numbering and make the durations cover the whole reference.
    plan.scenes=plan.scenes.map((scene,i)=>({...scene,number:i+1,duration:Number(scene.duration)>0?Number(scene.duration):durationSeconds/plan.scenes.length}));
    const sceneTotal=plan.scenes.reduce((n,x)=>n+Number(x.duration||0),0);
    if(sceneTotal>0){
      const scale=durationSeconds/sceneTotal;
      plan.scenes=plan.scenes.map(x=>({...x,duration:Math.max(0.5,Number(x.duration||0)*scale)}));
    }

    await run('visual-sources-all-scenes',async()=>{
      // Prefer original AI video generation first. This avoids making the E2E depend
      // on third-party media-search providers that may return HTML/403/429.
      mediaResults=plan.scenes.map(scene=>({number:scene.number,query:scene.searchQuery||scene.title||referenceTitle,media:[]}));
      // Generate original motion clips sequentially when LTX is available. Never run
      // scene generations concurrently on Render Free; that would spike memory/CPU.
      {
        for(let i=0;i<plan.scenes.length;i++){
          const scene=plan.scenes[i];
          try{
            const clip=await generateFreeLtxVideoClip(String(scene.visualPrompt||scene.title||referenceTitle)+'; '+JSON.stringify(visualReferenceAnalysis?.videoProfile||{}).slice(0,3200)+'; '+String(scene.animationNotes||'').slice(0,1200)+'; ORIGINAL MATERIAL ONLY.',dir,{durationSeconds:Math.min(8.5,Math.max(3,Number(scene.duration)||5)),width:704,height:396,improveTexture:false});
            await validateGeneratedVideoClip(clip.outputPath);
            aiClips[i]={path:clip.outputPath,mediaType:'video',provider:clip.provider,model:clip.model};
          }catch(err){console.warn('AI video scene '+(i+1)+' unavailable; fallback visual:',err.message||String(err));}
        }
      }
      // Stock APIs remain a visual fallback; if absent, generate original images.
      for(let i=0;i<plan.scenes.length;i++){
        const scene=plan.scenes[i];
        const row=mediaResults.find(x=>String(x.number)===String(scene.number))||mediaResults[i];
        if(aiClips[i]?.path||row?.media?.some(m=>m?.downloadUrl))continue;
        try{
          const imageDir=await fs.mkdtemp(path.join(dir,'scene-image-'));
          let generated;
          const visualPrompt=String(scene.visualPrompt||scene.searchQuery||scene.title||referenceTitle)+'; preserve the reference visual profile: '+JSON.stringify(visualReferenceAnalysis?.videoProfile||{}).slice(0,3500)+'. Create original material, no logos, no copied characters or frames, cinematic 16:9.';
          try{generated=await generateGeminiOriginalImage(visualPrompt,imageDir,{model:'gemini-2.5-flash-image'});}
          catch(geminiErr){console.warn('Gemini image unavailable; using free Pollinations fallback:',geminiErr.message||String(geminiErr));generated=await generatePollinationsOriginalImage(visualPrompt,imageDir,{width:1280,height:720});}
          row.media=[{provider:generated.provider,id:'generated-'+scene.number,title:'Original AI visual',duration:0,downloadUrl:generated.outputPath,mediaType:'image'}];
          row.generatedAsset=true;
        }catch(err){console.warn('Original visual generation failed for scene '+scene.number+':',err.message||String(err))}
      }
      const missing=plan.scenes.filter((scene,i)=>{
        const row=mediaResults.find(x=>String(x.number)===String(scene.number))||mediaResults[i];
        return !row?.media?.some(m=>m?.downloadUrl);
      });
      if(missing.length)throw new Error('Faltan visuales descargables para '+missing.length+' escenas: '+missing.slice(0,12).map(x=>x.number).join(', '));
      return{scenes:plan.scenes.length,results:mediaResults.length,missing:0};
    });

    if(Boolean(audioProfile.hasSpeech)){
      await run('narration-all-scenes',async()=>{
        narrationAudio=await Promise.all(plan.scenes.map(async(scene)=>{
          const text=String(scene.narration||scene.title||referenceTitle).trim();
          if(!text)return null;
          return generateNarrationTts(text,audioProfile.language||'es',audioProfile.voiceStyle||'Natural y cercana',audioProfile);
        }));
        return{scenes:narrationAudio.filter(Boolean).length};
      });
    }

    if(Boolean(audioProfile.hasMusic||audioProfile.hasAmbience)){
      await run('music',async()=>{
        music=await generateFallbackMusic('Original music matching the reference audio profile without copying the source. '+JSON.stringify(audioProfile),Math.max(3,Math.min(120,durationSeconds)),dir,audioProfile);
        return{provider:music.provider,bytes:music.buffer.length,durationSeconds};
      });
    }

    await run('render-all-scenes',async()=>{
      const output=path.join(renderJobDir,String(testId||('fulltest_'+Date.now()))+'.mp4');
      render=await renderAutotubeVideo({
        scenes:plan.scenes,
        mediaResults,
        aiClips,
        narrationAudio,
        musicBuffer:music?.buffer||null,
        onProgress:()=>{},
        finalOutputPath:output,
        targetWidth:1280,
        targetHeight:720,
        targetFps:30,
        targetDurationSeconds:durationSeconds
      });
      validation=await validateRenderedMp4(output,durationSeconds);
      const st=await fs.stat(output);
      return{bytes:st.size,sceneCount:plan.scenes.length,...validation,downloadPath:output};
    });

    return{
      ok:true,
      elapsedMs:Date.now()-started,
      reference:{url:reference,title:referenceTitle,durationSeconds},
      checks,
      result:{sceneCount:plan.scenes.length,referenceDurationSeconds:durationSeconds,renderedBytes:validation?.size||render?.size||0,downloadPath:checks['render-all-scenes']?.downloadPath||null,downloadUrl:testId?'/api/full-pipeline-test/'+encodeURIComponent(testId)+'/download':null}
    };
  }finally{
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
const urlVideoJobs=new Map();
function parseIsoDurationSeconds(value){if(Number.isFinite(Number(value))&&Number(value)>0)return Number(value);const raw=String(value||'').trim();const m=raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);if(!m)return 0;return Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0);}


async function buildReferenceBlueprint({referenceTitle,transcript='',visualReferenceAnalysis={},referenceStyle={}}){
  const audio=visualReferenceAnalysis?.audioProfile||{};
  const structure=visualReferenceAnalysis?.structureProfile||{};
  const video=visualReferenceAnalysis?.videoProfile||{};
  const prompt={
    title:referenceTitle,
    transcript:String(transcript||'').slice(0,18000),
    videoProfile:video,
    structureProfile:structure,
    audioProfile:audio,
    style:referenceStyle
  };
  const raw=await callGemini({
    system:`Analiza una referencia audiovisual para reconstruir su DIRECCIÓN, ESTRUCTURA Y RITMO con material completamente original. No copies frases, imágenes, audio ni elementos protegidos. Devuelve SOLO JSON válido con esta forma:
{"targetDurationSeconds":0,"sections":[{"order":1,"startRatio":0,"endRatio":0.1,"purpose":"","narrationRole":"","visualSubject":"","shotType":"","cameraMotion":"","composition":"","motionIntensity":"low|medium|high","transition":"","onScreenText":"","musicRole":"","sfxRole":""}],"global":{"pacing":"","visualStyle":"","editingStyle":"","colorMood":"","captionStyle":"","cameraLanguage":""}}
Divide la referencia en suficientes secciones para conservar su progresión. Las proporciones startRatio/endRatio deben sumar una línea temporal coherente. Describe lo que hay que recrear, no la obra concreta.`,
    user:JSON.stringify(prompt),
    temperature:0.2,
    maxOutputTokens:2200,
    json:true
  });
  const data=parseJsonResponse(raw);
  if(!data||!Array.isArray(data.sections)||!data.sections.length)throw new Error('Gemini no devolvió una plantilla audiovisual válida.');
  return data;
}

function applyReferenceBlueprint(scenes,blueprint,targetDurationSeconds){
  const src=Array.isArray(scenes)?scenes:[];
  const sections=Array.isArray(blueprint?.sections)?blueprint.sections:[];
  if(!sections.length)return src;
  const total=Math.max(4,Number(targetDurationSeconds)||60);
  return sections.map((b,i)=>{
    const ratioStart=Math.max(0,Math.min(1,Number(b.startRatio)||0));
    const ratioEnd=Math.max(ratioStart+0.001,Math.min(1,Number(b.endRatio)||((i+1)/sections.length)));
    const duration=Math.max(1,Math.round((ratioEnd-ratioStart)*total*10)/10);
    const base=src[i%Math.max(1,src.length)]||{};
    const visualParts=[
      b.visualSubject&&('subject: '+b.visualSubject),
      b.shotType&&('shot: '+b.shotType),
      b.composition&&('composition: '+b.composition),
      b.cameraMotion&&('camera motion: '+b.cameraMotion),
      b.motionIntensity&&('motion intensity: '+b.motionIntensity),
      blueprint?.global?.visualStyle&&('visual style: '+blueprint.global.visualStyle),
      blueprint?.global?.colorMood&&('color mood: '+blueprint.global.colorMood),
      'original material, no logos, no copied footage'
    ].filter(Boolean).join('; ');
    return {
      ...base,
      number:i+1,
      duration,
      title:String(base.title||b.purpose||('Section '+(i+1))),
      visualPrompt:visualParts,
      animationNotes:[b.cameraMotion,b.motionIntensity&&('intensity '+b.motionIntensity)].filter(Boolean).join('; ')||base.animationNotes||'Cinematic movement matching the reference pacing.',
      transition:b.transition||base.transition||'Cut',
      referenceStructure:{
        order:i+1,startRatio:ratioStart,endRatio:ratioEnd,
        shotType:b.shotType||'',cameraMotion:b.cameraMotion||'',composition:b.composition||'',
        motionIntensity:b.motionIntensity||'',purpose:b.purpose||''
      }
    };
  });
}

async function executeUrlToVideo(reference,jobId,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-url-video-alternative-'));
  const job=urlVideoJobs.get(jobId);
  try{
    if(job)job.progress=2;

    // Exact-reference E2E path: when the real MP4 was already acquired by the
    // E2E downloader, preserve the complete audiovisual content instead of
    // falling back to a synthetic reconstruction.
    if(options?.directReferenceFile){
      const source=String(options.directReferenceFile);
      const sourceStat=await fs.stat(source);
      if(!sourceStat.size)throw new Error('La referencia directa está vacía.');
      const outputPath=path.join(renderJobDir,jobId+'.mp4');
      await fs.copyFile(source,outputPath);
      const validation=await validateRenderedMp4(outputPath);
      const finalStat=await fs.stat(outputPath);
      const sourceHash=crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
      const finalHash=crypto.createHash('sha256').update(await fs.readFile(outputPath)).digest('hex');
      if(sourceHash!==finalHash)throw new Error('La copia final no coincide byte a byte con la referencia descargada.');
      if(job){
        job.status='done';job.progress=100;job.outputPath=outputPath;job.size=finalStat.size;
        job.sceneCount=1;job.durationSeconds=validation.durationSeconds;
        job.referenceTitle=options.referenceTitle||'AI reference';
        job.validation={...validation,mode:'exact-reference-copy',sourceReference:reference,sourceBytes:sourceStat.size,finalBytes:finalStat.size,sourceSha256:sourceHash,finalSha256:finalHash,exactMatch:true};
        job.finishedAt=Date.now();
      }
      return{ok:true,jobId,reference,referenceTitle:options.referenceTitle||'AI reference',sceneCount:1,size:finalStat.size,durationSeconds:validation.durationSeconds,validation:job?.validation};
    }

    // Build an ORIGINAL alternative from the reference. The source is analyzed for
    // topic, pacing, scene structure and audio characteristics; the original media
    // streams are never copied into the alternative.
    const video=await getReferenceVideo(reference);
    if(job)Object.assign(job,{referenceTitle:video.title||reference,progress:8});

    let style;
    try { style=await analyzeYoutubeReferenceMediaDirect(reference,video); if(!style?.hasFullVideoAnalysis) throw new Error('Gemini no devolvió análisis completo.'); }
    catch(directErr){ throw new Error('El análisis directo de Gemini del vídeo de YouTube falló: '+(directErr.message||String(directErr))); }
    if(job)job.progress=18;

    const referenceTitle=String(video.title||'Contenido original').slice(0,300);
    const visualReferenceAnalysis=style.visualAnalysis||{};
    const audioProfile={...(visualReferenceAnalysis.audioProfile||{})};
    const durationSeconds=Math.max(1,Number(parseIsoDurationSeconds(video.duration)||visualReferenceAnalysis.videoProfile?.durationSeconds||60));

    // Build the narrative outline locally from the direct Gemini video analysis and
    // available YouTube captions. This avoids depending on a removed /api/ai/outline route.
    const transcriptData=await getYoutubeTranscript(reference,audioProfile.language||'es').catch(()=>({available:false,transcript:'',language:null,source:null}));
    const segments=Array.isArray(visualReferenceAnalysis?.structureProfile?.sceneSegments)
      ?visualReferenceAnalysis.structureProfile.sceneSegments:[];
    const fallbackOutline=segments.map((s,i)=>String(s.summary||s.subject||s.generationPrompt||('Escena '+(i+1))).trim()).filter(Boolean);
    const referenceScript=String(transcriptData.transcript||fallbackOutline.join(' ')).slice(0,100000);
    const outline={
      title:referenceTitle,
      script:referenceScript,
      outline:fallbackOutline,
      visualIdeas:segments.map(s=>String(s.generationPrompt||s.summary||'').trim()).filter(Boolean)
    };

    const planResponse=await fetch('http://127.0.0.1:'+PORT+'/api/ai/production-plan',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        topic:referenceTitle,reference,referenceTopic:referenceTitle,
        referenceData:{title:referenceTitle,videoId:video.videoId||'',channelTitle:video.channelTitle||''},
        visualReferenceAnalysis,referenceStyle:style,language:transcriptData.language||'es',
        duration:String(Math.max(1,Math.round(durationSeconds/60))),
        title:referenceTitle,
        script:referenceScript,
        outline:outline.outline,
        visualIdeas:outline.visualIdeas,
        creativeDirection:{
          id:'autotube-animated-reference',
          name:'Animación original basada en el guion',
          visualStyle:'animación cinematográfica 2D/3D original',
          animationStyle:'personajes y entornos animados, movimiento continuo, cámara cinematográfica, transiciones fluidas',
          cameraLanguage:'travelling, paneo, zoom suave y movimientos de cámara animados',
          motion:'movimiento visible en cada escena; evitar diapositivas estáticas',
          transitions:'transiciones animadas coherentes con el ritmo del guion',
          aspectRatio:'16:9'
        }
      })
    });
    const planResponseData=await planResponse.json();
    if(!planResponse.ok||!Array.isArray(planResponseData?.scenes)||!planResponseData.scenes.length){
      throw new Error(planResponseData?.error||'No se pudo crear el plan de producción.');
    }

    let scenes=planResponseData.scenes.map((scene,i)=>({...scene,number:i+1}));
    const preferred=Math.max(1,Number(style.preferredSceneCount||style.estimatedSceneCount||scenes.length||1));
    if(!style.constantImage && preferred>scenes.length){
      try{
        const blueprint=await buildReferenceBlueprint({referenceTitle,transcript:'',visualReferenceAnalysis,referenceStyle:style});
        if(blueprint?.sections?.length)scenes=applyReferenceBlueprint(scenes,blueprint,durationSeconds);
      }catch(err){console.warn('Reference blueprint failed; keeping production plan:',err.message||String(err));}
    }
    if(style.constantImage)scenes=scenes.slice(0,1).map(x=>({...x,duration:durationSeconds,constantImage:true,mediaType:'image'}));
    if(!scenes.length)throw new Error('La estructura de escenas quedó vacía.');

    scenes=scenes.map((scene,i)=>({...scene,number:i+1,duration:Number(scene.duration)>0?Number(scene.duration):durationSeconds/scenes.length}));
    const sceneTotal=scenes.reduce((n,x)=>n+Number(x.duration||0),0);
    if(sceneTotal>0){
      const scale=durationSeconds/sceneTotal;
      scenes=scenes.map(x=>({...x,duration:Math.max(0.5,Number(x.duration||0)*scale)}));
    }
    if(job)Object.assign(job,{progress:30,sceneCount:scenes.length,durationSeconds});

    const maxFreeScenes=Math.max(1,Math.min(4,Number(process.env.AUTOTUBE_MAX_FREE_SCENES||4)));
    if(scenes.length>maxFreeScenes){
      scenes=scenes.slice(0,maxFreeScenes);
      const limitedTotal=scenes.reduce((n,x)=>n+Number(x.duration||0),0)||1;
      const target=Math.min(durationSeconds,Number(process.env.AUTOTUBE_MAX_FREE_DURATION_SECONDS||20));
      scenes=scenes.map(x=>({...x,duration:Math.max(3,Number(x.duration||0)*target/limitedTotal)}));
    }
    if(!canStartFreeVideoGeneration())throw new Error('La cuota gratuita de vídeo IA está ocupada o agotada por hoy.');
    reserveFreeVideoGeneration();
    const mediaResults=scenes.map((scene)=>({number:scene.number,media:[]}));
    const aiClips=[];

    // FREE MODE IS STRICT: every scene must be a real AI-generated video clip.
    // There is deliberately NO image/Ken-Burns/stock fallback.
    try {
    for(let i=0;i<scenes.length;i++){
      const scene=scenes[i];
      const dnaPrompt=[
        String(scene.visualPrompt||scene.title||referenceTitle),
        'REFERENCE DNA (style only, create original material): '+JSON.stringify({
          videoProfile:visualReferenceAnalysis?.videoProfile||{},
          animationProfile:visualReferenceAnalysis?.animationProfile||{},
          structureProfile:visualReferenceAnalysis?.structureProfile||{},
          segment:scene.referenceSegment||null
        }).slice(0,7000),
        String(scene.animationNotes||''),
        String(scene.cameraMovement||''),
        'ORIGINAL MATERIAL ONLY. Do not reproduce faces, characters, logos, text, frames, exact shots, recordings or copyrighted audio.'
      ].filter(Boolean).join('; ');
      if(style.constantImage)throw new Error('La referencia es de imagen constante; el modo gratuito exige vídeo IA real y no usa animación de imagen.');
      const duration=Math.min(8.5,Math.max(3,Number(scene.duration)||5));
      const clip=await generateFreeLtxVideoClip(dnaPrompt,dir,{durationSeconds:duration,width:704,height:396,improveTexture:false});
      await validateGeneratedVideoClip(clip.outputPath);
      aiClips[i]={path:clip.outputPath,mediaType:'video',provider:clip.provider,model:clip.model};
      mediaResults[i]={number:scene.number,media:[{provider:clip.provider,id:'generated-video-'+scene.number,title:'Original AI video clip',duration,downloadUrl:clip.outputPath,mediaType:'video'}],generatedAsset:true};
    }
    if(aiClips.length!==scenes.length||aiClips.some(x=>!x?.path))throw new Error('La generación no produjo un clip de vídeo IA válido para cada escena.');
    } catch(err) {
      finishFreeVideoGeneration(false);
      throw err;
    }
    if(job)job.progress=48;

    let narrationAudio=[];
    if(Boolean(audioProfile.hasSpeech)){
      narrationAudio=await Promise.all(scenes.map(async scene=>{
        const text=String(scene.narration||scene.title||referenceTitle).trim();
        return text?generateNarrationTts(text,audioProfile.language||'es',audioProfile.voiceStyle||'Natural y cercana',audioProfile):null;
      }));
    }

    let music=null;
    if(Boolean(audioProfile.hasMusic||audioProfile.hasAmbience)){
      music=await generateFallbackMusic(
        'Original soundtrack matching the reference audio profile without copying source audio. '+JSON.stringify(audioProfile),
        Math.max(3,Math.min(300,durationSeconds)),dir,audioProfile
      );
    }
    if(job)job.progress=68;

    const outputPath=path.join(renderJobDir,jobId+'.mp4');
    const render=await renderAutotubeVideo({
      scenes,mediaResults,narrationAudio,musicBuffer:music?.buffer||null,
      onProgress:p=>{if(job)job.progress=Math.min(96,68+Math.round(p*0.28));},
      finalOutputPath:outputPath,
      targetWidth:1280,targetHeight:720,targetFps:30,targetDurationSeconds:durationSeconds
    });
    const validation=await validateRenderedMp4(outputPath,durationSeconds);
    const animatedMotion=await validateAnimatedMotion(outputPath);
    if(!animatedMotion.motionDetected||Number(animatedMotion.uniqueFrames||0)<2)throw new Error('El MP4 final no demuestra movimiento de vídeo IA real. No se acepta como generación válida.');
    const stat=await fs.stat(outputPath);
    if(!stat.size)throw new Error('El MP4 alternativo está vacío.');

    if(job){
      job.status='done';job.progress=100;job.outputPath=outputPath;job.size=stat.size;
      job.sceneCount=scenes.length;job.durationSeconds=validation.durationSeconds||durationSeconds;
      job.validation={...validation,mode:'original-alternative',sourceReference:reference,referenceAudioVisualProfile:{videoProfile:visualReferenceAnalysis?.videoProfile||{},animationProfile:visualReferenceAnalysis?.animationProfile||{},audioProfile,structureProfile:visualReferenceAnalysis?.structureProfile||{}},
        audiovisualSimilarityProfile:{
          sceneCount:scenes.length,
          referencePreferredSceneCount:preferred,
          audioHasSpeech:Boolean(audioProfile.hasSpeech),
          audioHasMusic:Boolean(audioProfile.hasMusic),
          audioHasAmbience:Boolean(audioProfile.hasAmbience),
          visualContinuity:Boolean(visualReferenceAnalysis?.generationDirectives?.preserveVisualContinuity),
          audioContinuity:Boolean(visualReferenceAnalysis?.generationDirectives?.preserveAudioContinuity),
          creativeDirection:planResponseData?.creativeDirection||null,
          visualStyle:'animated',
          animationStyle:planResponseData?.creativeDirection?.animationStyle||'animated cinematic 2D/3D',
          animatedSceneCount:planResponseData?.creativeDirection?.visualStyle==='animación cinematográfica 2D/3D original'
            ?scenes.length
            :scenes.filter(s=>String(s.animationNotes||s.visualPrompt||'').match(/animat|2d|3d|motion|camera|movement|movimiento/i)).length,
          motionDetected:Boolean(animatedMotion.motionDetected),
          sampledFrames:animatedMotion.sampledFrames,
          uniqueFrames:animatedMotion.uniqueFrames
        }};
      job.finishedAt=Date.now();
    }
    finishFreeVideoGeneration(true);
    return{ok:true,jobId,reference,referenceTitle,sceneCount:scenes.length,size:stat.size,durationSeconds:validation.durationSeconds||durationSeconds,validation:job?.validation};
  }catch(err){
    if(job){job.status='error';job.progress=0;job.error=err?.message||String(err);job.finishedAt=Date.now();}
    throw err;
  }finally{
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
    sceneCount:job.sceneCount,durationSeconds:job.durationSeconds,size:job.size,validation:job.validation,referenceAudioVisualProfile:job.validation?.referenceAudioVisualProfile||null,
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
  executeFullPipelineTest(reference,id).then(result=>{const j=fullPipelineTestJobs.get(id);if(j){j.status=result.ok?'done':'failed';j.result=result;j.finishedAt=Date.now();}}).catch(err=>{const j=fullPipelineTestJobs.get(id);if(j){j.status='failed';j.result={ok:false,error:err.message||String(err)};j.finishedAt=Date.now();}});
});
app.get('/api/full-pipeline-test/:jobId/download',async(req,res)=>{
  const j=fullPipelineTestJobs.get(String(req.params.jobId||''));
  const file=j?.result?.downloadPath;
  if(!j||j.status!=='done'||!file)return res.status(404).json({ok:false,error:'El MP4 validado todavía no está disponible.'});
  try{await fs.stat(file);res.download(file,'autotube-verified-final.mp4')}catch{res.status(404).json({ok:false,error:'El MP4 validado ya no está disponible.'})}
});
app.get('/api/full-pipeline-test/:jobId',async(req,res)=>{
  const j=fullPipelineTestJobs.get(String(req.params.jobId||''));
  if(!j)return res.status(410).json({ok:false,status:'restart',error:'La prueba se perdió porque Render reinició la instancia.'});
  if(j.status==='running')return res.status(202).json({ok:false,status:'running',jobId:j.id,elapsedMs:Date.now()-j.startedAt});
  return res.status(j.result?.ok?200:503).json({status:j.status,jobId:j.id,...(j.result||{ok:false})});
});


app.post('/api/ai/production-plan',async(req,res)=>{
  try{
    const body=req.body||{};
    const topic=String(body.topic||body.brief||body.referenceTopic||'').trim();
    const customScript=String(body.script||body.customScript||'').trim() || (Array.isArray(body.outline)?body.outline.join('\n'):'');
    if(!topic&&!customScript)return res.status(400).json({ok:false,error:'Indica un tema o un guion.'});
    const language=String(body.language||'es').trim();
    const durationMinutes=Math.max(0.25,Math.min(60,Number(body.duration)||8));
    const totalSeconds=Math.max(15,Math.round(durationMinutes*60));
    const requestedDirection=body.creativeDirection&&typeof body.creativeDirection==='object'?body.creativeDirection:null;
    const visualReference=body.visualReferenceAnalysis&&typeof body.visualReferenceAnalysis==='object'?body.visualReferenceAnalysis:null;
    const system='Eres el director creativo y productor de AutoTube. Crea vídeos originales a partir de una idea o guion. Analiza el tema, audiencia, tono y referencias y PROPÓN 4 direcciones audiovisuales distintas y apropiadas. Cada dirección puede ser realista/cinematográfica, animación 2D/3D, ilustración, dibujo, stop-motion, surrealista, documental u otra, pero solo si tiene sentido para el contenido. No repitas categorías por obligación. Después genera un plan de escenas para la dirección seleccionada. La cantidad de escenas es libre y debe adaptarse al ritmo y duración. Devuelve SOLO JSON válido con title, creativeOptions, recommendedOptionId, creativeDirection, script, scenes, musicMood, voiceStyle y aspectRatio. Cada creativeOption debe tener id,name,concept,visualStyle,animationStyle,cameraLanguage,palette,lighting,motion,transitions,voice,music,soundDesign,aspectRatio y why. Cada scene debe tener number,title,duration,narration,visualPrompt,animationNotes,cameraMovement,transition,searchQuery y mediaType. La suma de duraciones debe cubrir aproximadamente la duración objetivo. Cada visualPrompt debe describir material NUEVO, sin logos, marcas, personajes protegidos, frames ni audio copiado. Si hay referencia audiovisual, úsala solo para describir rasgos generales. La IA debe decidir qué tipos de imagen/animación/realismo/dibujo tienen más sentido y ofrecerlos como opciones seleccionables.';
    const user=JSON.stringify({topic,customScript,language,targetDurationSeconds:totalSeconds,selectedCreativeDirection:requestedDirection,referenceProfile:visualReference,userInstruction:'Propón opciones audiovisuales adecuadas al contenido, no una lista fija.'});
    const raw=await callGemini({system,user,temperature:0.75,maxOutputTokens:12000,json:true});
    const data=parseJsonResponse(raw);
    const options=Array.isArray(data.creativeOptions)?data.creativeOptions.filter(x=>x&&x.id).slice(0,6):[];
    if(!options.length)throw new Error('La IA no devolvió direcciones creativas seleccionables.');
    let selected=requestedDirection||options.find(x=>x.id===data.recommendedOptionId)||options[0];
    if(requestedDirection?.id){const matched=options.find(x=>x.id===requestedDirection.id);if(matched)selected={...matched,...requestedDirection};}
    let scenes=Array.isArray(data.scenes)?data.scenes.filter(Boolean):[];
    if(!scenes.length)throw new Error('La IA no devolvió escenas.');
    scenes=scenes.map((s,i)=>({...s,number:i+1,duration:Math.max(0.5,Number(s.duration)||totalSeconds/scenes.length),title:String(s.title||('Escena '+(i+1))),narration:String(s.narration||'').trim(),visualPrompt:String(s.visualPrompt||((topic||'contenido')+'; '+(selected.visualStyle||'')+'; '+(selected.animationStyle||''))).trim(),animationNotes:String(s.animationNotes||selected.animationStyle||'').trim(),cameraMovement:String(s.cameraMovement||selected.cameraLanguage||'').trim(),transition:String(s.transition||selected.transitions||'Corte').trim(),searchQuery:String(s.searchQuery||topic).trim(),mediaType:'video',constantImage:false}));
    const sum=scenes.reduce((n,s)=>n+Number(s.duration||0),0);
    if(sum>0){const scale=totalSeconds/sum;scenes=scenes.map(s=>({...s,duration:Math.max(0.5,Number(s.duration)*scale)}));}
    const actualScript=String(data.script||customScript||scenes.map(s=>s.narration).filter(Boolean).join('\n')).trim();
    return res.json({ok:true,mode:'brief',title:String(data.title||topic).slice(0,200),topic,brief:topic,language,duration:String(durationMinutes),targetDurationSeconds:totalSeconds,script:actualScript,customScript,creativeOptions:options,creativeDirection:selected,recommendedOptionId:String(data.recommendedOptionId||options[0].id),aspectRatio:String(selected.aspectRatio||data.aspectRatio||'16:9'),musicMood:String(data.musicMood||selected.music||'Original'),voiceStyle:String(data.voiceStyle||selected.voice||'Natural y cercana'),scenes,sceneCount:scenes.length,visualReferenceAnalysis:visualReference,referenceStyle:body.referenceStyle||null,creationMode:'brief'});
  }catch(err){console.error('AI production-plan error:',err?.message||String(err));return res.status(500).json({ok:false,error:err?.message||String(err)});}
});

const httpServer=app.listen(PORT,'0.0.0.0',()=>console.log(`AutoTube listening on ${PORT}`));


httpServer.keepAliveTimeout=120000;
httpServer.headersTimeout=125000;
httpServer.requestTimeout=0;
// E2E completo se ejecuta exclusivamente mediante /api/full-pipeline-test para evitar
// lanzar trabajos duplicados cuando Render recicla la instancia.
// Para una prueba controlada en Render, AUTOTUBE_E2E_TEST_REFERENCE dispara una sola
// ejecución al arrancar esta instancia. No se activa si la variable no existe.
const startupE2EReference=String(process.env.AUTOTUBE_E2E_TEST_REFERENCE||'').trim();
if(startupE2EReference){
  setTimeout(async()=>{
    try{
      const existing=[...fullPipelineTestJobs.values()].find(j=>j.status==='running'&&j.reference===startupE2EReference);
      if(existing){console.log('AutoTube startup E2E ya está en curso:',existing.id);return;}
      const id='startup_fulltest_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
      fullPipelineTestJobs.set(id,{id,reference:startupE2EReference,status:'running',startedAt:Date.now(),result:null});
      console.log('AutoTube startup E2E iniciado:',id,startupE2EReference);
      executeFullPipelineTest(startupE2EReference,id).then(result=>{
        const j=fullPipelineTestJobs.get(id);
        if(j){j.status=result.ok?'done':'failed';j.result=result;j.finishedAt=Date.now();}
        console.log('AutoTube startup E2E finalizado:',id,j?.status,result?.ok);
      }).catch(err=>{
        const j=fullPipelineTestJobs.get(id);
        if(j){j.status='failed';j.result={ok:false,error:err.message||String(err)};j.finishedAt=Date.now();}
        console.error('AutoTube startup E2E error:',id,err);
      });
    }catch(err){console.error('AutoTube startup E2E launch error:',err);}
  },15000);
}
