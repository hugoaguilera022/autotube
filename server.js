  return{width,height,fps,audioCodec,durationSeconds};
}


async function generateGeminiOriginalImage(prompt,dir,options={}) {
  const key=String(process.env['GEM'+'INI_'+'API_'+'KEY']||'').trim();
  if(!key){
    const promptText=encodeURIComponent(String(prompt||'').replace(/\\s+/g,' ').trim().slice(0,1800));
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
      return{outputPath,bytes:stat.size,provider:'Pollinations AI image fallback',model:'flux',status:'complete'};
    }finally{clearTimeout(timer)}
  }
  const model=String(options.model||'gemini-2.5-flash-image').trim();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),45000);
  try{
    const body={
      contents:[{parts:[{text:String(prompt||'').trim()}]}],
      generationConfig:{
        responseModalities:['IMAGE'],
        responseFormat:{image:{aspectRatio:'16:9'}}
      }
    };
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-goog-api-key':key},
      body:JSON.stringify(body),
      signal:controller.signal
    });
    const raw=await response.text();
    let data=null;try{data=raw?JSON.parse(raw):null}catch{}
    if(!response.ok)throw new Error('Gemini image generation '+response.status+': '+(data?.error?.message||raw.slice(0,500)));
    const parts=data?.candidates?.[0]?.content?.parts||[];
    const imagePart=parts.find(p=>p?.inlineData?.data||p?.inline_data?.data);
    const b64=String(imagePart?.inlineData?.data||imagePart?.inline_data?.data||'').trim();
    if(!b64)throw new Error('Gemini image generation no devolvió datos de imagen.');
    const mime=String(imagePart?.inlineData?.mimeType||imagePart?.inline_data?.mime_type||'image/png').trim();
    const ext=/jpe?g/i.test(mime)?'jpg':'png';
    const outputPath=path.join(dir,'gemini-original-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.'+ext);
    await fs.writeFile(outputPath,Buffer.from(b64,'base64'));
    const stat=await fs.stat(outputPath);
    if(!stat.size)throw new Error('Gemini devolvió una imagen vacía.');
    if(typeof global.gc==='function')global.gc();
    return{outputPath,bytes:stat.size,provider:'Google Gemini image generation',model,status:'complete'};