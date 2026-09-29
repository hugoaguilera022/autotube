const originalFetch=global.fetch;
function timeoutForRequest(url){const u=String(url||'');if(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\/ai\//i.test(u))return 180000;if(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(u))return 0;if(/generativelanguage[.]googleapis[.]com\/v1beta\/interactions/i.test(u))return 120000;if(/(?:^|\.)hf\.space\//i.test(u)||/huggingface\.co/i.test(u))return 300000;if(/gen\.pollinations\.ai/i.test(u))return 300000;if(/youtube\.com|googlevideo\.com|ytimg\.com|i\.ytimg\.com|yt3\.ggpht\.com/i.test(u))return 120000;if(/^https?:/i.test(u))return 30000;return 0;}
global.fetch=async function(url,options={}){const timeoutMs=timeoutForRequest(url);if(!timeoutMs)return originalFetch(url,options);const controller=new AbortController();const upstream=options?.signal;if(upstream){if(upstream.aborted)controller.abort(upstream.reason);else upstream.addEventListener('abort',()=>controller.abort(upstream.reason),{once:true});}const timer=setTimeout(()=>controller.abort(new Error('AutoTube external request timeout: '+String(url||'').slice(0,300))),timeoutMs);try{return await originalFetch(url,{...options,signal:controller.signal});}finally{clearTimeout(timer)}};
console.log('AutoTube render stability preload active');
// Process-level heartbeat watchdog: a detached child survives a blocked Node event loop.
// The parent refreshes the heartbeat every 20 seconds; after 5 minutes without a refresh,
// the child terminates the parent so Render can restart the instance and resume its checkpoint.
if(String(process.env.AUTOTUBE_HEARTBEAT_WATCHDOG_DISABLED||'0')!=='1'){
  const {spawn}=require('child_process');
  const fs=require('fs');
  const heartbeatPath=require('path').join(require('os').tmpdir(),'autotube-process-heartbeat');
  const parentPid=process.pid;
  try{fs.writeFileSync(heartbeatPath,String(Date.now()));}catch{}
  const heartbeatTimer=setInterval(()=>{try{fs.writeFileSync(heartbeatPath,String(Date.now()));}catch{}},20000);
  heartbeatTimer.unref();
  const watchdog = "const fs=require('fs'),pid="+parentPid+",file="+JSON.stringify(heartbeatPath)+";const wait=ms=>new Promise(r=>setTimeout(r,ms));async function main(){await wait(60000);for(;;){try{process.kill(pid,0)}catch{process.exit(0)};let age=Infinity;try{age=Date.now()-Number(fs.readFileSync(file,'utf8'))}catch{};if(age>300000){try{process.kill(pid,'SIGTERM')}catch{};process.exit(0)}await wait(30000)}}main();";
  const child=spawn(process.execPath,['-e',watchdog],{detached:true,stdio:'ignore'});
  child.unref();
  console.log('AutoTube heartbeat watchdog active: 5m stall recovery');
}

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
