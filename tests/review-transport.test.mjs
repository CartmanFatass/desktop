import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { archiveReviewResponse, inspectReviewAdmission, runReviewQuery } from '../review-transport.mjs';
import { readReviewTransportState } from '../state.mjs';
import { reviewPlainTextIdentity } from '../review-text-identity.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-review-v3-'));
}

const productModelEvidence = {
  requestedProductModel: 'GPT-5.6 Sol',
  matchedLabel: 'GPT-5.6 Sol',
  selectionView: 'chatgpt_product_model_menu',
  role: 'menuitemradio',
  scopedMatchCount: 1
};
const reasoningEffortEvidence = {
  requestedReasoningEffort: 'Pro',
  matchedLabel: 'Pro',
  selectionView: 'chatgpt_reasoning_effort_slider',
  role: 'slider',
  actionOwner: 'Power',
  scopedMatchCount: 1,
  min: 0,
  max: 4,
  value: 4
};

function request(responsePath, overrides = {}) {
  return {
    stableKey: 'strict-v3',
    provider: 'chatgpt',
    productModel: 'GPT-5.6 Sol',
    reasoningEffort: 'Pro',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    conversationId: 'conversation-1',
    idempotencyKey: 'operation-1',
    prompt: 'exact prompt',
    responsePath,
    timeoutMs: 5_000,
    ...overrides
  };
}

function completion() {
  const observedAt = Date.now();
  const text = 'exact assistant response';
  const textSha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    status: 'COMPLETE',
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
    clickedControls: [],
    productModelEvidence,
    reasoningEffortEvidence
  };
}

function fakeController({ preBoundaryFailures = 0, crashAfterBoundary = false, crashAfterActivation = false, completeImmediately = false, recoverExactWithoutReceipt = false, recoverAmbiguous = false, holdAfterBoundary = null, onBoundaryHeld = null } = {}) {
  let activations = 0;
  return {
    get activations() { return activations; },
    async reviewQuery(args) {
      if (preBoundaryFailures > 0) {
        preBoundaryFailures -= 1;
        const error = new Error('synthetic_precommit_ui_failure');
        error.data = { noClickProven: true };
        throw error;
      }
      const identity = reviewPlainTextIdentity(args.prompt);
      await args.onPrepared({ baselineMessageIds: ['history-1'], productModelEvidence, reasoningEffortEvidence });
      await args.onComposerVerified({
        ok: true,
        textModel: 'agentify_review_plain_text_v1',
        replacementModel: 'agentify_review_composer_replace_v2',
        sourceSha256: identity.sourceSha256,
        canonicalPromptSha256: identity.canonicalSha256,
        observedCanonicalSha256: identity.canonicalSha256
      });
      await args.onSendBoundaryEntered({ productModelEvidence, reasoningEffortEvidence });
      onBoundaryHeld?.();
      if (holdAfterBoundary) await holdAfterBoundary;
      if (crashAfterBoundary) throw new Error('synthetic_reserved_crash');
      activations += 1;
      await args.onSendAction({ clickCount: 1, sendActivationCount: 1, clickTimeIdentity: { ok: true }, productModelEvidence, reasoningEffortEvidence });
      if (crashAfterActivation) throw new Error('synthetic_unknown_boundary');
      await args.onUserTurnObserved({
        observedUserMessageId: 'user-1',
        providerUserMessageCount: 1,
        commitmentClass: 'turn_exact',
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId
      });
      await args.onSubmitted({ userMessageId: 'user-1', conversationUrl: args.expectedUrl, conversationId: args.expectedConversationId });
      return completeImmediately ? completion() : {
        status: 'SENT_WAITING',
        userMessageId: 'user-1',
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId,
        productModelEvidence,
        reasoningEffortEvidence
      };
    },
    async recoverReviewSubmission(args) {
      if (recoverAmbiguous) throw new Error('review_user_message_identity_ambiguous');
      if (!recoverExactWithoutReceipt) {
        return {
          status: 'COMMITMENT_UNKNOWN',
          conversationUrl: args.expectedUrl,
          conversationId: args.expectedConversationId
        };
      }
      assert.ok(args.causalSubmissionReceipt == null);
      const recovered = {
        status: 'SENT_WAITING',
        userMessageId: 'user-1',
        providerUserMessageCount: 1,
        submittedAt: Date.now(),
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId,
        productModelEvidence,
        reasoningEffortEvidence,
        identityMode: 'agentify_review_observed_exact_turn_v3'
      };
      await args.onRecovered(recovered);
      return recovered;
    },
    async observeReviewResponse() { return completion(); }
  };
}

function fakeTabs(controller) {
  let showCount = 0;
  return {
    async ensureTab() { return 'tab-1'; },
    async adoptTab() {},
    getControllerById() { return controller; },
    getWindowById() {
      return {
        async show() {
          showCount += 1;
        }
      };
    },
    updateTabUrl() {},
    get showCount() { return showCount; }
  };
}

test('review transport: two pre-boundary failures and same-key success consume one provider message', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const controller = fakeController({ preBoundaryFailures: 2 });
  const input = request(responsePath);

  const tabs = fakeTabs(controller);
  await assert.rejects(runReviewQuery({ stateDir, tabs, request: input }), /synthetic_precommit_ui_failure/);
  let admission = await inspectReviewAdmission({ stateDir, request: input });
  assert.equal(admission.repairable, true);
  await assert.rejects(runReviewQuery({ stateDir, tabs, request: input }), /synthetic_precommit_ui_failure/);
  const receipt = await runReviewQuery({ stateDir, tabs, request: input });

  assert.equal(receipt.attemptCount, 3);
  assert.equal(receipt.providerUserMessageCount, 1);
  assert.equal(receipt.sendActivationCount, 1);
  assert.equal(controller.activations, 1);
  assert.equal(tabs.showCount, 3);
  assert.equal(receipt.commitment, 'ONE_EXACT');
  assert.equal(receipt.messageCapability, 'SEALED');
});
test('review transport: concurrent same-key call cannot seal a live ARMED reservation', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  let releaseBoundary;
  let reportBoundary;
  const holdAfterBoundary = new Promise((resolve) => { releaseBoundary = resolve; });
  const boundaryHeld = new Promise((resolve) => { reportBoundary = resolve; });
  const controller = fakeController({
    crashAfterBoundary: true,
    holdAfterBoundary,
    onBoundaryHeld: reportBoundary
  });
  const input = request(responsePath);
  const first = runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input });
  await boundaryHeld;

  await assert.rejects(
    runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input }),
    /review_operation_in_progress/
  );
  const live = (await readReviewTransportState(stateDir)).operations['operation-1'];
  assert.deepEqual(
    [live.phase, live.commitment, live.recoverability, live.messageCapability],
    ['ARMED', 'ZERO_PROVEN', 'OBSERVE_ONLY', 'RESERVED']
  );

  releaseBoundary();
  await assert.rejects(first, /synthetic_reserved_crash/);
});


test('review transport: reserved crash is observe-only and same-key delivery cannot activate', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const controller = fakeController({ crashAfterBoundary: true });
  const input = request(responsePath);

  await assert.rejects(runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input }), /synthetic_reserved_crash/);
  const operation = (await readReviewTransportState(stateDir)).operations['operation-1'];
  assert.deepEqual(
    [operation.phase, operation.commitment, operation.recoverability, operation.messageCapability],
    ['VERIFY_COMMITMENT', 'UNRESOLVED', 'OBSERVE_ONLY', 'SEALED']
  );
  const unresolved = await runReviewQuery({
    stateDir,
    tabs: fakeTabs(controller),
    request: request(responsePath, { verifyExisting: true })
  });
  assert.deepEqual(
    [unresolved.phase, unresolved.commitment, unresolved.recoverability, unresolved.messageCapability],
    ['VERIFY_COMMITMENT', 'UNRESOLVED', 'OBSERVE_ONLY', 'SEALED']
  );
  await assert.rejects(runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input }), /review_delivery_replay_forbidden/);
  assert.equal(controller.activations, 0);
});
test('review transport: crash after native activation but before local receipt resolves from one exact observed turn without inferring activation', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const controller = fakeController({ crashAfterBoundary: true, recoverExactWithoutReceipt: true });
  const input = request(responsePath);

  await assert.rejects(runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input }), /synthetic_reserved_crash/);
  const complete = await runReviewQuery({
    stateDir,
    tabs: fakeTabs(controller),
    request: request(responsePath, { verifyExisting: true })
  });

  assert.equal(complete.phase, 'TERMINAL');
  assert.equal(complete.commitment, 'ONE_EXACT');
  assert.equal(complete.providerUserMessageCount, 1);
  assert.equal(complete.sendActivationCount, 0);
  assert.equal(complete.turnConfirmationMode, 'agentify_review_observed_exact_turn_v3');
  assert.equal(controller.activations, 0);
});
test('review transport: ambiguous recovery observation becomes a sealed commitment violation', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const controller = fakeController({ crashAfterBoundary: true, recoverAmbiguous: true });
  const input = request(responsePath);

  await assert.rejects(runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input }), /synthetic_reserved_crash/);
  await assert.rejects(
    runReviewQuery({
      stateDir,
      tabs: fakeTabs(controller),
      request: request(responsePath, { verifyExisting: true })
    }),
    /review_user_message_identity_ambiguous/
  );
  const operation = (await readReviewTransportState(stateDir)).operations['operation-1'];
  assert.deepEqual(
    [operation.phase, operation.commitment, operation.recoverability, operation.observability, operation.messageCapability],
    ['TERMINAL', 'VIOLATION', 'HUMAN_INTERLOCK', 'CONTRADICTORY', 'SEALED']
  );
});



test('review transport: uncertain native activation seals capability and never resends', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const controller = fakeController({ crashAfterActivation: true });
  const input = request(responsePath);

  await assert.rejects(runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input }), /synthetic_unknown_boundary/);
  const operation = (await readReviewTransportState(stateDir)).operations['operation-1'];
  assert.equal(operation.sendActivationCount, 1);
  assert.equal(operation.commitment, 'UNRESOLVED');
  assert.equal(operation.messageCapability, 'SEALED');
  await assert.rejects(runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input }), /review_delivery_replay_forbidden/);
  assert.equal(controller.activations, 1);
});

test('review transport: exact one-message observation publishes raw archive and exact target receipt', async () => {
  const stateDir = await tempDir();
  const responsePath = path.join(stateDir, 'response.txt');
  const controller = fakeController();
  const input = request(responsePath);
  const waiting = await runReviewQuery({ stateDir, tabs: fakeTabs(controller), request: input });
  assert.equal(waiting.phase, 'WAIT_RESPONSE');

  const complete = await runReviewQuery({
    stateDir,
    tabs: fakeTabs(controller),
    request: request(responsePath, { verifyExisting: true })
  });
  assert.equal(complete.phase, 'TERMINAL');
  assert.equal(complete.commitment, 'ONE_EXACT');
  assert.equal(complete.providerUserMessageCount, 1);
  assert.equal(complete.sendActivationCount, 1);
  assert.deepEqual(complete.productModelEvidence, productModelEvidence);
  assert.deepEqual(complete.reasoningEffortEvidence, reasoningEffortEvidence);
  assert.equal(complete.archive.projection, 'exact');
  assert.equal(await fs.readFile(responsePath, 'utf8'), 'exact assistant response');
});
test('review transport: concurrent different archive writers never replace the winning immutable bytes', async () => {
  const dir = await tempDir();
  const responsePath = path.join(dir, 'immutable-response.txt');
  const attempts = await Promise.allSettled([
    archiveReviewResponse({ responsePath, text: 'first exact response' }),
    archiveReviewResponse({ responsePath, text: 'second exact response' })
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.match(String(attempts.find((attempt) => attempt.status === 'rejected').reason?.message), /review_response_path_conflict/);
  assert.ok(['first exact response', 'second exact response'].includes(await fs.readFile(responsePath, 'utf8')));
});
