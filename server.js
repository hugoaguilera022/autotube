  const supportedResolution=(width===1280&&height===720)||(width===1920&&height===1080);
  if(!supportedResolution)throw new Error('Resolución real del MP4: '+width+'x'+height+' (se esperaba 1280x720 o 1920x1080).');
  if(!fps||Math.abs(fps-30)>0.5)throw new Error('FPS reales del MP4: '+(fps||'desconocidos')+' (se esperaban 30).');  if(audioCodec!=='aac')throw new Error('Códec de audio real del MP4: '+(audioCodec||'desconocido')+' (se esperaba AAC).');
  return{width,height,fps,audioCodec,durationSeconds};
}


async function generateGeminiOriginalImage(prompt,dir,options={}) {
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key){
    const promptText=encodeURIComponent(String(prompt||'').replace(/\s+/g,' ').trim().slice(0,1800));
    const url='https://image.pollinations.ai/prompt/'+promptText+'?width=1280&height=720&nologo=true&model=flux';
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),90000);
    try{
      const response=await fetch(url,{signal:controller.signal});
      if(!response.ok)throw new Error('Pollinations image '+response.status);
      const data=Buffer.from(await response.arrayBuffer());
      if(!data.length)throw new Error('Pollinations devolvió una imagen vacía.');
      const outputPath=path.join(dir,'ai-original-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.jpg');
      await fs.writeFile(outputPath,data);
      const stat=await fs.stat(outputPath);
      if(!stat.size)throw new Error('La imagen IA está vacía.');
      return{outputPath,bytes:stat.size,mediaType:'image',provider:'Pollinations AI · Flux',model:'flux',status:'complete'};
    }finally{clearTimeout(timer)}
  }
  const model=String(options.model||'gemini-2.5-flash-image').trim();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),45000);