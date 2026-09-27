// The production URL-to-video E2E workflow owns the real end-to-end test.
// Disable the legacy automatic self-test so it cannot consume the single
// Render worker at startup and race the real user job.
const originalSetTimeout=global.setTimeout;
global.setTimeout=function(callback,delay,...args){
  try{
    const source=Function.prototype.toString.call(callback);
    if(Number(delay)===15000 && /selfTestId|startupSelfTestReference|executeUrlToVideo/.test(source)){
      console.log('AutoTube startup self-test disabled; external E2E owns validation.');
      return originalSetTimeout(()=>{},2147483647);
    }
  }catch{}
  return originalSetTimeout(callback,delay,...args);
};
