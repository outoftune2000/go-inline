import type { CompletionRequest, ModelOptions, ModelProvider, ProviderId } from './types';

export class ProviderError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number) { super(message); }
}

export function endpoint(base: string, path: string, local: boolean): string {
  const url = new URL(base.endsWith('/') ? base : base + '/');
  if (url.username || url.password || url.search || url.hash) throw new ProviderError('Endpoint must not contain credentials, query parameters, or a fragment.');
  if (local) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
      throw new ProviderError('llama.cpp must use a loopback HTTP or HTTPS endpoint.');
    }
  } else if (url.protocol !== 'https:') throw new ProviderError('Hosted endpoints must use HTTPS.');
  return new URL(path, url).toString();
}

async function jsonRequest(url: string, signal: AbortSignal, body?: unknown, key?: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch {
    if (signal.aborted) throw new ProviderError('Request cancelled or timed out.');
    throw new ProviderError('Cannot reach the configured provider. Check its endpoint and service.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 401 ? 'Check the API key.' : response.status === 403 ? 'This account or model does not permit external API access.' : response.status === 429 ? 'Rate limited; wait before trying again.' : response.status === 404 ? 'Check the endpoint and installed model ID.' : 'Provider request failed.';
    const retryAfter = response.headers.get('retry-after');
    const retryMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 60000;
    throw new ProviderError(`HTTP ${response.status}. ${hint}`, response.status === 429 ? Math.max(1000, Math.min(86400000, Number.isFinite(retryMs) ? retryMs : 60000)) : undefined);
  }
  // Bound response memory and avoid printing provider bodies, which may echo source or keys.
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('Provider returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new ProviderError('Provider response exceeded the size limit.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(signal.aborted ? 'Request cancelled or timed out.' : 'Provider returned an interrupted or invalid JSON response.');
  } finally { reader.releaseLock(); }
}

export class LlamaCppProvider implements ModelProvider {
  constructor(private options: ModelOptions) {}
  async check(signal: AbortSignal): Promise<void> {
    const data = await jsonRequest(endpoint(this.options.endpoint, 'health', true), signal);
    if (data.status !== 'ok') throw new ProviderError('llama-server is not ready. Load a Qwen2.5-Coder Base GGUF model first.');
  }
  async complete(r: CompletionRequest): Promise<string> {
    // Comments keep supplementary declarations out of the actual insertion location.
    const context = '// Complete only the current function or one new function. Do not add unrelated functions.\n' + (r.declarations ? '// Relevant Go declarations:\n' + r.declarations.split(/\r?\n/).map(l => '// ' + l).join('\n') + '\n\n' : '');
    const prompt = '<|fim_prefix|>' + context + r.prefix + '<|fim_suffix|>' + r.suffix + '<|fim_middle|>';
    const data = await jsonRequest(endpoint(this.options.endpoint, 'completion', true), r.signal, {
      prompt, stream: false, temperature: 0, n_predict: r.maxTokens, cache_prompt: true,
      stop: ['<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|endoftext|>', '<|im_end|>']
    });
    if (typeof data.content !== 'string') throw new ProviderError('llama.cpp returned no completion text.');
    return data.content;
  }
}

class ChatProvider implements ModelProvider {
  constructor(private options: ModelOptions, private service: 'Zen' | 'OpenRouter') {}
  private validate(): void {
    if (!this.options.apiKey) throw new ProviderError(`Set a ${this.service} API key with Go Inline: Set ${this.service} API Key.`);
    const setting = this.service === 'Zen' ? 'zen' : 'openrouter';
    if (!this.options.model.trim()) throw new ProviderError(`Choose a Chat Completions model in goInline.${setting}.model.`);
    if (this.service === 'OpenRouter' && !this.options.model.endsWith(':free') && this.options.model !== 'openrouter/free') {
      throw new ProviderError('OpenRouter is free-only: choose an explicit :free model or openrouter/free.');
    }
  }
  async check(signal: AbortSignal): Promise<void> {
    // A tiny generation checks actual model permission, not just server reachability.
    await this.complete({ prefix: 'package main\n// Reply with a Go comment.\n', suffix: '', declarations: '', mode: 'automatic', maxTokens: 8, signal });
  }
  async complete(r: CompletionRequest): Promise<string> {
    this.validate();
    const data = await jsonRequest(endpoint(this.options.endpoint, 'chat/completions', false), r.signal, {
      model: this.options.model, stream: false, temperature: 0, max_tokens: r.maxTokens,
      ...(this.service === 'OpenRouter' ? { reasoning: { enabled: false }, provider: { max_price: { prompt: 0, completion: 0 } } } : {}),
      messages: [
        { role: 'system', content: 'You complete Go source at a cursor. Return ONLY the missing code, without Markdown, explanation, reasoning, or copies of the prefix or suffix. Use surrounding comments, names, signatures, and declarations to infer intent. Do not change existing code or add imports elsewhere. Complete at most the current function or one new function; never add additional named functions or methods. ' + (r.mode === 'manual' ? 'Complete the remaining function body where appropriate.' : 'Suggest only the next line or small coherent block.') },
        { role: 'user', content: JSON.stringify({ relevantDeclarations: r.declarations, prefix: r.prefix, suffix: r.suffix }) }
      ]
    }, this.options.apiKey);
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new ProviderError(`${this.service} returned no completion text. Check model compatibility.`);
    return text;
  }
}

export class ZenProvider extends ChatProvider {
  constructor(options: ModelOptions) { super(options, 'Zen'); }
}
export class OpenRouterProvider extends ChatProvider {
  constructor(options: ModelOptions) { super(options, 'OpenRouter'); }
}

export function createProvider(id: ProviderId, options: ModelOptions): ModelProvider {
  if (id === 'zen') return new ZenProvider(options);
  if (id === 'openrouter') return new OpenRouterProvider(options);
  return new LlamaCppProvider(options);
}
