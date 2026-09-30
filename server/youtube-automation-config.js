'use strict';

const LA_ULTIMA_CLAVE_AUTOMATION = Object.freeze({
  channel: {
    name: 'La Última Clave',
    handle: '@LaUltimaClave',
    language: 'es',
    timezone: 'Europe/Madrid',
    niche: 'misterio, suspense psicológico e historias inquietantes'
  },
  publishing: {
    enabled: false,
    frequency: 'daily',
    preferredHour: '18:00',
    defaultVisibility: 'private'
  },
  shorts: { enabled: true, targetDurationSeconds: 65, scenes: 12 },
  longForm: { enabled: true, minMinutes: 6, maxMinutes: 12 },
  originality: {
    requireNewStory: true,
    requireNewScript: true,
    rejectNearDuplicate: true,
    similarityThreshold: 0.82
  },
  quality: {
    requireRealAiVideo: true,
    requireAudio: true,
    requireValidMp4: true,
    minScenes: 2
  },
  series: [
    'La Última Clave',
    'Historias en 60 segundos',
    'Mensaje Desconocido',
    'No Abras',
    'Lo Que Vio La Cámara',
    'Misterios de la Mente'
  ]
});

module.exports = { LA_ULTIMA_CLAVE_AUTOMATION };