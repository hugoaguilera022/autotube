require('dotenv').config();
const crypto=require('crypto');
const Express=require('express');
const originalListen=Express.application.listen;
if(!Express.application.__autotubeAiE2EFix){
  Express.application.__autotubeAiE2EFix=true;
  Express.application.listen=function(...args){
    const app=this;
    app.get('/api/verify-ai-e2e',async(req,res)=>{
      const reference=String(req.query?.reference||'').trim();
      if(!reference)return res.status(400).json({ok:false,error:'reference requerida'});
      try{
        const upstream=await fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/verify-ai-e2e',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({reference}),
          signal:AbortSignal.timeout(15000)
        });
        const raw=await upstream.text();
        res.status(upstream.status).type('application/json').send(raw);
      }catch(err){
        res.status(502).json({ok:false,error:'No se pudo iniciar la generación IA: '+String(err?.message||err)});
      }
    });
    return originalListen.apply(this,args);
  };
}
