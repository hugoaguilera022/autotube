(() => { document.head.appendChild(Object.assign(document.createElement('script'),{src:'/brief-ui.js?v=20260926'}));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const setState = (text, button) => {
    const state = document.querySelector('#mediaState');
    if (state) state.textContent = text;
    if (button) button.textContent = text;
  };
  const extractFileUrl = value => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return extractFileUrl(value[0]);
    if (typeof value === 'object') return value.url || value.path || value.video?.url || value.video?.path || value.data?.url || value.data?.path || '';
    return '';
  };
  async function run() {
    const scenes = window.__autotubeCurrentPlan?.scenes || (typeof currentVideoPlan !== 'undefined' && currentVideoPlan?.scenes) || [];
    if (!scenes.length) return alert('Primero genera las escenas.');
    const btn = document.querySelector('#generateAiVideoBtn');
    const state = document.querySelector('#mediaState');
    btn.disabled = true;
    const old = btn.textContent;
    try {
      setState('Conectando con Hugging Face…', btn);
      const mod = await import('https://cdn.jsdelivr.net/npm/@gradio/client/+esm');
      const Client = mod.Client;
      const client = await Client.connect('DeepRat/LTX-Video-ZeroGPU-Optimized', {
        status_callback: s => {
          if (s?.status === 'error') setState('Hugging Face: error de cola', btn);
          else if (s?.status === 'pending') setState('En cola de GPU…', btn);
          else if (s?.status === 'generating') setState('Generando en GPU…', btn);
        }
      });
      const api = await client.view_api();
      const endpoint = api?.named_endpoints?.['/text_to_video'] || api?.named_endpoints?.text_to_video;
      if (!endpoint) throw new Error('El Space de vídeo IA no expone el endpoint /text_to_video actualmente.');
      const clipCount = Math.min(6, Math.max(1, scenes.length));
      const clips = [];
      const plan = typeof currentVideoPlan !== 'undefined' ? currentVideoPlan : null;
      for (let i = 0; i < clipCount; i++) {
        const scene = scenes[Math.min(scenes.length - 1, Math.round(i * (scenes.length - 1) / Math.max(1, clipCount - 1)))];
        setState(`Generando vídeo IA ${i + 1} de ${clipCount}…`, btn);
        const ref = plan?.referenceStyle?.visualAnalysis || plan?.visualReferenceAnalysis || {};
        const vp = ref.videoProfile || {}, ap = ref.animationProfile || {}, sp = ref.structureProfile || {};
        const prompt = [
          scene.visualPrompt || scene.title || 'Cinematic realistic scene',
          scene.animationNotes || '',
          vp.visualStyle && `visual language: ${vp.visualStyle}`,
          vp.composition && `composition: ${vp.composition}`,
          vp.palette && `palette: ${vp.palette}`,
          vp.lighting && `lighting: ${vp.lighting}`,
          vp.cameraMovement && `camera: ${vp.cameraMovement}`,
          ap.cameraMotion && `camera animation: ${ap.cameraMotion}`,
          ap.zoomStyle && `zoom: ${ap.zoomStyle}`,
          ap.panStyle && `pan: ${ap.panStyle}`,
          ap.effects && `effects: ${ap.effects}`,
          ap.transitionStyle && `transitions: ${ap.transitionStyle}`,
          ap.motionIntensity && `motion: ${ap.motionIntensity}`,
          sp.pacing && `pacing: ${sp.pacing}`,
          'Original generation only. Preserve general audiovisual characteristics of the reference without reproducing any identifiable shot, frame, character, text, logo, recording or copyrighted expression. Realistic high-quality cinematography, landscape 16:9, coherent natural motion, detailed textures, normal real-time speed, no text, no logos, no watermark.'
        ].filter(Boolean).join('. ');
        const negative = 'worst quality, blurry, jittery, distorted, inconsistent motion, text, logo, watermark, slow motion, slow-mo';
        let result;
        let last;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            result = await client.predict('/text_to_video', [prompt, negative, null, null, 704, 960, 'text-to-video', 2.0, 9, Math.floor(Math.random() * 4294967295), true, 3, true, false]);
            break;
          } catch (e) {
            last = e;
            if (attempt < 2) { setState(`Reintentando escena ${i + 1}…`, btn); await wait(2500); }
          }
        }
        if (!result) throw new Error(`Hugging Face falló en la escena ${i + 1}: ${last?.message || last || 'error desconocido'}`);
        const fileUrl = extractFileUrl(result?.data?.[0]);
        if (!fileUrl) throw new Error(`Hugging Face terminó la escena ${i + 1} pero no devolvió el MP4.`);
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`No se pudo descargar el MP4 de la escena ${i + 1} (${response.status}).`);
        const blob = await response.blob();
        clips.push(new File([blob], `ai-scene-${i + 1}.mp4`, { type: 'video/mp4' }));
      }
      if (typeof currentVideoPlan !== 'undefined') currentVideoPlan.aiClips = clips;
      window.__autotubeCurrentPlan = typeof currentVideoPlan !== 'undefined' ? currentVideoPlan : { scenes, aiClips: clips };
      const box = document.querySelector('#mediaResults');
      if (box) box.innerHTML = `<div class="card"><div class="section-head"><h3>${clips.length} vídeos IA generados</h3><span>LTX Video · ZeroGPU</span></div>${clips.map((f,i)=>`<div style="padding:8px 0;border-top:1px solid #252a33"><b>Escena ${i+1}</b> · ${Math.round(f.size/1024)} KB · MP4</div>`).join('')}</div>`;
      setState(`✓ ${clips.length} vídeos IA listos para renderizar`, btn);
    } catch (e) {
      const msg = String(e?.message || e);
      setState('Error de vídeo IA', btn);
      alert(msg);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
  window.addEventListener('load', () => {
    const btn = document.querySelector('#generateAiVideoBtn');
    if (btn) btn.onclick = run;
  });
})();
