// Stability layer for the long-running URL -> MP4 pipeline.
// It does not alter AI outline/production-plan generation.
// It only prevents external media/TTS/YouTube-understanding requests from
// keeping a Render free instance occupied indefinitely.
const originalFetch = global.fetch;

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

function youtubeAnalysisFallbackResponse() {
  const segmentCount = 6;
  const segmentDuration = 10;
  const sceneSegments = Array.from({length:segmentCount},(_,i)=>({
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
    videoProfile:{durationSeconds:segmentCount*segmentDuration,constantImage:false,estimatedSceneCount:segmentCount,sceneChangeRate:'moderate',cameraMovement:'subtle cinematic movement',composition:'horizontal 16:9 composition',palette:'coherent cinematic palette',lighting:'cinematic lighting',visualStyle:'original cinematic treatment',continuity:'high'},
    animationProfile:{cameraMotion:'subtle push-ins and lateral movement',zoomStyle:'slow cinematic push-in',panStyle:'slow lateral pan',overlays:'none unless required',textAnimation:'minimal',effects:'subtle atmospheric effects',transitionStyle:'soft crossfades',motionIntensity:'low to medium',visualRhythm:'steady with controlled changes'},
    audioProfile:{hasSpeech:true,language:'es',speechRate:'natural',pauses:'short natural pauses',emotion:'clear and engaging',hasMusic:true,hasAmbience:true,hasSoundEffects:false,musicMood:'cinematic and coherent with the topic',energy:'medium',dynamics:'moderate',instrumentation:'original instrumental background',voiceStyle:'natural Spanish narration',bpmEstimate:90,voiceMusicBalance:'voice clearly above music',audioContinuity:'continuous'},
    structureProfile:{opening:'clear thematic opening',pacing:'steady',transitions:'soft',segmentCount,segmentDurations:sceneSegments.map(()=>segmentDuration),visualContinuity:'high',timestamps:sceneSegments.map(x=>x.startSeconds),sceneSegments},
    generationDirectives:{useSingleContinuousVisual:false,preferredSceneCount:segmentCount,preserveVisualContinuity:true,preserveAudioContinuity:true,visualSearchStrategy:'Find distinct original royalty-cleared visuals matching each generated scene and topic.',musicStrategy:'Generate original instrumental music matching the topic and narration.',narrationStrategy:'Natural Spanish narration with clear pacing.',animationStrategy:'Subtle original camera motion and soft transitions.'}
  };
  return new Response(JSON.stringify({output_text:JSON.stringify(analysis)}),{status:200,headers:{'Content-Type':'application/json'}});
}

global.fetch = async function patchedFetch(url, options = {}) {
  const timeoutMs = timeoutForRequest(url, options);
  const value = String(url || '');
  const body = String(options?.body || '');
  const isYoutubeUnderstanding = /generativelanguage\.googleapis\.com\/v1beta\/interactions/i.test(value)
    && /"type"\s*:\s*"video"/i.test(body);
  if (!timeoutMs) return originalFetch(url, options);
  const controller = new AbortController();
  const upstreamSignal = options?.signal;
  let abortedByUs = false;
  let timer = null;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort(upstreamSignal.reason);
    else upstreamSignal.addEventListener('abort', () => controller.abort(upstreamSignal.reason), { once: true });
  }
  timer = setTimeout(() => { abortedByUs = true; controller.abort(new Error('AutoTube external request timeout')); }, timeoutMs);
  try {
    const response = await originalFetch(url, { ...options, signal: controller.signal });
    if (isYoutubeUnderstanding && (response.status === 429 || response.status >= 500)) {
      await response.arrayBuffer().catch(() => {});
      console.warn('Gemini YouTube understanding unavailable; using lightweight reference fallback.');
      return youtubeAnalysisFallbackResponse();
    }
    return response;
  } catch (err) {
    if (isYoutubeUnderstanding && (abortedByUs || /429|rate.?limit|timeout/i.test(String(err?.message || err)))) {
      console.warn('Gemini YouTube understanding timed out/rate-limited; using lightweight reference fallback.');
      return youtubeAnalysisFallbackResponse();
    }
    if (abortedByUs && /generativelanguage\.googleapis\.com\/v1beta\/interactions/i.test(value)) {
      console.warn('Gemini interaction timed out; continuing with local fallback.');
      return new Response('{}', { status: 504, headers: { 'Content-Type': 'application/json' } });
    }
    if (abortedByUs && /generativelanguage\.googleapis\.com/i.test(value)) {
      throw new Error('Gemini TTS 429: AutoTube Gemini TTS request timed out after 60 seconds; fallback requested.');
    }
    throw err;
  } finally { if (timer) clearTimeout(timer); }
};

console.log('AutoTube render stability preload active');
