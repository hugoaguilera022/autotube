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

  if (/api\.pexels\.com/i.test(value)) return 20000;
  if (/pixabay\.com\/api/i.test(value)) return 20000;

  return 0;
}

function youtubeAnalysisFallbackResponse() {
  const analysis = {
    videoProfile: {
      durationSeconds: 0,
      constantImage: true,
      estimatedSceneCount: 1,
      sceneChangeRate: "unknown",
      cameraMovement: "minimal",
      composition: "horizontal 16:9 composition suitable for a YouTube video",
      palette: "natural and coherent with the reference topic",
      lighting: "natural cinematic lighting",
      visualStyle: "original documentary/cinematic visual treatment",
      continuity: "preserve strong visual continuity across the generated video"
    },
    animationProfile: {
      cameraMotion: "subtle original motion",
      zoomStyle: "slow optional push-in",
      panStyle: "slow optional pan",
      overlays: "none unless required by the topic",
      textAnimation: "minimal",
      effects: "subtle atmospheric effects only",
      transitionStyle: "soft crossfades",
      motionIntensity: "low",
      visualRhythm: "calm and continuous"
    },
    audioProfile: {
      hasSpeech: true,
      language: "es",
      speechRate: "natural",
      pauses: "short natural pauses",
      emotion: "clear and engaging",
      hasMusic: true,
      hasAmbience: true,
      hasSoundEffects: false,
      musicMood: "cinematic and coherent with the topic",
      energy: "medium",
      dynamics: "moderate",
      instrumentation: "original instrumental background",
      voiceStyle: "natural Spanish narration",
      bpmEstimate: 90,
      voiceMusicBalance: "voice clearly above music",
      audioContinuity: "continuous"
    },
    structureProfile: {
      opening: "clear thematic opening",
      pacing: "steady",
      transitions: "soft",
      segmentCount: 1,
      segmentDurations: [],
      visualContinuity: "high",
      timestamps: [],
      sceneSegments: [{
        startSeconds: 0,
        endSeconds: 0,
        summary: "Original continuous visual segment based on the reference topic.",
        subject: "reference topic",
        shotScale: "medium/wide",
        composition: "cinematic horizontal composition",
        cameraMovement: "subtle",
        motionIntensity: "low",
        lighting: "natural",
        palette: "coherent and cinematic",
        transitionIn: "fade in",
        transitionOut: "fade out",
        audioRole: "continuous music and narration",
        narrationRole: "explain the topic naturally",
        continuityAnchor: "consistent subject, palette and lighting",
        generationPrompt: "Create an original cinematic visual related to the reference topic; do not copy any scene, person, text, framing or recording."
      }]
    },
    generationDirectives: {
      useSingleContinuousVisual: true,
      preferredSceneCount: 1,
      preserveVisualContinuity: true,
      preserveAudioContinuity: true,
      visualSearchStrategy: "Find original royalty-cleared visuals matching each generated scene and topic.",
      musicStrategy: "Generate original instrumental music matching the topic and narration.",
      narrationStrategy: "Natural Spanish narration with clear pacing.",
      animationStrategy: "Subtle original camera motion and soft transitions."
    }
  };
  return new Response(JSON.stringify({
    output_text: JSON.stringify(analysis)
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
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

  timer = setTimeout(() => {
    abortedByUs = true;
    controller.abort(new Error('AutoTube external request timeout'));
  }, timeoutMs);

  try {
    const response = await originalFetch(url, { ...options, signal: controller.signal });

    // Gemini video understanding can be rate-limited on the free tier.
    // Do not let that prevent the actual URL -> MP4 pipeline from reaching
    // the existing outline/production-plan and rendering stages.
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
    if (abortedByUs && /generativelanguage\.googleapis\.com/i.test(value)) {
      throw new Error('Gemini TTS 429: AutoTube Gemini TTS request timed out after 60 seconds; fallback requested.');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

console.log('AutoTube render stability preload active');
