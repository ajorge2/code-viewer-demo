import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const telemetryStore = new AsyncLocalStorage();

function timingBucket(context, name) {
  if (!context.timings[name]) {
    context.timings[name] = { count: 0, totalMs: 0, minMs: null, maxMs: null };
  }
  return context.timings[name];
}

function addTiming(context, name, elapsedMs) {
  const bucket = timingBucket(context, name);
  bucket.count += 1;
  bucket.totalMs += elapsedMs;
  bucket.minMs = bucket.minMs == null ? elapsedMs : Math.min(bucket.minMs, elapsedMs);
  bucket.maxMs = bucket.maxMs == null ? elapsedMs : Math.max(bucket.maxMs, elapsedMs);
}

function counterBucket(parent, name, defaults) {
  if (!parent[name]) parent[name] = { ...defaults };
  return parent[name];
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

const emptyUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

function addUsage(bucket, usage = {}) {
  bucket.inputTokens += Number(usage.input_tokens || 0);
  bucket.outputTokens += Number(usage.output_tokens || 0);
  bucket.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens || 0);
  bucket.cacheReadInputTokens += Number(usage.cache_read_input_tokens || 0);
}

function snapshot(context) {
  const timings = {};
  for (const [name, value] of Object.entries(context.timings)) {
    timings[name] = {
      count: value.count,
      totalMs: rounded(value.totalMs),
      minMs: rounded(value.minMs ?? 0),
      maxMs: rounded(value.maxMs ?? 0),
    };
  }
  return {
    label: context.label,
    metadata: context.metadata,
    durationMs: rounded(performance.now() - context.startedAt),
    timings,
    cache: context.cache,
    models: context.models,
  };
}

export function telemetryActive() {
  return Boolean(telemetryStore.getStore());
}

export async function runWithTelemetry(label, metadata, fn) {
  const context = {
    label,
    metadata: metadata || {},
    startedAt: performance.now(),
    timings: {},
    cache: { hits: 0, misses: 0, sets: 0, byKind: {} },
    models: {
      calls: 0,
      usage: emptyUsage(),
      byPhase: {},
      byModel: {},
      usageByPhase: {},
      usageByModel: {},
    },
  };

  return telemetryStore.run(context, async () => {
    try {
      const value = await fn();
      return { value, telemetry: snapshot(context) };
    } catch (error) {
      error.benchmarkTelemetry = snapshot(context);
      throw error;
    }
  });
}

export async function measureTelemetry(name, fn) {
  const context = telemetryStore.getStore();
  if (!context) return fn();
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    addTiming(context, name, performance.now() - startedAt);
  }
}

export function recordCacheAccess(kind, hit) {
  const context = telemetryStore.getStore();
  if (!context) return;
  const normalized = kind || 'unknown';
  const bucket = counterBucket(context.cache.byKind, normalized, { hits: 0, misses: 0, sets: 0 });
  if (hit) {
    context.cache.hits += 1;
    bucket.hits += 1;
  } else {
    context.cache.misses += 1;
    bucket.misses += 1;
  }
}

export function recordCacheSet(kind) {
  const context = telemetryStore.getStore();
  if (!context) return;
  const normalized = kind || 'unknown';
  const bucket = counterBucket(context.cache.byKind, normalized, { hits: 0, misses: 0, sets: 0 });
  context.cache.sets += 1;
  bucket.sets += 1;
}

export function recordModelCall(phase, model) {
  const context = telemetryStore.getStore();
  if (!context) return;
  const normalizedPhase = phase || 'unknown';
  const normalizedModel = model || 'unknown';
  context.models.calls += 1;
  context.models.byPhase[normalizedPhase] = (context.models.byPhase[normalizedPhase] || 0) + 1;
  context.models.byModel[normalizedModel] = (context.models.byModel[normalizedModel] || 0) + 1;
}

export function recordModelUsage(phase, model, usage) {
  const context = telemetryStore.getStore();
  if (!context || !usage) return;
  const normalizedPhase = phase || 'unknown';
  const normalizedModel = model || 'unknown';
  const phaseBucket = counterBucket(context.models.usageByPhase, normalizedPhase, emptyUsage());
  const modelBucket = counterBucket(context.models.usageByModel, normalizedModel, emptyUsage());
  addUsage(context.models.usage, usage);
  addUsage(phaseBucket, usage);
  addUsage(modelBucket, usage);
}
