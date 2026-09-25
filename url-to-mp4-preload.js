require('dotenv').config();
const path=require('path');
const fs=require('fs/promises');
const os=require('os');
const crypto=require('crypto');
const {spawn}=require('child_process');
const youtubedl=require('youtube-dl-exec');
const ffmpegPath=require('ffmpeg-static');

const jobs=new Map();

function validYoutubeUrl(input){
  try{
    const u=new URL(String(input||'').trim());
    const host=u.hostname.toLowerCase();
    if(host==='youtu.be') return /^\/[A-Za-z0-9_-]{6,20}$/.test(u.pathname);
    if(host==='youtube.com'||host==='www.youtube.com'||host.endsWith('.youtube.com')){
      return (u.pathname==='/watch'&&!!u.searchParams.get('v'))
        || /^\/shorts\/[A-Za-z0-9_-]{6,20}/.test(u.pathname)
        || /^\/embed\/[A-Za-z0-9_-]{6,20}/.test(u.pathname);
    }
  }catch{}
  return false;
}
function runFfmpeg(args){
  return new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});
    let err='';
    p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000)});
    p.on('error',reject);
    p.on('close',code=>code===0?resolve():reject(new Error('FFmpeg '+code+': '+err.slice(-2500))));
  });
}
async function probe(file){
  const out=await new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-map','0:v:0','-map','0:a:0?','-c','copy','-f','null','-'],{stdio:['ignore','pipe','pipe']});
    let stderr='';
    p.stderr.on('data',d=>{stderr+=d.toString();if(stderr.length>30000)stderr=stderr.slice(-30000)});
    p.on('error',reject);
    p.on('close',code=>code===0?resolve(stderr):reject(new Error('No se pudo validar el vídeo descargado: '+stderr.slice(-1800))));
  });
  const text=String(out);
  const dm=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  const duration=dm?Number(dm[1])*3600+Number(dm[2])*60+Number(dm[3]):0;
  const vm=(text.split(/\r?\n/).find(x=>/Video:/i.test(x))||'').match(/(\d{2,5})x(\d{2,5})/);
  const fm=(text.split(/\r?\n/).find(x=>/Video:/i.test(x))||'').match(/(\d+(?:\.\d+)?)\s*fps/i);
  const videoLine=text.split(/\r?\n/).find(x=>/Video:/i.test(x))||'';
  const audioLine=text.split(/\r?\n/).find(x=>/Audio:/i.test(x))||'';
  const ac=(audioLine.match(/Audio:\s*([a-z0-9_]+)/i)||[])[1]||'';
  return {duration,width:vm?Number(vm[1]):0,height:vm?Number(vm[2]):0,fps:fm?Number(fm[1]):0,videoLine,audioLine,audioCodec:ac};
}
async function downloadExactYoutube(url,dir){
  await fs.mkdir(dir,{recursive:true});
  const out=path.join(dir,'source.%(ext)s');
  const strategies=[
    {name:'mp4-avc-aac',format:'bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/best[ext=mp4]'},
    {name:'best-compatible',format:'bestvideo*+bestaudio/best'},
    {name:'best-single',format:'best'}
  ];
  let last='';
  for(const s of strategies){
    try{
      const result=await youtubedl(url,{
        format:s.format,
        output:out,
        mergeOutputFormat:'mp4',
        noPlaylist:true,
        noWarnings:true,
        noCheckCertificates:true,
        restrictFilenames:true,
        preferFreeFormats:false,
        ffmpegLocation:path.dirname(ffmpegPath),
        retries:3,
        fragmentRetries:3,
        concurrentFragments:2
      },{timeout:600000,killSignal:'SIGKILL'});
      const files=await fs.readdir(dir);
      const candidates=files.filter(x=>/^source\.(mp4|mkv|webm|mov|m4v)$/i.test(x));
      if(!candidates.length) throw new Error('yt-dlp no produjo un archivo de vídeo.');
      const source=path.join(dir,candidates[0]);
      const st=await fs.stat(source);
      if(!st.size)throw new Error('El archivo descargado está vacío.');
      return {source,bytes:st.size,strategy:s.name,ytDlpOutput:String(result||'').slice(-1500)};
    }catch(e){
      last=String(e?.stderr||e?.message||e||'').slice(-2500);
      for(const f of await fs.readdir(dir).catch(()=>[]))if(/^source\./i.test(f))await fs.rm(path.join(dir,f),{force:true}).catch(()=>{});
    }
  }
  throw new Error('YouTube no permitió obtener el vídeo. Último error: '+last);
}
async function toMp4(source,output){
  const ext=path.extname(source).toLowerCase();
  if(ext==='.mp4'){
    await fs.copyFile(source,output);
    return 'direct-copy';
  }
  try{
    await runFfmpeg(['-y','-hide_banner','-loglevel','error','-i',source,'-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart',output]);
    return 'remux-copy';
  }catch{
    await runFfmpeg(['-y','hide_banner','-loglevel','error','-i',source,'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','320k','-movflags','+faststart',output]);
    return 'compatible-transcode';
  }
}
function install(){
  if(install.done)return;
  install.done=true;
  const Express=require('express');
  const originalListen=Express.application.listen;
  Express.application.listen=function(...args){
    const app=this;
    if(!app.__autotubeExactUrlRoutes){
      app.__autotubeExactUrlRoutes=true;
      app.post('/api/url-to-mp4',async(req,res)=>{
        const reference=String(req.body?.reference||'').trim();
        if(!validYoutubeUrl(reference))return res.status(400).json({error:'La URL no es un vídeo de YouTube válido.'});
        if([...jobs.values()].some(j=>j.status==='processing'))return res.status(409).json({error:'Ya hay una descarga/render de URL en curso. Espera a que termine.'});
        const id='urlmp4_'+Date.now()+'_'+crypto.randomBytes(5).toString('hex');
        jobs.set(id,{id,status:'processing',progress:1,createdAt:Date.now(),reference});
        res.status(202).json({ok:true,jobId:id,status:'processing',statusUrl:'/api/url-to-mp4/'+encodeURIComponent(id)});
        (async()=>{
          const dir=path.join(os.tmpdir(),'autotube-url-'+id),output=path.join(dir,'autotube-exact.mp4');
          try{
            await fs.mkdir(dir,{recursive:true});
            jobs.get(id).progress=10;
            const dl=await downloadExactYoutube(reference,dir);
            jobs.get(id).progress=65;
            const sourceProbe=await probe(dl.source);
            jobs.get(id).source=sourceProbe;
            const mode=await toMp4(dl.source,output);
            jobs.get(id).progress=92;
            const finalProbe=await probe(output);
            const stat=await fs.stat(output);
            if(!stat.size)throw new Error('El MP4 final está vacío.');
            if(sourceProbe.duration&&Math.abs(sourceProbe.duration-finalProbe.duration)>Math.max(1,sourceProbe.duration*0.01))throw new Error('La duración cambió durante la conversión.');
            jobs.get(id).status='done';jobs.get(id).progress=100;jobs.get(id).finishedAt=Date.now();jobs.get(id).outputPath=output;jobs.get(id).size=stat.size;jobs.get(id).mode=mode;jobs.get(id).final=finalProbe;
            console.log('Exact URL->MP4 completed',id,{bytes:stat.size,mode,source:sourceProbe,final:finalProbe});
          }catch(e){
            console.error('Exact URL->MP4 error',id,e);
            const j=jobs.get(id);if(j){j.status='error';j.progress=0;j.error=e.message||String(e)}
            await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
          }
        })();
      });
      app.get('/api/url-to-mp4/:jobId',async(req,res)=>{
        const j=jobs.get(String(req.params.jobId||''));
        if(!j)return res.status(404).json({error:'Trabajo no encontrado. Render puede haberse reiniciado.'});
        if(j.status==='processing')return res.json({ok:true,status:'processing',progress:j.progress||0});
        if(j.status==='error')return res.json({ok:false,status:'error',error:j.error||'No se pudo generar el MP4.'});
        res.json({ok:true,status:'done',progress:100,size:j.size,mode:j.mode,source:j.source,final:j.final,downloadUrl:'/api/url-to-mp4/'+encodeURIComponent(j.id)+'/download'});
      });
      app.get('/api/url-to-mp4/:jobId/download',async(req,res)=>{
        const j=jobs.get(String(req.params.jobId||''));
        if(!j||j.status!=='done')return res.status(404).json({error:'MP4 no disponible.'});
        try{await fs.stat(j.outputPath);res.download(j.outputPath,'autotube-exact.mp4');}
        catch{res.status(404).json({error:'El MP4 ya no está disponible. Genera uno nuevo.'});}
      });
    }
    return originalListen.apply(this,args);
  };
}
install();
