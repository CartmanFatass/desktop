import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  ensureToken,
  readToken,
  writeToken,
  defaultSettings,
  normalizeSettings,
  readSettings,
  writeSettings,
  readReviewTransportState,
  writeReviewTransportState
} from '../state.mjs';

async function tempDir() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  return base;
}

test('state: ensureToken creates and is readable', async () => {
  const dir = await tempDir();
  const token = await ensureToken(dir);
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 20);
  const token2 = await readToken(dir);
  assert.equal(token2, token);
});

test('state: writeToken overrides existing', async () => {
  const dir = await tempDir();
  await writeToken('abc123', dir);
  assert.equal(await readToken(dir), 'abc123');
  await writeToken('def456', dir);
  assert.equal(await readToken(dir), 'def456');
});

test('state: normalizeSettings defaults allowAuthPopups to true', () => {
  const s = normalizeSettings({});
  assert.equal(s.allowAuthPopups, true);
  assert.equal(s.browserBackend, 'chrome-cdp');
  assert.equal(s.chromeDebugPort, 9222);
  assert.equal(s.chromeProfileMode, 'isolated');
  assert.equal(s.chromeProfileName, 'Default');
});

test('state: readSettings returns defaults when file missing', async () => {
  const dir = await tempDir();
  const s = await readSettings(dir);
  assert.deepEqual(s, defaultSettings());
});

test('state: writeSettings persists allowAuthPopups', async () => {
  const dir = await tempDir();
  const saved = await writeSettings({ allowAuthPopups: false }, dir);
  assert.equal(saved.allowAuthPopups, false);
  const re = await readSettings(dir);
  assert.equal(re.allowAuthPopups, false);
});

test('state: normalizeSettings clamps backend fields', () => {
  const s = normalizeSettings({
    browserBackend: 'chrome-cdp',
    chromeDebugPort: 70000,
    chromeExecutablePath: ' /Applications/Google Chrome.app/Contents/MacOS/Google Chrome ',
    chromeProfileMode: 'existing',
    chromeProfileName: ' Profile 2 '
  });
  assert.equal(s.browserBackend, 'chrome-cdp');
  assert.equal(s.chromeDebugPort, 65535);
  assert.equal(s.chromeExecutablePath, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(s.chromeProfileMode, 'existing');
  assert.equal(s.chromeProfileName, 'Profile 2');
});

test('state: review transport ledger is atomically persisted and defaults cleanly', async () => {
  const dir = await tempDir();
  assert.deepEqual(await readReviewTransportState(dir), { schemaVersion: 1, bindings: {}, operations: {} });
  const now = Date.now();
  const responseText = 'complete';
  const responseSha256 = (await import('node:crypto')).createHash('sha256').update(responseText, 'utf8').digest('hex');
  const value = {
    schemaVersion: 1,
    bindings: {
      'hmasd-formal-pro': {
        stableKey: 'hmasd-formal-pro',
        provider: 'chatgpt',
        model: 'GPT-5.6 Pro',
        conversationUrl: 'https://chatgpt.com/c/c-1',
        conversationId: 'c-1',
        createdAt: now,
        updatedAt: now
      }
    },
    operations: {
      smoke: {
        operationId: 'operation-1',
        idempotencyKey: 'smoke',
        requestFingerprint: 'f'.repeat(64),
        stableKey: 'hmasd-formal-pro',
        provider: 'chatgpt',
        model: 'GPT-5.6 Pro',
        conversationUrl: 'https://chatgpt.com/c/c-1',
        conversationId: 'c-1',
        promptSha256: 'a'.repeat(64),
        status: 'COMPLETE',
        terminalState: 'NATURAL_COMPLETION_VERIFIED',
        sendCount: 1,
        sendActionCount: 1,
        userMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        responseText,
        responseSha256,
        snapshots: [
          { observedAt: now, assistantMessageId: 'assistant-1', textSha256: responseSha256 },
          { observedAt: now + 3_100, assistantMessageId: 'assistant-1', textSha256: responseSha256 }
        ],
        controls: { stop: false, continue: false, retry: false, answerNow: true },
        clickedControls: [],
        modelEvidence: 'GPT-5.6 Pro',
        createdAt: now,
        updatedAt: now,
        deadlineAt: now + 10_000,
        completedAt: now + 3_100
      }
    }
  };
  await writeReviewTransportState(value, dir);
  assert.deepEqual(await readReviewTransportState(dir), value);
  const missingSendAction = structuredClone(value);
  delete missingSendAction.operations.smoke.sendActionCount;
  await assert.rejects(writeReviewTransportState(missingSendAction, dir), /review_transport_state_invalid/);
});

test('state: corrupt review transport ledger fails closed', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'review-transport.json'), '{not-json', 'utf8');
  await assert.rejects(readReviewTransportState(dir), /review_transport_state_invalid/);
});

test('state: parseable null or malformed nested review records fail closed', async () => {
  const dir = await tempDir();
  await fs.writeFile(
    path.join(dir, 'review-transport.json'),
    JSON.stringify({ schemaVersion: 1, bindings: { key: null }, operations: { op: null } }),
    'utf8'
  );
  await assert.rejects(readReviewTransportState(dir), /review_transport_state_invalid/);
});

test('state: incomplete parseable COMPLETE review receipt fails closed', async () => {
  const dir = await tempDir();
  const now = Date.now();
  const incomplete = {
    schemaVersion: 1,
    bindings: {},
    operations: {
      op: {
        operationId: 'operation-1',
        idempotencyKey: 'op',
        requestFingerprint: 'f'.repeat(64),
        stableKey: 'key',
        provider: 'chatgpt',
        model: 'GPT-5.6 Pro',
        conversationUrl: 'https://chatgpt.com/c/c-1',
        conversationId: 'c-1',
        promptSha256: 'a'.repeat(64),
        status: 'COMPLETE',
        terminalState: 'NATURAL_COMPLETION_VERIFIED',
        sendCount: 1,
        userMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        createdAt: now,
        updatedAt: now,
        deadlineAt: now + 10_000
      }
    }
  };
  await fs.writeFile(path.join(dir, 'review-transport.json'), JSON.stringify(incomplete), 'utf8');
  await assert.rejects(readReviewTransportState(dir), /review_transport_state_invalid/);
});
