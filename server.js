

httpServer.keepAliveTimeout=120000;
httpServer.headersTimeout=125000;
httpServer.requestTimeout=0;
if(String(process.env.AUTOTUBE_E2E_REFERENCE||'').trim()){
  const e2eReference=String(process.env.AUTOTUBE_E2E_REFERENCE).trim();
  setTimeout(async()=>{
    console.log('AUTOTUBE E2E START',e2eReference);
    try{
      const result=await executeFullPipelineTest(e2eReference);
      console.log('AUTOTUBE E2E RESULT',JSON.stringify(result));
    }catch(err){
      console.error('AUTOTUBE E2E FAILED',err?.stack||err?.message||String(err));
    }
  },12000);
}
// No ejecutamos un render E2E automáticamente al arrancar Render: podría bloquear
// el benchmark o un render iniciado por el usuario. Las pruebas E2E se lanzan
// explícitamente desde los workflows/endpoints de test.