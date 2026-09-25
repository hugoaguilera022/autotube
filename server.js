  }
}
const urlVideoJobs=new Map();
function parseIsoDurationSeconds(value){const m=String(value||'').match(/^PT(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+(?:\\.\\d+)?)S)?$/i);if(!m)return 0;return Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0);}

async function executeUrlToVideo(reference,jobId){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autotube-url-video-'));
  const job=urlVideoJobs.get(jobId);
  try{
    const cachedReference=[...youtubeReferenceJobs.values()]
      .filter(j=>j.status==='done'&&j.reference===reference&&j.result?.video&&j.result?.referenceStyle)
      .sort((a,b)=>Number(b.finishedAt||0)-Number(a.finishedAt||0))[0];
    const useCached=Boolean(cachedReference&&Date.now()-Number(cachedReference.finishedAt||0)<15*60*1000);
    const video=useCached?cachedReference.result.video:await getReferenceVideo(reference);
    const style=useCached?cachedReference.result.referenceStyle:await analyzeYoutubeReferenceMedia(reference,video);
    if(!style?.visualAnalysis||!style?.visualAnalysis?.structureProfile){
      throw new Error('No se pudo obtener un análisis audiovisual suficiente de la referencia. El render se detuvo antes de generar visuales.');
    }

    const referenceTitle=String(video?.title||'Contenido original').slice(0,300);
    const targetDurationSeconds=Math.max(4,parseIsoDurationSeconds(video?.duration)||Number(style?.visualAnalysis?.videoProfile?.durationSeconds)||60);
    const visualReferenceAnalysis=style?.visualAnalysis||{};
    if(job)job.progress=12;

    const outlineRes=await fetch('http://127.0.0.1:'+PORT+'/api/ai/outline',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        topic:referenceTitle,reference,referenceTopic:referenceTitle,
        referenceData:video||{title:referenceTitle},
        visualReferenceAnalysis,referenceStyle:style,
        language:'es',duration:String(Math.max(1,Math.ceil(targetDurationSeconds/60)))
      })
    });
    const outline=await outlineRes.json().catch(()=>null);
    if(!outlineRes.ok)throw new Error(outline?.error||'No se pudo generar la estructura.');

    const planRes=await fetch('http://127.0.0.1:'+PORT+'/api/ai/production-plan',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        topic:referenceTitle,reference,referenceTopic:referenceTitle,
        referenceData:video||{title:referenceTitle},
        visualReferenceAnalysis,referenceStyle:style,
        language:'es',duration:String(Math.max(1,Math.ceil(targetDurationSeconds/60))),title:outline?.title||referenceTitle,
        outline:outline?.outline||[],visualIdeas:outline?.visualIdeas||[]
      })
    });
    const plan=await planRes.json().catch(()=>null);
    if(!planRes.ok||!Array.isArray(plan?.scenes)||!plan.scenes.length)
      throw new Error(plan?.error||'Plan de producción inválido.');

    const scenes=plan.scenes.map((s,i)=>({
      ...s,number:i+1,duration:Math.max(4,Math.min(20,Number(s.duration)||8)),
      mediaType:'video',constantImage:false
    }));

    // Render a short but complete original remake on the constrained
    // Render instance. The visual generator is driven by the analyzed
    // subject/style rather than copying the source recording.
    const maxSeconds=targetDurationSeconds;
    let used=0;
    const finalScenes=[];
    for(let i=0;i<scenes.length&&used<maxSeconds;i++){
      const remaining=scenes.length-i-1;
      const room=Math.max(4,maxSeconds-used-Math.max(0,remaining*4));
      const duration=Math.max(4,Math.min(Number(scenes[i].duration)||8,room));
      finalScenes.push({...scenes[i],duration});
      used+=duration;
      if(finalScenes.length>=12)break;
    }
    if(job)job.progress=30;

    const referenceAudio=style?.visualAnalysis?.audioProfile||{};
    const wantsVoice=Boolean(referenceAudio.hasSpeech);
    const wantsMusic=Boolean(referenceAudio.hasMusic);
    const narrationAudio=[];
    let musicBuffer=null;

    // Audio is generated only when the reference actually contains that layer.
    // Voice-only references never receive an invented music bed; music-only
    // references never receive invented narration; mixed references receive both.
    if(wantsVoice){
      for(let i=0;i<finalScenes.length;i++){
        let narration=String(finalScenes[i]?.narration||'').trim();
        if(!narration){
          const script=await callGemini({
            system:'Eres guionista de YouTube. Escribe una narración ORIGINAL, factual y directamente relacionada con el tema de la referencia. No copies frases del vídeo de referencia.',
            user:JSON.stringify({
              topic:referenceTitle,
              scene:finalScenes[i]?.title||'',
              visualPrompt:finalScenes[i]?.visualPrompt||'',
              durationSeconds:finalScenes[i]?.duration||8,
              language:'es',
              audioProfile:referenceAudio
            }),
            temperature:0.5,maxOutputTokens:350,json:false
          });
          narration=String(script||'').trim();
        }
        if(!narration)throw new Error('La referencia contiene voz, pero no se pudo crear la narración original de la escena '+String(finalScenes[i].number)+'.');
        narrationAudio[i]=await generateNarrationTts(
          narration,
          String(referenceAudio.language||'es'),
          String(referenceAudio.voiceStyle||'Natural y cercana'),
          referenceAudio
        );
      }
    }

    if(wantsMusic){
      const totalDuration=finalScenes.reduce((n,s)=>n+Math.max(4,Math.min(20,Number(s.duration)||8)),0);
      musicBuffer=await generateMusicBuffer({
        topic:referenceTitle,
        mood:String(referenceAudio.musicMood||'original instrumental'),