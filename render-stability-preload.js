// Stability layer for the long-running URL -> MP4 pipeline.
// It does not alter AI outline/production-plan generation.
// It only prevents external media/TTS requests from hanging indefinitely.
const originalFetch = global.fetch;

function timeoutForRequest(url, options = {}) {
  const value = String(url || '');
  const body = String(options?.body || '');

  // Gemini audio generation can otherwise keep a Render worker stuck on one
  // scene forever. generateNarrationTts already falls back to ElevenLabs for
  // quota-style Gemini errors, so use the same error class on timeout.
  const isGeminiTts = /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent/i.test(value)
    && /responseModalities|AUDIO_WAV|speechConfig/i.test(body);
  if (isGeminiTts) return 60000;

  // Media search should fail quickly enough for the existing Pexels -> Pixabay
  // fallback to run instead of leaving the whole job waiting.
  if (/api\.pexels\.com/i.test(value)) return 20000;
  if (/pixabay\.com\/api/i.test(value)) return 20000;

  return 0;
}

global.fetch = async function patchedFetch(url, options = {}) {
  const timeoutMs = timeoutForRequest(url, options);
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
    return await originalFetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (abortedByUs && /generativelanguage\.googleapis\.com/i.test(String(url || ''))) {
      // generateNarrationTts recognizes this as a quota-style Gemini failure
      // and uses its existing ElevenLabs fallback when available.
      throw new Error('Gemini TTS 429: AutoTube Gemini TTS request timed out after 60 seconds; fallback requested.');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

console.log('AutoTube render stability preload active');
