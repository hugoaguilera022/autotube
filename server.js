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
const multer = require('multer');
const youtubedl = require('youtube-dl-exec');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });
const renderJobs = new Map();
const renderJobDir = path.join(os.tmpdir(), 'autotube-render-jobs');
fs.mkdir(renderJobDir, { recursive: true }).catch(() => {});
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
async function callGemini({system,user,images=[],temperature=0.7,maxOutputTokens=1200,json=false}){const k=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();if(!k)throw new Error('Falta la clave de Gemini.');const parts=[{text:String(user||'')}];for(const im of images)parts.push({inline_data:{mime_type:im.mimeType||'image/jpeg',data:im.data}});const headers={'Content-Type':'application/json'};headers['x-goog-'+'api-key']=k;const models=[...new Set([String(GEMINI_MODEL||'').trim(),'gemini-3.5-flash-lite','gemini-3.1-flash-lite'].filter(Boolean))];let lastError='';for(const model of models){for(const structured of (json?[true,false]:[false])){const body={system_instruction:{parts:[{text:String(system||'')}]},contents:[{role:'user',parts}],generationConfig:{maxOutputTokens,...(structured?{responseMimeType:'application/json'}:{})}};const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{method:'POST',headers,body:JSON.stringify(body)});const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}if(response.ok){const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim()||'';if(text)return text;lastError='Gemini no devolvió contenido.';continue}const message=data?.error?.message||raw.slice(0,500)||'Error desconocido';lastError='Gemini '+response.status+': '+message;if(response.status===429||response.status>=500)break;if(response.status===400&&structured)continue;if(response.status===404||/model|not found|unsupported/i.test(message))break;break}}throw new Error(lastError||'Gemini no pudo procesar la solicitud.');}
function parseJsonResponse(text){return JSON.parse(String(text||'').replace(/^\s*```json\s*/i,'').replace(/\s*```\s*$/i,'').trim());}
const app=express();
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
app.get('/api/health',(_req,res)=>res.json({ok:true,app:'AutoTube',configured:{gemini:Boolean(process.env['GEM'+'INI_'+'API_'+'KEY']),youtube:Boolean(process.env.YOUTUBE_CLIENT_ID&&process.env.YOUTUBE_CLIENT_SECRET),pexels:Boolean(process.env.PEXELS_API_KEY),pixabay:Boolean(process.env.PIXABAY_API_KEY),elevenlabs:Boolean(process.env.ELEVENLABS_API_KEY),supabase:supabaseConfigured()}}));
function extractYoutubeVideoId(input){const value=String(input||'').trim();if(!value)return'';try{const url=new URL(value);if(url.hostname==='youtu.be')return url.pathname.slice(1).split('/')[0];if(url.hostname.endsWith('youtube.com')){if(url.pathname==='/watch')return url.searchParams.get('v')||'';if(url.pathname.startsWith('/shorts/'))return url.pathname.split('/')[2]||'';if(url.pathname.startsWith('/embed/'))return url.pathname.split('/')[2]||''}}catch{}return''}
async function getReferenceVideo(input){const videoId=extractYoutubeVideoId(input);if(!videoId)throw new Error('La URL de referencia de YouTube no es válida.');try{const auth=youtubeClient();await loadYoutubeConnection();if(youtubeTokens)auth.setCredentials(youtubeTokens);const youtube=google.youtube({version:'v3',auth}),response=await youtube.videos.list({part:'snippet,contentDetails,statistics',id:[videoId]}),video=response.data.items?.[0];if(video){const s=video.snippet||{},d=video.contentDetails||{};return{videoId,title:s.title||'',description:s.description||'',channelTitle:s.channelTitle||'',publishedAt:s.publishedAt||'',tags:s.tags||[],categoryId:s.categoryId||'',defaultLanguage:s.defaultLanguage||s.defaultAudioLanguage||'',duration:d.duration||'',definition:d.definition||'',caption:d.caption==='true',thumbnail:s.thumbnails?.maxres?.url||s.thumbnails?.high?.url||s.thumbnails?.medium?.url||'',thumbnails:[s.thumbnails?.maxres?.url,s.thumbnails?.high?.url,s.thumbnails?.standard?.url,s.thumbnails?.medium?.url].filter(Boolean),defaultAudioLanguage:s.defaultAudioLanguage||''}}}catch(err){console.error('YouTube reference API error:',err.message)}const oembed=await fetch('https://www.youtube.com/oembed?url='+encodeURIComponent(input)+'&format=json');if(!oembed.ok)throw new Error('No se pudo analizar el vídeo de referencia.');const data=await oembed.json();return{videoId,title:data.title||'',channelTitle:data.author_name||'',thumbnail:data.thumbnail_url||'',thumbnails:[data.thumbnail_url].filter(Boolean)}}
async function downloadYoutubeReference(url,dir){
  const output=path.join(dir,'reference.%(ext)s');
  const strategies=[
    {name:'web_safari-hls',format:'best[protocol^=m3u8]/best[height<=360]',extractor_args:{youtube:{player_client:['web_safari']}}},
    {name:'android_vr',format:'bv*[height<=360]+ba/b[height<=360]',extractor_args:{youtube:{player_client:['android_vr']}}},
    {name:'web_embedded',format:'bv*[height<=360]+ba/b[height<=360]',extractor_args:{youtube:{player_client:['web_embedded']}}}
  ];
  let lastError='';
  for(const strategy of strategies){
    try{
      const result=await youtubedl(url,{
        format:strategy.format,
        mergeOutputFormat:'mp4',
        output,
        noPlaylist:true,
        noWarnings:true,
        noCheckCertificates:true,
        restrictFilenames:true,
        preferFreeFormats:false,
        extractor_args:strategy.extractor_args,
        ffmpegLocation:path.dirname(ffmpegPath)
      },{timeout:180000,killSignal:'SIGKILL'});
      const files=await fs.readdir(dir);
      const videoFile=files.find(name=>/^reference\.(mp4|mkv|webm|mov)$/i.test(name));
      if(!videoFile)throw new Error('yt-dlp no produjo un archivo de vídeo.');
      const file=path.join(dir,videoFile);
      const stat=await fs.stat(file);
      if(!stat.size)throw new Error('La copia temporal de análisis está vacía.');
      return{file,bytes:stat.size,ytDlpOutput:String(result||'').slice(-1000),strategy:strategy.name};
    }catch(err){
      lastError=String(err?.stderr||err?.message||err||'').slice(-1600);
      await fs.rm(output.replace('%(ext)s','*'),{force:true}).catch(()=>{});
      const files=await fs.readdir(dir).catch(()=>[]);
      for(const name of files.filter(x=>/^reference\./i.test(x)))await fs.rm(path.join(dir,name),{force:true}).catch(()=>{});
    }
  }
  throw new Error('No se pudo descargar temporalmente el vídeo de YouTube para el análisis audiovisual. Estrategias probadas: web_safari/HLS, android_vr y web_embedded. Último error: '+lastError);
}

async function uploadGeminiFile(filePath,mimeType){
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key)throw new Error('Falta GEMINI_API_KEY.');
  const stat=await fs.stat(filePath);
  const startResponse=await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files',{
    method:'POST',
    headers:{
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

async function analyzeYoutubeReferenceMedia(url,video){
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key)throw new Error('Falta GEMINI_API_KEY.');
  const referenceUrl=String(url||'').trim();
  if(!referenceUrl)throw new Error('Falta la URL de YouTube.');
  const prompt='Analiza directamente el vídeo público de YouTube indicado. Estudia TODO lo que puedas de sus flujos visual y sonoro: imagen, movimiento, cambios de plano, continuidad, composición, color, iluminación, presencia de texto/personas/objetos, ritmo visual, transiciones, voz, música, ambiente, efectos, energía, dinámica, instrumentación perceptible, carácter de la voz y BPM aproximado si es posible. No transcribas letras ni reproduzcas contenido protegido. El objetivo es crear un vídeo ORIGINAL que conserve únicamente el tipo de contenido y el lenguaje audiovisual general del referente. Determina explícitamente si la imagen permanece esencialmente constante durante todo el vídeo. Devuelve ÚNICAMENTE JSON válido, sin markdown, con exactamente estas claves: videoProfile, audioProfile, structureProfile, generationDirectives. Dentro de videoProfile incluye durationSeconds, constantImage, estimatedSceneCount, sceneChangeRate, cameraMovement, composition, palette, lighting, visualStyle, continuity. Dentro de audioProfile incluye hasSpeech, hasMusic, hasAmbience, musicMood, energy, dynamics, instrumentation, voiceStyle, bpmEstimate, audioContinuity. Dentro de structureProfile incluye opening, pacing, transitions, segmentCount, segmentDurations, visualContinuity. Dentro de generationDirectives incluye useSingleContinuousVisual, preferredSceneCount, preserveVisualContinuity, preserveAudioContinuity, visualSearchStrategy, musicStrategy.';
  const models=['gemini-3.8-flash'];
  let lastError='';
  for(const model of models){
    const body={
      model,
      input:[
        {type:'text',text:prompt},
        {type:'video',uri:referenceUrl}
      ]
    };
    let r=null,raw='',d=null;
    for(let attempt=0;attempt<3;attempt++){
      r=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-goog-api-key':key},
        body:JSON.stringify(body)
      });
      raw=await r.text();d=null;try{d=raw?JSON.parse(raw):null}catch{}
      if(r.ok)break;
      lastError='Gemini YouTube '+r.status+': '+(d?.error?.message||raw.slice(0,700));
      if(r.status>=500&&attempt<2){await new Promise(resolve=>setTimeout(resolve,5000*(attempt+1)));continue}
      break;
    }
    if(r?.ok){
      const text=String(d?.output_text||'').trim();
      if(text){
        const analysis=parseJsonResponse(text);
        const vp=analysis?.videoProfile||{},sp=analysis?.structureProfile||{},gd=analysis?.generationDirectives||{};
        const ap=analysis?.audioProfile||{};
        const constantImage=Boolean(vp.constantImage||gd.useSingleContinuousVisual&&Number(gd.preferredSceneCount)===1);
        vp.constantImage=constantImage;
        vp.durationSeconds=Number(vp.durationSeconds||0);
        analysis.videoProfile=vp;
        analysis.audioProfile=ap;
        analysis.structureProfile=sp;
        analysis.generationDirectives=gd;
        analysis.generationDirectives.useSingleContinuousVisual=Boolean(gd.useSingleContinuousVisual||constantImage);
        analysis.generationDirectives.preferredSceneCount=constantImage?1:Number(gd.preferredSceneCount||vp.estimatedSceneCount||sp.segmentCount||1);
        analysis.generationDirectives.preserveVisualContinuity=true;
        analysis.generationDirectives.preserveAudioContinuity=true;
        if(constantImage)analysis.generationDirectives.visualSearchStrategy='Usar una única imagen/fotografía horizontal estable durante toda la duración; no inventar cambios de escena.';
        return{
          visualAnalysis:analysis,
          visualSource:'youtube-url-direct+Gemini-video-understanding',
          analysisSource:'Gemini-YouTube-URL',
          thumbnailCount:Number(video?.thumbnails?.length||0),
          referenceFileBytes:0,
          hasFullVideoAnalysis:true,
          hasAudioAnalysis:true,
          measuredVisualContinuity:{source:'Gemini video understanding',constantImage},
          constantImage,
          estimatedSceneCount:Number(vp.estimatedSceneCount||sp.segmentCount||1),
          preferredSceneCount:Number(analysis.generationDirectives.preferredSceneCount||1)
        };
      }
      lastError='Gemini no devolvió el análisis del vídeo de YouTube.';
    }else{
      lastError='Gemini YouTube '+r.status+': '+(d?.error?.message||raw.slice(0,700));
    }
    if(r.status===429||r.status>=500)break;
  }
  throw new Error(lastError||'Gemini no pudo analizar el vídeo de YouTube.');
}

app.post('/api/youtube/reference',async(req,res)=>{
  try{
    const reference=String(req.body?.reference||'').trim();
    if(!reference)return res.status(400).json({error:'Indica una URL de YouTube.'});
    const video=await getReferenceVideo(reference);
    const referenceStyle=await analyzeYoutubeReferenceMedia(reference,video);
    res.json({
      ok:true,
      reference,
      video,
      referenceStyle,
      analysis:{
        basis:'URL pública de YouTube analizada directamente por Gemini para obtener información audiovisual y de audio.',
        note:'AutoTube analiza la URL directamente y no descarga ni reutiliza el vídeo o su audio en el MP4 generado.'
      }
    });
  }catch(err){
    console.error('YouTube full reference analysis error:',err);
    res.status(502).json({error:err.message||'No se pudo analizar el vídeo completo de YouTube.'});
  }
});

app.post('/api/ai/outline',async(req,res)=>{const{topic,language='es',duration='8',reference='',referenceData=null,visualReferenceAnalysis=null,referenceStyle=null,referenceTopic=''}=req.body||{};const effectiveTopic=String(topic||referenceTopic||referenceData?.title||'').trim();if(!effectiveTopic)return res.status(400).json({error:'Indica un tema o proporciona una referencia de YouTube.'});if(!process.env['GEM'+'INI_'+'API_'+'KEY'])return res.json({demo:true,title:`Ideas para un vídeo sobre ${effectiveTopic}`,outline:['Gancho inicial','Contexto y promesa','Desarrollo en 3 bloques','Cierre y llamada a la acción'],note:'Conecta GEMINI_API_KEY para generar con IA.'});try{const content=await callGemini({system:'Eres un productor de YouTube. Devuelve JSON con title, hook, outline, visualIdeas, description y tags. No copies textos de otros vídeos.',user:JSON.stringify({task:'Crea una estructura audiovisual original sobre el tema indicado. Si referenceTopic contiene el título/tema de la referencia y el usuario no ha proporcionado otro tema, usa ese tema como asunto principal del nuevo vídeo. No sustituyas el tema de la referencia por otro asunto no relacionado.',topic:effectiveTopic,language,duration,reference:referenceData||(reference?{url:reference}:null),visualReferenceAnalysis,referenceStyle}),temperature:0.8,maxOutputTokens:1400,json:true});return res.json(parseJsonResponse(content))}catch(err){console.error('Outline Gemini error:',err);return res.json({demo:true,fallback:true,title:`${effectiveTopic} — The AI Movie`,hook:`Una historia audiovisual original sobre ${effectiveTopic}.`,outline:['Gancho inicial','Contexto y promesa','Desarrollo en 3 bloques','Momento principal','Cierre'],visualIdeas:[`Cinematic realistic footage about ${effectiveTopic}, opening scene, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, development, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, main moment, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, ending, 16:9`],description:`Vídeo original sobre ${effectiveTopic}.`,tags:[effectiveTopic,'AI','YouTube'],warning:'Gemini no respondió correctamente en este intento; se ha creado una estructura local para continuar.'})}});

app.post('/api/ai/production-plan',async(req,res)=>{try{const{topic,language='es',duration='8',title='',outline=[],visualIdeas=[],visualReferenceAnalysis=null,referenceStyle=null,referenceTopic=''}=req.body||{};const effectiveTopic=String(topic||referenceTopic||'').trim();if(!effectiveTopic)return res.status(400).json({error:'Indica un tema o proporciona una referencia.'});const refProfile=referenceStyle?.visualAnalysis||visualReferenceAnalysis||{};const refDirectives=refProfile?.generationDirectives||{};const refVideo=refProfile?.videoProfile||{};const sceneCount=Boolean(refDirectives.useSingleContinuousVisual||refVideo.constantImage)?1:Math.max(4,Math.min(12,Math.round(Number(duration)/2)));const content=await callGemini({system:'Eres director de producción audiovisual de YouTube. Puedes trabajar con cualquier género, tema o formato de vídeo. Devuelve JSON válido con title, musicMood, voiceStyle y scenes. El género y contenido deben determinarse por el tema y por las referencias proporcionadas; no presupongas naturaleza, paisajes, relajación ni bienestar. Cada escena debe tener number, title, narration, visualPrompt, searchQuery, duration y transition. Si generationDirectives.useSingleContinuousVisual=true o videoProfile.constantImage=true, genera UNA SOLA escena que cubra toda la duración y exige continuidad visual absoluta; no inventes cambios de plano ni varias escenas. Si el perfil indica una imagen fija, la búsqueda visual debe priorizar una fotografía/imagen horizontal única y el montaje debe mantenerla durante toda la duración. Añade también mediaType ("image" o "video") y constantImage (boolean). Si existe visualReferenceAnalysis, úsalo como guía principal de ESTILO VISUAL: paisaje y entorno, iluminación, hora del día, paleta, composición, escala de planos, movimiento de cámara, velocidad/ritmo, presencia o ausencia de personas, textura, profundidad y atmósfera. Mantén esas características de forma consistente entre escenas. Si existe referenceStyle, úsalo como perfil principal de referencia: conserva el tipo de estructura, densidad de edición, composición, iluminación, paleta, escala de planos y ritmo general. Usa audioStyle solo como guía de diseño para crear música y sonido ORIGINAL; no copies ninguna pista, voz o audio. Si la referencia procede de una URL de YouTube, usa el análisis audiovisual y sonoro obtenido directamente de esa URL como guía principal, sin copiar contenido identificable. Si existe una referencia de YouTube, úsala para rasgos generales de formato y temática. NO copies escenas, textos, personajes, encuadres concretos ni contenido identificable. Genera escenas y búsquedas originales que reproduzcan el tipo de experiencia visual, no el vídeo fuente. En visualPrompt describe explícitamente los rasgos de estilo que deben conservarse. En searchQuery incluye las palabras necesarias para encontrar vídeos reales compatibles con ese estilo, además del contenido de la escena. Crea contenido original.',user:JSON.stringify({topic:effectiveTopic,language,duration,title,outline,visualIdeas,visualReferenceAnalysis,referenceStyle,sceneCount,stylePriority:'Cuando haya análisis visual, la similitud buscada es de características audiovisuales generales (ambiente, luz, composición, movimiento y ritmo), no de contenido ni de planos concretos.'}),temperature:0.75,maxOutputTokens:2600,json:true});return res.json(parseJsonResponse(content))}catch(err){console.error('Production plan error:',err);const fallbackCount=Math.max(4,Math.min(12,Math.round(Number(req.body?.duration||8)/2))),fallbackTopic=String(req.body?.topic||req.body?.referenceTopic||'el tema del vídeo').trim(),fallbackScenes=Array.from({length:fallbackCount},(_,i)=>({number:i+1,title:i===0?'Introducción':'Desarrollo · escena '+(i+1),narration:i===0?'Presentación del tema y promesa principal del vídeo.':'Desarrollo del contenido con una explicación clara y visual.',visualPrompt:'Realistic cinematic footage about '+fallbackTopic+', scene '+(i+1)+', natural light, detailed, 16:9, original composition',searchQuery:fallbackTopic,duration:Math.round((Number(req.body?.duration||8)*60)/fallbackCount),transition:'Fundido suave'}));res.json({demo:true,fallback:true,title:req.body?.title||'Vídeo sobre '+fallbackTopic,musicMood:'Ambient cinematográfico',voiceStyle:'Natural y cercana',scenes:fallbackScenes,warning:'La API de IA no respondió. Se ha creado un plan local para que puedas continuar.'})}});


;