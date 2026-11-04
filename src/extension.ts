import * as vscode from 'vscode';
import { ContextCollector } from './context';
import { cleanCompletion, generated, delay, Scheduler, CompletionCancelledError, CompletionTimeoutError } from './core';
import { CompletionCache, completionKey } from './completion-cache';
import { createProvider, ProviderError } from './providers';
import type { Mode, ProviderId } from './types';

const config = () => vscode.workspace.getConfiguration('goInline');

export function activate(context: vscode.ExtensionContext): void {
  const collector = new ContextCollector();
  const scheduler = new Scheduler();
  const completionCache = new CompletionCache();
  const requestHints = new Map<string, { key: string; expires: number }>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  status.command = 'goInline.selectProvider';
  let health = 'not checked';
  let pendingManual: { uri: string; version: number; position: vscode.Position; expires: number } | undefined;
  let lastError = '';
  let lastErrorAt = 0;
  let cooldownUntil = 0;
  let requestEpoch = 0;
  const update = () => {
    const enabled = config().get('enabled', true);
    status.text = `$(sparkle) Go Inline: ${enabled ? config().get('provider', 'llamacpp') : 'off'}`;
    status.tooltip = `Go Inline — ${health}. Click to choose provider.`;
    if (vscode.window.activeTextEditor?.document.languageId === 'go') status.show(); else status.hide();
  };
  const provider = async (c = config()) => {
    const id = c.get<ProviderId>('provider', 'llamacpp');
    return createProvider(id, {
      endpoint: c.get<string>(`${id}.endpoint`)! , model: c.get<string>(`${id}.model`, ''),
      apiKey: id === 'llamacpp' ? undefined : await context.secrets.get(`goInline.${id}.apiKey`)
    });
  };
  const reset = () => { requestEpoch++; requestHints.clear(); completionCache.cancelPending(); scheduler.cancel(); pendingManual = undefined; };
  const invalidateAnswers = () => { reset(); completionCache.clear(); };

  context.subscriptions.push(collector, status, { dispose: () => { requestEpoch++; scheduler.cancel(); completionCache.clear(); requestHints.clear(); } },
    vscode.window.onDidChangeActiveTextEditor(() => { reset(); update(); }),
    vscode.window.onDidChangeTextEditorSelection(reset),
    vscode.workspace.onDidChangeTextDocument(reset),
    context.secrets.onDidChange(invalidateAnswers),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('goInline')) { invalidateAnswers(); cooldownUntil = 0; health = 'not checked'; update(); } }),
    vscode.commands.registerCommand('goInline.toggle', async () => {
      await config().update('enabled', !config().get('enabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('goInline.selectProvider', async () => {
      const item = await vscode.window.showQuickPick([
        { label: 'llama.cpp — local', id: 'llamacpp' as const, description: 'Code stays on this machine; connect to llama-server' },
        { label: 'OpenCode Zen — hosted', id: 'zen' as const, description: 'Sends bounded code context to your configured HTTPS API' },
        { label: 'OpenRouter — free models', id: 'openrouter' as const, description: 'Sends bounded code context to OpenRouter; free endpoints only' }
      ], { title: 'Go Inline provider' });
      if (item) await config().update('provider', item.id, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('goInline.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ title: 'Zen API key', password: true, ignoreFocusOut: true, prompt: 'Stored in VS Code SecretStorage. Leave empty to remove the saved key.' });
      if (key === undefined) return;
      if (key.trim()) await context.secrets.store('goInline.zen.apiKey', key.trim()); else await context.secrets.delete('goInline.zen.apiKey');
      health = 'not checked'; invalidateAnswers(); update();
    }),
    vscode.commands.registerCommand('goInline.setOpenRouterApiKey', async () => {
      const key = await vscode.window.showInputBox({ title: 'OpenRouter API key', password: true, ignoreFocusOut: true, prompt: 'Stored in VS Code SecretStorage. Leave empty to remove the saved key.' });
      if (key === undefined) return;
      if (key.trim()) await context.secrets.store('goInline.openrouter.apiKey', key.trim()); else await context.secrets.delete('goInline.openrouter.apiKey');
      health = 'not checked'; invalidateAnswers(); update();
    }),
    vscode.commands.registerCommand('goInline.checkConnection', async () => {
      if (!vscode.workspace.isTrusted) return;
      try {
        await scheduler.run(new AbortController().signal, 0, 15000, async signal => (await provider()).check(signal));
        health = 'connected'; update();
        void vscode.window.showInformationMessage('Go Inline: provider and configured model are available.');
      } catch (e) {
        health = e instanceof ProviderError ? e.message : 'Connection check failed.'; update();
        void vscode.window.showErrorMessage(`Go Inline: ${health}`);
      }
    }),
    vscode.commands.registerCommand('goInline.completeLong', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'go' || !editor.selection.isEmpty) return;
      if (!config().get('enabled', true)) { void vscode.window.showInformationMessage('Enable Go Inline before requesting a suggestion.'); return; }
      requestEpoch++;
      pendingManual = { uri: editor.document.uri.toString(), version: editor.document.version, position: editor.selection.active, expires: Date.now() + 3000 };
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }),
    vscode.languages.registerInlineCompletionItemProvider({ language: 'go', scheme: 'file' }, {
      async provideInlineCompletionItems(document, position, _inlineContext, token) {
        const editor = vscode.window.activeTextEditor;
        if (!vscode.workspace.isTrusted || !config().get('enabled', true) || !editor || editor.document !== document || !editor.selection.isEmpty || !editor.selection.active.isEqual(position) || generated(document.getText())) return [];
        const isManual = pendingManual && pendingManual.uri === document.uri.toString() && pendingManual.version === document.version && pendingManual.position.isEqual(position) && pendingManual.expires >= Date.now();
        const mode: Mode = isManual ? 'manual' : 'automatic';
        pendingManual = undefined;
        const version = document.version;
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        const c = config();
        const epoch = requestEpoch;
        const started = Date.now();
        const documentText = document.getText();
        const contextRevision = collector.revision;
        const valid = () => epoch === requestEpoch && !controller.signal.aborted && !token.isCancellationRequested && collector.revision === contextRevision && document.version === version && vscode.window.activeTextEditor === editor && editor.selection.active.isEqual(position) && editor.selection.isEmpty;
        const id = c.get<ProviderId>('provider', 'llamacpp');
        const maxTokens = c.get<number>(`${mode}.maxTokens`, mode === 'automatic' ? 128 : 512);
        const inputs = { uri: document.uri.toString(), position: [position.line, position.character], documentText, provider: id, endpoint: c.get(`${id}.endpoint`), model: c.get(`${id}.model`, ''), mode, maxTokens, timeout: c.get(`${mode}.timeoutMs`), eol: document.eol };
        const quickKey = completionKey({ ...inputs, contextRevision });
        try {
          for (const [key, hint] of requestHints) if (hint.expires <= Date.now()) requestHints.delete(key);
          const hint = requestHints.get(quickKey);
          let answer = hint ? completionCache.getExisting(hint.key, controller.signal) : undefined;
          const reused = answer !== undefined;
          if (!answer) {
            if (mode === 'automatic') await delay(c.get<number>('debounceMs', 350), controller.signal);
            if (!valid()) return [];
            const snapshot = await collector.collect(document, position, c.get<number>('contextTokens', 4000), c.get<boolean>('supplementaryContext', true), controller.signal);
            if (!valid()) return [];
            const key = completionKey({ ...inputs, snapshot });
            requestHints.delete(quickKey);
            requestHints.set(quickKey, { key, expires: Date.now() + 300000 });
            while (requestHints.size > 128) requestHints.delete(requestHints.keys().next().value!);
            answer = completionCache.getOrCreate(key, controller.signal, sharedSignal => {
            if (Date.now() < cooldownUntil) throw new ProviderError('Rate limited; new generation requests are paused briefly.');
            return scheduler.run(sharedSignal, 0, c.get<number>(`${mode}.timeoutMs`, mode === 'automatic' ? 3000 : 15000), async signal => {
            try {
              const model = await provider(c);
              const raw = await model.complete({ ...snapshot, mode, maxTokens, signal });
              if (signal.aborted) throw signal.reason;
              const offset = document.offsetAt(position);
              return cleanCompletion(raw, snapshot.prefix, snapshot.suffix, document.eol === vscode.EndOfLine.CRLF, documentText.slice(0, offset), documentText.slice(offset));
            } catch (error) {
              if (signal.aborted) {
                if (signal.reason instanceof CompletionTimeoutError) throw signal.reason;
                throw new CompletionCancelledError('Completion cancelled');
              }
              throw error;
            }
            });
            });
          }
          const text = await answer;
          if (!valid()) return [];
          health = `${reused ? 'reused answer' : 'connected'}; last suggestion ${Date.now() - started} ms`; update();
          return text ? [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))] : [];
        } catch (error) {
          if (error instanceof CompletionCancelledError) return [];
          if (!controller.signal.aborted && !token.isCancellationRequested) {
            if (error instanceof ProviderError && error.retryAfterMs) cooldownUntil = Date.now() + error.retryAfterMs;
            const message = error instanceof CompletionTimeoutError || error instanceof ProviderError ? error.message : 'Completion failed.';
            health = message; update();
            if (mode === 'manual' && (message !== lastError || Date.now() - lastErrorAt > 30000)) {
              lastError = message; lastErrorAt = Date.now();
              void vscode.window.showWarningMessage(`Go Inline: ${message}`);
            }
          }
          return [];
        } finally { subscription.dispose(); }
      }
    })
  );
  update();
}

export function deactivate(): void {}
