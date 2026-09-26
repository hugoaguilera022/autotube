  const space=String(process.env.LTX_SPACE||'Lightricks/ltx-video-distilled').trim();
  const duration=Math.max(0.3,Math.min(8.5,Number(options.durationSeconds)||5));
  const width=Math.max(256,Math.min(1280,Math.round((Number(options.width)||704)/32)*32));
  const height=Math.max(256,Math.min(1280,Math.round((Number(options.height)||512)/32)*32));
  const negativePrompt=String(options.negativePrompt||'worst quality, inconsistent motion, blurry, jittery, distorted, text, logos').trim();
  const app=await Client.connect(space);
  const seed=Math.floor(Math.random()*4294967295);
  // Current LTX Space exposes text_to_video as positional Gradio inputs.
  // Keep this isolated to the optional AI-visual path.
  const result=await app.predict('/text_to_video',[
    String(prompt||'').trim(), negativePrompt, null, null,
    height, width, 'text-to-video', duration, 9, seed, true,
    Number(options.guidanceScale||3), Boolean(options.improveTexture??false)
  ]);
  const data=Array.isArray(result?.data)?result.data:[];
  const output=data[0];
  const url=typeof output==='string'?output:(output?.url||output?.path||output?.video?.url||'');
  if(!url)throw new Error('LTX/ZeroGPU terminó la generación pero no devolvió el vídeo.');
  const response=await fetch(String(url));
  if(!response.ok)throw new Error('LTX/ZeroGPU no pudo descargar el vídeo generado ('+response.status+').');
  const outputPath=path.join(dir,'ltx-generated-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.mp4');
  await fs.writeFile(outputPath,Buffer.from(await response.arrayBuffer()));
  const stat=await fs.stat(outputPath);
  if(!stat.size)throw new Error('LTX/ZeroGPU devolvió un vídeo vacío.');
  return{outputPath,bytes:stat.size,provider:'Hugging Face ZeroGPU · LTX Video',model:'LTX Video 0.9.8 distilled',durationSeconds:duration,status:'complete'};
}

async function validateGeneratedVideoClip(file){
  const result=await new Promise((resolve,reject)=>{