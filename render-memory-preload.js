// Render Free memory guard: keep FFmpeg scene rendering bounded without changing
// the public pipeline. The app still outputs 1280x720 MP4; only the intermediate
// canvas/threading is constrained to avoid the 512 MB container limit.
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
