import { createHash } from 'node:crypto';
import { abortError } from './core';

export function completionKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface Pending {
  controller: AbortController;
  promise: Promise<string>;
  consumers: number;
  cancellation?: ReturnType<typeof setTimeout>;
}

/** In-memory LRU with fixed expiry and reference-counted, shared generations. */
export class CompletionCache {
  private answers = new Map<string, { value: string; expires: number }>();
  private pending = new Map<string, Pending>();
  private characters = 0;
  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly maxEntries = 128,
    private readonly now: () => number = Date.now,
    private readonly maxCharacters = 1_000_000
  ) {}

  cancelPending(): void {
    for (const entry of this.pending.values()) {
      if (entry.cancellation) clearTimeout(entry.cancellation);
      entry.controller.abort();
    }
    this.pending.clear();
  }
  clear(): void { this.cancelPending(); this.answers.clear(); this.characters = 0; }

  private remove(key: string): void {
    const value = this.answers.get(key);
    if (value) this.characters -= value.value.length;
    this.answers.delete(key);
  }
  private lookup(key: string): string | undefined {
    for (const [k, entry] of this.answers) if (entry.expires <= this.now()) this.remove(k);
    const hit = this.answers.get(key);
    if (!hit) return undefined;
    this.answers.delete(key); this.answers.set(key, hit);
    return hit.value;
  }
  private save(key: string, value: string): void {
    if (!value.trim() || value.length > this.maxCharacters) return;
    this.remove(key);
    this.answers.set(key, { value, expires: this.now() + this.ttlMs });
    this.characters += value.length;
    while (this.answers.size > this.maxEntries || this.characters > this.maxCharacters) this.remove(this.answers.keys().next().value!);
  }

  getOrCreate(key: string, signal: AbortSignal, generate: (signal: AbortSignal) => Promise<string>): Promise<string> {
    const existing = this.getExisting(key, signal);
    if (existing) return existing;
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      entry = { controller: new AbortController(), promise: Promise.resolve(''), consumers: 0 };
      const current = entry;
      this.pending.set(key, current);
      current.promise = Promise.resolve().then(() => {
        if (current.controller.signal.aborted) throw abortError();
        return generate(current.controller.signal);
      }).then(value => {
        if (current.controller.signal.aborted) throw abortError();
        if (this.pending.get(key) === current) this.save(key, value);
        return value;
      }).finally(() => {
        if (current.cancellation) clearTimeout(current.cancellation);
        if (this.pending.get(key) === current) this.pending.delete(key);
      });
      // Every subscriber may cancel before the underlying generation settles.
      void current.promise.catch(() => undefined);
    }
    return this.subscribe(key, entry, signal);
  }

  getExisting(key: string, signal: AbortSignal): Promise<string> | undefined {
    if (signal.aborted) return Promise.reject(abortError());
    const hit = this.lookup(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) return undefined;
    return this.subscribe(key, entry, signal);
  }

  private subscribe(key: string, shared: Pending, signal: AbortSignal): Promise<string> {
    if (shared.cancellation) { clearTimeout(shared.cancellation); shared.cancellation = undefined; }
    shared.consumers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, value?: string) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', cancel);
        shared.consumers--;
        if (!shared.consumers && this.pending.get(key) === shared) {
          // Allow VS Code's replacement request to attach before aborting the old one.
          shared.cancellation = setTimeout(() => {
            if (!shared.consumers && this.pending.get(key) === shared) {
              shared.controller.abort(); this.pending.delete(key);
            }
          }, 50);
        }
        if (error !== undefined) reject(error); else resolve(value!);
      };
      const cancel = () => finish(abortError());
      signal.addEventListener('abort', cancel, { once: true });
      shared.promise.then(value => finish(undefined, value), error => finish(error));
      if (signal.aborted) cancel();
    });
  }
}
