import assert from 'node:assert/strict';
import test from 'node:test';

import {
  measureTelemetry,
  recordCacheAccess,
  recordCacheSet,
  recordModelCall,
  recordModelUsage,
  runWithTelemetry,
} from '../server/benchmark/telemetry.js';

test('runWithTelemetry isolates and summarizes benchmark counters', async () => {
  const { value, telemetry } = await runWithTelemetry('unit', { state: 'cold' }, async () => {
    recordCacheAccess('bare', false);
    recordCacheSet('bare');
    recordCacheAccess('bare', true);
    recordModelCall('bare_summary', 'test-model');
    recordModelUsage('bare_summary', 'test-model', {
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    });
    await measureTelemetry('phase', async () => 42);
    return 'ok';
  });

  assert.equal(value, 'ok');
  assert.equal(telemetry.label, 'unit');
  assert.deepEqual(telemetry.metadata, { state: 'cold' });
  assert.equal(telemetry.cache.hits, 1);
  assert.equal(telemetry.cache.misses, 1);
  assert.equal(telemetry.cache.sets, 1);
  assert.deepEqual(telemetry.cache.byKind.bare, { hits: 1, misses: 1, sets: 1 });
  assert.equal(telemetry.models.calls, 1);
  assert.equal(telemetry.models.byPhase.bare_summary, 1);
  assert.equal(telemetry.models.byModel['test-model'], 1);
  assert.deepEqual(telemetry.models.usage, {
    inputTokens: 120,
    outputTokens: 30,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 5,
  });
  assert.deepEqual(telemetry.models.usageByPhase.bare_summary, telemetry.models.usage);
  assert.deepEqual(telemetry.models.usageByModel['test-model'], telemetry.models.usage);
  assert.equal(telemetry.timings.phase.count, 1);
  assert.ok(telemetry.durationMs >= 0);
});

test('telemetry calls are inert outside a benchmark context', async () => {
  recordCacheAccess('bare', true);
  recordCacheSet('bare');
  recordModelCall('answer', 'test-model');
  recordModelUsage('answer', 'test-model', { input_tokens: 10, output_tokens: 5 });
  assert.equal(await measureTelemetry('phase', async () => 'unchanged'), 'unchanged');
});
