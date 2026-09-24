# AutoTube

Web independiente para automatizar la creación de vídeos de YouTube con IA.

## Flujo
1. Introducir un tema y, opcionalmente, una URL de referencia.
2. Generar una estructura/metadata original con IA.
3. Añadir el módulo de producción: visuales, voz, música y montaje.
4. Revisar el vídeo.
5. Conectar YouTube mediante OAuth y publicar.
6. Programar el modo Auto-Pilot.

La URL de referencia debe usarse para estudiar formato/tema, no para copiar contenido protegido.

## Ejecutar localmente
```bash
cp .env.example .env
npm install
npm start
```
Abrir http://localhost:3000

## Render
El proyecto incluye `render.yaml`. Conecta el repositorio en Render como Web Service y añade las variables de entorno. Nunca subas `.env` a GitHub.

## API keys
- `OPENAI_API_KEY`: generación de guion/metadata.
- `YOUTUBE_CLIENT_ID` + `YOUTUBE_CLIENT_SECRET`: OAuth de YouTube.
- `YOUTUBE_REDIRECT_URI`: callback OAuth.
- `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `ELEVENLABS_API_KEY`: módulos opcionales.
