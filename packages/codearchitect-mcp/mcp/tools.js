import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkProject, languageFor } from '../server/ingest/code.js';
import { parseToTree } from '../server/ingest/parseTree.js';
import { selectionContext, ANSWER_GUIDANCE } from './focus.js';

export const DEMO_ROOT = fileURLToPath(new URL('./demo/', import.meta.url));
export const PRIVACY = {
  scope: 'CodeArchitect MCP entry point only; the web application has separate behavior',
  content_storage: 'No request, result, source text or parse tree persisted',
  external_api_calls: false, telemetry: false,
  local_data: 'Explicit project root; tracked source files in Git repositories; read-only',
  host_notice: 'Your AI application may retain results or send them to its model provider',
};
const EXTENSIONS = new Set(['.js','.jsx','.mjs','.ts','.tsx','.py','.go','.rs','.java','.c','.cpp','.h','.rb']);
const fail = () => { throw new Error('Source unavailable. Use a supported source file relative to the configured project root.'); };
export async function createTools(projectRoot = DEMO_ROOT) {
  const demo = projectRoot === DEMO_ROOT;
  const root = await fs.realpath(projectRoot);
  if (!(await fs.stat(root)).isDirectory()) fail();
  async function paths() {
    // Demo files ship with the package and need not be tracked in a developer checkout.
    const candidates = demo ? ['billing.js', 'report.js'] : await walkProject(root);
    return candidates.filter(p => EXTENSIONS.has(path.extname(p)) && !p.split(/[\\/]/).some(x => x.startsWith('.'))).slice(0, 4000);
  }
  async function read(relative) {
    if (!(await paths()).includes(relative)) fail();
    const candidate = path.resolve(root, relative);
    const resolved = await fs.realpath(candidate).catch(fail);
    if (!resolved.startsWith(root + path.sep)) fail();
    // Reject symbolic links even when their target is inside the allowed root.
    let current = root;
    for (const segment of relative.split(/[\\/]/)) {
      current = path.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) fail();
    }
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 100_000) fail();
      const buffer = Buffer.alloc(100_001);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 100_000) fail();
      return { id: relative, relPath: relative, content: buffer.subarray(0,bytesRead).toString('utf8'), language: languageFor(relative) };
    } finally { await handle.close(); }
  }
  return {
    async get_question_context(args) {
      const available=await paths();
      const relative=args.path;
      if(args.selection && (args.start_line!==undefined||args.end_line!==undefined)) throw new Error('Use a selection or a line range, not both');
      if(available.includes(relative)) {
        const record=await read(relative);
        const tree=await parseToTree(record.content,record.language);
        if(!tree)throw new Error('No supported parse tree for this file');
        let selection=args.selection;
        if(!selection && args.start_line!==undefined) {
          const lines=record.content.split('\n');
          const end=args.end_line||args.start_line;
          if(end>lines.length)throw new Error('Line outside file');
          selection={start_line:args.start_line,start_column:1,end_line:end,end_column:lines[end-1].length+1};
        }
        if(args.end_line!==undefined && args.start_line===undefined)throw new Error('An end line requires a start line');
        if(selection) return {scope:'selection',...selectionContext(record.content,tree,{...args,file:relative,selection})};
        return overview([{...record,tree}],args,'file',0);
      }
      if(args.selection||args.start_line!==undefined||args.end_line!==undefined)throw new Error('A range requires a supported source file');
      const folder=path.resolve(root,relative);
      const resolved=await fs.realpath(folder).catch(fail);
      if((resolved!==root&&!resolved.startsWith(root+path.sep))||!(await fs.stat(resolved)).isDirectory())fail();
      if(relative.split(/[\\/]/).some(p=>p.startsWith('.')&&p!=='.'))fail();
      let probe=root;
      for(const segment of path.relative(root,folder).split(path.sep).filter(Boolean)) {
        probe=path.join(probe,segment);if((await fs.lstat(probe)).isSymbolicLink())fail();
      }
      const folderRelative=path.relative(root,folder);
      const members=available.filter(p=>!folderRelative||p.startsWith(folderRelative+path.sep));
      const records=[];
      let skipped=0;
      for(const p of members.slice(0,12)) {
        try {
          const record=await read(p);
          const tree=await parseToTree(record.content,record.language);
          if(tree)records.push({...record,tree});else skipped++;
        } catch {skipped++;}
      }
      return overview(records,args,'folder',members.length-records.length,skipped);
    },
  };
}

function overview(records,args,scope,omitted,skipped=0) {
  const budget=args.max_context_chars||12000;
  let remaining=budget;
  let unitsOmitted=0;
  const files=records.map(record=>{
    const nodes=(record.tree.children||[]);
    const units=nodes.slice(0,12).map(n=>{
      const start=record.content.slice(0,n.start).split('\n').length;
      const end=record.content.slice(0,Math.max(n.start,n.end-1)).split('\n').length;
      const allowance=Math.min(remaining,Math.floor(budget/Math.max(1,records.length)/Math.min(12,Math.max(1,nodes.length))));
      const source=record.content.slice(n.start,Math.min(n.end,n.start+allowance));
      remaining-=source.length;
      return {node_type:n.type,start_line:start,end_line:end,source,truncated:source.length<n.end-n.start};
    });
    unitsOmitted+=Math.max(0,nodes.length-units.length);
    return {file:record.relPath,language:record.language,units};
  });
  return {scope,path:args.path,question:args.question,files,budget:{max_context_chars:budget,source_characters:budget-remaining,files_omitted:omitted,units_omitted:unitsOmitted},skipped_files:skipped,
    answer_guidance:ANSWER_GUIDANCE,limitations:['Structural overview, not a generated summary. Ask a focused follow-up range for detail.','At most 12 files and 12 top-level units per file. Cross-file relationships and product intent must not be assumed from names.']};
}
