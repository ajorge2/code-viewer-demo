// The project's folder tree — the layer ABOVE the per-file box trees. Files are
// leaves; directories are internal nodes; the project root is the top. This is
// what lets `bare`/`ctx` extend past a file into its folders, up to the root.
//
// Content-addressed, like everything else:
//   • file leaf hash  = hash(file content)  — identical to the in-file root node's
//     hash, so a file's folder-level bare and its whole-file bare share one key.
//   • folder hash     = hash(sorted child hashes) — changes if any descendant
//     changes, so edits would invalidate a folder and its ancestors (edits are
//     out of scope for now, but the keys are ready for it).
//
// One project is active at a time, so the built tree is held module-level.
import crypto from 'crypto';

const sh = (s, n = 16) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
const norm = (p) => p.replace(/\\/g, '/');
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

let current = null; // { root, nodes: Map<path, node> }

// Build (and store) the folder tree from files: [{ relPath, content }].
export function setProjectTree(rootName, files) {
  const root = { kind: 'dir', path: '', name: rootName || '(project)', children: [] };
  const dirs = new Map([['', root]]);
  const ensureDir = (dirPath) => {
    if (dirs.has(dirPath)) return dirs.get(dirPath);
    const node = { kind: 'dir', path: dirPath, name: dirPath.split('/').pop(), children: [] };
    dirs.set(dirPath, node);
    ensureDir(dirOf(dirPath)).children.push(node);
    return node;
  };
  for (const f of files) {
    const rel = norm(f.relPath);
    const ch = sh(f.content);
    ensureDir(dirOf(rel)).children.push({
      kind: 'file', path: rel, name: rel.split('/').pop(), contentHash: ch, hash: ch, bareKey: `b:${ch}`,
    });
  }
  // Bottom-up hashing: a folder's hash is derived from its (sorted) children.
  const hashNode = (n) => {
    if (n.kind === 'file') return n.hash;
    n.children.sort((a, b) => (a.path < b.path ? -1 : 1));
    n.hash = sh(n.children.map(hashNode).join('|'));
    n.bareKey = `b:${n.hash}`;
    return n.hash;
  };
  hashNode(root);
  const nodes = new Map();
  const index = (n) => { nodes.set(n.path, n); if (n.children) n.children.forEach(index); };
  index(root);
  current = { root, nodes };
  return current;
}

export function getProjectTree() { return current; }

// Folder chain root → directory-of(relPath), inclusive — the folders whose
// context a FILE (and its chunks) inherits. Empty if no tree is built.
export function folderChainTo(relPath) {
  return chainToDir(dirOf(norm(relPath)));
}

// Folder chain root → the directory itself, inclusive — for chatting ABOUT a
// folder (the path IS the folder, not a file inside it).
export function folderChainToDir(dirPath) {
  return chainToDir(norm(dirPath).replace(/\/$/, ''));
}

function chainToDir(dirPath) {
  if (!current) return [];
  const chain = [current.nodes.get('')]; // project root
  let acc = '';
  for (const seg of dirPath.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    const n = current.nodes.get(acc);
    if (n) chain.push(n);
  }
  return chain;
}
