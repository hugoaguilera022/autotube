const originalFetch=global.fetch;
function timeoutForRequest(url){const u=String(url||'');if(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\/ai\//i.test(u))return 180000;if(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(u))return 0;if(/generativelanguage[.]googleapis[.]com\/v1beta\/interactions/i.test(u))return 120000;if(/(?:^|\.)hf\.space\//i.test(u)||/huggingface\.co/i.test(u))return 300000;if(/gen\.pollinations\.ai/i.test(u))return 300000;if(/youtube\.com|googlevideo\.com|ytimg\.com|i\.ytimg\.com|yt3\.ggpht\.com/i.test(u))return 120000;if(/^https?:/i.test(u))return 30000;return 0;}
global.fetch=async function(url,options={}){const timeoutMs=timeoutForRequest(url);if(!timeoutMs)return originalFetch(url,options);const controller=new AbortController();const upstream=options?.signal;if(upstream){if(upstream.aborted)controller.abort(upstream.reason);else upstream.addEventListener('abort',()=>controller.abort(upstream.reason),{once:true});}const timer=setTimeout(()=>controller.abort(new Error('AutoTube external request timeout: '+String(url||'').slice(0,300))),timeoutMs);try{return await originalFetch(url,{...options,signal:controller.signal});}finally{clearTimeout(timer)}};
console.log('AutoTube render stability preload active');

// Independent watchdog: if the Node event loop/server stops answering health checks,
// Render is allowed to restart the instance and the autonomous cycle can resume.
// It does not restart healthy instances and exits automatically when its parent exits.
if(String(process.env.AUTOTUBE_WATCHDOG_DISABLED||'0')!=='1'){
  const {spawn}=require('child_process');
  const port=Number(process.env.PORT||3000);
  const parentPid=process.pid;
  const script=`const pid=${parentPid},port=${port};let misses=0;const wait=ms=>new Promise(r=>setTimeout(r,ms));async function main(){await wait(45000);for(;;){try{process.kill(pid,0)}catch{process.exit(0)};try{const c=new AbortController();const t=setTimeout(()=>c.abort(),10000);const r=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:c.signal});clearTimeout(t);if(r.ok){misses=0}else misses++}catch{misses++};if(misses>=6){try{process.kill(pid,'SIGTERM')}catch{};process.exit(0)}await wait(30000)}}main();`;
  const child=spawn(process.execPath,['-e',script],{detached:true,stdio:'ignore'});
  child.unref();
}
