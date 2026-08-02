import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';

test('greets a trimmed name', () => {
  assert.equal(greet('  Ada '), 'Hello, Ada!');
});

test('rejects an empty name', () => {
  assert.throws(() => greet('   '), TypeError);
});
