import type { CodeContext } from './types';
import { limitToOneFunction } from './function-limit';
import { repairGoDelimiters } from './delimiters';

export function generated(text: string): boolean {
  return /^\/\/ Code generated .* DO NOT EDIT\./m.test(text);
}

/** Budget is approximate, deliberately conservative for ordinary Go text. */
export function boundContext(text: string, offset: number, declarations: string, tokens: number): CodeContext {
  const budget = Math.max(256, tokens * 3 - 1000); // reserve prompt labels and FIM tokens
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const imports = text.match(/^import\s*(?:\([\s\S]*?^\)|[^\r\n]+)/gm)?.join('\n') ?? '';
  const pkg = text.match(/^package\s+\w+/m)?.[0] ?? '';
  const supplemental = [pkg, imports, declarations].filter(Boolean).join('\n');
  const extra = supplemental.slice(0, Math.floor(budget * 0.25));
  const remaining = budget - extra.length;
  const suffixSize = Math.min(after.length, Math.floor(remaining * 0.3));
  const prefixSize = remaining - suffixSize;
  return { prefix: before.slice(-prefixSize), suffix: after.slice(0, suffixSize), declarations: extra };
}

function goLexicalState(text: string): { depth: number; parens: number; brackets: number; state: string } {
  let depth = 0;
  let parens = 0, brackets = 0;
  let state = 'code';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (state === 'line') { if (ch === '\n') state = 'code'; continue; }
    if (state === 'block') { if (ch === '*' && next === '/') { state = 'code'; i++; } continue; }
    if (state === 'raw') { if (ch === '`') state = 'code'; continue; }
    if (state === '"' || state === "'") { if (ch === '\\') i++; else if (ch === state) state = 'code'; continue; }
    if (ch === '/' && next === '/') { state = 'line'; i++; }
    else if (ch === '/' && next === '*') { state = 'block'; i++; }
    else if (ch === '`') state = 'raw';
    else if (ch === '"' || ch === "'") state = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  return { depth, parens, brackets, state };
}

export function cleanCompletion(raw: string, prefix: string, suffix: string, crlf = false, functionPrefix = prefix, validationSuffix = suffix): string {
  let code = raw.replace(/\r\n/g, '\n');
  const fenced = code.match(/^\s*```(?:go|golang)?[ \t]*\n([\s\S]*?)\n?```\s*$/i);
  if (fenced) code = fenced[1];
  // Never display model control tokens, reasoning, or accompanying prose.
  code = code.split(/<\|(?:fim_|endoftext|im_end|im_start)|<\/s>/)[0];
  if (/```|<think>|<\/think>|^(?:Here(?:'s| is)|Sure\b|This (?:code|function)|The (?:code|function)|Explanation:)/i.test(code.trim())) return '';
  const p = prefix.replace(/\r\n/g, '\n');
  const s = suffix.replace(/\r\n/g, '\n');
  if (p && code.startsWith(p)) code = code.slice(p.length);
  // Some models echo the current line. Avoid stripping a single meaningful character.
  const currentLine = p.slice(p.lastIndexOf('\n') + 1);
  if (currentLine.trim().length >= 4 && code.startsWith(currentLine)) code = code.slice(currentLine.length);
  const fullPrefix = functionPrefix.replace(/\r\n/g, '\n');
  code = repairGoDelimiters(code, fullPrefix, validationSuffix.replace(/\r\n/g, '\n'));
  code = limitToOneFunction(code, fullPrefix);
  const insertion = goLexicalState(fullPrefix);
  const atInsertionLevel = (index: number) => {
    const lexical = goLexicalState(fullPrefix + code.slice(0, index));
    return lexical.depth === insertion.depth && lexical.parens === insertion.parens && lexical.brackets === insertion.brackets && lexical.state === 'code';
  };
  // Base models can reproduce the existing suffix and then invent another function.
  // Keep only the insertion before a full, exact copy of that existing context.
  if (s.length >= 2 && s.trim()) {
    for (let index = code.indexOf(s); index >= 0; index = code.indexOf(s, index + 1)) {
      if (atInsertionLevel(index)) { code = code.slice(0, index); break; }
    }
  }
  // Remove only exact overlap at the end; never delete non-overlapping generated code.
  for (let n = Math.min(code.length, s.length); n > 0; n--) {
    if (code.endsWith(s.slice(0, n)) && (!s.slice(0, n).trim() || atInsertionLevel(code.length - n))) { code = code.slice(0, -n); break; }
  }
  // Preserve indentation already supplied by the editor and use document line endings.
  if (/^[\t ]*$/.test(currentLine) && currentLine && code.startsWith(currentLine)) code = code.slice(currentLine.length);
  if (!code.trim()) return '';
  return crlf ? code.replace(/\n/g, '\r\n') : code;
}

export class CompletionCancelledError extends Error {}
export class CompletionTimeoutError extends Error {}
export function abortError(): Error { return new CompletionCancelledError('Completion cancelled'); }
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Superseding callers wait for the previous task to release its resources. */
export class Scheduler {
  private current?: AbortController;
  private tail: Promise<unknown> = Promise.resolve();
  cancel(): void { this.current?.abort(); }
  async run<T>(signal: AbortSignal, debounceMs: number, timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw abortError();
    this.cancel();
    const controller = new AbortController();
    this.current = controller;
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const previous = this.tail.catch(() => undefined);
    const result = (async () => {
      await previous;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await delay(debounceMs, controller.signal);
        timer = setTimeout(() => controller.abort(new CompletionTimeoutError('Completion timed out. Warm the model or increase the timeout in Settings.')), timeoutMs);
        return await task(controller.signal);
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (this.current === controller) this.current = undefined;
      }
    })();
    this.tail = result;
    return result;
  }
}
