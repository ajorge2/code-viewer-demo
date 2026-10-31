import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, listFiles, getFile } from '../server/store.js';
import { setProjectTree } from '../server/ingest/projectTree.js';
import { warmProjectBares } from '../server/llm/meaning.js';
import { cacheGet } from '../server/llm/cache.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await loadProject(root, {
  excludeRootDirs: ['experiments', 'docs', 'test', 'demo'],
  excludeRootFiles: ['package.json', 'README.md'],
});
const files = listFiles().map(f => getFile(f.id)).filter(Boolean);
const tree = setProjectTree(path.basename(root), files);
console.log(`Generating basic summaries for ${files.length} files and ${tree.nodes.size - files.length} folders…`);
await warmProjectBares(files);
const rows = [...tree.nodes.values()].map(node => {
  const value = cacheGet(node.bareKey);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing summary: ${node.path}`);
  return { k: node.bareKey, v: value, f: node.hash, t: node.kind === 'file' ? 'bare' : 'folderbare' };
});
const output = path.join(root, 'demo/basic-summaries.jsonl');
await fs.writeFile(`${output}.tmp`, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
await fs.rename(`${output}.tmp`, output);
console.log(`Saved and verified ${rows.length} basic summaries in ${output}`);
