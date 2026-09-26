const original=require('youtube-dl-exec');

//
// STRICT MEDIA MODE
// This wrapper deliberately NEVER fabricates an MP4 from a YouTube thumbnail.
// URL -> MP4 is required to contain the original audiovisual streams.
// If YouTube blocks yt-dlp, the job must fail instead of producing a false match.
//
function wrapped(url,opts={},config={}) {
  return original(url,opts,config).catch(err => {
    const msg=String(err?.stderr||err?.message||err||'');
    if(/not a bot|sign in to confirm|cookies-from-browser|cookies to authenticate|confirm you're not a bot/i.test(msg)) {
      throw new Error('YouTube bloqueó la obtención del vídeo original. AutoTube no generará una miniatura ni un vídeo falso: se requiere acceso al stream original.');
    }
    throw err;
  });
}
Object.assign(wrapped,original);
require.cache[require.resolve('youtube-dl-exec')].exports=wrapped;
