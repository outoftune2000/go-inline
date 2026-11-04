import { runTests } from '@vscode/test-electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const workspace = path.join(root, '.test-host', 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'go.mod'), 'module example.com/goinline-host\n\ngo 1.22\n');
await writeFile(path.join(workspace, 'main.go'), 'package demo\nfunc NewUser() User {\n\treturn User{/*CURSOR*/}\n}\n');
await writeFile(path.join(workspace, 'types.go'), 'package demo\ntype User struct { Name string }\n');
await writeFile(path.join(workspace, '.gitignore'), '');
await runTests({
  ...(process.env.VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE } : {}),
  extensionDevelopmentPath: process.env.GO_EXTENSION_PATH ? [root, process.env.GO_EXTENSION_PATH] : root,
  extensionTestsPath: path.join(root, 'scripts', 'host-entry.cjs'),
  launchArgs: [workspace, '--user-data-dir=' + path.join(root, '.test-host', 'profile-' + Date.now()), '--extensions-dir=' + path.join(root, '.test-host', 'extensions'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu'],
  extensionTestsEnv: { GO_INLINE_TEST: '1' }
});
