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
function legacyState() {
  const now = 1_700_000_000_000;
  return {
    schemaVersion: 2,
    bindings: {
      'legacy-binding': {
        stableKey: 'legacy-binding',
        provider: 'chatgpt',
        model: 'GPT-5.4 Pro',
        conversationUrl: 'https://chatgpt.com/c/legacy-conversation',
        conversationId: 'legacy-conversation',
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
        conversationUrl: 'https://chatgpt.com/c/legacy-conversation',
        conversationId: 'legacy-conversation',
        promptSha256: 'c'.repeat(64),
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

function legacyBytes(state = legacyState()) {
  return Buffer.from(` ${JSON.stringify(state, null, 3)}\n`, 'utf8');
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


test('state: read-only v2 projection preserves provenance without mutating either state or archive', async () => {
  const dir = await tempDir();
  const file = reviewTransportPath(dir);
  const bytes = legacyBytes();
  await fs.writeFile(file, bytes);

  const projected = await readReviewTransportStateReadOnly(dir);

  assert.equal(projected.schemaVersion, 3);
  assert.deepEqual(projected.bindings, {});
  assert.deepEqual(projected.operations, {});
  assert.deepEqual(projected.legacy.bindingKeys, ['legacy-binding']);
  assert.deepEqual(projected.legacy.idempotencyKeys, ['legacy-operation']);
  assert.equal(projected.legacy.sourceSchemaVersion, 2);
  assert.equal(projected.legacy.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(
    fs.readFile(path.join(dir, projected.legacy.archiveBasename)),
    (error) => error?.code === 'ENOENT'
  );
});

test('state: valid v2 cuts over to empty active v3 with an exact immutable archive and reruns idempotently', async () => {
  const dir = await tempDir();
  const file = reviewTransportPath(dir);
  const bytes = legacyBytes();
  await fs.writeFile(file, bytes);

  const cutover = await readReviewTransportState(dir);
  const archivePath = path.join(dir, cutover.legacy.archiveBasename);

  assert.deepEqual(cutover.bindings, {});
  assert.deepEqual(cutover.operations, {});
  assert.deepEqual(await fs.readFile(archivePath), bytes);
  assert.deepEqual(await readReviewTransportState(dir), cutover);
  assert.deepEqual(await fs.readFile(archivePath), bytes);
  await writeReviewTransportState(cutover, dir);
  assert.deepEqual(await readReviewTransportState(dir), cutover);
  assert.deepEqual(await fs.readFile(archivePath), bytes);
});

test('state: matching pre-existing v2 archive resumes cutover and mismatched bytes refuse unchanged', async () => {
  const bytes = legacyBytes();
  for (const matches of [true, false]) {
    const dir = await tempDir();
    const file = reviewTransportPath(dir);
    await fs.writeFile(file, bytes);
    const projected = await readReviewTransportStateReadOnly(dir);
    const archivePath = path.join(dir, projected.legacy.archiveBasename);
    const archiveBytes = matches ? bytes : Buffer.from('not the legacy ledger', 'utf8');
    await fs.writeFile(archivePath, archiveBytes);

    if (matches) {
      const cutover = await readReviewTransportState(dir);
      assert.deepEqual(cutover.legacy, projected.legacy);
    } else {
      await assert.rejects(readReviewTransportState(dir), /review_transport_state_invalid/);
      assert.deepEqual(await fs.readFile(file), bytes);
    }
    assert.deepEqual(await fs.readFile(archivePath), archiveBytes);
  }
});
test('state: unsupported directory fsync still verifies the published archive and completes cutover', async () => {
  for (const code of ['EPERM', 'EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR']) {
    const dir = await tempDir();
    const file = reviewTransportPath(dir);
    const bytes = legacyBytes();
    await fs.writeFile(file, bytes);
    let syncCalls = 0;

    const cutover = await readReviewTransportState(dir, {
      syncDirectory: async () => {
        syncCalls += 1;
        const error = new Error('directory sync unavailable');
        error.code = code;
        throw error;
      }
    });

    assert.equal(syncCalls, 1);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).schemaVersion, 3);
    assert.deepEqual(
      await fs.readFile(path.join(dir, cutover.legacy.archiveBasename)),
      bytes
    );
  }
});

test('state: unexpected directory fsync errors refuse replacement while exact archive retry remains idempotent', async () => {
  const dir = await tempDir();
  const file = reviewTransportPath(dir);
  const bytes = legacyBytes();
  await fs.writeFile(file, bytes);

  await assert.rejects(
    readReviewTransportState(dir, {
      syncDirectory: async () => {
        const error = new Error('synthetic_directory_sync_failure');
        error.code = 'EIO';
        throw error;
      }
    }),
    /synthetic_directory_sync_failure/
  );
  assert.deepEqual(await fs.readFile(file), bytes);

  const projected = await readReviewTransportStateReadOnly(dir);
  const archivePath = path.join(dir, projected.legacy.archiveBasename);
  assert.deepEqual(await fs.readFile(archivePath), bytes);

  let retrySyncCalls = 0;
  const cutover = await readReviewTransportState(dir, {
    syncDirectory: async () => {
      retrySyncCalls += 1;
      throw new Error('existing archive must bypass directory sync');
    }
  });
  assert.equal(retrySyncCalls, 0);
  assert.deepEqual(cutover.legacy, projected.legacy);
  assert.deepEqual(await fs.readFile(archivePath), bytes);
});


test('state: v3 legacy provenance revalidates archive presence, bytes, and tombstone keys', async () => {
  for (const corruption of ['missing', 'bytes', 'keys']) {
    const dir = await tempDir();
    const file = reviewTransportPath(dir);
    const bytes = legacyBytes();
    await fs.writeFile(file, bytes);
    const cutover = await readReviewTransportState(dir);
    const archivePath = path.join(dir, cutover.legacy.archiveBasename);
    if (corruption === 'missing') await fs.rm(archivePath);
    if (corruption === 'bytes') await fs.writeFile(archivePath, 'changed legacy bytes', 'utf8');
    if (corruption === 'keys') {
      const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
      persisted.legacy.idempotencyKeys = [];
      await fs.writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    }
    await assert.rejects(readReviewTransportState(dir), /review_transport_state_invalid/);
  }
});

test('state: corrupt v2 identity and count invariants refuse without mutation', async () => {
  const corruptStates = [];
  const wrongIdentity = legacyState();
  wrongIdentity.operations['legacy-operation'].idempotencyKey = 'other-operation';
  corruptStates.push(wrongIdentity);
  const wrongCount = legacyState();
  wrongCount.operations['legacy-operation'].sendCount = 2;
  corruptStates.push(wrongCount);

  for (const state of corruptStates) {
    const dir = await tempDir();
    const bytes = legacyBytes(state);
    const file = reviewTransportPath(dir);
    await fs.writeFile(file, bytes);
    await assert.rejects(readReviewTransportState(dir), /review_transport_state_invalid/);
    assert.deepEqual(await fs.readFile(file), bytes);
  }
});
test('state: legacy and current ledgers accept Windows absolute response paths and refuse relative paths', async () => {
  const absolutePaths = [
    String.raw`C:\Agentify\responses\review.txt`,
    String.raw`\\server\share\Agentify\responses\review.txt`
  ];

  for (const responsePath of absolutePaths) {
    const legacyDir = await tempDir();
    const legacy = legacyState();
    legacy.operations['legacy-operation'].responsePath = responsePath;
    await fs.writeFile(reviewTransportPath(legacyDir), legacyBytes(legacy));
    assert.equal(
      (await readReviewTransportStateReadOnly(legacyDir)).legacy.idempotencyKeys[0],
      'legacy-operation'
    );

    const currentDir = await tempDir();
    const operation = { ...repairableOperation(), responsePath };
    await writeReviewTransportState(stateWith(operation), currentDir);
    assert.equal(
      (await readReviewTransportState(currentDir)).operations['operation-key'].responsePath,
      responsePath
    );
  }

  const relativePath = path.join('responses', 'review.txt');
  const legacyDir = await tempDir();
  const legacy = legacyState();
  legacy.operations['legacy-operation'].responsePath = relativePath;
  await fs.writeFile(reviewTransportPath(legacyDir), legacyBytes(legacy));
  await assert.rejects(
    readReviewTransportStateReadOnly(legacyDir),
    /review_transport_state_invalid/
  );

  const currentDir = await tempDir();
  const operation = { ...repairableOperation(), responsePath: relativePath };
  await assert.rejects(
    writeReviewTransportState(stateWith(operation), currentDir),
    /review_transport_state_invalid/
  );
});


test('state: unknown ledger versions remain unsupported and unchanged', async () => {
  for (const schemaVersion of [1, 4]) {
    const dir = await tempDir();
    const file = reviewTransportPath(dir);
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion, bindings: {}, operations: {} }, null, 2)}\n`);
    await fs.writeFile(file, bytes);
    await assert.rejects(readReviewTransportState(dir), /review_transport_state_version_unsupported/);
    assert.deepEqual(await fs.readFile(file), bytes);
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
