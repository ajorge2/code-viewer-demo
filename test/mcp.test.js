import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../mcp/server.js';
import { createTools } from '../mcp/tools.js';

async function clientFor(root,fn) {
  const server=await createServer(root);
  const client=new Client({name:'mcp-test',version:'1.0.0'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try { await fn(client); } finally { await client.close(); await server.close(); }
}
const query={path:'billing.js',question:'Why does this exclude pending orders?',start_line:3,end_line:4};

test('one question-context tool; optional lines, whole files and folders; no credentials',async () => {
  await clientFor(undefined,async client => {
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['get_question_context']);
    const result=await client.callTool({name:'get_question_context',arguments:query});
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.scope,'selection');
    assert.match(result.structuredContent.highlight.source,/filter/);
    assert.ok(result.structuredContent.answer_guidance.some(x=>x.includes('product level')));
    for(const target of ['billing.js','.']) {
      const r=await client.callTool({name:'get_question_context',arguments:{path:target,question:'What behavior does this support?'}});
      assert.ok(!r.isError);assert.equal(r.structuredContent.scope,target==='.'?'folder':'file');
      assert.ok(r.structuredContent.budget.source_characters<=12000);
    }
    const policy=await client.readResource({uri:'privacy://policy'});
    assert.equal(JSON.parse(policy.contents[0].text).external_api_calls,false);
    assert.equal((await client.callTool({name:'get_question_context',arguments:{...query,start_line:0}})).isError,true);
  });
});

test('precise highlight and stale selection checking',async () => {
  await clientFor(undefined,async client => {
    const args={path:'report.js',question:'How does this affect the report?',selection:{start_line:3,start_column:21,end_line:3,end_column:38},selected_text:'paidTotal(orders)'};
    const result=await client.callTool({name:'get_question_context',arguments:args});
    assert.ok(!result.isError,JSON.stringify(result));
    assert.equal(result.structuredContent.highlight.source,'paidTotal(orders)');
    assert.equal((await client.callTool({name:'get_question_context',arguments:{...args,selected_text:'stale'}})).isError,true);
  });
});

test('private paths, symlinks and oversize files rejected; no source/cache writes',async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codearchitect-mcp-'));
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'codearchitect-outside-'));
  try {
    await fs.writeFile(path.join(root,'small.js'),'function example() {\n  return 42;\n}\n');
    await fs.writeFile(path.join(root,'.secret.js'),'const PRIVATE_SENTINEL = 1;');
    await fs.writeFile(path.join(outside,'secret.js'),'const PRIVATE_SENTINEL = 2;');
    await fs.symlink(path.join(outside,'secret.js'),path.join(root,'linked.js'));
    await fs.symlink(outside,path.join(root,'linked-folder'));
    await fs.writeFile(path.join(root,'large.js'),'x'.repeat(100001));
    const before=await fs.readdir(root);
    await clientFor(root,async client => {
      for (const target of ['../secret.js','.secret.js','linked.js','linked-folder','large.js',outside]) {
        const r=await client.callTool({name:'get_question_context',arguments:{path:target,question:'Explain this'}});
        assert.equal(r.isError,true,target);assert.ok(!JSON.stringify(r).includes('PRIVATE_SENTINEL'));
      }
      const good=await client.callTool({name:'get_question_context',arguments:{path:'small.js',question:'Why return 42?',start_line:2}});
      assert.ok(!good.isError);assert.match(good.structuredContent.highlight.source,/return 42/);
    });
    assert.deepEqual(await fs.readdir(root),before);
  } finally {await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});

test('cross-function highlight focuses both units and excludes unrelated source',async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codearchitect-focus-'));
  try {
    await fs.writeFile(path.join(root,'multi.js'),'function first() { return 1; }\nfunction second() { return 2; }\nfunction unrelated() { return "PRIVATE_SENTINEL"; }\n');
    const result=await (await createTools(root)).get_question_context({path:'multi.js',question:'How do these two differ?',start_line:1,end_line:2,max_context_chars:4000});
    assert.equal(result.focus.length,2);
    assert.ok(result.focus.every(x=>!x.source.includes('PRIVATE_SENTINEL')));
    assert.ok(result.budget.source_characters<=4000);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('large highlights are explicitly clipped within the source budget',async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codearchitect-bounded-'));
  try {
    await fs.writeFile(path.join(root,'wide.js'),'function wide() {\n'+('  const value = 1;\n'.repeat(1000))+'}\n');
    const result=await (await createTools(root)).get_question_context({path:'wide.js',question:'What is this doing?',start_line:2,end_line:900,max_context_chars:2000});
    assert.equal(result.highlight.truncated,true);assert.ok(result.budget.source_characters<=2000);
    assert.ok(result.focus.some(x=>x.truncated));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
