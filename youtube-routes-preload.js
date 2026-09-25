require('dotenv').config();
const crypto = require('crypto');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

function clean(v){ return String(v||'').trim(); }
function supabase(){
  const url=clean(process.env.SUPABASE_URL).replace(/\/+$/,'');
  const key=clean(process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY);
  return url&&key ? createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}}) : null;
}
function encKey(){
  const raw=clean(process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw,'hex') : crypto.createHash('sha256').update(raw).digest();
}
function encrypt(tokens){
  const iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv('aes-256-gcm',encKey(),iv);
  const data=Buffer.concat([c.update(JSON.stringify(tokens),'utf8'),c.final()]);
  return [iv,c.getAuthTag(),data].map(x=>x.toString('base64')).join('.');
}
function decrypt(value){
  const [iv,tag,data]=String(value||'').split('.');
  if(!iv||!tag||!data) throw new Error('Token cifrado inválido.');
  const d=crypto.createDecipheriv('aes-256-gcm',encKey(),Buffer.from(iv,'base64'));
  d.setAuthTag(Buffer.from(tag,'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data,'base64')),d.final()]).toString('utf8'));
}
function oauth(){
  const port=process.env.PORT||3000;
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI || `${process.env.APP_URL||`http://localhost:${port}`}/api/youtube/callback`
  );
}
let tokens=null;
let loaded=false;
async function load(){
  if(loaded) return;
  loaded=true;
  const db=supabase();
  if(!db) return;
  try{
    const {data,error}=await db.from('youtube_connections').select('*').eq('id','default').limit(1);
    if(error) throw error;
    const row=data?.[0];
    if(row?.tokens_encrypted) tokens=decrypt(row.tokens_encrypted);
  }catch(e){ loaded=false; console.error('YouTube connection load:',e.message); }
}
async function save(profile){
  const db=supabase();
  if(!db||!tokens) return;
  const {error}=await db.from('youtube_connections').upsert({
    id:'default',
    tokens_encrypted:encrypt(tokens),
    profile:profile||null,
    updated_at:new Date().toISOString()
  },{onConflict:'id'});
  if(error) throw error;
}
async function profile(){
  await load();
  if(!tokens) return null;
  const auth=oauth();
  auth.setCredentials(tokens);
  const yt=google.youtube({version:'v3',auth});
  const r=await yt.channels.list({part:'snippet,contentDetails,statistics',mine:true});
  const c=r.data.items?.[0];
  if(!c) return null;
  return {
    channelId:c.id||'',
    title:c.snippet?.title||'',
    handle:c.snippet?.customUrl||'',
    avatar:c.snippet?.thumbnails?.high?.url||c.snippet?.thumbnails?.default?.url||'',
    subscribers:Number(c.statistics?.subscriberCount||0),
    videos:Number(c.statistics?.videoCount||0),
    views:Number(c.statistics?.viewCount||0)
  };
}

function install(){
  if(install.done) return;
  install.done=true;
  const originalListen=require('express').application.listen;
  require('express').application.listen=function(...args){
    const app=this;
    if(!app.__autotubeYoutubeRoutes){
      app.__autotubeYoutubeRoutes=true;

      app.get('/api/youtube/auth',async(_req,res)=>{
        try{
          if(!process.env.YOUTUBE_CLIENT_ID||!process.env.YOUTUBE_CLIENT_SECRET){
            return res.status(503).send('Faltan YOUTUBE_CLIENT_ID o YOUTUBE_CLIENT_SECRET en Render.');
          }
          const auth=oauth();
          const url=auth.generateAuthUrl({
            access_type:'offline',
            prompt:'consent',
            scope:['https://www.googleapis.com/auth/youtube.readonly']
          });
          return res.redirect(url);
        }catch(e){ return res.status(500).send('No se pudo iniciar la conexión con YouTube: '+e.message); }
      });

      app.get('/api/youtube/callback',async(req,res)=>{
        try{
          const code=clean(req.query.code);
          if(!code) return res.status(400).send('Falta el código de autorización de YouTube.');
          const auth=oauth();
          const result=await auth.getToken(code);
          tokens=result.tokens;
          const p=await profile();
          await save(p);
          res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><title>YouTube conectado</title><body style="font-family:system-ui;text-align:center;padding:60px"><h2>YouTube conectado correctamente</h2><p>Puedes cerrar esta ventana.</p><script>try{window.opener&&window.opener.postMessage({type:'youtube_connected'},window.location.origin)}catch(e){}setTimeout(()=>{if(window.opener)window.close();else window.location.href='/'},800)</script></body></html>`);
        }catch(e){
          console.error('YouTube OAuth callback:',e.message);
          res.status(500).send('No se pudo completar la conexión con YouTube: '+e.message);
        }
      });

      app.get('/api/youtube/profile',async(_req,res)=>{
        try{
          const p=await profile();
          if(!p) return res.json({connected:false});
          return res.json({connected:true,...p});
        }catch(e){
          console.error('YouTube profile:',e.message);
          return res.status(401).json({connected:false,error:'La conexión de YouTube ha caducado o no es válida.'});
        }
      });

      app.post('/api/youtube/disconnect',async(_req,res)=>{
        try{
          tokens=null; loaded=true;
          const db=supabase();
          if(db){
            const {error}=await db.from('youtube_connections').delete().eq('id','default');
            if(error) throw error;
          }
          return res.json({ok:true});
        }catch(e){ return res.status(500).json({ok:false,error:e.message}); }
      });
    }
    return originalListen.apply(this,args);
  };
}
install();
