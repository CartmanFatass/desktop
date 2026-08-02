import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runReviewQuery, sanitizeReviewErrorData } from '../review-transport.mjs';
import { readReviewTransportState, writeReviewTransportState } from '../state.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

async function fixture() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-review-transport-'));
  const calls = { review: 0, observe: 0, recover: 0, inspect: 0, inspectSubmission: 0, ensure: [], update: [] };
  let failBeforeSubmittedReceipt = false;
  let reviewFailure = null;
  let sendControlFailure = null;
  let diagnosticResult = null;
  let submissionDiagnosticResult = null;
  let fixturePrompt = '';
  const composerIdentityFields = () => ({
    composerPromptSha256: sha256(fixturePrompt),
    composerIdentity: {
      ok: true,
      serializerOk: true,
      serializerMethod: 'contenteditable_structural',
      serializerError: null,
      serializerTag: null,
      serializedLength: fixturePrompt.length,
      observedLengths: [fixturePrompt.length],
      expectedLength: fixturePrompt.length,
      candidateCount: 1,
      rootTag: 'DIV',
      elementCount: 1,
      textNodeCount: 1,
      otherNodeCount: 0,
      maxDepth: 1,
      tagHistogram: { DIV: 1 }
    }
  });
  const exactIdentityFields = () => ({
    identityMode: 'rendered_exact',
    composerPromptSha256: sha256(fixturePrompt),
    newUserMessageCount: 1,
    renderedIdentityDiagnostic: {
      serializerOk: true,
      serializerMethod: 'rendered_user_message_structural',
      serializerError: null,
      serializerTag: null,
      serializedLength: fixturePrompt.length,
      observedLengths: [fixturePrompt.length],
      expectedLength: fixturePrompt.length,
      newUserMessageCount: 1,
      renderedContentCandidateCount: 4,
      exactMatchCount: 1,
      readableCandidateCount: 1,
      rootTag: 'DIV',
      elementCount: 1,
      textNodeCount: 1,
      otherNodeCount: 0,
      maxDepth: 1,
      tagHistogram: { DIV: 1 }
    }
  });
  let exclusiveTail = Promise.resolve();
  const controller = {
    async runExclusive(fn) {
      const previous = exclusiveTail;
      let release;
      exclusiveTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    async reviewQuery(args) {
      calls.review += 1;
      const submittedUrl = args.firstBinding ? 'https://chatgpt.com/c/first-bound' : args.expectedUrl;
      const submittedId = args.firstBinding ? 'first-bound' : args.expectedConversationId;
      await args.onPrepared({
        baselineMessageIds: ['historical-user-1'],
        preparedAt: 50,
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId,
        modelEvidence: 'GPT-5.6 Pro'
      });
      if (reviewFailure) throw reviewFailure;
      if (sendControlFailure) throw sendControlFailure;
      await args.onSendAction({
        clickCount: 1,
        sendActionCount: 1,
        sendActionAt: 90
      });
      if (failBeforeSubmittedReceipt) throw new Error('simulated_crash_after_send_intent');
      await args.onSubmitted({
        userMessageId: 'user-1',
        submittedAt: 100,
        conversationUrl: submittedUrl,
        conversationId: submittedId,
        modelEvidence: 'GPT-5.6 Pro',
        ...exactIdentityFields()
      });
      return {
        userMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        text: 'SMOKE_OK',
        snapshots: [
          { observedAt: 1000, assistantMessageId: 'assistant-1', textSha256: sha256('SMOKE_OK') },
          { observedAt: 4100, assistantMessageId: 'assistant-1', textSha256: sha256('SMOKE_OK') }
        ],
        controls: { stop: false, continue: false, retry: false, answerNow: false },
        conversationUrl: submittedUrl,
        conversationId: submittedId,
        modelEvidence: 'GPT-5.6 Pro'
      };
    },
    async observeReviewResponse(args) {
      calls.observe += 1;
      return {
        userMessageId: args.userMessageId,
        assistantMessageId: 'assistant-1',
        text: 'SMOKE_OK',
        snapshots: [
          { observedAt: 5000, assistantMessageId: 'assistant-1', textSha256: sha256('SMOKE_OK') },
          { observedAt: 8100, assistantMessageId: 'assistant-1', textSha256: sha256('SMOKE_OK') }
        ],
        controls: { stop: false, continue: false, retry: false, answerNow: false },
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId,
        modelEvidence: 'GPT-5.6 Pro'
      };
    },
    async recoverReviewSubmission(args) {
      calls.recover += 1;
      assert.deepEqual(args.baselineMessageIds, ['historical-user-1']);
      assert.equal(args.exactComposerCausalBinding, true);
      await args.onRecovered({
        userMessageId: 'user-1',
        submittedAt: 100,
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId,
        modelEvidence: 'GPT-5.6 Pro',
        ...exactIdentityFields()
      });
      return {
        userMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        text: 'SMOKE_OK',
        snapshots: [
          { observedAt: 9000, assistantMessageId: 'assistant-1', textSha256: sha256('SMOKE_OK') },
          { observedAt: 12100, assistantMessageId: 'assistant-1', textSha256: sha256('SMOKE_OK') }
        ],
        controls: { stop: false, continue: false, retry: false, answerNow: false },
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId,
        modelEvidence: 'GPT-5.6 Pro'
      };
    },
    async inspectReviewComposerIdentity() {
      calls.inspect += 1;
      return diagnosticResult;
    },
    async inspectReviewSubmissionIdentity() {
      calls.inspectSubmission += 1;
      return submissionDiagnosticResult;
    }
  };
  const tabs = {
    async ensureTab(args) {
      calls.ensure.push(args);
      return 'tab-1';
    },
    getControllerById() {
      return controller;
    },
    updateTabUrl(tabId, url) {
      calls.update.push({ tabId, url });
    }
  };
  const prompt = 'Return exactly SMOKE_OK.';
  fixturePrompt = prompt;
  const request = {
    stableKey: 'hmasd-agentify-transport-smoke',
    provider: 'chatgpt',
    model: 'GPT-5.6 Pro',
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    conversationId: 'conversation-1',
    idempotencyKey: 'hmasd-agentify-transport-smoke',
    prompt,
    promptSha256: sha256(prompt),
    timeoutMs: 45 * 60_000
  };
  return {
    stateDir,
    calls,
    tabs,
    request,
    setFailBeforeSubmittedReceipt(value) {
      failBeforeSubmittedReceipt = !!value;
    },
    setReviewFailure(error, diagnostic) {
      reviewFailure = error;
      diagnosticResult = diagnostic;
    },
    setSendControlFailure(error) {
      sendControlFailure = error;
    },
    setSubmissionDiagnostic(diagnostic) {
      submissionDiagnosticResult = diagnostic;
    }
  };
}

test('review transport: mismatch diagnostics retain only non-content structural metadata', () => {
  assert.deepEqual(sanitizeReviewErrorData({
    ok: false,
    serializerOk: false,
    serializerMethod: 'contenteditable_structural',
    serializerError: 'review_composer_element_unsupported',
    serializerTag: 'PRE',
    serializedLength: 0,
    observedLengths: [2889, 2743],
    expectedLength: 2810,
    rootTag: 'DIV',
    elementCount: 21,
    textNodeCount: 12,
    otherNodeCount: 0,
    maxDepth: 4,
    tagHistogram: { DIV: 2, PRE: 8, 'bad tag': 99 },
    prompt: 'must-not-persist',
    text: 'must-not-persist',
    arbitrary: { nested: 'must-not-persist' }
  }), {
    ok: false,
    serializerOk: false,
    serializerMethod: 'contenteditable_structural',
    serializerError: 'review_composer_element_unsupported',
    serializerTag: 'PRE',
    rootTag: 'DIV',
    serializedLength: 0,
    expectedLength: 2810,
    elementCount: 21,
    textNodeCount: 12,
    otherNodeCount: 0,
    maxDepth: 4,
    observedLengths: [2889, 2743],
    tagHistogram: { DIV: 2, PRE: 8 }
  });
});

test('review transport: composer mismatch persists observe-only sanitized diagnostics', async () => {
  const f = await fixture();
  const error = new Error('review_composer_identity_mismatch');
  error.data = { serializerOk: false, serializerTag: 'PRE', prompt: 'must-not-persist' };
  f.setReviewFailure(error, {
    ok: false,
    serializerOk: false,
    serializerMethod: 'contenteditable_structural',
    serializerError: 'review_composer_element_unsupported',
    serializerTag: 'PRE',
    serializedLength: 0,
    observedLengths: [2889, 2743],
    expectedLength: 2810,
    rootTag: 'DIV',
    elementCount: 40,
    textNodeCount: 24,
    otherNodeCount: 0,
    maxDepth: 4,
    tagHistogram: { CODE: 8, DIV: 2, PRE: 8 },
    prompt: 'must-not-persist'
  });
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_composer_identity_mismatch/
  );
  const state = await readReviewTransportState(f.stateDir);
  const operation = state.operations[f.request.idempotencyKey];
  assert.equal(operation.status, 'BLOCKED');
  assert.equal(operation.sendCount, 0);
  assert.equal(operation.sendActionCount, 0);
  assert.equal(operation.failureStage, 'before_send_click');
  assert.equal(operation.terminalState, 'IDENTITY_UNREADABLE');
  assert.equal(operation.errorData.serializerTag, 'PRE');
  assert.deepEqual(operation.errorData.tagHistogram, { CODE: 8, DIV: 2, PRE: 8 });
  assert.equal(JSON.stringify(operation.errorData).includes('must-not-persist'), false);
  assert.equal(f.calls.inspect, 1);
});

test('review transport: expired blocked operation permits one metadata-only submission diagnosis', async () => {
  const f = await fixture();
  const error = new Error('review_user_message_identity_unreadable');
  f.setReviewFailure(error, null);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_user_message_identity_unreadable/
  );
  const expired = await readReviewTransportState(f.stateDir);
  expired.operations[f.request.idempotencyKey].deadlineAt = Date.now() - 1;
  await writeReviewTransportState(expired, f.stateDir);
  f.setSubmissionDiagnostic({
    ok: false,
    serializerOk: false,
    serializerMethod: 'rendered_user_message_structural',
    serializerError: 'review_composer_element_unsupported',
    serializerTag: 'PRE',
    serializedLength: 0,
    observedLengths: [],
    expectedLength: f.request.prompt.length,
    candidateCount: 1,
    rootTag: 'DIV',
    elementCount: 9,
    textNodeCount: 4,
    otherNodeCount: 0,
    maxDepth: 3,
    tagHistogram: { CODE: 4, DIV: 1, PRE: 4 },
    prompt: 'must-not-persist'
  });
  const diagnosed = await runReviewQuery({
    stateDir: f.stateDir,
    tabs: f.tabs,
    request: { ...f.request, diagnoseExisting: true }
  });
  assert.equal(diagnosed.status, 'BLOCKED');
  assert.equal(diagnosed.sendCount, 0);
  assert.equal(diagnosed.diagnosticOnly, true);
  assert.equal(diagnosed.errorData.serializerTag, 'PRE');
  assert.deepEqual(diagnosed.errorData.tagHistogram, { CODE: 4, DIV: 1, PRE: 4 });
  assert.equal(JSON.stringify(diagnosed.errorData).includes('must-not-persist'), false);
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.inspectSubmission, 1);
});

test('review transport: legacy zero-send blocked operation is not reusable without pre-click evidence', async () => {
  const f = await fixture();
  const error = new Error('review_composer_identity_mismatch');
  f.setReviewFailure(error, { serializerOk: false, serializerTag: 'PRE' });
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_composer_identity_mismatch/
  );
  const legacy = await readReviewTransportState(f.stateDir);
  delete legacy.operations[f.request.idempotencyKey].sendActionCount;
  delete legacy.operations[f.request.idempotencyKey].failureStage;
  await writeReviewTransportState(legacy, f.stateDir);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_operation_closed_create_fresh/
  );
  assert.equal(f.calls.review, 1);
});

test('review transport: deterministic send-control rejection remains an eligible pre-click failure', async () => {
  const f = await fixture();
  const error = new Error('review_send_control_ambiguous');
  error.data = { ok: false, clickCount: 0, noClickProven: true };
  f.setSendControlFailure(error);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_send_control_ambiguous/
  );
  const state = await readReviewTransportState(f.stateDir);
  const operation = state.operations[f.request.idempotencyKey];
  assert.equal(operation.sendActionCount, 0);
  assert.equal(operation.sendCount, 0);
  assert.equal(operation.failureStage, 'before_send_click');
  assert.equal(operation.terminalState, 'IDENTITY_UNREADABLE');
  assert.equal(operation.errorData.noClickProven, true);
});

test('review transport: one send persists a complete receipt and duplicate returns it', async () => {
  const f = await fixture();
  const first = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  assert.equal(first.status, 'COMPLETE');
  assert.equal(first.sendCount, 1);
  assert.equal(first.promptSha256, sha256(f.request.prompt));
  assert.equal(first.responseSha256, sha256('SMOKE_OK'));
  assert.equal(first.userMessageId, 'user-1');
  assert.equal(first.assistantMessageId, 'assistant-1');
  assert.equal(first.sendActionCount, 1);
  assert.equal('submissionIdentityMode' in first, false);
  assert.equal('composerPromptSha256' in first, false);
  assert.equal(f.calls.review, 1);

  const duplicate = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  assert.equal(duplicate.status, 'COMPLETE');
  assert.equal(duplicate.operationId, first.operationId);
  assert.equal(f.calls.review, 1);
});

test('review transport: first ChatGPT binding captures the created conversation after one strict send', async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    stableKey: 'first-binding-key',
    idempotencyKey: 'first-binding-op',
    conversationUrl: 'https://chatgpt.com/',
    conversationId: '__new__',
    firstBinding: true
  };
  const receipt = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request });
  assert.equal(receipt.conversationUrl, 'https://chatgpt.com/c/first-bound');
  assert.equal(receipt.conversationId, 'first-bound');
  assert.deepEqual(f.calls.update, [{ tabId: 'tab-1', url: 'https://chatgpt.com/c/first-bound' }]);
  const state = await readReviewTransportState(f.stateDir);
  assert.equal(state.bindings['first-binding-key'].conversationId, 'first-bound');
  assert.equal(state.operations['first-binding-op'].conversationId, 'first-bound');
});

test('review transport: Gemini uses the same strict receipt lifecycle with provider-specific identity', async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    stableKey: 'gemini-review-key',
    idempotencyKey: 'gemini-review-op',
    provider: 'gemini',
    model: 'Gemini 2.5 Pro',
    conversationUrl: 'https://gemini.google.com/app/gemini-conversation',
    conversationId: 'gemini-conversation'
  };
  const receipt = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request });
  assert.equal(receipt.provider, 'gemini');
  assert.equal(receipt.conversationId, 'gemini-conversation');
  assert.equal(f.calls.ensure[0].vendorName, 'Gemini');
  assert.equal(f.calls.review, 1);
});

test('review transport: conflicting idempotency payload is rejected without another send', async () => {
  const f = await fixture();
  await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  const prompt = 'different';
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: { ...f.request, prompt, promptSha256: sha256(prompt) }
    }),
    /review_idempotency_conflict/
  );
  assert.equal(f.calls.review, 1);
});

test('review transport: restart verification is observe-only and bound to the same operation', async () => {
  const f = await fixture();
  const first = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  const verified = await runReviewQuery({
    stateDir: f.stateDir,
    tabs: f.tabs,
    request: { ...f.request, verifyExisting: true }
  });
  assert.equal(verified.operationId, first.operationId);
  assert.equal(verified.responseSha256, first.responseSha256);
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.observe, 1);
});

test('review transport: stable-key mismatch fails while caller prompt hash is ignored', async () => {
  const f = await fixture();
  await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: {
        ...f.request,
        idempotencyKey: 'other-op',
        conversationUrl: 'https://chatgpt.com/c/conversation-2',
        conversationId: 'conversation-2'
      }
    }),
    /review_binding_mismatch/
  );
  const retry = await runReviewQuery({
    stateDir: f.stateDir,
    tabs: f.tabs,
    request: { ...f.request, idempotencyKey: 'hash-ignored', promptSha256: '0'.repeat(64) }
  });
  assert.equal(retry.status, 'COMPLETE');
  assert.equal(f.calls.review, 2);
});

test('review transport: timeout above 45 minutes is rejected before tab or send', async () => {
  const f = await fixture();
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: { ...f.request, timeoutMs: 45 * 60_000 + 1 }
    }),
    /review_timeout_out_of_range/
  );
  assert.equal(f.calls.review, 0);
  assert.equal(f.calls.ensure.length, 0);
});

test('review transport: failed operation stays closed and one fresh recovery operation may resend', async () => {
  const f = await fixture();
  f.setFailBeforeSubmittedReceipt(true);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /simulated_crash_after_send_intent/
  );
  const uncertain = await readReviewTransportState(f.stateDir);
  assert.equal(uncertain.operations[f.request.idempotencyKey].status, 'BLOCKED');
  assert.equal(uncertain.operations[f.request.idempotencyKey].terminalState, 'SUBMITTED_UNVERIFIED');
  assert.equal(uncertain.operations[f.request.idempotencyKey].sendActionCount, 1);
  assert.equal(uncertain.operations[f.request.idempotencyKey].sendCount, 0);
  assert.equal(uncertain.operations[f.request.idempotencyKey].failureStage, 'send_occurred_or_uncertain');
  f.setFailBeforeSubmittedReceipt(false);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_operation_closed_create_fresh/
  );
  const recovered = await runReviewQuery({
    stateDir: f.stateDir,
    tabs: f.tabs,
    request: { ...f.request, idempotencyKey: 'fresh-recovery' }
  });
  assert.equal(recovered.status, 'COMPLETE');
  assert.equal(recovered.sendCount, 1);
  assert.equal(f.calls.review, 2);
  assert.equal(f.calls.recover, 0);
});

test('review transport: concurrent identical calls re-read terminal state and send once', async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request })
  ]);
  assert.equal(first.operationId, second.operationId);
  assert.equal(first.status, 'COMPLETE');
  assert.equal(second.status, 'COMPLETE');
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.recover, 0);
});

test('review transport: a failed operation cannot itself send again', async () => {
  const f = await fixture();
  f.setFailBeforeSubmittedReceipt(true);
  const request = { ...f.request, idempotencyKey: 'deadline-test', timeoutMs: 1_000 };
  await assert.rejects(runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request }), /simulated_crash_after_send_intent/);
  f.setFailBeforeSubmittedReceipt(false);
  await assert.rejects(runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request }), /review_operation_closed_create_fresh/);
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.recover, 0);
});
