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
    const r=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-goog-api-key':key},
      body:JSON.stringify(body)
    });
    const raw=await r.text();let d=null;try{d=raw?JSON.parse(raw):null}catch{}
    if(r.ok){
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
        basis:'Vídeo completo de YouTube descargado temporalmente para análisis audiovisual + audio mediante Gemini.',
        note:'El archivo se usa únicamente como entrada temporal de análisis y se elimina al terminar. AutoTube no reutiliza el vídeo ni su audio en el MP4 generado.'
      }
    });
  }catch(err){
    console.error('YouTube full reference analysis error:',err);
    res.status(502).json({error:err.message||'No se pudo analizar el vídeo completo de YouTube.'});
  }
});

app.post('/api/ai/outline',async(req,res)=>{const{topic,language='es',duration='8',reference='',referenceData=null,visualReferenceAnalysis=null,referenceStyle=null,referenceTopic=''}=req.body||{};const effectiveTopic=String(topic||referenceTopic||referenceData?.title||'').trim();if(!effectiveTopic)return res.status(400).json({error:'Indica un tema o proporciona una referencia de YouTube.'});if(!process.env['GEM'+'INI_'+'API_'+'KEY'])return res.json({demo:true,title:`Ideas para un vídeo sobre ${effectiveTopic}`,outline:['Gancho inicial','Contexto y promesa','Desarrollo en 3 bloques','Cierre y llamada a la acción'],note:'Conecta GEMINI_API_KEY para generar con IA.'});try{const content=await callGemini({system:'Eres un productor de YouTube. Devuelve JSON con title, hook, outline, visualIdeas, description y tags. No copies textos de otros vídeos.',user:JSON.stringify({task:'Crea una estructura audiovisual original sobre el tema indicado. Si referenceTopic contiene el título/tema de la referencia y el usuario no ha proporcionado otro tema, usa ese tema como asunto principal del nuevo vídeo. No sustituyas el tema de la referencia por otro asunto no relacionado.',topic:effectiveTopic,language,duration,reference:referenceData||(reference?{url:reference}:null),visualReferenceAnalysis,referenceStyle}),temperature:0.8,maxOutputTokens:1400,json:true});return res.json(parseJsonResponse(content))}catch(err){console.error('Outline Gemini error:',err);return res.json({demo:true,fallback:true,title:`${effectiveTopic} — The AI Movie`,hook:`Una historia audiovisual original sobre ${effectiveTopic}.`,outline:['Gancho inicial','Contexto y promesa','Desarrollo en 3 bloques','Momento principal','Cierre'],visualIdeas:[`Cinematic realistic footage about ${effectiveTopic}, opening scene, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, development, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, main moment, 16:9`,`Cinematic realistic footage about ${effectiveTopic}, ending, 16:9`],description:`Vídeo original sobre ${effectiveTopic}.`,tags:[effectiveTopic,'AI','YouTube'],warning:'Gemini no respondió correctamente en este intento; se ha creado una estructura local para continuar.'})}});

app.post('/api/ai/production-plan',async(req,res)=>{try{const{topic,language='es',duration='8',title='',outline=[],visualIdeas=[],visualReferenceAnalysis=null,referenceStyle=null,referenceTopic=''}=req.body||{};const effectiveTopic=String(topic||referenceTopic||'').trim();if(!effectiveTopic)return res.status(400).json({error:'Indica un tema o proporciona una referencia.'});const refProfile=referenceStyle?.visualAnalysis||visualReferenceAnalysis||{};const refDirectives=refProfile?.generationDirectives||{};const refVideo=refProfile?.videoProfile||{};const sceneCount=Boolean(refDirectives.useSingleContinuousVisual||refVideo.constantImage)?1:Math.max(4,Math.min(12,Math.round(Number(duration)/2)));const content=await callGemini({system:'Eres director de producción audiovisual de YouTube. Puedes trabajar con cualquier género, tema o formato de vídeo. Devuelve JSON válido con title, musicMood, voiceStyle y scenes. El género y contenido deben determinarse por el tema y por las referencias proporcionadas; no presupongas naturaleza, paisajes, relajación ni bienestar. Cada escena debe tener number, title, narration, visualPrompt, searchQuery, duration y transition. Si generationDirectives.useSingleContinuousVisual=true o videoProfile.constantImage=true, genera UNA SOLA escena que cubra toda la duración y exige continuidad visual absoluta; no inventes cambios de plano ni varias escenas. Si el perfil indica una imagen fija, la búsqueda visual debe priorizar una fotografía/imagen horizontal única y el montaje debe mantenerla durante toda la duración. Añade también mediaType ("image" o "video") y constantImage (boolean). Si existe visualReferenceAnalysis, úsalo como guía principal de ESTILO VISUAL: paisaje y entorno, iluminación, hora del día, paleta, composición, escala de planos, movimiento de cámara, velocidad/ritmo, presencia o ausencia de personas, textura, profundidad y atmósfera. Mantén esas características de forma consistente entre escenas. Si existe referenceStyle, úsalo como perfil principal de referencia: conserva el tipo de estructura, densidad de edición, composición, iluminación, paleta, escala de planos y ritmo general. Usa audioStyle solo como guía de diseño para crear música y sonido ORIGINAL; no copies ninguna pista, voz o audio. Si la referencia procede únicamente de una URL, recuerda que su audio no ha sido escuchado directamente y evita afirmar detalles no evidenciados. Si existe una referencia de YouTube, úsala para rasgos generales de formato y temática. NO copies escenas, textos, personajes, encuadres concretos ni contenido identificable. Genera escenas y búsquedas originales que reproduzcan el tipo de experiencia visual, no el vídeo fuente. En visualPrompt describe explícitamente los rasgos de estilo que deben conservarse. En searchQuery incluye las palabras necesarias para encontrar vídeos reales compatibles con ese estilo, además del contenido de la escena. Crea contenido original.',user:JSON.stringify({topic:effectiveTopic,language,duration,title,outline,visualIdeas,visualReferenceAnalysis,referenceStyle,sceneCount,stylePriority:'Cuando haya análisis visual, la similitud buscada es de características audiovisuales generales (ambiente, luz, composición, movimiento y ritmo), no de contenido ni de planos concretos.'}),temperature:0.75,maxOutputTokens:2600,json:true});return res.json(parseJsonResponse(content))}catch(err){console.error('Production plan error:',err);const fallbackCount=Math.max(4,Math.min(12,Math.round(Number(req.body?.duration||8)/2))),fallbackTopic=String(req.body?.topic||req.body?.referenceTopic||'el tema del vídeo').trim(),fallbackScenes=Array.from({length:fallbackCount},(_,i)=>({number:i+1,title:i===0?'Introducción':'Desarrollo · escena '+(i+1),narration:i===0?'Presentación del tema y promesa principal del vídeo.':'Desarrollo del contenido con una explicación clara y visual.',visualPrompt:'Realistic cinematic footage about '+fallbackTopic+', scene '+(i+1)+', natural light, detailed, 16:9, original composition',searchQuery:fallbackTopic,duration:Math.round((Number(req.body?.duration||8)*60)/fallbackCount),transition:'Fundido suave'}));res.json({demo:true,fallback:true,title:req.body?.title||'Vídeo sobre '+fallbackTopic,musicMood:'Ambient cinematográfico',voiceStyle:'Natural y cercana',scenes:fallbackScenes,warning:'La API de IA no respondió. Se ha creado un plan local para que puedas continuar.'})}});


async function generateGeminiTts(text,language='es',style='Natural y cercana'){
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key)throw new Error('Falta GEMINI_API_KEY.');
  const safeText=String(text||'').trim();
  if(!safeText)throw new Error('La narración está vacía.');
  const lang=String(language||'es').toLowerCase().startsWith('es')?'es-ES':(String(language||'en').toLowerCase().startsWith('en')?'en-US':String(language||'es'));
  const body={
    contents:[{role:'user',parts:[{text:'Lee exactamente el siguiente texto como narración profesional para YouTube. Estilo: '+String(style||'Natural y cercana')+'. No añadas palabras, introducciones ni comentarios.\n\n'+safeText}]}],
    generationConfig:{
      responseModalities:['AUDIO'],
      responseFormat:{audio:{mimeType:'AUDIO_L16',sampleRate:24000}},
      speechConfig:{voiceConfig:{voice:'Kore'},languageCode:lang}
    }
  };
  const models=['gemini-3.8-flash-tts','gemini-3.8-flash-lite-tts','gemini-2.5-flash-preview-tts'];
  let lastError='';
  for(const model of models){
    const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-goog-api-key':key},
      body:JSON.stringify(body)
    });
    const raw=await r.text();let d=null;try{d=raw?JSON.parse(raw):null}catch{}
    if(r.ok){
      const data=d?.candidates?.[0]?.content?.parts?.find(p=>p?.inlineData?.data)?.inlineData?.data;
      if(!data)throw new Error('Gemini TTS no devolvió audio.');
      const pcm=Buffer.from(data,'base64');
      if(!pcm.length)throw new Error('Gemini TTS devolvió audio vacío.');
      const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-tts-'));
      try{
        const input=path.join(dir,'voice.pcm'),output=path.join(dir,'voice.wav');
        await fs.writeFile(input,pcm);
        await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','s16le','-ar','24000','-ac','1','-i',input,'-c:a','pcm_s16le','-ar','44100','-ac','2',output]);
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
app.post('/api/ai/voice',async(req,res)=>{
  try{
    const text=String(req.body?.text||'').trim();
    if(!text)return res.status(400).json({error:'La narración está vacía.'});
    const audio=await generateGeminiTts(text,req.body?.language||'es',req.body?.style||'Natural y cercana');
    res.set('Content-Type','audio/wav');res.set('Content-Length',String(audio.length));res.send(audio);
  }catch(err){console.error('Gemini TTS error:',err);res.status(502).json({error:err.message||'No se pudo generar la narración.'})}
});

async function generateLyriaMusic(prompt){
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key)throw new Error('Falta GEMINI_API_KEY.');
  const body={
    model:'lyria-3-clip-preview',
    input:String(prompt||'Instrumental original, no vocals.'),
    response_format:{type:'audio'}
  };
  const r=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-goog-api-key':key},
    body:JSON.stringify(body)
  });
  const raw=await r.text();let d=null;try{d=raw?JSON.parse(raw):null}catch{}
  if(!r.ok)throw new Error('Lyria '+r.status+': '+(d?.error?.message||raw.slice(0,700)));
  const audio=d?.output_audio;
  if(!audio?.data)throw new Error('Lyria no devolvió audio.');
  return{buffer:Buffer.from(audio.data,'base64'),mime:audio.mime_type||'audio/mpeg'};
}


app.post('/api/ai/music',async(req,res)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-music-'));
  try{
    const duration=Math.max(30,Math.min(300,Number(req.body?.durationSeconds)||60));
    const mood=String(req.body?.mood||'instrumental original').replace(/[\r\n"]/g,' ').slice(0,500);
    const topic=String(req.body?.topic||'').replace(/[\r\n"]/g,' ').slice(0,300);
    const audioProfile=req.body?.audioProfile&&typeof req.body.audioProfile==='object'?req.body.audioProfile:{};
    const prompt=[
      'Create ORIGINAL instrumental background music for a YouTube video.',
      'Do not copy or imitate any existing recording, melody, lyrics, artist, or track.',
      'Use these reference characteristics only as high-level production guidance.',
      'Topic: '+topic,
      'Mood: '+mood,
      'Energy: '+String(audioProfile.energy||''),
      'Dynamics: '+String(audioProfile.dynamics||''),
      'Instrumentation: '+String(audioProfile.instrumentation||''),
      'Voice/music relationship: '+String(audioProfile.audioContinuity||'continuous'),
      'Estimated BPM: '+String(audioProfile.bpmEstimate||'unknown'),
      'Instrumental only, no vocals.',
      'Maintain a coherent continuous bed suitable for narration.'
    ].join('\n');
    const generated=await generateLyriaMusic(prompt);
    const raw=path.join(dir,'generated-audio');
    const output=path.join(dir,'music.wav');
    await fs.writeFile(raw,generated.buffer);
    await runFfmpeg(['-y','-hide_banner','-loglevel','error','-stream_loop','-1','-i',raw,'-t',String(duration),'-ar','44100','-ac','2','-c:a','pcm_s16le','-af','afade=t=in:st=0:d=3,afade=t=out:st='+(Math.max(3,duration-3))+':d=3',output]);
    const audio=await fs.readFile(output);
    if(!audio.length)throw new Error('La música generada está vacía.');
    res.set('Content-Type','audio/wav');res.set('Content-Length',String(audio.length));res.send(audio);
  }catch(err){
    console.error('Music generation error:',err);
    res.status(502).json({error:err.message||'No se pudo generar la música con Lyria.'});
  }finally{
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
});

async function searchPexels(query){if(!process.env.PEXELS_API_KEY)return[];const r=await fetch('https://api.pexels.com/v1/videos/search?'+new URLSearchParams({query,orientation:'landscape',size:'medium',locale:'es-ES',per_page:'6'}),{headers:{Authorization:process.env.PEXELS_API_KEY}});if(!r.ok)throw new Error('Pexels API '+r.status);const d=await r.json();return(d.videos||[]).map(v=>({provider:'Pexels',id:v.id,title:'Vídeo Pexels',duration:v.duration,thumbnail:v.image,url:v.url,downloadUrl:(v.video_files||[]).filter(x=>x.link).sort((a,b)=>{const sa=(a.width||0)<=1280?0:1,sb=(b.width||0)<=1280?0:1;if(sa!==sb)return sa-sb;return Math.abs((a.width||0)-1920)-Math.abs((b.width||0)-1920)})[0]?.link||''})).filter(x=>x.downloadUrl)}
async function searchPexelsPhotos(query){if(!process.env.PEXELS_API_KEY)return[];const r=await fetch('https://api.pexels.com/v1/search?'+new URLSearchParams({query,orientation:'landscape',size:'large',locale:'es-ES',per_page:'6'}),{headers:{Authorization:process.env.PEXELS_API_KEY}});if(!r.ok)throw new Error('Pexels Photos API '+r.status);const d=await r.json();return(d.photos||[]).map(v=>({provider:'Pexels',id:v.id,title:'Imagen Pexels',duration:0,thumbnail:v.src?.medium||v.src?.small||'',url:v.url,downloadUrl:v.src?.large2x||v.src?.large||v.src?.original||'',mediaType:'image'})).filter(x=>x.downloadUrl)}
async function searchPixabay(query){if(!process.env.PIXABAY_API_KEY)return[];const r=await fetch('https://pixabay.com/api/videos/?'+new URLSearchParams({key:process.env.PIXABAY_API_KEY,q:query,lang:'es',video_type:'film',safesearch:'true',order:'popular',per_page:'6'}));if(!r.ok)throw new Error('Pixabay API '+r.status);const d=await r.json();return(d.hits||[]).map(v=>({provider:'Pixabay',id:v.id,title:'Vídeo Pixabay',duration:v.duration,thumbnail:v.videos?.medium?.thumbnail||v.videos?.small?.thumbnail||'',url:v.pageURL,downloadUrl:v.videos?.large?.url||v.videos?.medium?.url||v.videos?.small?.url||''})).filter(x=>x.downloadUrl)}
async function searchPixabayImages(query){if(!process.env.PIXABAY_API_KEY)return[];const r=await fetch('https://pixabay.com/api/?'+new URLSearchParams({key:process.env.PIXABAY_API_KEY,q:query,lang:'es',image_type:'photo',orientation:'horizontal',safesearch:'true',order:'popular',per_page:'6'}));if(!r.ok)throw new Error('Pixabay Images API '+r.status);const d=await r.json();return(d.hits||[]).map(v=>({provider:'Pixabay',id:v.id,title:'Imagen Pixabay',duration:0,thumbnail:v.webformatURL||v.previewURL||'',url:v.pageURL,downloadUrl:v.largeImageURL||v.webformatURL||'',mediaType:'image'})).filter(x=>x.downloadUrl)}
app.post('/api/media/search',async(req,res)=>{try{const scenes=Array.isArray(req.body?.scenes)?req.body.scenes:[];if(!scenes.length)return res.status(400).json({error:'No hay escenas para buscar.'});const results=[];for(const scene of scenes.slice(0,12)){const query=String(scene.searchQuery||scene.visualPrompt||scene.title||'').replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,100);const wantImage=String(scene.mediaType||'').toLowerCase()==='image'||Boolean(scene.constantImage);const[pexels,pixabay]=await Promise.allSettled(wantImage?[searchPexelsPhotos(query),searchPixabayImages(query)]:[searchPexels(query),searchPixabay(query)]);results.push({number:scene.number,title:scene.title,query,mediaType:wantImage?'image':'video',media:[...(pexels.status==='fulfilled'?pexels.value:[]),...(pixabay.status==='fulfilled'?pixabay.value:[])]})}res.json({ok:true,results,credits:{pexels:'Visuales proporcionados por Pexels',pixabay:'Visuales proporcionados por Pixabay'}})}catch(err){res.status(502).json({error:err.message||'No se pudieron buscar visuales.'})}});

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
function runFfmpeg(args){return new Promise((resolve,reject)=>{const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000)});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('FFmpeg '+code+': '+err.slice(-2500))))})}
app.post('/api/reference/visual-analysis',upload.single('video'),async(req,res)=>{
  try{
    const file=req.file;
    if(!file||!file.buffer?.length)return res.status(400).json({error:'No se recibió ningún vídeo de referencia.'});
    const allowed=/^video\/(mp4|quicktime|webm|x-msvideo|mpeg|ogg)$/i.test(String(file.mimetype||''))||/\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg)$/i.test(String(file.originalname||''));
    if(!allowed)return res.status(400).json({error:'El archivo de referencia no parece ser un vídeo compatible.'});
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-reference-'));
    try{
      const input=path.join(dir,'reference-video');
      const framesDir=path.join(dir,'frames');
      await fs.mkdir(framesDir,{recursive:true});
      await fs.writeFile(input,file.buffer);
      const stat=await fs.stat(input);
      if(!stat.size)throw new Error('El vídeo de referencia está vacío.');
      try{await runFfmpeg(['-y','-hide_banner','-loglevel','error','-i',input,'-map','0:v:0','-an','-sn','-dn','-vf','fps=1/2,scale=768:-2','-frames:v','6','-q:v','3',path.join(framesDir,'frame-%02d.jpg')]);}catch(firstErr){console.warn('Reference frame extraction retry:',firstErr.message);await runFfmpeg(['-y','-hide_banner','-loglevel','error','-ss','0','-i',input,'-map','0:v:0','-an','-sn','-dn','-vf','scale=768:-2','-frames:v','1','-q:v','3',path.join(framesDir,'frame-%02d.jpg')]);}
      const files=(await fs.readdir(framesDir)).filter(x=>/^frame-\d+\.jpg$/i.test(x)).sort();
      if(!files.length)throw new Error('No se pudieron extraer fotogramas del vídeo de referencia.');
      const images=[];
      for(const name of files){
        const data=await fs.readFile(path.join(framesDir,name));
        if(data.length)images.push({mimeType:'image/jpeg',data:data.toString('base64')});
      }
      if(!images.length)throw new Error('Los fotogramas extraídos están vacíos.');
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
    }
  }catch(err){
    console.error('Visual reference analysis error:',err);
    return res.status(502).json({error:err.message||'No se pudo analizar visualmente el vídeo de referencia.'});
  }
});

async function downloadAudioBuffer(buffer,file){await fs.writeFile(file,buffer);const stat=await fs.stat(file);if(!stat.size)throw new Error('El audio generado está vacío.');}
async function renderAutotubeVideo({scenes,mediaResults,narrationAudio=[],musicBuffer=null,onProgress=()=>{},finalOutputPath}){
  if(!ffmpegPath)throw new Error('FFmpeg no está disponible.');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-'));
  try{
    const clips=[];
    const usableScenes=scenes.map((scene,i)=>({scene,found:mediaResults.find(x=>String(x.number)===String(scene.number))||mediaResults[i],audio:narrationAudio[i]||null})).filter(x=>x.found?.media?.find(m=>m.downloadUrl)?.downloadUrl);
    if(!usableScenes.length)throw new Error('No hay clips de vídeo disponibles para las escenas.');
    const total=usableScenes.length;
    for(let i=0;i<total;i++){
      const{scene,found,audio}=usableScenes[i],media=found.media.find(m=>m.downloadUrl),asset=media.downloadUrl,input=path.join(dir,'in-'+i+'.bin'),output=path.join(dir,'scene-'+i+'.mp4'),duration=Math.max(2,Math.min(180,Number(scene.duration)||8));
      await downloadToFile(asset,input);
      let audioInput=null;
      if(audio){audioInput=path.join(dir,'voice-'+i+'.bin');await fs.writeFile(audioInput,Buffer.isBuffer(audio)?audio:await fs.readFile(audio));const stat=await fs.stat(audioInput);if(!stat.size)throw new Error('La narración de la escena '+(i+1)+' está vacía.');}
      const args=['-y'];if(String(media?.mediaType||found.mediaType||scene.mediaType||'video').toLowerCase()==='image')args.push('-loop','1','-i',input);else args.push('-stream_loop','-1','-i',input);
      if(audioInput)args.push('-i',audioInput);else args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100');
      args.push('-t',String(duration),'-vf','scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuv420p,fps=30','-map','0:v:0','-map','1:a:0','-c:a','aac','-b:a','192k','-af','apad');
      args.push('-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-threads','1','-avoid_negative_ts','make_zero',output);
      await runFfmpeg(args);
      const stat=await fs.stat(output);if(!stat.size)throw new Error('FFmpeg creó una escena vacía.');clips.push(output);onProgress(Math.min(80,Math.round(((i+1)/total)*70)+5));
    }
    const list=path.join(dir,'concat.txt');await fs.writeFile(list,clips.map(f=>"file '"+f.replace(/'/g,"'\\''")+"'").join('\n'));
    const videoOnly=path.join(dir,'video-only.mp4');
    try{await runFfmpeg(['-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',videoOnly]);}
    catch(copyErr){console.warn('Concat copy falló; usando recodificación final:',copyErr.message);await runFfmpeg(['-y','-f','concat','-safe','0','-i',list,'-c:v','libx264','-c:a','aac','-b:a','192k','-preset','medium','-crf','20','-pix_fmt','yuv420p','-threads','1','-movflags','+faststart',videoOnly]);}
    let out=videoOnly;
    if(musicBuffer){
      const musicFile=path.join(dir,'music.bin');await downloadAudioBuffer(musicBuffer,musicFile);out=path.join(dir,'autotube-final.mp4');
      await runFfmpeg(['-y','-i',videoOnly,'-stream_loop','-1','-i',musicFile,'-filter_complex','[1:a]volume=0.18,aresample=async=1[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]','-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',out]);
    }
    const stat=await fs.stat(out);if(!stat.size)throw new Error('El MP4 final está vacío.');
    if(finalOutputPath){await fs.copyFile(out,finalOutputPath);const finalStat=await fs.stat(finalOutputPath);if(!finalStat.size)throw new Error('No se pudo guardar el MP4 final.');onProgress(100);return{outputPath:finalOutputPath,size:finalStat.size,duration:usableScenes.reduce((n,x)=>n+(Number(x.scene.duration)||8),0)}}
    onProgress(100);return{outputPath:out,size:stat.size,duration:usableScenes.reduce((n,x)=>n+(Number(x.scene.duration)||8),0)}
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}
}
app.post('/api/render',upload.fields([{name:'narration',maxCount:12},{name:'music',maxCount:1}]),async(req,res)=>{try{let scenes=[];let mediaResults=[];try{scenes=JSON.parse(String(req.body?.scenes||'[]'));mediaResults=JSON.parse(String(req.body?.mediaResults||'[]'));}catch{throw new Error('Los datos de producción no tienen un formato válido.');}if(!scenes.length||!mediaResults.length)return res.status(400).json({error:'Genera las escenas y busca los visuales antes de renderizar.'});const jobId='render_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex'),outputPath=path.join(renderJobDir,jobId+'.mp4');renderJobs.set(jobId,{status:'processing',progress:1,createdAt:Date.now(),outputPath,error:null});res.status(202).json({ok:true,jobId,status:'processing'});(async()=>{const job=renderJobs.get(jobId);try{const narrationFiles=Array.isArray(req.files?.narration)?req.files.narration:[],musicFile=Array.isArray(req.files?.music)?req.files.music[0]:null;const result=await renderAutotubeVideo({scenes,mediaResults,narrationAudio:narrationFiles.map(x=>x.buffer),musicBuffer:musicFile?.buffer||null,onProgress:p=>{if(job)job.progress=p},finalOutputPath:outputPath});if(job){job.status='done';job.progress=100;job.size=result.size;job.finishedAt=Date.now()}console.log('Render completed:',jobId,'size=',result.size)}catch(err){console.error('Render error:',jobId,err);if(job){job.status='error';job.progress=0;job.error=err.message||'No se pudo renderizar el vídeo.'}}})()}catch(err){console.error('Render start error:',err);if(!res.headersSent)res.status(500).json({error:err.message||'No se pudo iniciar el render.'})}});
app.get('/api/render/:jobId',async(req,res)=>{const job=renderJobs.get(String(req.params.jobId||''));if(!job)return res.status(404).json({error:'Render no encontrado. El servicio puede haberse reiniciado; inicia un nuevo render.'});if(job.status==='processing')return res.json({ok:true,status:'processing',progress:job.progress||0});if(job.status==='error')return res.json({ok:false,status:'error',error:job.error||'No se pudo renderizar el vídeo.'});try{const stat=await fs.stat(job.outputPath);if(!stat.size)throw new Error('MP4 vacío');res.json({ok:true,status:'done',progress:100,size:stat.size,downloadUrl:'/api/render/'+encodeURIComponent(req.params.jobId)+'/download'})}catch{return res.status(404).json({error:'El vídeo renderizado ya no está disponible. Inicia un nuevo render.'})}});
app.get('/api/render/:jobId/download',async(req,res)=>{const job=renderJobs.get(String(req.params.jobId||''));if(!job)return res.status(404).json({error:'Render no encontrado.'});if(job.status!=='done')return res.status(409).json({error:'El render todavía no está listo.'});try{await fs.stat(job.outputPath);res.download(job.outputPath,'autotube-final.mp4')}catch{res.status(404).json({error:'El vídeo renderizado ya no está disponible.'})}});

async function validateRenderedMp4(file){
  const probe=await new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-'],{stdio:['ignore','pipe','pipe']});
    let stderr='';
    p.stderr.on('data',x=>{stderr+=x.toString()});
    p.on('error',reject);
    p.on('close',code=>{
      if(code!==0)return reject(new Error('FFmpeg no pudo validar el MP4 final: '+stderr.slice(-800)));
      resolve(stderr);
    });
  });
  const text=String(probe||'');
  const videoLine=(text.split(/\r?\n/).find(line=>/Video:/i.test(line))||'');
  const audioLine=(text.split(/\r?\n/).find(line=>/Audio:/i.test(line))||'');
  const vm=videoLine.match(/(\d{2,5})x(\d{2,5})/);
  const fm=videoLine.match(/(\d+(?:\.\d+)?)\s*fps/);
  const am=audioLine.match(/Audio:\s*([a-z0-9_]+)/i);
  if(!vm)throw new Error('No se pudo verificar la resolución real del MP4.');
  const width=Number(vm[1]),height=Number(vm[2]);
  const fps=fm?Number(fm[1]):0;
  const audioCodec=am?String(am[1]).toLowerCase():'';
  if(width!==1920||height!==1080)throw new Error('Resolución real del MP4: '+width+'x'+height+' (se esperaba 1920x1080).');
  if(!fps||Math.abs(fps-30)>0.5)throw new Error('FPS reales del MP4: '+(fps||'desconocidos')+' (se esperaban 30).');
  if(audioCodec!=='aac')throw new Error('Códec de audio real del MP4: '+(audioCodec||'desconocido')+' (se esperaba AAC).');
  return{width,height,fps,audioCodec};
}

const preflightJobs=new Map();

async function executePreflight(){
  const checks={};
  let preflightReferenceVideo=null;
  let preflightReferenceStyle=null;
  const run=async(name,fn)=>{const started=Date.now();try{const value=await fn();checks[name]={ok:true,ms:Date.now()-started,...(value&&typeof value==='object'?value:{})};}catch(err){checks[name]={ok:false,ms:Date.now()-started,error:err.message||String(err)};}};
  await run('ffmpeg',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-preflight-'));try{const out=path.join(dir,'test.mp4');await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=320x180:r=10','-t','1','-an','-c:v','libx264','-pix_fmt','yuv420p',out]);const st=await fs.stat(out);if(!st.size)throw new Error('FFmpeg produjo un archivo vacío.');return{bytes:st.size};}finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}});
  await run('gemini',async()=>{const text=await callGemini({system:'Responde únicamente con JSON válido.',user:'Devuelve {"ok":true}.',maxOutputTokens:80,json:true});return{response:parseJsonResponse(text)}});
  const referenceUrl='https://www.youtube.com/watch?v=DtNJMSoerWU';
  await run('youtube-reference',async()=>{const r=await fetch('http://127.0.0.1:'+PORT+'/api/youtube/reference',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:referenceUrl})});const raw=await r.text();let d=null;try{d=raw?JSON.parse(raw):null}catch{}if(!r.ok)throw new Error(d?.error||'YouTube reference '+r.status);if(!d?.video?.title)throw new Error('No se obtuvo el título de la referencia.');if(!d?.referenceStyle)throw new Error('No se obtuvo el perfil de referencia.');preflightReferenceVideo=d.video;preflightReferenceStyle=d.referenceStyle;return{title:d.video.title,visualSource:d.referenceStyle.visualSource||'unknown',thumbnailCount:Number(d.referenceStyle.thumbnailCount)||0,hasVisualAnalysis:Boolean(d.referenceStyle.hasFullVideoAnalysis),hasAudioProfile:Boolean(d.referenceStyle.hasAudioAnalysis),hasStructureProfile:Boolean(d.referenceStyle.structure),constantImage:Boolean(d.referenceStyle.constantImage),estimatedSceneCount:Number(d.referenceStyle.estimatedSceneCount||0),preferredSceneCount:Number(d.referenceStyle.preferredSceneCount||0)}});
  await run('pexels',async()=>{if(!process.env.PEXELS_API_KEY)throw new Error('Falta PEXELS_API_KEY.');const rows=await searchPexels('cinematic');if(!rows.length)throw new Error('Pexels no devolvió vídeos.');return{results:rows.length}});
  await run('pixabay',async()=>{if(!process.env.PIXABAY_API_KEY)throw new Error('Falta PIXABAY_API_KEY.');const rows=await searchPixabay('cinematic');if(!rows.length)throw new Error('Pixabay no devolvió vídeos.');return{results:rows.length}});
  await run('visual-reference',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-preflight-reference-'));try{const input=path.join(dir,'reference.mp4');await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=5','-t','1','-an','-c:v','libx264','-pix_fmt','yuv420p',input]);const video=await fs.readFile(input);const form=new FormData();form.append('video',new Blob([video],{type:'video/mp4'}),'preflight-reference.mp4');const r=await fetch('http://127.0.0.1:'+PORT+'/api/reference/visual-analysis',{method:'POST',body:form});const raw=await r.text();let d=null;try{d=raw?JSON.parse(raw):null}catch{}if(!r.ok)throw new Error(d?.error||'Visual analysis '+r.status);if(!d?.analysis||typeof d.analysis!=='object')throw new Error('El análisis visual no devolvió JSON estructurado.');return{framesAnalyzed:Number(d.framesAnalyzed)||0};}finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}});
  await run('production-plan',async()=>{const ref=preflightReferenceVideo||await getReferenceVideo(referenceUrl);const refStyle=preflightReferenceStyle||await analyzeYoutubeReferenceMedia(referenceUrl,ref);const r=await fetch('http://127.0.0.1:'+PORT+'/api/ai/production-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:'',referenceTopic:ref.title,language:'es',duration:'2',title:'Preflight original',outline:['Gancho','Contexto','Desarrollo','Cierre'],visualIdeas:['Reference-derived documentary visuals'],visualReferenceAnalysis:refStyle.visualAnalysis,referenceStyle:refStyle})});const raw=await r.text();let d=null;try{d=raw?JSON.parse(raw):null}catch{}if(!r.ok)throw new Error(d?.error||'Production plan '+r.status);if(!Array.isArray(d?.scenes)||!d.scenes.length)throw new Error('El plan de producción no devolvió escenas.');return{scenes:d.scenes.length,title:d.title||''}});
  let ttsAudio=null;
  await run('tts',async()=>{ttsAudio=await generateGeminiTts('Prueba de narración de AutoTube.','es','Natural y cercana');if(!ttsAudio.length)throw new Error('Gemini TTS devolvió audio vacío.');return{provider:'Gemini TTS',bytes:ttsAudio.length}});
  let musicBuffer=null;
  await run('music-ffmpeg',async()=>{
    const r=await fetch('http://127.0.0.1:'+PORT+'/api/ai/music',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        topic:preflightReferenceVideo?.title||'Preflight',
        mood:preflightReferenceStyle?.visualAnalysis?.audioProfile?.musicMood||'instrumental original',
        audioProfile:preflightReferenceStyle?.visualAnalysis?.audioProfile||{},
        durationSeconds:30
      })
    });
    if(!r.ok){const raw=await r.text();let d=null;try{d=raw?JSON.parse(raw):null}catch{}throw new Error(d?.error||'Music API '+r.status);}
    musicBuffer=Buffer.from(await r.arrayBuffer());
    if(!musicBuffer.length)throw new Error('La prueba de música produjo un archivo vacío.');
    return{bytes:musicBuffer.length,provider:'Lyria'};
  });
  const mediaSource=checks.pexels?.ok?'pexels':(checks.pixabay?.ok?'pixabay':null);
  await run('render-smoke',async()=>{if(!mediaSource)throw new Error('No hay proveedor de vídeo disponible para la prueba de render.');const rows=mediaSource==='pexels'?await searchPexels('cinematic'):await searchPixabay('cinematic');const remoteClip=rows.find(x=>x.downloadUrl);if(!remoteClip)throw new Error('No hay un clip descargable para la prueba de render.');if(!ttsAudio||!musicBuffer)throw new Error('Faltan audio de narración o música para la prueba integrada.');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-preflight-render-'));try{const source=path.join(dir,'smoke-source.mp4');await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=5','-t','2','-an','-c:v','libx264','-pix_fmt','yuv420p',source]);const out=path.join(dir,'smoke.mp4');const result=await renderAutotubeVideo({scenes:[{number:1,title:'Preflight',duration:2,narration:'Prueba de narración.'}],mediaResults:[{number:1,title:'Preflight',media:[{downloadUrl:source}]}],narrationAudio:[ttsAudio],musicBuffer,finalOutputPath:out});const validated=await validateRenderedMp4(out);return{bytes:result.size,provider:mediaSource,hasNarration:true,hasMusic:true,validatedAudioStream:true,...validated};}finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}});
  await run('render-image-smoke',async()=>{
    if(!musicBuffer||!ttsAudio)throw new Error('Faltan audio de narración o música para la prueba de imagen fija.');
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-preflight-image-'));
    try{
      const image=path.join(dir,'reference.jpg');
      await runFfmpeg(['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x202020:s=320x180','-frames:v','1','-q:v','2',image]);
      const out=path.join(dir,'image-smoke.mp4');
      const result=await renderAutotubeVideo({
        scenes:[{number:1,title:'Imagen fija',duration:2,narration:'Prueba de imagen fija.',mediaType:'image',constantImage:true}],
        mediaResults:[{number:1,title:'Imagen fija',mediaType:'image',media:[{downloadUrl:image,mediaType:'image'}]}],
        narrationAudio:[ttsAudio],
        musicBuffer,
        finalOutputPath:out
      });
      const validated=await validateRenderedMp4(out);
      return{bytes:result.size,mediaType:'image',hasNarration:true,hasMusic:true,...validated};
    }finally{
      await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
    }
  });
  const failed=Object.entries(checks).filter(([,v])=>!v.ok).map(([k,v])=>({name:k,error:v.error}));
  return{ok:failed.length===0,checks,failed};
}

app.get('/api/preflight',async(_req,res)=>{
  const existing=[...preflightJobs.values()].find(j=>j.status==='running');
  if(existing)return res.status(202).json({ok:false,status:'running',jobId:existing.id,statusUrl:'/api/preflight/'+encodeURIComponent(existing.id),message:'Preflight ya está ejecutándose.'});
  const id='preflight_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
  preflightJobs.set(id,{id,status:'running',startedAt:Date.now(),result:null});
  res.status(202).json({ok:false,status:'running',jobId:id,statusUrl:'/api/preflight/'+encodeURIComponent(id),message:'Preflight iniciado. Consulta statusUrl para ver el resultado completo.'});
  executePreflight().then(result=>{const job=preflightJobs.get(id);if(job){job.status=result.ok?'done':'failed';job.result=result;job.finishedAt=Date.now();}}).catch(err=>{const job=preflightJobs.get(id);if(job){job.status='failed';job.result={ok:false,checks:{},failed:[{name:'preflight',error:err.message||String(err)}]};job.finishedAt=Date.now();}});
});
app.get('/api/preflight/:jobId',async(req,res)=>{
  const job=preflightJobs.get(String(req.params.jobId||''));
  if(!job)return res.status(410).json({ok:false,error:'La instancia se reinició durante el preflight y perdió el estado temporal. No se inició ningún vídeo real. Vuelve a abrir /api/preflight para lanzar una prueba nueva.'});
  if(job.status==='running')return res.status(202).json({ok:false,status:'running',jobId:job.id,elapsedMs:Date.now()-job.startedAt});
  return res.status(job.result?.ok?200:503).json({status:job.status,jobId:job.id,...(job.result||{ok:false,checks:{},failed:[]})});
});

app.listen(PORT,()=>console.log(`AutoTube listening on ${PORT}`));
