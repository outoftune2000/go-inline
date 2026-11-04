import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ignore from 'ignore';
import { boundContext, generated } from './core';
import type { CodeContext } from './types';

const exec = promisify(execFile);
const packageName = (text: string) => text.match(/^package\s+(\w+)/m)?.[1];
const inside = (root: string, target: string) => { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

async function within<T>(promise: Thenable<T>, ms: number, signal: AbortSignal): Promise<T | undefined> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(undefined); return; }
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value?: T) => { clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(value); };
    const cancel = () => finish();
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(cancel, ms);
    Promise.resolve(promise).then(finish, () => finish());
  });
}

export class ContextCollector implements vscode.Disposable {
  private generation = 0;
  private cache = new Map<string, string>();
  private subscriptions: vscode.Disposable[];
  get revision(): number { return this.generation; }
  constructor() {
    const invalidate = () => { this.generation++; this.cache.clear(); };
    const relevant = (document: vscode.TextDocument) => document.languageId === 'go' || ['.gitignore','go.mod','go.sum','go.work','go.work.sum'].includes(path.basename(document.uri.fsPath));
    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.go,.gitignore,go.mod,go.sum,go.work,go.work.sum}');
    this.subscriptions = [watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate), vscode.workspace.onDidChangeTextDocument(e => { if (relevant(e.document)) invalidate(); }), vscode.workspace.onDidCloseTextDocument(document => { if (relevant(document)) invalidate(); })];
  }
  dispose(): void { for (const s of this.subscriptions) s.dispose(); }

  private async permitted(uri: vscode.Uri, active: vscode.TextDocument): Promise<boolean> {
    if (uri.scheme !== 'file' || path.extname(uri.fsPath) !== '.go') return false;
    const folder = vscode.workspace.getWorkspaceFolder(active.uri);
    if (!folder || !vscode.workspace.getWorkspaceFolder(uri) || !inside(folder.uri.fsPath, uri.fsPath)) return false;
    if (path.dirname(uri.fsPath) !== path.dirname(active.uri.fsPath)) return false;
    const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    if (rel.split('/').some(p => p === 'vendor' || p === '.git' || p === 'node_modules')) return false;
    const [rootReal, targetReal] = await Promise.all([realpath(folder.uri.fsPath), realpath(uri.fsPath)]);
    if (!inside(rootReal, targetReal)) return false;
    // Respect nested .gitignore rules even in a folder that has no Git repository.
    const parts = rel.split('/');
    for (let depth = 0; depth < parts.length; depth++) {
      const directory = path.join(folder.uri.fsPath, ...parts.slice(0, depth));
      const content = await readFile(path.join(directory, '.gitignore'), 'utf8').catch(() => '');
      if (content && ignore().add(content).ignores(parts.slice(depth).join('/'))) return false;
    }
    try {
      const result = await exec('git', ['check-ignore', '--no-index', '--', uri.fsPath], { cwd: folder.uri.fsPath, timeout: 300, windowsHide: true });
      if (result.stdout.trim()) return false;
    } catch (e: any) {
      // Exit 1 means not ignored; 128 means no repository. Other failures fail closed.
      if (e.code !== 1 && e.code !== 128 && e.code !== 'ENOENT') return false;
    }
    return true;
  }

  async collect(document: vscode.TextDocument, position: vscode.Position, tokens: number, supplementary: boolean, signal: AbortSignal): Promise<CodeContext> {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const key = `${document.uri}:${document.version}:${position.line}`;
    const generation = this.generation;
    let declarations = this.cache.get(key);
    if (supplementary && declarations === undefined && !signal.aborted) {
      declarations = await this.declarations(document, position, signal);
      if (generation === this.generation && !signal.aborted) {
        if (this.cache.size > 100) this.cache.clear();
        this.cache.set(key, declarations);
      }
    }
    return boundContext(text, offset, supplementary ? declarations ?? '' : '', tokens);
  }

  private async declarations(document: vscode.TextDocument, position: vscode.Position, signal: AbortSignal): Promise<string> {
    const snippets: string[] = [];
    const seen = new Set<string>();
    const deadline = Date.now() + 500;
    // Request only a few identifiers near the cursor, using providers already supplied by gopls.
    const offset = document.offsetAt(position);
    const start = Math.max(0, offset - 1200);
    const nearby = document.getText().slice(start, offset);
    const words = [...nearby.matchAll(/\b[A-Za-z_]\w*\b/g)].reverse();
    let lookups = 0;
    for (const word of words) {
      if (signal.aborted || Date.now() >= deadline || lookups >= 6 || snippets.join('\n').length > 2500) break;
      if (seen.has(word[0]) || /^(?:if|for|return|func|var|const|nil|err|range|package|import|type|struct|else|make|len|true|false)$/.test(word[0])) continue;
      seen.add(word[0]); lookups++;
      const definitions = await within(vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', document.uri, document.positionAt(start + word.index!)), Math.min(120, deadline - Date.now()), signal);
      for (const def of definitions?.slice(0, 2) ?? []) {
        if (signal.aborted || Date.now() >= deadline) break;
        const uri = 'targetUri' in def ? def.targetUri : def.uri;
        if (uri.toString() === document.uri.toString()) continue;
        const allowed = await within(this.permitted(uri, document), Math.max(1, deadline - Date.now()), signal);
        if (!allowed || signal.aborted) continue;
        const other = await within(vscode.workspace.openTextDocument(uri), Math.max(1, deadline - Date.now()), signal);
        if (!other || generated(other.getText()) || packageName(other.getText()) !== packageName(document.getText())) continue;
        const range = 'targetRange' in def ? def.targetRange : def.range;
        const symbols = await within(vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri), Math.max(1, deadline - Date.now()), signal);
        const find = (items: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
          for (const item of items) {
            if (item.range.contains(range.start)) return find(item.children ?? []) ?? item;
          }
          return undefined;
        };
        const symbol = find(symbols ?? []);
        let source = symbol ? other.getText(symbol.range) : other.lineAt(range.start.line).text;
        // Only signatures for functions; type definitions include fields and interface methods.
        if (/^\s*func\b/.test(source)) source = source.split('{')[0].trimEnd();
        source = source.slice(0, 1800);
        if (!snippets.includes(source)) snippets.push(source);
      }
    }
    return snippets.join('\n\n');
  }
}
