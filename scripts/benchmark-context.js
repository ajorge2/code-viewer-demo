#!/usr/bin/env node

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let activeCacheDir = null;

function gitState() {
  try {
    const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = Boolean(execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim());
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

function parseArgs(argv) {
  const out = {
    config: path.join(ROOT, 'benchmarks', 'context.example.json'),
    outputDir: path.join(ROOT, 'benchmark-results'),
    dryRun: false,
    trials: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--config') out.config = path.resolve(argv[++i]);
    else if (arg === '--out-dir') out.outputDir = path.resolve(argv[++i]);
    else if (arg === '--trials') out.trials = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run benchmark:context -- [--config FILE] [--trials N] [--out-dir DIR] [--dry-run]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (out.trials != null && (!Number.isInteger(out.trials) || out.trials < 1)) {
    throw new Error('--trials must be a positive integer.');
  }
  return out;
}

function percentile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

const rounded = (value) => (value == null ? null : Math.round(value * 1000) / 1000);

function timing(telemetry, name) {
  return telemetry.timings[name]?.totalMs ?? 0;
}

function compactMetrics(telemetry) {
  const warmProjectMs = timing(telemetry, 'warm_project_bares');
  const folderContextMs = timing(telemetry, 'folder_context');
  const frontierContextMs = timing(telemetry, 'context_preparation');
  return {
    totalMs: telemetry.durationMs,
    warmProjectMs,
    folderContextMs,
    frontierContextMs,
    contextPreparationMs: warmProjectMs + folderContextMs + frontierContextMs,
    answerModelMs: timing(telemetry, 'model.answer'),
    cacheHits: telemetry.cache.hits,
    cacheMisses: telemetry.cache.misses,
    cacheSets: telemetry.cache.sets,
    modelCalls: telemetry.models.calls,
    modelCallsByPhase: telemetry.models.byPhase,
  };
}

function summarize(records) {
  const states = {};
  for (const state of ['cold', 'prewarmed', 'repeat']) {
    const selected = records.filter((record) => record.state === state);
    const field = (name) => selected.map((record) => record.metrics[name]);
    states[state] = {
      observations: selected.length,
      totalMs: { p50: rounded(percentile(field('totalMs'), 0.5)), p95: rounded(percentile(field('totalMs'), 0.95)) },
      contextPreparationMs: {
        p50: rounded(percentile(field('contextPreparationMs'), 0.5)),
        p95: rounded(percentile(field('contextPreparationMs'), 0.95)),
      },
      cacheHits: { p50: rounded(percentile(field('cacheHits'), 0.5)) },
      cacheMisses: { p50: rounded(percentile(field('cacheMisses'), 0.5)) },
      modelCalls: { p50: rounded(percentile(field('modelCalls'), 0.5)) },
    };
  }
  const cold = states.cold.contextPreparationMs.p50;
  const prewarmed = states.prewarmed.contextPreparationMs.p50;
  const repeat = states.repeat.contextPreparationMs.p50;
  const reduction = (before, after) => (
    before && after != null ? rounded(((before - after) / before) * 100) : null
  );
  return {
    states,
    contextPreparationReductionPct: {
      coldToPrewarmed: reduction(cold, prewarmed),
      prewarmedToRepeat: reduction(prewarmed, repeat),
    },
  };
}

function markdownReport(report) {
  const lines = [
    '# CodeArchitect context benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    `Observations per state: ${report.summary.states.cold.observations}`,
    '',
    '## Repository scale',
    '',
    '| Repository | Files | Lines | Source bytes | Questions |',
    '|---|---:|---:|---:|---:|',
    ...report.repositories.map((repo) => `| ${repo.name} | ${repo.files} | ${repo.lines} | ${repo.bytes} | ${repo.questions} |`),
    '',
    '## Results',
    '',
    '| State | Context p50 | Context p95 | Total p50 | Total p95 | Cache hits p50 | Cache misses p50 | Model calls p50 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const state of ['cold', 'prewarmed', 'repeat']) {
    const item = report.summary.states[state];
    lines.push(`| ${state} | ${item.contextPreparationMs.p50} ms | ${item.contextPreparationMs.p95} ms | ${item.totalMs.p50} ms | ${item.totalMs.p95} ms | ${item.cacheHits.p50} | ${item.cacheMisses.p50} | ${item.modelCalls.p50} |`);
  }
  lines.push(
    '',
    '## Derived comparisons',
    '',
    `- Cold → prewarmed context-preparation reduction: ${report.summary.contextPreparationReductionPct.coldToPrewarmed ?? 'n/a'}%`,
    `- Prewarmed → repeat context-preparation reduction: ${report.summary.contextPreparationReductionPct.prewarmedToRepeat ?? 'n/a'}%`,
    '',
    '## Candidate resume wording',
    '',
    '> Use only after the repository set and observation count are representative.',
    '',
    `Built a background process that caches content-addressed summaries from code units through the project root, reducing p50 context-preparation latency from ${report.summary.states.cold.contextPreparationMs.p50} ms cold to ${report.summary.states.prewarmed.contextPreparationMs.p50} ms after prewarming (${report.summary.contextPreparationReductionPct.coldToPrewarmed ?? 'n/a'}%) across ${report.repositories.length} repositories containing up to ${Math.max(...report.repositories.map((repo) => repo.files))} files.`,
    '',
  );
  return lines.join('\n');
}

function resolveRepositoryPath(configPath, value) {
  return path.resolve(path.dirname(configPath), value);
}

function findTargetNode(nodes, start, end) {
  const candidates = Object.entries(nodes)
    .filter(([, node]) => node.start <= start && node.end >= end)
    .filter(([, node]) => node.semantic || node.parent == null)
    .sort(([, a], [, b]) => (a.end - a.start) - (b.end - b.start));
  if (!candidates.length) throw new Error(`No structural node contains range ${start}:${end}.`);
  return candidates[0][0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (!Array.isArray(config.repositories) || !config.repositories.length) {
    throw new Error('Config must contain at least one repository.');
  }
  const trials = args.trials ?? config.trials ?? 1;
  if (!Number.isInteger(trials) || trials < 1) throw new Error('Config trials must be a positive integer.');

  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codearchitect-benchmark-'));
  activeCacheDir = cacheDir;
  process.env.CODEARCHITECT_BENCHMARK = '1';
  process.env.MEANING_CACHE_DIR = cacheDir;

  const [{ runWithTelemetry }, store, projectTree, meaning, cache, tree] = await Promise.all([
    import('../server/benchmark/telemetry.js'),
    import('../server/store.js'),
    import('../server/ingest/projectTree.js'),
    import('../server/llm/meaning.js'),
    import('../server/llm/cache.js'),
    import('../server/ingest/tree.js'),
  ]);

  const repositoryReports = [];
  const prepared = [];
  for (const repository of config.repositories) {
    if (!repository.path || !Array.isArray(repository.questions) || !repository.questions.length) {
      throw new Error('Each repository needs path and at least one question.');
    }
    const repositoryPath = resolveRepositoryPath(configPath, repository.path);
    await store.registerProject(repositoryPath);
    const files = store.listFiles();
    const source = files.map((meta) => {
      const file = store.getFile(meta.id);
      return { relPath: file.relPath, content: file.content };
    });
    projectTree.setProjectTree(repository.name || path.basename(repositoryPath), source);

    const questions = [];
    for (const question of repository.questions) {
      const meta = files.find((file) => file.relPath === question.file);
      if (!meta) throw new Error(`File not found in scanned project: ${question.file}`);
      const file = store.getFile(meta.id);
      const start = file.content.indexOf(question.find);
      if (start < 0) throw new Error(`Locator not found in ${question.file}: ${question.find}`);
      const end = start + question.find.length;
      const { nodes } = await tree.fileNodes(file);
      questions.push({
        id: question.id || `${question.file}:${start}`,
        file,
        nodeId: findTargetNode(nodes, start, end),
        question: question.question,
      });
    }

    const scale = {
      name: repository.name || path.basename(repositoryPath),
      path: repositoryPath,
      files: files.length,
      lines: files.reduce((sum, file) => sum + file.lineCount, 0),
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      questions: questions.length,
      scan: store.getScanStats(),
    };
    repositoryReports.push(scale);
    prepared.push({ scale, questions, source });
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, trials, repositories: repositoryReports }, null, 2));
    await fs.rm(cacheDir, { recursive: true, force: true });
    activeCacheDir = null;
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for a real benchmark. Use --dry-run to validate without model calls.');
  }

  const records = [];
  for (const repository of prepared) {
    await store.registerProject(repository.scale.path);
    projectTree.setProjectTree(repository.scale.name, repository.source);
    for (const question of repository.questions) {
      for (let trial = 1; trial <= trials; trial += 1) {
        const sessionId = `benchmark-${trial}`;
        cache.resetMeaningCacheForBenchmark();
        meaning.resetMeaningSessionForBenchmark();
        const cold = await runWithTelemetry('cold_full_context_ask', {
          repository: repository.scale.name, question: question.id, state: 'cold', trial,
        }, async () => {
          await meaning.warmProjectBares(repository.source);
          return meaning.ask({ file: question.file, nodeId: question.nodeId, question: question.question, sessionId });
        });
        records.push({
          repository: repository.scale.name, question: question.id, state: 'cold', trial,
          metrics: compactMetrics(cold.telemetry), telemetry: cold.telemetry,
        });

        cache.resetMeaningCacheForBenchmark();
        meaning.resetMeaningSessionForBenchmark();
        const warm = await runWithTelemetry('warm', {
          repository: repository.scale.name, question: question.id, state: 'prewarmed', trial,
        }, () => meaning.warmProjectBares(repository.source));
        const prewarmed = await runWithTelemetry('ask', {
          repository: repository.scale.name, question: question.id, state: 'prewarmed', trial,
        }, () => meaning.ask({ file: question.file, nodeId: question.nodeId, question: question.question, sessionId }));
        records.push({
          repository: repository.scale.name, question: question.id, state: 'prewarmed', trial,
          metrics: compactMetrics(prewarmed.telemetry), telemetry: prewarmed.telemetry,
          warm: { metrics: compactMetrics(warm.telemetry), telemetry: warm.telemetry },
        });

        const repeat = await runWithTelemetry('ask', {
          repository: repository.scale.name, question: question.id, state: 'repeat', trial,
        }, () => meaning.ask({ file: question.file, nodeId: question.nodeId, question: question.question, sessionId }));
        records.push({
          repository: repository.scale.name, question: question.id, state: 'repeat', trial,
          metrics: compactMetrics(repeat.telemetry), telemetry: repeat.telemetry,
        });
      }
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: configPath,
    trials,
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model || 'unknown',
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      code: gitState(),
      modelCallConcurrency: 8,
      bareWindowChars: Number(process.env.BARE_WINDOW_CHARS) || 48000,
      models: {
        bare: process.env.BARE_MODEL || 'gpt-5-mini',
        meaning: process.env.MEANING_MODEL || 'gpt-5.1',
        answer: process.env.ANSWER_MODEL || 'gpt-5.1',
      },
      cacheStateDefinitions: {
        cold: 'Empty isolated meaning cache; the full warm pass is paid synchronously inside the measured operation so answer context matches the prewarmed state.',
        prewarmed: 'Empty isolated meaning cache followed by completed warmProjectBares.',
        repeat: 'Same selection and question immediately repeated after the prewarmed ask.',
      },
    },
    repositories: repositoryReports,
    summary: summarize(records),
    records,
  };

  await fs.mkdir(args.outputDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(args.outputDir, `context-${stamp}.json`);
  const markdownPath = path.join(args.outputDir, `context-${stamp}.md`);
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, markdownReport(report)),
  ]);
  await fs.rm(cacheDir, { recursive: true, force: true });
  activeCacheDir = null;
  console.log(JSON.stringify({ ok: true, json: jsonPath, markdown: markdownPath, summary: report.summary }, null, 2));
}

main().catch(async (error) => {
  if (activeCacheDir) await fs.rm(activeCacheDir, { recursive: true, force: true }).catch(() => {});
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
