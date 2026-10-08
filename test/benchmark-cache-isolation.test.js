import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWithTelemetry } from '../server/benchmark/telemetry.js';

test('benchmark cache uses its isolated directory and records hits and misses', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codearchitect-cache-test-'));
  process.env.CODEARCHITECT_BENCHMARK = '1';
  process.env.MEANING_CACHE_DIR = directory;
  const cache = await import(`../server/llm/cache.js?test=${Date.now()}`);

  try {
    cache.resetMeaningCacheForBenchmark();
    const { telemetry } = await runWithTelemetry('cache', {}, async () => {
      assert.equal(cache.cacheGet('b:unit'), undefined);
      cache.cacheSet('b:unit', 'summary', { kind: 'bare', fileHash: 'file' });
      assert.equal(cache.cacheGet('b:unit'), 'summary');
    });

    assert.equal(telemetry.cache.misses, 1);
    assert.equal(telemetry.cache.hits, 1);
    assert.equal(telemetry.cache.sets, 1);
    assert.match(await fs.readFile(path.join(directory, 'meanings.jsonl'), 'utf8'), /"k":"b:unit"/);

    cache.resetMeaningCacheForBenchmark();
    await assert.rejects(fs.access(path.join(directory, 'meanings.jsonl')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
