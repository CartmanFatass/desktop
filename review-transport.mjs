import crypto from 'node:crypto';
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

function normalizedToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function sanitizeReviewErrorData(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!data) return null;
  const output = {};
  for (const field of ['ok', 'serializerOk']) {
    if (typeof data[field] === 'boolean') output[field] = data[field];
  }
  for (const field of ['serializerMethod', 'serializerError', 'serializerTag', 'rootTag']) {
    if (data[field] === null) {
      output[field] = null;
    } else if (typeof data[field] === 'string' && data[field].length <= 128) {
      output[field] = data[field];
    }
  }
  for (const field of [
    'serializedLength', 'expectedLength', 'candidateCount', 'elementCount',
    'textNodeCount', 'otherNodeCount', 'maxDepth'
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

function conversationIdFromUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('review_invalid_request', { field: 'conversationUrl' });
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') {
    fail('review_invalid_request', { field: 'conversationUrl' });
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const marker = parts.lastIndexOf('c');
  if (marker < 0 || marker + 1 >= parts.length) fail('review_invalid_request', { field: 'conversationUrl' });
  return parts[marker + 1];
}

function normalizeRequest(input) {
  const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const stableKey = requiredText(request.stableKey, 'stableKey', { max: 128 });
  const idempotencyKey = requiredText(request.idempotencyKey, 'idempotencyKey', { max: 128 });
  if (!KEY_RE.test(stableKey) || !KEY_RE.test(idempotencyKey)) fail('review_invalid_request', { field: 'key' });
  const provider = requiredText(request.provider, 'provider', { max: 64 }).toLowerCase();
  if (provider !== 'chatgpt') fail('review_invalid_request', { field: 'provider' });
  const model = requiredText(request.model, 'model', { max: 128 });
  const conversationUrl = requiredText(request.conversationUrl, 'conversationUrl', { max: 2048 });
  const conversationId = requiredText(request.conversationId, 'conversationId', { max: 256 });
  if (conversationIdFromUrl(conversationUrl) !== conversationId) {
    fail('review_conversation_identity_mismatch');
  }
  const prompt = requiredExactText(request.prompt, 'prompt', { max: 200_000 });
  const promptSha256 = requiredText(request.promptSha256, 'promptSha256', { max: 64 });
  if (!SHA256_RE.test(promptSha256) || sha256(prompt) !== promptSha256) fail('review_prompt_hash_mismatch');
  const timeoutMs = Number(request.timeoutMs ?? MAX_REVIEW_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_REVIEW_TIMEOUT_MS || timeoutMs > MAX_REVIEW_TIMEOUT_MS) {
    fail('review_timeout_out_of_range');
  }
  const verifyExisting = request.verifyExisting === true;
  const diagnoseExisting = request.diagnoseExisting === true;
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
    diagnoseExisting
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
      timeoutMs: request.timeoutMs
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
  if (normalizedToken(result.modelEvidence) !== normalizedToken(request.model)) {
    fail('review_model_identity_mismatch');
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
    modelEvidence: result.modelEvidence,
    clickedControls: []
  };
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
    if (binding && !sameBinding(binding, request)) fail('review_binding_mismatch');
    if (!binding) state.bindings[request.stableKey] = { ...expectedBinding, createdAt: now, updatedAt: now };
    const existing = state.operations[request.idempotencyKey];
    if (existing && existing.requestFingerprint !== fingerprint) fail('review_idempotency_conflict');
    if (request.diagnoseExisting && !existing) fail('review_diagnostic_operation_missing');
    if (existing) return { existing: true, operation: { ...existing } };
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
      createdAt: now,
      updatedAt: now
    };
    state.operations[request.idempotencyKey] = operation;
    return { existing: false, operation: { ...operation } };
  });

  if (
    intake.existing &&
    intake.operation.status === 'COMPLETE' &&
    !request.verifyExisting &&
    !request.diagnoseExisting
  ) return intake.operation;
  const tabId = await tabs.ensureTab({
    key: request.stableKey,
    name: request.stableKey,
    url: request.conversationUrl,
    vendorId: request.provider,
    vendorName: 'ChatGPT',
    show: false,
    exactUrl: true
  });
  const controller = tabs.getControllerById(tabId);
  const runControllerExclusive = async (fn) =>
    typeof controller.runExclusive === 'function' ? await controller.runExclusive(fn) : await fn();

  const onSubmitted = async (submitted) => {
    const userMessageId = requiredText(submitted?.userMessageId, 'userMessageId', { max: 512 });
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.sendCount > 0 && op.userMessageId !== userMessageId) fail('review_duplicate_send_detected');
      op.status = 'SUBMITTED';
      op.sendCount = 1;
      op.userMessageId = userMessageId;
      op.tabId = tabId;
      op.submittedAt = submitted?.submittedAt || Date.now();
      op.modelEvidence = submitted?.modelEvidence || null;
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
      if (op.sendCount !== 0 || op.userMessageId) fail('review_operation_state_invalid');
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
          currentOperation.userMessageId ||
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
          expectedUrl: request.conversationUrl,
          expectedConversationId: request.conversationId,
          expectedModel: request.model
        });
        return { diagnosticOnly: true, diagnostic };
      }
      if (currentOperation.status === 'COMPLETE' && !request.verifyExisting) {
        return { completedOperation: { ...currentOperation } };
      }
      const remainingMs = Math.floor(currentOperation.deadlineAt - Date.now());
      if (remainingMs <= 0) fail('review_operation_deadline_exceeded');
      const result = intake.existing
        ? currentOperation.userMessageId
          ? await controller.observeReviewResponse({
          expectedUrl: request.conversationUrl,
          expectedConversationId: request.conversationId,
          expectedModel: request.model,
          userMessageId: currentOperation.userMessageId,
          timeoutMs: remainingMs
        })
          : await controller.recoverReviewSubmission({
            prompt: request.prompt,
            baselineMessageIds: currentOperation.baselineMessageIds,
            expectedUrl: request.conversationUrl,
            expectedConversationId: request.conversationId,
            expectedModel: request.model,
            timeoutMs: remainingMs,
            onRecovered: onSubmitted
          })
        : await controller.reviewQuery({
          prompt: request.prompt,
          expectedUrl: request.conversationUrl,
          expectedConversationId: request.conversationId,
          expectedModel: request.model,
          timeoutMs: remainingMs,
          onPrepared,
          onSubmitted
        });
      return { result, expectedUserMessageId: currentOperation.userMessageId || null };
    });
    if (execution.diagnosticOnly) {
      const safeDiagnostic = sanitizeReviewErrorData(execution.diagnostic);
      return await mutateState(stateDir, async (state) => {
        const op = state.operations[request.idempotencyKey];
        if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
        if (op.status !== 'BLOCKED' || op.sendCount !== 0 || op.userMessageId) {
          fail('review_diagnostic_operation_ineligible');
        }
        if (safeDiagnostic) op.errorData = safeDiagnostic;
        op.diagnosticObservedAt = Date.now();
        op.updatedAt = Date.now();
        return { ...op, diagnosticOnly: true };
      });
    }
    if (execution.completedOperation) return execution.completedOperation;
    const validated = validateResult(execution.result, request, execution.expectedUserMessageId);
    return await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.sendCount !== 1 || op.userMessageId !== validated.userMessageId) fail('review_send_receipt_missing');
      Object.assign(op, validated, {
        status: 'COMPLETE',
        terminalState: 'NATURAL_COMPLETION_VERIFIED',
        tabId,
        completedAt: Date.now(),
        updatedAt: Date.now()
      });
      return { ...op };
    });
  } catch (error) {
    let safeErrorData = sanitizeReviewErrorData(error?.data);
    if (
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
      op.status = 'BLOCKED';
      op.terminalState = op.userMessageId ? 'REVIEW_RESPONSE_BLOCKED' : 'IDENTITY_UNREADABLE';
      op.error = String(error?.message || error);
      if (safeErrorData) op.errorData = safeErrorData;
      op.updatedAt = Date.now();
    }).catch(() => {});
    throw error;
  }
}

export { MAX_REVIEW_TIMEOUT_MS };
