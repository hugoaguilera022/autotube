const fs=require('fs/promises');
const path=require('path');
const os=require('os');
const {spawn}=require('child_process');
const ffmpegPath=require('ffmpeg-static');
const original=require('youtube-dl-exec');

function videoId(input){try{const u=new URL(String(input||''));if(u.hostname==='youtu.be')return u.pathname.slice(1).split('/')[0];if(u.hostname.endsWith('youtube.com')){if(u.pathname==='/watch')return u.searchParams.get('v')||'';if(u.pathname.startsWith('/shorts/'))return u.pathname.split('/')[2]||'';if(u.pathname.startsWith('/embed/'))return u.pathname.split('/')[2]||''}}catch{}return''}
function ffmpeg(args){return new Promise((resolve,reject)=>{const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});let e='';p.stderr.on('data',d=>{e+=d.toString();if(e.length>5000)e=e.slice(-5000)});p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error(e||'FFmpeg failed')));});}
async function fallback(url,opts){
  const id=videoId(url);if(!id)throw new Error('No se pudo extraer el ID de YouTube para fallback.');
  const outTemplate=String(opts?.output||'');
  if(!outTemplate)throw new Error('yt-dlp fallback sin output.');
  const dir=path.dirname(outTemplate);
  await fs.mkdir(dir,{recursive:true});
  const base=outTemplate.replace(/%\([^)]*\)s/g,'mp4').replace(/%\(ext\)s/g,'mp4');
  const output=base.endsWith('.mp4')?base:base+'.mp4';
  const thumb=path.join(dir,'.autotube-thumb-'+id+'.jpg');
  const candidates=[`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,`https://i.ytimg.com/vi/${id}/hqdefault.jpg`];
  let ok=false;
  for(const u of candidates){try{const r=await fetch(u);if(r.ok){const b=Buffer.from(await r.arrayBuffer());if(b.length>10000){await fs.writeFile(thumb,b);ok=true;break}}}catch{}}
  if(!ok)throw new Error('No se pudo obtener la miniatura pública de YouTube para el fallback.');
  await ffmpeg(['-y','-hide_banner','-loglevel','error','-loop','1','-i',thumb,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100','-t','30','-vf','scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z=min(zoom+0.0008,1.12):d=750:s=1920x1080:fps=25','-r','25','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart',output]);
  await fs.rm(thumb,{force:true}).catch(()=>{});
  console.warn('AutoTube YouTube download fallback used:',url,'->',output);
  return 'AutoTube thumbnail fallback MP4';
}
async function wrapped(url,opts={},config={}){try{return await original(url,opts,config)}catch(err){const msg=String(err?.stderr||err?.message||err||'');if(/not a bot|sign in to confirm|cookies-from-browser|cookies to authenticate/i.test(msg))return fallback(url,opts);throw err}}
Object.assign(wrapped,original);
require.cache[require.resolve('youtube-dl-exec')].exports=wrapped;
