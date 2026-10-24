import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
test('hosted registry rejects uploads and host path selection before ingest', async () => {
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const proc=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:String(port),OPENAI_API_KEY:'',BRAINTRUST_API_KEY:''},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;
  for(let i=0;i<80;i++) {try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'server starts');
  assert.equal((await (await fetch(base+'/api/health')).json()).publicDemo,true);
  for(const path of ['/api/projects','/api/projects/upload','/api/projects/arbitrary/activate']) {
   const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/private',name:'private',files:[{relPath:'private.js',content:'PRIVATE_SENTINEL'}]})});
   assert.equal(response.status,403);
  }
  assert.equal((await fetch(base+'/api/projects',{headers:{Origin:'https://hostile.example'}})).status,403);
  assert.equal((await fetch(base+'/api/health')).headers.get('cache-control'),'no-store');
 }finally{proc.kill('SIGTERM');await new Promise(r=>proc.once('exit',r));}
});
