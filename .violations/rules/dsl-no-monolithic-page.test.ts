import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rule } from './dsl-no-monolithic-page.js';

describe('dsl/no-monolithic-page-component', () => {
  it('has the correct rule id', () => {
    assert.equal(rule.id, 'dsl/no-monolithic-page-component');
  });
  it('is an error', () => {
    assert.equal(rule.defaultSeverity, 'error');
  });
});
