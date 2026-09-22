import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionPathFilter,
  parseSessionIgnoreGlobs,
} from '../server/session-path-filter.js';

test('session ignore globs support comma-separated and JSON-array configuration', () => {
  assert.deepEqual(
    parseSessionIgnoreGlobs(' **/.claude-unleashed/**, **/.automation/**,**/.automation/** '),
    ['**/.claude-unleashed/**', '**/.automation/**']
  );
  assert.deepEqual(
    parseSessionIgnoreGlobs('["**/{generated,cache}/**", "**/.workers/**"]'),
    ['**/{generated,cache}/**', '**/.workers/**']
  );
  assert.throws(
    () => parseSessionIgnoreGlobs('["valid", 42]'),
    /array of strings/
  );
});

test('session path filter matches hidden workflow directories without hiding normal projects', () => {
  const filter = createSessionPathFilter('**/.claude-unleashed/**,**/.automation-worktrees/**');

  assert.equal(filter.isIgnored('/Users/vkatari/.claude-unleashed/worktrees/05086bb3'), true);
  assert.equal(filter.isIgnored('/Users/vkatari/.claude-unleashed'), true);
  assert.equal(filter.isIgnored('C:\\Users\\me\\.automation-worktrees\\job-1'), true);
  assert.equal(filter.isIgnored('/Users/vkatari/dev/claude-mobile-ui'), false);
  assert.equal(filter.isIgnored(null), false);
});

test('session path filter treats leading exclamation marks literally', () => {
  const filter = createSessionPathFilter('!**/personal/**');

  assert.equal(filter.isIgnored('/Users/me/work/project'), false);
  assert.equal(filter.isIgnored('/Users/me/personal/project'), false);
});
