import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

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
import { inspectReviewAdmission } from '../review-transport.mjs';

async function tempDir() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  return base;
}

function completeReviewState({ schemaVersion = 2, includeSendActionCount = true } = {}) {
  const now = 1_785_524_715_964;
  const responseText = 'complete';
  const responseSha256 = crypto.createHash('sha256').update(responseText, 'utf8').digest('hex');
  const operation = {
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
    updatedAt: now + 3_100,
    deadlineAt: now + 10_000,
    completedAt: now + 3_100
  };
  if (includeSendActionCount) operation.sendActionCount = 1;
  return {
    schemaVersion,
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
    operations: { smoke: operation }
  };
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
  assert.deepEqual(await readReviewTransportState(dir), { schemaVersion: 2, bindings: {}, operations: {} });
  const value = completeReviewState();
  await writeReviewTransportState(value, dir);
  assert.deepEqual(await readReviewTransportState(dir), value);
  const missingSendAction = structuredClone(value);
  delete missingSendAction.operations.smoke.sendActionCount;
  await assert.rejects(writeReviewTransportState(missingSendAction, dir), /review_transport_state_invalid/);
});

test('state: valid schema v1 COMPLETE migrates sendActionCount with deterministic provenance', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'review-transport.json');
  const legacy = completeReviewState({ schemaVersion: 1, includeSendActionCount: false });
  await fs.writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const migrated = await readReviewTransportState(dir);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.operations.smoke.sendActionCount, 1);
  assert.deepEqual(migrated.migrationHistory, [{
    migrationId: 'review_transport_v1_to_v2_complete_send_action_count',
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    inferredFields: [{
      idempotencyKey: 'smoke',
      operationId: 'operation-1',
      field: 'sendActionCount',
      value: 1,
      basis: 'validated_complete_send_and_completion_evidence'
    }]
  }]);
  const firstPersisted = await fs.readFile(file, 'utf8');
  assert.deepEqual(await readReviewTransportState(dir), migrated);
  assert.equal(await fs.readFile(file, 'utf8'), firstPersisted);
  assert.deepEqual(await writeReviewTransportState(migrated, dir), migrated);
  assert.equal(await fs.readFile(file, 'utf8'), firstPersisted);
});

test('state: schema v1 COMPLETE missing sendActionCount is not migrated unless every other completion invariant holds', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'review-transport.json');
  const legacy = completeReviewState({ schemaVersion: 1, includeSendActionCount: false });
  legacy.operations.smoke.snapshots[1].textSha256 = '0'.repeat(64);
  const original = `${JSON.stringify(legacy, null, 2)}\n`;
  await fs.writeFile(file, original, 'utf8');

  await assert.rejects(readReviewTransportState(dir), /review_transport_state_invalid/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('state: fresh strict admission succeeds after valid legacy migration without treating it as an existing operation', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'review-transport.json');
  await fs.writeFile(
    file,
    `${JSON.stringify(completeReviewState({ schemaVersion: 1, includeSendActionCount: false }), null, 2)}\n`,
    'utf8'
  );
  const prompt = 'fresh strict prompt';
  const admission = await inspectReviewAdmission({
    stateDir: dir,
    request: {
      stableKey: 'fresh-strict-key',
      provider: 'chatgpt',
      model: 'GPT-5.6 Pro',
      conversationUrl: 'https://chatgpt.com/c/fresh-strict',
      conversationId: 'fresh-strict',
      idempotencyKey: 'fresh-strict-operation',
      prompt,
      promptSha256: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
      timeoutMs: 60_000
    }
  });
  assert.equal(admission.exactExisting, false);
  assert.equal(admission.observationOnly, false);
  assert.equal(admission.requiresSendCapacity, true);
  assert.equal((await readReviewTransportState(dir)).schemaVersion, 2);
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
