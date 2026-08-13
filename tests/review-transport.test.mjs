import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  prepareReviewPromptInput,
  resolveReviewPromptInput,
  inspectReviewAdmission,
  runReviewQuery,
  sanitizeReviewErrorData
} from '../review-transport.mjs';
import { readReviewTransportState, writeReviewTransportState } from '../state.mjs';
import { REVIEW_PLAIN_TEXT_MODEL, reviewPlainTextIdentity } from '../review-text-identity.mjs';
import { REVIEW_COMPOSER_REPLACEMENT_MODEL } from '../review-composer-replacement.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

async function fixture() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-review-transport-'));
  const calls = { review: 0, reviewPrompts: [], observe: 0, observeArgs: [], forbidden: 0, recover: 0, inspect: 0, inspectSubmission: 0, adopt: [], ensure: [], update: [] };
  let failBeforeSubmittedReceipt = false;
  let postClickFailure = null;
  let failAfterSubmittedReceipt = false;
  let firstBindingSubmittedUrl = 'https://chatgpt.com/c/first-bound';
  let reviewFailure = null;
  let sendControlFailure = null;
  let observedTurnFailure = null;
  let observeFailure = null;
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
      calls.reviewPrompts.push(args.prompt);
      const submittedUrl = args.firstBinding ? firstBindingSubmittedUrl : args.expectedUrl;
      const submittedId = args.firstBinding ? firstBindingSubmittedUrl.split('/').at(-1) : args.expectedConversationId;
      await args.onPrepared({
        baselineMessageIds: ['historical-user-1'],
        preparedAt: 50,
        conversationUrl: args.expectedUrl,
        conversationId: args.expectedConversationId,
        modelEvidence: 'GPT-5.6 Pro'
      });
      await args.onComposerVerified?.({
        ok: true,
        textModel: REVIEW_PLAIN_TEXT_MODEL,
        replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
        composerKind: 'contenteditable',
        clearMethod: 'already_empty',
        selectionVerified: true,
        deleteKeyCount: 0,
        initialSerializerOk: true,
        initialSerializedLength: 0,
        emptyVerified: true,
        emptySnapshotCount: 2,
        caretVerified: true,
        caretMethod: 'contenteditable_collapsed_range',
        promptInsertCount: 1,
        sourceSha256: reviewPlainTextIdentity(args.prompt).sourceSha256,
        canonicalPromptSha256: reviewPlainTextIdentity(args.prompt).canonicalSha256,
        observedCanonicalSha256: reviewPlainTextIdentity(args.prompt).canonicalSha256,
        identityMode: 'canonical_exact'
      });
      if (reviewFailure) throw reviewFailure;
      if (sendControlFailure) throw sendControlFailure;
      await args.onSendAction({
        clickCount: 1,
        sendActionCount: 1,
        sendActionAt: 90,
        clickTimeIdentity: {
          ok: true,
          recoveredExact: true,
          textModel: REVIEW_PLAIN_TEXT_MODEL,
          identityMode: 'canonical_exact',
          sourceSha256: reviewPlainTextIdentity(args.prompt).sourceSha256,
          canonicalPromptSha256: reviewPlainTextIdentity(args.prompt).canonicalSha256,
          observedCanonicalSha256: reviewPlainTextIdentity(args.prompt).canonicalSha256,
          serializedLength: args.prompt.length,
          expectedLength: args.prompt.length
        }
      });
      if (postClickFailure) throw postClickFailure;
      if (failBeforeSubmittedReceipt) throw new Error('simulated_crash_after_send_intent');
      const observedTurn = observedTurnFailure?.receipt || {
        observedUserMessageId: 'user-1',
        observedAt: 95,
        conversationUrl: submittedUrl,
        conversationId: submittedId,
        modelEvidence: 'GPT-5.6 Pro',
        commitmentClass: 'turn_exact',
        serializerOk: true,
        serializerMethod: 'rendered_user_message_structural',
        serializerError: null,
        serializerTag: null,
        serializedLength: args.prompt.length,
        observedLengths: [args.prompt.length],
        expectedLength: args.prompt.length,
        newUserMessageCount: 1,
        readableCandidateCount: 1,
        exactMatchCount: 1
      };
      await args.onUserTurnObserved?.(observedTurn);
      if (observedTurnFailure) throw observedTurnFailure.error;
      await args.onSubmitted({
        userMessageId: 'user-1',
        submittedAt: 100,
        conversationUrl: submittedUrl,
        conversationId: submittedId,
        modelEvidence: 'GPT-5.6 Pro',
        sourcePromptSha256: reviewPlainTextIdentity(args.prompt).sourceSha256,
        canonicalPromptSha256: reviewPlainTextIdentity(args.prompt).canonicalSha256,
        renderedIdentityMode: 'canonical_exact',
        ...exactIdentityFields()
      });
      if (failAfterSubmittedReceipt) throw new Error('simulated_crash_after_submitted_receipt');
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
      calls.observeArgs.push(args);
      if (observeFailure) throw observeFailure;
      const recoveredUrl = args.expectedConversationId?.startsWith('WEB:')
        ? 'https://chatgpt.com/c/canonical-bound'
        : args.expectedUrl;
      const recoveredId = args.expectedConversationId?.startsWith('WEB:')
        ? 'canonical-bound'
        : args.expectedConversationId;
      return {
        userMessageId: args.userMessageId,
        assistantMessageId: 'assistant-1',
        text: 'SMOKE_OK',
        snapshots: [
          { observedAt: 5000, assistantMessageId: 'assistant-1', textSha256: sha256('SMOKE_OK') },
          { observedAt: 8100, assistantMessageId: 'assistant-1', textSha256: sha256('SMOKE_OK') }
        ],
        controls: { stop: false, continue: false, retry: false, answerNow: false },
        conversationUrl: recoveredUrl,
        conversationId: recoveredId,
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
    async adoptTab(args) {
      calls.adopt.push(args);
      return args.id;
    },
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
    setPostClickFailure(error) {
      postClickFailure = error;
    },
    setFailAfterSubmittedReceipt(value) {
      failAfterSubmittedReceipt = !!value;
    },
    setFirstBindingSubmittedUrl(value) {
      firstBindingSubmittedUrl = value;
    },
    setReviewFailure(error, diagnostic) {
      reviewFailure = error;
      diagnosticResult = diagnostic;
    },
    setSendControlFailure(error) {
      sendControlFailure = error;
    },
    setObservedTurnFailure(error, receipt) {
      observedTurnFailure = { error, receipt };
    },
    setObserveFailure(error) {
      observeFailure = error;
    },
    armForbiddenControls() {
      for (const method of ['reviewQuery', 'send', 'input', 'click', 'Continue', 'Retry', 'Stop', 'answerNow', 'inspectReviewComposerIdentity']) {
        controller[method] = async () => {
          calls.forbidden += 1;
          throw new Error(`forbidden_control_called:${method}`);
        };
      }
    },
    setSubmissionDiagnostic(diagnostic) {
      submissionDiagnosticResult = diagnostic;
    }
  };
}

test('review prompt input: reads exact UTF-8 promptPath once from relative or absolute paths', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-review-prompt-'));
  const relativePath = 'review-prompt.txt';
  const absolutePath = path.join(tempDir, relativePath);
  const exactPrompt = 'Review this exactly:\r\ncaf\u00e9 \u2014 \u3053\u3093\u306b\u3061\u306f\r\n';
  await fs.writeFile(absolutePath, exactPrompt, 'utf8');
  try {
    const relativeReads = [];
    const readFile = async (...args) => {
      relativeReads.push(args);
      return await fs.readFile(...args);
    };
    assert.equal(
      await resolveReviewPromptInput({ promptPath: relativePath }, { cwd: tempDir, readFile }),
      exactPrompt
    );
    assert.deepEqual(relativeReads, [[absolutePath, 'utf8']]);

    const absoluteReads = [];
    assert.equal(
      await resolveReviewPromptInput({ promptPath: absolutePath }, {
        cwd: path.dirname(tempDir),
        readFile: async (...args) => {
          absoluteReads.push(args);
          return await fs.readFile(...args);
        }
      }),
      exactPrompt
    );
    assert.deepEqual(absoluteReads, [[absolutePath, 'utf8']]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('review prompt input: requires exactly one inline prompt or nonblank promptPath', async () => {
  await assert.rejects(resolveReviewPromptInput({}), /exactly_one_of_prompt_or_promptPath_required/);
  await assert.rejects(
    resolveReviewPromptInput({ prompt: 'inline', promptPath: 'review-prompt.txt' }),
    /exactly_one_of_prompt_or_promptPath_required/
  );
  await assert.rejects(
    resolveReviewPromptInput({ promptPath: '   ' }),
    /exactly_one_of_prompt_or_promptPath_required/
  );
  let reads = 0;
  const inlinePrompt = 'inline\r\n\u3053\u3093\u306b\u3061\u306f';
  assert.equal(
    await resolveReviewPromptInput({ prompt: inlinePrompt }, { readFile: async () => { reads += 1; } }),
    inlinePrompt
  );
  assert.equal(reads, 0);
});

test('review prompt preparation: invalid hashes fail before connection after one exact file read', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-review-prompt-hash-'));
  const promptPath = path.join(tempDir, 'review-prompt.txt');
  const exactPrompt = 'Review this exactly:\r\ncaf\u00e9 \u2014 \u3053\u3093\u306b\u3061\u306f\r\n';
  await fs.writeFile(promptPath, exactPrompt, 'utf8');
  try {
    for (const [promptSha256, expectedError] of [
      ['A'.repeat(64), /review_prompt_sha256_invalid/],
      ['0'.repeat(64), /review_prompt_sha256_mismatch/]
    ]) {
      const reads = [];
      await assert.rejects(
        prepareReviewPromptInput(
          { promptPath: 'review-prompt.txt', promptSha256 },
          {
            cwd: tempDir,
            readFile: async (...args) => {
              reads.push(args);
              return await fs.readFile(...args);
            }
          }
        ),
        expectedError
      );
      assert.deepEqual(reads, [[promptPath, 'utf8']]);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('review transport: adopts an exact existing tab before the normal send lifecycle', async () => {
  const f = await fixture();
  const request = { ...f.request, existingTabId: 'tab-existing' };
  const receipt = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request });
  assert.equal(receipt.status, 'COMPLETE');
  assert.deepEqual(f.calls.adopt, [{
    id: 'tab-existing',
    key: request.stableKey,
    name: request.stableKey,
    url: request.conversationUrl,
    vendorId: request.provider,
    vendorName: 'ChatGPT'
  }]);
  assert.equal(f.calls.review, 1);
});

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

test('review transport: one unreadable visible user turn is durably anchored before terminal failure', async () => {
  const f = await fixture();
  const receipt = {
    observedUserMessageId: 'observed-unreadable-user',
    observedAt: 101,
    conversationUrl: f.request.conversationUrl,
    conversationId: f.request.conversationId,
    modelEvidence: 'GPT-5.6 Pro',
    commitmentClass: 'turn_unreadable',
    serializerOk: false,
    serializerMethod: 'rendered_user_message_structural',
    serializerError: 'review_composer_element_unsupported',
    serializerTag: 'PRE',
    expectedLength: f.request.prompt.length,
    newUserMessageCount: 1,
    readableCandidateCount: 0,
    exactMatchCount: 0,
    renderedContentCandidateCount: 4,
    rootTag: 'PRE',
    elementCount: 2,
    textNodeCount: 1,
    otherNodeCount: 0,
    maxDepth: 2,
    tagHistogram: { CODE: 1, PRE: 1 }
  };
  const error = new Error('review_user_message_identity_unreadable');
  error.data = receipt;
  f.setObservedTurnFailure(error, receipt);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_user_message_identity_unreadable/
  );
  const operation = (await readReviewTransportState(f.stateDir)).operations[f.request.idempotencyKey];
  assert.equal(operation.status, 'BLOCKED');
  assert.equal(operation.terminalState, 'SUBMITTED_UNVERIFIED');
  assert.equal(operation.sendActionCount, 1);
  assert.equal(operation.sendCount, 0);
  assert.equal(operation.userMessageId, undefined);
  assert.equal(operation.observedUserMessageId, 'observed-unreadable-user');
  assert.equal(operation.observedCommitmentClass, 'turn_unreadable');
  assert.equal(operation.errorData.commitmentClass, 'turn_unreadable');
  assert.equal(operation.errorData.newUserMessageCount, 1);
  assert.equal(operation.errorData.serializerTag, 'PRE');
  assert.deepEqual(operation.errorData.tagHistogram, { CODE: 1, PRE: 1 });
});

test('review transport: readable content mismatch persists the observed anchor and safe fingerprint', async () => {
  const f = await fixture();
  const receipt = {
    observedUserMessageId: 'observed-mismatch-user',
    observedAt: 102,
    conversationUrl: f.request.conversationUrl,
    conversationId: f.request.conversationId,
    modelEvidence: 'GPT-5.6 Pro',
    commitmentClass: 'turn_content_mismatch',
    serializerOk: true,
    serializerMethod: 'rendered_user_message_structural',
    serializerError: 'review_user_message_content_mismatch',
    serializedLength: 15,
    observedLengths: [15],
    expectedLength: f.request.prompt.length,
    newUserMessageCount: 1,
    readableCandidateCount: 1,
    exactMatchCount: 0,
    textModel: REVIEW_PLAIN_TEXT_MODEL,
    identityMode: 'mismatch',
    mismatchClass: 'code_point_length_mismatch',
    observedRawSha256: sha256('Pasted_text.txt'),
    observedCanonicalSha256: sha256('Pasted_text.txt')
  };
  const error = new Error('review_user_message_content_mismatch');
  error.data = receipt;
  f.setObservedTurnFailure(error, receipt);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_user_message_content_mismatch/
  );
  const operation = (await readReviewTransportState(f.stateDir)).operations[f.request.idempotencyKey];
  assert.equal(operation.observedUserMessageId, 'observed-mismatch-user');
  assert.equal(operation.observedCommitmentClass, 'turn_content_mismatch');
  assert.equal(operation.errorData.serializedLength, 15);
  assert.equal(operation.errorData.mismatchClass, 'code_point_length_mismatch');
  assert.equal(operation.errorData.observedCanonicalSha256, sha256('Pasted_text.txt'));
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_operation_closed_create_fresh/
  );
  assert.equal(f.calls.review, 1);
});

test('review transport: click with no observed turn remains distinct and has no fabricated anchor', async () => {
  const f = await fixture();
  const error = new Error('review_user_message_not_observed_after_click');
  error.data = {
    commitmentClass: 'click_no_turn',
    newUserMessageCount: 0,
    expectedLength: f.request.prompt.length
  };
  f.setPostClickFailure(error);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_user_message_not_observed_after_click/
  );
  const operation = (await readReviewTransportState(f.stateDir)).operations[f.request.idempotencyKey];
  assert.equal(operation.observedUserMessageId, undefined);
  assert.equal(operation.errorData.commitmentClass, 'click_no_turn');
  assert.equal(operation.errorData.newUserMessageCount, 0);
  assert.equal(operation.sendActionCount, 1);
  assert.equal(operation.terminalState, 'SUBMITTED_UNVERIFIED');
});

test('review transport: one send persists a complete receipt and duplicate returns it', async () => {
  const f = await fixture();
  const first = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  assert.equal(first.status, 'COMPLETE');
  assert.equal(first.sendCount, 1);
  assert.equal(first.promptSha256, sha256(f.request.prompt));
  assert.equal(first.responseSha256, sha256('SMOKE_OK'));
  assert.equal(first.userMessageId, 'user-1');
  assert.equal(first.observedUserMessageId, 'user-1');
  assert.equal(first.observedCommitmentClass, 'turn_exact');
  assert.equal(first.assistantMessageId, 'assistant-1');
  assert.equal(first.sendActionCount, 1);
  assert.equal(first.promptTextModel, REVIEW_PLAIN_TEXT_MODEL);
  assert.equal(first.canonicalPromptSha256, reviewPlainTextIdentity(f.request.prompt).canonicalSha256);
  assert.equal(first.composerIdentity.verified, true);
  assert.equal(first.composerIdentity.sourceSha256, f.request.promptSha256);
  assert.equal(first.renderedIdentity.canonicalPromptSha256, reviewPlainTextIdentity(f.request.prompt).canonicalSha256);
  assert.equal(first.clickTimeIdentity.recoveredExact, true);
  assert.equal(first.clickTimeIdentity.sourceSha256, f.request.promptSha256);
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

test('review transport: a submitted provisional first binding adopts the canonical identity without another send', async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    stableKey: 'first-binding-recovery-key',
    idempotencyKey: 'first-binding-recovery-op',
    conversationUrl: 'https://chatgpt.com/',
    conversationId: '__new__',
    firstBinding: true
  };
  f.setFirstBindingSubmittedUrl('https://chatgpt.com/c/WEB:temporary-bound');
  f.setFailAfterSubmittedReceipt(true);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request }),
    /simulated_crash_after_submitted_receipt/
  );
  const blocked = await readReviewTransportState(f.stateDir);
  assert.equal(blocked.operations[request.idempotencyKey].sendCount, 1);
  assert.equal(blocked.operations[request.idempotencyKey].userMessageId, 'user-1');
  assert.equal(blocked.operations[request.idempotencyKey].conversationId, 'WEB:temporary-bound');

  f.setFailAfterSubmittedReceipt(false);
  const receipt = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request });
  assert.equal(receipt.status, 'COMPLETE');
  assert.equal(receipt.sendCount, 1);
  assert.equal(receipt.conversationUrl, 'https://chatgpt.com/c/canonical-bound');
  assert.equal(receipt.conversationId, 'canonical-bound');
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.observe, 1);
  assert.deepEqual(f.calls.update, [
    { tabId: 'tab-1', url: 'https://chatgpt.com/c/WEB:temporary-bound' },
    { tabId: 'tab-1', url: 'https://chatgpt.com/c/canonical-bound' }
  ]);
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

test('review transport: composer replacement receipt is mandatory before strict submission', async () => {
  const f = await fixture();
  const originalReviewQuery = f.tabs.getControllerById().reviewQuery;
  f.tabs.getControllerById().reviewQuery = async (args) => {
    await args.onPrepared({
      baselineMessageIds: [], preparedAt: 50,
      conversationUrl: args.expectedUrl,
      conversationId: args.expectedConversationId,
      modelEvidence: 'GPT-5.6 Pro'
    });
    await args.onComposerVerified({
      ok: true,
      textModel: REVIEW_PLAIN_TEXT_MODEL,
      sourceSha256: reviewPlainTextIdentity(args.prompt).sourceSha256,
      canonicalPromptSha256: reviewPlainTextIdentity(args.prompt).canonicalSha256,
      observedCanonicalSha256: reviewPlainTextIdentity(args.prompt).canonicalSha256,
      identityMode: 'canonical_exact'
    });
    return await originalReviewQuery(args);
  };
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /review_composer_identity_receipt_invalid/
  );
  const state = await readReviewTransportState(f.stateDir);
  const operation = state.operations[f.request.idempotencyKey];
  assert.equal(operation.sendActionCount, 0);
  assert.equal(operation.sendCount, 0);
  assert.equal(operation.failureStage, 'before_send_click');
});

test('review transport: admission distinguishes a fresh send from exact existing observation', async () => {
  const f = await fixture();
  const fresh = await inspectReviewAdmission({ stateDir: f.stateDir, request: f.request });
  assert.equal(fresh.requiresSendCapacity, true);
  assert.equal(fresh.exactExisting, false);

  await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  const existing = await inspectReviewAdmission({ stateDir: f.stateDir, request: f.request });
  assert.equal(existing.requiresSendCapacity, false);
  assert.equal(existing.exactExisting, true);
  assert.equal(existing.observationOnly, true);

  const verifying = await inspectReviewAdmission({
    stateDir: f.stateDir,
    request: { ...f.request, verifyExisting: true }
  });
  assert.equal(verifying.requiresSendCapacity, false);

  await assert.rejects(
    inspectReviewAdmission({
      stateDir: f.stateDir,
      request: { ...f.request, prompt: 'conflict', promptSha256: sha256('conflict') }
    }),
    /review_idempotency_conflict/
  );
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

test('review transport: exact CRLF and non-ASCII prompt content is hash-bound before send', async () => {
  const f = await fixture();
  const prompt = 'Review this exactly:\r\ncaf\u00e9 \u2014 \u3053\u3093\u306b\u3061\u306f\r\n';
  const receipt = await runReviewQuery({
    stateDir: f.stateDir,
    tabs: f.tabs,
    request: {
      ...f.request,
      idempotencyKey: 'exact-crlf-nonascii',
      prompt,
      promptSha256: sha256(prompt)
    }
  });
  assert.equal(receipt.promptSha256, sha256(prompt));
  assert.deepEqual(f.calls.reviewPrompts, [prompt]);
});

test('review transport: malformed or mismatched prompt hash fails before state, tab, or send', async () => {
  const f = await fixture();
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: { ...f.request, promptSha256: 'A'.repeat(64) }
    }),
    /review_prompt_sha256_invalid/
  );
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: { ...f.request, promptSha256: '0'.repeat(64) }
    }),
    /review_prompt_sha256_mismatch/
  );
  assert.deepEqual(await fs.readdir(f.stateDir), []);
  assert.equal(f.calls.review, 0);
  assert.deepEqual(f.calls.adopt, []);
  assert.deepEqual(f.calls.ensure, []);
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

test('review transport: missing verifyExisting is rejected before state, tab, or controller access', async () => {
  const f = await fixture();
  f.armForbiddenControls();
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: { ...f.request, verifyExisting: true, existingTabId: 'tab-existing' }
    }),
    /review_observation_unavailable/
  );
  const state = await readReviewTransportState(f.stateDir);
  assert.deepEqual(state.operations, {});
  assert.deepEqual(state.bindings, {});
  assert.deepEqual(f.calls.adopt, []);
  assert.deepEqual(f.calls.ensure, []);
  assert.equal(f.calls.observe, 0);
  assert.equal(f.calls.review, 0);
  assert.equal(f.calls.forbidden, 0);
});

test('review transport: verifyExisting observes a persisted submission after its original deadline', async () => {
  const f = await fixture();
  f.setFailAfterSubmittedReceipt(true);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /simulated_crash_after_submitted_receipt/
  );
  const expired = await readReviewTransportState(f.stateDir);
  expired.operations[f.request.idempotencyKey].deadlineAt = Date.now() - 1;
  await writeReviewTransportState(expired, f.stateDir);

  f.setFailAfterSubmittedReceipt(false);
  const verified = await runReviewQuery({
    stateDir: f.stateDir,
    tabs: f.tabs,
    request: { ...f.request, verifyExisting: true }
  });
  assert.equal(verified.status, 'COMPLETE');
  assert.equal(verified.sendCount, 1);
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.observe, 1);
  assert.equal(f.calls.observeArgs[0].timeoutMs, f.request.timeoutMs);
});

test('review transport: bounded failed verification preserves its single submitted operation', async () => {
  const f = await fixture();
  f.setFailAfterSubmittedReceipt(true);
  await assert.rejects(
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request }),
    /simulated_crash_after_submitted_receipt/
  );
  const expired = await readReviewTransportState(f.stateDir);
  expired.operations[f.request.idempotencyKey].deadlineAt = Date.now() - 1;
  await writeReviewTransportState(expired, f.stateDir);

  f.setObserveFailure(new Error('timeout_waiting_for_response'));
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: { ...f.request, verifyExisting: true }
    }),
    /timeout_waiting_for_response/
  );
  const state = await readReviewTransportState(f.stateDir);
  const operation = state.operations[f.request.idempotencyKey];
  assert.deepEqual(Object.keys(state.operations), [f.request.idempotencyKey]);
  assert.equal(operation.sendCount, 1);
  assert.equal(operation.sendActionCount, 1);
  assert.equal(operation.status, 'BLOCKED');
  assert.equal(operation.terminalState, 'SUBMITTED_UNVERIFIED');
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.observe, 1);
  assert.equal(f.calls.observeArgs[0].timeoutMs, f.request.timeoutMs);
});

test('review transport: observer completion cannot promote a ledger without one persisted send action', async () => {
  const f = await fixture();
  await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  const state = await readReviewTransportState(f.stateDir);
  const operation = state.operations[f.request.idempotencyKey];
  operation.status = 'SUBMITTED';
  operation.terminalState = null;
  operation.sendActionCount = 0;
  delete operation.observedUserMessageId;
  delete operation.observedUserMessageAt;
  delete operation.observedConversationUrl;
  delete operation.observedConversationId;
  delete operation.observedCommitmentClass;
  delete operation.observedTurnEvidence;
  delete operation.newUserMessageCount;
  await writeReviewTransportState(state, f.stateDir);

  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: { ...f.request, verifyExisting: true }
    }),
    /review_send_receipt_invalid/
  );
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.observe, 1);
});

test('review transport: repeated verifyExisting has no send or control capability', async () => {
  const f = await fixture();
  const first = await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  f.armForbiddenControls();
  const verified = { ...f.request, verifyExisting: true };
  const [once, twice] = await Promise.all([
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: verified }),
    runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: verified })
  ]);
  assert.equal(once.operationId, first.operationId);
  assert.equal(twice.operationId, first.operationId);
  assert.equal(f.calls.review, 1);
  assert.equal(f.calls.observe, 2);
  assert.equal(f.calls.forbidden, 0);
});

test('review transport: stable-key mismatch and prompt hash mismatch fail without another send', async () => {
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
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: { ...f.request, idempotencyKey: 'hash-mismatch', promptSha256: '0'.repeat(64) }
    }),
    /review_prompt_sha256_mismatch/
  );
  assert.equal(f.calls.review, 1);
});

test('review transport: binding mismatch cannot adopt or re-key a tab', async () => {
  const f = await fixture();
  await runReviewQuery({ stateDir: f.stateDir, tabs: f.tabs, request: f.request });
  await assert.rejects(
    runReviewQuery({
      stateDir: f.stateDir,
      tabs: f.tabs,
      request: {
        ...f.request,
        idempotencyKey: 'different-operation',
        conversationUrl: 'https://chatgpt.com/c/conversation-2',
        conversationId: 'conversation-2',
        existingTabId: 'tab-existing'
      }
    }),
    /review_binding_mismatch/
  );
  assert.deepEqual(f.calls.adopt, []);
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
