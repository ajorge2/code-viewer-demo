import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
const root=fileURLToPath(new URL('../mcp-public/',import.meta.url));
const upstream='https://site--orcview--764vq9x779wv.code.run/mcp/sqlharness/server';
const hosts=new Set(['site--codearchitect--74wvcb9qzxr6.code.run','127.0.0.1','localhost']);
export function createPublicRouter({sqlEndpoint=upstream}={}) {
  const router=express.Router();
  let active=0;
  router.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    if(!hosts.has(req.hostname))return res.status(403).json({error:'Host not allowed'});
    const origin=req.get('origin');
    if(origin){
      let allowed=false;
      try{const u=new URL(origin);allowed=hosts.has(u.hostname)&&['https:','http:'].includes(u.protocol);}catch{}
      if(!allowed)return res.status(403).json({error:'Origin not allowed'});
      res.set({'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'POST, GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id','Access-Control-Expose-Headers':'MCP-Protocol-Version, MCP-Session-Id'});
    }
    if(req.method==='OPTIONS')return res.status(204).end();
    next();
  });
  router.use('/assets',express.static(path.join(root,'assets'),{index:false}));
  router.use('/install',express.static(path.join(root,'install'),{index:false}));
  for(const name of ['codearchitect','sqlharness']) {
    router.get('/'+name+'/',(_req,res)=>res.sendFile(path.join(root,name+'.html')));
  }
  router.get('/health',(_req,res)=>res.json({ok:true,release:'mcp-2026-10-23',sample_only:true,model_calls:false}));
  router.use(express.json({limit:'64kb',strict:true}));
  router.use((req,res,next)=>{
    if(req.method!=='POST')return next();
    if(active>=8){res.set('Retry-After','2');return res.status(429).json({error:'Demo busy; retry shortly'});}
    active++;res.once('close',()=>{active--;});next();
  });
  router.post('/codearchitect/server',async(req,res)=>{
    const server=await createServer();
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once('close',()=>{void transport.close();void server.close();});
    try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch{if(!res.headersSent)res.status(500).json({error:'Sample request failed'});}
  });
  router.post('/sqlharness/server',async(req,res)=>{
    try{
      // Forward only protocol headers; never forward user credentials, cookies or arbitrary destinations.
      const headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
      for(const [key,value] of Object.entries(req.headers)) {
        if(/^mcp-(protocol-version|method|name|param-[a-z0-9-]+)$/.test(key)&&typeof value==='string')headers[key]=value;
      }
      const result=await fetch(sqlEndpoint,{method:'POST',headers,body:JSON.stringify(req.body),signal:AbortSignal.timeout(12000),redirect:'error'});
      const text=await result.text();
      if(text.length>1_000_000)return res.status(502).json({error:'Sample response exceeded limit'});
      res.status(result.status).type(result.headers.get('content-type')||'application/json').send(text);
    }catch{res.status(503).json({error:'SQL sample temporarily unavailable; retry shortly'});}
  });
  router.all(['/codearchitect/server','/sqlharness/server'],(_req,res)=>res.status(405).end());
  router.use((_req,res)=>res.status(404).json({error:'Unknown MCP page or endpoint'}));
  router.use((_error,_req,res,_next)=>res.status(400).json({error:'Invalid or oversized request'}));
  return router;
}
