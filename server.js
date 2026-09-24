        visualPrompt: 'Cinematic realistic footage related to ' + topic + ', scene ' + (i + 1) + ', natural lighting, 16:9',
        duration: Math.round((Number(duration) * 60) / sceneCount),
        transition: 'Fundido suave'
      }));
      return res.json({ demo: true, title: title || 'Vídeo sobre ' + topic, scenes, musicMood: 'Ambient relajante', voiceStyle: 'Natural y cercana' });
    }

    const content = await callGemini({system:'Eres director de producción de YouTube. Devuelve JSON válido con title, musicMood, voiceStyle y scenes. Cada escena debe tener number, title, narration, visualPrompt, searchQuery, duration y transition. Crea contenido original.',user:JSON.stringify({topic,language,duration,title,outline,visualIdeas,visualReferenceAnalysis,sceneCount}),temperature:0.75,maxOutputTokens:2600,json:true});
    res.json(parseJsonResponse(content));
  } catch (err) {
    console.error('Production plan error:', err);
    const fallbackCount = Math.max(4, Math.min(12, Math.round(Number(req.body?.duration || 8) / 2)));
    const fallbackTopic = req.body?.topic || 'el tema del vídeo';
    const fallbackScenes = Array.from({ length: fallbackCount }, (_, i) => ({
      number: i + 1,
      title: i === 0 ? 'Introducción' : 'Desarrollo · escena ' + (i + 1),
      narration: i === 0
        ? 'Presentación del tema y promesa principal del vídeo.'
        : 'Desarrollo del contenido con una explicación clara y visual.',
      visualPrompt: 'Realistic cinematic footage about ' + fallbackTopic + ', scene ' + (i + 1) + ', natural light, detailed, 16:9, original composition',
      duration: Math.round((Number(req.body?.duration || 8) * 60) / fallbackCount),
      transition: 'Fundido suave'
    }));
    res.json({
      demo: true,
      fallback: true,
      title: req.body?.title || 'Vídeo sobre ' + fallbackTopic,
      musicMood: 'Ambient cinematográfico',
      voiceStyle: 'Natural y cercana',
      scenes: fallbackScenes,
      warning: 'La API de IA no respondió. Se ha creado un plan local para que puedas continuar.'
    });
  }
});


async function generateFreeAmbientMusic({ durationSeconds = 180, mood = 'ambient cinematográfico relajante' } = {}) {
  const seconds = Math.max(3, Math.min(300, Number(durationSeconds) || 180));
  const output = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'autotube-music-')), 'ambient.wav');
  const safeMood = String(mood || '').slice(0, 120);
  try {
    // Música procedural generada localmente con FFmpeg: no requiere API externa ni licencia musical.
    // Usa drones suaves, capas armónicas, modulación lenta y fade in/out para acompañar narración.
    const filter = [
      'sine=f=110:d=' + seconds + ',volume=0.075,tremolo=f=0.12:d=0.35[a]',
      'sine=f=164.81:d=' + seconds + ',volume=0.045,tremolo=f=0.11:d=0.30[b]',
      'sine=f=220:d=' + seconds + ',volume=0.028,tremolo=f=0.10:d=0.25[c]',
      'sine=f=55:d=' + seconds + ',volume=0.018,tremolo=f=0.10:d=0.20[d]',
      '[a][b][c][d]amix=inputs=4:duration=longest:normalize=0,lowpass=f=1200,afade=t=in:st=0:d=4,afade=t=out:st=' + Math.max(0, seconds - 6) + ':d=6,volume=0.8[aout]'
    ].join(';');
    await runFfmpeg([
      '-y',
      '-filter_complex', filter,
      '-map', '[aout]',
      '-ar', '44100',
      '-ac', '2',
      '-c:a', 'pcm_s16le',
      output
    ]);
    return Buffer.from(await fs.readFile(output));
  } finally {
    await fs.rm(path.dirname(output), { recursive: true, force: true }).catch(() => {});
  }
}

function normalizeSearchQuery(value){
  return String(value||'').replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,100);
}
function pickPexelsFile(video){
  const files=(video?.video_files||[]).filter(x=>x?.link);
  return files.sort((a,b)=>((b.width||0)*(b.height||0))-((a.width||0)*(a.height||0)))[0]?.link||'';
}
async function searchPexels(query){
  if(!process.env.PEXELS_API_KEY)return [];
  const url='https://api.pexels.com/v1/videos/search?'+new URLSearchParams({query,orientation:'landscape',size:'medium',locale:'es-ES',per_page:'8'}).toString();
  const r=await fetch(url,{headers:{Authorization:process.env.PEXELS_API_KEY}});
  if(!r.ok)throw new Error('Pexels API '+r.status);
  const d=await r.json();
  return (d.videos||[]).map(v=>({provider:'Pexels',id:v.id,title:'Vídeo Pexels',duration:v.duration,thumbnail:v.image,url:v.url,downloadUrl:pickPexelsFile(v)})).filter(x=>x.downloadUrl);
}
async function searchPixabay(query){
  if(!process.env.PIXABAY_API_KEY)return [];
  const url='https://pixabay.com/api/videos/?'+new URLSearchParams({key:process.env.PIXABAY_API_KEY,q:query,lang:'es',video_type:'film',safesearch:'true',order:'popular',per_page:'8'}).toString();
  const r=await fetch(url);
  if(!r.ok)throw new Error('Pixabay API '+r.status);
  const d=await r.json();
  return (d.hits||[]).map(v=>({provider:'Pixabay',id:v.id,title:'Vídeo Pixabay',duration:v.duration,thumbnail:v.videos?.medium?.thumbnail||v.videos?.small?.thumbnail||'',url:v.pageURL,downloadUrl:v.videos?.medium?.url||v.videos?.small?.url||''})).filter(x=>x.downloadUrl);
}
app.post('/api/media/search',async(req,res)=>{
  try{
    const scenes=Array.isArray(req.body?.scenes)?req.body.scenes:[];
    if(!scenes.length)return res.status(400).json({error:'No hay escenas para buscar.'});
    const results=[];
    for(const scene of scenes.slice(0,12)){
      const query=normalizeSearchQuery(scene.searchQuery||scene.visualPrompt||scene.title||'nature');
      const [pexels,pixabay]=await Promise.allSettled([searchPexels(query),searchPixabay(query)]);
      const media=[
        ...(pexels.status==='fulfilled'?pexels.value:[]),
        ...(pixabay.status==='fulfilled'?pixabay.value:[])
      ];
      results.push({number:scene.number,title:scene.title,query,media,errors:{
        pexels:pexels.status==='rejected'?pexels.reason.message:null,
        pixabay:pixabay.status==='rejected'?pixabay.reason.message:null
      }});
    }
    res.json({ok:true,results,credits:{pexels:'Vídeos proporcionados por Pexels',pixabay:'Vídeos proporcionados por Pixabay'}});
  }catch(err){console.error('Media search error:',err);res.status(502).json({error:err.message||'No se pudieron buscar visuales.'});}
});

async function downloadToFile(url,file){
  const r=await fetch(url);
  if(!r.ok)throw new Error('No se pudo descargar el recurso ('+r.status+').');
  const buf=Buffer.from(await r.arrayBuffer());
  await fs.writeFile(file,buf);
}
function runFfmpeg(args){
  return new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});
    let err='';p.stderr.on('data',d=>{err+=d.toString();if(err.length>12000)err=err.slice(-12000)});
    p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('FFmpeg '+code+': '+err.slice(-2500))));
  });
}
async function renderAutotubeVideo({scenes,mediaResults,narrationBuffers=[],musicBuffer=null}){
  if(!ffmpegPath)throw new Error('FFmpeg no está disponible.');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-'));
  try{
    const clips=[],voiceFiles=[];
    for(let i=0;i<scenes.length;i++){
      const scene=scenes[i],found=mediaResults.find(x=>String(x.number)===String(scene.number))||mediaResults[i],asset=found?.media?.find(x=>x.downloadUrl)?.downloadUrl;
      if(!asset)continue;
      const input=path.join(dir,'in-'+i+'.mp4'),output=path.join(dir,'scene-'+i+'.mp4');
      await downloadToFile(asset,input);
      const duration=Math.max(2,Math.min(120,Number(scene.duration)||8));
      await runFfmpeg(['-y','-stream_loop','-1','-i',input,'-t',String(duration),'-vf',"scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p,fps=30",'-an','-c:v','libx264','-preset','veryfast','-crf','23','-movflags','+faststart',output]);
      clips.push(output);
      if(narrationBuffers[i]){const vf=path.join(dir,'voice-'+i+'.mp3');await fs.writeFile(vf,narrationBuffers[i]);voiceFiles.push({file:vf,delay:scenes.slice(0,i).reduce((n,x)=>n+(Number(x.duration)||8),0)});}
    }
    if(!clips.length)throw new Error('No hay clips de vídeo disponibles para las escenas.');
    const list=path.join(dir,'concat.txt');
    await fs.writeFile(list,clips.map(f=>"file '"+f.replace(/'/g,"'\\''")+"'").join('\n'));
    // Re-encode al unir los clips para evitar incompatibilidades de timestamps/codec
    // entre vídeos descargados de Pexels/Pixabay.
    const out=path.join(dir,'autotube-final.mp4');
    await runFfmpeg([
      '-y',
      '-f','concat','-safe','0',
      '-i',list,
      '-an',
      '-c:v','libx264',
      '-preset','veryfast',
      '-crf','23',
      '-pix_fmt','yuv420p',
      '-movflags','+faststart',
      out
    ]);
    // Importante: esta primera fase NO genera ni música ni narración.
    return {buffer:await fs.readFile(out),duration:clips.length};
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
app.post('/api/render',async(req,res)=>{
  try{
    const scenes=Array.isArray(req.body?.scenes)?req.body.scenes:[];
    const mediaResults=Array.isArray(req.body?.mediaResults)?req.body.mediaResults:[];
    if(!scenes.length||!mediaResults.length)return res.status(400).json({error:'Genera las escenas y busca los visuales antes de renderizar.'});

    const jobId='render_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex');
    const outputPath=path.join(renderJobDir,jobId+'.mp4');
    renderJobs.set(jobId,{status:'processing',progress:0,createdAt:Date.now(),outputPath,error:null});

    // El render se ejecuta en segundo plano para evitar que Render cierre la petición
    // por timeout mientras FFmpeg procesa vídeos largos.
    res.status(202).json({ok:true,jobId,status:'processing'});

    (async()=>{
      const job=renderJobs.get(jobId);
      try{
        // No generamos audio en esta primera fase: el objetivo es obtener el MP4 de vídeo.
        // La música/narración se procesarán en una fase posterior.
        if(job) job.progress=25;
        const result=await renderAutotubeVideo({scenes,mediaResults,narrationBuffers:[]});
        await fs.writeFile(outputPath,result.buffer);
        if(job){ job.status='done'; job.progress=100; job.size=result.buffer.length; job.finishedAt=Date.now(); }
        console.log('Render completed:',jobId,'size=',result.buffer.length);
      }catch(err){
        console.error('Render error:',jobId,err);
        if(job){ job.status='error'; job.progress=0; job.error=err.message||'No se pudo renderizar el vídeo.'; }
        await fs.rm(outputPath,{force:true}).catch(()=>{});
      }
    })();
  }catch(err){
    console.error('Render start error:',err);
    res.status(502).json({error:err.message||'No se pudo iniciar el render.'});
  }
});

app.get('/api/render/:jobId',async(req,res)=>{
  const job=renderJobs.get(String(req.params.jobId||''));
  if(!job)return res.status(404).json({error:'Render no encontrado o ya ha expirado.'});
  if(job.status==='processing')return res.json({ok:true,status:'processing',progress:job.progress||0});
  if(job.status==='error')return res.status(502).json({ok:false,status:'error',error:job.error});
  try{
    const stat=await fs.stat(job.outputPath);
    res.json({ok:true,status:'done',progress:100,size:stat.size,downloadUrl:'/api/render/'+encodeURIComponent(req.params.jobId)+'/download'});
  }catch{
    renderJobs.delete(req.params.jobId);
    return res.status(404).json({error:'El vídeo renderizado ya no está disponible.'});
  }
});

app.get('/api/render/:jobId/download',async(req,res)=>{
  const job=renderJobs.get(String(req.params.jobId||''));
  if(!job)return res.status(404).json({error:'Render no encontrado o ya ha expirado.'});
  if(job.status!=='done')return res.status(409).json({error:'El render todavía no está listo.'});
  try{
    const stat=await fs.stat(job.outputPath);
    res.set({'Content-Type':'video/mp4','Content-Length':String(stat.size),'Content-Disposition':'attachment; filename="autotube-final.mp4"','Cache-Control':'no-store'});
    res.sendFile(job.outputPath);
  }catch{
    res.status(404).json({error:'El vídeo renderizado ya no está disponible.'});
  }
});
async function generateElevenVoice({text,voiceId,language='es'}){
  if(!process.env.ELEVENLABS_API_KEY)throw new Error('ELEVENLABS_API_KEY no está configurada.');
  const id=String(voiceId||process.env.ELEVENLABS_VOICE_ID||'JBFqnCBsd6RMkjVDRZzb').trim();
  const response=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+encodeURIComponent(id)+'?output_format=mp3_44100_128',{
    method:'POST',
    headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({text:String(text||''),model_id:'eleven_multilingual_v2',language_code:language==='es'?'es':undefined,voice_settings:{stability:0.45,similarity_boost:0.75,style:0.2,use_speaker_boost:true}})
  });
  if(!response.ok){const detail=await response.text();throw new Error('ElevenLabs TTS '+response.status+': '+detail.slice(0,500));}
  return Buffer.from(await response.arrayBuffer());
}
app.post('/api/ai/voice',async(req,res)=>{
  try{
    const {text='',language='es',voiceId=''}=req.body||{};
    if(!String(text).trim())return res.status(400).json({error:'No hay texto para narrar.'});
    const audio=await generateElevenVoice({text,language,voiceId});
    res.set({'Content-Type':'audio/mpeg','Content-Length':String(audio.length),'Content-Disposition':'inline; filename="autotube-voice.mp3"','Cache-Control':'no-store'});
    res.send(audio);
  }catch(err){console.error('ElevenLabs voice error:',err);res.status(502).json({error:err.message||'No se pudo generar la voz.'});}
});

app.post('/api/ai/music', async (req, res) => {
  try {
    const { mood = 'ambient cinematográfico relajante', durationSeconds = 180 } = req.body || {};
    const audio = await generateFreeAmbientMusic({ durationSeconds, mood });
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(audio.length),
      'Content-Disposition': 'inline; filename="autotube-free-music.wav"',
      'Cache-Control': 'no-store'
    });
    res.send(audio);
  } catch (err) {
    console.error('Free music generation error:', err);
    res.status(502).json({ error: err.message || 'No se pudo generar la música gratuita.' });
  }
});

app.post('/api/project', (req, res) => {
  const project = { id: `p_${Date.now()}`, createdAt: new Date().toISOString(), status: 'draft', ...req.body };
  res.json(project);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
async function verifySupabaseConnection() {
  if (!supabaseConfigured()) {
    console.log('Supabase persistence not configured.');
    return;
  }
  const { url, key } = supabaseEnv();
  try {
    await supabaseRequest('youtube_connections?select=id&limit=1', { method: 'GET' });
    console.log('Supabase connection OK:', {
      host: new URL(url).host,
      keyType: key.startsWith('sb_secret_') ? 'secret' : key.startsWith('sb_publishable_') ? 'publishable' : 'legacy/unknown'
    });
  } catch (err) {
    console.error('Supabase connection FAILED:', err.message);
    console.error('Supabase config:', {
      host: new URL(url).host,
      keyType: key.startsWith('sb_secret_') ? 'secret' : key.startsWith('sb_publishable_') ? 'publishable' : 'legacy/unknown',
      keyLength: key.length
    });
  }
}

app.listen(PORT, () => {
  console.log(`AutoTube running on port ${PORT}`);
  verifySupabaseConnection();
});