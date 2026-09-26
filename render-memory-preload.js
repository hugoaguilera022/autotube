// Render Free memory guard: keep FFmpeg and music generation bounded without changing
// the public pipeline. The app still outputs 1280x720 MP4; expensive optional AI
// providers are short-circuited when their response can exceed the 512 MB container.
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

// Lyria is optional. On Render Free its binary audio response can consume a large
// transient buffer, so force the already-present deterministic local music fallback.
if (String(process.env.AUTOTUBE_DISABLE_LYRIA || '1') === '1') {
  const nativeFetch = global.fetch;
  if (typeof nativeFetch === 'function') {
    global.fetch = async function autotubeRenderFetch(input, init) {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (/generativelanguage\.googleapis\.com\/v1beta\/models\/lyria/i.test(url)) {
        throw new Error('Lyria disabled on constrained Render; using local music fallback.');
      }
      return nativeFetch(input, init);
    };
  }
}
