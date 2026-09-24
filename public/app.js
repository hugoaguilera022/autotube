const $ = (s) => document.querySelector(s);
const views = [...document.querySelectorAll('.view')];
function go(name){views.forEach(v=>v.classList.toggle('active-view',v.id===name));document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===name));const titles={dashboard:'Tu contenido, automatizado.',create:'Crear un vídeo con IA.',projects:'Tus proyectos.',automation:'Automatiza tu canal.',connections:'Conexiones & API'};$('#pageTitle').textContent=titles[name]||'AutoTube';}
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>go(b.dataset.view));document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));
async function health(){try{const r=await fetch('/api/health');const d=await r.json();$('#serverStatus').textContent='Servidor conectado';$('#openaiBadge').textContent=d.configured.openai?'Conectado':'Revisar'}catch{$('#serverStatus').textContent='Servidor no disponible'}}health();
async function connectYoutube(){try{const r=await fetch('/api/youtube/auth');const d=await r.json();if(!r.ok)return alert(d.error);window.open(d.url,'youtube_oauth','width=620,height=760');}catch(e){alert('No se pudo iniciar la conexión con YouTube.')}}
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
$('#generateBtn').onclick=async()=>{const topic=$('#topic').value.trim();if(!topic)return alert('Escribe primero el tema del vídeo.');const btn=$('#generateBtn'),state=$('#generationState'),preview=$('#preview');btn.disabled=true;btn.textContent='Generando…';state.textContent='Procesando';preview.innerHTML='<div class="empty"><div class="empty-icon">✦</div><b>La IA está preparando la estructura…</b><p>Esto puede tardar unos segundos.</p></div>';try{const r=await fetch('/api/ai/outline',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic,duration:$('#duration').value,language:$('#language').value,reference:$('#reference').value})});const d=await r.json();if(!r.ok)throw new Error(d.error);preview.innerHTML=`<div style="text-align:left"><span class="pill">${d.demo?'DEMO · API PENDIENTE':'IA GENERATIVA'}</span><h3 style="font-size:21px;margin:14px 0 7px">${escapeHtml(d.title||'Nuevo vídeo')}</h3><p class="muted">${escapeHtml(d.hook||d.note||'Estructura preparada.')}</p><ol style="color:#cbd0db;line-height:1.8">${(d.outline||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ol><button class="primary" onclick="alert('Siguiente módulo: producción de visuales, voz y montaje.')">Continuar a producción →</button></div>`;state.textContent='Listo';}catch(e){state.textContent='Error';preview.innerHTML='<div class="empty"><div class="empty-icon">!</div><b>No se pudo generar</b><p>'+escapeHtml(e.message)+'</p></div>'}finally{btn.disabled=false;btn.textContent='Generar estructura con IA'}};
function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
