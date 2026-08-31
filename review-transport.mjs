import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readReviewTransportState, writeReviewTransportState } from './state.mjs';
import {
  REVIEW_PLAIN_TEXT_MODEL,
  reviewPlainTextIdentity
} from './review-text-identity.mjs';
import { REVIEW_COMPOSER_REPLACEMENT_MODEL } from './review-composer-replacement.mjs';

const MAX_REVIEW_TIMEOUT_MS = 45 * 60_000;
const MIN_REVIEW_TIMEOUT_MS = 1_000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REVIEW_REQUEST_FIELDS = new Set([
  'stableKey',
  'provider',
  'productModel',
  'reasoningEffort',
  'conversationUrl',
  'conversationId',
  'idempotencyKey',
  'prompt',
  'promptSha256',
  'responsePath',
  'timeoutMs',
  'verifyExisting',
  'firstBinding',
  'geminiBootstrap',
  'geminiBootstrapContinuation',
  'bootstrapNonScientific',
  'existingTabId'
]);
const stateLocks = new Map();

function fail(code, data = null) {
  const error = new Error(code);
  error.data = data;
  throw error;
}
function requiredText(value, field, { max = 4096 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) fail('review_invalid_request', { field });
  return value;
}
function requiredExactText(value, field, { max }) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('review_invalid_request', { field });
  return value;
}
function sha256(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }

export async function archiveReviewResponse({ responsePath, text }) {
  if (typeof responsePath !== 'string' || !path.isAbsolute(responsePath) || !responsePath.trim()) fail('review_response_path_invalid');
  if (typeof text !== 'string' || !text.trim()) fail('review_response_invalid');
  const exactPath = path.resolve(responsePath);
  const parent = path.dirname(exactPath);
  await fs.mkdir(parent, { recursive: true });
  const verifyExisting = async () => {
    const first = await fs.readFile(exactPath, 'utf8');
    const second = await fs.readFile(exactPath, 'utf8');
    if (first !== text || second !== text) fail('review_response_path_conflict');
    return {
      path: exactPath,
      sha256: sha256(second),
      sizeBytes: Buffer.byteLength(second, 'utf8'),
      projection: 'exact',
      verifiedAt: Date.now()
    };
  };
  try {
    return await verifyExisting();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporaryPath = path.join(parent, `.${path.basename(exactPath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporaryPath, exactPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return await verifyExisting();
    }
    const directory = await fs.open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const observed = await fs.readFile(exactPath, 'utf8');
    if (observed !== text) fail('review_response_archive_verification_failed');
    return {
      path: exactPath,
      sha256: sha256(observed),
      sizeBytes: Buffer.byteLength(observed, 'utf8'),
      projection: 'exact',
      verifiedAt: Date.now()
    };
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function resolveReviewPromptInput({ prompt, promptPath } = {}, { cwd = process.cwd(), readFile = fs.readFile } = {}) {
  const hasPrompt = typeof prompt === 'string';
  const hasPromptPath = typeof promptPath === 'string' && promptPath.trim().length > 0;
  if (hasPrompt === hasPromptPath) throw new Error('exactly_one_of_prompt_or_promptPath_required');
  if (!hasPromptPath) return prompt;
  return await readFile(path.isAbsolute(promptPath) ? promptPath : path.resolve(cwd, promptPath), 'utf8');
}
export function validateReviewPromptSha256(prompt, promptSha256) {
  if (promptSha256 == null) return sha256(prompt);
  if (typeof promptSha256 !== 'string' || !SHA256_RE.test(promptSha256)) fail('review_prompt_sha256_invalid');
  if (promptSha256 !== sha256(prompt)) fail('review_prompt_sha256_mismatch');
  return promptSha256;
}
export async function prepareReviewPromptInput({ prompt, promptPath, promptSha256 } = {}, options = {}) {
  const exactPrompt = await resolveReviewPromptInput({ prompt, promptPath }, options);
  validateReviewPromptSha256(exactPrompt, promptSha256);
  return exactPrompt;
}

function conversationIdentityFromUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail('review_invalid_request', { field: 'conversationUrl' }); }
  const provider = parsed.hostname === 'chatgpt.com' ? 'chatgpt' : parsed.hostname === 'gemini.google.com' ? 'gemini' : null;
  if (parsed.protocol !== 'https:' || !provider || parsed.search || parsed.hash) fail('review_invalid_request', { field: 'conversationUrl' });
  const parts = parsed.pathname.split('/').filter(Boolean);
  const marker = parts.lastIndexOf(provider === 'chatgpt' ? 'c' : 'app');
  if (marker < 0 || marker + 1 >= parts.length) fail('review_invalid_request', { field: 'conversationUrl' });
  return { provider, conversationId: parts[marker + 1] };
}
function normalizeResponsePath(value) {
  if (path.isAbsolute(value)) return path.resolve(value);
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value);
  fail('review_invalid_request', { field: 'responsePath' });
}

function normalizeRequest(input) {
  const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const unknownField = Object.keys(request).find((field) => !REVIEW_REQUEST_FIELDS.has(field));
  if (unknownField) fail('review_invalid_request', { field: unknownField });
  const stableKey = requiredText(request.stableKey, 'stableKey', { max: 128 });
  const idempotencyKey = requiredText(request.idempotencyKey, 'idempotencyKey', { max: 128 });
  if (!KEY_RE.test(stableKey) || !KEY_RE.test(idempotencyKey)) fail('review_invalid_request', { field: 'key' });
  const provider = requiredText(request.provider, 'provider', { max: 64 }).toLowerCase();
  if (!['chatgpt', 'gemini'].includes(provider)) fail('review_invalid_request', { field: 'provider' });
  const productModel = requiredText(request.productModel, 'productModel', { max: 128 });
  if (!Object.hasOwn(request, 'reasoningEffort')) fail('review_invalid_request', { field: 'reasoningEffort' });
  const reasoningEffort = provider === 'chatgpt' ? requiredText(request.reasoningEffort, 'reasoningEffort', { max: 128 }) : request.reasoningEffort;
  if (provider === 'gemini' && reasoningEffort !== null) fail('review_invalid_request', { field: 'reasoningEffort' });
  if (provider === 'chatgpt' && productModel !== 'GPT-5.6 Sol') fail('review_invalid_request', { field: 'productModel' });
  if (provider === 'chatgpt' && reasoningEffort !== 'Pro') fail('review_invalid_request', { field: 'reasoningEffort' });
  const conversationUrl = requiredText(request.conversationUrl, 'conversationUrl', { max: 2048 });
  const conversationId = requiredText(request.conversationId, 'conversationId', { max: 256 });
  const firstBinding = request.firstBinding === true;
  const geminiBootstrap = request.geminiBootstrap === true;
  const geminiBootstrapContinuation = request.geminiBootstrapContinuation === true;
  const bootstrapNonScientific = request.bootstrapNonScientific === true;
  if (geminiBootstrap && (provider !== 'gemini' || !firstBinding || !bootstrapNonScientific || geminiBootstrapContinuation)) fail('review_invalid_request', { field: 'geminiBootstrap' });
  if (productModel === '__selected__' && !geminiBootstrap) fail('review_invalid_request', { field: 'productModel' });
  if (geminiBootstrapContinuation && (provider !== 'gemini' || firstBinding || geminiBootstrap)) fail('review_invalid_request', { field: 'geminiBootstrapContinuation' });
  if (firstBinding) {
    const supportedRoot = (provider === 'chatgpt' && conversationUrl === 'https://chatgpt.com/') || (provider === 'gemini' && conversationUrl === 'https://gemini.google.com/app');
    if (!supportedRoot || conversationId !== '__new__') fail('review_invalid_request', { field: 'firstBinding' });
  } else {
    const identity = conversationIdentityFromUrl(conversationUrl);
    if (identity.provider !== provider || identity.conversationId !== conversationId) fail('review_conversation_identity_mismatch');
  }
  const prompt = requiredExactText(request.prompt, 'prompt', { max: 200_000 });
  const promptSha256 = validateReviewPromptSha256(prompt, request.promptSha256);
  const verifyExisting = request.verifyExisting === true;
  const responsePath = requiredText(request.responsePath, 'responsePath', { max: 32_768 });
  const normalizedResponsePath = normalizeResponsePath(responsePath);
  const timeoutMs = Number(request.timeoutMs ?? MAX_REVIEW_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_REVIEW_TIMEOUT_MS || timeoutMs > MAX_REVIEW_TIMEOUT_MS) fail('review_timeout_out_of_range');
  const existingTabId = request.existingTabId == null ? null : requiredText(request.existingTabId, 'existingTabId', { max: 512 });
  return { stableKey, provider, productModel, reasoningEffort, conversationUrl, conversationId, idempotencyKey, prompt, promptSha256, responsePath: normalizedResponsePath, timeoutMs, verifyExisting, firstBinding, geminiBootstrap, geminiBootstrapContinuation, bootstrapNonScientific, existingTabId };
}
function fingerprintResponsePath(responsePath) {
  const wsl = /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.*)$/i.exec(responsePath || '');
  return wsl ? `/${wsl[1].replace(/\\/g, '/')}` : responsePath;
}
function requestFingerprintPayload(request, responsePath) {
  return { stableKey: request.stableKey, provider: request.provider, productModel: request.productModel, reasoningEffort: request.reasoningEffort, conversationUrl: request.conversationUrl, conversationId: request.conversationId, idempotencyKey: request.idempotencyKey, promptSha256: request.promptSha256, responsePath, firstBinding: request.firstBinding, geminiBootstrap: request.geminiBootstrap, geminiBootstrapContinuation: request.geminiBootstrapContinuation, bootstrapNonScientific: request.bootstrapNonScientific };
}
export function reviewRequestFingerprint(request) {
  return sha256(JSON.stringify(requestFingerprintPayload(request, fingerprintResponsePath(request.responsePath))));
}
async function withStateLock(stateDir, fn) {
  const key = path.resolve(stateDir);
  const previous = stateLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => next);
  stateLocks.set(key, chained);
  await previous;
  try { return await fn(); } finally { release(); if (stateLocks.get(key) === chained) stateLocks.delete(key); }
}
async function mutateState(stateDir, fn) {
  return await withStateLock(stateDir, async () => {
    const state = await readReviewTransportState(stateDir);
    const result = await fn(state);
    await writeReviewTransportState(state, stateDir);
    return result;
  });
}
async function readStateLocked(stateDir) { return await withStateLock(stateDir, async () => await readReviewTransportState(stateDir)); }
function sameImmutableRequest(operation, request) {
  return [
    'stableKey',
    'provider',
    'productModel',
    'reasoningEffort',
    'conversationUrl',
    'conversationId',
    'idempotencyKey',
    'promptSha256',
    'responsePath'
  ].every((field) => operation?.[field] === request[field]);
}

function rejectRetiredKeyReuse(state, request) {
  if (state.retiredIdempotencyKeys.includes(request.idempotencyKey)) {
    fail('review_idempotency_conflict', { keyType: 'idempotency' });
  }
  if (state.retiredStableKeys.includes(request.stableKey)) {
    fail('review_binding_mismatch', { keyType: 'binding' });
  }
}

function operationConversation(operation) {
  if (operation?.observedConversationUrl && operation?.observedConversationId) {
    return {
      conversationUrl: operation.observedConversationUrl,
      conversationId: operation.observedConversationId
    };
  }
  return {
    conversationUrl: operation.conversationUrl,
    conversationId: operation.conversationId
  };
}
function sameTarget(left, right) { return left?.provider === right.provider && left.productModel === right.productModel && left.reasoningEffort === right.reasoningEffort; }
function sameBinding(binding, request) { return binding?.stableKey === request.stableKey && sameTarget(binding, request) && binding.conversationUrl === request.conversationUrl && binding.conversationId === request.conversationId; }
function publicReceipt(operation) { return { ...operation }; }


function validateCompletion(result, request, expectedUserMessageId) {
  if (!result || typeof result !== 'object') fail('review_identity_unreadable');
  if (result.conversationUrl !== request.conversationUrl || result.conversationId !== request.conversationId) {
    fail('review_conversation_identity_mismatch');
  }
  const providerUserMessageId = requiredText(result.userMessageId, 'userMessageId', { max: 512 });
  if (expectedUserMessageId && providerUserMessageId !== expectedUserMessageId) {
    fail('review_user_message_identity_mismatch');
  }
  const providerAssistantMessageId = requiredText(result.assistantMessageId, 'assistantMessageId', { max: 512 });
  const responseText = requiredExactText(result.text, 'response', { max: 2_000_000 });
  const responseSha256 = sha256(responseText);
  const snapshots = Array.isArray(result.snapshots) ? result.snapshots : [];
  if (
    snapshots.length !== 2 ||
    snapshots.some((snapshot) =>
      snapshot?.assistantMessageId !== providerAssistantMessageId ||
      snapshot?.textSha256 !== responseSha256 ||
      !Number.isFinite(snapshot?.observedAt)
    ) ||
    snapshots[1].observedAt - snapshots[0].observedAt < 3_000
  ) fail('review_completion_unstable');
  const controls = result.controls && typeof result.controls === 'object' ? result.controls : {};
  if (controls.stop || controls.continue || controls.retry || (Array.isArray(result.clickedControls) && result.clickedControls.length)) {
    fail('review_completion_controls_active');
  }
  return { providerUserMessageId, providerAssistantMessageId, responseText };
}

function failureCode(error) {
  const value = String(error?.message || error || 'UNKNOWN_FAILURE').replace(/^review_/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return value || 'UNKNOWN_FAILURE';
}

function observeArgs(operation, request) {
  const identity = operationConversation(operation);
  return {
    expectedUrl: identity.conversationUrl,
    expectedConversationId: identity.conversationId,
    productModel: request.productModel,
    reasoningEffort: request.reasoningEffort,
    userMessageId: operation.providerUserMessageId,
    expectedPrompt: request.prompt,
    expectedPromptSha256: operation.promptSha256,
    timeoutMs: request.timeoutMs
  };
}

export async function runReviewQuery({ stateDir, tabs, request: rawRequest, onTabResolved = null }) {
  if (!stateDir || !tabs) fail('review_transport_misconfigured');
  const request = normalizeRequest(rawRequest);
  const fingerprint = reviewRequestFingerprint(request);
  const promptIdentity = reviewPlainTextIdentity(request.prompt);
  const intake = await mutateState(stateDir, async (state) => {
    const now = Date.now();
    rejectRetiredKeyReuse(state, request);
    const binding = state.bindings[request.stableKey];
    const existing = state.operations[request.idempotencyKey];
    if (
      existing &&
      (existing.requestFingerprint !== fingerprint || !sameImmutableRequest(existing, request))
    ) fail('review_idempotency_conflict');
    if (request.verifyExisting && !existing) fail('review_observation_unavailable');
    if (existing) {
      if (!existing.sendAttempted) {
        existing.error = null;
        existing.updatedAt = now;
      }
      return { operation: { ...existing }, binding: binding ? { ...binding } : null };
    }
    if (request.firstBinding) {
      if (binding) fail('review_binding_mismatch');
    } else if (binding) {
      if (!sameBinding(binding, request)) fail('review_binding_mismatch');
    } else {
      state.bindings[request.stableKey] = {
        stableKey: request.stableKey,
        provider: request.provider,
        productModel: request.productModel,
        reasoningEffort: request.reasoningEffort,
        conversationUrl: request.conversationUrl,
        conversationId: request.conversationId,
        createdAt: now,
        updatedAt: now
      };
    }
    const operation = {
      schemaVersion: 4,
      operationId: crypto.randomUUID(),
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint,
      stableKey: request.stableKey,
      provider: request.provider,
      productModel: request.productModel,
      reasoningEffort: request.reasoningEffort,
      conversationUrl: request.conversationUrl,
      conversationId: request.conversationId,
      promptSha256: request.promptSha256,
      responsePath: request.responsePath,
      sendAttempted: false,
      sendAttemptedAt: null,
      providerUserMessageId: null,
      providerAssistantMessageId: null,
      observedConversationUrl: null,
      observedConversationId: null,
      archive: null,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    state.operations[request.idempotencyKey] = operation;
    return { operation: { ...operation }, binding: null };
  });
  if (intake.operation.archive) return publicReceipt(intake.operation);

  let tabId;
  let controller;
  try {
    if (request.existingTabId) {
      const requestedIdentity = operationConversation(intake.operation);
      await tabs.adoptTab({
        id: request.existingTabId,
        key: request.stableKey,
        name: request.stableKey,
        url: requestedIdentity.conversationUrl,
        vendorId: request.provider,
        vendorName: request.provider === 'gemini' ? 'Gemini' : 'ChatGPT'
      });
    }
    const liveIdentity = operationConversation(intake.operation);
    tabId = await tabs.ensureTab({
      key: request.stableKey,
      name: request.stableKey,
      url: liveIdentity.conversationUrl,
      vendorId: request.provider,
      vendorName: request.provider === 'gemini' ? 'Gemini' : 'ChatGPT',
      show: true,
      exactUrl: true
    });
    const presenter = tabs.getWindowById(tabId);
    if (typeof presenter?.show !== 'function') fail('review_tab_presenter_unavailable');
    await presenter.show();
    controller = tabs.getControllerById(tabId);
  } catch (error) {
    await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      if (!operation) return;
      operation.error = { code: failureCode(error) };
      operation.updatedAt = Date.now();
    });
    throw error;
  }

  const runExclusive = async (fn) =>
    typeof controller?.runExclusive === 'function' ? await controller.runExclusive(fn) : await fn();
  let preparedBaselineMessageIds = null;
  const onPrepared = async (prepared) => {
    const baselineMessageIds = Array.isArray(prepared?.baselineMessageIds)
      ? prepared.baselineMessageIds.map((id) => requiredText(id, 'baselineMessageId', { max: 512 }))
      : null;
    if (!baselineMessageIds || new Set(baselineMessageIds).size !== baselineMessageIds.length) {
      fail('review_submission_baseline_invalid');
    }
    preparedBaselineMessageIds = baselineMessageIds;
  };
  const onComposerVerified = async (identity) => {
    if (
      identity?.ok !== true ||
      identity.textModel !== REVIEW_PLAIN_TEXT_MODEL ||
      identity.replacementModel !== REVIEW_COMPOSER_REPLACEMENT_MODEL ||
      identity.sourceSha256 !== request.promptSha256 ||
      identity.canonicalPromptSha256 !== promptIdentity.canonicalSha256 ||
      identity.observedCanonicalSha256 !== promptIdentity.canonicalSha256
    ) fail('review_composer_identity_receipt_invalid');
  };
  const onSendAttempted = async () => {
    await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      if (
        !operation ||
        operation.operationId !== intake.operation.operationId ||
        operation.sendAttempted
      ) fail('review_operation_state_invalid');
      const now = Date.now();
      operation.sendAttempted = true;
      operation.sendAttemptedAt = now;
      operation.updatedAt = now;
      operation.error = null;
    });
  };
  const onUserTurnObserved = async (observed) => {
    const providerUserMessageId = requiredText(
      observed?.observedUserMessageId || observed?.userMessageId,
      'observedUserMessageId',
      { max: 512 }
    );
    const observedConversationUrl = requiredText(observed?.conversationUrl, 'conversationUrl', { max: 2048 });
    const observedConversationId = requiredText(observed?.conversationId, 'conversationId', { max: 256 });
    await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      if (
        !operation ||
        operation.operationId !== intake.operation.operationId ||
        !operation.sendAttempted ||
        (operation.providerUserMessageId && operation.providerUserMessageId !== providerUserMessageId)
      ) fail('review_operation_state_invalid');
      Object.assign(operation, {
        providerUserMessageId,
        observedConversationUrl,
        observedConversationId,
        updatedAt: Date.now(),
        error: null
      });
      if (request.firstBinding) {
        const now = Date.now();
        state.bindings[request.stableKey] = {
          stableKey: request.stableKey,
          provider: request.provider,
          productModel: request.productModel,
          reasoningEffort: request.reasoningEffort,
          conversationUrl: observedConversationUrl,
          conversationId: observedConversationId,
          createdAt: now,
          updatedAt: now
        };
      }
    });
    if (request.firstBinding) tabs.updateTabUrl(tabId, observedConversationUrl);
  };

  try {
    await onTabResolved?.({ tabId, stableKey: request.stableKey, idempotencyKey: request.idempotencyKey });
    const execution = await runExclusive(async () => {
      let current = (await readStateLocked(stateDir)).operations[request.idempotencyKey];
      if (!current.sendAttempted) {
        const submitted = await controller.reviewQuery({
          prompt: request.prompt,
          expectedUrl: request.conversationUrl,
          expectedConversationId: request.conversationId,
          productModel: request.productModel,
          reasoningEffort: request.reasoningEffort,
          timeoutMs: request.timeoutMs,
          onPrepared,
          onComposerVerified,
          onSendAttempted,
          onUserTurnObserved,
          firstBinding: request.firstBinding,
          requireTargetPreflight: true
        });
        current = (await readStateLocked(stateDir)).operations[request.idempotencyKey];
        if (!current.providerUserMessageId && submitted?.userMessageId) {
          await onUserTurnObserved({
            userMessageId: submitted.userMessageId,
            conversationUrl: submitted.conversationUrl,
            conversationId: submitted.conversationId
          });
          current = (await readStateLocked(stateDir)).operations[request.idempotencyKey];
        }

      }
      if (!current.providerUserMessageId) {
        if (typeof controller?.observeReviewUserTurn !== 'function') fail('review_observation_unavailable');
        const observed = await controller.observeReviewUserTurn({
          prompt: request.prompt,
          expectedUrl: current.conversationUrl,
          expectedConversationId: current.conversationId,
          productModel: request.productModel,
          reasoningEffort: request.reasoningEffort,
          timeoutMs: request.timeoutMs,
          firstBinding: request.firstBinding,
          baselineMessageIds: preparedBaselineMessageIds
        });
        if (!observed?.userMessageId) return { waiting: true };
        await onUserTurnObserved(observed);
        current = (await readStateLocked(stateDir)).operations[request.idempotencyKey];
      }
      if (typeof controller?.observeReviewResponse !== 'function') fail('review_observation_unavailable');
      return {
        result: await controller.observeReviewResponse(observeArgs(current, request)),
        identity: operationConversation(current)
      };
    });

    if (execution.waiting || execution.result?.status === 'SENT_WAITING') {
      return publicReceipt((await readStateLocked(stateDir)).operations[request.idempotencyKey]);
    }
    const validated = validateCompletion(
      execution.result,
      { ...request, ...execution.identity },
      (await readStateLocked(stateDir)).operations[request.idempotencyKey].providerUserMessageId
    );
    await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      operation.providerUserMessageId = validated.providerUserMessageId;
      operation.providerAssistantMessageId = validated.providerAssistantMessageId;
      operation.observedConversationUrl = execution.identity.conversationUrl;
      operation.observedConversationId = execution.identity.conversationId;
      operation.error = null;
      operation.updatedAt = Date.now();
    });
    const archive = await archiveReviewResponse({
      responsePath: request.responsePath,
      text: validated.responseText
    });
    return await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      if (
        !operation.sendAttempted ||
        !operation.providerUserMessageId ||
        !operation.providerAssistantMessageId
      ) fail('review_send_receipt_invalid');
      operation.archive = archive;
      operation.error = null;
      operation.updatedAt = Date.now();
      return publicReceipt(operation);
    });
  } catch (error) {
    await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      if (!operation || operation.archive) return;
      operation.error = { code: failureCode(error) };
      operation.updatedAt = Date.now();
    }).catch(() => {});
    throw error;
  }
}


export { MAX_REVIEW_TIMEOUT_MS };
