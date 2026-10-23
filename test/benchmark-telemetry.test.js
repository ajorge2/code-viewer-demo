import assert from 'node:assert/strict';
import test from 'node:test';

import {
  measureTelemetry,
  recordCacheAccess,
  recordCacheSet,
  recordModelCall,
  runWithTelemetry,
} from '../server/benchmark/telemetry.js';

test('runWithTelemetry isolates and summarizes benchmark counters', async () => {
  const { value, telemetry } = await runWithTelemetry('unit', { state: 'cold' }, async () => {
    recordCacheAccess('bare', false);
    recordCacheSet('bare');
    recordCacheAccess('bare', true);
    recordModelCall('bare_summary', 'test-model');
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
  assert.equal(telemetry.timings.phase.count, 1);
  assert.ok(telemetry.durationMs >= 0);
});

test('telemetry calls are inert outside a benchmark context', async () => {
  recordCacheAccess('bare', true);
  recordCacheSet('bare');
  recordModelCall('answer', 'test-model');
  assert.equal(await measureTelemetry('phase', async () => 'unchanged'), 'unchanged');
});
