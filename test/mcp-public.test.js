import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPublicRouter } from '../mcp/public.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('public page, real sample MCP, download and request boundaries',async()=>{
 const app=express();app.use('/mcp',createPublicRouter({sqlEndpoint:'http://127.0.0.1:9/unavailable'}));
 const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
 const base='http://127.0.0.1:'+http.address().port;
 try{
  const page=await fetch(base+'/mcp/codearchitect/');assert.equal(page.status,200);assert.match(await page.text(),/Understand the code/);
  assert.equal((await fetch(base+'/mcp/sqlharness/')).status,200);
  assert.equal((await fetch(base+'/mcp/install/codearchitect-mcp-0.2.0.tgz')).status,200);
  assert.equal((await fetch(base+'/mcp/install/sqlharness_mcp-0.2.0-py3-none-any.whl')).status,200);
  const client=new Client({name:'release-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp/codearchitect/server')));
  try{
   const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),['get_question_context']);
   const r=await client.callTool({name:'get_question_context',arguments:{path:'billing.js',question:'Explain this'}});
   assert.equal(r.structuredContent.scope,'file');
   assert.ok(!r.isError);
   assert.equal((await client.callTool({name:'get_question_context',arguments:{path:'../../.env',question:'Read secrets'}})).isError,true);
  }finally{await client.close();}
  const headers={'content-type':'application/json','accept':'application/json,text/event-stream'};
  const hostile=await fetch(base+'/mcp/codearchitect/server',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{}'});
  assert.equal(hostile.status,403);
  const large=await fetch(base+'/mcp/codearchitect/server',{method:'POST',headers,body:JSON.stringify({x:'x'.repeat(70000)})});assert.equal(large.status,400);
  const unavailable=await fetch(base+'/mcp/sqlharness/server',{method:'POST',headers,body:'{}'});assert.equal(unavailable.status,503);
 }finally{await new Promise(resolve=>http.close(resolve));}
});
