const cds = require('@sap/cds');
let fired = {};
['loaded','served','serving','listening','bootstrap','subscribe','connect'].forEach(e=>cds.on(e,()=>{fired[e]=(fired[e]||0)+1; console.log('EVENT:',e);}));
process.on('unhandledRejection',(r)=>console.error('UNHANDLED REJECTION:',r && r.stack || r));
(async()=>{
  try{
    cds.env.profiles = ['development'];
    const m = await cds.load('*');
    console.log('>>> MODEL LOADED, defs:', Object.keys(m.definitions).length);
    await cds.deploy(m).to('sqlite::memory:');
    console.log('>>> DEPLOY RESOLVED OK');
  }catch(e){ console.error('>>> ERROR:', e && e.stack || e); }
})();
setTimeout(()=>{
  console.log('FIRED EVENTS:', fired);
  console.log('ACTIVE RESOURCES:', process.getActiveResourcesInfo());
  process.exit(0);
}, 25000);
