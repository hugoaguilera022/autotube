// AutoTube provider bridge: route the legacy free LTX ZeroGPU call contract to a
// currently running public Wan 2.2 ZeroGPU Space. This keeps the existing pipeline
// unchanged while providing a genuinely AI-generated MP4 without a paid API balance.
const originalFetch=global.fetch;
const target='https://alexcheng0072-wan27-free-video-generator.hf.space';
const eventMap=new Map();

function isLegacyLtx(url){
  return /^https:\/\/DeepRat-LTX-Video-ZeroGPU-Optimized\.hf\.space\/gradio_api\/call\/generate(?:\/.*)?$/i.test(String(url||''));
}
async function bridge(url,options={}){
  const u=String(url||'');
  if(!isLegacyLtx(u)) return originalFetch(url,options);
  const isPoll=/\/gradio_api\/call\/generate\/[^/]+$/i.test(u);
  if(isPoll){
    const oldId=u.split('/').pop();
    const mapped=eventMap.get(oldId);
    if(!mapped)return originalFetch(url,options);
    const response=await originalFetch(target+'/gradio_api/call/generate_video/'+encodeURIComponent(mapped),{
      ...options,
      headers:{...(options.headers||{}),Accept:'text/event-stream'}
    });
    return response;
  }
  let body=options?.body;
  let payload=null;
  try{payload=typeof body==='string'?JSON.parse(body):null}catch{}
  const data=Array.isArray(payload?.data)?payload.data:[];
  const prompt=String(data[0]||'').trim();
  const duration=Math.max(2,Math.min(5,Number(data[7])||3));
  const response=await originalFetch(target+'/gradio_api/call/generate_video',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({data:[null,prompt,'832x480',duration]}),
    signal:options?.signal
  });
  const raw=await response.text();
  if(!response.ok)return new Response(raw,{status:response.status,statusText:response.statusText,headers:{'Content-Type':'application/json'}});
  let parsed=null;try{parsed=JSON.parse(raw)}catch{}
  const newId=String(parsed?.event_id||'').trim();
  if(!newId)return new Response(JSON.stringify({error:'Wan2.2 bridge: no event_id'}),{status:502,headers:{'Content-Type':'application/json'}});
  const oldId='bridge_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  eventMap.set(oldId,newId);
  setTimeout(()=>eventMap.delete(oldId),10*60*1000);
  return new Response(JSON.stringify({event_id:oldId}),{status:200,headers:{'Content-Type':'application/json'}});
}
global.fetch=bridge;
console.log('AutoTube Wan2.2 ZeroGPU bridge active');
