const $ = (s) => document.querySelector(s);
let currentVideoPlan = null;
const views = [...document.querySelectorAll('.view')];
function go(name){views.forEach(v=>v.classList.toggle('active-view',v.id===name));document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===name));const titles={dashboard:'Tu contenido, automatizado.',create:'Crear un vídeo con IA.',production:'Producción del vídeo',projects:'Tus proyectos.',automation:'Automatiza tu canal.',connections:'Conexiones & API'};$('#pageTitle').textContent=titles[name]||'AutoTube';}
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>go(b.dataset.view));document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));
async function health(){try{const r=await fetch('/api/health');const d=await r.json();$('#serverStatus').textContent='Servidor conectado';$('#openaiBadge').textContent=d.configured.openai?'Conectado':'Revisar'}catch{$('#serverStatus').textContent='Servidor no disponible'}}health();
function connectYoutube(){
  // Navegación directa: Google OAuth se abre en la misma pestaña y Safari no puede bloquearla.
  window.location.href='/api/youtube/auth';
}
$('#youtubeBtn').onclick=connectYoutube;$('#youtubeConnect2').onclick=connectYoutube;
$('#youtubeConnected').onclick=()=>go('connections');
function updateYoutubeGlobalStatus(connected, profile={}) {
  const connectButton = $('#youtubeBtn');
  const connectedButton = $('#youtubeConnected');
  if (!connectButton || !connectedButton) return;
  if (connected) {
    connectButton.classList.add('hidden');
    connectedButton.classList.remove('hidden');
    $('#youtubeStatusTitle').textContent = profile.title || 'YouTube conectado';
    $('#youtubeStatusAvatar').src = profile.avatar || '';
  } else {
    connectButton.classList.remove('hidden');
    connectedButton.classList.add('hidden');
  }
}

async function loadYoutubeProfile(){
  try{
    const r=await fetch('/api/youtube/profile');
    const d=await r.json();
    const card=$('#youtubeProfile');
    if(!r.ok||!d.connected){card.classList.add('hidden');updateYoutubeGlobalStatus(false);return;}
    card.classList.remove('hidden');
    updateYoutubeGlobalStatus(true, d);
    $('#ytAvatar').src=d.avatar||'';
    $('#ytTitle').textContent=d.title||'Canal de YouTube';
    $('#ytHandle').textContent=d.handle?d.handle:'';
    $('#ytSubscribers').textContent=Number(d.subscribers||0).toLocaleString('es-ES');
    $('#ytVideos').textContent=Number(d.videos||0).toLocaleString('es-ES');
    $('#ytViews').textContent=Number(d.views||0).toLocaleString('es-ES');
    $('#ytChannelId').textContent=d.channelId||'—';
  }catch{ $('#youtubeProfile').classList.add('hidden'); updateYoutubeGlobalStatus(false); }
}
$('#youtubeRefresh').onclick=loadYoutubeProfile;
$('#youtubeDisconnect').onclick=async()=>{if(!confirm('¿Desconectar este canal de YouTube?'))return;await fetch('/api/youtube/disconnect',{method:'POST'});loadYoutubeProfile();};
window.addEventListener('message',e=>{if(e.data?.type==='youtube_connected'){alert('YouTube conectado correctamente.');loadYoutubeProfile();}});
loadYoutubeProfile();
async function analyzeReferenceForCreation(reference){
  const value=String(reference||'').trim();
  if(!value)return null;
  const r=await fetch('/api/youtube/reference',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:value})});
  const d=await r.json();
  if(!r.ok)throw new Error(d.error||'No se pudo analizar la referencia.');
  return d;
}

$('#generateBtn').onclick=async()=>{
const topic=$('#topic').value.trim();if(!topic)return alert('Escribe primero el tema del vídeo.');
const btn=$('#generateBtn'),state=$('#generationState'),preview=$('#preview');btn.disabled=true;btn.textContent='Generando…';state.textContent='Procesando';
preview.innerHTML='<div class="empty"><div class="empty-icon">✦</div><b>La IA está preparando la estructura…</b><p>Esto puede tardar unos segundos.</p></div>';
try{
const referenceValue=$('#reference').value.trim();
let referenceAnalysis=null;
if(referenceValue){
  state.textContent='Analizando referencia';
  preview.innerHTML='<div class="empty"><div class="empty-icon">▶</div><b>Analizando el vídeo de referencia…</b><p>AutoTube extraerá temática y características de formato para crear una propuesta original.</p></div>';
  referenceAnalysis=await analyzeReferenceForCreation(referenceValue);
}
const r=await fetch('/api/ai/outline',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic,duration:$('#duration').value,language:$('#language').value,reference:referenceValue,referenceData:referenceAnalysis?.video||null})});
const d=await r.json();if(!r.ok)throw new Error(d.error);
currentVideoPlan={...d,topic,duration:$('#duration').value,language:$('#language').value,reference:referenceValue,referenceData:referenceAnalysis?.video||null};
preview.innerHTML='<div style="text-align:left"><span class="pill">'+(d.demo?'DEMO':'IA GENERATIVA')+'</span><h3 style="font-size:21px;margin:14px 0 7px">'+escapeHtml(d.title||'Nuevo vídeo')+'</h3><p class="muted">'+escapeHtml(d.hook||d.note||'Estructura preparada.')+'</p><ol style="color:#cbd0db;line-height:1.8">'+(d.outline||[]).map(x=>'<li>'+escapeHtml(x)+'</li>').join('')+'</ol><button class="primary" id="continueProductionBtn">Continuar a producción →</button></div>';
state.textContent='Listo';$('#continueProductionBtn').onclick=()=>openProduction(d);}catch(e){state.textContent='Error';preview.innerHTML='<div class="empty"><div class="empty-icon">!</div><b>No se pudo generar</b><p>'+escapeHtml(e.message)+'</p></div>'}finally{btn.disabled=false;btn.textContent='Generar estructura con IA'}};
function openProduction(plan){currentVideoPlan={...currentVideoPlan,...plan};$('#productionTitle').textContent=plan.title||'Nuevo vídeo';$('#productionMeta').textContent=(plan.outline?.length||0)+' bloques de contenido · '+(plan.duration||$('#duration').value)+' min · '+(plan.language||$('#language').value);$('#productionState').textContent='Listo para producir';$('#scenesList').innerHTML='<div class="card empty"><div class="empty-icon">🎬</div><b>Plan preparado</b><p>Pulsa “Generar escenas con IA” para crear el montaje escena por escena.</p></div>';go('production')}
$('#backToCreate').onclick=()=>go('create');
$('#generateMusicBtn').onclick=generateMusic;
$('#findMediaBtn').onclick=loadSceneMedia;
$('#generateVoiceBtn').onclick=generateVoiceForScenes;
$('#renderVideoBtn').onclick=renderFinalVideo;
$('#buildProductionBtn').onclick=async()=>{if(!currentVideoPlan?.topic)return alert('Primero genera la estructura del vídeo.');const btn=$('#buildProductionBtn'),progress=$('#productionProgress'),bar=$('#productionProgressBar'),value=$('#productionProgressValue'),label=$('#productionProgressLabel');btn.disabled=true;btn.textContent='Generando…';progress.classList.remove('hidden');$('#productionState').textContent='Produciendo';bar.style.width='12%';value.textContent='12%';label.textContent='Analizando estructura…';try{await new Promise(r=>setTimeout(r,350));bar.style.width='35%';value.textContent='35%';label.textContent='Diseñando escenas…';const r=await fetch('/api/ai/production-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentVideoPlan)});const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo crear el plan.');currentVideoPlan={...currentVideoPlan,...d};bar.style.width='78%';value.textContent='78%';label.textContent='Preparando narración y visuales…';renderScenes(d);await new Promise(r=>setTimeout(r,250));bar.style.width='100%';value.textContent='100%';label.textContent='Plan de producción listo';$('#productionState').textContent='Listo';}catch(e){$('#productionState').textContent='Error';label.textContent='Error';$('#scenesList').innerHTML='<div class="card empty"><div class="empty-icon">!</div><b>No se pudo generar</b><p>'+escapeHtml(e.message)+'</p></div>'}finally{btn.disabled=false;btn.textContent='Regenerar escenas con IA'}};
function renderScenes(d){const scenes=d.scenes||[];'<div class="section-head"><h3>'+scenes.length+' escenas preparadas</h3><span>'+escapeHtml(d.musicMood||'Música pendiente')+' · '+escapeHtml(d.voiceStyle||'Voz pendiente')+'</span></div>'+scenes.map(s=>'<div class="card scene-card"><div class="scene-number">'+String(s.number).padStart(2,'0')+'</div><div class="scene-body"><div class="scene-title"><div><b>'+escapeHtml(s.title||'Escena')+'</b><span>'+escapeHtml(String(s.duration||0))+' s · '+escapeHtml(s.transition||'Transición suave')+'</span></div><span class="badge">VISUAL + VOZ</span></div><p><strong>Narración:</strong> '+escapeHtml(s.narration||'')+'</p><p class="visual-prompt"><strong>Visual:</strong> '+escapeHtml(s.visualPrompt||'')+'</p></div></div>').join('')}
async function generateMusic(){
  if(!currentVideoPlan?.topic)return alert('Primero genera el plan del vídeo.');
  const btn=$('#generateMusicBtn'),state=$('#musicState'),audio=$('#musicPlayer'),label=$('#musicLabel');
  btn.disabled=true;btn.textContent='Generando música…';state.textContent='Generando';
  try{
    const r=await fetch('/api/ai/music',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      topic:currentVideoPlan.topic,
      mood:currentVideoPlan.musicMood||'ambient cinematográfico relajante',
      durationSeconds:Math.min(300,Math.max(30,Number(currentVideoPlan.duration||8)*60))
    })});
    if(!r.ok){let d={};try{d=await r.json()}catch{}throw new Error(d.error||'No se pudo generar la música.');}
    const blob=await r.blob();
    if(window.currentMusicUrl)URL.revokeObjectURL(window.currentMusicUrl);
    window.currentMusicUrl=URL.createObjectURL(blob);
    audio.src=window.currentMusicUrl;audio.classList.remove('hidden');audio.load();
    label.textContent='Música generada · lista para el montaje';state.textContent='Listo';
  }catch(e){state.textContent='Error';label.textContent=e.message;}
  finally{btn.disabled=false;btn.textContent='Generar música con IA'}
}

async function generateVoiceForScenes(){
  const scenes=currentVideoPlan?.scenes||[];
  if(!scenes.length)return alert('Primero genera las escenas.');
  const btn=$('#generateVoiceBtn'),state=$('#voiceState'),audio=$('#voicePlayer');
  btn.disabled=true;btn.textContent='Generando voz…';state.textContent='Creando narración por escenas';
  try{
    const blobs=[];
    for(const scene of scenes){
      const r=await fetch('/api/ai/voice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:scene.narration||scene.script||'',language:currentVideoPlan.language||'es'})});
      if(!r.ok){let d={};try{d=await r.json()}catch{}throw new Error(d.error||'No se pudo generar una voz.');}
      blobs.push(await r.blob());
    }
    currentVideoPlan.narrationAudio=blobs.map(b=>URL.createObjectURL(b));
    if(blobs[0]){audio.src=currentVideoPlan.narrationAudio[0];audio.classList.remove('hidden');audio.load();}
    state.textContent='Voz lista';
  }catch(e){state.textContent='Error';alert(e.message)}
  finally{btn.disabled=false;btn.textContent='Generar narración IA'}
}

async function renderFinalVideo(){
  const scenes=currentVideoPlan?.scenes||[], mediaResults=currentVideoPlan?.mediaResults||[];
  if(!scenes.length||!mediaResults.length)return alert('Primero genera las escenas y busca los visuales.');
  const btn=$('#renderVideoBtn'),state=$('#renderState');btn.disabled=true;btn.textContent='Renderizando…';state.textContent='Preparando clips y música…';
  try{
    const r=await fetch('/api/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenes,mediaResults})});
    if(!r.ok){let d={};try{d=await r.json()}catch{}throw new Error(d.error||'No se pudo renderizar el vídeo.');}
    const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='autotube-final.mp4';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    state.textContent='MP4 listo';
  }catch(e){state.textContent='Error';alert(e.message)}
  finally{btn.disabled=false;btn.textContent='🎬 Renderizar MP4'}
}

async function loadSceneMedia(){
  const scenes=currentVideoPlan?.scenes||[];
  if(!scenes.length)return alert('Primero genera las escenas.');
  const btn=$('#findMediaBtn'),state=$('#mediaState');
  btn.disabled=true;btn.textContent='Buscando visuales…';state.textContent='Pexels + Pixabay';
  try{
    const r=await fetch('/api/media/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenes})});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudieron buscar visuales.');
    currentVideoPlan.mediaResults=d.results||[];renderMediaResults(d.results||[]);
    state.textContent='Listo';
  }catch(e){state.textContent='Error';alert(e.message)}
  finally{btn.disabled=false;btn.textContent='Buscar visuales de las escenas'}
}
function renderMediaResults(results){
  const box=$('#mediaResults'); if(!box)return;
  box.innerHTML=results.map(r=>'<div class="card media-scene"><div class="media-scene-head"><b>Escena '+escapeHtml(String(r.number))+': '+escapeHtml(r.title||'')+'</b><span>'+escapeHtml(r.query||'')+'</span></div><div class="media-grid">'+(r.media||[]).slice(0,6).map(m=>'<a class="media-item" href="'+escapeHtml(m.url||'#')+'" target="_blank" rel="noopener"><img src="'+escapeHtml(m.thumbnail||'')+'" alt=""><div><b>'+escapeHtml(m.provider)+'</b><span>'+escapeHtml(String(m.duration||0))+' s</span></div></a>').join('')+'</div></div>').join('')||'<div class="card empty">No se encontraron visuales.</div>';
}

function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
