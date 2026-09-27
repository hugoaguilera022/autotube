// Render Free uses this preload only as an explicit safety switch. An explicit
// AUTOTUBE_ENABLE_LTX=1 override is required before enabling sequential AI video clips.
if (String(process.env.AUTOTUBE_DISABLE_LTX||'')==='1' && String(process.env.AUTOTUBE_ENABLE_LTX||'')!=='1') {
  const Module=require('module');
  const nativeRequire=Module.prototype.require;
  Module.prototype.require=function autotubeDisableLtx(request){
    if(request==='@gradio/client') return {Client:{connect:async()=>{throw new Error('ZeroGPU disabled by safety switch.')}}};
    return nativeRequire.apply(this,arguments);
  };
}
