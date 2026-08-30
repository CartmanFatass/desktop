import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultReviewTransportState,
  readReviewTransportState,
  reviewTransportPath,
  writeReviewTransportState
} from '../state.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-state-v3-'));
}

function repairableOperation() {
  const now = Date.now();
  return {
    schemaVersion: 3,
    operationId: 'operation-1',
    idempotencyKey: 'operation-key',
    requestFingerprint: 'fingerprint',
    stableKey: 'stable-key',
    provider: 'chatgpt',
    productModel: 'GPT-5.6 Sol',
    reasoningEffort: 'Pro',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    conversationId: 'conversation-1',
    promptSha256: 'a'.repeat(64),
    responsePath: path.join(os.tmpdir(), 'response.txt'),
    phase: 'PREPARE_UI',
    commitment: 'ZERO_PROVEN',
    recoverability: 'PRECOMMIT_REPAIR',
    observability: 'FRESH_COMPLETE',
    messageCapability: 'AVAILABLE',
    failure: { locus: 'PRECOMMIT_UI', code: 'DIRECT_NO_ACTIVATION_RECEIPT' },
    providerUserMessageCount: 0,
    sendActivationCount: 0,
    attemptCount: 2,
    createdAt: now,
    updatedAt: now
  };
}

function stateWith(operation) {
  return {
    schemaVersion: 3,
    bindings: {
      'stable-key': {
        stableKey: 'stable-key',
        provider: 'chatgpt',
        productModel: 'GPT-5.6 Sol',
        reasoningEffort: 'Pro',
        conversationUrl: 'https://chatgpt.com/c/conversation-1',
        conversationId: 'conversation-1',
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt
      }
    },
    operations: { 'operation-key': operation }
  };
}

test('state: current ledger is v3 only and repairable orthogonal state round-trips', async () => {
  const dir = await tempDir();
  assert.deepEqual(await readReviewTransportState(dir), { schemaVersion: 3, bindings: {}, operations: {} });
  const value = stateWith(repairableOperation());
  await writeReviewTransportState(value, dir);
  assert.deepEqual(await readReviewTransportState(dir), value);
});
test('state: current cutover operation identity remains ordinary current semantics', async () => {
  const dir = await tempDir();
  const idempotencyKey = 'chatgpt_gpt56sol_pro_full_ui_transport_contract_review_20260318';
  const operation = {
    ...repairableOperation(),
    operationId: '40c7053e-0c8f-44af-907f-c4d0b841c66d',
    idempotencyKey
  };
  const value = stateWith(operation);
  value.operations = { [idempotencyKey]: operation };

  await writeReviewTransportState(value, dir);
  const loaded = await readReviewTransportState(dir);
  assert.equal(loaded.operations[idempotencyKey].operationId, operation.operationId);
  assert.deepEqual(
    [
      loaded.operations[idempotencyKey].phase,
      loaded.operations[idempotencyKey].commitment,
      loaded.operations[idempotencyKey].recoverability,
      loaded.operations[idempotencyKey].messageCapability
    ],
    ['PREPARE_UI', 'ZERO_PROVEN', 'PRECOMMIT_REPAIR', 'AVAILABLE']
  );
});


test('state: v2 and unknown ledgers are refused unchanged with an unsupported-version error', async () => {
  for (const schemaVersion of [1, 2, 4]) {
    const dir = await tempDir();
    const file = reviewTransportPath(dir);
    const bytes = `${JSON.stringify({ schemaVersion, bindings: {}, operations: {} }, null, 2)}\n`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, bytes, 'utf8');
    await assert.rejects(readReviewTransportState(dir), /review_transport_state_version_unsupported/);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
});

test('state: legacy overloaded authority fields are rejected', async () => {
  const dir = await tempDir();
  for (const legacy of ['model', 'expectedModel', 'expectedMode', 'modelEvidence', 'status', 'terminalState', 'sendCount', 'sendActionCount', 'newUserMessageCount']) {
    const operation = { ...repairableOperation(), [legacy]: 'legacy' };
    await assert.rejects(writeReviewTransportState(stateWith(operation), dir), /review_transport_state_invalid/);
  }
});

test('state: exact terminal archive requires exact target evidence and raw-byte archive identity', async () => {
  const operation = {
    ...repairableOperation(),
    phase: 'TERMINAL',
    commitment: 'ONE_EXACT',
    recoverability: 'NONE',
    observability: 'FRESH_COMPLETE',
    messageCapability: 'SEALED',
    failure: { locus: 'NONE', code: 'NONE' },
    providerUserMessageCount: 1,
    sendActivationCount: 1,
    userMessageId: 'user-1',
    turnConfirmationMode: 'agentify_review_causal_submission_v1',
    assistantMessageId: 'assistant-1',
    productModelEvidence: {
      requestedProductModel: 'GPT-5.6 Sol',
      matchedLabel: 'GPT-5.6 Sol',
      selectionView: 'chatgpt_product_model_menu',
      role: 'menuitemradio',
      scopedMatchCount: 1
    },
    reasoningEffortEvidence: {
      requestedReasoningEffort: 'Pro',
      matchedLabel: 'Pro',
      selectionView: 'chatgpt_reasoning_effort_slider',
      role: 'slider',
      actionOwner: 'Power',
      scopedMatchCount: 1,
      min: 0,
      max: 4,
      value: 4
    },
    archive: {
      path: path.join(os.tmpdir(), 'response.txt'),
      sha256: 'b'.repeat(64),
      sizeBytes: 17,
      projection: 'exact',
      verifiedAt: Date.now()
    }
  };
  const dir = await tempDir();
  await writeReviewTransportState(stateWith(operation), dir);

  operation.archive = { ...operation.archive, path: path.join(os.tmpdir(), 'raw-response.txt') };
  await assert.rejects(writeReviewTransportState(stateWith(operation), dir), /review_transport_state_invalid/);

  operation.archive = { ...operation.archive, path: operation.responsePath, projection: 'terminal_lf_v1' };
  await assert.rejects(writeReviewTransportState(stateWith(operation), dir), /review_transport_state_invalid/);
});
