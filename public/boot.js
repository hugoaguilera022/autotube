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
  window.addEventListener('DOMContentLoaded',function(){var y=document.getElementById('youtubeBtn'),y2=document.getElementById('youtubeConnect2');if(y)y.onclick=connect;if(y2)y2.onclick=connect;health();});
})();
