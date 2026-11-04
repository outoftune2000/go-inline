import { cases } from '../evaluation/cases';
import { boundContext, cleanCompletion } from '../src/core';
import { createProvider } from '../src/providers';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderId } from '../src/types';
const exec = promisify(execFile);
const reference = process.argv.includes('--reference');
const replayIndex = process.argv.indexOf('--replay');
const replayFile = replayIndex >= 0 ? process.argv[replayIndex + 1] : undefined;
const id: ProviderId = process.env.GO_INLINE_PROVIDER === 'openrouter' ? 'openrouter' : process.env.GO_INLINE_PROVIDER === 'zen' ? 'zen' : 'llamacpp';
const model = process.env.GO_INLINE_MODEL || (id === 'llamacpp' ? 'server-loaded-model' : id === 'openrouter' ? 'cohere/north-mini-code:free' : '');
const provider = createProvider(id, { endpoint: process.env.GO_INLINE_ENDPOINT || (id === 'llamacpp' ? 'http://127.0.0.1:18080' : id === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://opencode.ai/zen/v1'), model, apiKey: process.env.GO_INLINE_API_KEY });

async function main() {
  if (replayIndex >= 0 && !replayFile) throw new Error('--replay requires a saved evaluation report.');
  const replayReport = replayFile ? JSON.parse(await readFile(replayFile, 'utf8')) : undefined;
  if (!reference && !replayReport) {
    await provider.check(AbortSignal.timeout(15000));
    // Warm-up excluded from measurements; no source fixture is logged to the console.
    await provider.complete({ prefix: 'package fixture\nfunc Add(a,b int) int { return ', suffix: ' }', declarations: '', mode: 'automatic', maxTokens: 16, signal: AbortSignal.timeout(30000) });
  }
  const root = await mkdtemp(path.join(tmpdir(), 'go-inline-eval-'));
  const results: Record<string, unknown>[] = [];
  try {
    await writeFile(path.join(root, 'go.mod'), 'module goinline-evaluation\n\ngo 1.22\n');
    for (const c of cases) {
      const directory = path.join(root, c.id); await mkdir(directory);
      const [prefix, suffix] = c.source.split('/*CURSOR*/');
      const bounded = boundContext(prefix + suffix, prefix.length, c.extra ?? '', 4000);
      const started = performance.now();
      let completion = ''; let failure = ''; let latencyMs = 0; let stage = 'generation';
      try {
        const saved = replayReport?.results.find((r: any) => r.id === c.id);
        const raw = reference ? c.reference : replayReport ? saved?.completion ?? '' : await provider.complete({ ...bounded, mode: 'automatic', maxTokens: 128, signal: AbortSignal.timeout(3000) });
        latencyMs = replayReport ? saved?.latencyMs ?? 0 : Math.round(performance.now() - started);
        completion = reference || replayReport ? raw : cleanCompletion(raw, bounded.prefix, bounded.suffix, c.source.includes('\r\n'));
        if (!completion.trim()) throw new Error('Empty completion');
        await writeFile(path.join(directory, 'completion.go'), prefix + completion + suffix);
        if (c.extra) await writeFile(path.join(directory, 'types.go'), 'package fixture\n' + c.extra + '\n');
        const testImports = c.id === 'wrap' ? '\n"fmt"\n"errors"' : c.id === 'bytes' ? '\n"strings"' : c.id === 'context' ? '\n"context"' : '';
        await writeFile(path.join(directory, 'completion_test.go'), `package fixture\nimport ("testing"${testImports})\nfunc TestCompletion(t *testing.T) { ${c.assertion} }\n`);
        stage = 'formatting';
        await exec('gofmt', ['-w', directory], { timeout: 15000, windowsHide: true });
        stage = 'compilation or behavioral check';
        await exec('go', ['test', '-timeout=3s', './' + c.id], { cwd: root, timeout: 30000, windowsHide: true });
      } catch (e: any) {
        if (!latencyMs && !replayReport) latencyMs = Math.round(performance.now() - started);
        let details = String(e.stderr || e.stdout || e.message);
        if (process.env.GO_INLINE_API_KEY) details = details.split(process.env.GO_INLINE_API_KEY).join('[REDACTED]');
        failure = `${stage}: ${details.slice(0, 4000)}`;
      }
      results.push({ id: c.id, description: c.description, latencyMs, passed: !failure, failure, completion: reference ? undefined : completion, usefulness: reference ? undefined : 'unreviewed' });
      console.log(`${c.id}: ${failure ? 'FAIL' : 'PASS'}${reference ? '' : ` (${latencyMs} ms)`}`);
    }
    const latencies = results.filter(r => (r.latencyMs as number) > 0).map(r => r.latencyMs as number).sort((a,b) => a-b);
    const reportProvider = replayReport?.provider ?? id;
    const reportModel = replayReport?.model ?? model;
    const report = { kind: reference ? 'reference-fixture-validation' : replayReport ? 'live-model-evaluation-revalidated' : 'live-model-evaluation', provider: reference ? undefined : reportProvider, model: reference ? undefined : reportModel, cases: results.length, passed: results.filter(r => r.passed).length, medianLatencyMs: reference ? undefined : latencies[Math.floor(latencies.length / 2)], targetMedianMs: 1500, results };
    await mkdir('evaluation/results', { recursive: true });
    const filename = reference ? 'reference.json' : `${reportProvider}-${reportModel.replace(/[^a-z0-9_-]/gi, '_')}-${replayReport ? 'revalidated-' : ''}${Date.now()}.json`;
    await writeFile(path.join('evaluation/results', filename), JSON.stringify(report, null, 2));
    console.log(`${report.passed}/${report.cases} passed. Report: evaluation/results/${filename}`);
    if (report.passed !== report.cases) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Evaluation failed'); process.exitCode = 1; });
