require('dotenv').config();
const path=require('path');
const fs=require('fs/promises');
const os=require('os');
const crypto=require('crypto');
const {spawn}=require('child_process');
const youtubedl=require('youtube-dl-exec');
const ffmpegPath=require('ffmpeg-static');
const jobs=new Map();
function validYoutubeUrl(input){try{const u=new URL(String(input||'').trim()),h=u.hostname.toLowerCase();if(u.protocol!=='http:'&&u.protocol!=='https:')return false;if(h==='youtu.be')return /^\/[A-Za-z0-9_-]{6,20}$/.test(u.pathname);if(h==='youtube.com'||h==='www.youtube.com'||h.endsWith('.youtube.com'))return(u.pathname==='/watch'&&!!u.searchParams.get('v'))||/^\/shorts\/[A-Za-z0-9_-]{6,20}/.test(u.pathname)||/^\/embed\/[A-Za-z0-9_-]{6,20}/.test(u.pathname);return /\.(mp4|m4v|mov|webm|mkv)(?:$|\?)/i.test(u.pathname+u.search)}catch{}return false}
function runFfmpeg(args){return new Promise((resolve,reject)=>{const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});let e='';p.stderr.on('data',d=>{e+=d.toString();if(e.length>12000)e=e.slice(-12000)});p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error('FFmpeg '+c+': '+e.slice(-2500))))})}
async function sha256File(file){const h=crypto.createHash('sha256');const stream=require('fs').createReadStream(file);for await(const chunk of stream)h.update(chunk);return h.digest('hex')}
async function streamHash(file,map){return new Promise((resolve,reject)=>{const p=spawn(ffmpegPath,['-hide_banner','-loglevel','error','-i',file,'-map',map,'-c','copy','-f','hash','-'],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>{out+=d.toString()});p.stderr.on('data',d=>{err+=d.toString()});p.on('error',reject);p.on('close',c=>{if(c!==0)return reject(new Error('No se pudo calcular la huella del stream '+map+': '+err.slice(-1200)));const m=out.match(/SHA256=([0-9a-f]+)/i);if(!m)return reject(new Error('FFmpeg no devolvió una huella SHA-256 para '+map+'.'));resolve(m[1].toLowerCase())})})}
async function probe(file){const out=await new Promise((resolve,reject)=>{const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-map','0:v:0','-map','0:a:0?','-c','copy','-f','null','-'],{stdio:['ignore','pipe','pipe']});let e='';p.stderr.on('data',d=>{e+=d.toString();if(e.length>30000)e=e.slice(-30000)});p.on('error',reject);p.on('close',c=>c===0?resolve(e):reject(new Error('No se pudo validar el vídeo descargado: '+e.slice(-1800))))});const t=String(out),dm=t.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i),duration=dm?Number(dm[1])*3600+Number(dm[2])*60+Number(dm[3]):0,vl=t.split(/\r?\n/).find(x=>/Video:/i.test(x))||'',al=t.split(/\r?\n/).find(x=>/Audio:/i.test(x))||'',vm=vl.match(/(\d{2,5})x(\d{2,5})/),fm=vl.match(/(\d+(?:\.\d+)?)\s*fps/i),ac=(al.match(/Audio:\s*([a-z0-9_]+)/i)||[])[1]||'';return{duration,width:vm?Number(vm[1]):0,height:vm?Number(vm[2]):0,fps:fm?Number(fm[1]):0,videoLine:vl,audioLine:al,audioCodec:ac}}
async function downloadViaExternalProvider(url,dir){
  const base=String(process.env.AUTOTUBE_EXTERNAL_DOWNLOADER_URL||'').trim().replace(/\/$/,'');
  const key=String(process.env.AUTOTUBE_EXTERNAL_DOWNLOADER_KEY||'').trim();
  if(!base)throw new Error('No hay proveedor externo configurado.');
  const headers={'Accept':'application/json'};if(key)headers['Authorization']='Bearer '+key;
  const infoRes=await fetch(base+'/video/info?url='+encodeURIComponent(url),{headers});
  if(!infoRes.ok)throw new Error('Proveedor externo info HTTP '+infoRes.status);
  const info=await infoRes.json(),data=info?.data||info;
  const dlRes=await fetch(base+'/download',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({url,format:'mp4'})});
  if(!dlRes.ok)throw new Error('Proveedor externo download HTTP '+dlRes.status);
  let task=(await dlRes.json())?.data||{};let fileUrl=task.download_url||task.url;const taskId=task.task_id||task.id;
  const deadline=Date.now()+Number(process.env.AUTOTUBE_EXTERNAL_TIMEOUT_MS||480000);
  while(!fileUrl&&taskId&&Date.now()<deadline){await new Promise(r=>setTimeout(r,3000));const st=await fetch(base+'/download/'+encodeURIComponent(taskId),{headers});if(!st.ok)continue;task=(await st.json())?.data||{};if(task.status==='failed')throw new Error('Proveedor externo falló: '+String(task.error||'descarga fallida'));fileUrl=task.download_url||task.url}
  if(!fileUrl)throw new Error('Proveedor externo no entregó el MP4 dentro del tiempo límite.');
  const target=String(fileUrl).startsWith('http')?String(fileUrl):base+String(fileUrl);const fr=await fetch(target,{headers});if(!fr.ok||!fr.body)throw new Error('No se pudo descargar el MP4 entregado por el proveedor.');
  const out=path.join(dir,'source.mp4'),fh=await fs.open(out,'w');try{const reader=fr.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;await fh.write(value)}}finally{await fh.close()}
  const st=await fs.stat(out);if(!st.size)throw new Error('El proveedor externo devolvió un MP4 vacío.');
  return{source:out,bytes:st.size,strategy:'external-provider',external:{title:String(data.title||''),description:String(data.description||''),duration:Number(data.duration||0)}};
}
async function downloadViaPiped(url,dir){
  const u=new URL(url);
  let id='';
  if(u.hostname.toLowerCase()==='youtu.be'){
    id=u.pathname.split('/').filter(Boolean)[0]||'';
  }else{
    id=u.searchParams.get('v')||'';
    if(!id){
      const parts=u.pathname.split('/').filter(Boolean);
      if((parts[0]==='shorts'||parts[0]==='embed')&&parts[1])id=parts[1];
    }
  }
  if(!id)throw new Error('No se pudo extraer el ID de YouTube.');
  const instances=String(process.env.AUTOTUBE_PIPED_INSTANCES||'https://pipedapi.kavin.rocks,https://pipedapi-libre.kavin.rocks,https://pipedapi.leptons.xyz,https://piped-api.privacy.com.de,https://pipedapi.adminforge.de,https://api.piped.yt,https://pipedapi.privacydev.net,https://pipedapi.smnz.de,https://pipedapi.pfcd.me,https://pipedapi.darkness.services,https://pipedapi.owo.si,https://pipedapi.12a.app,https://pipedapi.nezumi.party,https://pipedapi.ngn.tf,https://pipedapi.drgns.space').split(',').map(x=>x.trim().replace(/\/$/,'')).filter(Boolean);
  let last='';
  for(const base of instances){
    try{
      const r=await fetch(base+'/streams/'+encodeURIComponent(id),{headers:{Accept:'application/json'}});
      if(!r.ok)throw new Error('API HTTP '+r.status);
      const data=await r.json();
      const streams=Array.isArray(data.videoStreams)?data.videoStreams:[];
      const videos=streams.filter(x=>x&&x.url&&String(x.mimeType||'').toLowerCase().startsWith('video/mp4')).sort((a,b)=>(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0))||Number(b.bitrate||0)-Number(a.bitrate||0));
      const audios=(Array.isArray(data.audioStreams)?data.audioStreams:[]).filter(x=>x&&x.url).sort((a,b)=>Number(b.bitrate||0)-Number(a.bitrate||0));
      const selected=videos[0];
      if(!selected)throw new Error('No hay stream MP4 de vídeo.');
      const out=path.join(dir,'source.mp4');
      if(selected.videoOnly===false||selected.videoOnly===undefined){
        const fr=await fetch(selected.url,{headers:{Referer:'https://piped.video/'}});
        if(!fr.ok||!fr.body)throw new Error('vídeo HTTP '+fr.status);
        const fh=await fs.open(out,'w');try{const reader=fr.body.getReader();while(true){const part=await reader.read();if(part.done)break;await fh.write(part.value)}}finally{await fh.close()}
      }else if(audios[0]){
        const vp=path.join(dir,'piped-video.mp4'),ap=path.join(dir,'piped-audio.m4a');
        for(const pair of [[selected.url,vp],[audios[0].url,ap]]){
          const fr=await fetch(pair[0],{headers:{Referer:'https://piped.video/'}});
          if(!fr.ok||!fr.body)throw new Error('stream HTTP '+fr.status);
          const fh=await fs.open(pair[1],'w');try{const reader=fr.body.getReader();while(true){const part=await reader.read();if(part.done)break;await fh.write(part.value)}}finally{await fh.close()}
        }
        await runFfmpeg(['-y','-hide_banner','-loglevel','error','-i',vp,'-i',ap,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',out]);
      }else throw new Error('No hay audio reproducible.');
      const st=await fs.stat(out);
      if(!st.size)throw new Error('MP4 vacío.');
      return{source:out,bytes:st.size,strategy:'piped:'+base,external:{title:String(data.title||''),description:String(data.description||''),duration:Number(data.duration||0),thumbnail:String(data.thumbnailUrl||'')}};
    }catch(e){
      last=base+': '+String(e&&e.message||e);console.error('AUTOTUBE PIPED FAILED',last);
      for(const name of await fs.readdir(dir).catch(()=>[])){
        if(name==='source.mp4'||name==='piped-video.mp4'||name==='piped-audio.m4a')await fs.rm(path.join(dir,name),{force:true}).catch(()=>{});
      }
    }
  }
  throw new Error('Piped no pudo obtener el vídeo. Último error: '+last);
}

async function downloadViaCobalt(url,dir){
  const base=String(process.env.AUTOTUBE_COBALT_API_URL||'').trim().replace(/\/$/,'');
  if(!base)throw new Error('Cobalt no configurado.');
  const headers={'Accept':'application/json','Content-Type':'application/json'};
  const key=String(process.env.AUTOTUBE_COBALT_API_KEY||'').trim();
  if(key)headers.Authorization='Api-Key '+key;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);
  let r,lastBody='';
  try{
    for(let attempt=1;attempt<=3;attempt++){
      r=await fetch(base+'/',{method:'POST',headers,body:JSON.stringify({url,videoQuality:'1080',downloadMode:'auto',youtubeVideoCodec:'h264',youtubeVideoContainer:'mp4',youtubeBetterAudio:true,disableMetadata:false}),signal:controller.signal});
      if(r.ok)break;
      lastBody=await r.text().catch(()=> '');
      if(![502,503,504,429].includes(r.status)||attempt===3)break;
      await new Promise(resolve=>setTimeout(resolve,attempt*5000));
    }
  }finally{clearTimeout(timer)}
  if(!r.ok)throw new Error('Cobalt HTTP '+r.status+' '+lastBody);
  const data=await r.json();
  if(data.status==='error')throw new Error('Cobalt '+String(data.code||'error')+' '+JSON.stringify(data.context||{}));
  let fileUrl=data.url;
  if(data.status==='redirect'&&fileUrl){}
  else if(data.status==='tunnel'&&fileUrl){}
  else if(data.status==='local-processing'&&data.url)fileUrl=data.url;
  else throw new Error('Cobalt devolvió estado no descargable: '+JSON.stringify(data).slice(0,2000));
  const fr=await fetch(fileUrl,{headers:key?{Authorization:'Api-Key '+key}:{}});
  if(!fr.ok||!fr.body)throw new Error('Cobalt file HTTP '+fr.status);
  const out=path.join(dir,'source.mp4'),fh=await fs.open(out,'w');
  try{const reader=fr.body.getReader();while(true){const part=await reader.read();if(part.done)break;await fh.write(part.value)}}finally{await fh.close()}
  const st=await fs.stat(out);if(!st.size)throw new Error('Cobalt devolvió un MP4 vacío.');
  return{source:out,bytes:st.size,strategy:'cobalt',external:{title:String(data.filename||''),cobaltStatus:data.status}};
}

async function downloadViaInvidious(url,dir){
  const u=new URL(url);
  let id='';
  if(u.hostname.toLowerCase()==='youtu.be') id=u.pathname.split('/').filter(Boolean)[0]||'';
  else if(u.searchParams.get('v')) id=u.searchParams.get('v');
  else { const parts=u.pathname.split('/').filter(Boolean); if((parts[0]==='shorts'||parts[0]==='embed')&&parts[1]) id=parts[1]; }
  if(!id) throw new Error('No se pudo extraer el ID de YouTube.');
  const instances=String(process.env.AUTOTUBE_INVIDIOUS_INSTANCES||'https://inv.nadeko.net,https://invidious.nerdvpn.de,https://yt.chocolatemoo53.com,https://invidious.tiekoetter.com').split(',').map(x=>x.trim().replace(/\/$/,'')).filter(Boolean);
  let last='';
  for(const base of instances){
    try{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
      let r;
      try{r=await fetch(base+'/api/v1/videos/'+encodeURIComponent(id),{headers:{Accept:'application/json'},signal:controller.signal});}
      finally{clearTimeout(timer)}
      if(!r.ok) throw new Error('HTTP '+r.status);
      const data=await r.json();
      const progressive=(Array.isArray(data.formatStreams)?data.formatStreams:[]).filter(x=>x?.url&&String(x.container||'').toLowerCase()==='mp4').sort((a,b)=>(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0)))[0];
      const adaptive=(Array.isArray(data.adaptiveFormats)?data.adaptiveFormats:[]);
      const videos=adaptive.filter(x=>x?.url&&/^video\//i.test(String(x.type||''))).sort((a,b)=>(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0)));
      const audios=adaptive.filter(x=>x?.url&&/^audio\//i.test(String(x.type||''))).sort((a,b)=>Number(b.bitrate||0)-Number(a.bitrate||0));
      const out=path.join(dir,'source.mp4');
      if(progressive){
        const fr=await fetch(progressive.url);
        if(!fr.ok||!fr.body)throw new Error('stream HTTP '+fr.status);
        const fh=await fs.open(out,'w');try{const reader=fr.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;await fh.write(value)}}finally{await fh.close()}
      }else if(videos.length&&audios.length){
        const vpath=path.join(dir,'iv-video.'+(String(videos[0].container||'mp4').toLowerCase()||'mp4'));
        const apath=path.join(dir,'iv-audio.'+(String(audios[0].container||'m4a').toLowerCase()||'m4a'));
        for(const [src,target] of [[videos[0].url,vpath],[audios[0].url,apath]]){
          const fr=await fetch(src);if(!fr.ok||!fr.body)throw new Error('stream HTTP '+fr.status);
          const fh=await fs.open(target,'w');try{const reader=fr.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;await fh.write(value)}}finally{await fh.close()}
        }
        await runFfmpeg(['-y','-hide_banner','-loglevel','error','-i',vpath,'-i',apath,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',out]);
      }else throw new Error('La instancia no devolvió streams reproducibles.');
      const st=await fs.stat(out);if(!st.size)throw new Error('MP4 vacío.');
      return{source:out,bytes:st.size,strategy:'invidious:'+base,external:{title:String(data.title||''),description:String(data.description||''),duration:Number(data.lengthSeconds||0),channelTitle:String(data.author||''),captions:Array.isArray(data.captions)?data.captions:[]}};
    }catch(e){last=base+': '+String(e?.message||e);console.error('AUTOTUBE INVIDIOUS FAILED',last);for(const f of await fs.readdir(dir).catch(()=>[]))if(/^source\.mp4$|^iv-(?:video|audio)\./i.test(f))await fs.rm(path.join(dir,f),{force:true}).catch(()=>{})}
  }
  throw new Error('Invidious no pudo obtener el vídeo. Último error: '+last);
}

async function downloadExactYoutube(url,dir){await fs.mkdir(dir,{recursive:true});const parsed=new URL(url);if(!/youtube\.com$|youtu\.be$/i.test(parsed.hostname)){const ext=(path.extname(parsed.pathname).toLowerCase()||'.mp4');const out=path.join(dir,'source'+ext);const r=await fetch(url);if(!r.ok)throw new Error('La URL directa devolvió HTTP '+r.status+'.');const file=await fs.open(out,'w');try{if(!r.body)throw new Error('La URL directa no devolvió contenido.');const reader=r.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;await file.write(value)}}finally{await file.close()}const st=await fs.stat(out);if(!st.size)throw new Error('La URL directa devolvió un archivo vacío.');return{source:out,bytes:st.size,strategy:'direct-media-url'}}try{return await downloadViaCobalt(url,dir)}catch(e){console.log('AUTOTUBE COBALT FAILED',String(e?.message||e));}const out=path.join(dir,'source.%(ext)s'),potScript=path.join(process.cwd(),'.pot-provider','server','build','generate_once.js'),potArgs=`youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416;youtube:player_client=mweb,web_safari`,strategies=[{name:'mweb-pot',format:'bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/best[ext=mp4]',extractorArgs:'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416;youtube:player_client=mweb,web_safari'},{name:'web-default',format:'bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/best[ext=mp4]',extractorArgs:'youtube:player_client=web,web_safari,android_vr,tv'},{name:'safari-hls-fallback',format:'bestvideo*+bestaudio/best',extractorArgs:'youtube:player_client=web_safari,android_vr,tv'},{name:'android-vr-fallback',format:'bestvideo*+bestaudio/best',extractorArgs:'youtube:player_client=android_vr,tv,web_embedded'},{name:'tv-fallback',format:'bestvideo*+bestaudio/best',extractorArgs:'youtube:player_client=tv,web_embedded,android_vr'},{name:'best-single',format:'best',extractorArgs:'youtube:player_client=web_safari,android_vr,tv'}];let last='';for(const s of strategies){try{const result=await youtubedl(url,{format:s.format,output:out,mergeOutputFormat:'mp4',noPlaylist:true,noWarnings:true,noCheckCertificates:true,restrictFilenames:true,preferFreeFormats:false,ffmpegLocation:path.dirname(ffmpegPath),retries:5,fragmentRetries:5,concurrentFragments:1,extractorArgs:s.extractorArgs,jsRuntimes:'node',remoteComponents:'ejs:github',forceIpv4:true,referer:'https://www.youtube.com/',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',verbose:true},{timeout:30000,killSignal:'SIGKILL'});const files=await fs.readdir(dir),c=files.filter(x=>/^source\.(mp4|mkv|webm|mov|m4v)$/i.test(x));if(!c.length)throw new Error('yt-dlp no produjo un archivo de vídeo.');const source=path.join(dir,c[0]),st=await fs.stat(source);if(!st.size)throw new Error('El archivo descargado está vacío.');return{source,bytes:st.size,strategy:s.name,ytDlpOutput:String(result||'').slice(-1500)}}catch(e){last=s.name+': '+String(e?.stderr||e?.message||e||'').slice(-6000);console.error('AUTOTUBE YTDLP STRATEGY FAILED',s.name,last);for(const f of await fs.readdir(dir).catch(()=>[]))if(/^source\./i.test(f))await fs.rm(path.join(dir,f),{force:true}).catch(()=>{})}}try{return await downloadViaPiped(url,dir)}catch(e){last='piped: '+String(e?.message||e)+' | prior='+last}try{return await downloadViaPiped(url,dir)}catch(e){last='piped: '+String(e?.message||e)+' | prior='+last}try{return await downloadViaPiped(url,dir)}catch(e){last='piped: '+String(e?.message||e)+' | prior='+last}try{return await downloadViaCobalt(url,dir)}catch(e){last='cobalt: '+String(e?.message||e)+' | prior='+last}try{return await downloadViaInvidious(url,dir)}catch(e){last='invidious: '+String(e?.message||e)+' | prior='+last}if(process.env.AUTOTUBE_EXTERNAL_DOWNLOADER_URL){try{return await downloadViaExternalProvider(url,dir)}catch(e){last='external-provider: '+String(e?.message||e)}}throw new Error('No se pudo obtener el vídeo de referencia por ninguna fuente configurada. Último error: '+last)}
async function toMp4(source,output){
  // STRICT QUALITY MODE: never re-encode the original media. Re-encoding changes
  // the audiovisual stream and therefore cannot satisfy an exact-match request.
  if(path.extname(source).toLowerCase()==='.mp4'){
    await fs.copyFile(source,output);
    return'direct-copy';
  }
  try{
    await runFfmpeg(['-y','-hide_banner','-loglevel','error','-i',source,'-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart',output]);
    return'remux-copy';
  }catch(err){
    throw new Error('El vídeo original no puede convertirse a contenedor MP4 sin recodificar. AutoTube no recodifica porque eso alteraría la calidad/condiciones audiovisuales originales. '+String(err?.message||err||''));
  }
}
async function processJob(id,reference){const dir=path.join(os.tmpdir(),'autotube-url-'+id),output=path.join(dir,'autotube-exact.mp4');try{await fs.mkdir(dir,{recursive:true});jobs.get(id).progress=10;const dl=await downloadExactYoutube(reference,dir);jobs.get(id).progress=65;const sourceProbe=await probe(dl.source);jobs.get(id).source=sourceProbe;const mode=await toMp4(dl.source,output);jobs.get(id).progress=92;const finalProbe=await probe(output),stat=await fs.stat(output);if(!stat.size)throw new Error('El MP4 final está vacío.');if(sourceProbe.duration&&Math.abs(sourceProbe.duration-finalProbe.duration)>Math.max(1,sourceProbe.duration*.01))throw new Error('La duración cambió durante la conversión.');if(sourceProbe.width&&finalProbe.width&&sourceProbe.width!==finalProbe.width)throw new Error('La resolución de vídeo cambió.');if(sourceProbe.height&&finalProbe.height&&sourceProbe.height!==finalProbe.height)throw new Error('La resolución de vídeo cambió.');const [sourceFileHash,finalFileHash,sourceVideoHash,finalVideoHash,sourceAudioHash,finalAudioHash]=await Promise.all([sha256File(dl.source),sha256File(output),streamHash(dl.source,'0:v:0'),streamHash(output,'0:v:0'),streamHash(dl.source,'0:a:0?'),streamHash(output,'0:a:0?')]);if(sourceVideoHash!==finalVideoHash)throw new Error('El stream de vídeo cambió: la secuencia audiovisual no es idéntica.');if(sourceAudioHash!==finalAudioHash)throw new Error('El stream de audio cambió: narración, música o sonido no son idénticos.');if(path.extname(dl.source).toLowerCase()==='.mp4'&&sourceFileHash!==finalFileHash)throw new Error('El MP4 final no es byte a byte idéntico al original.');Object.assign(jobs.get(id),{status:'done',progress:100,finishedAt:Date.now(),outputPath:output,size:stat.size,mode,final:finalProbe,integrity:{sourceFileSha256:sourceFileHash,finalFileSha256:finalFileHash,sourceVideoSha256:sourceVideoHash,finalVideoSha256:finalVideoHash,sourceAudioSha256:sourceAudioHash,finalAudioSha256:finalAudioHash,videoIdentical:sourceVideoHash===finalVideoHash,audioIdentical:sourceAudioHash===finalAudioHash,fileIdentical:sourceFileHash===finalFileHash}});console.log('AUTOTUBE URL->MP4 PASSED',id,{mode,source:sourceProbe,final:finalProbe,bytes:stat.size})}catch(e){console.error('AUTOTUBE URL->MP4 FAILED',id,e);Object.assign(jobs.get(id),{status:'error',progress:0,error:e.message||String(e)});await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}}
function install(){if(install.done)return;install.done=true;const Express=require('express'),originalListen=Express.application.listen;Express.application.listen=function(...args){const app=this;if(!app.__autotubeExactUrlRoutes){app.__autotubeExactUrlRoutes=true;app.post('/api/url-to-mp4',async(req,res)=>{const reference=String(req.body?.reference||'').trim();if(!validYoutubeUrl(reference))return res.status(400).json({error:'La URL no es un vídeo de YouTube ni una URL directa de vídeo descargable (.mp4/.m4v/.mov/.webm/.mkv).'});const active=[...jobs.values()].find(j=>j.status==='processing');if(active){if(String(active.reference||'')===reference)return res.status(202).json({ok:true,reused:true,jobId:active.id,status:'processing',progress:active.progress||0,statusUrl:'/api/url-to-mp4/'+encodeURIComponent(active.id)});return res.status(409).json({error:'Ya hay una descarga/render de URL en curso.'});}const id='urlmp4_'+Date.now()+'_'+crypto.randomBytes(5).toString('hex');jobs.set(id,{id,status:'processing',progress:1,createdAt:Date.now(),reference});res.status(202).json({ok:true,jobId:id,status:'processing',statusUrl:'/api/url-to-mp4/'+encodeURIComponent(id)});processJob(id,reference)});app.get('/api/url-to-mp4/:jobId',async(req,res)=>{const j=jobs.get(String(req.params.jobId||''));if(!j)return res.status(404).json({error:'Trabajo no encontrado. Render puede haberse reiniciado.'});if(j.status==='processing')return res.json({ok:true,status:'processing',progress:j.progress||0});if(j.status==='error')return res.json({ok:false,status:'error',error:j.error||'No se pudo generar el MP4.'});res.json({ok:true,status:'done',progress:100,size:j.size,mode:j.mode,source:j.source,final:j.final,downloadUrl:'/api/url-to-mp4/'+encodeURIComponent(j.id)+'/download'})});app.get('/api/url-to-mp4/:jobId/internal-path',async(req,res)=>{const j=jobs.get(String(req.params.jobId||''));if(!j||j.status!=='done')return res.status(404).json({error:'MP4 interno no disponible.'});try{await fs.stat(j.outputPath);return res.json({ok:true,path:j.outputPath,size:j.size,final:j.final,mode:j.mode})}catch{return res.status(404).json({error:'El MP4 interno ya no está disponible.'})}});app.get('/api/url-to-mp4/:jobId/download',async(req,res)=>{const j=jobs.get(String(req.params.jobId||''));if(!j||j.status!=='done')return res.status(404).json({error:'MP4 no disponible.'});try{await fs.stat(j.outputPath);res.download(j.outputPath,'autotube-exact.mp4')}catch{res.status(404).json({error:'El MP4 ya no está disponible. Genera uno nuevo.'})}})}return originalListen.apply(this,args)}}install();
