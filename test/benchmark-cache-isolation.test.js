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
      cache.cacheSet('c:file:unit', 'focused A', { kind: 'ctx', fileHash: 'file', sessionId: 'session-a' });
      assert.equal(cache.cacheGet('c:file:unit', { sessionId: 'session-a' }), 'focused A');
      assert.equal(cache.cacheGet('c:file:unit', { sessionId: 'session-b' }), undefined);
    });

    assert.equal(telemetry.cache.misses, 2);
    assert.equal(telemetry.cache.hits, 2);
    assert.equal(telemetry.cache.sets, 2);
    const durable = await fs.readFile(path.join(directory, 'basic-summaries.jsonl'), 'utf8');
    assert.match(durable, /"k":"b:unit"/);
    assert.doesNotMatch(durable, /focused A/);

    cache.resetMeaningCacheForBenchmark();
    await assert.rejects(fs.access(path.join(directory, 'basic-summaries.jsonl')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
