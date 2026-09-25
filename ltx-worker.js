const { Client } = require('@gradio/client');
const fs = require('fs/promises');
const path = require('path');

async function main(){
  const input=JSON.parse(process.argv[2]||'{}');
  const dir=input.dir;
  const space=String(input.space||'Lightricks/ltx-video-distilled').trim();
  const duration=Math.max(0.3,Math.min(8.5,Number(input.durationSeconds)||3));
  const width=Math.max(256,Math.min(1280,Math.round((Number(input.width)||256)/32)*32));
  const height=Math.max(256,Math.min(1280,Math.round((Number(input.height)||256)/32)*32));
  const app=await Client.connect(space);
  const result=await app.predict('/text_to_video',{
    prompt:String(input.prompt||'').trim(),
    negative_prompt:String(input.negativePrompt||'worst quality, inconsistent motion, blurry, jittery, distorted, text, logos').trim(),
    image_n:null, video_n:null, height, width, mode:'text-to-video', duration,
    frames_to_use:9, seed:Math.floor(Math.random()*4294967295), randomize_seed:true,
    guidance_scale:Number(input.guidanceScale||3), improve_texture:Boolean(input.improveTexture??false)
  });
  const data=Array.isArray(result?.data)?result.data:[];
  const output=data[0];
  const url=typeof output==='string'?output:(output?.url||output?.path||output?.video?.url||'');
  if(!url)throw new Error('LTX/ZeroGPU terminó la generación pero no devolvió el vídeo.');
  const response=await fetch(String(url));
  if(!response.ok)throw new Error('LTX/ZeroGPU no pudo descargar el vídeo generado ('+response.status+').');
  const outputPath=path.join(dir,'ltx-generated.mp4');
  await fs.writeFile(outputPath,Buffer.from(await response.arrayBuffer()));
  const stat=await fs.stat(outputPath);
  if(!stat.size)throw new Error('LTX/ZeroGPU devolvió un vídeo vacío.');
  process.stdout.write(JSON.stringify({ok:true,outputPath,bytes:stat.size,durationSeconds:duration,provider:'Hugging Face ZeroGPU · LTX Video',model:'LTX Video 0.9.8 distilled',status:'complete'}));
}
main().catch(err=>{process.stderr.write(String(err?.stack||err));process.exit(1);});