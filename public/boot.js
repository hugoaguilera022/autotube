(function(){
  'use strict';
  function nav(name){
    document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('active-view',v.id===name);});
    document.querySelectorAll('.nav').forEach(function(n){n.classList.toggle('active',n.getAttribute('data-view')===name);});
    var titles={dashboard:'Tu contenido, automatizado.',create:'Crear un vídeo con IA.',production:'Producción del vídeo',projects:'Tus proyectos.',automation:'Automatiza tu canal.',connections:'Conexiones & API'};
    var t=document.getElementById('pageTitle'); if(t)t.textContent=titles[name]||'AutoTube';
  }
  window.autoTubeNavigate=nav;
  window.addEventListener('error',function(e){var s=document.getElementById('serverStatus');if(s)s.textContent='Error de interfaz: '+String(e.message||'JavaScript').slice(0,70);});
  function health(){fetch('/api/health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){var s=document.getElementById('serverStatus');if(s)s.textContent=d&&d.ok?'Servidor conectado':'Servidor no disponible';var b=document.getElementById('openaiBadge');if(b)b.textContent=d&&d.configured&&d.configured.gemini?'Conectado':'Revisar';}).catch(function(){var s=document.getElementById('serverStatus');if(s)s.textContent='Servidor no disponible';});}
  function connect(){window.location.href='/api/youtube/auth';}

  async function exactUrlToMp4(){
    var input=document.getElementById('reference'),btn=document.getElementById('urlToVideoBtn'),state=document.getElementById('generationState'),preview=document.getElementById('preview');
    var reference=String(input&&input.value||'').trim();
    if(!reference)return alert('Añade primero una URL de YouTube.');
    var valid=false;try{var u=new URL(reference),h=u.hostname.toLowerCase();valid=(h==='youtu.be'||h==='youtube.com'||h==='www.youtube.com'||h.endsWith('.youtube.com'))&&(u.searchParams.has('v')||/^\\/(shorts|embed)\\//.test(u.pathname)||h==='youtu.be');}catch(e){}
    if(!valid)return alert('Introduce una URL de vídeo de YouTube válida.');
    if(btn)btn.disabled=true;
    if(state)state.textContent='Descargando vídeo original…';
    if(preview)preview.innerHTML='<div class="empty"><div class="empty-icon">◉</div><b>Descargando el vídeo original…</b><p>Se conserva el contenido audiovisual; el MP4 solo se remuxa si el contenedor original no es MP4.</p></div>';
    try{
      var r=await fetch('/api/url-to-mp4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:reference})});
      var raw=await r.text(),d=null;try{d=raw?JSON.parse(raw):null}catch(e){}
      if(!r.ok)throw new Error(d&&d.error||'No se pudo iniciar la conversión ('+r.status+').');
      var jobId=d&&d.jobId;if(!jobId)throw new Error('El servidor no devolvió el identificador del trabajo.');
      for(var i=0;i<600;i++){
        await new Promise(function(resolve){setTimeout(resolve,2000);});
        var sr=await fetch('/api/url-to-mp4/'+encodeURIComponent(jobId),{cache:'no-store'});
        var sd=await sr.json().catch(function(){return null;});
        if(sd&&sd.status==='done'){
          var vr=await fetch(sd.downloadUrl);if(!vr.ok)throw new Error('El MP4 terminó pero no se pudo descargar.');
          var blob=await vr.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='autotube-original.mp4';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},60000);
          if(state)state.textContent='MP4 listo';
          if(preview)preview.innerHTML='<div class="empty"><div class="empty-icon">✓</div><b>MP4 listo</b><p>Vídeo descargado y validado. Modo: '+String(sd.mode||'copy')+' · '+String(sd.final&&sd.final.width||'')+'×'+String(sd.final&&sd.final.height||'')+' · '+String(sd.final&&sd.final.fps||'')+' fps.</p></div>';
          return;
        }
        if(sd&&sd.status==='error')throw new Error(sd.error||'No se pudo generar el MP4.');
        var p=Math.max(0,Math.min(99,Number(sd&&sd.progress)||0));if(state)state.textContent=p?'Generando MP4 '+p+'%':'Generando MP4…';if(btn)btn.textContent=p?'MP4 '+p+'%':'Generando MP4…';
      }
      throw new Error('El proceso está tardando demasiado.');
    }catch(e){
      if(state)state.textContent='Error';
      if(preview)preview.innerHTML='<div class="empty"><div class="empty-icon">!</div><b>No se pudo generar el MP4</b><p>'+String(e&&e.message||e).replace(/[&<>'"]/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch];})+'</p></div>';
    }finally{if(btn){btn.disabled=false;btn.textContent='▶ Generar vídeo original desde esta URL';}}
  }

  async function showYoutubeTranscript(){
    var input=document.getElementById('reference'),btn=document.getElementById('viewTranscriptBtn'),panel=document.getElementById('transcriptPanel'),area=document.getElementById('youtubeTranscript'),state=document.getElementById('transcriptState'),meta=document.getElementById('transcriptMeta');
    var reference=String(input&&input.value||'').trim();
    if(!reference)return alert('Añade primero una URL de YouTube.');
    if(btn)btn.disabled=true;
    if(state)state.textContent='Obteniendo guion…';
    try{
      var r=await fetch('/api/youtube/transcript?language='+encodeURIComponent(document.getElementById('language')?.value||'es')+'&reference='+encodeURIComponent(reference),{cache:'no-store'});
      var d=await r.json().catch(function(){return null;});
      if(!r.ok||!d?.available)throw new Error(d?.error||'No hay una transcripción accesible para este vídeo.');
      window.autotubeReferenceTranscript=String(d.transcript||'');
      window.autotubeReferenceTranscriptLanguage=d.language||'';
      if(panel)panel.classList.remove('hidden');
      if(area)area.value=window.autotubeReferenceTranscript;
      if(meta)meta.textContent=(d.language||'')+' · '+(d.source||'YouTube');
      if(state)state.textContent='✓ Guion disponible';
    }catch(e){
      if(state)state.textContent='No disponible';
      if(panel)panel.classList.remove('hidden');
      if(area)area.value='';
      alert(String(e?.message||e));
    }finally{if(btn)btn.disabled=false;}
  }
  function useYoutubeTranscript(){
    var text=String(window.autotubeReferenceTranscript||document.getElementById('youtubeTranscript')?.value||'').trim();
    if(!text)return alert('Primero obtén una transcripción.');
    var direct=document.getElementById('scriptInput');
    if(direct){
      direct.value=text;
      direct.dispatchEvent(new Event('input',{bubbles:true}));
      var topic=document.getElementById('topic')?.value||'';
      var brief=document.getElementById('briefTopic');
      if(brief&&!String(brief.value||'').trim()&&topic)brief.value=topic;
      alert('Guion cargado en la creación directa. Puedes editarlo antes de generar.');
    }else{
      alert('Guion guardado para la siguiente generación.');
    }
  }
  window.addEventListener('DOMContentLoaded',function(){var exact=document.getElementById('urlToVideoBtn');if(exact)exact.onclick=exactUrlToMp4;var transcript=document.getElementById('viewTranscriptBtn');if(transcript)transcript.onclick=showYoutubeTranscript;var useTranscript=document.getElementById('useTranscriptBtn');if(useTranscript)useTranscript.onclick=useYoutubeTranscript;var y=document.getElementById('youtubeBtn'),y2=document.getElementById('youtubeConnect2');if(y)y.onclick=connect;if(y2)y2.onclick=connect;health();});
})();
