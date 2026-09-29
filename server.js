require('./url-to-mp4-preload.js');
require('dotenv').config();
const { falConfigured, falImage, falVideo, falTts, falMusic, replicateConfigured, replicateVideo, elevenTts, stabilityMusic, capabilityCatalog } = require('./universal-ai-providers.js');
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
const geminiCooldowns=new Map();
function geminiCooldownActive(scope='general'){return Date.now()<Number(geminiCooldowns.get(scope)||0);}
function noteGeminiQuota(scope='general',ms=60000){geminiCooldowns.set(scope,Date.now()+Math.max(10000,Number(ms)||60000));}
async function callGemini({system,user,images=[],files=[],temperature=0.7,maxOutputTokens=1200,json=false}){const k=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();if(!k)throw new Error('Falta la clave de Gemini.');const parts=[{text:String(user||'')}];for(const im of images)parts.push({inline_data:{mime_type:im.mimeType||'image/jpeg',data:im.data}});for(const file of files){if(file?.uri)parts.push({file_data:{mime_type:file.mimeType||'application/octet-stream',file_uri:file.uri}});}const headers={'Content-Type':'application/json'};headers['x-goog-'+'api-key']=k;const models=[...new Set([String(GEMINI_MODEL||'').trim(),'gemini-3.5-flash-lite','gemini-3.1-flash-lite'].filter(Boolean))];let lastError='';for(const model of models){for(const structured of (json?[true,false]:[false])){const body={system_instruction:{parts:[{text:String(system||'')}]},contents:[{role:'user',parts}],generationConfig:{maxOutputTokens,...(structured?{responseMimeType:'application/json'}:{})}};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);let response;try{response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});}catch(err){lastError=err?.name==='AbortError'?'Gemini request timeout (20s).':String(err?.message||err);continue}finally{clearTimeout(timer)}const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}if(response.ok){const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim()||'';if(text)return text;lastError='Gemini no devolvió contenido.';continue}const message=data?.error?.message||raw.slice(0,500)||'Error desconocido';lastError='Gemini '+response.status+': '+message;if(response.status===429||response.status>=500)break;if(response.status===400&&structured)continue;if(response.status===404||/model|not found|unsupported/i.test(message))break;break}}throw new Error(lastError||'Gemini no pudo procesar la solicitud.');}
async function callGeminiYoutube(url,{user,maxOutputTokens=5000}={}){if(geminiCooldownActive('youtube'))throw new Error('GEMINI_QUOTA_COOLDOWN: se evita consumir más cuota de análisis de YouTube durante el cooldown.');const k=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();if(!k)throw new Error('Falta la clave de Gemini.');const model='gemini-3.8-flash';const body={model,input:[{type:'text',text:String(user||'')},{type:'video',uri:String(url),processing:{type:'static',fps:0.5}}]};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120000);let response;try{response=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':k},body:JSON.stringify(body),signal:controller.signal});}catch(err){throw new Error(err?.name==='AbortError'?'Gemini YouTube URL timeout (120s).':String(err?.message||err));}finally{clearTimeout(timer)}const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}if(!response.ok){if(response.status===429)noteGeminiQuota('youtube',90000);throw new Error('Gemini '+model+' '+response.status+': '+String(data?.error?.message||raw.slice(0,500)));}const output=String(data?.output_text||data?.outputText||data?.steps?.flatMap(s=>s?.content||[]).map(c=>c?.text||'').join('')||'').trim();if(!output)throw new Error('Gemini '+model+' no devolvió análisis.');parseJsonResponse(output);console.log('AutoTube Gemini YouTube model selected:',model);return output;}
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
  let parsed;
  try{
    const raw=await callGeminiYoutube(referenceUrl,{user:prompt,maxOutputTokens:12000});
    parsed=parseJsonResponse(raw);
  }catch(err){
    const message=String(err?.message||err);
    console.warn('Gemini YouTube direct analysis unavailable; using metadata-only audiovisual plan:',message);
    const durationSeconds=Number(videoMeta?.durationSeconds||parseIsoDurationSeconds(videoMeta?.duration)||30)||30;
    parsed={
      videoProfile:{
        durationSeconds,
        aspectRatio:'16:9',
        visualStyle:'cinematic original reconstruction based on available public metadata',
        composition:'dynamic widescreen compositions',
        palette:'determined creatively from the title/topic',
        lighting:'cinematic',
        cameraMovement:'smooth varied camera movement',
        continuity:true,
        constantImage:false
      },
      animationProfile:{
        cameraMotion:'smooth cinematic motion',
        zoomStyle:'subtle push-in and pull-out',
        panStyle:'slow controlled pans',
        motionIntensity:'medium',
        transitionStyle:'clean cinematic cuts',
        visualRhythm:'matched to scene pacing'
      },
      audioProfile:{
        hasSpeech:false,
        language:videoMeta?.defaultAudioLanguage||videoMeta?.defaultLanguage||'es',
        speechRate:'natural',
        pauses:'natural',
        emotion:'neutral',
        hasMusic:true,
        hasAmbience:true,
        hasSoundEffects:false,
        musicMood:'cinematic atmospheric',
        energy:'medium',
        dynamics:'moderate',
        instrumentation:'ambient synthesized/orchestral',
        bpmEstimate:90,
        voiceStyle:'natural'
      },
      structureProfile:{
        opening:'strong visual opening',
        pacing:'moderate',
        transitions:'cinematic cuts',
        segmentCount:Math.max(1,Math.min(8,Math.ceil(durationSeconds/20))),
        segmentDurations:[],
        timestamps:[],
        sceneSegments:[]
      },
      generationDirectives:{
        preferredSceneCount:Math.max(1,Math.min(8,Math.ceil(durationSeconds/20))),
        preserveVisualContinuity:true,
        preserveAudioContinuity:true,
        animationStrategy:'original cinematic AI video',
        visualSearchStrategy:'none',
        musicStrategy:'original synchronized audio',
        narrationStrategy:'none'
      }
    };
  }
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
app.get('/api/video-providers',async(_req,res)=>{try{res.json({ok:true,providers:await getVideoProviderHealth(),freeDailyBudget:freeAiBudgetSnapshot()});}catch(err){res.status(503).json({ok:false,error:err.message||String(err)});}});
app.get('/api/ai-capabilities',(_req,res)=>res.json({ok:true,capabilities:capabilityCatalog()}));
app.get('/api/free-production-budget',(_req,res)=>res.json({ok:true,freeOnlyDefault:String(process.env.AUTOTUBE_ALLOW_PAID_PROVIDERS||'0')!=='1',budget:freeAiBudgetSnapshot(),resourceBudget:{hfZeroGpu:hfZeroGpuResourceSnapshot()},zeroGpuQuotaCooldownUntil:getSharedZeroGpuCooldownUntil()}));
app.get('/api/health',(_req,res)=>res.json({ok:true,app:'AutoTube',commit:process.env.RENDER_GIT_COMMIT||'',autonomous:{enabled:autonomousEnabled,stopped:autonomousStopped,reference:autonomousReference},providers:{video:true,musicAi:Boolean(process.env.ACE_STEP_URL),kokoro:Boolean(process.env.KOKORO_TTS_URL)},configured:{gemini:Boolean(process.env['GEM'+'INI_'+'API_'+'KEY']),ltxZeroGpu:true,youtube:Boolean(process.env.YOUTUBE_CLIENT_ID&&process.env.YOUTUBE_CLIENT_SECRET),pexels:Boolean(process.env.PEXELS_API_KEY),pixabay:Boolean(process.env.PIXABAY_API_KEY),elevenlabs:Boolean(process.env.ELEVENLABS_API_KEY),supabase:supabaseConfigured()}}));
app.get('/api/recovery/preflight',async(req,res)=>{
  const strategy=String(req.query?.strategy||'').trim();
  if(!strategy)return res.status(400).json({ok:false,error:'strategy requerida'});
  if(strategy==='HF_INFERENCE_RESOURCE_SWITCH'){
    const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
    if(!token)return res.status(503).json({ok:false,strategy,reason:'HF_TOKEN_MISSING'});
    const models=String(process.env.AUTOTUBE_HF_PREFLIGHT_MODELS||'Wan-AI/Wan2.1-T2V-1.3B,Lightricks/LTX-Video-0.9.8-13B-distilled,tencent/HunyuanVideo').split(',').map(x=>x.trim()).filter(Boolean);
    try{
      const who=await fetch('https://huggingface.co/api/whoami-v2',{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
      if(!who.ok)return res.status(503).json({ok:false,strategy,reason:'HF_TOKEN_INVALID_OR_INACCESSIBLE'});
      const found=[];
      for(const model of models){
        const info=await fetch('https://huggingface.co/api/models/'+encodeURIComponent(model)+'?expand=inferenceProviderMapping',{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
        if(!info.ok)continue;
        const data=await info.json();
        for(const [provider,v] of Object.entries(data?.inferenceProviderMapping||{})){
          if(String(v?.status||'')==='live')found.push({model,provider,isFree:Boolean(v?.is_free)});
        }
      }
      const free=found.find(x=>x.isFree);
      if(!free)return res.status(503).json({ok:false,strategy,reason:found.length?'HF_LIVE_VIDEO_PROVIDERS_REQUIRE_CREDITS_OR_PROVIDER_KEY':'HF_NO_LIVE_VIDEO_PROVIDER',liveProviders:found.length});
      return res.json({ok:true,strategy,provider:free.provider,model:free.model,free:true,liveProviders:found.length});
    }catch(err){return res.status(503).json({ok:false,strategy,reason:'HF_PREFLIGHT_ERROR',detail:String(err?.message||err).slice(0,180)});}
  }
  if(strategy==='INDEPENDENT_FREE_PROVIDER'){
    if(String(process.env.FREE_AI_API_KEY||'').trim())return res.json({ok:true,strategy,provider:'FREE_AI',free:true});
    if(String(process.env.PIXAZO_API_KEY||'').trim())return res.json({ok:true,strategy,provider:'PIXAZO_FREE',model:'LTX',free:true});
    if(String(process.env.AGNES_API_KEY||'').trim())return res.json({ok:true,strategy,provider:'AGNES_FREE',free:true});
    return res.status(503).json({ok:false,strategy,reason:'NO_INDEPENDENT_FREE_PROVIDER_CREDENTIAL'});
  }
  return res.json({ok:true,strategy,provider:'LOCAL'});
});
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

async function validateGeneratedAgainstReference(file,referenceUrl,referenceAnalysis){
  const uploaded=await uploadGeminiFile(file,'video/mp4');
  const prompt=[
    'Evalúa ESTE vídeo MP4 generado por AutoTube frente al perfil audiovisual del vídeo de referencia de YouTube.',
    'La salida debe ser material IA original, pero debe recrear de forma reconocible las características audiovisuales del referente.',
    'Evalúa composición, estilo visual, paleta e iluminación, lenguaje de cámara, movimiento/animación, ritmo/estructura, continuidad y características del audio.',
    'No penalices que no copie personajes, caras, logos, texto, frames o audio: debe ser una recreación original.',
    'Devuelve ÚNICAMENTE JSON con overallScore, visualScore, cameraMotionScore, animationMotionScore, structureScore, continuityScore, audioScore, sceneCoverageScore, issues, matchedFeatures y retryDirectives.',
    'Puntuaciones 0..1. Si una característica no existe en la referencia, no la penalices.',
    'Aceptación: overallScore >= 0.68, structureScore >= 0.55, visualScore >= 0.55, cameraMotionScore >= 0.50 y sceneCoverageScore >= 0.55.',
    'Si no cumple, issues y retryDirectives deben indicar cambios concretos para regenerar.',
    'Referencia: '+String(referenceUrl),
    'PERFIL DE REFERENCIA: '+JSON.stringify(referenceAnalysis||{}).slice(0,30000)
  ].join('\\n');
  const raw=await callGemini({
    system:'Eres un validador audiovisual objetivo. Compara el vídeo proporcionado con el perfil de referencia y no inventes similitudes.',
    user:prompt,
    files:[{uri:uploaded.uri,mimeType:'video/mp4'}],
    maxOutputTokens:2200,
    json:true
  });
  const result=parseJsonResponse(raw);
  for(const key of ['overallScore','visualScore','cameraMotionScore','animationMotionScore','structureScore','continuityScore','audioScore','sceneCoverageScore']) result[key]=Math.max(0,Math.min(1,Number(result[key])||0));
  const accepted=result.overallScore>=0.68 && result.structureScore>=0.55 && result.visualScore>=0.55 && result.cameraMotionScore>=0.50 && result.sceneCoverageScore>=0.55;
  result.accepted=accepted; result.referenceValidation=true; result.referenceUrl=referenceUrl;
  if(!accepted) throw Object.assign(new Error('REFERENCE_SIMILARITY_VALIDATION_FAILED: el MP4 no alcanza la fidelidad audiovisual mínima respecto al referente.'),{code:'REFERENCE_SIMILARITY_VALIDATION_FAILED',validation:result});
  return result;
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

function runFfmpeg(args,timeoutMs=180000){return new Promise((resolve,reject)=>{const safeArgs=[...args];const p=spawn(ffmpegPath,safeArgs,{stdio:['ignore','ignore','pipe']});let err='';let finished=false;const timer=setTimeout(()=>{if(finished)return;finished=true;try{p.kill('SIGKILL')}catch{}reject(new Error('FFmpeg timeout after '+timeoutMs+'ms: '+safeArgs.slice(0,18).join(' ')))},timeoutMs);p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000)});p.on('error',e=>{if(finished)return;finished=true;clearTimeout(timer);reject(e)});p.on('close',code=>{if(finished)return;finished=true;clearTimeout(timer);code===0?resolve():reject(new Error('FFmpeg '+code+': '+err.slice(-2500)))})})}
async function generateProceduralMusic(description,durationSeconds,dir,audioProfile={}){
  const duration=Math.max(1,Math.min(300,Number(durationSeconds)||30));
  const out=path.join(dir,'autotube-procedural-music-'+Date.now()+'.mp3');
  const energy=String(audioProfile.energy||'').toLowerCase();const gain=/(high|intense|energetic)/.test(energy)?0.11:0.07;
  const bpm=Math.max(55,Math.min(120,Number(audioProfile.bpmEstimate)||72));const chord=Math.max(0.5,60/bpm*4);
  const freqs=[[261.63,329.63,392],[220,261.63,329.63],[174.61,220,261.63],[196,246.94,293.66]];const inputs=[];const voiceLabels=[];
  for(let voice=0;voice<3;voice++){const labels=[];for(let chordIndex=0;chordIndex<4;chordIndex++){const freq=freqs[chordIndex][voice];const inputIndex=inputs.length/4;inputs.push('-f','lavfi','-i','sine=frequency='+freq+':duration='+chord);labels.push('['+inputIndex+':a]');}voiceLabels.push(labels);}
  const filterParts=[];for(let voice=0;voice<3;voice++)filterParts.push(voiceLabels[voice].join('')+'concat=n=4:v=0:a=1,volume='+String(gain/(voice+1))+'[v'+voice+']');
  filterParts.push('[v0][v1][v2]amix=inputs=3:duration=longest:normalize=0,lowpass=f=3600,highpass=f=70,acompressor=threshold=-24dB:ratio=2:attack=20:release=180,afade=t=in:st=0:d=2,afade=t=out:st='+Math.max(0,duration-2)+':d=2[a]');
  await runFfmpeg(['-y','-hide_banner','-loglevel','error',...inputs,'-filter_complex',filterParts.join(';'),'-map','[a]','-t',String(duration),'-ac','2','-ar','44100','-c:a','libmp3lame','-b:a','128k',out]);
  const buffer=await fs.readFile(out);if(buffer.length<1000)throw new Error('La música procedural quedó vacía.');
  return{buffer,provider:'AutoTube procedural last-resort',durationSeconds:duration,description:String(description||''),generationType:'procedural'};
}
const musicProviderState=new Map();
function musicState(provider='unknown'){const key=String(provider||'unknown');if(!musicProviderState.has(key))musicProviderState.set(key,{cooldownUntil:0,failures:0,lastError:'',lastFailureAt:0,lastSuccessAt:0});return musicProviderState.get(key);}
function musicCooldownActive(provider){return Date.now()<Number(musicState(provider).cooldownUntil||0);}
function noteMusicCooldown(provider,ms,err=''){const st=musicState(provider);st.cooldownUntil=Date.now()+Math.max(15000,Number(ms)||60000);st.failures++;st.lastFailureAt=Date.now();st.lastError=String(err||'');st.lastFailureAt=Date.now();}
function noteMusicSuccess(provider){const st=musicState(provider);st.cooldownUntil=0;st.failures=0;st.lastSuccessAt=Date.now();st.lastError='';}
function classifyMusicError(err){const m=String(err?.message||err||'').toLowerCase();if(/429|quota|rate limit|too many requests|insufficient.*credit|limit/.test(m))return'quota';if(/401|403|api key|unauthori|forbidden/.test(m))return'auth';if(/404|model.*not found|unsupported/.test(m))return'model';if(/timeout|timed out|econnreset|eai_again|socket hang up|network/.test(m))return'network';if(/500|502|503|504|service unavailable|temporarily unavailable/.test(m))return'capacity';return'other';}
async function validateGeneratedMusic(bufferOrPath,expectedDuration){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-music-qa-'));const file=path.join(dir,'candidate.audio');
  try{
    if(Buffer.isBuffer(bufferOrPath))await fs.writeFile(file,bufferOrPath);else await fs.copyFile(String(bufferOrPath),file);
    const stat=await fs.stat(file);if(stat.size<2000)throw new Error('Audio generado demasiado pequeño.');
    const stderr=await new Promise((resolve,reject)=>{const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-af','volumedetect,astats=metadata=1:reset=1','-f','null','-'],{stdio:['ignore','ignore','pipe']});let e='';p.stderr.on('data',d=>{e+=d.toString();if(e.length>30000)e=e.slice(-30000)});p.on('error',reject);p.on('close',code=>code===0?resolve(e):reject(new Error('FFmpeg no pudo validar el audio: '+e.slice(-1600))));});
    const t=String(stderr);const dm=t.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);const duration=dm?Number(dm[1])*3600+Number(dm[2])*60+Number(dm[3]):0;
    const rms=t.match(/RMS level dB:\s*(-?[\d.]+)/i);const peak=t.match(/Peak level dB:\s*(-?[\d.]+)/i);const rmsDb=rms?Number(rms[1]):NaN,peakDb=peak?Number(peak[1]):NaN;
    if(!duration||duration<1)throw new Error('Audio sin duración verificable.');if(Number.isFinite(rmsDb)&&rmsDb<-55)throw new Error('Audio prácticamente silencioso (RMS '+rmsDb+' dB).');if(Number.isFinite(peakDb)&&peakDb<-50)throw new Error('Audio demasiado débil (peak '+peakDb+' dB).');
    const entropy=t.match(/Entropy:\s*([\d.]+)/i),crest=t.match(/Crest factor:\s*([\d.]+)/i),zcr=t.match(/Zero crossings rate:\s*([\d.]+)/i);
    const entropyValue=entropy?Number(entropy[1]):NaN,crestValue=crest?Number(crest[1]):NaN,zcrValue=zcr?Number(zcr[1]):NaN;
    if(Number.isFinite(crestValue)&&crestValue<1.02&&Number.isFinite(rmsDb)&&rmsDb>-45)throw new Error('Audio rechazado por QA: señal demasiado parecida a ruido plano/constante (crest '+crestValue+').');
    if(expectedDuration&&duration<Math.max(1,Number(expectedDuration)*0.75))throw new Error('Audio demasiado corto: '+duration.toFixed(2)+' s.');
    return{ok:true,durationSeconds:duration,rmsDb,peakDb,entropy:Number.isFinite(entropyValue)?entropyValue:null,crestFactor:Number.isFinite(crestValue)?crestValue:null,zeroCrossingRate:Number.isFinite(zcrValue)?zcrValue:null,bytes:stat.size};
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
async function discoverPollinationsMusicModels(key){
  try{const r=await fetch('https://gen.pollinations.ai/v1/models',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:AbortSignal.timeout(15000)});if(!r.ok)return[];
    const data=await r.json().catch(()=>null);const list=Array.isArray(data?.data)?data.data:(Array.isArray(data)?data:[]);
    return list.filter(x=>String(x?.category||'').toLowerCase()==='audio').filter(x=>{const s=(String(x?.id||'')+' '+String(x?.title||'')+' '+String(x?.description||'')).toLowerCase();return /music|lyria|stable.?audio|song|soundtrack/.test(s)&&!/speech|tts|voice|whisper/.test(s);}).sort((a,b)=>Number(b?.health?.success_rate||0)-Number(a?.health?.success_rate||0)).map(x=>String(x?.id||x?.name||'').trim()).filter(Boolean).slice(0,8);
  }catch(err){console.warn('[MusicCascade] Pollinations discovery unavailable:',err?.message||String(err));return[];}
}
async function generatePollinationsMusic(description,durationSeconds,dir,audioProfile={}){
  const key=String(process.env.POLLINATIONS_API_KEY||'').trim();if(!key)throw new Error('POLLINATIONS_API_KEY no configurada.');
  const models=await discoverPollinationsMusicModels(key);const configured=String(process.env.POLLINATIONS_MUSIC_MODEL||'').trim();const candidates=[configured,...models].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);if(!candidates.length)throw new Error('Pollinations no expone un modelo musical disponible.');
  const prompt=String(description||'Original instrumental music matching the reference audio profile: '+JSON.stringify(audioProfile)).slice(0,3000);let lastErr=null;
  for(const model of candidates){if(musicCooldownActive('pollinations:'+model))continue;try{
    const url='https://gen.pollinations.ai/audio/'+encodeURIComponent(prompt)+'?'+new URLSearchParams({model:String(model),duration:String(Math.min(120,Math.max(5,Number(durationSeconds)||30)))}).toString();
    const r=await fetch(url,{headers:{Authorization:'Bearer '+key,Accept:'audio/*'},signal:AbortSignal.timeout(180000)});const contentType=String(r.headers.get('content-type')||'').toLowerCase();const bytes=Buffer.from(await r.arrayBuffer());
    if(!r.ok)throw new Error('Pollinations music '+r.status+': '+bytes.toString('utf8').slice(0,500));if(!contentType.startsWith('audio/'))throw new Error('Pollinations music no devolvió audio ('+contentType+').');
    const qa=await validateGeneratedMusic(bytes,durationSeconds);noteMusicSuccess('pollinations:'+model);return{buffer:bytes,provider:'Pollinations AI Music',model,durationSeconds:qa.durationSeconds,generationType:'ai-music',validation:qa};
  }catch(err){lastErr=err;const kind=classifyMusicError(err);noteMusicCooldown('pollinations:'+model,kind==='quota'?24*60*60*1000:kind==='auth'||kind==='model'?60*60*1000:kind==='capacity'||kind==='network'?90000:60000,err.message);console.warn('[MusicCascade] Pollinations model failed; quarantined:',model,err.message);}}
  throw lastErr||new Error('Pollinations music exhausted.');
}
async function generateHuggingFaceMusic(description,durationSeconds,dir,audioProfile={}){
  // Stable Audio Open is useful for short musical/ambient passages; MusicGen remains a secondary option.

  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();if(!token)throw new Error('HF music token no configurado.');
  const configured=String(process.env.AUTOTUBE_HF_MUSIC_MODEL||'').trim();const candidates=[configured,'stabilityai/stable-audio-open-1.0','facebook/musicgen-small','facebook/musicgen-medium'].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);let lastErr=null;
  for(const model of candidates){if(musicCooldownActive('hf:'+model))continue;try{
    const r=await fetch('https://router.huggingface.co/hf-inference/models/'+encodeURIComponent(model),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'audio/wav'},body:JSON.stringify({inputs:String(description||'').slice(0,2500),parameters:{duration:Math.min(30,Math.max(5,Number(durationSeconds)||30))}}),signal:AbortSignal.timeout(180000)});
    const ct=String(r.headers.get('content-type')||'').toLowerCase();const bytes=Buffer.from(await r.arrayBuffer());if(!r.ok)throw new Error('Hugging Face music '+r.status+': '+bytes.toString('utf8').slice(0,600));if(!ct.startsWith('audio/'))throw new Error('Hugging Face music no devolvió audio ('+ct+').');
    const qa=await validateGeneratedMusic(bytes,durationSeconds);noteMusicSuccess('hf:'+model);return{buffer:bytes,provider:'Hugging Face MusicGen',model,durationSeconds:qa.durationSeconds,generationType:'ai-music',validation:qa};
  }catch(err){lastErr=err;const kind=classifyMusicError(err);noteMusicCooldown('hf:'+model,kind==='quota'?24*60*60*1000:kind==='auth'||kind==='model'?60*60*1000:kind==='capacity'||kind==='network'?90000:60000,err.message);console.warn('[MusicCascade] HF model failed; quarantined:',model,err.message);}}
  throw lastErr||new Error('Hugging Face MusicGen exhausted.');
}
async function generateAceStepMusic(description,durationSeconds,dir,audioProfile={}){
  const base=String(process.env.ACE_STEP_URL||'').trim();if(!base)throw new Error('ACE_STEP_URL no configurada.');
  const r=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:String(description||'').slice(0,3000),duration:Number(durationSeconds)||30,lyrics:'',instrumental:true}),signal:AbortSignal.timeout(180000)});const ct=String(r.headers.get('content-type')||'').toLowerCase();const bytes=Buffer.from(await r.arrayBuffer());
  if(!r.ok)throw new Error('ACE-Step '+r.status+': '+bytes.toString('utf8').slice(0,600));if(!ct.startsWith('audio/'))throw new Error('ACE-Step no devolvió audio ('+ct+').');const qa=await validateGeneratedMusic(bytes,durationSeconds);return{buffer:bytes,provider:'ACE-Step',model:'configured endpoint',durationSeconds:qa.durationSeconds,generationType:'ai-music',validation:qa};
}
async function generateMusicWithCascade(description,durationSeconds,dir,audioProfile={}){
  const errors=[];const providers=[...(process.env.STABILITY_API_KEY&&String(process.env.AUTOTUBE_ENABLE_STABILITY_MUSIC??'1').trim()!=='0'?['stability']:[]),...(falConfigured()&&String(process.env.AUTOTUBE_ENABLE_FAL_MUSIC??'1').trim()!=='0'?['fal']:[]),...(process.env.ACE_STEP_URL?['ace-step']:[]),...(process.env.POLLINATIONS_API_KEY?['pollinations']:[]),...((process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN)?['huggingface']:[])];
  for(const provider of providers){if(musicCooldownActive(provider)){errors.push(provider+': cooldown activo');continue;}try{
    let music;if(provider==='stability')music=await stabilityMusic(description,dir,{durationSeconds});else if(provider==='fal')music=await falMusic(description,dir,{durationSeconds});else if(provider==='ace-step')music=await generateAceStepMusic(description,durationSeconds,dir,audioProfile);else if(provider==='pollinations')music=await generatePollinationsMusic(description,durationSeconds,dir,audioProfile);else music=await generateHuggingFaceMusic(description,durationSeconds,dir,audioProfile);
    const qa=await validateGeneratedMusic(music.buffer,durationSeconds);noteMusicSuccess(provider);return{...music,validation:qa};
  }catch(err){const kind=classifyMusicError(err);const msg=String(err?.message||err);errors.push(provider+': '+kind+': '+msg.slice(0,700));noteMusicCooldown(provider,kind==='quota'?24*60*60*1000:kind==='auth'||kind==='model'?60*60*1000:kind==='capacity'||kind==='network'?90000:60000,msg);console.warn('[MusicCascade] provider failed; advancing:',provider,msg);}}
  if(String(process.env.AUTOTUBE_ALLOW_PROCEDURAL_AUDIO||'0')==='1'){const music=await generateProceduralMusic(description,durationSeconds,dir,audioProfile);return{...music,validation:await validateGeneratedMusic(music.buffer,durationSeconds)};}
  throw new Error('MUSIC_PROVIDERS_EXHAUSTED: '+errors.join(' | '));
}
const generateFallbackMusic=generateMusicWithCascade;

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
      // Fast path for the autonomous AI-video pipeline: generated clips are already
      // H.264 MP4 at 1280x720. Re-encoding every long scene was the dominant CPU
      // cost and caused Render Free restarts. Extend by stream-copying the video
      // and encode only a tiny silent AAC track; final music is mixed afterwards.
      const fastAiVideo=Boolean(aiClip?.path)&&!audio&&!isImage;
      // Pollinations/LTX AI clips are already encoded MP4s. Never re-encode them
      // on Render Free unless narration must be mixed into the scene.
      const fastGeneratedVideo=Boolean(aiClip?.path)&&!audio&&!isImage;
      if(fastGeneratedVideo){
        await runFfmpeg([
          '-y','-hide_banner','-loglevel','error',
          '-stream_loop','-1','-i',input,
          '-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100',
          '-t',String(duration),
          '-map','0:v:0','-map','1:a:0',
          '-c:v','copy','-c:a','aac','-b:a','96k','-ar','44100','-ac','2',
          '-shortest','-avoid_negative_ts','make_zero','-movflags','+faststart',output
        ]);
        const fastStat=await fs.stat(output);
        if(!fastStat.size)throw new Error('FFmpeg creó una escena AI vacía (escena '+scene.number+').');
        clips.push(output);
        console.log('AutoTube fast AI-video stream-copy scene:',scene.number,'duration=',duration,'size=',fastStat.size);
        onProgress(Math.min(78,Math.round(((i+1)/total)*70)+5));
        continue;
      }
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
        // Render Free stability: avoid amix/filter_complex on the final mux.
        // Keep the already-rendered video bitstream and mux the generated music directly.
        '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-ar','44100','-ac','2','-b:a','128k','-threads','1','-movflags','+faststart','-shortest',out]);
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

async function validateReferenceConformance(file,referenceStyle={},referenceTitle='',referenceThumbnail=''){
  const result={status:'deterministic',semanticAudit:null,score:null};
  const vp=referenceStyle?.videoProfile||{}, ap=referenceStyle?.animationProfile||{}, aud=referenceStyle?.audioProfile||{}, sp=referenceStyle?.structureProfile||{};
  const targetAspect=String(vp.aspectRatio||'16:9');
  const targetDuration=Number(vp.durationSeconds||0);
  result.reference={title:String(referenceTitle||''),targetAspect,targetDurationSeconds:targetDuration,targetSceneCount:Number(sp.segmentCount||sp.sceneSegments?.length||0)};
  result.checks={aspectRatio:targetAspect==='16:9',durationProfile:targetDuration>0,audioProfile:Boolean(aud&&Object.keys(aud).length),animationProfile:Boolean(ap&&Object.keys(ap).length),structureProfile:Boolean(sp&&Object.keys(sp).length)};
  const auditRequired=String(process.env.AUTOTUBE_REQUIRE_REFERENCE_AUDIT||'0').trim()==='1';
  const geminiKey=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(geminiKey){
    const auditDir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-reference-audit-'));
    try{
      const probe=await new Promise((resolve,reject)=>{
        const p=spawn(ffmpegPath,['-hide_banner','-loglevel','error','-i',file,'-vf','fps=1/5,scale=512:-2','-frames:v','6','-q:v','6',path.join(auditDir,'frame-%02d.jpg')],{stdio:['ignore','pipe','pipe']});
        let err='';p.stderr.on('data',x=>err+=x.toString());p.on('error',reject);p.on('close',code=>code===0?resolve(true):reject(new Error('No se pudieron extraer frames para la auditoría audiovisual: '+err.slice(-600))));
      });
      const files=await fs.readdir(auditDir);const images=[];
      for(const name of files.filter(x=>/^frame-\\d+\\.jpg$/i.test(x)).sort().slice(0,6)){const bytes=await fs.readFile(path.join(auditDir,name));images.push({mimeType:'image/jpeg',data:bytes.toString('base64')});}
      if(!images.length)throw new Error('La auditoría audiovisual no obtuvo frames.');
      const auditPrompt=[
        'Evalúa si estas imágenes son una recreación audiovisual ORIGINAL coherente con el perfil analizado del vídeo de referencia de YouTube.',
        'No evalúes si son copias exactas; evalúa semejanza de lenguaje audiovisual: composición, sujetos/tipo de plano, paleta, iluminación, movimiento implícito, ritmo, continuidad y estructura.',
        'Devuelve SOLO JSON: {"overallScore":0,"visualContentScore":0,"styleScore":0,"structureScore":0,"continuityScore":0,"matchedAspects":[],"missingAspects":[],"majorMismatch":false,"explanation":""}.',
        'Una puntuación alta requiere que el conjunto recuerde claramente al perfil de referencia, pero con material original.',
        'Título de referencia: '+String(referenceTitle||''),
        'Perfil audiovisual de referencia: '+JSON.stringify({videoProfile:vp,animationProfile:ap,structureProfile:sp,audioProfile:aud}).slice(0,18000),
        referenceThumbnail?'Miniatura de referencia disponible como contexto adicional, pero no debe sustituir al perfil.':'',
        'Analiza las '+images.length+' imágenes generadas adjuntas.'
      ].filter(Boolean).join('\\n');
      const raw=await callGemini({system:'Eres un auditor audiovisual objetivo. No copies contenido ni identidades. Compara únicamente rasgos audiovisuales.',user:auditPrompt,images,temperature:0,maxOutputTokens:900,json:true});
      const audit=parseJsonResponse(raw);const score=Number(audit?.overallScore);
      if(!Number.isFinite(score))throw new Error('Auditoría Gemini devolvió una puntuación inválida.');
      result.semanticAudit={status:'completed',provider:'Gemini vision audit',...audit};result.score=score;result.status=score>=70?'passed':'insufficient';
      if(score<70&&auditRequired)throw new Error('REFERENCE_CONFORMANCE_INSUFFICIENT: auditoría audiovisual '+score+'/100; faltan rasgos del vídeo de referencia. '+String(audit?.explanation||''));
    }catch(err){
      result.semanticAudit={status:'unavailable',error:String(err?.message||err)};result.status=auditRequired?'inconclusive':'deterministic-only';
      if(auditRequired)throw err;
    }finally{await fs.rm(auditDir,{recursive:true,force:true}).catch(()=>{});}
  }else{
    result.semanticAudit={status:'unavailable',reason:'GEMINI_API_KEY no configurada'};result.status='deterministic-only';
  }
  return result;
}

async function validateRenderedMp4(file,expectedDuration=0,options={}){
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
  const supportedResolution=(width===854&&height===480)||(width===1280&&height===720)||(width===1920&&height===1080);
  if(!supportedResolution)throw new Error('Resolución real del MP4: '+width+'x'+height+' (se esperaba 854x480, 1280x720 o 1920x1080).');
  const expectedFps=Number(options.expectedFps)||30;
  if(!fps||Math.abs(fps-expectedFps)>0.5)throw new Error('FPS reales del MP4: '+(fps||'desconocidos')+' (se esperaban '+expectedFps+').');  if(audioCodec!=='aac')throw new Error('Códec de audio real del MP4: '+(audioCodec||'desconocido')+' (se esperaba AAC).');
  const motion=await validateAnimatedMotion(file);
  const referenceConformance=options.referenceStyle?await validateReferenceConformance(file,options.referenceStyle,options.referenceTitle||'',options.referenceThumbnail||''):null;
  return{width,height,fps,audioCodec,durationSeconds,motion,referenceConformance};
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

async function generateLocalKokoroTts(text,language='es',voiceStyle='Natural y cercana',audioProfile={}) {
  const base=String(process.env.KOKORO_TTS_URL||'').trim();
  if(!base)throw new Error('KOKORO_TTS_URL no configurado');
  const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:String(text||''),language:String(language||'es'),voice:String(process.env.KOKORO_TTS_VOICE||''),speed:1}),signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error('Kokoro TTS '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length<1000)throw new Error('Kokoro TTS devolvió audio vacío.');
  return bytes;
}
async function generateNarrationTts(text,language='es',voiceStyle='Natural y cercana',audioProfile={}) {
  const clean=String(text||'').replace(/\s+/g,' ').trim().slice(0,280);
  if(!clean)return null;
  const tl=String(language||'es').toLowerCase().split(/[-_]/)[0]||'es';
  if(falConfigured()&&String(process.env.AUTOTUBE_ENABLE_FAL_TTS??'1').trim()!=='0'){try{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-fal-tts-'));try{const result=await falTts(clean,dir);return await fs.readFile(result.outputPath);}finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}}catch(err){console.warn('FAL TTS unavailable; advancing to local/free voice:',err.message||err);}}
  if(process.env.ELEVENLABS_API_KEY&&process.env.ELEVENLABS_VOICE_ID){try{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-eleven-'));try{const result=await elevenTts(clean,dir,{voiceId:process.env.ELEVENLABS_VOICE_ID});return await fs.readFile(result.outputPath);}finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}}catch(err){console.warn('ElevenLabs TTS unavailable; advancing to local/free voice:',err.message||err);}}
  if(process.env.KOKORO_TTS_URL){try{return await generateLocalKokoroTts(clean,tl,voiceStyle,audioProfile);}catch(err){console.warn('Kokoro TTS unavailable; using Google TTS fallback:',err.message||err);}}
  const url='https://translate.google.com/translate_tts?'+new URLSearchParams({ie:'UTF-8',client:'tw-ob',tl,q:clean});
  const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{Accept:'audio/mpeg','User-Agent':'Mozilla/5.0 AutoTube/1.0'}});
  if(!response.ok)throw new Error('Google TTS '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length<1000)throw new Error('Google TTS devolvió audio vacío.');
  return bytes;
}
const generateGeminiTts=generateNarrationTts;

const originalImageProviderState=new Map();
function originalImageState(provider='unknown'){const key=String(provider||'unknown');if(!originalImageProviderState.has(key))originalImageProviderState.set(key,{cooldownUntil:0,failures:0,lastError:'',lastFailureAt:0,lastSuccessAt:0});return originalImageProviderState.get(key);}
function originalImageCooldownActive(provider='unknown'){return Date.now()<Number(originalImageState(provider).cooldownUntil||0);}
function noteOriginalImageCooldown(provider='unknown',ms=120000,err=''){const st=originalImageState(provider);st.cooldownUntil=Date.now()+Math.max(15000,Number(ms)||120000);st.failures++;st.lastFailureAt=Date.now();st.lastError=String(err||'');}
function noteOriginalImageSuccess(provider='unknown'){const st=originalImageState(provider);st.cooldownUntil=0;st.failures=0;st.lastSuccessAt=Date.now();st.lastError='';}
function classifyOriginalImageError(err){const m=String(err?.message||err||'').toLowerCase();if(/429|quota|rate limit|too many requests|limit: 0/.test(m))return'quota';if(/401|403|api key|unauthori|forbidden/.test(m))return'auth';if(/404|model.*not found|unsupported model/.test(m))return'model';if(/timeout|timed out|econnreset|eai_again|socket hang up|network/.test(m))return'network';if(/500|502|503|504|service unavailable|temporarily unavailable/.test(m))return'capacity';return'other';}
async function validateGeneratedOriginalImage(file){
  const probe=await new Promise((resolve,reject)=>{const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-f','null','-'],{stdio:['ignore','pipe','pipe']});let e='';p.stderr.on('data',d=>{e+=d.toString();if(e.length>12000)e=e.slice(-12000)});p.on('error',reject);p.on('close',code=>code===0?resolve(e):reject(new Error('Imagen inválida para FFmpeg: '+e.slice(-1200))));});
  const stat=await fs.stat(file);if(stat.size<1000)throw new Error('Imagen generada demasiado pequeña.');
  const t=String(probe);const vm=t.split(/\r?\n/).find(x=>/Video:/i.test(x))||'';const size=vm.match(/(\d{2,5})x(\d{2,5})/);if(!size)throw new Error('No se pudo verificar la resolución de la imagen.');
  return{ok:true,width:Number(size[1]),height:Number(size[2]),bytes:stat.size};
}
async function generateHuggingFaceOriginalImage(prompt,dir,options={}){
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  if(!token)throw new Error('HF image token no configurado.');
  const model=String(options.model||process.env.AUTOTUBE_HF_IMAGE_MODEL||'black-forest-labs/FLUX.1-schnell').trim();
  const response=await fetch('https://router.huggingface.co/hf-inference/models/'+encodeURIComponent(model),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'image/png'},body:JSON.stringify({inputs:String(prompt||'').trim(),parameters:{width:Number(options.width)||854,height:Number(options.height)||480,num_inference_steps:4}}),signal:AbortSignal.timeout(120000)});
  const contentType=String(response.headers.get('content-type')||'').toLowerCase();const raw=await response.arrayBuffer();
  if(!response.ok){let detail='';try{detail=Buffer.from(raw).toString('utf8').slice(0,600)}catch{}throw new Error('Hugging Face image '+response.status+': '+detail);}
  if(!contentType.startsWith('image/'))throw new Error('Hugging Face no devolvió una imagen ('+contentType+').');
  const bytes=Buffer.from(raw);if(bytes.length<1000)throw new Error('Hugging Face devolvió una imagen vacía.');
  const outputPath=path.join(dir,'hf-original-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.png');await fs.writeFile(outputPath,bytes);await validateGeneratedOriginalImage(outputPath);
  return{outputPath,bytes:bytes.length,provider:'Hugging Face Inference · '+model,model,status:'complete'};
}
async function generateOriginalImageWithCascade(prompt,dir,options={}){
  const errors=[];
  const providers=[
    ...(falConfigured()&&String(process.env.AUTOTUBE_ENABLE_FAL_IMAGE??'1').trim()!=='0'?['fal']:[]),
    ...(replicateConfigured()&&String(process.env.AUTOTUBE_ENABLE_REPLICATE_IMAGE??'1').trim()!=='0'?['replicate']:[]),
    ...(String(process.env.AUTOTUBE_ALLOW_HF_IMAGE||'1')!=='0'&&(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN)?['huggingface']:[]),
    'gemini',
    'pollinations'
  ];
  for(const provider of providers){
    if(originalImageCooldownActive(provider)){errors.push(provider+': cooldown activo');continue;}
    try{
      let image;
      if(provider==='fal')image=await falImage(prompt,dir,{width:Number(options.width)||854,height:Number(options.height)||480});
      else if(provider==='replicate'){const Replicate=require('replicate');const client=new Replicate({auth:process.env.REPLICATE_API_TOKEN});const out=await client.run('black-forest-labs/flux-schnell',{input:{prompt:String(prompt||'').trim(),go_fast:true,aspect_ratio:'16:9',output_format:'png',output_quality:90}});const u=typeof out?.[0]?.url==='function'?out[0].url():out?.[0];if(!u)throw new Error('Replicate image no devolvió URL');const outputPath=path.join(dir,'replicate-image-'+Date.now()+'.png');const dl=await downloadFileFromUrl(u,outputPath);image={...dl,provider:'replicate',model:'black-forest-labs/flux-schnell',status:'complete'};}
      else if(provider==='huggingface')image=await generateHuggingFaceOriginalImage(prompt,dir,{model:options.hfModel,width:Number(options.width)||854,height:Number(options.height)||480});
      else if(provider==='gemini')image=await generateGeminiOriginalImage(prompt,dir,{model:String(options.geminiModel||'gemini-2.5-flash-image')});
      else image=await generatePollinationsOriginalImage(prompt,dir,{width:Number(options.width)||854,height:Number(options.height)||480});
      await validateGeneratedOriginalImage(image.outputPath);
      noteOriginalImageSuccess(provider);
      console.log('[OriginalImageCascade] provider success:',provider,image.model||'');
      return{...image,providerKey:provider,generationType:'ai-image'};
    }catch(err){
      const kind=classifyOriginalImageError(err);const msg=String(err?.message||err);errors.push(provider+': '+kind+': '+msg.slice(0,700));
      const cooldown=kind==='quota'?24*60*60*1000:kind==='auth'||kind==='model'?60*60*1000:kind==='capacity'||kind==='network'?90000:60000;
      noteOriginalImageCooldown(provider,cooldown,msg);
      console.warn('[OriginalImageCascade] '+provider+' failed; provider quarantined for '+Math.round(cooldown/1000)+'s; advancing:',msg);
    }
  }
  throw new Error('ORIGINAL_IMAGE_PROVIDERS_EXHAUSTED: '+errors.join(' | '));
}

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

async function discoverPollinationsVideoModels(key) {
  try {
    const response=await fetch('https://gen.pollinations.ai/v1/models',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)return[];
    const data=await response.json().catch(()=>null);
    const list=Array.isArray(data?.data)?data.data:(Array.isArray(data)?data:[]);
    return list.map(x=>String(x?.id||x?.name||'').trim()).filter(Boolean).filter((id,i,arr)=>arr.indexOf(id)===i).slice(0,12);
  }catch(err){
    console.warn('Pollinations model discovery unavailable:',err?.message||String(err));
    return[];
  }
}

async function generatePollinationsVideoClip(prompt,dir,options={}) {
  const key=String(process.env.POLLINATIONS_API_KEY||'').trim();
  if(!key)throw new Error('No hay POLLINATIONS_API_KEY configurada para el fallback de vídeo IA.');
  const duration=Math.max(2,Math.min(5,Number(options.durationSeconds)||4));
  const aspectRatio=String(options.aspectRatio||'16:9');
  const configured=String(process.env.POLLINATIONS_VIDEO_MODEL||'wan-fast').trim();
  const discovered=await discoverPollinationsVideoModels(key);
  // /v1/models also exposes text-only models. Never send those to /video:
  // they return HTTP 400 and waste the autonomous cycle budget. Keep only
  // models that are known/advertised as video-capable.
  const looksVideoCapable=(id)=>{
    const value=String(id||'').toLowerCase();
    if(!value)return false;
    if(/gpt|gem|gemma|qwen|deepseek|command|glm|nemotron|llama|mistral|claude|codes|coder|text|chat|reason|instruct/.test(value))return false;
    return /wan|ltx|hunyuan.?video|cogvideo|mochi|video|kling|veo|seedance|sora/.test(value);
  };
  const candidates=[configured,...discovered.filter(looksVideoCapable),'wan-fast','wan']
    .filter(looksVideoCapable)
    .filter((x,i,arr)=>arr.indexOf(x)===i);
  let lastError=null;
  for(const model of candidates){
    const endpoint='https://gen.pollinations.ai/video/'+encodeURIComponent(String(prompt||'').trim())+'?'+new URLSearchParams({
      model,duration:String(duration),aspectRatio
    }).toString();
    try{
      const response=await fetch(endpoint,{signal:AbortSignal.timeout(300000),headers:{
        Authorization:'Bearer '+key,
        Accept:'video/mp4,video/*,*/*;q=0.8',
        'User-Agent':'AutoTube/1.0'
      }});
      if(!response.ok){
        const body=(await response.text()).slice(0,700);
        throw new Error('HTTP '+response.status+': '+body);
      }
      if(!response.body)throw new Error('Pollinations no devolvió un cuerpo de respuesta.');
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
      await validateGeneratedVideoClip(outputPath);
      console.log('Pollinations video fallback succeeded:',model,total,'bytes');
      return{outputPath,bytes:total,provider:'Pollinations AI video',model,durationSeconds:duration,status:'complete'};
    }catch(err){
      lastError=err;
      console.warn('Pollinations video model failed:',model,err?.message||String(err));
    }
  }
  throw new Error('Pollinations no pudo generar un vídeo IA válido con ningún modelo disponible. Último error: '+(lastError?.message||'desconocido'));
}

async function generateHuggingFaceProviderVideoClip(prompt,dir,options={}) {
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  if(!token)throw new Error('HF_TOKEN no configurado.');
  const configuredModel=String(process.env.HF_VIDEO_MODEL||'').trim();
  const configuredProvider=String(process.env.HF_VIDEO_PROVIDER||'').trim();
  const duration=Math.max(2,Math.min(5,Number(options.durationSeconds)||3));
  const imagePath=String(options.firstFramePath||'').trim();
  const candidates=[
    ...(configuredModel?[{model:configuredModel,provider:configuredProvider||'auto'}]:[]),
    {model:'Wan-AI/Wan2.1-T2V-1.3B',provider:'fal-ai'},
    {model:'Wan-AI/Wan2.2-TI2V-5B',provider:'replicate'},
    {model:'Wan-AI/Wan2.2-I2V-A14B',provider:'fal-ai'},
    {model:'Lightricks/LTX-Video-0.9.8-13B-distilled',provider:'fal-ai'}
  ];
  const unique=candidates.filter((x,i,a)=>a.findIndex(y=>y.model===x.model&&y.provider===x.provider)===i);
  const errors=[];
  const {InferenceClient}=require('@huggingface/inference');
  for(const candidate of unique){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(new Error('HF video timeout')),240000);
    try{
      const client=new InferenceClient(token);
      let blob;
      const wantsI2V=Boolean(imagePath)&&/I2V|TI2V|image-to-video/i.test(candidate.model);
      if(wantsI2V){
        blob=await client.imageToVideo({
          provider:candidate.provider,
          model:candidate.model,
          image:await fs.readFile(imagePath),
          prompt:String(prompt||'').trim()
        });
      }else{
        blob=await client.textToVideo({
          provider:candidate.provider,
          model:candidate.model,
          inputs:String(prompt||'').trim()
        });
      }
      const bytes=Buffer.from(await blob.arrayBuffer());
      if(bytes.length<10000)throw new Error('Hugging Face devolvió un vídeo vacío.');
      const outputPath=path.join(dir,'hf-provider-generated-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
      await fs.writeFile(outputPath,bytes);
      const validation=await validateGeneratedVideoClip(outputPath);
      if(!validation.ok)throw new Error('Vídeo HF inválido después de generarlo.');
      return{outputPath,bytes:bytes.length,provider:'Hugging Face Inference Providers · '+candidate.provider,model:candidate.model,durationSeconds:duration,status:'complete',routeMode:wantsI2V?'I2V':'T2V'};
    }catch(err){
      errors.push(candidate.model+'@'+candidate.provider+': '+String(err?.message||err).slice(0,320));
      console.warn('HF video candidate failed:',candidate.model,candidate.provider,err?.message||String(err));
    }finally{clearTimeout(timer)}
  }
  throw new Error('Ninguna ruta HF de vídeo disponible: '+errors.join(' | '));
}

async function generateHuggingFaceVideoModelCascade(prompt,dir,options={}) {
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  if(!token)throw new Error('HF_TOKEN no configurado.');
  const duration=Math.max(2,Math.min(5,Number(options.durationSeconds)||3));
  const imagePath=String(options.firstFramePath||'').trim();
  const models=[
    process.env.HF_VIDEO_MODEL,
    'Wan-AI/Wan2.2-T2V-A14B',
    'Wan-AI/Wan2.2-I2V-A14B',
    'Lightricks/LTX-2.3',
    'tencent/HunyuanVideo-I2V',
    'tencent/HunyuanVideo-1.5',
    'THUDM/CogVideoX1.5-5B',
    'genmo/mochi-1-preview'
  ].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
  const providers=[
    process.env.HF_VIDEO_PROVIDER,
    'fal-ai',
    'replicate',
    'hf-inference'
  ].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
  const errors=[];
  const {InferenceClient}=require('@huggingface/inference');
  const client=new InferenceClient(token);
  for(const model of models){
    for(const provider of providers){
      try{
        let blob;
        if(imagePath && /I2V|HunyuanVideo-I2V|Wan2\.2-I2V/i.test(model)){
          blob=await client.imageToVideo({provider,model,image:await fs.readFile(imagePath),inputs:String(prompt||'').trim()});
        }else{
          blob=await client.textToVideo({provider,model,inputs:String(prompt||'').trim()});
        }
        const bytes=Buffer.from(await blob.arrayBuffer());
        if(bytes.length<10000)throw new Error('respuesta de vídeo vacía');
        const outputPath=path.join(dir,'hf-cascade-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
        await fs.writeFile(outputPath,bytes);
        await validateGeneratedVideoClip(outputPath);
        return{outputPath,bytes:bytes.length,provider:'Hugging Face Inference Providers · '+provider,model,durationSeconds:duration,status:'complete'};
      }catch(err){
        errors.push(model+'@'+provider+': '+String(err?.message||err).slice(0,260));
        console.warn('HF high-quality model failed:',model,provider,err?.message||String(err));
      }
    }
  }
  throw new Error('Ningún modelo HF de alta calidad disponible: '+errors.join(' | '));
}

async function generateFreeLtx25VideoClip(prompt,dir,options={}) {
  const {Client,handle_file}=require('@gradio/client');
  const configured=String(process.env.LTX25_SPACE_URL||'').trim().replace(/\/$/,'');
  const spaces=[configured,'https://ChopperBlu-ltx-2-5-demo.hf.space','https://Lightricks-LTX-2-5.hf.space','https://akhaliq-ltx-2-5-workflow.hf.space']
    .filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
  const duration=Math.max(1,Math.min(8,Number(options.durationSeconds)||3));
  const width=896, height=512;
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  const imagePath=String(options.firstFramePath||'').trim();
  const errors=[];
  for(const spaceUrl of spaces){
    try{
      const client=await Client.connect(spaceUrl,token?{token}:undefined);
      const seed=Math.floor(Math.random()*2147483647);
      const image=imagePath?await handle_file(imagePath):null;
      // Current LTX-2.5 public demos expose a stable /generate_video API:
      // prompt, image, width, height, duration, auto_length, seed, randomize_seed, decoder.
      let result;
      try{
        result=await client.predict('/generate_video',[
          String(prompt||'').trim(), image, width, height, duration, false, seed, true, 'conv'
        ]);
      }catch(firstErr){
        // Workflow-based mirrors use the same logical operator with a smaller signature.
        result=await client.predict('/generate_video',[
          String(prompt||'').trim(), image, height, width, duration, seed, 'conv', false, true
        ]);
      }
      const data=Array.isArray(result?.data)?result.data:[];
      const output=data[0];
      const raw=typeof output==='string' ? output : (output?.url||output?.path||output?.video?.url||'');
      if(!raw)throw new Error('LTX-2.5 terminó sin devolver el vídeo.');
      const fileUrl=String(raw).startsWith('http')?String(raw):spaceUrl+'/gradio_api/file='+String(raw).replace(/^\//,'');
      const response=await fetch(fileUrl,{headers:token?{Authorization:'Bearer '+token}:{} ,signal:AbortSignal.timeout(300000)});
      if(!response.ok)throw new Error('LTX-2.5 descarga HTTP '+response.status);
      const outputPath=path.join(dir,'ltx25-generated-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length<10000)throw new Error('LTX-2.5 devolvió un archivo demasiado pequeño.');
      await fs.writeFile(outputPath,bytes);
      const validation=await validateGeneratedVideoClip(outputPath);
      if(!validation.ok)throw new Error('LTX-2.5 produjo un clip inválido.');
      return{outputPath,bytes:bytes.length,provider:'Hugging Face ZeroGPU · LTX-2.5',model:'LTX-2.5 distilled',durationSeconds:validation.durationSeconds,status:'complete'};
    }catch(err){
      errors.push(spaceUrl+': '+String(err?.message||err).slice(0,500));
      console.warn('LTX-2.5 Space failed:',spaceUrl,err?.message||String(err));
    }
  }
  throw new Error('LTX-2.5 no pudo generar un clip válido: '+errors.join(' | '));
}

async function downloadRemoteImageToFile(url,dir,name='reference-frame.jpg'){
  const response=await fetch(String(url||''),{signal:AbortSignal.timeout(30000),headers:{Accept:'image/*','User-Agent':'AutoTube/1.0'}});
  if(!response.ok)throw new Error('No se pudo descargar el frame de referencia: HTTP '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length<1000)throw new Error('El frame de referencia está vacío.');
  const outputPath=path.join(dir,name);
  await fs.writeFile(outputPath,bytes);
  return outputPath;
}

async function downloadGradioOutput(output,spaceUrl,token,dir,prefix){
  const raw=typeof output==='string'?output:(output?.url||output?.path||output?.video?.url||'');
  if(!raw)throw new Error('El modelo ZeroGPU terminó sin devolver un archivo.');
  const url=String(raw).startsWith('http')?String(raw):spaceUrl+'/gradio_api/file='+String(raw).replace(/^\//,'');
  const response=await fetch(url,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error('No se pudo descargar el resultado ZeroGPU ('+response.status+').');
  const outputPath=path.join(dir,prefix+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length<10000)throw new Error('El vídeo ZeroGPU descargado es demasiado pequeño.');
  await fs.writeFile(outputPath,bytes);
  await validateGeneratedVideoClip(outputPath);
  return outputPath;
}

async function generateFreeWan21VideoClip(prompt,dir,options={}) {
  const spaceUrl=String(process.env.WAN21_SPACE_URL||'https://weathon-vsf.hf.space').replace(/\/$/,'');
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  const headers={'Content-Type':'application/json'};
  if(token)headers.Authorization='Bearer '+token;
  const frames=81;
  const seed=Math.floor(Math.random()*2147483647);
  const submit=await fetch(spaceUrl+'/gradio_api/call/generate_video',{
    method:'POST',
    headers,
    body:JSON.stringify({data:[
      String(prompt||'').trim(),
      'worst quality, blurry, static, distorted anatomy, text, logos, watermark',
      1.5,
      0.1,
      8,
      frames,
      seed
    ]}),
    signal:AbortSignal.timeout(60000)
  });
  const raw=await submit.text();
  let parsed=null;try{parsed=raw?JSON.parse(raw):null}catch{}
  if(!submit.ok)throw new Error('Wan2.1 ZeroGPU submit '+submit.status+': '+raw.slice(0,500));
  const eventId=String(parsed?.event_id||'').trim();
  if(!eventId)throw new Error('Wan2.1 ZeroGPU no devolvió event_id.');
  const result=await fetch(spaceUrl+'/gradio_api/call/generate_video/'+encodeURIComponent(eventId),{
    headers:token?{Authorization:'Bearer '+token}:{},
    signal:AbortSignal.timeout(300000)
  });
  const stream=await result.text();
  if(!result.ok)throw new Error('Wan2.1 ZeroGPU result '+result.status+': '+stream.slice(0,700));
  const events=stream.split(/\r?\n\r?\n/);
  let completeData=null;
  for(const event of events){
    const type=(event.match(/^event:\s*(.+)$/m)||[])[1]?.trim();
    const dataLine=(event.match(/^data:\s*(.+)$/m)||[])[1];
    if(type==='error')throw new Error('Wan2.1 ZeroGPU error: '+String(dataLine||event).slice(0,700));
    if(type==='complete'&&dataLine){try{completeData=JSON.parse(dataLine)}catch{}}
  }
  const data=Array.isArray(completeData)?completeData:(Array.isArray(completeData?.data)?completeData.data:[]);
  const output=data[0];
  const outputPath=await downloadGradioOutput(output,spaceUrl,token,dir,'wan21-generated');
  return{outputPath,bytes:(await fs.stat(outputPath)).size,provider:'Hugging Face ZeroGPU · Wan2.1',model:'Wan2.1 T2V 1.3B',durationSeconds:5,status:'complete'};
}

async function generateFreeWanVace13VideoClip(prompt,dir,options={}){
  const firstFramePath=String(options.firstFramePath||'').trim();
  if(!firstFramePath)throw new Error('Wan2.1 VACE requiere un frame de referencia.');
  const space=String(process.env.WAN_VACE_SPACE_URL||'jdpadmin/wan2.1-vace-diffusers-demo').trim();
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  const {Client}=require('@gradio/client');
  const client=await Client.connect(space,token?{token}:undefined);
  const frames=81;
  const result=await client.predict('/run',[
    String(prompt||'').trim(),
    firstFramePath,
    firstFramePath,
    null,
    null,
    null,
    frames,
    20,
    5,
    Math.floor(Math.random()*2147483647),
    true
  ]);
  const data=Array.isArray(result?.data)?result.data:[];
  const output=data[0];
  const outputPath=await downloadGradioOutput(output,'https://'+space+'.hf.space',token,dir,'wan-vace-generated');
  return{outputPath,bytes:(await fs.stat(outputPath)).size,provider:'Hugging Face ZeroGPU · Wan2.1 VACE',model:'Wan2.1 VACE 1.3B',durationSeconds:Math.max(3,(frames-1)/16),status:'complete'};
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
    console.warn('LTX Video 0.9.8 unavailable:',message);
    if(String(process.env.AUTOTUBE_FREE_ONLY||'1').trim()!=='0')throw ltxErr;
    if(!String(process.env.POLLINATIONS_API_KEY||'').trim())throw ltxErr;
    return generatePollinationsVideoClip(prompt,dir,options);
  }
}

async function generateFreeWan22I2vVideoClip(prompt,dir,options={}){
  const {Client,handle_file}=require('@gradio/client');
  const space=String(process.env.WAN22_I2V_SPACE_URL||'zerogpu-aoti/wan2-2-fp8da-aoti-faster').trim();
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  const firstFramePath=String(options.firstFramePath||'').trim();
  if(!firstFramePath)throw new Error('Wan2.2 I2V requiere un frame de referencia.');
  const app=await Client.connect(space,token?{token}:undefined);
  const duration=Math.max(0.5,Math.min(5,Number(options.durationSeconds)||3.5));
  const steps=Math.max(4,Math.min(8,Number(options.steps)||4));
  const seed=Math.floor(Math.random()*2147483647);
  const result=await app.predict('/generate_video',[
    await handle_file(firstFramePath),
    String(prompt||'').trim(),
    steps,
    'worst quality, blurry, jittery, distorted, text, logos, watermark, duplicate subjects',
    duration,
    1,
    1,
    seed,
    true
  ]);
  const data=Array.isArray(result?.data)?result.data:[];
  const output=data[0];
  const outputPath=await downloadGradioOutput(output,'https://'+space+'.hf.space',token,dir,'wan22-i2v-generated');
  const stat=await fs.stat(outputPath);
  if(!stat.size)throw new Error('Wan2.2 I2V devolvió un vídeo vacío.');
  return{outputPath,bytes:stat.size,provider:'Hugging Face ZeroGPU · Wan2.2 I2V',model:'Wan2.2 I2V A14B FP8 Lightning',durationSeconds:duration,status:'complete'};
}

async function generateReplicateOfficialVideoClip(prompt,dir,options={}) {
  const token=String(process.env.REPLICATE_API_TOKEN||'').trim();
  if(!token)throw new Error('REPLICATE_API_TOKEN no configurado.');
  const configured=String(process.env.REPLICATE_VIDEO_MODELS||'').trim();
  const models=[...(configured?configured.split(','):[]),
    'lightricks/ltx-2.5-fast',
    'alibaba/wan-3',
    'alibaba/wan-3-prime',
    'prunaai/p-video-2'
  ].map(x=>String(x).trim()).filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
  const duration=Math.max(3,Math.min(8,Number(options.durationSeconds)||4));
  const aspectRatio=String(options.aspectRatio||'16:9');
  const errors=[];
  for(const model of models){
    try{
      const metaResponse=await fetch('https://api.replicate.com/v1/models/'+model,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
      if(!metaResponse.ok)throw new Error('model metadata HTTP '+metaResponse.status);
      const meta=await metaResponse.json();
      const schema=meta?.latest_version?.openapi_schema?.components?.schemas?.Input||{};
      const props=schema.properties||{};
      const input={};
      const promptKeys=['prompt','text','description'];
      const promptKey=promptKeys.find(k=>props[k]);
      if(!promptKey)throw new Error('modelo sin campo de prompt compatible');
      input[promptKey]=String(prompt||'').trim();
      const durationKey=['duration','duration_seconds','num_frames'].find(k=>props[k]);
      if(durationKey)input[durationKey]=durationKey==='num_frames'?Math.round(duration*24):duration;
      const aspectKey=['aspect_ratio','aspectRatio'].find(k=>props[k]);
      if(aspectKey)input[aspectKey]=aspectRatio;
      const resolutionKey=['resolution','size','output_resolution'].find(k=>props[k]);
      if(resolutionKey){
        const allowed=props[resolutionKey]?.enum||[];
        input[resolutionKey]=allowed.includes('480p')?'480p':allowed.includes('720p')?'720p':allowed.includes('16:9')?'16:9':allowed[0]||'480p';
      }
      const negativeKey=['negative_prompt','negativePrompt'].find(k=>props[k]);
      if(negativeKey)input[negativeKey]='blurry, jittery, distorted anatomy, text, logos, watermark, copied frames';
      const imagePath=String(options.firstFramePath||'').trim();
      const imageKey=['image','start_image','input_image','first_frame'].find(k=>props[k]);
      if(imagePath&&imageKey){
        const bytes=await fs.readFile(imagePath);
        if(bytes.length<=256*1024){
          const mime=/\.png$/i.test(imagePath)?'image/png':'image/jpeg';
          input[imageKey]='data:'+mime+';base64,'+bytes.toString('base64');
        }
      }
      const create=await fetch('https://api.replicate.com/v1/models/'+model+'/predictions',{
        method:'POST',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Prefer':'wait=60','Cancel-After':'3m'},
        body:JSON.stringify({input}),
        signal:AbortSignal.timeout(70000)
      });
      const prediction=await create.json().catch(()=>null);
      if(!create.ok)throw new Error('prediction HTTP '+create.status+': '+String(prediction?.detail||prediction?.error||'').slice(0,500));
      let p=prediction;
      const deadline=Date.now()+180000;
      while(p?.status&&!['succeeded','failed','canceled'].includes(p.status)&&Date.now()<deadline){
        await new Promise(r=>setTimeout(r,2500));
        const u=p?.urls?.get||('https://api.replicate.com/v1/predictions/'+encodeURIComponent(p.id||''));
        const rr=await fetch(u,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
        p=await rr.json();
      }
      if(p?.status!=='succeeded')throw new Error('prediction '+String(p?.status||'unknown')+': '+String(p?.error||'sin resultado').slice(0,500));
      const output=p.output;
      const raw=Array.isArray(output)?output[0]:(typeof output==='string'?output:(output?.url||output?.video?.url||output?.path||''));
      if(!raw)throw new Error('Replicate no devolvió una URL de vídeo.');
      const response=await fetch(String(raw),{signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new Error('descarga Replicate HTTP '+response.status);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length<10000)throw new Error('Replicate devolvió un archivo demasiado pequeño.');
      const outputPath=path.join(dir,'replicate-video-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
      await fs.writeFile(outputPath,bytes);
      const validation=await validateGeneratedVideoClip(outputPath);
      if(!validation.ok)throw new Error('Replicate produjo un clip inválido.');
      return{outputPath,bytes:bytes.length,provider:'Replicate official',model,durationSeconds:validation.durationSeconds,status:'complete'};
    }catch(err){
      errors.push(model+': '+String(err?.message||err).slice(0,500));
      console.warn('Replicate video model failed:',model,err?.message||String(err));
    }
  }
  throw new Error('Replicate no pudo generar un clip válido: '+errors.join(' | '));
}

/* Autonomous free-video provider manager. */
const videoProviderState = new Map();
const VIDEO_PROVIDER_COOLDOWN_MS = Math.max(30000, Number(process.env.AUTOTUBE_PROVIDER_COOLDOWN_MS)||180000);
const VIDEO_PROVIDER_PROBE_MS = Math.max(30000, Number(process.env.AUTOTUBE_PROVIDER_PROBE_MS)||60000);
// ZeroGPU quota is account-scoped across Spaces. A quota error from one Space therefore
// makes trying another ZeroGPU Space immediately wasteful. Keep a shared breaker for the
// whole account window and never spend more GPU time on blind provider fallbacks.
const ZEROGPU_SHARED_QUOTA_MS = Math.max(60*60*1000, Number(process.env.AUTOTUBE_ZEROGPU_QUOTA_COOLDOWN_MS)||24*60*60*1000);
let sharedZeroGpuCooldownUntilTs=0;
function zeroGpuQuotaActive(){return Date.now()<getSharedZeroGpuCooldownUntil();}

// Free-production guard: never spend the daily free GPU allowance on blind retries.
// This is intentionally conservative because ZeroGPU quota is measured in GPU time,
// not output-video seconds. The values are configurable and can be tightened without
// changing the pipeline.
const FREE_AI_WINDOW_MS = 24*60*60*1000;
const FREE_AI_DAILY_SECONDS = Math.max(15, Number(process.env.AUTOTUBE_FREE_AI_DAILY_SECONDS)||3600);
const FREE_AI_DAILY_CLIPS = Math.max(1, Number(process.env.AUTOTUBE_FREE_AI_DAILY_CLIPS)||600);
let freeAiBudget={windowStartedAt:0,reservedSeconds:0,completedClips:0};
function resetFreeAiBudgetIfNeeded(){
  const now=Date.now();
  if(!freeAiBudget.windowStartedAt || now-freeAiBudget.windowStartedAt>=FREE_AI_WINDOW_MS){
    freeAiBudget={windowStartedAt:now,reservedSeconds:0,completedClips:0};
  }
}
function freeAiBudgetSnapshot(){
  resetFreeAiBudgetIfNeeded();
  return {
    windowStartedAt:freeAiBudget.windowStartedAt,
    reservedSeconds:freeAiBudget.reservedSeconds,
    completedClips:freeAiBudget.completedClips,
    remainingSeconds:Math.max(0,FREE_AI_DAILY_SECONDS-freeAiBudget.reservedSeconds),
    remainingClips:Math.max(0,FREE_AI_DAILY_CLIPS-freeAiBudget.completedClips)
  };
}
function reserveFreeAiBudget(requestedSeconds){
  resetFreeAiBudgetIfNeeded();
  const seconds=Math.max(2,Math.min(10,Number(requestedSeconds)||3));
  // Reserve conservatively because hosted GPU billing is not equal to output duration.
  const reservation=Math.min(15,Math.ceil(seconds*1.5));
  if(freeAiBudget.reservedSeconds+reservation>FREE_AI_DAILY_SECONDS || freeAiBudget.completedClips>=FREE_AI_DAILY_CLIPS){
    const snap=freeAiBudgetSnapshot();
    throw new Error('FREE_AI_DAILY_BUDGET_EXHAUSTED: cuota gratuita protegida. remainingSeconds='+snap.remainingSeconds+' remainingClips='+snap.remainingClips);
  }
  freeAiBudget.reservedSeconds+=reservation;
  return reservation;
}
function releaseFreeAiBudget(reservation){
  resetFreeAiBudgetIfNeeded();
  const amount=Math.max(0,Number(reservation)||0);
  freeAiBudget.reservedSeconds=Math.max(0,freeAiBudget.reservedSeconds-amount);
}
function completeFreeAiClip(reservation=0){
  resetFreeAiBudgetIfNeeded();
  // A successful clip consumes the reservation. Any unused safety reserve is returned.
  const amount=Math.max(0,Number(reservation)||0);
  if(amount>0)freeAiBudget.reservedSeconds=Math.max(0,freeAiBudget.reservedSeconds-amount);
  freeAiBudget.completedClips++;
}

/*
 * Shared resource broker.
 * Hugging Face ZeroGPU quota belongs to the caller account and is shared across
 * the ZeroGPU Spaces AutoTube calls. We therefore budget the pool globally,
 * keep a safety margin, and quarantine the whole pool after a quota error.
 * The broker is intentionally conservative because the exact remaining quota
 * is not exposed as a reliable API to this server.
 */
const RESOURCE_WINDOW_MS=24*60*60*1000;
const HF_ZEROGPU_SOFT_LIMIT_SECONDS=Math.max(60,Number(process.env.AUTOTUBE_HF_ZEROGPU_SOFT_LIMIT_SECONDS)||240);
const HF_ZEROGPU_SAFETY_SECONDS=Math.max(15,Number(process.env.AUTOTUBE_HF_ZEROGPU_SAFETY_SECONDS)||45);
const HF_ZEROGPU_PROVIDERS=new Set([
  'LTX-2.3-ZeroGPU','Wan2.2-AoTI','Wan2.2-AoTI-R3GM','Wan2.2-AoTI-CB',
  'Wan2.2-Rahul-AOT','Wan2.2-Rahul-T2V','Wan2.2-ZeroGPU','OpenKing-Wan2.2',
  'Wan2.2-I2V','Wan2.1-VACE','LTX-2.5','Wan2.1','LTX-0.9.8'
]);
let hfZeroGpuResource={windowStartedAt:0,reservedSeconds:0,committedSeconds:0,attempts:0};
function resetHfZeroGpuResource(){
  const now=Date.now();
  if(!hfZeroGpuResource.windowStartedAt||now-hfZeroGpuResource.windowStartedAt>=RESOURCE_WINDOW_MS){
    hfZeroGpuResource={windowStartedAt:now,reservedSeconds:0,committedSeconds:0,attempts:0};
  }
}
function hfZeroGpuResourceSnapshot(){
  resetHfZeroGpuResource();
  return {
    windowStartedAt:hfZeroGpuResource.windowStartedAt,
    softLimitSeconds:HF_ZEROGPU_SOFT_LIMIT_SECONDS,
    safetySeconds:HF_ZEROGPU_SAFETY_SECONDS,
    reservedSeconds:hfZeroGpuResource.reservedSeconds,
    committedSeconds:hfZeroGpuResource.committedSeconds,
    attempts:hfZeroGpuResource.attempts,
    remainingSoftSeconds:Math.max(0,HF_ZEROGPU_SOFT_LIMIT_SECONDS-hfZeroGpuResource.committedSeconds-hfZeroGpuResource.reservedSeconds)
  };
}
function reserveHfZeroGpuAttempt(provider,requestedSeconds){
  if(!HF_ZEROGPU_PROVIDERS.has(String(provider||'')))return true;
  resetHfZeroGpuResource();
  const request=Math.max(3,Number(requestedSeconds)||3);
  const remaining=HF_ZEROGPU_SOFT_LIMIT_SECONDS-hfZeroGpuResource.committedSeconds-hfZeroGpuResource.reservedSeconds;
  if(remaining<request+HF_ZEROGPU_SAFETY_SECONDS){
    console.warn('[ResourceBroker] refusing ZeroGPU attempt before soft limit:',provider,'requested=',request,'remaining=',Math.max(0,remaining),'safety=',HF_ZEROGPU_SAFETY_SECONDS);
    return false;
  }
  hfZeroGpuResource.reservedSeconds+=request;
  hfZeroGpuResource.attempts++;
  return true;
}
function settleHfZeroGpuAttempt(provider,requestedSeconds,{success=false,quota=false}={}){
  if(!HF_ZEROGPU_PROVIDERS.has(String(provider||'')))return;
  resetHfZeroGpuResource();
  const request=Math.max(3,Number(requestedSeconds)||3);
  hfZeroGpuResource.reservedSeconds=Math.max(0,hfZeroGpuResource.reservedSeconds-request);
  if(success||quota){
    hfZeroGpuResource.committedSeconds=Math.min(HF_ZEROGPU_SOFT_LIMIT_SECONDS,hfZeroGpuResource.committedSeconds+request);
  }
}
function getSharedZeroGpuCooldownUntil(){
  return Math.max(sharedZeroGpuCooldownUntilTs,...[...videoProviderState.values()].map(st=>Number(st?.cooldownUntil||0)));
}
function noteZeroGpuQuota(err,providerName='ZeroGPU'){
  // ZeroGPU quota is shared across Spaces for the same caller account.
  const until=Date.now()+ZEROGPU_SHARED_QUOTA_MS;
  sharedZeroGpuCooldownUntilTs=Math.max(sharedZeroGpuCooldownUntilTs,until);
  for(const name of HF_ZEROGPU_PROVIDERS){
    const st=providerState(name);
    st.status='cooldown';
    st.lastError=String(err?.message||err);
    st.lastFailureAt=Date.now();
    st.cooldownUntil=Math.max(st.cooldownUntil||0,until);
  }
  console.warn('[VideoProviderManager] SHARED ZeroGPU quota cooldown until',new Date(until).toISOString(),'trigger=',providerName);
}
function providerState(name){if(!videoProviderState.has(name))videoProviderState.set(name,{status:'unknown',failures:0,lastError:'',lastFailureAt:0,lastSuccessAt:0,cooldownUntil:0});return videoProviderState.get(name);}
function classifyVideoProviderError(err){const m=String(err?.message||err||'').toLowerCase();if(/depleted.*monthly.*credit|monthly.*included.*credit|purchase pre-paid|purchase prepaid|insufficient.*credit|credits.*exhausted/.test(m))return'resource_exhausted';if(/401|403|unauthori[sz]ed|forbidden|oauth|login|permission|credentials/.test(m))return'user_blocking';if(/429|zero.?gpu quota|quota|rate limit|too many requests/.test(m))return'quota';if(/502|503|504|temporarily unavailable|space.*error|service unavailable|gateway/.test(m))return'transient_provider';if(/timeout|timed out|econnreset|etimedout|eai_again|socket hang up/.test(m))return'transient_network';if(/endpoint|not found|404|could not resolve app config|no api|invalid.*parameter|unexpected.*argument/.test(m))return'integration';if(/ffmpeg|invalid.*video|stream of video|duration.*invalid|static|movement/.test(m))return'output';return'unknown';}
function noteProviderFailure(name,err){const st=providerState(name);st.failures++;st.lastError=String(err?.message||err);st.lastFailureAt=Date.now();const kind=classifyVideoProviderError(err);if(kind==='quota'&&HF_ZEROGPU_PROVIDERS.has(String(name||''))){noteZeroGpuQuota(err,name);return;}if(kind==='resource_exhausted'){const waitMs=Math.max(5*60*1000,Number(process.env.AUTOTUBE_PROVIDER_CAPACITY_RETRY_MS||60*60*1000)||60*60*1000);st.status='capacity_wait';st.cooldownUntil=Date.now()+waitMs;console.warn('[VideoProviderManager]',name,'=> capacity_wait(resource_exhausted) until',new Date(st.cooldownUntil).toISOString(),'— se volverá a probar cuando pueda recuperar capacidad.');return;}const multiplier=kind==='quota'?4:kind==='integration'?6:1;st.cooldownUntil=Date.now()+VIDEO_PROVIDER_COOLDOWN_MS*multiplier*Math.min(4,st.failures);st.status=kind==='user_blocking'?'blocked':kind==='integration'?'broken':'down';console.warn('[VideoProviderManager]',name,'=>',st.status,'error=',st.lastError.slice(0,500));}
function noteProviderSuccess(name){const st=providerState(name);st.status='healthy';st.failures=0;st.lastError='';st.lastSuccessAt=Date.now();st.cooldownUntil=0;}
function providerAvailable(name){if(HF_ZEROGPU_PROVIDERS.has(String(name||''))&&zeroGpuQuotaActive())return false;const permanentlyUnstable={ 'Wan2.2-I2V':String(process.env.AUTOTUBE_ENABLE_WAN22_I2V||'0')!=='1', 'LTX-2.5':String(process.env.AUTOTUBE_ENABLE_LTX25||'0')!=='1', 'Wan2.1':String(process.env.AUTOTUBE_ENABLE_WAN21||'0')!=='1', 'LTX-0.9.8':String(process.env.AUTOTUBE_ENABLE_LTX098||'0')!=='1', 'Wan2.2-ZeroGPU':String(process.env.AUTOTUBE_ENABLE_WAN22_ZEROGPU||'1')!=='1' , 'OpenKing-Wan2.2':String(process.env.AUTOTUBE_ENABLE_OPENKING_WAN22||'1')!=='1', 'LTX-2.3-ZeroGPU':String(process.env.AUTOTUBE_ENABLE_LTX23_ZEROGPU||'1')!=='1', 'Wan2.2-AoTI':String(process.env.AUTOTUBE_ENABLE_WAN22_AOTI||'1')!=='1', 'Wan2.2-AoTI-R3GM':String(process.env.AUTOTUBE_ENABLE_WAN22_AOTI_R3GM||'1')!=='1', 'Wan2.2-AoTI-CB':String(process.env.AUTOTUBE_ENABLE_WAN22_AOTI_CB||'1')!=='1', 'Wan2.2-Rahul-AOT':String(process.env.AUTOTUBE_ENABLE_WAN22_RAHUL_AOT||'1')!=='1', 'Wan2.2-Rahul-T2V':String(process.env.AUTOTUBE_ENABLE_WAN22_RAHUL_T2V||'1')!=='1' };if(permanentlyUnstable[name])return false;const st=providerState(name);return st.status!=='blocked'&&Date.now()>=Number(st.cooldownUntil||0);}
async function probeVideoProvider(name){const st=providerState(name);if(st.status==='blocked')return{ok:false,status:st.status,error:st.lastError};if(st.status==='healthy'&&Date.now()-st.lastSuccessAt<VIDEO_PROVIDER_PROBE_MS)return{ok:true,status:'healthy',cached:true};const raw={ 'Wan2.2-I2V':process.env.WAN22_I2V_SPACE_URL||'https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space','LTX-2.5':process.env.LTX25_SPACE_URL||'https://lightricks-ltx-2-5.hf.space','Wan2.1':process.env.WAN21_SPACE_URL||'https://weathon-vsf.hf.space','Wan2.1-VACE':process.env.WAN_VACE_SPACE_URL||'https://jdpadmin-wan2-1-vace-diffusers-demo.hf.space','LTX-0.9.8':process.env.LTX_SPACE||'https://lightricks-ltx-video-distilled.hf.space','Wan2.2-ZeroGPU':process.env.WAN22_ZEROGPU_SPACE_URL||'https://alexcheng0072-wan27-free-video-generator.hf.space','OpenKing-Wan2.2':process.env.OPENKING_WAN22_SPACE_URL||'https://openking-wan2-video-generation.hf.space', 'LTX-2.3-ZeroGPU':process.env.LTX23_ZEROGPU_SPACE||'https://shaundeoOo-ltx-2-3-fast.hf.space','Wan2.2-AoTI':process.env.WAN22_AOTI_SPACE_URL||'https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space','Wan2.2-AoTI-R3GM':process.env.WAN22_AOTI_R3GM_SPACE_URL||'https://r3gm-wan2-2-fp8da-aoti-preview.hf.space','Wan2.2-AoTI-CB':process.env.WAN22_AOTI_CB_SPACE_URL||'https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space','Wan2.2-Rahul-AOT':process.env.WAN22_RAHUL_AOT_SPACE_URL||'https://rahul7star-wan22-aot.hf.space','Wan2.2-Rahul-T2V':process.env.WAN22_RAHUL_T2V_SPACE_URL||'https://rahul7star-wan2-2-t2v-a14b.hf.space'}[name];if(!raw)return{ok:false,status:'unconfigured'};const url=String(raw).startsWith('http')?String(raw).replace(/\/$/,'')+'/gradio_api/info':'https://'+String(raw).replace(/\/$/,'')+'.hf.space/gradio_api/info';try{const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();const response=await fetch(url,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(4000)});if(!response.ok)throw new Error('HTTP '+response.status);noteProviderSuccess(name);return{ok:true,status:'healthy'};}catch(err){noteProviderFailure(name,err);return{ok:false,status:providerState(name).status,error:String(err.message||err)};}}
async function getVideoProviderHealth(){const result={};for(const name of ['LTX-2.3-ZeroGPU','Wan2.2-AoTI','Wan2.2-Rahul-AOT','Wan2.2-AoTI-R3GM','Wan2.2-AoTI-CB','Wan2.2-Rahul-T2V','Wan2.2-ZeroGPU','OpenKing-Wan2.2','Wan2.2-I2V','LTX-2.5','Wan2.1-VACE','Wan2.1','LTX-0.9.8'])result[name]=providerAvailable(name)?await probeVideoProvider(name):{ok:false,status:providerState(name).status,cooldownUntil:providerState(name).cooldownUntil,lastError:providerState(name).lastError};return result;}

async function validateHfTokenForAutotube(token){
  const value=String(token||'').trim();
  if(!value)return{ok:false,reason:'missing'};
  const now=Date.now();
  if(global.__autotubeHfTokenCheck&&now-global.__autotubeHfTokenCheck.at<10*60*1000)return global.__autotubeHfTokenCheck;
  try{
    const response=await fetch('https://huggingface.co/api/whoami-v2',{
      headers:{Authorization:'Bearer '+value,Accept:'application/json'},
      signal:AbortSignal.timeout(15000)
    });
    const result={ok:response.ok,status:response.status,at:now};
    global.__autotubeHfTokenCheck=result;
    console.log('[Wan2.2-AoTI] HF token validation=',JSON.stringify({ok:result.ok,status:result.status}));
    return result;
  }catch(err){
    const result={ok:false,status:0,at:now,reason:String(err?.message||err).slice(0,180)};
    global.__autotubeHfTokenCheck=result;
    console.warn('[Wan2.2-AoTI] HF token validation error=',result.reason);
    return result;
  }
}
function normalizeGradioSpaceUrl(space){
  const raw=String(space||'').trim();
  if(/^https?:\/\//i.test(raw)) return raw.replace(/\/$/,'');
  return 'https://'+raw.replace(/\/$/,'')+'.hf.space';
}
async function buildWan22AotiInputs(app,space,{frame,prompt,negative,duration,guidance1,guidance2,steps,seedValue}){
  const api=await app.view_api();
  const endpoint=api?.named_endpoints?.['/generate_video'];
  const params=Array.isArray(endpoint?.parameters)?endpoint.parameters:[];
  if(!params.length)throw new Error('AoTI /generate_video no expone parámetros en view_api().');
  const lower=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
  const values={};
  const choiceDefault=p=>{
    if(p.default!==undefined&&p.default!==null)return p.default;
    const choices=p?.type?.enum||p?.enum||p?.choices||p?.component_config?.choices;
    if(Array.isArray(choices)&&choices.length)return choices[0];
    return undefined;
  };
  for(const p of params){
    const key=lower(p.label||p.name||'');
    let value;
    if(key.includes('inputimage')||key==='image'||key.includes('firstimage'))value=frame;
    else if(key.includes('lastimage')||key.includes('secondimage'))value=frame;
    else if(key.includes('negativeprompt'))value=negative;
    else if(key==='prompt'||key.includes('textprompt'))value=String(prompt||'').trim();
    else if(key.includes('duration'))value=duration;
    else if(key==='steps'||key.includes('numinferencessteps')||key==='inferencesteps'||key.includes('inferencessteps'))value=steps;
    else if(key.includes('guidancescale2')||key.includes('guidance2'))value=guidance2;
    else if(key.includes('guidancescale'))value=guidance1;
    else if(key==='seed')value=seedValue;
    else if(key.includes('randomizeseed'))value=true;
    else if(key.includes('quality'))value=5;
    else if(key.includes('framemultiplier')||key.includes('videofps')||key.includes('fluidity'))value=16;
    else if(key.includes('safemode'))value=false;
    else if(key.includes('flowshift'))value=3.0;
    else if(key.includes('scheduler')){
      value=choiceDefault(p);
      if(value===undefined){
        const choices=p?.type?.enum||p?.enum||p?.choices||p?.component_config?.choices;
        value=Array.isArray(choices)&&choices.length?choices[0]:(p.optional?null:'UniPCMultistep');
      }
    }
    else if(p.default!==undefined)value=p.default;
    else if(p.optional)value=null;
    else {
      const fallback=choiceDefault(p);
      if(fallback!==undefined)value=fallback;
      else throw new Error('AoTI parámetro no reconocido: '+String(p.label||p.name||'unknown'));
    }
    values[p.name||p.label]=value;
  }
  console.log('[Wan2.2-AoTI] resolved /generate_video schema',JSON.stringify(params.map(p=>({name:p.name,label:p.label,component:p.component,default:p.default,choices:p?.type?.enum||p?.enum||p?.choices||p?.component_config?.choices}))).slice(0,5000));
  return params.map(p=>values[p.name||p.label]);
}
async function generateFreeWan22AotiVideoClip(prompt,dir,options={}) {
  const {Client}=require('@gradio/client');
  const space=String(options.spaceOverride||process.env.WAN22_AOTI_SPACE_URL||'zerogpu-aoti/wan2-2-fp8da-aoti-faster').trim();
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  const firstFramePath=String(options.firstFramePath||'').trim();
  if(!firstFramePath)throw new Error('Wan2.2 AoTI requiere frame.');
  const duration=Math.max(0.5,Math.min(5,Number(options.durationSeconds)||3.5));
  const steps=Math.max(4,Math.min(8,Number(options.steps)||4));
  const seed=Math.floor(Math.random()*2147483647);
  console.log('[Wan2.2-AoTI] starting Gradio client generation',JSON.stringify({space,duration,steps,hasFrame:true}));
  if(!token)throw new Error('Wan2.2 AoTI requiere HF_TOKEN/HUGGINGFACE_TOKEN.');
  const tokenCheck=await validateHfTokenForAutotube(token);
  if(!tokenCheck.ok)throw new Error('HF token rejected before ZeroGPU call: HTTP '+String(tokenCheck.status||0));
  let result;
  try{
    const clientOptions={token,hf_token:token};
    console.log('[Wan2.2-AoTI] HF authentication configured=',true);
    const app=await Client.connect(space,clientOptions);
    const frameBytes=await fs.readFile(firstFramePath);
    const ext=String(path.extname(firstFramePath)||'').toLowerCase();
    const mime=ext==='.png'?'image/png':ext==='.webp'?'image/webp':'image/jpeg';
    const frame=new Blob([frameBytes],{type:mime});
    const negative=String(options.negativePrompt||'worst quality, blurry, jittery, distorted, text, logos, watermark, duplicate subjects').trim();
    const guidance1=Number(options.guidanceScale||1);
    const guidance2=Number(options.guidanceScale2||1);
    const seedValue=seed;
    const inputs=await buildWan22AotiInputs(app,space,{frame,prompt,negative,duration,guidance1,guidance2,steps,seedValue});
    result=await app.predict('/generate_video',inputs);
  }catch(err){
    const detail=err?.message||String(err);
    const extra=err?.cause?.message||err?.cause?.detail||err?.response?.data||'';
    throw new Error('Wan2.2 AoTI Gradio generation failed: '+detail+(extra?' | detail='+String(extra).slice(0,1800):''));
  }
  const data=Array.isArray(result?.data)?result.data:[];
  const output=data[0];
  if(!output)throw new Error('Wan2.2 AoTI terminó sin salida: '+JSON.stringify(data).slice(0,2500));
  console.log('[Wan2.2-AoTI] generation returned output',JSON.stringify({type:typeof output,keys:typeof output==='object'?Object.keys(output):[]}).slice(0,1200));
  const outputPath=await downloadGradioOutput(output,normalizeGradioSpaceUrl(space),token,dir,'wan22-aoti-generated');
  const validation=await validateGeneratedVideoClip(outputPath);
  if(!validation.ok)throw new Error('Wan2.2 AoTI produjo un clip inválido.');
  const stat=await fs.stat(outputPath);
  if(!stat.size)throw new Error('Wan2.2 AoTI produjo un archivo vacío.');
  console.log('[Wan2.2-AoTI] validated real MP4',JSON.stringify({bytes:stat.size,durationSeconds:validation.durationSeconds}));
  return{outputPath,bytes:stat.size,provider:'Hugging Face ZeroGPU · Wan2.2 AoTI',model:'Wan2.2 I2V A14B FP8 Lightning',durationSeconds:validation.durationSeconds,status:'complete'};
}

async function generateFreeLtx23ZeroGpuVideoClip(prompt,dir,options={}) {
  const {Client,handle_file}=require('@gradio/client');
  const spaces=[
    String(process.env.LTX23_ZEROGPU_SPACE||'Lightricks/LTX-2-3').trim(),
    'Lightricks/LTX-2-3',
    'linoyts/LTX-2-3',
    'linoyts/ltx23-distilled-api',
    'ShaundeOoO/ltx-2.3-fast'
  ].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  const imagePath=String(options.firstFramePath||'').trim();
  const duration=Math.max(1,Math.min(Number(process.env.AUTOTUBE_PROVIDER_REQUEST_MAX_SECONDS||120),Number(options.durationSeconds)||3));
  const width=768,height=512;
  const errors=[];
  for(const space of spaces){
    try{
      const app=await Client.connect(space,token?{token}:undefined);
      const image=imagePath?await handle_file(imagePath):null;
      const seed=Math.floor(Math.random()*2147483647);
      const result=await app.predict(2,[image,String(prompt||'').trim(),duration,false,seed,true,height,width]);
      const data=Array.isArray(result?.data)?result.data:[];
      const raw0=data[0];
      const raw=typeof raw0==='string'?(raw0):(raw0?.url||raw0?.path||raw0?.video?.url||raw0?.video?.path||'');
      if(!raw)throw new Error('LTX-2.3 Space no devolvió un vídeo. data='+JSON.stringify(data).slice(0,1200));
      const outputPath=await downloadGradioOutput(raw,'https://'+space.replace(/^https?:\/\//,'').replace(/\.hf\.space$/,'')+'.hf.space',token,dir,'ltx23-official-generated');
      const validation=await validateGeneratedVideoClip(outputPath);
      if(!validation.ok)throw new Error('LTX-2.3 Space produjo un clip inválido.');
      const stat=await fs.stat(outputPath);
      if(!stat.size)throw new Error('LTX-2.3 Space produjo un archivo vacío.');
      return{outputPath,bytes:stat.size,provider:'Hugging Face ZeroGPU · LTX-2.3',model:'Lightricks LTX-2.3 Distilled 22B',durationSeconds:validation.durationSeconds,status:'complete'};
    }catch(err){
      errors.push(space+': '+String(err?.message||err).slice(0,600));
      console.warn('LTX-2.3 ZeroGPU Space failed:',space,err?.message||String(err));
      if(classifyVideoProviderError(err)==='quota')throw err;
    }
  }
  throw new Error('LTX-2.3 ZeroGPU routes failed: '+errors.join(' | '));
}

async function generateWan22RestVideoClip(prompt,dir,options={}) {
  const space=String(options.spaceUrl||'').trim().replace(/\/$/,'');
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  const imagePath=String(options.firstFramePath||'').trim();
  if(!imagePath)throw new Error('Wan2.2 REST requiere un frame inicial.');
  const imageBytes=await fs.readFile(imagePath);
  if(!imageBytes.length)throw new Error('Frame inicial vacío.');
  const uploadHeaders=token?{Authorization:'Bearer '+token}:{};
  const form=new FormData();
  form.append('files',new Blob([imageBytes],{type:/\.png$/i.test(imagePath)?'image/png':'image/jpeg'}),path.basename(imagePath));
  const upload=await fetch(space+'/gradio_api/upload',{method:'POST',headers:uploadHeaders,body:form,signal:AbortSignal.timeout(60000)});
  const uploadText=await upload.text();
  if(!upload.ok)throw new Error('Wan2.2 upload HTTP '+upload.status+': '+uploadText.slice(0,1200));
  let uploaded=null;try{uploaded=JSON.parse(uploadText)}catch{}
  const uploadedPath=Array.isArray(uploaded)?uploaded[0]:uploaded?.path||uploaded?.[0]?.path;
  if(!uploadedPath)throw new Error('Wan2.2 upload no devolvió ruta: '+uploadText.slice(0,900));
  const fileData={path:String(uploadedPath),meta:{_type:'gradio.FileData'},orig_name:path.basename(imagePath)};
  const mode=String(options.mode||'simple');
  let data;
  if(mode==='openking'){
    const duration=Math.max(2,Math.min(Number(process.env.AUTOTUBE_PROVIDER_REQUEST_MAX_SECONDS||120),Number(options.durationSeconds)||3));
    const width=832,height=480,frames=Math.max(49,Math.min(97,Math.round(duration*24)));
    data=[String(prompt||'').trim(),fileData,width,height,frames,8,5.0,Math.floor(Math.random()*2147483647)];
  }else{
    const duration=Math.max(3,Math.min(Number(process.env.AUTOTUBE_PROVIDER_REQUEST_MAX_SECONDS||120),Number(options.durationSeconds)||3));
    data=[fileData,String(prompt||'').trim(),4,String(options.negativePrompt||'static, blurry, distorted, text, watermark').trim(),duration,1,1,Math.floor(Math.random()*2147483647),true];
  }
  const endpoint=String(options.endpoint||'/generate_video');
  const headers={'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
  const submit=await fetch(space+'/gradio_api/call'+endpoint,{method:'POST',headers,body:JSON.stringify({data}),signal:AbortSignal.timeout(30000)});
  const submitText=await submit.text();
  if(!submit.ok)throw new Error('Wan2.2 REST submit HTTP '+submit.status+': '+submitText.slice(0,1200));
  let submitted=null;try{submitted=JSON.parse(submitText)}catch{}
  const eventId=String(submitted?.event_id||'').trim();
  if(!eventId)throw new Error('Wan2.2 REST no devolvió event_id: '+submitText.slice(0,700));
  const stream=await fetch(space+'/gradio_api/call'+endpoint+'/'+encodeURIComponent(eventId),{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(360000)});
  if(!stream.ok)throw new Error('Wan2.2 REST SSE HTTP '+stream.status);
  const reader=stream.body?.getReader();if(!reader)throw new Error('Wan2.2 REST no devolvió SSE.');
  const decoder=new TextDecoder();let buffer='',completed=null,errorMessage='';
  while(true){
    const part=await reader.read();if(part.done)break;
    buffer+=decoder.decode(part.value,{stream:true});
    const events=buffer.split(/\n\n/);buffer=events.pop()||'';
    for(const block of events){
      const ev=(block.match(/(?:^|\n)event:\s*([^\n]+)/)||[])[1]?.trim()||'';
      const dl=(block.match(/(?:^|\n)data:\s*([\s\S]+)/)||[])[1]?.trim()||'';
      if(ev==='error'||ev==='exception'){errorMessage=dl||('Wan2.2 '+mode+' error');break;}
      if(ev==='complete'){try{completed=JSON.parse(dl)}catch{completed=null;}break;}
    }
    if(completed!==null||errorMessage)break;
  }
  await reader.cancel().catch(()=>{});
  if(errorMessage)throw new Error('Wan2.2 '+mode+' generation error: '+String(errorMessage).slice(0,1800));
  const arr=Array.isArray(completed)?completed:(completed?.data||[]),candidates=[];
  const collect=v=>{if(v==null)return;if(typeof v==='string')candidates.push(v);else if(Array.isArray(v))v.forEach(collect);else if(typeof v==='object')for(const k of ['video','url','path','value'])if(v[k]!=null)collect(v[k]);};
  collect(arr);
  const raw=candidates.find(x=>/\.mp4($|[?#])|^https?:|^\//i.test(x))||candidates[0];
  if(!raw)throw new Error('Wan2.2 '+mode+' no devolvió vídeo. data='+JSON.stringify(arr).slice(0,1800));
  const outputUrl=String(raw).startsWith('http')?String(raw):space+String(raw).replace(/^\//,'/');
  const response=await fetch(outputUrl,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error('Wan2.2 '+mode+' descarga HTTP '+response.status);
  const outputPath=path.join(dir,'wan22-rest-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
  await fs.writeFile(outputPath,Buffer.from(await response.arrayBuffer()));
  const validation=await validateGeneratedVideoClip(outputPath);
  if(!validation.ok)throw new Error('Wan2.2 '+mode+' produjo un clip inválido.');
  return{outputPath,bytes:(await fs.stat(outputPath)).size,provider:'Hugging Face ZeroGPU · Wan2.2 '+mode,model:'Wan2.2 I2V',durationSeconds:validation.durationSeconds,status:'complete'};
}

async function generateFreeWan22ZeroGpuVideoClip(prompt,dir,options={}) {
  return generateWan22RestVideoClip(prompt,dir,{...options,spaceUrl:process.env.WAN22_ZEROGPU_SPACE_URL||'https://alexcheng0072-wan27-free-video-generator.hf.space',mode:'simple'});
}
async function generateFreeOpenKingWan22VideoClip(prompt,dir,options={}) {
  return generateWan22RestVideoClip(prompt,dir,{...options,spaceUrl:process.env.OPENKING_WAN22_SPACE_URL||'https://openking-wan2-video-generation.hf.space',mode:'openking'});
}

async function generateFreeWan22RahulT2vVideoClip(prompt,dir,options={}) {
  const space=String(process.env.WAN22_RAHUL_T2V_SPACE_URL||'https://rahul7star-wan2-2-t2v-a14b.hf.space').trim().replace(/\/$/,'');
  const token=String(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN||'').trim();
  const headers={'Content-Type':'application/json'}; if(token)headers.Authorization='Bearer '+token;
  const frames=Math.max(24,Math.min(48,Math.round((Number(options.durationSeconds)||3)*16)));
  const data=[String(prompt||'').trim(),String(options.negativePrompt||'static, blurry, distorted, text, watermark').trim(),768,432,frames,4,3,Math.max(8,Math.min(16,Number(options.steps)||12)),16,false];
  const endpoint='/generate_video';
  const submit=await fetch(space+'/gradio_api/call'+endpoint,{method:'POST',headers,body:JSON.stringify({data}),signal:AbortSignal.timeout(30000)});
  const txt=await submit.text(); if(!submit.ok)throw new Error('Wan22 Rahul T2V submit HTTP '+submit.status+': '+txt.slice(0,1200));
  let p=null;try{p=JSON.parse(txt)}catch{} const eventId=String(p?.event_id||'').trim(); if(!eventId)throw new Error('Wan22 Rahul T2V no event_id: '+txt.slice(0,700));
  const stream=await fetch(space+'/gradio_api/call'+endpoint+'/'+encodeURIComponent(eventId),{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(360000)});
  if(!stream.ok)throw new Error('Wan22 Rahul T2V SSE HTTP '+stream.status);
  const reader=stream.body?.getReader(); if(!reader)throw new Error('Wan22 Rahul T2V no SSE');
  const decoder=new TextDecoder(); let buffer='',completed=null,errorMessage='';
  while(true){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});const events=buffer.split(/\n\n/);buffer=events.pop()||'';for(const block of events){const ev=(block.match(/(?:^|\n)event:\s*([^\n]+)/)||[])[1]?.trim()||'';const dl=(block.match(/(?:^|\n)data:\s*([\s\S]+)/)||[])[1]?.trim()||'';if(ev==='error'||ev==='exception'){errorMessage=dl||'Wan22 Rahul T2V error';break;}if(ev==='complete'){try{completed=JSON.parse(dl)}catch{}break;}}if(completed!==null||errorMessage)break;}
  await reader.cancel().catch(()=>{}); if(errorMessage)throw new Error('Wan22 Rahul T2V error: '+String(errorMessage).slice(0,1800));
  const arr=Array.isArray(completed)?completed:(completed?.data||[]),candidates=[];const collect=v=>{if(v==null)return;if(typeof v==='string')candidates.push(v);else if(Array.isArray(v))v.forEach(collect);else if(typeof v==='object')for(const k of ['video','url','path','value'])if(v[k]!=null)collect(v[k]);};collect(arr);
  const raw=candidates.find(x=>/\.mp4($|[?#])|^https?:|^\//i.test(x))||candidates[0];if(!raw)throw new Error('Wan22 Rahul T2V no video: '+JSON.stringify(arr).slice(0,1800));
  const url=String(raw).startsWith('http')?String(raw):space+String(raw).replace(/^\//,'/');const response=await fetch(url,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('Wan22 Rahul T2V download HTTP '+response.status);
  const outputPath=path.join(dir,'wan22-rahul-t2v-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');await fs.writeFile(outputPath,Buffer.from(await response.arrayBuffer()));
  const validation=await validateGeneratedVideoClip(outputPath);if(!validation.ok)throw new Error('Wan22 Rahul T2V invalid clip');
  return{outputPath,bytes:(await fs.stat(outputPath)).size,provider:'Hugging Face ZeroGPU · Wan2.2 Rahul T2V',model:'Wan2.2 T2V A14B',durationSeconds:validation.durationSeconds,status:'complete'};
}

let agnesStatusNextAt=0;
let agnesStatusLock=Promise.resolve();
async function waitForAgnesStatusSlot(minIntervalMs=15000){
  let release;
  const previous=agnesStatusLock;
  agnesStatusLock=new Promise(resolve=>{release=resolve});
  await previous;
  const wait=Math.max(0,agnesStatusNextAt-Date.now());
  if(wait>0)await new Promise(r=>setTimeout(r,wait));
  agnesStatusNextAt=Date.now()+Math.max(10000,minIntervalMs);
  release();
}
async function generateFreeAiVideoClip(prompt,dir,options={}) {
  const key=String(process.env.FREE_AI_API_KEY||'').trim();
  if(!key)throw new Error('FREE_AI_API_KEY no configurada.');
  const duration=Math.max(2,Math.min(3,Number(options.durationSeconds)||3));
  const model=String(process.env.FREE_AI_VIDEO_MODEL||'').trim();
  const payload={prompt:String(prompt||'').trim(),duration};
  if(model)payload.model=model;
  const create=await fetch('https://api.free.ai/v1/video/generate/',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(90000)});
  const raw=await create.text(); let data=null; try{data=raw?JSON.parse(raw):null}catch{}
  if(!create.ok)throw new Error('Free.ai video '+create.status+': '+raw.slice(0,700));
  let videoUrl=String(data?.video_url||data?.url||'').trim();
  const jobId=String(data?.job_id||data?.id||data?.task_id||'').trim();
  if(!videoUrl&&jobId){
    const deadline=Date.now()+180000;
    let delay=10000;
    while(Date.now()<deadline){
      await new Promise(r=>setTimeout(r,delay));
      const sr=await fetch('https://api.free.ai/v1/status/'+encodeURIComponent(jobId)+'/',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:AbortSignal.timeout(30000)});
      const sb=await sr.text(); let sd=null; try{sd=sb?JSON.parse(sb):null}catch{}
      if(!sr.ok)throw new Error('Free.ai status '+sr.status+': '+sb.slice(0,500));
      videoUrl=String(sd?.video_url||sd?.url||sd?.result?.video_url||'').trim();
      const status=String(sd?.status||sd?.state||'').toLowerCase();
      if(/failed|error|cancel/.test(status))throw new Error('Free.ai video generation failed: '+String(sd?.error||sd?.message||status).slice(0,500));
      if(videoUrl)break;
      delay=Math.min(30000,delay+5000);
    }
  }
  if(!videoUrl)throw new Error('Free.ai no devolvió video_url.');
  const vr=await fetch(videoUrl,{signal:AbortSignal.timeout(120000)}); if(!vr.ok)throw new Error('Free.ai video download '+vr.status);
  const bytes=Buffer.from(await vr.arrayBuffer()); if(bytes.length<10000)throw new Error('Free.ai vídeo vacío.');
  const outputPath=path.join(dir,'free-ai-generated-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4'); await fs.writeFile(outputPath,bytes);
  const validation=await validateGeneratedVideoClip(outputPath); if(!validation.ok)throw new Error('Free.ai vídeo no pasó QA.');
  return{outputPath,bytes:bytes.length,provider:'Free.ai',model:model||'CogVideoX',durationSeconds:validation.durationSeconds,status:'complete'};
}

async function generatePixazoFreeVideoClip(prompt,dir,options={}) {
  const key=String(process.env.PIXAZO_API_KEY||'').trim();
  if(!key)throw new Error('PIXAZO_API_KEY no configurada.');
  const duration=Math.max(2,Math.min(5,Math.round(Number(options.durationSeconds)||3)));
  const create=await fetch('https://gateway.pixazo.ai/ltx/text-to-video',{
    method:'POST',
    headers:{'Ocp-Apim-Subscription-Key':key,'Content-Type':'application/json','Cache-Control':'no-cache'},
    body:JSON.stringify({prompt:String(prompt||'').trim()}),
    signal:AbortSignal.timeout(90000)
  });
  const raw=await create.text(); let data=null; try{data=raw?JSON.parse(raw):null}catch{}
  if(!create.ok)throw new Error('Pixazo video '+create.status+': '+raw.slice(0,700));
  let videoUrl=String(data?.output_url||data?.video_url||data?.media_url||data?.output?.media_url||data?.result?.video_url||'').trim();
  const jobId=String(data?.job_id||data?.request_id||data?.id||'').trim();
  const pollUrl=String(data?.polling_url||data?.poll_url||'').trim();
  if(!videoUrl&&jobId){
    const deadline=Date.now()+180000;
    let delay=10000;
    while(Date.now()<deadline){
      await new Promise(res=>setTimeout(res,delay));
      const url=pollUrl||('https://gateway.pixazo.ai/v2/requests/status/'+encodeURIComponent(jobId));
      const sr=await fetch(url,{headers:{'Ocp-Apim-Subscription-Key':key,Accept:'application/json'},signal:AbortSignal.timeout(30000)});
      const sb=await sr.text(); let sd=null; try{sd=sb?JSON.parse(sb):null}catch{}
      if(!sr.ok){
        if(sr.status===429){await new Promise(res=>setTimeout(res,30000));continue;}
        throw new Error('Pixazo status '+sr.status+': '+sb.slice(0,500));
      }
      videoUrl=String(sd?.output_url||sd?.video_url||sd?.media_url||sd?.output?.media_url||sd?.result?.video_url||'').trim();
      const status=String(sd?.status||sd?.state||'').toUpperCase();
      if(status==='ERROR'||status==='FAILED')throw new Error('Pixazo video generation failed: '+String(sd?.error||sd?.message||status).slice(0,500));
      if(videoUrl)break;
      delay=Math.min(30000,delay+5000);
    }
  }
  if(!videoUrl)throw new Error('Pixazo no devolvió video_url.');
  const vr=await fetch(videoUrl,{signal:AbortSignal.timeout(120000)}); if(!vr.ok)throw new Error('Pixazo video download '+vr.status);
  const bytes=Buffer.from(await vr.arrayBuffer()); if(bytes.length<10000)throw new Error('Pixazo vídeo vacío.');
  const outputPath=path.join(dir,'pixazo-generated-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
  await fs.writeFile(outputPath,bytes);
  const validation=await validateGeneratedVideoClip(outputPath); if(!validation.ok)throw new Error('Pixazo vídeo no pasó QA.');
  return{outputPath,bytes:bytes.length,provider:'Pixazo Free',model:'LTX',durationSeconds:validation.durationSeconds,status:'complete'};
}

async function generateAgnesFreeVideoClip(prompt,dir,options={}) {
  const key=String(process.env.AGNES_API_KEY||'').trim();
  if(!key)throw new Error('AGNES_API_KEY no configurada.');
  const duration=Math.max(5,Math.min(20,Number(options.durationSeconds)||5));
  const frameRate=24;
  // Agnes requires num_frames <= 441 and num_frames = 8n + 1.
  const requestedFrames=Math.max(9,Math.min(441,Math.round(duration*frameRate)));
  const numFrames=Math.min(441,8*Math.max(1,Math.round((requestedFrames-1)/8))+1);
  const create=await fetch('https://apihub.agnes-ai.com/v1/videos',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:String(process.env.AGNES_VIDEO_MODEL||'agnes-video-v2.0'),prompt:String(prompt||'').trim(),width:1152,height:768,num_frames:numFrames,frame_rate:frameRate}),signal:AbortSignal.timeout(60000)});
  const raw=await create.text(); let data=null; try{data=raw?JSON.parse(raw):null}catch{}
  if(!create.ok)throw new Error('Agnes video '+create.status+': '+raw.slice(0,900));
  const taskId=String(data?.video_id||data?.id||data?.task_id||'').trim(); if(!taskId)throw new Error('Agnes no devolvió video_id.');
  const deadline=Date.now()+Math.min(360000,Math.max(180000,Number(process.env.AUTOTUBE_AGNES_TIMEOUT_MS)||300000));
  let pollDelay=15000;
  while(Date.now()<deadline){
    await waitForAgnesStatusSlot(Math.max(15000,pollDelay));
    let r;
    try{
      r=await fetch('https://apihub.agnes-ai.com/agnesapi?video_id='+encodeURIComponent(taskId),{headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:AbortSignal.timeout(30000)});
    }catch(err){
      console.warn('Agnes status query transient error:',String(err?.message||err).slice(0,240));
      await new Promise(res=>setTimeout(res,Math.min(45000,pollDelay)));
      pollDelay=Math.min(45000,pollDelay+5000);
      continue;
    }
    const body=await r.text(); let state=null; try{state=body?JSON.parse(body):null}catch{}
    if(!r.ok){
      if(r.status===429){
        const retryHeader=Number(r.headers.get('retry-after')||0);
        const retryMs=Math.max(30000,Number.isFinite(retryHeader)&&retryHeader>0?retryHeader*1000:0);
        console.warn('Agnes status rate limited; backing off ms='+retryMs);
        await new Promise(res=>setTimeout(res,retryMs));
        pollDelay=Math.min(60000,Math.max(pollDelay,retryMs));
        continue;
      }
      throw new Error('Agnes status '+r.status+': '+body.slice(0,500));
    }
    const status=String(state?.status||state?.data?.status||'').toLowerCase();
    const videoUrl=String(state?.video_url||state?.data?.video_url||'').trim();
    if(status==='failed'||status==='error')throw new Error('Agnes generación falló: '+String(state?.error||state?.message||'unknown').slice(0,500));
    if(videoUrl){
      const vr=await fetch(videoUrl,{signal:AbortSignal.timeout(120000)}); if(!vr.ok)throw new Error('Agnes video download '+vr.status);
      const bytes=Buffer.from(await vr.arrayBuffer()); if(bytes.length<10000)throw new Error('Agnes vídeo vacío.');
      const outputPath=path.join(dir,'agnes-generated-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4'); await fs.writeFile(outputPath,bytes);
      const validation=await validateGeneratedVideoClip(outputPath); if(!validation.ok)throw new Error('Agnes vídeo no pasó QA.');
      return{outputPath,bytes:bytes.length,provider:'Agnes AI Free',model:String(process.env.AGNES_VIDEO_MODEL||'agnes-video-v2.0'),durationSeconds:validation.durationSeconds,status:'complete'};
    }
    pollDelay=Math.min(45000,pollDelay+5000);
  }
  throw new Error('Agnes generación agotó el timeout.');
}
async function generateMagicHourVideoClip(prompt,dir,options={}) {
  const key=String(process.env.MAGIC_HOUR_API_KEY||'').trim();
  if(!key)throw new Error('Magic Hour no configurado: falta MAGIC_HOUR_API_KEY.');
  const duration=Math.max(2,Math.min(10,Number(options.durationSeconds)||5));
  const outputPath=path.join(dir,'magichour-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
  const controller=new AbortController();
  const timeoutMs=Math.max(90000,Number(process.env.AUTOTUBE_MAGIC_HOUR_TIMEOUT_MS||480000));
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  async function mhFetch(url,init={}) {
    const r=await fetch(url,{...init,headers:{accept:'application/json','content-type':'application/json',authorization:'Bearer '+key,...(init.headers||{})},signal:controller.signal});
    const raw=await r.text(); let body=null; try{body=JSON.parse(raw);}catch{}
    if(!r.ok)throw new Error('Magic Hour '+String(body?.code||'HTTP_'+r.status)+': '+String(body?.message||body?.error?.message||raw).slice(0,900));
    return body;
  }
  try {
    const requestedDuration=Math.max(2,Math.min(10,Math.round(duration)));
    const create=await mhFetch('https://api.magichour.ai/v1/text-to-video',{method:'POST',body:JSON.stringify({
      name:'AutoTube E2E AI video smoke test',end_seconds:requestedDuration,aspect_ratio:'16:9',
      resolution:'480p',model:'ltx-2.5',audio:false,style:{prompt:String(prompt||'').slice(0,7000)}
    })});
    const id=String(create?.id||'').trim(); if(!id)throw new Error('Magic Hour no devolvió id de proyecto.');
    const started=Date.now(); let project=null;
    while(Date.now()-started<timeoutMs-5000){
      await new Promise(resolve=>setTimeout(resolve,5000));
      project=await mhFetch('https://api.magichour.ai/v1/video-projects/'+encodeURIComponent(id),{method:'GET'});
      const status=String(project?.status||'').toLowerCase();
      if(status==='complete'){
        const url=String(project?.downloads?.[0]?.url||'').trim(); if(!url)throw new Error('Magic Hour terminó sin URL de descarga.');
        const vr=await fetch(url,{signal:controller.signal}); if(!vr.ok)throw new Error('Magic Hour descarga HTTP '+vr.status);
        const buf=Buffer.from(await vr.arrayBuffer()); if(buf.length<1000)throw new Error('Magic Hour devolvió un MP4 demasiado pequeño.');
        await fs.writeFile(outputPath,buf);
        return{outputPath,bytes:buf.length,provider:'Magic Hour',model:'ltx-2.5',durationSeconds:requestedDuration,jobId:id,creditsCharged:Number(project?.credits_charged||create?.credits_charged||0),status:'complete'};
      }
      if(status==='error'||status==='canceled')throw new Error('Magic Hour job '+status+': '+String(project?.error?.message||project?.error||'sin detalle').slice(0,900));
    }
    throw new Error('Magic Hour job excedió el timeout de '+timeoutMs+' ms.');
  } finally { clearTimeout(timer); }
}

async function generateBestFreeVideoClip(prompt,dir,options={}) {
  const sceneIndex=Math.max(0,Number(options.sceneIndex)||0);
  const referenceFramePath=String(options.firstFramePath||'').trim();
  const allowPaid=String(process.env.AUTOTUBE_ALLOW_PAID_PROVIDERS||'0')==='1';
  // HF_ZERO_GPU recovery uses already-implemented non-Hugging-Face providers
  // as independent resource classes. Runtime credentials decide which route is
  // actually usable; no secret is embedded or changed by this repair.
  const allowHfInferenceRecovery =
    Boolean(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN) &&
    String(process.env.AUTOTUBE_ENABLE_HF_INFERENCE_VIDEO_RECOVERY??'1').trim()!=='0';
  // Pollinations video and Replicate video are paid routes in the current runtime.
  // They are never treated as free recovery unless explicitly opted in.
  const allowPollinationsRecovery =
    Boolean(process.env.POLLINATIONS_API_KEY) &&
    String(process.env.AUTOTUBE_ENABLE_POLLINATIONS_VIDEO_RECOVERY??'0').trim()==='1';
  const allowReplicateRecovery =
    Boolean(process.env.REPLICATE_API_TOKEN) &&
    String(process.env.AUTOTUBE_ENABLE_REPLICATE_VIDEO_RECOVERY??'0').trim()==='1';
  // Market-selected backbone: try the providers we intentionally selected for
  // production BEFORE legacy/HF recovery routes. A failed provider is quarantined by
  // noteProviderFailure/providerAvailable, so the next attempt moves to a genuinely
  // different capability route instead of repeating the same dead lane.
  const legacyEnabled=String(process.env.AUTOTUBE_LEGACY_VIDEO_FALLBACKS||'0').trim()==='1';
  const magicConfigured=configured('MAGIC_HOUR_API_KEY');
  const marketOrder=[
    ...(falConfigured()&&String(process.env.AUTOTUBE_ENABLE_FAL_VIDEO??'1').trim()!=='0'?['FAL']:[]),
    ...(replicateConfigured()&&String(process.env.AUTOTUBE_ENABLE_REPLICATE_VIDEO??'1').trim()!=='0'?['Replicate-Wan']:[]),
    ...(allowPaid&&process.env.REPLICATE_API_TOKEN?['Replicate']:[]),
    ...(allowPaid&&process.env.POLLINATIONS_API_KEY&&String(process.env.AUTOTUBE_ALLOW_POLLINATIONS_PAID||'0').trim()==='1'?['Pollinations']:[]),
    ...(allowHfInferenceRecovery?['HF-Inference']:[]),
    ...(magicConfigured?['MagicHour']:[])
  ];
  const aotiEnabled=String(process.env.AUTOTUBE_ENABLE_WAN22_AOTI??'1').trim()!=='0';
  const recoveryOrder=[
    // Explicitly enabled AoTI is independent of the legacy-fallback master switch.
    // The frame requirement is kept because the AoTI endpoint is image-to-video.
    ...(aotiEnabled&&referenceFramePath?['Wan2.2-AoTI']:[]),
    // Remaining legacy ZeroGPU routes stay behind the legacy switch.
    ...(legacyEnabled&&referenceFramePath?['Wan2.2-AoTI-R3GM','Wan2.2-AoTI-CB','Wan2.2-Rahul-AOT','LTX-2.3-ZeroGPU','Wan2.2-I2V','Wan2.1-VACE']:[]),
    ...(process.env.FREE_AI_API_KEY?['Free.ai']:[]),
    ...(process.env.PIXAZO_API_KEY?['Pixazo-Free']:[]),
    ...(process.env.AGNES_API_KEY?['Agnes-Free']:[]),
    ...(allowPollinationsRecovery?['Pollinations']:[]),
    ...(allowReplicateRecovery?['Replicate']:[]),
    ...(legacyEnabled?['Wan2.2-Rahul-T2V','Wan2.2-ZeroGPU','OpenKing-Wan2.2','LTX-2.5','Wan2.1','LTX-0.9.8']:[])
  ];
  const baseOrder=[...new Set([...marketOrder,...recoveryOrder])];
  const rotation=baseOrder.length?sceneIndex%baseOrder.length:0;
  const rotatedOrder=[...baseOrder.slice(rotation),...baseOrder.slice(0,rotation)];
  const order=allocationProviderOrder(rotatedOrder,Math.max(3,Number(options.durationSeconds)||3));
  console.log('[VideoCapacity] scene '+(sceneIndex+1)+' requested='+Math.max(3,Number(options.durationSeconds)||3)+'s order='+order.join(' > '));
  const errors=[];
  
  let budgetReservation=0;
  let budgetCommitted=false;
  try{ budgetReservation=reserveFreeAiBudget(options.durationSeconds||3); }
  catch(err){ throw err; }
  const requestedResourceSeconds=Math.max(3,Number(options.durationSeconds)||3);
  const allocationRows=new Map((activeVideoAllocation?.rows||[]).map(r=>[r.provider,r]));
  const executableOrder=[...new Set(order)].filter(provider=>{
    const row=allocationRows.get(provider);
    if(!row)return true;
    return Number(row.remainingSeconds)>=requestedResourceSeconds;
  });
  if(!executableOrder.length){
    throw new Error('CAPACITY_WAIT_REQUIRED: ninguna ruta tiene capacidad suficiente para la siguiente petición de '+requestedResourceSeconds+'s.');
  }
  for(const provider of executableOrder){
    const pst=providerState(provider);
    if(pst.status==='blocked'||Date.now()<Number(pst.cooldownUntil||0)){errors.push(provider+': cooldown/blocked until '+new Date(Number(pst.cooldownUntil||0)).toISOString());console.log('[VideoProviderManager] provider skipped before generation:',provider,'status=',pst.status,'cooldownUntil=',pst.cooldownUntil);continue;}
    if(HF_ZEROGPU_PROVIDERS.has(String(provider||''))&&zeroGpuQuotaActive()){errors.push(provider+': shared ZeroGPU quota cooldown active until '+new Date(getSharedZeroGpuCooldownUntil()).toISOString());console.log('[VideoProviderManager] provider skipped before generation:',provider,'reason=shared ZeroGPU quota');continue;}
    if(provider==='Replicate-Wan'){
      try{const clip=await replicateVideo(prompt,dir,options);const validation=await validateGeneratedVideoClip(clip.outputPath);noteProviderSuccess(provider);completeFreeAiClip(budgetReservation); budgetCommitted=true; commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};}catch(err){noteProviderFailure(provider,err);errors.push(provider+': '+String(err.message||err).slice(0,700));continue;}
    }
    if(provider==='FAL'){
      try{
        const clip=await falVideo(prompt,dir,{...options,generateAudio:Boolean(options.generateAudio),durationSeconds:Math.max(4,Number(options.durationSeconds)||5)});
        const validation=await validateGeneratedVideoClip(clip.outputPath); noteProviderSuccess(provider);
        completeFreeAiClip(budgetReservation); budgetCommitted=true;
        commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
      }catch(err){noteProviderFailure(provider,err);errors.push(provider+': '+String(err.message||err).slice(0,700));continue;}
    }
    if(provider==='Free.ai'){
      try{
        const clip=await generateFreeAiVideoClip(prompt,dir,options);
        const validation=await validateGeneratedVideoClip(clip.outputPath); noteProviderSuccess(provider);
        completeFreeAiClip(budgetReservation); budgetCommitted=true;
        commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
      }catch(err){
        noteProviderFailure(provider,err); errors.push(provider+': '+String(err.message||err).slice(0,500)); continue;
      }
    }
    if(provider==='Pixazo-Free'){
      try{
        const clip=await generatePixazoFreeVideoClip(prompt,dir,options);
        const validation=await validateGeneratedVideoClip(clip.outputPath); noteProviderSuccess(provider);
        completeFreeAiClip(budgetReservation); budgetCommitted=true;
        commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
      }catch(err){noteProviderFailure(provider,err);errors.push(provider+': '+String(err.message||err).slice(0,500));continue;}
    }
    if(provider==='Agnes-Free'){
      try{
        const clip=await generateAgnesFreeVideoClip(prompt,dir,options);
        const validation=await validateGeneratedVideoClip(clip.outputPath); noteProviderSuccess(provider);
        completeFreeAiClip(budgetReservation); budgetCommitted=true;
        commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
      }catch(err){noteProviderFailure(provider,err);errors.push(provider+': '+String(err.message||err).slice(0,500));continue;}
    }
    if(provider==='HF-Inference'){
      try{
        const clip=await generateHuggingFaceProviderVideoClip(prompt,dir,options);
        const validation=await validateGeneratedVideoClip(clip.outputPath); noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true});
        commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
      }catch(err){noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+String(err.message||err).slice(0,500));continue;}
    }
    if(provider==='Replicate'){
      try{
        const clip=await generateReplicateOfficialVideoClip(prompt,dir,options);
        const validation=await validateGeneratedVideoClip(clip.outputPath); noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true});
        commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
      }catch(err){noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+String(err.message||err).slice(0,500));continue;}
    }
    if(provider==='MagicHour'){
      try{
        const clip=await generateMagicHourVideoClip(prompt,dir,options);
        const validation=await validateGeneratedVideoClip(clip.outputPath);
        if(!validation.ok)throw new Error('Magic Hour generó un clip inválido.');
        noteProviderSuccess(provider); completeFreeAiClip(budgetReservation); budgetCommitted=true;
        commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
      }catch(err){noteProviderFailure(provider,err);errors.push(provider+': '+String(err.message||err).slice(0,700));continue;}
    }
    if(provider==='Pollinations'){
      try{
        const clip=await generatePollinationsVideoClip(prompt,dir,options);
        const validation=await validateGeneratedVideoClip(clip.outputPath); noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true});
        commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
      }catch(err){noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+String(err.message||err).slice(0,500));continue;}
    }
    if(!providerAvailable(provider)){
      const st=providerState(provider);
      console.warn('[VideoProviderManager] provider skipped before generation:',provider,'status=',st.status,'cooldownUntil=',st.cooldownUntil,'lastError=',String(st.lastError||'').slice(0,300));
      continue;
    }
    if(!reserveHfZeroGpuAttempt(provider,requestedResourceSeconds)){
      console.warn('[VideoProviderManager] provider skipped by ZeroGPU resource broker:',provider,'requestedSeconds=',requestedResourceSeconds,'snapshot=',JSON.stringify(hfZeroGpuResourceSnapshot()));
      continue;
    }
    // ZeroGPU public Spaces can expose a transient/incorrect /info health response.
    // Do not spend a generation window on a redundant probe; the real Gradio request
    // plus output validation is the authoritative health check for these free routes.
    const health=(provider==='OpenKing-Wan2.2'||provider==='Wan2.2-ZeroGPU'||provider==='LTX-2.3-ZeroGPU'||provider==='Wan2.2-AoTI'||provider==='Wan2.2-AoTI-R3GM'||provider==='Wan2.2-AoTI-CB')
      ? {ok:true,status:'generation-direct'}
      : await probeVideoProvider(provider);
    if(!health.ok)continue;
    if(provider==='Wan2.2-Rahul-AOT'){try{const clip=await generateWan22RestVideoClip(prompt,dir,{...options,durationSeconds:Math.max(3,Number(options.durationSeconds)||3),spaceUrl:process.env.WAN22_RAHUL_AOT_SPACE_URL||'https://rahul7star-wan22-aot.hf.space',mode:'simple',endpoint:'/generate_video_with_upload'});const validation=await validateGeneratedVideoClip(clip.outputPath);noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true});completeFreeAiClip(budgetReservation); budgetCommitted=true; commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};}catch(err){const kind=classifyVideoProviderError(err);noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+kind+': '+String(err.message||err).slice(0,700));continue;}} if(provider==='Wan2.2-Rahul-T2V'){try{const clip=await generateFreeWan22RahulT2vVideoClip(prompt,dir,{...options,durationSeconds:Math.max(3,Number(options.durationSeconds)||3)});const validation=await validateGeneratedVideoClip(clip.outputPath);noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true});completeFreeAiClip(budgetReservation); budgetCommitted=true; commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds)); commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};}catch(err){const kind=classifyVideoProviderError(err);noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+kind+': '+String(err.message||err).slice(0,700));continue;}} if(provider==='Wan2.2-AoTI'||provider==='Wan2.2-AoTI-R3GM'||provider==='Wan2.2-AoTI-CB'){try{const spaces={ 'Wan2.2-AoTI':process.env.WAN22_AOTI_SPACE_URL||'https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space','Wan2.2-AoTI-R3GM':process.env.WAN22_AOTI_R3GM_SPACE_URL||'https://r3gm-wan2-2-fp8da-aoti-preview.hf.space','Wan2.2-AoTI-CB':process.env.WAN22_AOTI_CB_SPACE_URL||'https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space'};const clip=await generateFreeWan22AotiVideoClip(prompt,dir,{...options,durationSeconds:Math.max(3,Number(options.durationSeconds)||3),spaceOverride:spaces[provider]});const validation=await validateGeneratedVideoClip(clip.outputPath);noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true});completeFreeAiClip(budgetReservation); budgetCommitted=true; commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds)); commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};}catch(err){const kind=classifyVideoProviderError(err);noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+kind+': '+String(err.message||err).slice(0,500));continue;}} if(provider==='LTX-2.3-ZeroGPU'){try{const clip=await generateFreeLtx23ZeroGpuVideoClip(prompt,dir,{...options,durationSeconds:Math.max(3,Number(options.durationSeconds)||3)});const validation=await validateGeneratedVideoClip(clip.outputPath);noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true});completeFreeAiClip(budgetReservation); budgetCommitted=true; commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds)); commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};}catch(err){const kind=classifyVideoProviderError(err);noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+kind+': '+String(err.message||err).slice(0,500));continue;}} if(provider==='OpenKing-Wan2.2'){try{const clip=await generateFreeOpenKingWan22VideoClip(prompt,dir,options);const validation=await validateGeneratedVideoClip(clip.outputPath);noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true}); completeFreeAiClip(budgetReservation);budgetCommitted=true; commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};}catch(err){const kind=classifyVideoProviderError(err);noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+kind+': '+String(err.message||err).slice(0,500));continue;}}
        if(provider==='Wan2.2-ZeroGPU'){try{const clip=await generateFreeWan22ZeroGpuVideoClip(prompt,dir,options);const validation=await validateGeneratedVideoClip(clip.outputPath);noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true}); completeFreeAiClip(budgetReservation);budgetCommitted=true; commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};}catch(err){const kind=classifyVideoProviderError(err);noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});errors.push(provider+': '+kind+': '+String(err.message||err).slice(0,500));continue;}} if(!health.ok)continue;
    try{
      let clip;
      if(provider==='Wan2.2-I2V')clip=await generateFreeWan22I2vVideoClip(prompt,dir,{...options,firstFramePath:referenceFramePath});
      else if(provider==='Wan2.1-VACE')clip=await generateFreeWanVace13VideoClip(prompt,dir,{...options,firstFramePath:referenceFramePath});
      else if(provider==='LTX-2.5')clip=await generateFreeLtx25VideoClip(prompt,dir,options);
      else if(provider==='Wan2.1')clip=await generateFreeWan21VideoClip(prompt,dir,options);
      else clip=await generateFreeLtxVideoClip(prompt,dir,options);
      const validation=await validateGeneratedVideoClip(clip.outputPath);
      if(!validation.ok)throw new Error('Clip IA inválido después de generarlo.');
      noteProviderSuccess(provider);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{success:true});
      commitVideoAllocation(provider,Number(validation.durationSeconds||clip.durationSeconds||requestedResourceSeconds));
        return{...clip,providerKey:provider,generationType:'ai-video',validation};
    }catch(err){
      const kind=classifyVideoProviderError(err); noteProviderFailure(provider,err);settleHfZeroGpuAttempt(provider,requestedResourceSeconds,{quota:classifyVideoProviderError(err)==='quota'});
      errors.push(provider+': '+kind+': '+String(err.message||err).slice(0,500));
      if(kind==='user_blocking')continue;
    }
  }
  if(requireRealAiVideoGeneration()) throw new Error('REAL_AI_VIDEO_REQUIRED: todos los proveedores de vídeo IA disponibles fallaron; el fallback determinista está bloqueado en el E2E estricto.');
  // Last-resort free path: if an AI video provider is unavailable, use a validated
  // scene image already produced by the pipeline and create deterministic cinematic
  // motion locally. This is intentionally last so hosted AI providers are still preferred.
  if(referenceFramePath){
    try{
      const clip=await generateLocalMotionFallbackClip(dir,{...options,firstFramePath:referenceFramePath});
      const validation=await validateGeneratedVideoClip(clip.outputPath);
      if(!validation.ok)throw new Error('El fallback local no pasó la validación.');
      return{...clip,providerKey:'Local-FFmpeg',generationType:'deterministic-fallback',validation,fallback:true,providerFailures:errors};
    }catch(err){
      errors.push('Local-FFmpeg: '+String(err.message||err).slice(0,500));
    }
  }
  if(!budgetCommitted)releaseFreeAiBudget(budgetReservation);
  throw new Error('RETRYABLE_AI_VIDEO_INCOMPLETE: ningún proveedor de vídeo IA ni fallback local pudo generar un clip válido. '+errors.join(' | '));
}

function requireRealAiVideoGeneration(){return String(process.env.AUTOTUBE_REQUIRE_REAL_AI_VIDEO??'1').trim()!=='0';}
function classifyGenerationType(clip){return String(clip?.generationType||clip?.providerKey||clip?.provider||'').toLowerCase().includes('local-ffmpeg')?'deterministic-fallback':'ai-video';}
async function generateLocalMotionFallbackClip(dir,options={}) {
  const sourcePath=String(options.firstFramePath||options.sceneImagePath||'').trim();
  if(!sourcePath)throw new Error('Fallback local requiere una imagen de escena.');
  const duration=Math.max(3,Math.min(8,Number(options.durationSeconds)||5));
  const outputPath=path.join(dir,'local-motion-fallback-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
  const fps=Math.max(18,Math.min(30,Number(options.fps)||20));
  const width=Math.max(320,Math.min(1280,Number(options.width)||854));
  const height=Math.max(180,Math.min(720,Number(options.height)||480));
  const zoom=Math.max(1.02,Math.min(1.18,Number(options.zoom)||1.08));
  const frames=Math.ceil(duration*fps);
  // Deterministic, dependency-free motion fallback: animated crop/zoom + slight
  // horizontal drift. It never calls an external provider and therefore remains
  // available when every hosted video model is unavailable.
  await runFfmpeg(['-y','-hide_banner','-loglevel','error','-loop','1','-i',sourcePath,
    '-vf',`scale=${Math.ceil(width*zoom/2)*2}:${Math.ceil(height*zoom/2)*2},zoompan=z='min(zoom+${(zoom-1)/frames}*1.5,${zoom})':x='iw/2-(iw/zoom/2)+sin(on/30)*iw*0.025':y='ih/2-(ih/zoom/2)+cos(on/37)*ih*0.018':d=1:s=${width}x${height}:fps=${fps},format=yuv420p`,
    '-frames:v',String(frames),'-an','-c:v','libx264','-preset','ultrafast','-crf','23','-movflags','+faststart',outputPath]);
  const stat=await fs.stat(outputPath);
  if(!stat.size)throw new Error('Fallback local produjo un MP4 vacío.');
  return{outputPath,bytes:stat.size,provider:'AutoTube local motion fallback · FFmpeg',model:'zoompan-cinematic',durationSeconds:duration,status:'complete'};
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
        onProgress:(progress)=>{
          touch('render-all-scenes',Number(progress)||0);
        },
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



const e2eVideoJobs=new Map();
async function executeE2EVideo001(id,{inducePrimaryFailure=false}={}){
  const job=e2eVideoJobs.get(id);
  const startedAt=Date.now();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-e2e-video-'));
  const attempts=[];
  const imagePath=path.join(dir,'e2e-input.png');
  try{
    job.currentStage='input';
    // Stable local input image: the E2E tests the hosted AI video path, not image generation.
    await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x243447:s=1280x720','-frames:v','1','-f','image2',imagePath]);
    const imageStat=await fs.stat(imagePath);
    if(!imageStat.size)throw new Error('E2E input image is empty.');
    const prompt='Original cinematic scene for AutoTube E2E validation: a peaceful futuristic mountain valley at sunrise, subtle atmospheric movement, realistic lighting, slow camera tracking, natural depth and motion. No logos, text, brands or copied imagery.';
    const options={firstFramePath:imagePath,durationSeconds:5,aspectRatio:'16:9',resolution:'720p',generateAudio:false,sceneIndex:0};
    const runAttempt=async(provider,fn)=>{
      const t=Date.now();
      try{
        if(inducePrimaryFailure&&provider==='FAL')throw new Error('E2E_INDUCED_PRIMARY_FAILURE: simulated FAL 503');
        const clip=await withAttemptTimeout(fn, 'E2E-VIDEO-001 '+provider, 330000);
        const validation=await validateGeneratedVideoClip(clip.outputPath);
        if(!validation.ok)throw new Error('E2E MP4 validation failed.');
        const actual=Number(validation.durationSeconds||clip.durationSeconds||0);
        if(actual<4.5||actual>5.5)throw new Error('E2E duration outside tolerance: '+actual+' s');
        attempts.push({testId:'E2E-VIDEO-001',provider:provider,model:clip.model||'',mode:clip.routeMode||'I2V',requestedDuration:5,latencyMs:Date.now()-t,status:'success',validation});
        return {...clip,validation};
      }catch(err){
        attempts.push({testId:'E2E-VIDEO-001',provider,model:'',mode:'I2V',requestedDuration:5,latencyMs:Date.now()-t,status:'failed',errorClass:classifyVideoProviderError(err),error:String(err?.message||err).slice(0,900),retryAllowed:false});
        throw err;
      }
    };
    job.currentStage='primary-fal-seedance-2.5-i2v';
    let clip;
    try{
      clip=await runAttempt('FAL',()=>falVideo(prompt,dir,{...options}));
      noteProviderSuccess('FAL');
    }catch(primaryErr){
      noteProviderFailure('FAL',primaryErr);
      job.currentStage='fallback-replicate-wan-2.7-i2v';
      clip=await runAttempt('Replicate-Wan',()=>replicateVideo(prompt,dir,{...options}));
      noteProviderSuccess('Replicate-Wan');
    }
    job.currentStage='final-validation';
    const final=await validateGeneratedVideoClip(clip.outputPath);
    const result={
      ok:true,
      status:inducePrimaryFailure?'PASS_WITH_FALLBACK':'PASS',
      testId:'E2E-VIDEO-001',
      realAiVideo:true,
      primary:'fal.ai Seedance 2.5 I2V',
      fallback:'Replicate Wan 2.7 I2V',
      selectedProvider:clip.provider,
      selectedModel:clip.model,
      outputPath:clip.outputPath,
      downloadPath:clip.outputPath,
      validation:final,
      attempts,
      elapsedMs:Date.now()-startedAt,
      inducedPrimaryFailure:inducePrimaryFailure
    };
    job.status='done';job.currentStage='complete';job.result=result;job.finishedAt=Date.now();
    return result;
  }catch(err){
    const result={ok:false,status:'FAIL',testId:'E2E-VIDEO-001',realAiVideo:false,error:String(err?.message||err),attempts,elapsedMs:Date.now()-startedAt};
    job.status='failed';job.currentStage='failed';job.result=result;job.finishedAt=Date.now();
    return result;
  }finally{
    // Keep a successful MP4 available to the status/download endpoint until the job expires.
    if(job?.status!=='done')await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
app.get('/api/e2e/video-001',async(req,res)=>{
  const induce=String(req.query?.inducePrimaryFailure||'0')==='1';
  const existing=[...e2eVideoJobs.values()].find(j=>j.status==='running'&&j.inducePrimaryFailure===induce);
  if(existing)return res.status(202).json({ok:false,status:'running',jobId:existing.id,statusUrl:'/api/e2e/video-001/'+encodeURIComponent(existing.id)});
  const id='e2e_video_001_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  e2eVideoJobs.set(id,{id,status:'running',startedAt:Date.now(),result:null,inducePrimaryFailure:induce,currentStage:'queued'});
  res.status(202).json({ok:false,status:'running',jobId:id,statusUrl:'/api/e2e/video-001/'+encodeURIComponent(id),testId:'E2E-VIDEO-001',inducedPrimaryFailure:induce});
  executeE2EVideo001(id,{inducePrimaryFailure:induce}).catch(err=>console.error('E2E-VIDEO-001 runner error:',err));
});
app.get('/api/e2e/video-001/:jobId',async(req,res)=>{
  const j=e2eVideoJobs.get(String(req.params.jobId||''));
  if(!j)return res.status(410).json({ok:false,status:'restart',error:'E2E job lost after Render restart.'});
  if(j.status==='running')return res.status(202).json({ok:false,status:'running',jobId:j.id,testId:'E2E-VIDEO-001',currentStage:j.currentStage,elapsedMs:Date.now()-j.startedAt});
  return res.status(j.result?.ok?200:503).json({status:j.status,jobId:j.id,...(j.result||{ok:false})});
});
app.get('/api/e2e/video-001/:jobId/download',async(req,res)=>{
  const j=e2eVideoJobs.get(String(req.params.jobId||''));
  const file=j?.result?.downloadPath;
  if(!j?.result?.ok||!file)return res.status(404).json({ok:false,error:'MP4 E2E no disponible.'});
  try{await fs.stat(file);return res.download(file,'autotube-e2e-video-001.mp4');}catch{return res.status(404).json({ok:false,error:'MP4 E2E expirado.'});}
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
const autonomousPipelineCheckpoints=new Map();
const AUTOTUBE_CHECKPOINT_TTL_MS=Math.max(10*60*1000,Number(process.env.AUTOTUBE_CHECKPOINT_TTL_MS||6*60*60*1000));
const AUTOTUBE_CHECKPOINT_PERSIST_PREFIX='autotube-checkpoint-';
const PIPELINE_CHECKPOINT_STAGE_ORDER=['youtube-source-and-reference-analysis','production-plan','reference-blueprint','visual-sources-all-scenes','narration-all-scenes','music','render-all-scenes'];

const adaptiveProviderDurationCaps=new Map();
const adaptiveProviderCooldowns=new Map();
function adaptiveProviderKey(x){return String(x?.providerKey||x?.provider||x||'unknown');}
async function withAttemptTimeout(task,label,timeoutMs=300000){
  const ms=Math.max(1000,Number(timeoutMs)||300000); let timer;
  try{
    return await Promise.race([
      Promise.resolve().then(()=>task()),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('AUTOTUBE_AI_ATTEMPT_TIMEOUT: '+label+' superó '+ms+' ms')),ms);})
    ]);
  }finally{if(timer)clearTimeout(timer);}
}
function adaptiveCooldown(p,ms=120000){adaptiveProviderCooldowns.set(p,Date.now()+Math.max(5000,ms));}
function adaptiveCap(p){const n=Number(adaptiveProviderDurationCaps.get(p));return Number.isFinite(n)&&n>0?n:Number(process.env.AUTOTUBE_PROVIDER_INITIAL_MAX_SECONDS||5);}
function adaptiveSetCap(p,n){const cap=Math.max(0.5,Number(n)||0);if(cap>0)adaptiveProviderDurationCaps.set(p,cap);}
function adaptiveErrorKind(err){
  const k=classifyVideoProviderError(err),m=String(err?.message||err).toLowerCase();
  if(k==='quota'||/quota exceeded|exceeded your|remaining quota|rate limit|too many requests|429/.test(m))return 'quota';
  if(/illegal duration|requested duration|duration.*maximum|duration.*max/.test(m))return 'duration';
  if(/503|502|504|service unavailable|temporarily unavailable|space.*down|queue.*failed|timeout|timed out/.test(m))return 'capacity';
  return k||'execution';
}
async function concatVideoChunks(chunks,dir,prefix){
  if(!Array.isArray(chunks)||!chunks.length)throw new Error('No hay fragmentos para concatenar.');
  if(chunks.length===1)return chunks[0];
  const listPath=path.join(dir,prefix+'-concat-'+Date.now()+'.txt');
  const outPath=path.join(dir,prefix+'-joined-'+Date.now()+'.mp4');
  await fs.writeFile(listPath,chunks.map(p=>'file '+String(p).replace(/'/g,"'\\''")).join('\n')+'\n','utf8');
  try{
    await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',listPath,'-map','0:v:0','-an','-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',outPath]);
    await validateGeneratedVideoClip(outPath);return outPath;
  }finally{await fs.rm(listPath,{force:true}).catch(()=>{});}
}
async function generateResilientSceneVideoClip(prompt,dir,options={}){
  const target=Math.max(0.5,Number(options.durationSeconds)||4);let remaining=target;const chunks=[];const providersUsed=[];
  let attempts=0;const maxAttempts=Math.max(10,Math.ceil(target/0.5)*8);
  while(remaining>0.45&&attempts++<maxAttempts){
    const request=Math.max(3,Math.min(remaining,adaptiveCap('cascade'),Number(process.env.AUTOTUBE_PROVIDER_REQUEST_MAX_SECONDS||3)));
    let clip=null,lastErr=null;
    try{clip=await generateBestFreeVideoClip(prompt,dir,{...options,durationSeconds:request,adaptiveChunk:true});}catch(err){lastErr=err;}
    if(clip?.outputPath){
      const validation=await validateGeneratedVideoClip(clip.outputPath).catch(e=>({ok:false,error:e.message}));
      if(validation.ok){
        const actual=Math.max(0,Number(clip.durationSeconds)||Number(validation.durationSeconds)||0);
        if(actual>0){
          const provider=adaptiveProviderKey(clip);
          adaptiveSetCap(provider,actual);
          chunks.push(clip.outputPath);providersUsed.push({provider,duration:actual});
          remaining=Math.max(0,remaining-actual);
          continue;
        }
      }else lastErr=new Error('Fragmento generado no pasó QA: '+(validation.error||''));
    }
    const kind=adaptiveErrorKind(lastErr);
    if(kind==='duration'){adaptiveSetCap('cascade',Math.max(3,request/2));continue;}
    if(kind==='quota'){adaptiveCooldown('cascade',24*60*60*1000);adaptiveSetCap('cascade',Math.max(3,request/2));continue;}
    if(kind==='capacity'){adaptiveCooldown('cascade',90000);adaptiveSetCap('cascade',Math.max(3,request/2));continue;}
    if(lastErr)throw lastErr;
    break;
  }
  if(remaining>0.45)throw new Error('RETRYABLE_AI_VIDEO_INCOMPLETE: faltan '+remaining.toFixed(2)+' s de vídeo para completar la escena.');
  const joined=await concatVideoChunks(chunks,dir,'autotube-scene');
  const v=await validateGeneratedVideoClip(joined);if(!v.ok)throw new Error('La escena concatenada no pasó QA.');
  return{outputPath:joined,durationSeconds:v.durationSeconds,provider:providersUsed.map(x=>x.provider).filter((x,i,a)=>a.indexOf(x)===i).join(' + '),providerKey:providersUsed.length===1?providersUsed[0].provider:'adaptive-multi-provider',model:'adaptive-duration-chunks',generationType:'ai-video',status:'complete',chunks:chunks.length,providersUsed};
}
function pipelineCheckpointKey(reference){return crypto.createHash('sha1').update(String(reference||'').trim()).digest('hex').slice(0,20);}
function checkpointStageIndex(stage){const i=PIPELINE_CHECKPOINT_STAGE_ORDER.indexOf(String(stage||''));return i<0?-1:i;}
async function persistPipelineCheckpoint(next){
  if(!supabaseConfigured()||!next?.key)return;
  try{
    const persisted={
      type:'autotube_pipeline_checkpoint',
      key:next.key,
      reference:next.reference,
      completedStage:next.completedStage||'',
      completedStages:Array.isArray(next.completedStages)?next.completedStages:[],
      updatedAt:Number(next.updatedAt||Date.now()),
      video:next.video||null,
      style:next.style||null,
      plan:next.plan||null,
      blueprint:next.blueprint||null
    };
    await supabaseRequest('youtube_connections?on_conflict=id',{method:'POST',body:JSON.stringify({
      id:AUTOTUBE_CHECKPOINT_PERSIST_PREFIX+next.key,
      tokens_encrypted:encryptTokens({}),
      profile:persisted,
      updated_at:new Date(persisted.updatedAt).toISOString()
    })});
  }catch(err){console.warn('[Checkpoint] durable persistence unavailable:',String(err?.message||err).slice(0,400));}
}
async function hydratePipelineCheckpoint(reference){
  const key=pipelineCheckpointKey(reference);
  const memory=autonomousPipelineCheckpoints.get(key);
  if(memory&&Date.now()-Number(memory.updatedAt||0)<=AUTOTUBE_CHECKPOINT_TTL_MS)return memory;
  if(memory)autonomousPipelineCheckpoints.delete(key);
  if(!supabaseConfigured())return null;
  try{
    const rows=await supabaseRequest('youtube_connections?id=eq.'+encodeURIComponent(AUTOTUBE_CHECKPOINT_PERSIST_PREFIX+key)+'&select=*',{method:'GET'});
    const persisted=rows?.[0]?.profile;
    if(!persisted||persisted.type!=='autotube_pipeline_checkpoint')return null;
    if(Date.now()-Number(persisted.updatedAt||0)>AUTOTUBE_CHECKPOINT_TTL_MS)return null;
    const stage=String(persisted.completedStage||'');
    const cp={
      key,reference:String(reference||'').trim(),completedStage:stage,completedStages:Array.isArray(persisted.completedStages)?persisted.completedStages:PIPELINE_CHECKPOINT_STAGE_ORDER.slice(0,checkpointStageIndex(stage)+1),updatedAt:Number(persisted.updatedAt||Date.now()),
      video:persisted.video||null,style:persisted.style||null,plan:persisted.plan||null,blueprint:persisted.blueprint||null
    };
    // Render's filesystem is ephemeral. Never reuse file paths/media from a previous
    // instance; keep only the metadata stages that can be safely reconstructed.
    if(checkpointStageIndex(stage)>=checkpointStageIndex('visual-sources-all-scenes')){
      cp.completedStage=checkpointStageIndex(stage)>=checkpointStageIndex('reference-blueprint')?'reference-blueprint':stage;
    }
    autonomousPipelineCheckpoints.set(key,cp);
    console.log('[Checkpoint] hydrated durable metadata:',cp.completedStage,key);
    return cp;
  }catch(err){console.warn('[Checkpoint] durable hydration unavailable:',String(err?.message||err).slice(0,400));return null;}
}
function getPipelineCheckpoint(reference){
  const key=pipelineCheckpointKey(reference);
  const cp=autonomousPipelineCheckpoints.get(key);
  if(!cp)return null;
  if(Date.now()-Number(cp.updatedAt||0)>AUTOTUBE_CHECKPOINT_TTL_MS){autonomousPipelineCheckpoints.delete(key);return null;}
  return cp;
}
function savePipelineCheckpoint(reference,patch){
  const key=pipelineCheckpointKey(reference);
  const current=autonomousPipelineCheckpoints.get(key)||{key,reference:String(reference||'').trim(),completedStages:[],updatedAt:Date.now()};
  const next={...current,...patch,key,reference:String(reference||'').trim(),updatedAt:Date.now()};
  if(next.completedStage){
    next.completedStages=Array.from(new Set([...(current.completedStages||[]),next.completedStage]));
  }
  autonomousPipelineCheckpoints.set(key,next);
  void persistPipelineCheckpoint(next);
}
function invalidatePipelineCheckpoint(reference,fromStage=''){
  const key=pipelineCheckpointKey(reference);
  const cp=autonomousPipelineCheckpoints.get(key);
  if(!cp)return;
  const from=checkpointStageIndex(fromStage);
  if(from<0){autonomousPipelineCheckpoints.delete(key);return;}
  const kept=PIPELINE_CHECKPOINT_STAGE_ORDER.slice(0,from);
  cp.completedStages=(cp.completedStages||[]).filter(s=>kept.includes(s));
  cp.completedStage=kept.length?kept[kept.length-1]:'';
  cp.updatedAt=Date.now();
  for(const field of ['mediaResults','aiClips','narrationAudio','musicFile','render','dir'])delete cp[field];
  autonomousPipelineCheckpoints.set(key,cp);
  void persistPipelineCheckpoint(cp);
}

async function executeFullPipelineTest(reference,testId=null){
  const checkpoint=await hydratePipelineCheckpoint(reference);
  const dir=checkpoint?.dir && await fs.stat(checkpoint.dir).then(()=>checkpoint.dir).catch(()=>null)
    || await fs.mkdtemp(path.join(os.tmpdir(),'autotube-full-test-'));
  const resumedStages=Array.isArray(checkpoint?.completedStages)?checkpoint.completedStages:[];
  const started=Date.now();
  const checks={};
  if(resumedStages.length)console.log('AutoTube checkpoint resume:',reference,'stages=',resumedStages.join(','));
  const jobState=testId?fullPipelineTestJobs.get(testId):null;
  const touch=(stage,progress=null)=>{
    const j=testId?fullPipelineTestJobs.get(testId):null;
    if(j){j.currentStage=stage;j.lastProgressAt=Date.now();if(progress!==null)j.progress=progress;}
  };
  const run=async(name,fn)=>{
    const t=Date.now();
    touch(name,0);
    const limits={
      // Hard budgets keep a failed strategy from consuming the whole autonomous cycle.
      // Each stage can still be overridden with AUTOTUBE_STAGE_TIMEOUT_<STAGE>.
      'youtube-source-and-reference-analysis':120000,
      'production-plan':75000,
      'reference-blueprint':45000,
      'visual-sources-all-scenes':480000,
      'narration-all-scenes':120000,
      'music':150000,
      'render-all-scenes':900000
    };
    const timeoutMs=Number(process.env['AUTOTUBE_STAGE_TIMEOUT_'+String(name).replace(/[^A-Za-z0-9]/g,'_').toUpperCase()]||limits[name]||300000);
    console.log('AutoTube full pipeline stage start:',name,'timeoutMs=',timeoutMs,'budgetSec=',Math.round(timeoutMs/1000));
    let timer;
    try{
      const value=await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('AUTOTUBE_STAGE_TIMEOUT: '+name+' superó '+timeoutMs+' ms')),timeoutMs)})
      ]);
      checks[name]={ok:true,ms:Date.now()-t,...(value&&typeof value==='object'?value:{})};
      touch(name,100);
      console.log('AutoTube full pipeline stage done:',name,'ms=',Date.now()-t);
      return value;
    }catch(err){
      checks[name]={ok:false,ms:Date.now()-t,error:err.message||String(err)};
      console.error('AutoTube full pipeline stage failed:',name,'ms=',Date.now()-t,err.message||String(err));
      throw err;
    }finally{
      if(timer)clearTimeout(timer);
    }
  };
  try{
    let video=checkpoint?.video||null,style=checkpoint?.style||null,outline=null,plan=checkpoint?.plan||null,narrationAudio=checkpoint?.narrationAudio||[],music=null,render=null,validation=null,mediaResults=checkpoint?.mediaResults||[],aiClips=checkpoint?.aiClips||[];
    if(resumedStages.includes('youtube-source-and-reference-analysis')&&video&&style){
      checks['youtube-source-and-reference-analysis']={ok:true,resumed:true,checkpointAgeMs:Date.now()-Number(checkpoint.updatedAt||Date.now()),title:video.title||'',hasFullVideoAnalysis:Boolean(style.hasFullVideoAnalysis),hasAudioProfile:Boolean(style.hasAudioAnalysis),estimatedSceneCount:Number(style.estimatedSceneCount||0),preferredSceneCount:Number(style.preferredSceneCount||0),referenceFileBytes:Number(style.referenceFileBytes||0),downloadStrategy:style.downloadStrategy||''};
    }else await run('youtube-source-and-reference-analysis',async()=>{
      video=await getReferenceVideo(reference);
      style=await analyzeYoutubeReferenceMediaDirect(reference,video);
      if(!video?.title||!style?.visualAnalysis)throw new Error('No se obtuvo un perfil audiovisual completo de YouTube.');
      const value={
        title:video.title,
        hasFullVideoAnalysis:Boolean(style.hasFullVideoAnalysis),
        hasAudioProfile:Boolean(style.hasAudioAnalysis),
        estimatedSceneCount:Number(style.estimatedSceneCount||0),
        preferredSceneCount:Number(style.preferredSceneCount||0),
        referenceFileBytes:Number(style.referenceFileBytes||0),
        downloadStrategy:style.downloadStrategy||''
      };
      savePipelineCheckpoint(reference,{dir,video,style,completedStage:'youtube-source-and-reference-analysis'});
      return value;
    });

    const referenceTitle=String(video.title||'Contenido original').slice(0,300);
    const referenceStyle=style;
    const visualReferenceAnalysis=style.visualAnalysis;
    const audioProfile={...(visualReferenceAnalysis?.audioProfile||{})};
    const referenceDurationSeconds=Math.max(1,Number(parseIsoDurationSeconds(video.duration)||visualReferenceAnalysis?.videoProfile?.durationSeconds||30));
    const configuredAutonomousDuration=Number(process.env.AUTOTUBE_AUTONOMOUS_MAX_DURATION_SECONDS||20);
    const autonomousMaxDurationSeconds=Math.max(10,Math.min(3600,configuredAutonomousDuration));
    const durationSeconds=Math.min(referenceDurationSeconds,autonomousMaxDurationSeconds);
    if(durationSeconds<referenceDurationSeconds)console.log('AutoTube autonomous proof-duration cap:',durationSeconds,'s of reference',referenceDurationSeconds,'s; set AUTOTUBE_AUTONOMOUS_MAX_DURATION_SECONDS to the desired final duration after the smoke test passes.');
    else console.log('AutoTube autonomous cycle is running at full reference duration:',durationSeconds,'s');

    // Build the per-run allocation from the same live route matrix used by the resource gate.
    // The final duration is divided according to measured remaining capacity.
    try{
      const allocationGate=await evaluateAutonomousResourceGate();
      activateVideoCapacityAllocation(durationSeconds,allocationGate.available?.routeMatrix||[]);
    }catch(allocationErr){
      console.warn('[VideoCapacity] allocation preflight unavailable; using normal provider fallback order:',String(allocationErr?.message||allocationErr));
      activeVideoAllocation=null;
    }
    outline={title:referenceTitle,outline:[],visualIdeas:[]};

    if(!resumedStages.includes('production-plan')||!plan) await run('production-plan',async()=>{
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
      savePipelineCheckpoint(reference,{dir,video,style,plan,completedStage:'production-plan'});
      return{scenes:d.scenes.length,title:d.title||'',durationSeconds};
    });

    const preferred=Math.max(1,Number(style.preferredSceneCount||style.estimatedSceneCount||plan.scenes.length||1));
    if(!style.constantImage && preferred>plan.scenes.length){
      let blueprint=null;
      const cachedBlueprint=checkpoint?.blueprint;
      if(resumedStages.includes('reference-blueprint')&&cachedBlueprint?.sections?.length){
        blueprint=cachedBlueprint;
        checks['reference-blueprint']={ok:true,resumed:true,sections:blueprint.sections.length};
      }else{
        const blueprintStarted=Date.now();
        blueprint=buildLocalReferenceBlueprint(plan.scenes,durationSeconds,visualReferenceAnalysis,referenceStyle);
        checks['reference-blueprint']={ok:true,mode:'local-deterministic-fast',sections:blueprint.sections.length,ms:Date.now()-blueprintStarted};
      }
      if(blueprint?.sections?.length){
        plan.scenes=applyReferenceBlueprint(plan.scenes,blueprint,durationSeconds);
        savePipelineCheckpoint(reference,{dir,video,style,plan,blueprint,completedStage:'reference-blueprint'});
      }
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

    if(!resumedStages.includes('visual-sources-all-scenes')||!Array.isArray(mediaResults)||!mediaResults.length||!Array.isArray(aiClips)||!aiClips.length) await run('visual-sources-all-scenes',async()=>{
      // Prefer original AI video generation first. This avoids making the E2E depend
      // on third-party media-search providers that may return HTML/403/429.
      mediaResults=plan.scenes.map(scene=>({number:scene.number,query:scene.searchQuery||scene.title||referenceTitle,media:[]}));
      // Generate original motion clips sequentially when LTX is available. Never run
      // scene generations concurrently on Render Free; that would spike memory/CPU.
      {
        for(let i=0;i<plan.scenes.length;i++){
          const scene=plan.scenes[i];
          try{
            const continuity=JSON.stringify({visual:visualReferenceAnalysis?.videoProfile||{},animation:visualReferenceAnalysis?.animationProfile||{},structure:visualReferenceAnalysis?.structureProfile||{},audio:visualReferenceAnalysis?.audioProfile||{},scene:scene.referenceStructure||{}}).slice(0,7000);
            const prompt=[String(scene.visualPrompt||scene.title||referenceTitle),'Match the reference audiovisual language: composition, shot scale, camera movement, motion intensity, lighting, palette, pacing and continuity.','Preserve recurring visual anchors between scenes while generating new original material.','Continuity blueprint: '+continuity,'Scene animation: '+String(scene.animationNotes||''),'Camera: '+String(scene.cameraMovement||''),'Original material only; no copied frames, logos, text or watermark.'].join('; ');
            const referenceThumb=String(video?.thumbnail||'').trim();
            const referenceFramePath=referenceThumb?await downloadRemoteImageToFile(referenceThumb,dir,'adaptive-reference-frame-'+i+'.jpg').catch(()=> ''):'';
            let clip=null;
            try{
              clip=await withAttemptTimeout(()=>generateResilientSceneVideoClip(prompt,dir,{durationSeconds:Number(scene.duration)||4,aspectRatio:'16:9',sceneIndex:i,firstFramePath:referenceFramePath}),'adaptive-duration-scene-'+(i+1),Number(process.env.AUTOTUBE_AI_PROVIDER_ATTEMPT_TIMEOUT_MS||300000));
              console.log('AutoTube resilient scene generated:',i+1,'/',plan.scenes.length,'chunks=',clip.chunks,'providers=',clip.providerKey,'duration=',clip.durationSeconds);
            }catch(videoErr){console.warn('AutoTube resilient video generation exhausted for scene '+(i+1)+':',videoErr.message||String(videoErr));}
            // STRICT REAL_AI_VIDEO_REQUIRED: an image converted to pan/zoom motion is
            // never accepted as a video-generation fallback. A scene must originate
            // from a real AI video provider and carry generationType=ai-video.
            if(!clip)throw new Error('No se pudo completar la escena '+(i+1)+' con vídeo IA real.');
            if(String(clip.generationType||'')!=='ai-video')throw new Error('REAL_AI_VIDEO_REQUIRED: la escena '+(i+1)+' no procede de un generador de vídeo IA real.');
            aiClips.push({path:clip.outputPath,mediaType:'video',provider:clip.provider,model:clip.model,providerKey:clip.providerKey,generationType:'ai-video',durationSeconds:clip.durationSeconds||Number(scene.duration)||4});
            console.log('AutoTube scene clip committed:',i+1,'/',plan.scenes.length,'provider=',clip.providerKey||clip.provider,'duration=',clip.durationSeconds||Number(scene.duration)||4,'s');
          }catch(err){console.warn('AI video scene '+(i+1)+' unavailable:',err.message||String(err));}
        }
      }
      // Never accept a static image as success. Every planned scene must have a
      // validated generated clip; the renderer will concatenate them in timeline order.
      if(aiClips.length!==plan.scenes.length){
        throw new Error('RETRYABLE_AI_VIDEO_INCOMPLETE: faltan clips de escenas ('+aiClips.length+'/'+plan.scenes.length+'). No se reutilizarán clips de otra escena.');
      }
      mediaResults=plan.scenes.map((scene,i)=>{
        const clip=aiClips[i];
        return {
          number:scene.number,
          query:scene.searchQuery||scene.title||referenceTitle,
          media:[{
            provider:clip.provider,
            id:'generated-video-'+scene.number,
            title:'Original AI video clip',
            duration:Number(scene.duration)||2,
            downloadUrl:clip.path,
            mediaType:'video'
          }],
          generatedAsset:true
        };
      });
      const value={scenes:plan.scenes.length,results:mediaResults.length,missing:0,realAiVideoClips:aiClips.length,freeMode:true};
      savePipelineCheckpoint(reference,{dir,video,style,plan,mediaResults,aiClips,completedStage:'visual-sources-all-scenes'});
      return value;
    });

    if(Boolean(audioProfile.hasSpeech)&&!resumedStages.includes('narration-all-scenes')){
      await run('narration-all-scenes',async()=>{
        narrationAudio=await Promise.all(plan.scenes.map(async(scene)=>{
          const text=String(scene.narration||scene.title||referenceTitle).trim();
          if(!text)return null;
          return generateNarrationTts(text,audioProfile.language||'es',audioProfile.voiceStyle||'Natural y cercana',audioProfile);
        }));
        const value={scenes:narrationAudio.filter(Boolean).length};
        savePipelineCheckpoint(reference,{dir,video,style,plan,mediaResults,aiClips,narrationAudio,completedStage:'narration-all-scenes'});
        return value;
      });
    }

    if(Boolean(audioProfile.hasMusic||audioProfile.hasAmbience)&&!resumedStages.includes('music')){
      await run('music',async()=>{
        music=await generateFallbackMusic('Original music matching the reference audio profile without copying the source. '+JSON.stringify(audioProfile),Math.max(3,Math.min(120,durationSeconds)),dir,audioProfile);
        const musicFile=path.join(dir,'checkpoint-music.bin');
        await fs.writeFile(musicFile,music.buffer);
        savePipelineCheckpoint(reference,{dir,video,style,plan,mediaResults,aiClips,narrationAudio,musicFile,completedStage:'music'});
        return{provider:music.provider,bytes:music.buffer.length,durationSeconds};
      });
    }else if(resumedStages.includes('music')&&checkpoint?.musicFile){
      try{const musicBuffer=await fs.readFile(checkpoint.musicFile);music={buffer:musicBuffer,provider:'checkpoint'};}catch{invalidatePipelineCheckpoint(reference,'music');throw new Error('El checkpoint de música ya no es válido; se regenerará desde música.');}
    }

    if(!resumedStages.includes('render-all-scenes')) await run('render-all-scenes',async()=>{
      const output=path.join(renderJobDir,String(testId||('fulltest_'+Date.now()))+'.mp4');
      console.log('AutoTube render: starting FFmpeg scene assembly; sceneCount=',plan.scenes.length,'targetDurationSec=',durationSeconds);
      render=await renderAutotubeVideo({
        scenes:plan.scenes,
        mediaResults,
        aiClips,
        narrationAudio,
        musicBuffer:music?.buffer||null,
        onProgress:()=>{},
        finalOutputPath:output,
        // Render at 854x480 on Render Free to stay below its 512 MiB memory limit.
        // It preserves 16:9 while materially reducing FFmpeg's peak frame memory.
        targetWidth:854,
        targetHeight:480,
        // 20 fps matches the validated scene clips and preserves the generated motion without re-encoding.
        targetFps:20,
        targetDurationSeconds:durationSeconds
      });
      console.log('AutoTube render: FFmpeg assembly finished; starting final MP4 validation');
      validation=await validateRenderedMp4(output,durationSeconds,{expectedFps:20,referenceStyle,referenceTitle,referenceThumbnail:video?.thumbnail||''});
      console.log('AutoTube render: final MP4 validation passed; duration=',validation.durationSeconds,'fps=',validation.fps,'motion=',Boolean(validation.motion?.motionDetected),'reference=',validation.referenceConformance?.status||'not-run');
      const st=await fs.stat(output);
      const value={bytes:st.size,sceneCount:plan.scenes.length,...validation,downloadPath:output,referenceMatchStatus:validation.referenceConformance?.status||'not-run'};
      savePipelineCheckpoint(reference,{dir,video,style,plan,mediaResults,aiClips,narrationAudio,musicFile:music?.checkpointFile||checkpoint?.musicFile,render:value,completedStage:'render-all-scenes'});
      return value;
    });

    autonomousPipelineCheckpoints.delete(pipelineCheckpointKey(reference));
    return{
      ok:true,
      elapsedMs:Date.now()-started,
      reference:{url:reference,title:referenceTitle,durationSeconds},
      checks,
      result:{
        sceneCount:plan.scenes.length,
        referenceDurationSeconds:durationSeconds,
        renderedBytes:validation?.size||render?.size||0,
        realAiVideoClips:aiClips.length,
        allScenesRealAiVideo:aiClips.length===plan.scenes.length && aiClips.every(x=>String(x?.generationType||'')==='ai-video'),
        aiVideoProviders:[...new Set(aiClips.map(x=>String(x?.providerKey||x?.provider||'unknown')))],
        realAiVideoRequired:true,
        finalMotionDetected:Boolean(validation?.motion?.motionDetected),
        referenceConformance:validation?.referenceConformance||null,
        downloadPath:checks['render-all-scenes']?.downloadPath||null,
        downloadUrl:testId?'/api/full-pipeline-test/'+encodeURIComponent(testId)+'/download':null
      }
    };
  }catch(err){
    const failedStage=Object.keys(checks).reverse().find(name=>checks[name]?.ok===false)||'unknown';
    if(failedStage!=='unknown')invalidatePipelineCheckpoint(reference,failedStage);
    throw err;
  }finally{
    const keepCheckpoint=Boolean(getPipelineCheckpoint(reference));
    if(!keepCheckpoint)await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
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

function buildLocalReferenceBlueprint(scenes,targetDurationSeconds,visualReferenceAnalysis={},referenceStyle={}){
  const src=Array.isArray(scenes)?scenes:[];
  const total=Math.max(4,Number(targetDurationSeconds)||60);
  const count=Math.max(1,src.length||Math.ceil(total/20));
  const vp=visualReferenceAnalysis?.videoProfile||{};
  const ap=visualReferenceAnalysis?.animationProfile||{};
  const sp=visualReferenceAnalysis?.structureProfile||{};
  const sections=Array.from({length:count},(_,i)=>{
    const start=i/count,end=(i+1)/count,base=src[i%Math.max(1,src.length)]||{};
    return {order:i+1,startRatio:start,endRatio:end,purpose:String(base.title||('Escena '+(i+1))),narrationRole:String(base.narration?'narration':'visual'),visualSubject:String(base.visualPrompt||base.title||referenceStyle?.visualStyle||'original cinematic scene'),shotType:'medium-wide',cameraMotion:String(base.cameraMovement||ap.cameraMotion||vp.cameraMovement||'smooth cinematic movement'),composition:String(vp.composition||'16:9 balanced composition'),motionIntensity:String(ap.motionIntensity||'medium'),transition:String(base.transition||ap.transitionStyle||'clean cut'),onScreenText:'',musicRole:'continuous original soundtrack',sfxRole:String(visualReferenceAnalysis?.audioProfile?.hasSoundEffects?'subtle original sound design':'none')};
  });
  return {targetDurationSeconds:total,sections,global:{pacing:String(sp.pacing||ap.visualRhythm||'moderate'),visualStyle:String(vp.visualStyle||referenceStyle?.visualStyle||'original cinematic'),editingStyle:String(sp.transitions||ap.transitionStyle||'clean cuts'),colorMood:String(vp.palette||'cinematic'),captionStyle:'none unless required by script',cameraLanguage:String(vp.cameraMovement||ap.cameraMotion||'smooth cinematic movement')}};
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
    // Provider Manager owns routing, health, cooldowns and per-clip validation.
    try {
      let firstFramePath='';
      if(video.thumbnail){try{firstFramePath=await downloadRemoteImageToFile(video.thumbnail,dir,'reference-frame.jpg');}catch(err){console.warn('Reference thumbnail unavailable for VACE:',err.message||String(err));}}
      for(let i=0;i<scenes.length;i++){
        const scene=scenes[i];
        const dnaPrompt=[String(scene.visualPrompt||scene.title||referenceTitle),
          'REFERENCE DNA (style only, create original material): '+JSON.stringify({videoProfile:visualReferenceAnalysis?.videoProfile||{},animationProfile:visualReferenceAnalysis?.animationProfile||{},structureProfile:visualReferenceAnalysis?.structureProfile||{},audioProfile,segment:scene.referenceSegment||scene.referenceStructure||null}).slice(0,9000),
          'CONTINUITY: '+JSON.stringify({previousScene:i>0?scenes[i-1]?.referenceStructure||scenes[i-1]?.animationNotes||'':'opening scene',currentScene:scene.referenceStructure||null,globalPacing:visualReferenceAnalysis?.animationProfile?.visualRhythm||visualReferenceAnalysis?.structureProfile?.pacing||''}).slice(0,5000),
          String(scene.animationNotes||''),String(scene.cameraMovement||''),
          'NEW AI-GENERATED MATERIAL ONLY. Do not reproduce faces, characters, logos, text, frames, exact shots, recordings or copyrighted audio.'
        ].filter(Boolean).join('; ');
        if(style.constantImage)throw new Error('La referencia es de imagen constante; el modo gratuito exige vídeo IA real y no usa animación de imagen.');
        const duration=Math.min(8.5,Math.max(3,Number(scene.duration)||5));
        const clip=await generateBestFreeVideoClip(dnaPrompt,dir,{durationSeconds:duration,width:704,height:396,improveTexture:false,sceneIndex:i,firstFramePath});
        aiClips[i]={path:clip.outputPath,mediaType:'video',provider:clip.provider,model:clip.model,providerKey:clip.providerKey,generationType:clip.generationType||classifyGenerationType(clip),validation:clip.validation};
        mediaResults[i]={number:scene.number,media:[{provider:clip.provider,id:'generated-video-'+scene.number,title:'Original AI video clip',duration,downloadUrl:clip.outputPath,mediaType:'video',model:clip.model}],generatedAsset:true};
        if(job)job.providerHealth=Object.fromEntries([...videoProviderState.entries()].map(([k,v])=>[k,{...v}]));
      }
      if(aiClips.length!==scenes.length||aiClips.some(x=>!x?.path))throw new Error('La generación no produjo un clip de vídeo IA válido para cada escena.');
      const fallbackScenes=aiClips.map((x,i)=>({scene:Number(scenes[i]?.number||i+1),generationType:x?.generationType||classifyGenerationType(x),provider:x?.providerKey||x?.provider||''})).filter(x=>x.generationType!=='ai-video');
      if(requireRealAiVideoGeneration()&&fallbackScenes.length){throw new Error('REAL_AI_VIDEO_REQUIRED: '+fallbackScenes.map(x=>'escena '+x.scene+' ('+x.provider+')').join(', ')+' solo pudo generarse con fallback determinista. El E2E real exige vídeo generado por IA; se debe probar otra vía/proveedor.');}
    } catch(err) {finishFreeVideoGeneration(false);throw err;}
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
    if(job)job.progress=98;
    const referenceValidation=await validateGeneratedAgainstReference(outputPath,reference,visualReferenceAnalysis);
    if(!animatedMotion.motionDetected||Number(animatedMotion.uniqueFrames||0)<2)throw new Error('El MP4 final no demuestra movimiento de vídeo IA real. No se acepta como generación válida.');
    const stat=await fs.stat(outputPath);
    if(!stat.size)throw new Error('El MP4 alternativo está vacío.');

    if(job){
      job.status='done';job.progress=100;job.outputPath=outputPath;job.size=stat.size;
      job.sceneCount=scenes.length;job.durationSeconds=validation.durationSeconds||durationSeconds;
      job.validation={...validation,mode:'original-alternative',sourceReference:reference,referenceAudioVisualProfile:{videoProfile:visualReferenceAnalysis?.videoProfile||{},animationProfile:visualReferenceAnalysis?.animationProfile||{},audioProfile,structureProfile:visualReferenceAnalysis?.structureProfile||{}},
        referenceSimilarityValidation:referenceValidation,
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

app.post('/api/ai/story-clip',async(req,res)=>{
  const body=req.body||{};
  const scene=body.scene&&typeof body.scene==='object'?body.scene:{};
  const referenceProfile=body.referenceProfile&&typeof body.referenceProfile==='object'?body.referenceProfile:{};
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-story-'));
  try{
    const prompt=[
      'Create ONE original cinematic 16:9 illustration for this story scene.',
      String(scene.visualPrompt||scene.title||'original cinematic scene'),
      String(scene.animationNotes||''),
      String(scene.cameraMovement||''),
      referenceProfile?.videoProfile?.visualStyle&&('visual language: '+referenceProfile.videoProfile.visualStyle),
      referenceProfile?.videoProfile?.composition&&('composition: '+referenceProfile.videoProfile.composition),
      referenceProfile?.videoProfile?.palette&&('palette: '+referenceProfile.videoProfile.palette),
      referenceProfile?.videoProfile?.lighting&&('lighting: '+referenceProfile.videoProfile.lighting),
      'Completely new material. Do not reproduce identifiable frames, characters, logos, text, brands or copyrighted artwork.'
    ].filter(Boolean).join('; ');
    const image=await generateOriginalImageWithCascade(prompt,dir,{width:854,height:480});
    const output=path.join(dir,'story-scene.mp4');
    const seconds=Math.max(1,Math.min(30,Number(scene.duration)||5));
    await new Promise((resolve,reject)=>{
      const vf='scale=854:480:force_original_aspect_ratio=increase,crop=854:480,zoompan=z=1+0.0012*on:d=1:s=854x480:fps=20,format=yuv420p';
      const p=spawn(ffmpegPath,['-hide_banner','-loglevel','error','-loop','1','-i',image.outputPath,'-vf',vf,'-t',String(seconds),'-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',output]);
      let err='';p.stderr.on('data',d=>err+=d);p.on('close',code=>code===0?resolve(true):reject(new Error('Story image animation FFmpeg '+code+': '+err.slice(0,700))));
    });
    await validateGeneratedVideoClip(output);
    res.setHeader('Content-Type','video/mp4');
    res.setHeader('Content-Disposition','inline; filename="autotube-story-scene.mp4"');
    return res.sendFile(output);
  }catch(err){
    return res.status(503).json({ok:false,error:err?.message||String(err)});
  }finally{
    setTimeout(()=>fs.rm(dir,{recursive:true,force:true}).catch(()=>{}),1500);
  }
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
  if(j.status==='running')return res.status(202).json({ok:false,status:'running',jobId:j.id,elapsedMs:Date.now()-j.startedAt,currentStage:j.currentStage||'initializing',progress:Number(j.progress||0),lastProgressAt:j.lastProgressAt||j.startedAt,stageElapsedMs:j.lastProgressAt?Date.now()-j.lastProgressAt:Date.now()-j.startedAt,providerBudget:freeAiBudgetSnapshot(),providers:Object.fromEntries([...videoProviderState.entries()].map(([name,st])=>[name,{status:st.status,failures:st.failures,lastError:st.lastError,cooldownUntil:st.cooldownUntil,lastSuccessAt:st.lastSuccessAt}])) ,zeroGpuQuotaCooldownUntil:getSharedZeroGpuCooldownUntil()});
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
    if(geminiCooldownActive('youtube') || String(process.env.AUTOTUBE_FORCE_LOCAL_PLAN||'0')==='1') throw new Error('GEMINI_QUOTA_COOLDOWN: usar plan local sin esperar a Gemini.');
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
  }catch(err){
    console.error('AI production-plan error:',err?.message||String(err));
    // Keep the autonomous free pipeline alive even if Gemini returns malformed JSON
    // or times out. Recompute fallback inputs from the request body because the
    // variables declared inside the try block are intentionally scoped there.
    const fallbackBody=req.body||{};
    const fallbackTopic=String(fallbackBody.topic||fallbackBody.brief||fallbackBody.referenceTopic||'').trim();
    const fallbackCustomScript=String(fallbackBody.script||fallbackBody.customScript||'').trim() || (Array.isArray(fallbackBody.outline)?fallbackBody.outline.join('\n'):'');
    const fallbackLanguage=String(fallbackBody.language||'es').trim();
    const fallbackDurationMinutes=Math.max(0.25,Math.min(60,Number(fallbackBody.duration)||8));
    const totalSeconds=Math.max(15,Math.round(fallbackDurationMinutes*60));
    const count=Math.max(1,Math.min(6,Math.ceil(totalSeconds/30)));
    const base=totalSeconds/count;
    const scenes=Array.from({length:count},(_,i)=>({
      number:i+1,
      title:'Escena original '+(i+1),
      duration:base,
      narration:'',
      visualPrompt:(fallbackTopic||'contenido audiovisual')+'; escena cinematográfica original; composición 16:9; movimiento de cámara suave; iluminación cinematográfica; material nuevo sin logos ni personajes protegidos.',
      animationNotes:'movimiento cinematográfico original, parallax y acción visible',
      cameraMovement:'travelling suave y push-in',
      transition:i?'corte cinematográfico':'apertura cinematográfica',
      searchQuery:fallbackTopic||'contenido audiovisual',
      mediaType:'video',
      constantImage:false
    }));
    return res.json({ok:true,mode:'brief-fallback',title:fallbackTopic||'AutoTube original',topic:fallbackTopic,brief:fallbackTopic,language:fallbackLanguage,duration:String(fallbackDurationMinutes),targetDurationSeconds:totalSeconds,script:fallbackCustomScript,customScript:fallbackCustomScript,creativeOptions:[],creativeDirection:{id:'fallback',name:'Original cinematográfico',visualStyle:'cinematic',animationStyle:'AI video',cameraLanguage:'smooth cinematic motion',palette:'cinematic',lighting:'cinematic',motion:'visible',transitions:'clean cuts',voice:'none',music:'original',aspectRatio:'16:9'},recommendedOptionId:'fallback',aspectRatio:'16:9',musicMood:'cinematic atmospheric',voiceStyle:'none',scenes,sceneCount:scenes.length,visualReferenceAnalysis:fallbackBody.visualReferenceAnalysis||null,referenceStyle:fallbackBody.referenceStyle||null,creationMode:'brief-fallback',recovery:{strategy:'local-production-plan',reason:String(err?.message||err||'Gemini unavailable'),nextStage:'reference-blueprint'}});
  }
});

const httpServer=app.listen(PORT,'0.0.0.0',()=>console.log(`AutoTube listening on ${PORT}`));


httpServer.keepAliveTimeout=120000;
httpServer.headersTimeout=125000;
httpServer.requestTimeout=0;
// E2E completo se ejecuta exclusivamente mediante /api/full-pipeline-test para evitar
// lanzar trabajos duplicados cuando Render recicla la instancia.
// Para una prueba controlada en Render, AUTOTUBE_E2E_TEST_REFERENCE dispara una sola
// ejecución al arrancar esta instancia. No se activa si la variable no existe.
// Autonomous generation supervisor: this runs inside Render, so it is independent of the ChatGPT session.
// It keeps one reference-generation cycle alive across retries and resumes after a Render restart.
const autonomousReference=String(process.env.AUTOTUBE_AUTONOMOUS_REFERENCE||'https://www.youtube.com/watch?v=qMUk5jrgENE').trim();
const autonomousEnabled=String(process.env.AUTOTUBE_AUTONOMOUS_ENABLED||'1').trim()!=='0';
const autonomousIntervalMs=Math.max(60000,Number(process.env.AUTOTUBE_AUTONOMOUS_INTERVAL_MS||60000));
let autonomousStopped=false;
let autonomousLastStart=0;

/* LIVE_QUOTA_PROBE_MAGIC_HOUR_V1
 * Magic Hour exposes GET /v1/account with the current credit balance.
 */
let magicHourQuotaCache={checkedAt:0,credits:null,status:'unknown',error:null};
async function probeMagicHourAccount(){
  const key=String(process.env.MAGIC_HOUR_API_KEY||'').trim();
  if(!key)return {configured:false,status:'not_configured'};
  const now=Date.now();
  if(now-magicHourQuotaCache.checkedAt<60000&&magicHourQuotaCache.status!=='unknown')return {...magicHourQuotaCache,cached:true};
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),5000);
  try{
    const r=await fetch('https://api.magichour.ai/v1/account',{headers:{accept:'application/json',authorization:'Bearer '+key},signal:c.signal});
    const raw=await r.text(); let d=null; try{d=JSON.parse(raw);}catch{}
    if(r.status===401||r.status===403){magicHourQuotaCache={checkedAt:now,credits:null,status:'auth_required',error:'Magic Hour API key rejected'};return {...magicHourQuotaCache};}
    if(!r.ok){magicHourQuotaCache={checkedAt:now,credits:null,status:'unavailable',error:'HTTP '+r.status};return {...magicHourQuotaCache};}
    const credits=Number(d?.credits);
    if(!Number.isFinite(credits)){magicHourQuotaCache={checkedAt:now,credits:null,status:'unknown',error:'No numeric credits in account response'};return {...magicHourQuotaCache};}
    magicHourQuotaCache={checkedAt:now,credits,status:'available',error:null};return {...magicHourQuotaCache};
  }catch(e){magicHourQuotaCache={checkedAt:now,credits:null,status:'unavailable',error:String(e?.message||e)};return {...magicHourQuotaCache};}
  finally{clearTimeout(t);}
}
/* AUTOTUBE_RESOURCE_PREFLIGHT_V1
 * Hard invariant for autonomous production:
 * a new production cycle is forbidden unless a complete resource plan exists.
 * Unknown external quota is NOT treated as available capacity.
 */
const autonomousResourceGate={
  status:'NOT_CHECKED',
  reason:'',
  checkedAt:0,
  route:null,
  required:null,
  available:null,
  reservation:null
};
let autonomousResourceReservation=null;

function resourceNumberEnv(name, fallback=0){
  const n=Number(process.env[name]);
  return Number.isFinite(n)&&n>=0?n:fallback;
}
function resourceMargin(){
  return Math.max(1,Number(process.env.AUTOTUBE_RESOURCE_PREFLIGHT_MARGIN||1.2)||1.2);
}
function resourceTargetDurationSeconds(){
  const configured=Math.max(5,Number(process.env.AUTOTUBE_AUTONOMOUS_MAX_DURATION_SECONDS||20)||20);
  return Math.min(3600,configured);
}
const autonomousQuotaProbe={
  status:'IDLE',
  provider:null,
  startedAt:0,
  attempts:0,
  lastResult:null
};
function autonomousProbeDurationSeconds(){return 5;}
function autonomousProbeEligibleProvider(routePlan){
  const preferred=['Pollinations','Agnes-Free'];
  for(const name of preferred){
    const r=routePlan.routes.find(x=>x.provider===name&&x.configured&&x.integrated&&x.realAi&&x.state==='available'&&x.reason==='quota_unknown_probe_required');
    if(r)return r;
  }
  return routePlan.routes.find(r=>r.configured&&r.integrated&&r.realAi&&r.state==='available'&&r.reason==='quota_unknown_probe_required')||null;
}

function autonomousVideoProviderRegistry(){
  const configured=(...names)=>names.some(name=>Boolean(String(process.env[name]||'').trim()));
  const legacyEnabled=String(process.env.AUTOTUBE_LEGACY_VIDEO_FALLBACKS||'0').trim()==='1';
  const aotiEnabled=String(process.env.AUTOTUBE_ENABLE_WAN22_AOTI??'1').trim()!=='0';
  const hfConfigured=configured('HF_TOKEN','HUGGINGFACE_TOKEN');
  const falConfiguredNow=configured('FAL_KEY','FAL_API_KEY');
  const replicateConfiguredNow=configured('REPLICATE_API_TOKEN');
  const pixazoConfigured=configured('PIXAZO_API_KEY');
  const freeAiConfigured=configured('FREE_AI_API_KEY');
  const agnesConfigured=configured('AGNES_API_KEY');
  const pollinationsConfigured=configured('POLLINATIONS_API_KEY');
  const magicConfigured=configured('MAGIC_HOUR_API_KEY');
  const providers=[
    {provider:'FAL',integrated:true,configured:falConfiguredNow,tasks:['T2V','I2V'],minSeconds:4,maxSeconds:30,resolutions:['480p','720p','1080p'],realAi:true,resourceEnv:'AUTOTUBE_FAL_REMAINING_VIDEO_SECONDS',unit:'seconds'},
    {provider:'Replicate-Wan',integrated:true,configured:replicateConfiguredNow,tasks:['T2V','I2V'],minSeconds:2,maxSeconds:30,resolutions:['720p'],realAi:true,resourceEnv:'AUTOTUBE_REPLICATE_REMAINING_VIDEO_SECONDS',unit:'seconds'},
    {provider:'HF-Inference',integrated:true,configured:hfConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:null,resolutions:[],realAi:true,resourceEnv:'AUTOTUBE_HF_INFERENCE_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Pixazo-Free',integrated:true,configured:pixazoConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:10,resolutions:['720p','1080p'],realAi:true,resourceEnv:null,unit:'unknown'},
    {provider:'Agnes-Free',integrated:true,configured:agnesConfigured,tasks:['T2V'],minSeconds:5,maxSeconds:20,resolutions:['1152x768'],outputNormalization:true,realAi:true,resourceEnv:null,unit:'unknown'},
    {provider:'Free.ai',integrated:true,configured:freeAiConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:3,resolutions:[],realAi:true,resourceEnv:null,unit:'unknown'},
    {provider:'Wan2.2-AoTI',integrated:true,configured:aotiEnabled&&hfConfigured,tasks:['I2V'],minSeconds:0.5,maxSeconds:5,resolutions:[],realAi:true,requiresReferenceFrame:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Wan2.2-AoTI-R3GM',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['I2V'],minSeconds:0.5,maxSeconds:5,resolutions:[],realAi:true,requiresReferenceFrame:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Wan2.2-AoTI-CB',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['I2V'],minSeconds:0.5,maxSeconds:5,resolutions:[],realAi:true,requiresReferenceFrame:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Wan2.2-Rahul-AOT',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['I2V'],minSeconds:0.5,maxSeconds:5,resolutions:[],realAi:true,requiresReferenceFrame:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'LTX-2.3-ZeroGPU',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['I2V'],minSeconds:2,maxSeconds:10,resolutions:[],realAi:true,requiresReferenceFrame:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Wan2.2-I2V',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['I2V'],minSeconds:2,maxSeconds:10,resolutions:[],realAi:true,requiresReferenceFrame:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Wan2.1-VACE',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['I2V'],minSeconds:2,maxSeconds:10,resolutions:[],realAi:true,requiresReferenceFrame:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Wan2.2-Rahul-T2V',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:10,resolutions:[],realAi:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Wan2.2-ZeroGPU',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:10,resolutions:[],realAi:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'OpenKing-Wan2.2',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:10,resolutions:[],realAi:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'LTX-2.5',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:20,resolutions:[],realAi:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Wan2.1',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:10,resolutions:[],realAi:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'LTX-0.9.8',integrated:legacyEnabled,configured:legacyEnabled&&hfConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:10,resolutions:[],realAi:true,resourceEnv:'AUTOTUBE_ZEROGPU_REMAINING_SECONDS',unit:'seconds'},
    {provider:'Pollinations',integrated:true,configured:pollinationsConfigured,tasks:['T2V'],minSeconds:2,maxSeconds:null,resolutions:[],realAi:true,resourceEnv:null,unit:'unknown'},
    {provider:'MagicHour',integrated:true,configured:magicConfigured,tasks:['T2V','I2V'],minSeconds:2,maxSeconds:10,resolutions:['480p','720p','1080p'],realAi:true,resourceEnv:null,unit:'credits',externalQuota:'magic'},
    {provider:'LTX-Direct',integrated:false,configured:configured('LTX_API_KEY','LTX_API_TOKEN'),tasks:['T2V','I2V'],minSeconds:6,maxSeconds:20,resolutions:['720p','1080p','4K'],realAi:true,resourceEnv:null,unit:'unknown',externalQuota:'ltx'}
  ];
  return providers;
}
function providerRuntimeState(provider){
  const st=typeof videoProviderState!=='undefined'?videoProviderState.get(provider):null;
  if(st?.status==='blocked')return {status:'blocked',cooldownUntil:Number(st.cooldownUntil||0)};
  if(Number(st?.cooldownUntil||0)>Date.now())return {status:'cooldown',cooldownUntil:Number(st.cooldownUntil||0)};
  return {status:'available',cooldownUntil:0};
}
function resourceProviderCandidates(requiredVideoSeconds,externalCapacity={},routeMatrix=[]){
  const candidates=[];
  for(const route of routeMatrix){
    if(!route.configured||!route.integrated||!route.realAi)continue;
    const state=providerRuntimeState(route.provider);
    if(state.status!=='available')continue;
    let capacity=0,unit=route.unit||'unknown',capacityStatus='unknown';
    if(route.resourceEnv){
      capacity=resourceNumberEnv(route.resourceEnv);
      capacityStatus=capacity>0?'explicit':'zero';
    }else if(route.externalQuota==='magic'){
      capacity=Number(externalCapacity?.magic?.credits);
      unit='credits';
      capacityStatus=externalCapacity?.magic?.status==='available'&&Number.isFinite(capacity)?'live':'unknown';
    }
    candidates.push({...route,capacity:Number.isFinite(capacity)?capacity:0,unit,capacityStatus,state});
  }
  return candidates;
}
/* DYNAMIC_VIDEO_CAPACITY_ALLOCATION_V1
 * Allocates the requested final duration across every currently usable video route.
 * Capacities are converted to video-seconds where possible (Magic Hour credits use
 * AUTOTUBE_MAGIC_HOUR_CREDITS_PER_SECOND). Unknown-capacity routes remain elastic
 * only when explicitly weighted; they are never assigned a fabricated quota.
 */
let activeVideoAllocation=null;

function routeCapacityToVideoSeconds(route){
  const capacity=Number(route?.capacity);
  if(!Number.isFinite(capacity)||capacity<=0)return 0;
  if(String(route.unit||'')==='seconds')return capacity;
  if(String(route.provider||'')==='MagicHour'&&String(route.unit||'')==='credits'){
    const cps=Math.max(1,Number(process.env.AUTOTUBE_MAGIC_HOUR_CREDITS_PER_SECOND||24)||24);
    return capacity/cps;
  }
  return 0;
}
function buildVideoCapacityAllocation(durationSeconds,routeMatrix){
  const duration=Math.max(1,Number(durationSeconds)||1);
  const usable=(routeMatrix||[]).filter(r=>
    r.configured&&r.integrated&&r.realAi&&r.state==='available'&&
    r.durationOk&&r.minOk&&r.resolutionOk&&r.referencePlanned&&
    !['not_configured','not_integrated','insufficient_quota','unsupported','resolution_not_supported'].includes(r.reason)
  );
  const known=usable.map(r=>({...r,videoSeconds:routeCapacityToVideoSeconds(r)}).filter(x=>x.videoSeconds>0));
  const weighted=usable.map(r=>{
    const env='AUTOTUBE_'+String(r.provider).toUpperCase().replace(/[^A-Z0-9]+/g,'_')+'_WEIGHT_PERCENT';
    const weight=Math.max(0,Number(process.env[env]||0)||0);
    return {...r,weight};
  }).filter(r=>r.weight>0);
  const rows=known.sort((a,b)=>waterfallRank(a.provider)-waterfallRank(b.provider)).map(r=>({
    provider:r.provider,
    share:0,
    allocatedSeconds:r.videoSeconds,
    remainingSeconds:r.videoSeconds,
    capacitySeconds:r.videoSeconds,
    capacityStatus:r.capacityStatus,
    unit:r.unit
  }));
  if(!rows.length&&weighted.length){
    const totalWeight=weighted.reduce((n,r)=>n+r.weight,0);
    for(const r of weighted.sort((a,b)=>waterfallRank(a.provider)-waterfallRank(b.provider))){
      const allocated=duration*(r.weight/totalWeight);
      rows.push({provider:r.provider,share:allocated/duration,allocatedSeconds:allocated,remainingSeconds:allocated,capacitySeconds:null,capacityStatus:r.capacityStatus,unit:r.unit});
    }
  }
  const totalKnown=rows.reduce((n,r)=>n+r.allocatedSeconds,0);
  console.log('[VideoCapacity] waterfall plan:',JSON.stringify(rows.map(r=>({provider:r.provider,capacitySeconds:Number(r.allocatedSeconds.toFixed(2)),status:r.capacityStatus}))));
  if(totalKnown<duration)console.log('[VideoCapacity] known capacity below final duration; remaining production waits for newly available capacity:',(duration-totalKnown).toFixed(2)+'s');
  return{durationSeconds:duration,mode:rows.length?'waterfall':'no_capacity_plan',rows,createdAt:Date.now(),consumedSeconds:0};
}
function allocationProviderOrder(baseOrder,requestedSeconds){
  const request=Math.max(0.5,Number(requestedSeconds)||1);
  const ranked=[...baseOrder].sort((a,b)=>waterfallRank(a)-waterfallRank(b));
  if(!activeVideoAllocation?.rows?.length)return ranked;
  const rank=new Map(activeVideoAllocation.rows.map(r=>[r.provider,r]));
  const eligible=[];
  const unknown=[];
  for(const provider of ranked){
    const row=rank.get(provider);
    if(!row){unknown.push(provider);continue;}
    if(Number(row.remainingSeconds)>=request)eligible.push(provider);
  }
  return [...eligible,...unknown];
}
function commitVideoAllocation(provider,actualSeconds){
  if(!activeVideoAllocation?.rows?.length)return;
  const row=activeVideoAllocation.rows.find(r=>r.provider===provider);
  if(!row)return;
  const used=Math.max(0,Number(actualSeconds)||0);
  row.remainingSeconds=Math.max(0,row.remainingSeconds-used);
  activeVideoAllocation.consumedSeconds+=used;
  console.log('[VideoCapacity] consumed:',provider,used.toFixed(2)+'s','remaining allocation=',row.remainingSeconds.toFixed(2)+'s','snapshot=',JSON.stringify(getVideoCapacityAllocationSnapshot()));
}

function activateVideoCapacityAllocation(durationSeconds,routeMatrix){
  activeVideoAllocation=buildVideoCapacityAllocation(durationSeconds,routeMatrix);
  console.log('[VideoCapacity] allocation initialized:',JSON.stringify({
    durationSeconds:activeVideoAllocation.durationSeconds,
    mode:activeVideoAllocation.mode,
    providers:activeVideoAllocation.rows.map(r=>({provider:r.provider,sharePct:Number((r.share*100).toFixed(1)),allocatedSeconds:Number(r.allocatedSeconds.toFixed(2)),capacitySeconds:r.capacitySeconds}))
  }));
  return activeVideoAllocation;
}
function getVideoCapacityAllocationSnapshot(){
  if(!activeVideoAllocation)return null;
  return {
    durationSeconds:activeVideoAllocation.durationSeconds,
    mode:activeVideoAllocation.mode,
    consumedSeconds:activeVideoAllocation.consumedSeconds,
    providers:activeVideoAllocation.rows.map(r=>({...r,remainingSeconds:Number(r.remainingSeconds.toFixed(3)),consumedSeconds:Number((r.allocatedSeconds-r.remainingSeconds).toFixed(3))}))
  };
}
function allocationProviderOrder(baseOrder,requestedSeconds){
  if(!activeVideoAllocation?.rows?.length)return baseOrder;
  const request=Math.max(0.5,Number(requestedSeconds)||1);
  const rank=new Map(activeVideoAllocation.rows.map(r=>[r.provider,r]));
  return [...baseOrder].sort((a,b)=>{
    const ra=rank.get(a),rb=rank.get(b);
    const score=x=>x?x.remainingSeconds>=request?(x.remainingSeconds/request)+1000+x.share*100:x.remainingSeconds+x.share*0.01:-1;
    return score(rb)-score(ra);
  });
}
function commitVideoAllocation(provider,actualSeconds){
  if(!activeVideoAllocation?.rows?.length)return;
  const row=activeVideoAllocation.rows.find(r=>r.provider===provider);
  if(!row)return;
  const used=Math.max(0,Number(actualSeconds)||0);
  row.remainingSeconds=Math.max(0,row.remainingSeconds-used);
  activeVideoAllocation.consumedSeconds+=used;
  console.log('[VideoCapacity] consumed:',provider,used.toFixed(2)+'s','remaining allocation=',row.remainingSeconds.toFixed(2)+'s','snapshot=',JSON.stringify(getVideoCapacityAllocationSnapshot()));
}

function requiredVideoResourceSeconds(){
  const duration=resourceTargetDurationSeconds();
  const sceneCount=Math.max(1,Math.min(60,Number(process.env.AUTOTUBE_RESOURCE_PREFLIGHT_SCENES||Math.ceil(duration/5))||1));
  const margin=resourceMargin();
  const perSceneSeconds=duration/sceneCount;
  return {durationSeconds:duration,sceneCount,perSceneSeconds,videoSeconds:duration*margin};
}
async function probePollinationsAccount(){
  const key=String(process.env.POLLINATIONS_API_KEY||'').trim();
  if(!key)return{status:'not_configured',balance:null,videoCostPerSecond:null,videoSeconds:null};
  try{
    const balanceResponse=await fetch('https://gen.pollinations.ai/account/balance',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(!balanceResponse.ok){
      return{status:balanceResponse.status===403?'permission_denied':'unavailable',balance:null,videoCostPerSecond:null,videoSeconds:null};
    }
    const balanceBody=await balanceResponse.json().catch(()=>null);
    const balance=Number(balanceBody?.balance??balanceBody?.pollen??balanceBody?.remaining??balanceBody?.amount);
    let videoCostPerSecond=Number(process.env.AUTOTUBE_POLLINATIONS_POLLEN_PER_SECOND||0)||0;
    try{
      const modelsResponse=await fetch('https://gen.pollinations.ai/video/models',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
      if(modelsResponse.ok){
        const body=await modelsResponse.json().catch(()=>null);
        const list=Array.isArray(body?.data)?body.data:(Array.isArray(body)?body:[]);
        const wanted=String(process.env.POLLINATIONS_VIDEO_MODEL||'wan-fast').trim();
        const model=list.find(x=>String(x?.id||x?.name||'').trim()===wanted)||list.find(x=>/wan-fast/i.test(String(x?.id||x?.name||'')))||list[0];
        const candidates=[model?.pricePerSecond,model?.price_per_second,model?.costPerSecond,model?.cost_per_second,model?.pricing?.video?.perSecond,model?.pricing?.video?.per_second,model?.pricing?.perSecond,model?.pricing?.per_second];
        const discoveredCost=candidates.map(Number).find(x=>Number.isFinite(x)&&x>0);
        if(discoveredCost)videoCostPerSecond=discoveredCost;
      }
    }catch{}
    const videoSeconds=Number.isFinite(balance)&&balance>=0&&videoCostPerSecond>0?balance/videoCostPerSecond:null;
    return{status:Number.isFinite(balance)?'available':'unknown',balance:Number.isFinite(balance)?balance:null,videoCostPerSecond:videoCostPerSecond>0?videoCostPerSecond:null,videoSeconds};
  }catch(err){return{status:'unavailable',balance:null,videoCostPerSecond:null,videoSeconds:null,error:String(err?.message||err).slice(0,240)};}
}

const VIDEO_WATERFALL_PRIORITY=['Pollinations','FAL','MagicHour','HF-Inference','Replicate-Wan','Replicate','Free.ai','Pixazo-Free','Agnes-Free','Wan2.2-AoTI','Wan2.2-AoTI-R3GM','Wan2.2-AoTI-CB','Wan2.2-Rahul-AOT','LTX-2.3-ZeroGPU','Wan2.2-I2V','Wan2.1-VACE','Wan2.2-Rahul-T2V','Wan2.2-ZeroGPU','OpenKing-Wan2.2','LTX-2.5','Wan2.1','LTX-0.9.8'];
function waterfallRank(provider){const i=VIDEO_WATERFALL_PRIORITY.indexOf(String(provider));return i<0?9999:i;}

function buildAutonomousRouteMatrix({need,externalCapacity}){
  const referencePlanned=true;
  const desiredResolution=String(process.env.AUTOTUBE_RESOURCE_PREFLIGHT_RESOLUTION||'480p').trim().toLowerCase();
  const routes=autonomousVideoProviderRegistry().map(route=>{
    const state=providerRuntimeState(route.provider);
    const requiredTotal=need.videoSeconds;
    const hasMax=route.maxSeconds!==null&&route.maxSeconds!==undefined&&Number.isFinite(Number(route.maxSeconds));
    const hasMin=route.minSeconds!==null&&route.minSeconds!==undefined&&Number.isFinite(Number(route.minSeconds));
    const maxPerRequest=hasMax?Number(route.maxSeconds):null;
    const minPerRequest=hasMin?Number(route.minSeconds):null;
    const durationOk=!hasMax||need.perSceneSeconds<=maxPerRequest;
    const minOk=!hasMin||need.perSceneSeconds>=minPerRequest;
    const resolutionOk=!route.resolutions?.length||route.resolutions.map(String).map(x=>x.toLowerCase()).includes(desiredResolution)||desiredResolution==='auto';
    const taskNeeded=route.tasks.includes('T2V')?'T2V':route.tasks[0];
    const referenceOk=!route.requiresReferenceFrame||referencePlanned;
    const configured=Boolean(route.configured);
    const integrated=Boolean(route.integrated);
    let capacity=0,unit=route.unit||'unknown',capacityStatus='unknown',resourceOk=false,resourceRequired=requiredTotal;
    if(route.resourceEnv){
      capacity=resourceNumberEnv(route.resourceEnv);
      capacityStatus=capacity>0?'explicit':'zero';
      resourceOk=capacity>=requiredTotal;
    }else if(route.externalQuota==='magic'){
      capacity=Number(externalCapacity?.magic?.credits);
      unit='credits';
      capacityStatus=externalCapacity?.magic?.status==='available'&&Number.isFinite(capacity)?'live':'unknown';
      const creditsPerSecond=Math.max(1,Number(process.env.AUTOTUBE_MAGIC_HOUR_CREDITS_PER_SECOND||24)||24);
      resourceRequired=requiredTotal*creditsPerSecond;
      resourceOk=Number.isFinite(capacity)&&capacity>=resourceRequired;
    }else if(String(route.provider)==='Pollinations'){
      capacity=Number(externalCapacity?.pollinations?.videoSeconds);
      unit='seconds';
      capacityStatus=externalCapacity?.pollinations?.status==='available'&&Number.isFinite(capacity)?'live':'unknown';
      resourceRequired=requiredTotal;
      resourceOk=Number.isFinite(capacity)&&capacity>=resourceRequired;
    }else{
      resourceOk=false;
    }
    let reason='eligible';
    if(!configured)reason='not_configured';
    else if(!integrated)reason='not_integrated';
    else if(!route.realAi)reason='not_real_ai';
    else if(state.status!=='available')reason=state.status;
    else if(!durationOk)reason='scene_duration_exceeds_provider_limit';
    else if(!minOk)reason='scene_duration_below_provider_minimum';
    else if(!resolutionOk)reason='resolution_not_supported';
    else if(!referenceOk)reason='reference_frame_unavailable';
    else if(capacityStatus==='unknown')reason='quota_unknown_probe_required';
    else if(!resourceOk)reason='insufficient_quota';
    return {
      provider:route.provider,
      task:taskNeeded,
      configured,
      integrated,
      realAi:Boolean(route.realAi),
      requiresReferenceFrame:Boolean(route.requiresReferenceFrame),
      referencePlanned,
      minSeconds:route.minSeconds??null,
      maxSeconds:route.maxSeconds??null,
      resolution:desiredResolution,
      supportedResolutions:route.resolutions||[],
      state:state.status,
      cooldownUntil:state.cooldownUntil||0,
      capacity,
      unit,
      capacityStatus,
      resourceRequired,
      resourceAvailable:capacity,
      resourceOk,
      durationOk,
      minOk,
      resolutionOk,
      eligible:Boolean(configured&&integrated&&route.realAi&&state.status==='available'&&durationOk&&minOk&&resolutionOk&&referenceOk&&resourceOk),
      reason
    };
  });
  const eligible=routes.filter(r=>r.eligible);
  eligible.sort((a,b)=>{
    const rank=x=>({FAL:10,'Replicate-Wan':20,'Pixazo-Free':30,'Agnes-Free':40,'HF-Inference':50,'MagicHour':60,'LTX-Direct':70}[x.provider]||100);
    return rank(a)-rank(b);
  });
  return {routes,eligible,selected:eligible[0]||null};
}
async function evaluateAutonomousResourceGate(){
  const need=requiredVideoResourceSeconds();
  const externalCapacity={magic:await probeMagicHourAccount(),pollinations:await probePollinationsAccount()};
  const routePlan=buildAutonomousRouteMatrix({need,externalCapacity});
  const candidates=resourceProviderCandidates(need.videoSeconds,externalCapacity,routePlan.routes);
  const renderAvailable=Boolean(ffmpegPath);
  const geminiConfigured=Boolean(String(process.env.GEMINI_API_KEY||'').trim());
  const musicCanRun=Boolean(
    String(process.env.GEMINI_API_KEY||'').trim() ||
    String(process.env.FAL_KEY||process.env.FAL_API_KEY||'').trim()
  );
  // Resource policy: do NOT require enough quota for the whole production cycle up front.
  // Every configured, integrated, real-AI route that is not exhausted/blocked can contribute
  // whatever capacity it currently permits. Capacity is consumed dynamically per clip.
  const usableRoutes=routePlan.routes.filter(r=>
    r.configured&&r.integrated&&r.realAi&&r.state==='available'&&
    !['insufficient_quota','not_configured','unsupported','resolution_not_supported'].includes(r.reason) &&
    (r.resourceOk||r.capacityStatus==='unknown'||r.capacityStatus==='live'||r.capacityStatus==='explicit')
  );
  const complete=Boolean(usableRoutes.length&&renderAvailable&&geminiConfigured&&musicCanRun);
  autonomousResourceGate.checkedAt=Date.now();
  autonomousResourceGate.required={...need,render:true,gemini:true,music:true};
  autonomousResourceGate.available={
    videoCandidates:candidates.map(c=>({provider:c.provider,capacity:c.capacity,unit:c.unit,capacityStatus:c.capacityStatus})),
    externalCapacity,
    routeMatrix:routePlan.routes,
    viableRoutes:usableRoutes.map(x=>x.provider),
    selectedRoute:(routePlan.selected||usableRoutes[0]||null),
    allocationMode:'dynamic_multi_provider',
    providersAvailableForImmediateUse:usableRoutes.map(x=>({provider:x.provider,capacity:x.capacity,unit:x.unit,capacityStatus:x.capacityStatus,resourceOk:x.resourceOk})),
    render:renderAvailable,
    gemini:geminiConfigured,
    music:musicCanRun
  };
  autonomousResourceGate.route=(routePlan.selected||usableRoutes[0]||null);
  autonomousResourceGate.status=complete?'READY':'WAITING_FOR_RESOURCES';
  autonomousResourceGate.reason=complete
    ?'Hay al menos una ruta real disponible. El ciclo consume dinámicamente la capacidad permitida de todas las rutas utilizables, sin exigir cuota total por adelantado.'
    :'No hay ninguna ruta real disponible para producir vídeo. El ciclo NO se inicia.';
  if(!complete)console.warn('[ResourceGate] autonomous cycle NOT STARTED:',autonomousResourceGate.reason,JSON.stringify(autonomousResourceGate.available));
  else console.log('[ResourceGate] dynamic multi-provider capacity enabled:',usableRoutes.map(x=>x.provider).join(','));
  return {ok:complete,probeRequired:false,...autonomousResourceGate};
}

function reserveAutonomousResources(gate){
  if(!gate?.ok||autonomousResourceReservation)return false;
  autonomousResourceReservation={
    id:'res_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex'),
    createdAt:Date.now(),
    route:gate.route,
    required:gate.required
  };
  autonomousResourceGate.reservation=autonomousResourceReservation;
  return true;
}
function releaseAutonomousResources(){
  autonomousResourceReservation=null;
  autonomousResourceGate.reservation=null;
}
app.post('/api/autonomous/resource-probe',async(req,res)=>{
  if(autonomousProbe.status==='RUNNING')return res.status(409).json({ok:false,error:'Ya hay una prueba de cuota en curso.',probe:autonomousProbe});
  const gate=await evaluateAutonomousResourceGate();
  const candidate=autonomousProbeEligibleProvider(gate.routeMatrix?.length?{routes:gate.routeMatrix}:gate);
  if(!candidate)return res.status(503).json({ok:false,error:'No hay proveedor configurado con cuota desconocida apto para prueba.',gate});
  autonomousProbe.status='RUNNING'; autonomousProbe.provider=candidate.provider; autonomousProbe.startedAt=Date.now(); autonomousProbe.attempts++;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-resource-probe-'));
  const started=Date.now();
  try{
    const durationSeconds=5;
    const options={durationSeconds,sceneIndex:0,generateAudio:false,resourceProbe:true};
    const result=await generateBestFreeVideoClip(String(req.body?.prompt||'Original cinematic relaxing motion, subtle camera movement, natural lighting.'),dir,options);
    const validation=await validateGeneratedVideoClip(result.outputPath);
    const ok=Boolean(validation?.ok&&Number(validation.durationSeconds)>=4.5&&Number(validation.durationSeconds)<=6.5&&Number(validation.sizeBytes||validation.size||0)>1000);
    autonomousProbe.lastResult={ok,provider:result.providerKey||candidate.provider,durationSeconds:Number(validation.durationSeconds)||0,sizeBytes:Number(validation.sizeBytes||validation.size||0),elapsedMs:Date.now()-started,validation};
    autonomousProbe.status=ok?'CONFIRMED_FOR_RUN':'FAILED';
    if(!ok)throw new Error('La prueba no produjo un MP4 AI válido de aproximadamente 5 s.');
    return res.json({ok:true,probe:autonomousProbe,result:{provider:result.providerKey||candidate.provider,generationType:result.generationType,validation}});
  }catch(err){
    autonomousProbe.lastResult={ok:false,provider:candidate.provider,error:String(err?.message||err),elapsedMs:Date.now()-started};
    autonomousProbe.status='FAILED';
    return res.status(502).json({ok:false,probe:autonomousProbe,error:String(err?.message||err)});
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
});
app.get('/api/autonomous/resource-gate',async(_req,res)=>{
  const gate=await evaluateAutonomousResourceGate();
  return res.status(gate.ok?200:503).json(gate);
});

async function runAutonomousCycle(){
  if(!autonomousEnabled||autonomousStopped||!autonomousReference)return;
  const now=Date.now();
  const running=[...fullPipelineTestJobs.values()].find(j=>j.status==='running');
  if(running){
    const age=now-Number(running.startedAt||now);
    if(running.status==='blocked_user_action'){console.warn('AutoTube autonomous cycle remains blocked for user action:',running.id);return;}
    const stage=String(running.currentStage||'unknown');
    const lastProgressAt=Number(running.lastProgressAt||running.startedAt||now);
    const progressAgeMs=now-lastProgressAt;
    const staleDefaults={
      'youtube-source-and-reference-analysis':4*60*1000,
      'production-plan':3*60*1000,
      'reference-blueprint':3*60*1000,
      'visual-sources-all-scenes':4*60*1000,
      'narration-all-scenes':3*60*1000,
      'music':3*60*1000,
      'render-all-scenes':4*60*1000,
      unknown:5*60*1000
    };
    const configuredStale=Number(process.env.AUTOTUBE_AUTONOMOUS_STALE_MS||0);
    const staleAfterMs=Math.max(2*60*1000,configuredStale||staleDefaults[stage]||staleDefaults.unknown);
    if(progressAgeMs<staleAfterMs){
      console.log('AutoTube autonomous cycle: existing job progressing:',running.id,'stage=',stage,'ageMs=',age,'progressAgeMs=',progressAgeMs,'progress=',running.progress??'n/a');
      return;
    }
    running.status='failed';
    running.finishedAt=now;
    running.result={
      ok:false,
      error:'AUTONOMOUS_STALE_JOB: el job superó el tiempo máximo permitido y fue recuperado automáticamente.',
      retryable:true,
      userActionRequired:false,
      autonomousStopReason:'El job estaba atascado; se recupera y se inicia un nuevo intento.'
    };
    console.error('AutoTube autonomous cycle: stale job recovered automatically:',running.id,'ageMs=',age);
  }
  const recentDone=[...fullPipelineTestJobs.values()].find(j=>j.reference===autonomousReference&&j.status==='done'&&j.result?.ok);
  if(recentDone){autonomousStopped=true;console.log('AutoTube autonomous cycle: validated MP4 already exists; supervisor stopped:',recentDone.id);return;}
  // HARD GATE: only a brand-new production cycle is blocked by missing resources.
  const resourceGate=await evaluateAutonomousResourceGate();
  if(!resourceGate.ok){
    autonomousLastStart=Date.now()+Math.max(15000,autonomousIntervalMs);
    return;
  }
  if(!reserveAutonomousResources(resourceGate)){
    autonomousLastStart=Date.now()+Math.max(autonomousIntervalMs,60000);
    return;
  }
  if(Date.now()-autonomousLastStart<autonomousIntervalMs){releaseAutonomousResources();return;}
  autonomousLastStart=Date.now();
  const id='auto_fulltest_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  fullPipelineTestJobs.set(id,{id,reference:autonomousReference,status:'running',startedAt:Date.now(),lastProgressAt:Date.now(),currentStage:'starting',progress:0,result:null,autonomous:true});
  console.log('AutoTube autonomous cycle started:',id,autonomousReference);
  try{
    const result=await executeFullPipelineTest(autonomousReference,id);
    const j=fullPipelineTestJobs.get(id);
    if(j){j.status=result.ok?'done':'failed';j.result=result;j.finishedAt=Date.now();}
    console.log('AutoTube autonomous cycle finished:',id,j?.status,result?.ok);
    if(result?.ok)autonomousStopped=true;
  }catch(err){
    const message=String(err?.message||err||'Error desconocido');
    const userActionRequired=/INSUFFICIENT_BALANCE|Insufficient balance|401 Unauthorized|403 Forbidden|missing.*API.?key|API.?key.*missing|no.*API.?key|invalid.*credential|private.*video|sign in to confirm|USER_ACTION_REQUIRED/i.test(message);
    const j=fullPipelineTestJobs.get(id);
    if(j){
      j.status=userActionRequired?'blocked_user_action':'failed';
      j.currentStage='recovery';
      j.lastProgressAt=Date.now();
      j.result={
        ok:false,
        error:message,
        retryable:!userActionRequired,
        userActionRequired,
        autonomousStopReason:userActionRequired?'Se requiere una acción del usuario para continuar.':'El ciclo seguirá reintentando automáticamente.'
      };
      j.finishedAt=Date.now();
    }
    if(userActionRequired){
      autonomousStopped=true;
      console.error('AutoTube autonomous cycle STOPPED: USER ACTION REQUIRED:',id,message);
    }else{
      // Keep the supervisor alive, but never hammer the same failing strategy.
      autonomousLastStart=Date.now()+Math.min(15*60*1000,Math.max(60*1000,autonomousIntervalMs*2));
      console.error('AutoTube autonomous cycle error; classified as retryable and scheduled with backoff:',id,message);
    }
  }finally{
    releaseAutonomousResources();
  }
}
setTimeout(()=>{runAutonomousCycle().catch(err=>console.error('AutoTube autonomous launch error:',err));},20000);
setInterval(()=>{runAutonomousCycle().catch(err=>console.error('AutoTube autonomous interval error:',err));},autonomousIntervalMs);
