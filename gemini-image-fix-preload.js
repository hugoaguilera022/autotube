// Compatibility shim for Gemini 2.5 Flash Image on the REST endpoint used by AutoTube.
// Some deployed API revisions reject responseFormat.image.aspectRatio even though the
// model documentation accepts it. Remove only that optional field; the existing
// renderer normalizes generated stills to the project's 16:9 canvas with FFmpeg.
const nativeFetch = global.fetch;
if (typeof nativeFetch === 'function') {
  global.fetch = async function autotubeGeminiImageFetch(input, init = {}) {
    try {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash-image:generateContent/i.test(url) && init?.body) {
        const body = JSON.parse(String(init.body));
        const image = body?.generationConfig?.responseFormat?.image;
        if (image && Object.prototype.hasOwnProperty.call(image, 'aspectRatio')) {
          delete image.aspectRatio;
          init = { ...init, body: JSON.stringify(body) };
        }
      }
    } catch (_) {}
    return nativeFetch(input, init);
  };
}
