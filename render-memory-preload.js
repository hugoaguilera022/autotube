// Render Free memory guard: keep FFmpeg and optional binary AI providers bounded.
const Module = require('module');
const nativeRequire = Module.prototype.require;
Module.prototype.require = function autotubeRenderMemoryGuard(request) {
  if (request === 'child_process') {
    const cp = nativeRequire.apply(this, arguments);
    const nativeSpawn = cp.spawn;
    cp.spawn = function autotubeSpawn(command, args, options) {
      const a = Array.isArray(args) ? [...args] : args;
      const cmd = String(command || '').toLowerCase();
      if (cmd.includes('ffmpeg') && Array.isArray(a)) {
        const joined = a.join(' ');
        if (/1920:1080/.test(joined)) {
          for (let i = 0; i < a.length; i++) {
            if (typeof a[i] === 'string') a[i] = a[i].replace(/1920:1080/g, '1280:720').replace(/crop=1920:1080/g, 'crop=1280:720');
          }
        }
        if (!a.includes('-threads')) a.push('-threads', '1');
        if (!a.includes('-filter_threads')) a.push('-filter_threads', '1');
        if (!a.includes('-filter_complex_threads')) a.push('-filter_complex_threads', '1');
      }
      return nativeSpawn.call(this, command, a, options);
    };
    return cp;
  }
  return nativeRequire.apply(this, arguments);
};

// Render Free: force deterministic local music instead of large binary Lyria responses.
const nativeFetch = global.fetch;
if (typeof nativeFetch === 'function') {
  global.fetch = async function autotubeRenderFetch(input, init) {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (/generativelanguage\.googleapis\.com\/v1beta\/models\/lyria/i.test(url)) {
      throw new Error('Lyria disabled on constrained Render; using local music fallback.');
    }
    // The original-image Gemini fallback is also optional. If it is unavailable or
    // too memory-heavy, the existing Pixabay/Pexels/reference-thumbnail fallbacks run.
    if (/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash-image/i.test(url)) {
      throw new Error('Gemini image generation disabled on constrained Render; using visual fallback.');
    }
    return nativeFetch(input, init);
  };
}
