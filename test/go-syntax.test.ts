import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanCompletion } from '../src/core';
const exec = promisify(execFile);

test('repaired suggestions compile as Go: nested calls, indexing, maps, slices, arrays, generics and one function', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'go-inline-syntax-'));
  try {
    await writeFile(path.join(root, 'go.mod'), 'module example.com/syntax\n\ngo 1.22\n');
    const cases = [
      { prefix: 'func Nested() int { return id(', raw: 'id(1)', suffix: ')\n}\n' },
      { prefix: 'func Missing() int {\n', raw: 'return id(id(1)\n}', suffix: '\n' },
      { prefix: 'func Index(values, indexes []int) int { return values[', raw: 'indexes[0]', suffix: ']\n}\n' },
      { prefix: 'func Map() {\n', raw: 'var tasks = map[string]Task[\n}\n_ = tasks', suffix: '\n}\n' },
      { prefix: 'func Slice() {\n', raw: 'var tasks = []Task[\n}\n_ = tasks', suffix: '\n}\n' },
      { prefix: 'func Array() {\n', raw: 'var tasks = [3]Task[\n}\n_ = tasks', suffix: '\n}\n' },
      { prefix: 'func Generic() {\n', raw: 'var tasks = map[string]GenericTask[int]{}\n_ = tasks', suffix: '\n}\n' },
      { prefix: '', raw: 'func OnlyOne() {}\nfunc Unwanted() {}', suffix: '\n' }
    ];
    let source = 'package syntax\ntype Task struct{}\ntype GenericTask[T any] struct{ Value T }\nfunc id(x int) int { return x }\n';
    for (const c of cases) source += c.prefix + cleanCompletion(c.raw, c.prefix, c.suffix) + c.suffix;
    assert.ok(!source.includes('Unwanted'));
    await writeFile(path.join(root, 'completion.go'), source);
    await exec('gofmt', ['-w', path.join(root, 'completion.go')], { windowsHide: true, timeout: 15000 });
    await exec('go', ['test', './...'], { cwd: root, windowsHide: true, timeout: 30000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
