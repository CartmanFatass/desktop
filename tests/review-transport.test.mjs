import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  archiveReviewResponse,
  inspectReviewAdmission,
  runReviewQuery
} from '../review-transport.mjs';
import { readReviewTransportState } from '../state.mjs';
import { reviewPlainTextIdentity } from '../review-text-identity.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-review-v4-'));
}

function request(responsePath) {
  return {
    stableKey: 'strict-v4',
    provider: 'chatgpt',
    productModel: 'GPT-5.6 Sol',
    reasoningEffort: 'Pro',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    conversationId: 'conversation-1',
    idempotencyKey: 'operation-1',
    prompt: 'exact prompt',
    responsePath,
    timeoutMs: 5_000
  };
}

function completion() {
  const observedAt = Date.now();
  const text = 'exact assistant response';
  const textSha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    conversationId: 'conversation-1',
    text,
    snapshots: [
      { assistantMessageId: 'assistant-1', textSha256, observedAt },
      { assistantMessageId: 'assistant-1', textSha256, observedAt: observedAt + 3_000 }
    ],
    controls: { stop: false, continue: false, retry: false, answerNow: false },
    clickedControls: []
  };
}

function fakeTabs(controller) {
  return {
    async ensureTab() { return 'tab-1'; },
    async adoptTab() {},
    getControllerById() { return controller; },
    getWindowById() { return { async show() {} }; },
    updateTabUrl() {}
  };
}

async function prepareAndSend(args, onActivation) {
  const identity = reviewPlainTextIdentity(args.prompt);
  await args.onPrepared({ baselineMessageIds: ['history-1'] });
  await args.onComposerVerified({
    ok: true,
    textModel: 'agentify_review_plain_text_v1',
    replacementModel: 'agentify_review_composer_replace_v2',
    sourceSha256: identity.sourceSha256,
    canonicalPromptSha256: identity.canonicalSha256,
    observedCanonicalSha256: identity.canonicalSha256
  });
  await args.onSendAttempted();
  onActivation();
}

test('review transport: exact archive bytes are durable and idempotent', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const first = await archiveReviewResponse({ responsePath, text: 'alpha\nβeta\n' });
  const second = await archiveReviewResponse({ responsePath, text: 'alpha\nβeta\n' });
  assert.deepEqual(
    { ...second, verifiedAt: first.verifiedAt },
    first
  );
  assert.ok(Number.isSafeInteger(first.verifiedAt));
  assert.ok(Number.isSafeInteger(second.verifiedAt));
  assert.equal(await fs.readFile(responsePath, 'utf8'), 'alpha\nβeta\n');
  await assert.rejects(
    archiveReviewResponse({ responsePath, text: 'different' }),
    /review_response_path_conflict/
  );
});

test('review transport: a pre-send error stays retryable and the retry sends once', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const input = request(responsePath);
  let reviewCalls = 0;
  let activations = 0;
  const controller = {
    async reviewQuery(args) {
      reviewCalls += 1;
      if (reviewCalls === 1) throw new Error('synthetic_pre_send_failure');
      await prepareAndSend(args, () => { activations += 1; });
      await args.onUserTurnObserved({
        observedUserMessageId: 'user-1',
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId
      });
      return {
        userMessageId: 'user-1',
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId
      };
    },
    async observeReviewResponse() { return completion(); }
  };

  await assert.rejects(
    runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input }),
    /synthetic_pre_send_failure/
  );
  const failed = (await readReviewTransportState(stateDir)).operations[input.idempotencyKey];
  assert.equal(failed.sendAttempted, false);
  assert.equal(failed.sendAttemptedAt, null);
  assert.deepEqual(failed.error, { code: 'SYNTHETIC_PRE_SEND_FAILURE' });
  assert.equal((await inspectReviewAdmission({ stateDir, request: input })).requiresSendCapacity, true);

  const receipt = await runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input });
  assert.equal(activations, 1);
  assert.equal(receipt.sendAttempted, true);
  assert.ok(Number.isFinite(receipt.sendAttemptedAt));
  assert.equal(receipt.providerUserMessageId, 'user-1');
  assert.equal(receipt.providerAssistantMessageId, 'assistant-1');
  assert.equal(receipt.archive.sha256, crypto.createHash('sha256').update('exact assistant response').digest('hex'));
  assert.equal(await fs.readFile(responsePath, 'utf8'), 'exact assistant response');
});

test('review transport: re-entry after sendAttempted observes only and never activates Send', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const input = request(responsePath);
  let activations = 0;
  let reviewCalls = 0;
  let observationCalls = 0;
  const controller = {
    async reviewQuery(args) {
      reviewCalls += 1;
      await prepareAndSend(args, () => { activations += 1; });
      throw new Error('synthetic_pointer_outcome_unknown');
    },
    async observeReviewUserTurn() {
      observationCalls += 1;
      return {
        userMessageId: null,
        conversationUrl: input.conversationUrl,
        conversationId: input.conversationId
      };
    }
  };
  const tabs = fakeTabs(controller);

  await assert.rejects(
    runReviewQuery({ stateDir, tabs, request: input }),
    /synthetic_pointer_outcome_unknown/
  );
  const unknown = (await readReviewTransportState(stateDir)).operations[input.idempotencyKey];
  assert.equal(unknown.sendAttempted, true);
  assert.equal(unknown.providerUserMessageId, null);

  const receipt = await runReviewQuery({ stateDir, tabs, request: input });
  assert.equal(receipt.sendAttempted, true);
  assert.equal(receipt.providerUserMessageId, null);
  assert.equal(activations, 1);
  assert.equal(reviewCalls, 1);
  assert.equal(observationCalls, 1);
  assert.equal((await inspectReviewAdmission({ stateDir, request: input })).requiresSendCapacity, false);
});
