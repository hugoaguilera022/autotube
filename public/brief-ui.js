(() => {
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  async function api(url,options={},label='solicitud'){
    const r=await fetch(url,options); const raw=await r.text(); let d=null; try{d=raw?JSON.parse(raw):null}catch{}
    if(!r.ok)throw new Error(d?.error||'Error del servidor ('+r.status+') en '+label+'.'); return d;
  }
  async function analyze(file){
    if(!file)return null; const form=new FormData(); form.append('video',file);
    const d=await api('/api/reference/visual-analysis',{method:'POST',body:form},'análisis MP4'); return d?.analysis||null;
  }
  function inject(){
    const create=document.querySelector('#create'); if(!create||document.querySelector('#briefCreator'))return;
    const anchor=create.querySelector('.section-head'); const box=document.createElement('div'); box.id='briefCreator'; box.className='card'; box.style.cssText='margin:0 0 16px 0';
    box.innerHTML='<div class="card-head"><span>CREACIÓN DIRECTA · SIN YOUTUBE</span><span>IA CREATIVA</span></div>'+
      '<div class="grid2"><div><label>¿De qué quieres que vaya el vídeo?<textarea id="briefTopic" rows="4" placeholder="Tema, historia, objetivo, audiencia o idea. La IA decidirá el lenguaje audiovisual que mejor encaje."></textarea></label>'+
      '<label>Referencias visuales <span class="optional">opcional</span><textarea id="visualReferences" rows="3" placeholder="Puedes describir una estética, color, personaje, época o sensación. La IA lo incorporará sin copiar material."></textarea></label></div>'+
      '<div><label>Guion propio <span class="optional">opcional</span><textarea id="scriptInput" rows="7" placeholder="Déjalo vacío para que AutoTube escriba un guion nuevo con IA."></textarea></label>'+
      '<label>Muestra MP4 <span class="optional">opcional</span><input id="sampleMp4" type="file" accept="video/mp4,video/webm,video/quicktime"><small class="muted">Solo si quieres que la IA estudie una referencia audiovisual que tengas.</small></label></div></div>'+
      '<button class="primary wide" id="briefGenerateBtn" type="button">✦ Analizar idea y proponer estilos con IA</button>'+
      '<div id="creativeOptionsBox" class="hidden" style="margin-top:14px"></div>';
    anchor?.after(box); document.querySelector('#briefGenerateBtn').onclick=()=>createBrief();
  }
  function renderOptions(data){
    const box=document.querySelector('#creativeOptionsBox'); if(!box)return;
    const options=Array.isArray(data?.creativeOptions)?data.creativeOptions:[];
    if(!options.length){box.classList.add('hidden');return;}
    box.classList.remove('hidden');
    box.innerHTML='<div class="card-head"><span>DIRECCIONES CREATIVAS PROPUESTAS POR LA IA</span><span>Elige una</span></div>'+
      '<p class="muted" style="margin:6px 0 12px">No hay una lista fija: las opciones se han creado específicamente para tu idea.</p>'+
      '<div class="grid2">'+options.map((o,i)=>{
        const recommended=String(o.id)===String(data.recommendedOptionId);
        return '<button type="button" class="card creative-option" data-creative-id="'+esc(o.id)+'" style="text-align:left;cursor:pointer;border:1px solid '+(recommended?'var(--accent,#8b7cff)':'#252a33')+';background:'+(recommended?'rgba(139,124,255,.08)':'transparent')+'">'+
          '<div class="card-head"><b>'+esc(o.name||('Dirección '+(i+1)))+'</b><span>'+(recommended?'RECOMENDADA':'OPCIÓN '+(i+1))+'</span></div>'+
          '<p>'+esc(o.concept||'')+'</p>'+
          '<div class="muted"><b>Visual:</b> '+esc(o.visualStyle||'')+' · <b>Animación:</b> '+esc(o.animationStyle||'')+' · <b>Cámara:</b> '+esc(o.cameraLanguage||'')+'</div>'+
          '<div class="muted"><b>Color:</b> '+esc(o.palette||'')+' · <b>Luz:</b> '+esc(o.lighting||'')+' · <b>Movimiento:</b> '+esc(o.motion||'')+'</div>'+
          '<div class="muted"><b>Voz:</b> '+esc(o.voice||'')+' · <b>Música:</b> '+esc(o.music||'')+' · <b>Formato:</b> '+esc(o.aspectRatio||'')+'</div>'+
          '<small class="muted">'+esc(o.why||'')+'</small></button>';
      }).join('')+'</div>';
    box.querySelectorAll('[data-creative-id]').forEach(btn=>btn.onclick=async()=>{
      const selected=options.find(o=>String(o.id)===String(btn.dataset.creativeId)); if(!selected)return;
      await createBrief(selected);
    });
  }
  async function createBrief(selectedDirection=null){
    const brief=String(document.querySelector('#briefTopic')?.value||'').trim();
    const script=String(document.querySelector('#scriptInput')?.value||'').trim();
    const visual=String(document.querySelector('#visualReferences')?.value||'').trim();
    const sample=document.querySelector('#sampleMp4')?.files?.[0]||null;
    if(!brief&&!script){alert('Describe de qué quieres que vaya el vídeo o pega un guion.');return;}
    const btn=document.querySelector('#briefGenerateBtn'), state=document.querySelector('#generationState'), preview=document.querySelector('#preview');
    btn.disabled=true; btn.textContent=selectedDirection?'Aplicando dirección IA…':'Analizando y proponiendo estilos…';
    if(state)state.textContent=selectedDirection?'Aplicando dirección creativa…':'La IA está estudiando tu idea…';
    try{
      let visualAnalysis=null;
      if(sample&&!selectedDirection){if(state)state.textContent='Analizando muestra MP4…';visualAnalysis=await analyze(sample);}
      const duration=document.querySelector('#duration')?.value||'8';
      const language=document.querySelector('#language')?.value||'es';
      const title=brief.slice(0,90);
      const d=await api('/api/ai/production-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        topic:brief||'Tema del guion',brief,script,language,duration,title,
        outline:script?[script]:[],visualIdeas:visual?[visual]:[],
        visualReferenceAnalysis:visualAnalysis,referenceStyle:visualAnalysis?{visualAnalysis}:null,
        referenceTopic:brief,referenceData:null,reference:'',creationMode:'brief',
        creativeDirection:selectedDirection||null
      })},'generación de estructura');
      window.currentVideoPlan={...(window.currentVideoPlan||{}),...d,topic:brief||d.topic||'Tema del guion',brief,visualReferences:visual,customScript:script,creationMode:'brief'};
      renderOptions(d);
      if(!selectedDirection){
        if(state)state.textContent='Direcciones creativas listas para elegir';
        if(preview)preview.innerHTML='<div class="empty"><div class="empty-icon">✦</div><b>La IA ya ha diseñado las opciones</b><p>Elige una dirección creativa arriba. AutoTube generará las escenas adaptadas a ella.</p></div>';
      }else{
        if(typeof openProduction==='function')openProduction(window.currentVideoPlan);
        if(state)state.textContent='Dirección aplicada';
        if(preview)preview.innerHTML='<div class="empty"><div class="empty-icon">✓</div><b>Plan listo</b><p>'+esc(d.sceneCount||d.scenes?.length||0)+' escenas · '+esc(d.aspectRatio||'16:9')+' · '+esc(d.creativeDirection?.name||'Dirección IA')+'</p></div>';
      }
    }catch(e){
      if(state)state.textContent='Error';
      if(preview)preview.innerHTML='<div class="empty"><div class="empty-icon">!</div><b>No se pudo crear</b><p>'+esc(e.message)+'</p></div>';
    }finally{btn.disabled=false;btn.textContent='✦ Analizar idea y proponer estilos con IA';}
  }
  window.addEventListener('DOMContentLoaded',inject); window.addEventListener('load',inject);
})();