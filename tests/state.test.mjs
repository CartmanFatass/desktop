import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultReviewTransportState,
  readReviewTransportState,
  readReviewTransportStateReadOnly,
  reviewTransportPath,
  writeReviewTransportState
} from '../state.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-state-v4-'));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function legacyV2State() {
  const now = 1_700_000_000_000;
  return {
    schemaVersion: 2,
    bindings: {
      'legacy-binding': {
        stableKey: 'legacy-binding',
        provider: 'chatgpt',
        model: 'GPT-5.4 Pro',
        conversationUrl: 'https://chatgpt.com/c/legacy',
        conversationId: 'legacy',
        createdAt: now,
        updatedAt: now
      }
    },
    operations: {
      'legacy-operation': {
        schemaVersion: 2,
        operationId: 'legacy-operation-id',
        idempotencyKey: 'legacy-operation',
        requestFingerprint: 'legacy-fingerprint',
        stableKey: 'legacy-binding',
        provider: 'chatgpt',
        model: 'GPT-5.4 Pro',
        conversationUrl: 'https://chatgpt.com/c/legacy',
        conversationId: 'legacy',
        promptSha256: 'd'.repeat(64),
        status: 'SEND_INTENT',
        sendCount: 0,
        sendActionCount: 0,
        newUserMessageCount: 0,
        createdAt: now,
        updatedAt: now
      }
    }
  };
}

function legacyMetadata(rawBytes) {
  const digest = sha256(rawBytes);
  return {
    archiveBasename: `review-transport.v2-${digest}.json`,
    sha256: digest,
    sourceSchemaVersion: 2,
    bindingKeys: ['legacy-binding'],
    idempotencyKeys: ['legacy-operation']
  };
}

function productionV3State(legacy) {
  const createdAt = 1_710_000_000_000;
  const sendBoundaryEnteredAt = 1_710_000_000_500;
  return {
    schemaVersion: 3,
    bindings: {
      'vqfp-binding': {
        stableKey: 'vqfp-binding',
        provider: 'chatgpt',
        productModel: 'GPT-5.6 Sol',
        reasoningEffort: 'Pro',
        conversationUrl: 'https://chatgpt.com/',
        conversationId: '__new__',
        createdAt,
        updatedAt: sendBoundaryEnteredAt
      }
    },
    operations: {
      'vqfp-operation': {
        schemaVersion: 3,
        operationId: 'ff500569-be6a-4b40-b558-9e39892f261a',
        idempotencyKey: 'vqfp-operation',
        requestFingerprint: 'f'.repeat(64),
        stableKey: 'vqfp-binding',
        provider: 'chatgpt',
        productModel: 'GPT-5.6 Sol',
        reasoningEffort: 'Pro',
        conversationUrl: 'https://chatgpt.com/',
        conversationId: '__new__',
        responsePath: '/home/fires/hmasd/vqfp-response.md',
        promptSha256: 'e'.repeat(64),
        phase: 'VERIFY_COMMITMENT',
        commitment: 'UNRESOLVED',
        recoverability: 'OBSERVE_ONLY',
        observability: 'LOST',
        messageCapability: 'SEALED',
        failure: { locus: 'COMMIT_BOUNDARY', code: 'INTERRUPTED_RESERVED_BOUNDARY' },
        providerUserMessageCount: 0,
        sendActivationCount: 0,
        attemptCount: 1,
        sendBoundaryEnteredAt,
        createdAt,
        updatedAt: sendBoundaryEnteredAt
      },
      'completed-operation': {
        schemaVersion: 3,
        operationId: 'completed-operation-id',
        idempotencyKey: 'completed-operation',
        requestFingerprint: 'a'.repeat(64),
        stableKey: 'vqfp-binding',
        provider: 'chatgpt',
        productModel: 'GPT-5.6 Sol',
        reasoningEffort: 'Pro',
        conversationUrl: 'https://chatgpt.com/c/completed',
        conversationId: 'completed',
        responsePath: '/home/fires/hmasd/completed-response.md',
        promptSha256: 'c'.repeat(64),
        phase: 'TERMINAL',
        commitment: 'ONE_EXACT',
        recoverability: 'NONE',
        observability: 'FRESH_COMPLETE',
        messageCapability: 'SEALED',
        failure: { locus: 'NONE', code: 'NONE' },
        providerUserMessageCount: 1,
        sendActivationCount: 1,
        attemptCount: 1,
        sendBoundaryEnteredAt,
        userMessageId: 'provider-user-complete',
        assistantMessageId: 'provider-assistant-complete',
        turnConfirmationMode: 'agentify_review_causal_submission_v1',
        productModelEvidence: {
          requestedProductModel: 'GPT-5.6 Sol',
          matchedLabel: 'GPT-5.6 Sol',
          scopedMatchCount: 1
        },
        reasoningEffortEvidence: {
          requestedReasoningEffort: 'Pro',
          matchedLabel: 'Pro',
          scopedMatchCount: 1,
          role: 'slider',
          actionOwner: 'Power',
          min: 0,
          max: 4,
          value: 4
        },
        archive: {
          path: '/home/fires/hmasd/completed-response.md',
          sha256: 'b'.repeat(64),
          sizeBytes: 17,
          projection: 'exact',
          verifiedAt: sendBoundaryEnteredAt + 4_000
        },
        completedAt: sendBoundaryEnteredAt + 4_000,
        createdAt,
        updatedAt: sendBoundaryEnteredAt + 4_000
      }
    },
    legacy
  };
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

function stateWithReceipt(operation) {
  return {
    schemaVersion: 4,
    bindings: {},
    operations: { [operation.idempotencyKey]: operation }
  };
}

test('state: fresh review transport is the minimal v4 ledger', async () => {
  const stateDir = await tempDir();
  assert.deepEqual(defaultReviewTransportState(), {
    schemaVersion: 4,
    bindings: {},
    operations: {}
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

test('state: exact v3 bytes migrate once to v4 and preserve v2 tombstones and no-resend facts', async () => {
  const stateDir = await tempDir();
  const v2Bytes = Buffer.from(`${JSON.stringify(legacyV2State(), null, 3)}\n`, 'utf8');
  const legacy = legacyMetadata(v2Bytes);
  await fs.writeFile(path.join(stateDir, legacy.archiveBasename), v2Bytes);

  const v3 = productionV3State(legacy);
  const v3Bytes = Buffer.from(`  ${JSON.stringify(v3, null, 1)}\n`, 'utf8');
  await fs.writeFile(reviewTransportPath(stateDir), v3Bytes);
  const expectedV3Archive = `review-transport.v3-${sha256(v3Bytes)}.json`;

  const projectedReadOnly = await readReviewTransportStateReadOnly(stateDir);
  assert.equal(projectedReadOnly.schemaVersion, 4);
  await assert.rejects(fs.access(path.join(stateDir, expectedV3Archive)));
  assert.deepEqual(await fs.readFile(reviewTransportPath(stateDir)), v3Bytes);

  const migrated = await readReviewTransportState(stateDir);
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.legacy, legacy);
  assert.equal(migrated.v3Archive.archiveBasename, expectedV3Archive);
  assert.deepEqual(await fs.readFile(path.join(stateDir, expectedV3Archive)), v3Bytes);
  assert.deepEqual(await fs.readFile(path.join(stateDir, legacy.archiveBasename)), v2Bytes);

  const operation = migrated.operations['vqfp-operation'];
  assert.equal(operation.sendAttempted, true);
  assert.equal(operation.sendAttemptedAt, v3.operations['vqfp-operation'].sendBoundaryEnteredAt);
  assert.equal(operation.providerUserMessageId, null);
  assert.equal(operation.providerAssistantMessageId, null);
  assert.deepEqual(operation.error, { code: 'INTERRUPTED_RESERVED_BOUNDARY' });
  const completed = migrated.operations['completed-operation'];
  assert.equal(completed.providerUserMessageId, 'provider-user-complete');
  assert.equal(completed.providerAssistantMessageId, 'provider-assistant-complete');
  assert.deepEqual(completed.archive, v3.operations['completed-operation'].archive);
  assert.equal(completed.error, null);
  for (const deleted of [
    'phase',
    'commitment',
    'recoverability',
    'observability',
    'messageCapability',
    'providerUserMessageCount',
    'sendActivationCount',
    'attemptCount'
  ]) assert.equal(Object.hasOwn(operation, deleted), false);

  const onceBytes = await fs.readFile(reviewTransportPath(stateDir));
  await readReviewTransportState(stateDir);
  assert.deepEqual(await fs.readFile(reviewTransportPath(stateDir)), onceBytes);
});

test('state: uncut v2 active state is historical input and is never rewritten', async () => {
  const stateDir = await tempDir();
  const bytes = Buffer.from(`${JSON.stringify(legacyV2State(), null, 2)}\n`, 'utf8');
  await fs.writeFile(reviewTransportPath(stateDir), bytes);
  await assert.rejects(readReviewTransportState(stateDir), /review_transport_state_version_unsupported/);
  assert.deepEqual(await fs.readFile(reviewTransportPath(stateDir)), bytes);
});
