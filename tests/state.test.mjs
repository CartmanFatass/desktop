import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultReviewTransportState,
  readReviewTransportState,
  writeReviewTransportState
} from '../state.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-state-v4-'));
}

function receipt(overrides = {}) {
  const now = 1_720_000_000_000;
  return {
    schemaVersion: 4,
    operationId: 'operation-id',
    idempotencyKey: 'operation-key',
    requestFingerprint: 'a'.repeat(64),
    stableKey: 'binding-key',
    provider: 'chatgpt',
    productModel: 'GPT-5.6 Sol',
    reasoningEffort: 'Pro',
    conversationUrl: 'https://chatgpt.com/c/current',
    conversationId: 'current',
    promptSha256: 'b'.repeat(64),
    responsePath: '/tmp/response.txt',
    sendAttempted: false,
    sendAttemptedAt: null,
    providerUserMessageId: null,
    providerAssistantMessageId: null,
    observedConversationUrl: null,
    observedConversationId: null,
    archive: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function stateWithReceipt(operation, overrides = {}) {
  return {
    schemaVersion: 4,
    bindings: {},
    operations: { [operation.idempotencyKey]: operation },
    retiredIdempotencyKeys: [],
    retiredStableKeys: [],
    ...overrides
  };
}

test('state: fresh review transport has only the v4 current and retired-key fields', async () => {
  const stateDir = await tempDir();
  assert.deepEqual(defaultReviewTransportState(), {
    schemaVersion: 4,
    bindings: {},
    operations: {},
    retiredIdempotencyKeys: [],
    retiredStableKeys: []
  });
  assert.deepEqual(await readReviewTransportState(stateDir), defaultReviewTransportState());
});

test('state: receipt invariants reject impossible send and message facts', async () => {
  const stateDir = await tempDir();
  await assert.rejects(
    writeReviewTransportState(stateWithReceipt(receipt({ sendAttempted: true })), stateDir),
    /review_transport_state_invalid/
  );
  await assert.rejects(
    writeReviewTransportState(stateWithReceipt(receipt({ providerUserMessageId: 'user-1' })), stateDir),
    /review_transport_state_invalid/
  );
  await assert.rejects(
    writeReviewTransportState(stateWithReceipt(receipt({ providerAssistantMessageId: 'assistant-1' })), stateDir),
    /review_transport_state_invalid/
  );
  await assert.rejects(
    writeReviewTransportState(stateWithReceipt(receipt({
      sendAttempted: true,
      sendAttemptedAt: Date.now(),
      providerUserMessageId: 'user-1',
      archive: {
        path: '/tmp/response.txt',
        sha256: 'c'.repeat(64),
        sizeBytes: 1,
        projection: 'exact',
        verifiedAt: Date.now()
      }
    })), stateDir),
    /review_transport_state_invalid/
  );
  await assert.rejects(
    writeReviewTransportState(stateWithReceipt(receipt({ updatedAt: Date.now() + 0.5 })), stateDir),
    /review_transport_state_invalid/
  );
});

test('state: retired keys are flat no-reuse facts without archive metadata', async () => {
  const stateDir = await tempDir();
  const state = {
    schemaVersion: 4,
    bindings: {},
    operations: {},
    retiredIdempotencyKeys: ['retired-operation'],
    retiredStableKeys: ['retired-binding']
  };
  await writeReviewTransportState(state, stateDir);
  assert.deepEqual(await readReviewTransportState(stateDir), state);

  await assert.rejects(
    writeReviewTransportState({
      ...state,
      retiredIdempotencyKeys: [],
      archive: { sha256: 'd'.repeat(64) }
    }, stateDir),
    /review_transport_state_invalid/
  );
  await assert.rejects(
    writeReviewTransportState(
      stateWithReceipt(receipt({ idempotencyKey: 'retired-operation' }), {
        retiredIdempotencyKeys: ['retired-operation']
      }),
      stateDir
    ),
    /review_transport_state_invalid/
  );
});
