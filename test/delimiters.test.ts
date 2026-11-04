import test from 'node:test';
import assert from 'node:assert/strict';
import { repairGoDelimiters } from '../src/delimiters';
import { cleanCompletion } from '../src/core';

test('nested consecutive parentheses and brackets are not removed as duplicate suffixes', () => {
  assert.equal(cleanCompletion('inner(x)', 'func f() { return outer(', ')\n}'), 'inner(x)');
  assert.equal(cleanCompletion('inner(x))', 'func f() { return outer(', ')\n}'), 'inner(x)');
  assert.equal(cleanCompletion('indexes[0]', 'func f() { return values[', ']\n}'), 'indexes[0]');
  assert.equal(cleanCompletion('inner(deep(x))', 'func f() { return outer(', ')\n}'), 'inner(deep(x))');
});
test('missing call closers are inserted before a generated or existing block closer', () => {
  assert.equal(repairGoDelimiters('return outer(inner(x)\n}', 'func f() {\n', ''), 'return outer(inner(x))\n}');
  assert.equal(repairGoDelimiters('return outer(inner(x)', 'func f() {\n', '\n}'), 'return outer(inner(x))');
  assert.equal(cleanCompletion('inner(x', 'func f() { return outer(', ')\n}'), 'inner(x)');
  assert.equal(repairGoDelimiters('return f(a[i)', 'func f() {\n', '\n}'), 'return f(a[i])');
});
test('extra generated call/index closers are removed, without altering the existing suffix', () => {
  assert.equal(repairGoDelimiters('return f(x)))', 'func f() {\n', '\n}'), 'return f(x)');
  assert.equal(repairGoDelimiters('indexes[0]]', 'func f() { return values[', '\n}'), 'indexes[0]]');
});
test('empty map and struct slice/array literals use braces instead of a mistaken bracket', () => {
  for (const type of ['map[string]Task', '[]Task', '[3]Task', 'map[string][]Task', 'map[string]*Task']) {
    assert.equal(repairGoDelimiters(`var tasks = ${type}[\n\n}`, '', ''), `var tasks = ${type}{\n\n}`);
  }
  assert.equal(repairGoDelimiters('[\n}', 'func f() { var tasks = map[string]Task', '\n}'), '{\n}');
});
test('valid generics, indexing, comments and string/rune literals remain intact', () => {
  const values = [
    'var tasks = map[string]Task[int]{}',
    'var tasks = map[string]Task[\nint\n]{}',
    'return values[indexes[0]]',
    'println("map[string]Task[\\n} and )))")',
    '// map[string]Task[\n// }\nprintln("ok")',
    'println(`map[string]Task[\n}`)',
    'println(\')\')',
    'constructor(toString(x))'
  ];
  for (const value of values) assert.equal(repairGoDelimiters(value, 'func f() {\n', '\n}'), value);
});
test('missing parentheses are inserted after literals, before trailing comments or newlines', () => {
  assert.equal(repairGoDelimiters('println("hello" // comment\n', 'func f() {\n', '}'), 'println("hello") // comment\n');
  assert.equal(repairGoDelimiters('println("unfinished', 'func f() {\n', '}'), 'println("unfinished');
});
