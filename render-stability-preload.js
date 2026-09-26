// Stability layer for the long-running URL -> MP4 pipeline.
// It does not alter AI outline/production-plan generation.
// It only prevents external media/TTS/YouTube-understanding requests from
// keeping a Render free instance occupied indefinitely.
const originalFetch = global.fetch;
const referenceDurationCache = new Map();

function timeoutForRequest(url, options = {}) {
  const value = String(url || '');
  const body = String(options?.body || '');
  const isGeminiTts = /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent/i.test(value)
    && /responseModalities|AUDIO_WAV|speechConfig/i.test(body);
  if (isGeminiTts) return 60000;
  if (/generativelanguage\.googleapis\.com\/v1beta\/interactions/i.test(value)
      && /"type"\s*:\s*"video"/i.test(body)) return 75000;
  if (/generativelanguage\.googleapis\.com\/v1beta\/interactions/i.test(value)) return 45000;
  if (/api\.pexels\.com/i.test(value)) return 20000;
  if (/pixabay\.com\/api/i.test(value)) return 20000;
  return 0;
}

async function exactReferenceDuration(reference) {
  const key=String(reference||'').trim();
  if(!key)return 0;
  if(referenceDurationCache.has(key))return referenceDurationCache.get(key);
  try{
    const base=`http://127.0.0.1:${process.env.PORT||10000}`;
    const start=await originalFetch(base+'/api/url-to-mp4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:key})});
    const startData=await start.json().catch(()=>null);
    const jobId=startData?.jobId;
    if(!jobId)return 0;
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){
      await new Promise(r=>setTimeout(r,1500));
      const status=await originalFetch(base+'/api/url-to-mp4/'+encodeURIComponent(jobId));
      const data=await status.json().catch(()=>null);
      if(data?.status==='done'){
        const duration=Number(data?.source?.duration||data?.final?.duration||0);
        if(duration>0){referenceDurationCache.set(key,duration);return duration;}
        break;
      }
      if(data?.status==='error')break;
    }
  }catch(err){console.warn('Reference duration helper failed:',err?.message||String(err));}
  return 0;
}

function youtubeAnalysisFallbackResponse(durationSeconds=60) {
  const total=Math.max(30,Math.round(Number(durationSeconds)||60));
  const segmentCount=Math.max(6,Math.min(12,Math.round(total/10)));
  const segmentDuration=total/segmentCount;
  const sceneSegments=Array.from({length:segmentCount},(_,i)=>({
    startSeconds:i*segmentDuration,
    endSeconds:(i+1)*segmentDuration,
    summary:'Original audiovisual segment related to the reference topic.',
    subject:'reference topic',
    shotScale:i===0?'wide':'medium/wide',
    composition:'cinematic horizontal 16:9 composition',
    cameraMovement:i%2?'slow lateral movement':'subtle push-in',
    motionIntensity:i===0?'medium':'low',
    lighting:'cinematic lighting coherent with the reference topic',
    palette:'coherent palette maintained across the sequence',
    transitionIn:i===0?'fade in':'soft crossfade',
    transitionOut:i===segmentCount-1?'fade out':'soft crossfade',
    audioRole:'continuous narration and original background music',
    narrationRole:'natural Spanish narration advancing the topic',
    continuityAnchor:'consistent subject, palette and lighting family',
    generationPrompt:'Create an ORIGINAL cinematic visual related to the reference topic for this temporal segment. Preserve general composition, lighting, palette and motion language without copying any scene, person, text, framing or recording.'
  }));
  const analysis={
    videoProfile:{durationSeconds:total,constantImage:false,estimatedSceneCount:segmentCount,sceneChangeRate:'moderate',cameraMovement:'subtle cinematic movement',composition:'horizontal 16:9 composition',palette:'coherent cinematic palette',lighting:'cinematic lighting',visualStyle:'original cinematic treatment',continuity:'high'},
    animationProfile:{cameraMotion:'subtle push-ins and lateral movement',zoomStyle:'slow cinematic push-in',panStyle:'slow lateral pan',overlays:'none unless required',textAnimation:'minimal',effects:'subtle atmospheric effects',transitionStyle:'soft crossfades',motionIntensity:'low to medium',visualRhythm:'steady with controlled changes'},
    audioProfile:{hasSpeech:true,language:'es',speechRate:'natural',pauses:'short natural pauses',emotion:'clear and engaging',hasMusic:true,hasAmbience:true,hasSoundEffects:false,musicMood:'cinematic and coherent with the topic',energy:'medium',dynamics:'moderate',instrumentation:'original instrumental background',voiceStyle:'natural Spanish narration',bpmEstimate:90,voiceMusicBalance:'voice clearly above music',audioContinuity:'continuous'},
    structureProfile:{opening:'clear thematic opening',pacing:'steady',transitions:'soft',segmentCount,segmentDurations:sceneSegments.map(x=>x.endSeconds-x.startSeconds),visualContinuity:'high',timestamps:sceneSegments.map(x=>x.startSeconds),sceneSegments},
    generationDirectives:{useSingleContinuousVisual:false,preferredSceneCount:segmentCount,preserveVisualContinuity:true,preserveAudioContinuity:true,visualSearchStrategy:'Find distinct original royalty-cleared visuals matching each generated scene and topic.',musicStrategy:'Generate original instrumental music matching the topic and narration.',narrationStrategy:'Natural Spanish narration with clear pacing.',animationStrategy:'Subtle original camera motion and soft transitions.'}
  };
  return new Response(JSON.stringify({output_text:JSON.stringify(analysis)}),{status:200,headers:{'Content-Type':'application/json'}});
}

global.fetch = async function patchedFetch(url, options = {}) {
  const timeoutMs=timeoutForRequest(url,options);
  const value=String(url||'');
  const body=String(options?.body||'');
  const isYoutubeUnderstanding=/generativelanguage\.googleapis\.com\/v1beta\/interactions/i.test(value)&&/"type"\s*:\s*"video"/i.test(body);
  const isYoutubeOembed=/youtube\.com\/oembed\?/i.test(value);

  // oEmbed does not expose duration. AutoTube needs the real reference length
  // to build a scene timeline, so obtain it from the already-proven exact MP4
  // route and enrich the oEmbed JSON without changing the public API contract.
  if(isYoutubeOembed){
    const response=await originalFetch(url,options);
    if(!response.ok)return response;
    try{
      const data=await response.json();
      const reference=new URL(value).searchParams.get('url')||'';
      const duration=await exactReferenceDuration(reference);
      if(duration>0)data.duration=duration;
      return new Response(JSON.stringify(data),{status:response.status,headers:{'Content-Type':'application/json'}});
    }catch{return response;}
  }

  if(!timeoutMs)return originalFetch(url,options);
  const controller=new AbortController();
  const upstreamSignal=options?.signal;
  let abortedByUs=false;
  let timer=null;
  if(upstreamSignal){
    if(upstreamSignal.aborted)controller.abort(upstreamSignal.reason);
    else upstreamSignal.addEventListener('abort',()=>controller.abort(upstreamSignal.reason),{once:true});
  }
  timer=setTimeout(()=>{abortedByUs=true;controller.abort(new Error('AutoTube external request timeout'));},timeoutMs);
  try{
    const response=await originalFetch(url,{...options,signal:controller.signal});
    if(isYoutubeUnderstanding&&(response.status===429||response.status>=500)){
      await response.arrayBuffer().catch(()=>{});
      console.warn('Gemini YouTube understanding unavailable; using duration-aware reference fallback.');
      const ref=body.match(/https?:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]+/)?.[0]||'';
      const duration=ref?await exactReferenceDuration(ref):60;
      return youtubeAnalysisFallbackResponse(duration);
    }
    return response;
  }catch(err){
    if(isYoutubeUnderstanding&&(abortedByUs||/429|rate.?limit|timeout/i.test(String(err?.message||err)))){
      console.warn('Gemini YouTube understanding timed out/rate-limited; using duration-aware reference fallback.');
      const ref=body.match(/https?:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]+/)?.[0]||'';
      const duration=ref?await exactReferenceDuration(ref):60;
      return youtubeAnalysisFallbackResponse(duration);
    }
    if(abortedByUs&&/generativelanguage\.googleapis\.com\/v1beta\/interactions/i.test(value)){
      console.warn('Gemini interaction timed out; continuing with local fallback.');
      return new Response('{}',{status:504,headers:{'Content-Type':'application/json'}});
    }
    if(abortedByUs&&/generativelanguage\.googleapis\.com/i.test(value)){
      throw new Error('Gemini TTS 429: AutoTube Gemini TTS request timed out after 60 seconds; fallback requested.');
    }
    throw err;
  }finally{if(timer)clearTimeout(timer);}
};

console.log('AutoTube render stability preload active');
