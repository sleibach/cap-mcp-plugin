const cds = require('@sap/cds');
const t=setTimeout(()=>{console.error('VERDICT: HANG (deploy unresolved 18s)');process.exit(2);},18000);
(async()=>{
  const m = await cds.load('*');
  console.log('loaded',Object.keys(m.definitions).length);
  await cds.deploy(m).to('sqlite::memory:');
  clearTimeout(t); console.log('VERDICT: DEPLOY OK'); process.exit(0);
})().catch(e=>{clearTimeout(t);console.error('VERDICT ERR:',e&&e.stack||e);process.exit(1);});
