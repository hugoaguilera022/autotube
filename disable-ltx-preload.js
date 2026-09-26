// Keep Render Free stable when Hugging Face ZeroGPU has no quota.
// The main renderer already has a visual fallback; this prevents loading/connecting
// the Gradio LTX client at all, avoiding a 512 MB memory spike.
if (String(process.env.AUTOTUBE_DISABLE_LTX || '') === '1') {
  const Module = require('module');
  const nativeRequire = Module.prototype.require;
  Module.prototype.require = function autotubeDisableLtx(request) {
    if (request === '@gradio/client') {
      return {
        Client: {
          connect: async function () {
            throw new Error('ZeroGPU disabled on constrained Render; use visual fallback.');
          }
        }
      };
    }
    return nativeRequire.apply(this, arguments);
  };
}
