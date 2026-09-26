module.exports = { buildBriefFallback({topic, customScript='', duration='8', language='es', title=''}) {
  const count=Math.max(4,Math.min(12,Math.round(Number(duration||8)/2)));
  const total=Math.max(30,Math.round(Number(duration||8)*60));
  const per=Math.max(2,Math.round(total/count));
  const lines=String(customScript||'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const scenes=Array.from({length:count},(_,i)=>({
    number:i+1,
    title:i===0?(title||topic):'Desarrollo · '+topic+' · '+(i+1),
    narration:lines[i]||('Contenido original sobre '+topic+'.'),
    visualPrompt:'Visual original relacionado directamente con '+topic+', composición cinematográfica, movimiento natural, 16:9.',
    searchQuery:topic,
    duration:per,
    transition:'Fundido suave',
    mediaType:'video',
    constantImage:false,
    animationNotes:'Movimiento cinematográfico sutil y coherente.'
  }));
  return {demo:true,fallback:true,title:title||topic,topic,brief:topic,customScript,language,duration:String(duration||8),scenes,sceneCount:scenes.length,musicMood:'Original',voiceStyle:'Natural y cercana'};
}};