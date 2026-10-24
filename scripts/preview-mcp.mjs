import express from 'express';
import { createPublicRouter } from '../mcp/public.js';
const app=express();
app.use('/mcp',createPublicRouter({sqlEndpoint:'http://127.0.0.1:9021/mcp/sqlharness/server'}));
app.listen(9020,'127.0.0.1',()=>console.log('MCP preview: http://127.0.0.1:9020/mcp/codearchitect/'));
