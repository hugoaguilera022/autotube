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
if(process.env.AUTOTUBE_URL_E2E_ON_START==='1'){
  originalSetTimeout(async()=>{
    const base='http://127.0.0.1:'+String(process.env.PORT||10000);
    const reference=String(process.env.AUTOTUBE_E2E_REFERENCE||'https://www.youtube.com/watch?v=P_iFWenf1VA').trim();
    try{
      const res=await fetch(base+'/api/url-to-video?reference='+encodeURIComponent(reference));
      const started=await res.json().catch(()=>null);
      console.log('AUTOTUBE URL E2E START',res.status,JSON.stringify(started));
      const jobId=started?.jobId;
      if(jobId){
        const deadline=Date.now()+30*60*1000;
        while(Date.now()<deadline){
          await new Promise(r=>originalSetTimeout(r,5000));
          const sr=await fetch(base+'/api/url-to-video/'+encodeURIComponent(jobId));
          const data=await sr.json().catch(()=>null);
          console.log('AUTOTUBE URL E2E STATUS',sr.status,JSON.stringify(data).slice(0,6000));
          if(data?.status==='done'||data?.status==='error'||data?.status==='restart')break;
        }
      }
    }catch(e){console.error('AUTOTUBE URL E2E trigger failed',e?.message||String(e))}
  },30000);
}
