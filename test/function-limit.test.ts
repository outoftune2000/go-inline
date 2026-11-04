import test from 'node:test';
import assert from 'node:assert/strict';
import { limitToOneFunction } from '../src/function-limit';

test('keeps only the first new function or receiver method', () => {
  assert.equal(limitToOneFunction('func One() int { return 1 }\nfunc Two() int { return 2 }', 'package demo\n'), 'func One() int { return 1 }');
  assert.equal(limitToOneFunction('func (s *Server) Run() {}\nfunc Extra() {}', 'package demo\n'), 'func (s *Server) Run() {}');
});
test('finishes a partially typed function and excludes additional declarations', () => {
  assert.equal(limitToOneFunction('x int) int { return x }\nfunc Extra() {}', 'package demo\nfunc First('), 'x int) int { return x }');
  assert.equal(limitToOneFunction('return 1\n}\nfunc Extra() {}', 'package demo\nfunc First() int {\n'), 'return 1\n}');
  assert.equal(limitToOneFunction('return 1\nfunc Extra() {}', 'package demo\nfunc First() int {\n'), 'return 1');
});
test('preserves callbacks, function types, comments, and raw strings inside one function', () => {
  const code = 'func First() {\ncb := func() { println("func Extra() {}") }\nvar f func()\n_ = f\ncb()\n// func Hidden() {}\nprintln(`func Hidden() {}`)\n}\nfunc Second() {}';
  assert.equal(limitToOneFunction(code, 'package demo\n'), code.slice(0, code.indexOf('\nfunc Second')));
});
test('does not count earlier functions already present in the document', () => {
  assert.equal(limitToOneFunction('func New() {}\nfunc Extra() {}', 'package demo\nfunc Existing() {}\n'), 'func New() {}');
});
test('handles generic constraints and anonymous struct return types', () => {
  const generic = 'func First[T interface { ~int | ~int64 }](x T) T { return x }';
  assert.equal(limitToOneFunction(generic + '\nfunc Extra() {}', 'package demo\n'), generic);
  const struct = 'func First() struct { Value int } { return struct { Value int }{1} }';
  assert.equal(limitToOneFunction(struct + '\nfunc Extra() {}', 'package demo\n'), struct);
});
test('function return types are not confused with receiver method declarations', () => {
  const first = 'func First() func() func() { return func() func() { return func() {} } }';
  assert.equal(limitToOneFunction(first + '\nfunc Extra() {}', 'package demo\n'), first);
});
