import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LlamaCppProvider, ZenProvider, OpenRouterProvider, endpoint } from '../src/providers';
import type { CompletionRequest } from '../src/types';

const request = (): CompletionRequest => ({ prefix: 'func f() {\n', suffix: '\n}', declarations: 'type User struct{}', mode: 'automatic', maxTokens: 128, signal: new AbortController().signal });
test('endpoint validation protects local-only mode and credentials', () => {
  assert.equal(endpoint('http://localhost:8080', 'completion', true), 'http://localhost:8080/completion');
  assert.equal(endpoint('https://example.com/v1', 'chat/completions', false), 'https://example.com/v1/chat/completions');
  for (const value of ['http://remote.test', 'file:///tmp', 'https://user:key@localhost', 'http://localhost?token=secret']) assert.throws(() => endpoint(value, 'completion', true));
  assert.throws(() => endpoint('http://example.com', 'chat/completions', false));
});
test('llama.cpp sends raw FIM, output limits and prompt caching; checks health', async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok' })); return; }
    assert.equal(req.url, '/completion');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.stream, false); assert.equal(body.cache_prompt, true);
    assert.equal(body.n_predict, 128);
    assert.match(body.prompt, /<\|fim_prefix\|>[\s\S]*func f\(\) \{\n<\|fim_suffix\|>\n}<\|fim_middle\|>/);
    res.end(JSON.stringify({ content: '\treturn' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const provider = new LlamaCppProvider({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: '' });
    await provider.check(request().signal);
    assert.equal(await provider.complete(request()), '\treturn');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test('Zen uses Chat Completions and bearer authentication, not reasoning text', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://example.com/v1/chat/completions');
    assert.equal((init?.headers as any).Authorization, 'Bearer private-key');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.max_tokens, 128); assert.equal(body.stream, false);
    assert.equal(JSON.parse(body.messages[1].content).suffix, '\n}');
    return Response.json({ choices: [{ message: { content: 'return nil', reasoning_content: 'private reasoning' } }] });
  };
  try { assert.equal(await new ZenProvider({ endpoint: 'https://example.com/v1', model: 'test', apiKey: 'private-key' }).complete(request()), 'return nil'); }
  finally { globalThis.fetch = original; }
});
test('provider errors omit response bodies and classify HTTP failures', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 404, 429, 500]) {
      globalThis.fetch = async () => new Response('SENSITIVE SOURCE AND KEY', { status });
      await assert.rejects(new ZenProvider({ endpoint: 'https://example.com', model: 'test', apiKey: 'key' }).complete(request()), (e: Error) => e.message.includes(String(status)) && !e.message.includes('SENSITIVE'));
    }
    globalThis.fetch = async () => new Response('{broken');
    await assert.rejects(new LlamaCppProvider({ endpoint: 'http://localhost', model: '' }).complete(request()), /invalid JSON/);
    globalThis.fetch = async () => Response.json({ choices: [] });
    await assert.rejects(new ZenProvider({ endpoint: 'https://example.com', model: 'test', apiKey: 'key' }).complete(request()), /no completion/);
  } finally { globalThis.fetch = original; }
});
test('missing Zen settings do not make requests', async () => {
  await assert.rejects(new ZenProvider({ endpoint: 'https://example.com', model: '' }).complete(request()), /API key/);
  await assert.rejects(new ZenProvider({ endpoint: 'https://example.com', model: '', apiKey: 'key' }).complete(request()), /model/);
});
test('OpenRouter uses free-only routing, disables reasoning and keeps Zen credentials separate', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'cohere/north-mini-code:free');
    assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0 });
    assert.equal(body.reasoning.enabled, false);
    return Response.json({ choices: [{ message: { content: 'return a + b', reasoning: 'ignored' } }] });
  };
  try {
    const p = new OpenRouterProvider({ endpoint: 'https://openrouter.ai/api/v1', model: 'cohere/north-mini-code:free', apiKey: 'test-key' });
    assert.equal(await p.complete(request()), 'return a + b');
    await assert.rejects(new OpenRouterProvider({ endpoint: 'https://openrouter.ai/api/v1', model: 'paid/model', apiKey: 'test-key' }).complete(request()), /free-only/);
    await assert.rejects(new OpenRouterProvider({ endpoint: 'https://openrouter.ai/api/v1', model: 'cohere/north-mini-code:free' }).complete(request()), /OpenRouter API key/);
  } finally { globalThis.fetch = original; }
});
test('local HTTP cancellation interrupts an in-flight response', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('{"response":"'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const c = new AbortController();
    const result = new LlamaCppProvider({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: '' }).complete({ ...request(), signal: c.signal });
    const rejected = assert.rejects(result, /cancelled|timed out/);
    setTimeout(() => c.abort(), 40);
    await rejected;
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
