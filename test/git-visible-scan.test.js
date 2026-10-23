import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { walkProject } from '../server/ingest/code.js';

const execFileAsync = promisify(execFile);

test('Git projects expose only tracked source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codearchitect-git-scan-'));
  try {
    await mkdir(path.join(root, 'docs'));
    await mkdir(path.join(root, '.data'));
    await writeFile(path.join(root, '.gitignore'), '.data/\nignored.js\n');
    await writeFile(path.join(root, 'tracked.js'), 'export const safe = true;\n');
    await writeFile(path.join(root, 'docs', 'tracked.md'), '# Safe\n');
    await writeFile(path.join(root, 'untracked.js'), 'export const local = true;\n');
    await writeFile(path.join(root, 'ignored.js'), 'export const ignored = true;\n');
    await writeFile(path.join(root, '.data', 'private.json'), '{"secret":true}\n');

    await execFileAsync('git', ['-C', root, 'init', '-q']);
    await execFileAsync('git', ['-C', root, 'add', '.gitignore', 'tracked.js', 'docs/tracked.md']);

    assert.deepEqual(await walkProject(root), ['docs/tracked.md', 'tracked.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('non-Git folders retain the source-file scanner fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codearchitect-folder-scan-'));
  try {
    await writeFile(path.join(root, 'local.js'), 'export const local = true;\n');
    await writeFile(path.join(root, 'notes.txt'), 'not a supported source file\n');
    assert.deepEqual(await walkProject(root), ['local.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('demo exclusions hide only named root folders and files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codearchitect-demo-scan-'));
  try {
    await mkdir(path.join(root, 'docs'));
    await mkdir(path.join(root, 'src', 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'hidden.md'), '# Hidden\n');
    await writeFile(path.join(root, 'src', 'docs', 'kept.md'), '# Kept\n');
    await writeFile(path.join(root, 'package.json'), '{}\n');
    await writeFile(path.join(root, 'app.js'), 'export const app = true;\n');

    assert.deepEqual(
      await walkProject(root, {
        excludeRootDirs: ['docs'],
        excludeRootFiles: ['package.json'],
      }),
      ['app.js', path.join('src', 'docs', 'kept.md')],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
