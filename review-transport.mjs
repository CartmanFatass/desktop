import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readReviewTransportState, writeReviewTransportState } from './state.mjs';

const MAX_REVIEW_TIMEOUT_MS = 45 * 60_000;
const MIN_REVIEW_TIMEOUT_MS = 1_000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const stateLocks = new Map();

function fail(code, data = null) {
  const error = new Error(code);
  error.data = data;
  throw error;
}

function requiredText(value, field, { max = 4096 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
    fail('review_invalid_request', { field });
  }
  return value;
}

function requiredExactText(value, field, { max }) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail('review_invalid_request', { field });
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function resolveReviewPromptInput(
  { prompt, promptPath } = {},
  { cwd = process.cwd(), readFile = fs.readFile } = {}
) {
  const hasPrompt = typeof prompt === 'string';
  const hasPromptPath = typeof promptPath === 'string' && promptPath.trim().length > 0;
  if (hasPrompt === hasPromptPath) throw new Error('exactly_one_of_prompt_or_promptPath_required');
  if (!hasPromptPath) return prompt;
  const resolvedPromptPath = path.isAbsolute(promptPath) ? promptPath : path.resolve(cwd, promptPath);
  return await readFile(resolvedPromptPath, 'utf8');
}

export function validateReviewPromptSha256(prompt, promptSha256) {
  if (typeof promptSha256 !== 'string' || !SHA256_RE.test(promptSha256)) {
    fail('review_prompt_sha256_invalid');
  }
  if (promptSha256 !== sha256(prompt)) fail('review_prompt_sha256_mismatch');
  return promptSha256;
}

export async function prepareReviewPromptInput(
  { prompt, promptPath, promptSha256 } = {},
  options = {}
) {
  const exactPrompt = await resolveReviewPromptInput({ prompt, promptPath }, options);
  validateReviewPromptSha256(exactPrompt, promptSha256);
  return exactPrompt;
}

export function sanitizeReviewErrorData(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!data) return null;
  const output = {};
  for (const field of ['ok', 'serializerOk', 'noClickProven']) {
    if (typeof data[field] === 'boolean') output[field] = data[field];
  }
  for (const field of [
    'serializerMethod', 'serializerError', 'serializerTag', 'rootTag',
    'predicate', 'failureStage'
  ]) {
    if (data[field] === null) {
      output[field] = null;
    } else if (typeof data[field] === 'string' && data[field].length <= 128) {
      output[field] = data[field];
    }
  }
  for (const field of [
    'serializedLength', 'expectedLength', 'candidateCount', 'elementCount',
    'textNodeCount', 'otherNodeCount', 'maxDepth', 'exactMatchCount',
    'readableCandidateCount', 'renderedContentCandidateCount',
    'newUserMessageCount', 'sendActionCount'
  ]) {
    if (Number.isInteger(data[field]) && data[field] >= 0 && data[field] <= 10_000_000) {
      output[field] = data[field];
    }
  }
  if (
    Array.isArray(data.observedLengths) &&
    data.observedLengths.length <= 8 &&
    data.observedLengths.every((item) => Number.isInteger(item) && item >= 0 && item <= 10_000_000)
  ) {
    output.observedLengths = [...data.observedLengths];
  }
  if (data.tagHistogram && typeof data.tagHistogram === 'object' && !Array.isArray(data.tagHistogram)) {
    const entries = Object.entries(data.tagHistogram)
      .filter(([tag, count]) => /^[A-Z0-9_-]{1,32}$/.test(tag) && Number.isInteger(count) && count >= 0 && count <= 1_000_000)
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length <= 64) output.tagHistogram = Object.fromEntries(entries);
  }
  return Object.keys(output).length ? output : null;
}

function conversationIdentityFromUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('review_invalid_request', { field: 'conversationUrl' });
  }
  const provider = parsed.hostname === 'chatgpt.com'
    ? 'chatgpt'
    : parsed.hostname === 'gemini.google.com'
      ? 'gemini'
      : null;
  if (parsed.protocol !== 'https:' || !provider || parsed.search || parsed.hash) {
    fail('review_invalid_request', { field: 'conversationUrl' });
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const marker = parts.lastIndexOf(provider === 'chatgpt' ? 'c' : 'app');
  if (marker < 0 || marker + 1 >= parts.length) fail('review_invalid_request', { field: 'conversationUrl' });
  return { provider, conversationId: parts[marker + 1] };
}

function provisionalChatgptConversationId(value) {
  return typeof value === 'string' && value.startsWith('WEB:');
}

function normalizeRequest(input) {
  const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const stableKey = requiredText(request.stableKey, 'stableKey', { max: 128 });
  const idempotencyKey = requiredText(request.idempotencyKey, 'idempotencyKey', { max: 128 });
  if (!KEY_RE.test(stableKey) || !KEY_RE.test(idempotencyKey)) fail('review_invalid_request', { field: 'key' });
  const provider = requiredText(request.provider, 'provider', { max: 64 }).toLowerCase();
  if (!['chatgpt', 'gemini'].includes(provider)) fail('review_invalid_request', { field: 'provider' });
  const model = requiredText(request.model, 'model', { max: 128 });
  const conversationUrl = requiredText(request.conversationUrl, 'conversationUrl', { max: 2048 });
  const conversationId = requiredText(request.conversationId, 'conversationId', { max: 256 });
  const firstBinding = request.firstBinding === true;
  if (firstBinding) {
    if (provider !== 'chatgpt' || conversationUrl !== 'https://chatgpt.com/' || conversationId !== '__new__') {
      fail('review_invalid_request', { field: 'firstBinding' });
    }
  } else {
    const identity = conversationIdentityFromUrl(conversationUrl);
    if (identity.provider !== provider || identity.conversationId !== conversationId) {
      fail('review_conversation_identity_mismatch');
    }
  }
  const prompt = requiredExactText(request.prompt, 'prompt', { max: 200_000 });
  const promptSha256 = validateReviewPromptSha256(prompt, request.promptSha256);
  const timeoutMs = Number(request.timeoutMs ?? MAX_REVIEW_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_REVIEW_TIMEOUT_MS || timeoutMs > MAX_REVIEW_TIMEOUT_MS) {
    fail('review_timeout_out_of_range');
  }
  const verifyExisting = request.verifyExisting === true;
  const diagnoseExisting = request.diagnoseExisting === true;
  const existingTabId = request.existingTabId == null
    ? null
    : requiredText(request.existingTabId, 'existingTabId', { max: 512 });
  if (verifyExisting && diagnoseExisting) fail('review_invalid_request', { field: 'operationMode' });
  return {
    stableKey,
    provider,
    model,
    conversationUrl,
    conversationId,
    idempotencyKey,
    prompt,
    promptSha256,
    timeoutMs,
    verifyExisting,
    diagnoseExisting,
    firstBinding,
    existingTabId
  };
}

function requestFingerprint(request) {
  return sha256(
    JSON.stringify({
      stableKey: request.stableKey,
      provider: request.provider,
      model: request.model,
      conversationUrl: request.conversationUrl,
      conversationId: request.conversationId,
      idempotencyKey: request.idempotencyKey,
      promptSha256: request.promptSha256,
      timeoutMs: request.timeoutMs,
      firstBinding: request.firstBinding
    })
  );
}

async function withStateLock(stateDir, fn) {
  const key = path.resolve(stateDir);
  const previous = stateLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => next);
  stateLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (stateLocks.get(key) === chained) stateLocks.delete(key);
  }
}

async function mutateState(stateDir, fn) {
  return await withStateLock(stateDir, async () => {
    const state = await readReviewTransportState(stateDir);
    const result = await fn(state);
    await writeReviewTransportState(state, stateDir);
    return result;
  });
}

async function readStateLocked(stateDir) {
  return await withStateLock(stateDir, async () => await readReviewTransportState(stateDir));
}

function sameBinding(binding, request) {
  return (
    binding?.stableKey === request.stableKey &&
    binding?.provider === request.provider &&
    binding?.model === request.model &&
    binding?.conversationUrl === request.conversationUrl &&
    binding?.conversationId === request.conversationId
  );
}

function validateResult(result, request, expectedUserMessageId = null) {
  if (!result || typeof result !== 'object') fail('review_identity_unreadable');
  if (result.conversationUrl !== request.conversationUrl || result.conversationId !== request.conversationId) {
    fail('review_conversation_identity_mismatch');
  }
  const userMessageId = requiredText(result.userMessageId, 'userMessageId', { max: 512 });
  if (expectedUserMessageId && userMessageId !== expectedUserMessageId) fail('review_user_message_identity_mismatch');
  const assistantMessageId = requiredText(result.assistantMessageId, 'assistantMessageId', { max: 512 });
  const text = requiredExactText(result.text, 'response', { max: 2_000_000 });
  const responseSha256 = sha256(text);
  const snapshots = Array.isArray(result.snapshots) ? result.snapshots : [];
  if (snapshots.length !== 2) fail('review_completion_unstable');
  const [first, second] = snapshots;
  if (
    first?.assistantMessageId !== assistantMessageId ||
    second?.assistantMessageId !== assistantMessageId ||
    first?.textSha256 !== responseSha256 ||
    second?.textSha256 !== responseSha256 ||
    !Number.isFinite(first?.observedAt) ||
    !Number.isFinite(second?.observedAt) ||
    second.observedAt - first.observedAt < 3_000
  ) {
    fail('review_completion_unstable');
  }
  const controls = result.controls && typeof result.controls === 'object' ? result.controls : {};
  if (controls.stop || controls.continue || controls.retry) fail('review_completion_controls_active');
  if (Array.isArray(result.clickedControls) && result.clickedControls.length) fail('review_control_activation_forbidden');
  return {
    userMessageId,
    assistantMessageId,
    responseText: text,
    responseSha256,
    snapshots,
    controls: {
      stop: !!controls.stop,
      continue: !!controls.continue,
      retry: !!controls.retry,
      answerNow: !!controls.answerNow
    },
    conversationUrl: result.conversationUrl,
    conversationId: result.conversationId,
    modelEvidence: typeof result.modelEvidence === 'string' && result.modelEvidence.trim()
      ? result.modelEvidence
      : request.model,
    clickedControls: []
  };
}

async function observePersistedReview({ observeReviewResponse, operation, request }) {
  return await observeReviewResponse({
    expectedUrl: operation.conversationUrl,
    expectedConversationId: operation.conversationId,
    expectedModel: request.model,
    userMessageId: operation.userMessageId,
    timeoutMs: request.timeoutMs
  });
}

export async function runReviewQuery({ stateDir, tabs, request: rawRequest }) {
  if (!stateDir || !tabs) fail('review_transport_misconfigured');
  const request = normalizeRequest(rawRequest);
  const fingerprint = requestFingerprint(request);
  const intake = await mutateState(stateDir, async (state) => {
    const now = Date.now();
    const binding = state.bindings[request.stableKey];
    const expectedBinding = {
      stableKey: request.stableKey,
      provider: request.provider,
      model: request.model,
      conversationUrl: request.conversationUrl,
      conversationId: request.conversationId
    };
    const existing = state.operations[request.idempotencyKey];
    if (existing && existing.requestFingerprint !== fingerprint) fail('review_idempotency_conflict');
    if (request.verifyExisting) {
      if (!existing || !existing.userMessageId) fail('review_observation_unavailable');
      return { existing: true, operation: { ...existing }, binding: binding ? { ...binding } : null };
    }
    if (request.firstBinding) {
      if (binding && !existing) fail('review_binding_mismatch');
    } else {
      if (binding && !sameBinding(binding, request)) fail('review_binding_mismatch');
      if (!binding) state.bindings[request.stableKey] = { ...expectedBinding, createdAt: now, updatedAt: now };
    }
    if (request.existingTabId && !existing) {
      await tabs.adoptTab({
        id: request.existingTabId,
        key: request.stableKey,
        name: request.stableKey,
        url: request.conversationUrl,
        vendorId: request.provider,
        vendorName: request.provider === 'gemini' ? 'Gemini' : 'ChatGPT'
      });
    }
    if (request.diagnoseExisting && !existing) fail('review_diagnostic_operation_missing');
    if (existing) return { existing: true, operation: { ...existing }, binding: binding ? { ...binding } : null };
    const operation = {
      operationId: crypto.randomUUID(),
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint,
      stableKey: request.stableKey,
      provider: request.provider,
      model: request.model,
      conversationUrl: request.conversationUrl,
      conversationId: request.conversationId,
      promptSha256: request.promptSha256,
      timeoutMs: request.timeoutMs,
      deadlineAt: now + request.timeoutMs,
      status: 'SEND_INTENT',
      terminalState: null,
      sendCount: 0,
      sendActionCount: 0,
      failureStage: null,
      createdAt: now,
      updatedAt: now
    };
    state.operations[request.idempotencyKey] = operation;
    return { existing: false, operation: { ...operation }, binding: null };
  });

  if (
    intake.existing &&
    intake.operation.status === 'COMPLETE' &&
    !request.verifyExisting &&
    !request.diagnoseExisting
  ) return intake.operation;
  const liveIdentity = intake.binding || request;
  const tabId = await tabs.ensureTab({
    key: request.stableKey,
    name: request.stableKey,
    url: liveIdentity.conversationUrl,
    vendorId: request.provider,
    vendorName: request.provider === 'gemini' ? 'Gemini' : 'ChatGPT',
    show: false,
    exactUrl: true
  });
  const controller = tabs.getControllerById(tabId);
  const runControllerExclusive = async (fn) =>
    typeof controller.runExclusive === 'function' ? await controller.runExclusive(fn) : await fn();
  // The verification branch receives only this bound observer capability.  It
  // cannot reach the controller's send, input, or control-activation methods.
  const observeReviewResponse = typeof controller?.observeReviewResponse === 'function'
    ? controller.observeReviewResponse.bind(controller)
    : null;

  const onSubmitted = async (submitted) => {
    const userMessageId = requiredText(submitted?.userMessageId, 'userMessageId', { max: 512 });
    const submittedUrl = requiredText(submitted?.conversationUrl, 'conversationUrl', { max: 2048 });
    const submittedId = requiredText(submitted?.conversationId, 'conversationId', { max: 256 });
    const submittedIdentity = conversationIdentityFromUrl(submittedUrl);
    if (submittedIdentity.provider !== request.provider || submittedIdentity.conversationId !== submittedId) {
      fail('review_conversation_identity_mismatch');
    }
    if (!request.firstBinding && (submittedUrl !== request.conversationUrl || submittedId !== request.conversationId)) {
      fail('review_conversation_identity_mismatch');
    }
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.sendActionCount !== 1) fail('review_send_action_receipt_missing');
      op.status = 'SUBMITTED';
      op.sendCount = 1;
      op.userMessageId = userMessageId;
      op.conversationUrl = submittedUrl;
      op.conversationId = submittedId;
      op.tabId = tabId;
      op.submittedAt = submitted?.submittedAt || Date.now();
      op.modelEvidence = submitted?.modelEvidence || null;
      op.updatedAt = Date.now();
      if (request.firstBinding) {
        const now = Date.now();
        state.bindings[request.stableKey] = {
          stableKey: request.stableKey,
          provider: request.provider,
          model: request.model,
          conversationUrl: submittedUrl,
          conversationId: submittedId,
          createdAt: now,
          updatedAt: now
        };
      }
    });
    if (request.firstBinding) tabs.updateTabUrl(tabId, submittedUrl);
  };

  const onSendAction = async (action) => {
    if (Number(action?.clickCount) !== 1 || Number(action?.sendActionCount) !== 1) {
      fail('review_send_action_receipt_invalid');
    }
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (!['PREPARED', 'SEND_INTENT'].includes(op.status) || op.sendActionCount !== 0 || op.userMessageId) {
        fail('review_operation_state_invalid');
      }
      op.status = 'SEND_INTENT';
      op.sendActionCount = 1;
      op.clickCount = 1;
      op.sendActionAt = action?.sendActionAt || Date.now();
      op.updatedAt = Date.now();
    });
  };

  const onPrepared = async (prepared) => {
    const baselineMessageIds = Array.isArray(prepared?.baselineMessageIds)
      ? prepared.baselineMessageIds.map((value) => requiredText(value, 'baselineMessageId', { max: 512 }))
      : null;
    if (!baselineMessageIds) fail('review_submission_baseline_missing');
    if (new Set(baselineMessageIds).size !== baselineMessageIds.length) fail('review_submission_baseline_invalid');
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.sendCount !== 0 || op.sendActionCount !== 0 || op.userMessageId) fail('review_operation_state_invalid');
      op.status = 'PREPARED';
      op.baselineMessageIds = baselineMessageIds;
      op.preparedAt = prepared?.preparedAt || Date.now();
      op.modelEvidence = prepared?.modelEvidence || null;
      op.updatedAt = Date.now();
    });
  };

  try {
    const execution = await runControllerExclusive(async () => {
      const currentState = await readStateLocked(stateDir);
      const currentOperation = currentState.operations[request.idempotencyKey];
      if (!currentOperation || currentOperation.operationId !== intake.operation.operationId) {
        fail('review_operation_identity_mismatch');
      }
      if (request.diagnoseExisting) {
        if (
          currentOperation.status !== 'BLOCKED' ||
          currentOperation.sendCount !== 0 ||
          currentOperation.sendActionCount !== 0 ||
          currentOperation.userMessageId ||
          currentOperation.failureStage !== 'before_send_click' ||
          !Array.isArray(currentOperation.baselineMessageIds)
        ) {
          fail('review_diagnostic_operation_ineligible');
        }
        if (typeof controller?.inspectReviewSubmissionIdentity !== 'function') {
          fail('review_diagnostic_unavailable');
        }
        const diagnostic = await controller.inspectReviewSubmissionIdentity({
          prompt: request.prompt,
          baselineMessageIds: currentOperation.baselineMessageIds,
          expectedUrl: currentOperation.conversationUrl,
          expectedConversationId: currentOperation.conversationId,
          expectedModel: request.model
        });
        return { diagnosticOnly: true, diagnostic };
      }
      if (request.verifyExisting) {
        if (!intake.existing || !currentOperation.userMessageId) {
          fail('review_observation_unavailable');
        }
        if (!observeReviewResponse) fail('review_observation_unavailable');
        // Explicit verification is a fresh, bounded read-only attempt.  It is
        // deliberately independent of the original submission deadline, which
        // may have elapsed while the provider was still producing a response.
        const result = await observePersistedReview({ observeReviewResponse, operation: currentOperation, request });
        return { result, expectedUserMessageId: currentOperation.userMessageId };
      }
      if (currentOperation.status === 'COMPLETE') {
        return { completedOperation: { ...currentOperation } };
      }
      const remainingMs = Math.floor(currentOperation.deadlineAt - Date.now());
      if (remainingMs <= 0) fail('review_operation_deadline_exceeded');
      const result = intake.existing
        ? currentOperation.userMessageId
          ? await controller.observeReviewResponse({
          expectedUrl: currentOperation.conversationUrl,
          expectedConversationId: currentOperation.conversationId,
          expectedModel: request.model,
          userMessageId: currentOperation.userMessageId,
          timeoutMs: remainingMs
        })
          : fail('review_operation_closed_create_fresh')
        : await controller.reviewQuery({
          prompt: request.prompt,
          expectedUrl: request.conversationUrl,
          expectedConversationId: request.conversationId,
          expectedModel: request.model,
          timeoutMs: remainingMs,
          onPrepared,
          onSendAction,
          onSubmitted,
          firstBinding: request.firstBinding
        });
      return { result, expectedUserMessageId: currentOperation.userMessageId || null };
    });
    if (execution.diagnosticOnly) {
      const safeDiagnostic = sanitizeReviewErrorData(execution.diagnostic);
      return await mutateState(stateDir, async (state) => {
        const op = state.operations[request.idempotencyKey];
        if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
        if (
          op.status !== 'BLOCKED' ||
          op.sendCount !== 0 ||
          op.sendActionCount !== 0 ||
          op.userMessageId ||
          op.failureStage !== 'before_send_click'
        ) {
          fail('review_diagnostic_operation_ineligible');
        }
        if (safeDiagnostic) op.errorData = safeDiagnostic;
        op.diagnosticObservedAt = Date.now();
        op.updatedAt = Date.now();
        return { ...op, diagnosticOnly: true };
      });
    }
    if (execution.completedOperation) return execution.completedOperation;
    const resultRequest = request.firstBinding
      ? { ...request, conversationUrl: execution.result.conversationUrl, conversationId: execution.result.conversationId }
      : request;
    const validated = validateResult(execution.result, resultRequest, execution.expectedUserMessageId);
    let canonicalizedExistingBinding = false;
    const completed = await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.sendCount > 1) fail('review_send_receipt_invalid');
      op.sendCount = 1;
      op.userMessageId = validated.userMessageId;
      Object.assign(op, validated, {
        status: 'COMPLETE',
        terminalState: 'NATURAL_COMPLETION_VERIFIED',
        tabId,
        completedAt: Date.now(),
        updatedAt: Date.now()
      });
      if (request.firstBinding && provisionalChatgptConversationId(state.bindings[request.stableKey]?.conversationId)) {
        const binding = state.bindings[request.stableKey];
        if (!binding || binding.provider !== request.provider || binding.model !== request.model) {
          fail('review_binding_mismatch');
        }
        binding.conversationUrl = validated.conversationUrl;
        binding.conversationId = validated.conversationId;
        binding.updatedAt = Date.now();
        canonicalizedExistingBinding = true;
      }
      return { ...op };
    });
    if (canonicalizedExistingBinding) tabs.updateTabUrl(tabId, validated.conversationUrl);
    return completed;
  } catch (error) {
    if (request.diagnoseExisting) throw error;
    let safeErrorData = sanitizeReviewErrorData(error?.data);
    if (
      !request.verifyExisting &&
      String(error?.message || error) === 'review_composer_identity_mismatch' &&
      typeof controller?.inspectReviewComposerIdentity === 'function'
    ) {
      try {
        const observed = await runControllerExclusive(async () =>
          await controller.inspectReviewComposerIdentity({ expectedPrompt: request.prompt })
        );
        safeErrorData = sanitizeReviewErrorData({ ...(error?.data || {}), ...(observed || {}) });
      } catch {
        // The diagnostic is observe-only and best-effort. The original fail-closed
        // transport error remains authoritative if metadata cannot be read.
      }
    }
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.status === 'COMPLETE') return;
      const preSendFailure =
        op.sendActionCount === 0 &&
        !op.userMessageId &&
        (op.status === 'PREPARED' || !op.sendIntentAt || safeErrorData?.noClickProven === true);
      op.failureStage = preSendFailure ? 'before_send_click' : 'send_occurred_or_uncertain';
      op.status = 'BLOCKED';
      op.terminalState = preSendFailure ? 'IDENTITY_UNREADABLE' : 'SUBMITTED_UNVERIFIED';
      op.error = String(error?.message || error);
      const mechanicalErrorData = sanitizeReviewErrorData({
        ...(safeErrorData || {}),
        predicate: String(error?.message || error),
        failureStage: op.failureStage,
        sendActionCount: op.sendActionCount || 0,
        newUserMessageCount: op.newUserMessageCount || 0
      });
      if (mechanicalErrorData) op.errorData = mechanicalErrorData;
      op.updatedAt = Date.now();
    }).catch(() => {});
    throw error;
  }
}

export { MAX_REVIEW_TIMEOUT_MS };
