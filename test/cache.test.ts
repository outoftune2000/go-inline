import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletionCache, completionKey } from '../src/completion-cache';
import { delay } from '../src/core';
const signal = () => new AbortController().signal;

test('answers expire exactly five minutes after generation, not five minutes after a cache hit', async () => {
  let now = 0, calls = 0;
  const cache = new CompletionCache(300000, 128, () => now);
  const generate = async () => String(++calls);
  assert.equal(await cache.getOrCreate('same', signal(), generate), '1');
  now = 299999;
  assert.equal(await cache.getOrCreate('same', signal(), generate), '1');
  now = 300000;
  assert.equal(await cache.getOrCreate('same', signal(), generate), '2');
  cache.clear();
});
test('errors, cancelled requests, and empty completions are not cached', async () => {
  const cache = new CompletionCache(); let calls = 0;
  await assert.rejects(cache.getOrCreate('key', signal(), async () => { throw new Error('failure'); }));
  assert.equal(await cache.getOrCreate('key', signal(), async () => { calls++; return ''; }), '');
  assert.equal(await cache.getOrCreate('key', signal(), async () => { calls++; return 'valid'; }), 'valid');
  assert.equal(calls, 2);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(cache.getOrCreate('key', cancelled.signal, async () => 'unused'));
  cache.clear();
});
test('LRU eviction and character limits bound retained answers', async () => {
  const cache = new CompletionCache(300000, 2, Date.now, 10);
  let calls = 0;
  const get = (key: string, value = key) => cache.getOrCreate(key, signal(), async () => { calls++; return value; });
  await get('a'); await get('b'); await get('a'); await get('c'); await get('b');
  assert.equal(calls, 4, 'least recently used answer was evicted');
  await get('huge', 'x'.repeat(11)); await get('huge', 'x'.repeat(11));
  assert.equal(calls, 6, 'oversized answers are not retained');
  cache.clear();
});
test('abandoned generation aborts, while a replacement subscriber can reuse an in-flight request', async () => {
  const cache = new CompletionCache(); let calls = 0;
  const first = new AbortController();
  const task = async (s: AbortSignal) => { calls++; await delay(30, s); return 'answer'; };
  const a = cache.getOrCreate('key', first.signal, task);
  const rejected = assert.rejects(a);
  await Promise.resolve(); first.abort();
  const b = cache.getOrCreate('key', signal(), task);
  await rejected;
  assert.equal(await b, 'answer'); assert.equal(calls, 1);
  let generationSignal!: AbortSignal;
  const c = new AbortController();
  const abandoned = cache.getOrCreate('abandoned', c.signal, async s => { generationSignal = s; await delay(1000, s); return 'unused'; });
  const abandonedRejected = assert.rejects(abandoned);
  await Promise.resolve(); c.abort(); await abandonedRejected;
  await new Promise(r => setTimeout(r, 70));
  assert.ok(generationSignal.aborted);
  cache.clear();
});
test('clearing during a generation prevents late transport responses from repopulating the cache', async () => {
  const cache = new CompletionCache(); let finish!: () => void;
  const old = cache.getOrCreate('key', signal(), async () => { await new Promise<void>(r => { finish = r; }); return 'stale'; });
  const rejected = assert.rejects(old);
  await Promise.resolve(); cache.clear(); finish(); await rejected;
  assert.equal(await cache.getOrCreate('key', signal(), async () => 'new'), 'new');
  cache.clear();
});
test('cache keys fingerprint exact context and settings without retaining source text as keys', () => {
  const key = completionKey({ document: 'private source', provider: 'llamacpp', mode: 'automatic' });
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, completionKey({ document: 'private source', provider: 'llamacpp', mode: 'automatic' }));
  assert.notEqual(key, completionKey({ document: 'private source changed', provider: 'llamacpp', mode: 'automatic' }));
  assert.notEqual(key, completionKey({ document: 'private source', provider: 'openrouter', mode: 'automatic' }));
  assert.notEqual(key, completionKey({ document: 'private source', provider: 'llamacpp', mode: 'manual' }));
});
test('invalidating before a queued generation starts avoids making any backend call', async () => {
  const cache = new CompletionCache(); let calls = 0;
  const result = cache.getOrCreate('key', signal(), async () => { calls++; return 'answer'; });
  const rejected = assert.rejects(result);
  cache.clear(); await rejected;
  assert.equal(calls, 0);
});
