# AutoTube — Plan maestro ejecutable

Workspace: autotube's workspace

## Objetivo de aceptación
No considerar AutoTube terminado por un HTTP 200 o un deploy correcto. El criterio final es:

description/script/reference -> story -> scenes -> images -> I2V/T2V -> voice -> music -> subtitles -> FFmpeg -> MP4 -> ffprobe/validation -> induced provider failure -> automatic repair/fallback -> second valid MP4.

## Orden para terminar rápido y con pocos errores

### Fase 0 — Baseline (antes de ampliar UI)
1. Deploy limpio.
2. /api/health y /api/ai-capabilities.
3. Smoke test de una escena de 5 s.
4. Validar imagen, vídeo, audio y MP4 con ffprobe.
5. Guardar el artefacto válido y su estado.

**No avanzar si falla.**

### Fase 1 — Video E2E (prioridad máxima)
Ruta:
1. Imagen: fal FLUX Schnell.
2. I2V: fal Seedance 2.5 I2V.
3. Fallback: Replicate Wan 2.7 I2V.
4. Fallback: Replicate Seedance 2.5.
5. T2V solo cuando no exista frame.
6. No usar rutas antiguas agotadas como backbone.

Para cada intento:
capability check -> credential check -> cooldown/health -> generación -> descarga -> validación -> éxito o clasificación del error.

### Fase 2 — Circuit breaker y reparación
Clasificar:
401/403=user action; 404/unsupported=integration; 429/quota=quota; 5xx=provider; timeout=network/provider; corrupt_media=output.

Reglas:
- unsupported: cero reintentos idénticos.
- quota: cooldown y siguiente proveedor.
- 5xx: máximo 1 retry con backoff y después fallback.
- timeout: máximo 1 retry con duración reducida y después fallback.
- corrupt output: descartar artefacto y penalizar proveedor.
- user action: detener y pedir únicamente la acción necesaria.

Guardar health por proveedor: successes, failures, latency, cooldownUntil, lastError.

### Fase 3 — Historia y escenas
Solo después del vídeo corto estable:
- Story Engine
- Scene Plan
- Character Bible
- VisualDNA
- duración por escena
- continuidad entre escenas.

### Fase 4 — Voz
Gemini TTS -> ElevenLabs -> MiniMax/fal -> Kokoro.
Validar duración, silencio y formato.

### Fase 5 — Música
Stable Audio -> ElevenLabs Music -> MiniMax Music -> biblioteca con derechos comprobados.
Separar pista de voz y música; no mezclar hasta el compositor final.

### Fase 6 — Subtítulos
audio/STT -> timestamps -> ASS/SRT -> FFmpeg/libass.
Validar timestamps dentro de duración.

### Fase 7 — Compositor
FFmpeg como fuente de verdad:
concat, fades/transitions, audio mix, normalization, subtitles, codec y MP4.

### Fase 8 — Referencia de YouTube
No hacer yt-dlp obligatorio.
Usar análisis directo/metadata cuando esté permitido.
Crear ReferenceProfile:
visual, camera, rhythm, audio, structure, continuity.
Generar contenido original, no copiar frames/personajes/audio/texto.

### Fase 9 — E2E de reparación
Tests obligatorios:
1 escena/5 s;
2 escenas I2V;
2 escenas + voz;
2 escenas + voz + música + subtítulos;
5 escenas + continuidad;
fallo inducido del proveedor principal;
restart/resume;
1–3 min.

### Fase 10 — UI y automatización
Solo cuando el pipeline backend sea estable:
- progreso por etapa;
- proveedor actual y fallback;
- tiempo estimado;
- errores explicados;
- historial de jobs;
- reanudar desde último artefacto válido;
- publicación YouTube.

## Criterio de salida
La fase completa termina únicamente cuando existe un MP4 reproducible validado y AutoTube demuestra que puede detectar un fallo real, cambiar de ruta, regenerar y volver a validar sin intervención manual.

## Regla de velocidad
No trabajar en varias capas a la vez. Completar y validar una vertical antes de abrir la siguiente. Primero vídeo corto real; después composición; después voz/música/subtítulos; al final referencia/UI/automatización.
