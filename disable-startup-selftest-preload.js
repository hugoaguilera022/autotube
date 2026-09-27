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

// E2E is triggered explicitly only; never consume Gemini quota on service startup.\n
if(process.env.AUTOTUBE_E2E_ON_START==='1'){
  delete process.env.AUTOTUBE_E2E_ON_START;
  originalSetTimeout(async()=>{
    const base='http://127.0.0.1:'+String(process.env.PORT||10000);
    const reference='https://www.youtube.com/watch?v=P_iFWenf1VA';
    for(let i=0;i<3;i++){
      try{
        const res=await fetch(base+'/api/full-pipeline-test?reference='+encodeURIComponent(reference));
        const body=await res.text();
        console.log('AUTOTUBE CONTROLLED E2E',res.status,body.slice(0,1600));
        if(res.status!==503)return;
      }catch(e){console.log('AUTOTUBE controlled E2E trigger retry',e?.message||String(e))}
      await new Promise(r=>originalSetTimeout(r,10000));
    }
  },30000);
}
