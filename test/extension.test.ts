import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

function event() {
  const handlers = new Set<(...args: any[]) => void>();
  return { listen: (fn: (...args: any[]) => void) => { handlers.add(fn); return { dispose() { handlers.delete(fn); } }; }, fire: (...args: any[]) => { for (const h of handlers) h(...args); } };
}
class Position {
  constructor(public line: number, public character: number) {}
  isEqual(other: Position) { return other.line === this.line && other.character === this.character; }
}
function harness() {
  const commands = new Map<string, Function>();
  const change = event(), selection = event(), configuration = event(), active = event();
  const settings: Record<string, any> = { enabled: true, provider: 'llamacpp', 'llamacpp.endpoint': 'http://127.0.0.1:8080', supplementaryContext: false, debounceMs: 1, 'automatic.timeoutMs': 500, 'manual.timeoutMs': 1000 };
  let text = 'package main\nfunc f() int {\n\t';
  const position = new Position(2, 1);
  const document = { uri: { toString: () => 'file:///test.go' }, languageId: 'go', version: 1, eol: 1, getText: () => text, offsetAt: () => text.length };
  const editor = { document, selection: { active: position, isEmpty: true } };
  let registered: any;
  const status = { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
  const notifications: string[] = [];
  const disposable = { dispose() {} };
  const api: any = {
    workspace: { isTrusted: true, getConfiguration: () => ({ get: (k: string, fallback: any) => settings[k] ?? fallback, update: async (k: string, v: any) => { settings[k] = v; configuration.fire({ affectsConfiguration: () => true }); } }),
      createFileSystemWatcher: () => ({ ...disposable, onDidChange: event().listen, onDidCreate: event().listen, onDidDelete: event().listen }),
      onDidChangeTextDocument: (fn: Function) => change.listen(e => fn(e ?? { document })), onDidCloseTextDocument: event().listen, onDidChangeConfiguration: configuration.listen },
    window: { activeTextEditor: editor, createStatusBarItem: () => status, onDidChangeActiveTextEditor: active.listen, onDidChangeTextEditorSelection: selection.listen,
      showInformationMessage: (m: string) => notifications.push(m), showWarningMessage: (m: string) => notifications.push(m), showErrorMessage: (m: string) => notifications.push(m) },
    commands: { registerCommand: (id: string, fn: Function) => { commands.set(id, fn); return disposable; }, executeCommand: async (id: string) => commands.get(id)?.() },
    languages: { registerInlineCompletionItemProvider: (_s: unknown, provider: unknown) => { registered = provider; return disposable; } },
    StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 }, EndOfLine: { CRLF: 2 },
    Range: class { constructor(public start: Position, public end: Position) {} },
    InlineCompletionItem: class { constructor(public insertText: string, public range: unknown) {} }
  };
  let fetchImpl: typeof fetch = async () => Response.json({ content: 'return 42' });
  const module = { exports: {} as any };
  const realRequire = createRequire(process.cwd() + '/package.json');
  runInNewContext(readFileSync('dist/extension.js', 'utf8'), { module, exports: module.exports, require: (id: string) => id === 'vscode' ? api : realRequire(id), Buffer, URL, AbortController, setTimeout, clearTimeout, console, fetch: (...args: Parameters<typeof fetch>) => fetchImpl(...args) });
  const subscriptions: { dispose(): void }[] = [];
  const secretReads: string[] = [];
  const secretChange = event();
  module.exports.activate({ subscriptions, secrets: { onDidChange: secretChange.listen, get: async (key: string) => { secretReads.push(key); return 'saved-key'; } } });
  const call = (cancel = event()) => registered.provideInlineCompletionItems(document, editor.selection.active, {}, { isCancellationRequested: false, onCancellationRequested: cancel.listen });
  return { api, editor, document, settings, commands, status, notifications, change, selection, active, configuration, secretChange, call, secretReads,
    setFetch: (fn: typeof fetch) => { fetchImpl = fn; }, setText: (value: string) => { text = value; }, dispose: () => subscriptions.forEach(s => s.dispose()) };
}

test('extension registers Go commands and returns one insertion without editing document', async () => {
  const h = harness();
  try {
    for (const name of ['toggle', 'selectProvider', 'setApiKey', 'checkConnection', 'completeLong']) assert.ok(h.commands.has('goInline.' + name));
    const before = h.document.getText(); const items = await h.call();
    assert.equal(items.length, 1); assert.equal(items[0].insertText, 'return 42');
    assert.equal(h.document.getText(), before);
    assert.match(h.status.tooltip, /connected/);
  } finally { h.dispose(); }
});
test('manual command requests larger completion through native inline trigger', async () => {
  const h = harness(); let limit = 0;
  h.setFetch(async (_url, init) => { limit = JSON.parse(init?.body as string).n_predict; return Response.json({ content: 'return 42' }); });
  try {
    await h.commands.get('goInline.completeLong')!(); await h.call();
    assert.equal(limit, 512);
    await h.call(); assert.equal(limit, 128);
  } finally { h.dispose(); }
});
test('disabled and generated files, nonempty selections and untrusted workspaces make no requests', async () => {
  const h = harness(); let calls = 0; h.setFetch(async () => { calls++; return Response.json({ content: 'return 1' }); });
  try {
    h.settings.enabled = false; await h.call(); h.settings.enabled = true;
    h.api.workspace.isTrusted = false; await h.call(); h.api.workspace.isTrusted = true;
    h.editor.selection.isEmpty = false; await h.call(); h.editor.selection.isEmpty = true;
    h.setText('// Code generated by tool. DO NOT EDIT.\npackage main'); await h.call();
    assert.equal(calls, 0);
  } finally { h.dispose(); }
});
test('edits and cursor movement discard late responses even if transport ignores cancellation', async () => {
  for (const mutation of ['edit', 'cursor']) {
    const h = harness(); let started!: () => void; const ready = new Promise<void>(r => { started = r; }); let finish!: () => void;
    h.setFetch(async () => { started(); await new Promise<void>(r => { finish = r; }); return Response.json({ content: 'return 42' }); });
    try {
      const result = h.call(); await ready;
      if (mutation === 'edit') { h.document.version++; h.change.fire(); } else { h.editor.selection.active = new Position(1, 0); h.selection.fire(); }
      finish(); assert.equal((await result).length, 0);
    } finally { h.dispose(); }
  }
});
test('switching editor or disabling completion invalidates in-flight requests', async () => {
  const h = harness(); let started!: () => void; const ready = new Promise<void>(r => { started = r; }); let finish!: () => void;
  h.setFetch(async () => { started(); await new Promise<void>(r => { finish = r; }); return Response.json({ content: 'return 42' }); });
  try {
    const result = h.call(); await ready;
    await h.commands.get('goInline.toggle')!(); finish();
    assert.equal((await result).length, 0); assert.equal(h.settings.enabled, false);
  } finally { h.dispose(); }
});
test('default remains local and does not fall back to Zen after failure', async () => {
  const h = harness(); const urls: string[] = [];
  h.setFetch(async url => { urls.push(String(url)); throw new Error('private details'); });
  try {
    assert.equal((await h.call()).length, 0);
    assert.deepEqual(urls, ['http://127.0.0.1:8080/completion']);
    assert.equal(h.notifications.length, 0); assert.ok(!h.status.tooltip.includes('private details'));
  } finally { h.dispose(); }
});
test('OpenRouter selection uses its own endpoint, model and secret', async () => {
  const h = harness();
  h.settings.provider = 'openrouter';
  h.settings['openrouter.endpoint'] = 'https://openrouter.ai/api/v1';
  h.settings['openrouter.model'] = 'cohere/north-mini-code:free';
  h.setFetch(async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(JSON.parse(init?.body as string).model, 'cohere/north-mini-code:free');
    return Response.json({ choices: [{ message: { content: 'return 42' } }] });
  });
  try {
    assert.ok(h.commands.has('goInline.setOpenRouterApiKey'));
    assert.equal((await h.call())[0].insertText, 'return 42');
    assert.deepEqual(h.secretReads, ['goInline.openrouter.apiKey']);
  } finally { h.dispose(); }
});
test('rate limiting pauses later requests instead of hammering the provider', async () => {
  const h = harness(); let requests = 0;
  h.setFetch(async () => { requests++; return new Response('{}', { status: 429, headers: { 'retry-after': '60' } }); });
  try {
    assert.equal((await h.call()).length, 0);
    assert.equal((await h.call()).length, 0);
    assert.equal(requests, 1);
    assert.match(h.status.tooltip, /Rate limited/);
  } finally { h.dispose(); }
});
test('manual cancellation stays quiet while manual timeout provides an actionable message', async () => {
  for (const action of ['cancel', 'timeout']) {
    const h = harness();
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    h.settings['manual.timeoutMs'] = action === 'timeout' ? 20 : 1000;
    h.setFetch(async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    });
    try {
      await h.commands.get('goInline.completeLong')!();
      const result = h.call(); await ready;
      if (action === 'cancel') h.selection.fire();
      assert.equal((await result).length, 0);
      if (action === 'cancel') assert.equal(h.notifications.length, 0);
      else assert.match(h.notifications[0], /timed out/);
    } finally { h.dispose(); }
  }
});
test('identical simultaneous requests share one backend call and cache the final answer', async () => {
  const h = harness(); let calls = 0; let complete!: () => void;
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  h.setFetch(async () => { calls++; started(); await new Promise<void>(r => { complete = r; }); return Response.json({ content: 'return 42' }); });
  try {
    const first = h.call(); await ready;
    const second = h.call();
    await new Promise(r => setTimeout(r, 15));
    complete();
    assert.equal((await first)[0].insertText, 'return 42');
    assert.equal((await second)[0].insertText, 'return 42');
    assert.equal((await h.call())[0].insertText, 'return 42');
    assert.equal(calls, 1);
  } finally { h.dispose(); }
});
test('one subscriber cancelling does not cancel an identical request still being viewed', async () => {
  const h = harness(); let complete!: () => void; let started!: () => void;
  const ready = new Promise<void>(r => { started = r; }); let calls = 0;
  h.setFetch(async () => { calls++; started(); await new Promise<void>(r => { complete = r; }); return Response.json({ content: 'return 42' }); });
  try {
    const cancel = event(); const first = h.call(cancel); await ready;
    const second = h.call(); await new Promise(r => setTimeout(r, 15));
    cancel.fire(); complete();
    assert.equal((await first).length, 0);
    assert.equal((await second)[0].insertText, 'return 42');
    assert.equal(calls, 1);
  } finally { h.dispose(); }
});
test('cache survives undo to identical text but is separated by provider settings and credentials', async () => {
  const h = harness(); let calls = 0;
  h.setFetch(async () => { calls++; return Response.json({ content: 'return 42' }); });
  try {
    await h.call();
    const original = h.document.getText();
    h.setText(original + ' '); h.document.version++; h.change.fire(); await h.call();
    h.setText(original); h.document.version++; h.change.fire(); await h.call();
    assert.equal(calls, 2, 'undo reuses the original answer despite changed document version');
    h.secretChange.fire(); await h.call(); assert.equal(calls, 3);
    h.configuration.fire({ affectsConfiguration: () => true }); await h.call(); assert.equal(calls, 4);
  } finally { h.dispose(); }
});
test('a single ghost-text item cannot contain additional named functions', async () => {
  const h = harness();
  h.setFetch(async () => Response.json({ content: 'return 42\n}\n\nfunc Extra() int { return 7 }' }));
  try {
    const items = await h.call();
    assert.equal(items.length, 1);
    assert.equal(items[0].insertText, 'return 42\n}');
    assert.ok(!items[0].insertText.includes('Extra'));
  } finally { h.dispose(); }
});
test('hot answers skip the typing debounce and replacement requests attach before it', async () => {
  const h = harness(); h.settings.debounceMs = 120; let calls = 0;
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  h.setFetch(async (_url, init) => {
    calls++; started();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 60);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    return Response.json({ content: 'return 42' });
  });
  try {
    const cancel = event(); const first = h.call(cancel); await ready;
    const replacement = h.call(); cancel.fire();
    assert.equal((await first).length, 0);
    assert.equal((await replacement)[0].insertText, 'return 42');
    assert.equal(calls, 1, 'replacement shares the original generation despite the 120ms debounce');
    let resolved = false;
    const hot = h.call().then((items: any[]) => { resolved = true; return items; });
    await new Promise(r => setTimeout(r, 30));
    assert.ok(resolved, 'completed cache hit skips the debounce');
    assert.equal((await hot)[0].insertText, 'return 42');
    assert.equal(calls, 1);
  } finally { h.dispose(); }
});
test('changing settings or unloading the extension during debounce prevents a stale backend request', async () => {
  for (const action of ['settings', 'dispose']) {
    const h = harness(); h.settings.debounceMs = 40; let calls = 0;
    h.setFetch(async () => { calls++; return Response.json({ content: 'return 42' }); });
    const result = h.call();
    if (action === 'settings') h.configuration.fire({ affectsConfiguration: () => true }); else h.dispose();
    assert.equal((await result).length, 0);
    assert.equal(calls, 0);
    if (action === 'settings') h.dispose();
  }
});
