const fs=require('fs');
const path=require('path');
const file=path.join(process.cwd(),'server.js');
try{
  let s=fs.readFileSync(file,'utf8');
  const marker="    let style;\n    if(options.forceAi){\n      const direct=await geminiYoutubeUrlAnalysis(reference);";
  const start=s.indexOf(marker);
  const end=start>=0?s.indexOf("\n    let scenes;",start):-1;
  if(start>=0&&end>start){
    const block=`    let style;
    if(options.forceAi){
      try{
        style=await analyzeYoutubeReferenceMedia(reference,video,{skipFullDownload:false});
        console.log('AUTOTUBE FORCE-AI REFERENCE ANALYSIS READY',JSON.stringify({jobId,source:style?.analysisSource||style?.visualSource||'unknown',fullVideo:Boolean(style?.hasFullVideoAnalysis),audio:Boolean(style?.hasAudioAnalysis),scenes:Number(style?.preferredSceneCount||style?.estimatedSceneCount||1)}));
      }catch(err){
        console.warn('AUTOTUBE FORCE-AI REFERENCE ANALYSIS FALLBACK',err?.message||String(err));
        style={
          visualAnalysis:{
            videoProfile:{durationSeconds:Number(video?.durationSeconds||60)||60,estimatedSceneCount:6,sceneChangeRate:'unknown',cameraMovement:'subtle cinematic movement',composition:'16:9 horizontal',palette:'derived from public thumbnail',lighting:'derived from public thumbnail',visualStyle:'original cinematic treatment based on public reference thumbnail',continuity:'coherent'},
            animationProfile:{cameraMotion:'subtle cinematic movement',motionIntensity:'medium',visualRhythm:'steady',transitionStyle:'smooth'},
            audioProfile:{hasSpeech:null,hasMusic:null,hasAmbience:null,hasSoundEffects:null,musicMood:'original cinematic',energy:'medium',dynamics:'medium',instrumentation:'original',audioContinuity:'continuous'},
            structureProfile:{sceneSegments:[],segmentCount:6,pacing:'steady',narrativeStructure:'original'},
            generationDirectives:{preferredSceneCount:6,preserveVisualContinuity:true,preserveAudioContinuity:true}
          },
          visualSource:'public-thumbnail-fallback',
          analysisSource:'deterministic-fallback',
          hasFullVideoAnalysis:false,hasAudioAnalysis:false,hasAnimationAnalysis:true,hasStructureAnalysis:true,
          preferredSceneCount:6,estimatedSceneCount:6
        };
      }
    }`;
    fs.writeFileSync(file,s.slice(0,start)+block+s.slice(end));
    console.log('AUTOTUBE runtime force-AI fallback patch applied');
  }
}catch(err){console.error('AUTOTUBE runtime patch failed',err?.message||String(err));}
