import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Gemini composite preflight sidecar has no composer, prompt, ledger, or Send capability', () => {
  const source = readFileSync(new URL('../scripts/review-gemini-composite-preflight-sidecar.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['insertText', 'sendKey', 'review_query', 'reviewPreflight', 'Input.insertText', 'Network.getCookies', 'navigate']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /gemini\.google\.com/);
  assert.match(source, /expectedModel = 'Gemini 3\.1 Pro extended'/);
  assert.match(source, /promptInsertCount: 0/);
  assert.match(source, /sendActionCount: 0/);
  assert.match(source, /\ud655\uc7a5/);
});
