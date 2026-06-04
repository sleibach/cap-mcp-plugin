const fs=require('fs');
const cds = require('@sap/cds');
const log=(s)=>fs.appendFileSync('/tmp/verdict.txt',s+'\n');
fs.writeFileSync('/tmp/verdict.txt','START\n');
const t=setTimeout(()=>{log('VERDICT: HANG (deploy unresolved 18s)');process.exit(2);},18000);
(async()=>{
  const m = await cds.load('*');
  log('loaded defs='+Object.keys(m.definitions).length);
  await cds.deploy(m).to('sqlite::memory:');
  clearTimeout(t); log('VERDICT: DEPLOY OK'); process.exit(0);
})().catch(e=>{clearTimeout(t);log('VERDICT ERR: '+(e&&e.message));process.exit(1);});
