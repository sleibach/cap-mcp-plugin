const cds = require('@sap/cds');
(async()=>{
  try{
    const m = await cds.load('*');
    console.log('MODEL LOADED defs:', Object.keys(m.definitions).length, '| has Sessions:', !!m.definitions['cap.mcp.Sessions']);
    const db = await cds.deploy(m).to('sqlite::memory:');
    console.log('DEPLOY OK');
    process.exit(0);
  }catch(e){ console.error('ERR:', e && e.stack || e); process.exit(1); }
})();
setTimeout(()=>{ console.error('TIMEOUT-HANG: deploy did not finish in 20s'); process.exit(2); }, 20000);
