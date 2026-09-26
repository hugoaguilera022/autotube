(() => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  async function api(url,options={},label='solicitud'){
    const r=await fetch(url,options); const raw=await r.text(); let d=null;
    try{d=raw?JSON.parse(raw):null}catch{}
    if(!r.ok)throw new Error(d?.error||'Error del servidor ('+r.status+') en '+label+'.');
    return d;
  }
  async function analyze(file){
    if(!file)return null;
    const form=new FormData(); form.append('video',file);
    const d=await api('/api/reference/visual-analysis',{method:'POST',body:form},'análisis MP4');
    return d?.analysis||null;
  }
  function inject(){
    const create=document.querySelector('#create'); if(!create||document.querySelector('#briefCreator'))return;
    const anchor=create.querySelector('.section-head');
    const box=document.createElement('div'); box.id='briefCreator'; box.className='card';
    box.style.cssText='margin:0 0 16px 0';
    box.innerHTML='<div class="card-head"><span>CREACIÓN DIRECTA · SIN YOUTUBE</span><span>Nuevo</span></div>'+
      '<div class="grid2">'+
      '<div><label>¿De qué quieres que vaya el vídeo?<textarea id="briefTopic" rows="4" placeholder="Describe el tema, formato, tono y objetivo del vídeo."></textarea></label>'+
      '<label>Referencias visuales <span class="optional">opcional</span><textarea id="visualReferences" rows="3" placeholder="Colores, iluminación, animación, cámara, ritmo, composición o enlaces de referencia."></textarea></label></div>'+
      '<div><label>Guion propio <span class="optional">opcional</span><textarea id="scriptInput" rows="7" placeholder="Déjalo vacío para que AutoTube escriba SIEMPRE un guion nuevo con IA. Si aportas uno, se utilizará este guion."></textarea></label>'+
      '<label>Muestra MP4 <span class="optional">opcional</span><input id="sampleMp4" type="file" accept="video/mp4,video/webm,video/quicktime"><small class="muted">Se analiza como referencia audiovisual; el guion y la narración se crean de nuevo salvo que aportes tu propio guion.</small></label></div></div>'+
      '<button class="primary wide" id="briefGenerateBtn" type="button">✦ Crear vídeo desde mi idea</button>'+
      '<small class="muted">Sin guion propio → guion nuevo generado por IA. Con guion propio → se utiliza tu texto.</small>';
    anchor?.after(box);
    document.querySelector('#briefGenerateBtn').onclick=createBrief;
  }
  async function createBrief(){
    const brief=String(document.querySelector('#briefTopic')?.value||'').trim();
    const script=String(document.querySelector('#scriptInput')?.value||'').trim();
    const visual=String(document.querySelector('#visualReferences')?.value||'').trim();
    const sample=document.querySelector('#sampleMp4')?.files?.[0]||null;
    if(!brief&&!script){alert('Describe de qué quieres que vaya el vídeo o pega un guion.');return;}
    const btn=document.querySelector('#briefGenerateBtn'), state=document.querySelector('#generationState'), preview=document.querySelector('#preview');
    btn.disabled=true; btn.textContent='Preparando…'; if(state)state.textContent='Preparando referencias…';
    try{
      let visualAnalysis=null;
      if(sample){ if(state)state.textContent='Analizando muestra MP4…'; visualAnalysis=await analyze(sample); }
      if(state)state.textContent='Generando estructura con IA…';
      const duration=document.querySelector('#duration')?.value||'8';
      const language=document.querySelector('#language')?.value||'es';
      const title=brief.slice(0,90);
      const outline=script?[script]:[];
      const visualIdeas=visual?[visual]:[];
      const d=await api('/api/ai/production-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        topic:brief||'Tema del guion', brief, language, duration, title, outline, visualIdeas,
        visualReferenceAnalysis:visualAnalysis, referenceStyle:visualAnalysis?{visualAnalysis}:null,
        referenceTopic:brief, referenceData:null, reference:'', creationMode:'brief'
      })},'generación de estructura');
      window.currentVideoPlan=window.currentVideoPlan||{};
      currentVideoPlan={...currentVideoPlan,...d,topic:brief||d.topic||'Tema del guion',brief,visualReferences:visual,customScript:script,creationMode:'brief'};
      if(typeof openProduction==='function')openProduction(currentVideoPlan);
      if(state)state.textContent='Estructura lista';
      if(preview)preview.innerHTML='<div class="empty"><div class="empty-icon">✓</div><b>Estructura creada</b><p>Ahora puedes generar escenas IA, voz, música y renderizar el MP4.</p></div>';
    }catch(e){
      if(state)state.textContent='Error';
      if(preview)preview.innerHTML='<div class="empty"><div class="empty-icon">!</div><b>No se pudo crear</b><p>'+esc(e.message)+'</p></div>';
    }finally{btn.disabled=false;btn.textContent='✦ Crear vídeo desde mi idea';}
  }
  window.addEventListener('DOMContentLoaded',inject);
  window.addEventListener('load',inject);
})();