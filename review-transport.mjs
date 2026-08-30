import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readReviewTransportState, writeReviewTransportState } from './state.mjs';
import {
  REVIEW_CAUSAL_SUBMISSION_MODEL,
  REVIEW_PLAIN_TEXT_MODEL,
  reviewBaselineMessageIdsSha256,
  reviewPlainTextIdentity
} from './review-text-identity.mjs';
import { REVIEW_COMPOSER_REPLACEMENT_MODEL } from './review-composer-replacement.mjs';

const MAX_REVIEW_TIMEOUT_MS = 45 * 60_000;
const MIN_REVIEW_TIMEOUT_MS = 1_000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REVIEW_OBSERVED_EXACT_TURN_MODEL = 'agentify_review_observed_exact_turn_v3';
const stateLocks = new Map();
const activeReviewExecutions = new Set();

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
export function sanitizeReviewErrorData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'boolean') output[key] = entry;
    else if (typeof entry === 'string' && entry.length <= 128) output[key] = entry;
    else if (Number.isInteger(entry) && entry >= 0 && entry <= 10_000_000) output[key] = entry;
    else if (Array.isArray(entry) && entry.length <= 8 && entry.every((item) => typeof item === 'string' && item.length <= 128)) output[key] = [...entry];
  }
  return Object.keys(output).length ? output : null;
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
function normalizeRequest(input) {
  const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const legacy of ['model', 'expectedModel', 'expectedMode', 'modelEvidence']) if (Object.hasOwn(request, legacy)) fail('review_invalid_request', { field: legacy });
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
  const responsePath = request.responsePath == null ? null : requiredText(request.responsePath, 'responsePath', { max: 32_768 });
  if (!verifyExisting && !responsePath) fail('review_invalid_request', { field: 'responsePath' });
  if (responsePath && !path.isAbsolute(responsePath)) fail('review_invalid_request', { field: 'responsePath' });
  const timeoutMs = Number(request.timeoutMs ?? MAX_REVIEW_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_REVIEW_TIMEOUT_MS || timeoutMs > MAX_REVIEW_TIMEOUT_MS) fail('review_timeout_out_of_range');
  const existingTabId = request.existingTabId == null ? null : requiredText(request.existingTabId, 'existingTabId', { max: 512 });
  return { stableKey, provider, productModel, reasoningEffort, conversationUrl, conversationId, idempotencyKey, prompt, promptSha256, responsePath: responsePath ? path.resolve(responsePath) : null, timeoutMs, verifyExisting, firstBinding, geminiBootstrap, geminiBootstrapContinuation, bootstrapNonScientific, existingTabId };
}
function requestFingerprint(request) {
  return sha256(JSON.stringify({ stableKey: request.stableKey, provider: request.provider, productModel: request.productModel, reasoningEffort: request.reasoningEffort, conversationUrl: request.conversationUrl, conversationId: request.conversationId, idempotencyKey: request.idempotencyKey, promptSha256: request.promptSha256, responsePath: request.responsePath, firstBinding: request.firstBinding, geminiBootstrap: request.geminiBootstrap, geminiBootstrapContinuation: request.geminiBootstrapContinuation, bootstrapNonScientific: request.bootstrapNonScientific }));
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
function repairable(operation) {
  return operation?.phase === 'PREPARE_UI' && operation.commitment === 'ZERO_PROVEN' && operation.recoverability === 'PRECOMMIT_REPAIR' && operation.messageCapability === 'AVAILABLE' && operation.providerUserMessageCount === 0 && operation.sendActivationCount === 0 && !operation.userMessageId;
}
function sealInterruptedReservation(operation) {
  if (operation?.phase !== 'ARMED' || operation.messageCapability !== 'RESERVED') return false;
  operation.phase = 'VERIFY_COMMITMENT';
  operation.commitment = 'UNRESOLVED';
  operation.recoverability = 'OBSERVE_ONLY';
  operation.observability = 'LOST';
  operation.messageCapability = 'SEALED';
  operation.failure = { locus: 'COMMIT_BOUNDARY', code: 'INTERRUPTED_RESERVED_BOUNDARY' };
  operation.updatedAt = Date.now();
  return true;
}
function sameTarget(left, right) { return left?.provider === right.provider && left.productModel === right.productModel && left.reasoningEffort === right.reasoningEffort; }
function matchesExistingObservation(existing, request) {
  const operationIdentity = existing.conversationUrl === request.conversationUrl && existing.conversationId === request.conversationId;
  const observedIdentity = existing.firstBinding && existing.observedConversationUrl === request.conversationUrl && existing.observedConversationId === request.conversationId;
  return request.verifyExisting && existing.stableKey === request.stableKey && sameTarget(existing, request) && existing.idempotencyKey === request.idempotencyKey && existing.promptSha256 === request.promptSha256 && (!request.responsePath || !existing.responsePath || existing.responsePath === request.responsePath) && (operationIdentity || observedIdentity);
}
function sameBinding(binding, request) { return binding?.stableKey === request.stableKey && sameTarget(binding, request) && binding.conversationUrl === request.conversationUrl && binding.conversationId === request.conversationId; }
function publicReceipt(operation) { const { responseText: _responseText, ...receipt } = operation; return receipt; }

export async function inspectReviewAdmission({ stateDir, request: rawRequest }) {
  if (!stateDir) fail('review_transport_misconfigured');
  const request = normalizeRequest(rawRequest);
  const fingerprint = requestFingerprint(request);
  const state = await readStateLocked(stateDir);
  const existing = state.operations[request.idempotencyKey] || null;
  if (existing && existing.requestFingerprint !== fingerprint && !matchesExistingObservation(existing, request)) fail('review_idempotency_conflict');
  const mayRepair = !!existing && repairable(existing) && !request.verifyExisting;
  const observationOnly = request.verifyExisting || (!!existing && !mayRepair);
  return { idempotencyKey: request.idempotencyKey, requestFingerprint: fingerprint, exactExisting: !!existing, repairable: mayRepair, observationOnly, requiresSendCapacity: !observationOnly };
}
export async function observeReviewOperation({ stateDir, idempotencyKey, operationId = null }) {
  if (!stateDir) fail('review_transport_misconfigured');
  const key = requiredText(idempotencyKey, 'idempotencyKey', { max: 512 });
  const operation = (await readStateLocked(stateDir)).operations[key];
  if (!operation) fail('review_operation_not_found');
  if (operationId && operation.operationId !== operationId) fail('review_operation_identity_mismatch');
  return { observationKind: 'ledger_only', ...publicReceipt(operation), repairable: repairable(operation) };
}
function requireProductModelEvidence(value, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.requestedProductModel !== request.productModel || value.matchedLabel !== request.productModel || value.scopedMatchCount !== 1) fail('review_product_model_evidence_invalid');
  return { ...value };
}
function requireReasoningEffortEvidence(value, request) {
  if (request.provider === 'gemini') { if (value !== null && value !== undefined) fail('review_reasoning_effort_evidence_invalid'); return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.requestedReasoningEffort !== request.reasoningEffort || value.matchedLabel !== request.reasoningEffort || value.scopedMatchCount !== 1) fail('review_reasoning_effort_evidence_invalid');
  return { ...value };
}
function validateCompletion(result, request, expectedUserMessageId) {
  if (!result || typeof result !== 'object') fail('review_identity_unreadable');
  if (result.conversationUrl !== request.conversationUrl || result.conversationId !== request.conversationId) fail('review_conversation_identity_mismatch');
  const userMessageId = requiredText(result.userMessageId, 'userMessageId', { max: 512 });
  if (expectedUserMessageId && userMessageId !== expectedUserMessageId) fail('review_user_message_identity_mismatch');
  const assistantMessageId = requiredText(result.assistantMessageId, 'assistantMessageId', { max: 512 });
  const responseText = requiredExactText(result.text, 'response', { max: 2_000_000 });
  const responseSha256 = sha256(responseText);
  const snapshots = Array.isArray(result.snapshots) ? result.snapshots : [];
  if (snapshots.length !== 2 || snapshots.some((snapshot) => snapshot?.assistantMessageId !== assistantMessageId || snapshot?.textSha256 !== responseSha256 || !Number.isFinite(snapshot?.observedAt)) || snapshots[1].observedAt - snapshots[0].observedAt < 3_000) fail('review_completion_unstable');
  const controls = result.controls && typeof result.controls === 'object' ? result.controls : {};
  if (controls.stop || controls.continue || controls.retry || (Array.isArray(result.clickedControls) && result.clickedControls.length)) fail('review_completion_controls_active');
  return { userMessageId, assistantMessageId, responseText, snapshots, controls: { stop: false, continue: false, retry: false, answerNow: !!controls.answerNow }, productModelEvidence: requireProductModelEvidence(result.productModelEvidence, request), reasoningEffortEvidence: requireReasoningEffortEvidence(result.reasoningEffortEvidence, request) };
}
function failureCode(error) {
  const value = String(error?.message || error || 'UNKNOWN_FAILURE').replace(/^review_/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return value || 'UNKNOWN_FAILURE';
}
function observeArgs(operation, request) {
  return { expectedUrl: operation.conversationUrl, expectedConversationId: operation.conversationId, productModel: request.productModel, reasoningEffort: request.reasoningEffort, submittedProductModelEvidence: operation.productModelEvidence, submittedReasoningEffortEvidence: operation.reasoningEffortEvidence, userMessageId: operation.userMessageId, expectedPrompt: request.prompt, expectedPromptSha256: operation.promptSha256, baselineMessageIds: operation.baselineMessageIds, providerUserMessageCount: operation.providerUserMessageCount, sendActivationCount: operation.sendActivationCount, timeoutMs: request.timeoutMs };
}

async function runReviewQueryExecution({ stateDir, tabs, request: rawRequest, onTabResolved = null }) {
  if (!stateDir || !tabs) fail('review_transport_misconfigured');
  const request = normalizeRequest(rawRequest);
  const fingerprint = requestFingerprint(request);
  const promptIdentity = reviewPlainTextIdentity(request.prompt);
  const intake = await mutateState(stateDir, async (state) => {
    const now = Date.now();
    const binding = state.bindings[request.stableKey];
    const existing = state.operations[request.idempotencyKey];
    sealInterruptedReservation(existing);
    if (existing && existing.requestFingerprint !== fingerprint && !matchesExistingObservation(existing, request)) fail('review_idempotency_conflict');
    if (request.verifyExisting) {
      if (!existing || existing.commitment === 'ZERO_PROVEN') fail('review_observation_unavailable');
      if (!request.responsePath && existing.responsePath) request.responsePath = existing.responsePath;
      if (!request.responsePath) fail('review_observation_unavailable');
      return { existing: true, repair: false, operation: { ...existing }, binding: binding ? { ...binding } : null };
    }
    if (existing) {
      if (!repairable(existing)) fail('review_delivery_replay_forbidden');
      existing.attemptCount += 1;
      existing.failure = { locus: 'NONE', code: 'NONE' };
      delete existing.error; delete existing.errorData;
      existing.observability = 'UNOBSERVED'; existing.updatedAt = now;
      return { existing: true, repair: true, operation: { ...existing }, binding: binding ? { ...binding } : null };
    }
    if (request.firstBinding) { if (binding) fail('review_binding_mismatch'); }
    else if (binding) { if (!sameBinding(binding, request)) fail('review_binding_mismatch'); }
    else state.bindings[request.stableKey] = { stableKey: request.stableKey, provider: request.provider, productModel: request.productModel, reasoningEffort: request.reasoningEffort, conversationUrl: request.conversationUrl, conversationId: request.conversationId, createdAt: now, updatedAt: now };
    const operation = { schemaVersion: 3, operationId: crypto.randomUUID(), idempotencyKey: request.idempotencyKey, requestFingerprint: fingerprint, stableKey: request.stableKey, provider: request.provider, productModel: request.productModel, reasoningEffort: request.reasoningEffort, conversationUrl: request.conversationUrl, conversationId: request.conversationId, firstBinding: request.firstBinding, geminiBootstrap: request.geminiBootstrap, geminiBootstrapContinuation: request.geminiBootstrapContinuation, bootstrapNonScientific: request.bootstrapNonScientific, promptSha256: request.promptSha256, responsePath: request.responsePath, promptTextModel: promptIdentity.textModel, canonicalPromptSha256: promptIdentity.canonicalSha256, phase: 'PREPARE_UI', commitment: 'ZERO_PROVEN', recoverability: 'PRECOMMIT_REPAIR', observability: 'UNOBSERVED', messageCapability: 'AVAILABLE', failure: { locus: 'NONE', code: 'NONE' }, providerUserMessageCount: 0, sendActivationCount: 0, attemptCount: 1, createdAt: now, updatedAt: now };
    state.operations[request.idempotencyKey] = operation;
    return { existing: false, repair: false, operation: { ...operation }, binding: null };
  });
  if (intake.operation.phase === 'TERMINAL') return publicReceipt(intake.operation);
  let tabId;
  let controller;
  try {
    if (request.existingTabId && (!intake.existing || request.verifyExisting)) {
      await tabs.adoptTab({ id: request.existingTabId, key: request.stableKey, name: request.stableKey, url: request.conversationUrl, vendorId: request.provider, vendorName: request.provider === 'gemini' ? 'Gemini' : 'ChatGPT' });
    }
    const liveIdentity = request.verifyExisting ? request : intake.binding || request;
    tabId = await tabs.ensureTab({ key: request.stableKey, name: request.stableKey, url: liveIdentity.conversationUrl, vendorId: request.provider, vendorName: request.provider === 'gemini' ? 'Gemini' : 'ChatGPT', show: true, exactUrl: true });
    const presenter = tabs.getWindowById(tabId);
    if (typeof presenter?.show !== 'function') fail('review_tab_presenter_unavailable');
    await presenter.show();
    controller = tabs.getControllerById(tabId);
  } catch (error) {
    await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      if (operation && repairable(operation)) {
        operation.failure = { locus: 'TAB_OWNERSHIP', code: failureCode(error) };
        operation.observability = 'FRESH_COMPLETE';
        operation.error = String(error?.message || error);
        operation.updatedAt = Date.now();
      }
    });
    throw error;
  }
  const runExclusive = async (fn) => typeof controller?.runExclusive === 'function' ? await controller.runExclusive(fn) : await fn();
  const onPrepared = async (prepared) => {
    const baselineMessageIds = Array.isArray(prepared?.baselineMessageIds) ? prepared.baselineMessageIds.map((id) => requiredText(id, 'baselineMessageId', { max: 512 })) : null;
    if (!baselineMessageIds || new Set(baselineMessageIds).size !== baselineMessageIds.length) fail('review_submission_baseline_invalid');
    const productModelEvidence = requireProductModelEvidence(prepared.productModelEvidence, request);
    const reasoningEffortEvidence = requireReasoningEffortEvidence(prepared.reasoningEffortEvidence, request);
    await mutateState(stateDir, async (state) => { const operation = state.operations[request.idempotencyKey]; if (!operation || operation.operationId !== intake.operation.operationId || !repairable(operation)) fail('review_operation_state_invalid'); Object.assign(operation, { baselineMessageIds, productModelEvidence, reasoningEffortEvidence, preparedAt: prepared?.preparedAt || Date.now(), observability: 'FRESH_COMPLETE', updatedAt: Date.now() }); });
  };
  const onComposerVerified = async (identity) => {
    if (identity?.ok !== true || identity.textModel !== REVIEW_PLAIN_TEXT_MODEL || identity.replacementModel !== REVIEW_COMPOSER_REPLACEMENT_MODEL || identity.sourceSha256 !== request.promptSha256 || identity.canonicalPromptSha256 !== promptIdentity.canonicalSha256 || identity.observedCanonicalSha256 !== promptIdentity.canonicalSha256) fail('review_composer_identity_receipt_invalid');
    await mutateState(stateDir, async (state) => { const operation = state.operations[request.idempotencyKey]; if (!operation || operation.operationId !== intake.operation.operationId || !repairable(operation)) fail('review_operation_state_invalid'); operation.composerIdentity = sanitizeReviewErrorData(identity); operation.updatedAt = Date.now(); });
  };
  const onSendBoundaryEntered = async (boundary) => {
    const productModelEvidence = requireProductModelEvidence(boundary?.productModelEvidence, request);
    const reasoningEffortEvidence = requireReasoningEffortEvidence(boundary?.reasoningEffortEvidence, request);
    await mutateState(stateDir, async (state) => { const operation = state.operations[request.idempotencyKey]; if (!operation || operation.operationId !== intake.operation.operationId || !repairable(operation)) fail('review_operation_state_invalid'); Object.assign(operation, { phase: 'ARMED', messageCapability: 'RESERVED', recoverability: 'OBSERVE_ONLY', sendBoundaryEnteredAt: Number.isFinite(boundary?.enteredAt) ? boundary.enteredAt : Date.now(), productModelEvidence, reasoningEffortEvidence, updatedAt: Date.now() }); });
  };
  const onSendAction = async (action) => {
    if (action?.clickCount !== 1 || action?.sendActivationCount !== 1 || action?.clickTimeIdentity?.ok !== true) fail('review_send_action_receipt_invalid');
    const productModelEvidence = requireProductModelEvidence(action.productModelEvidence, request);
    const reasoningEffortEvidence = requireReasoningEffortEvidence(action.reasoningEffortEvidence, request);
    return await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      if (!operation || operation.operationId !== intake.operation.operationId || operation.phase !== 'ARMED' || operation.messageCapability !== 'RESERVED' || operation.sendActivationCount !== 0) fail('review_operation_state_invalid');
      const baselineMessageIdsSha256 = reviewBaselineMessageIdsSha256(operation.baselineMessageIds);
      if (!baselineMessageIdsSha256) fail('review_submission_baseline_missing');
      const causalSendReceipt = { ok: true, persisted: true, identityModel: REVIEW_CAUSAL_SUBMISSION_MODEL, operationId: operation.operationId, sendActionCount: 1, clickCount: 1, sourceSha256: request.promptSha256, canonicalPromptSha256: promptIdentity.canonicalSha256, baselineMessageIdsSha256, productModelEvidence, reasoningEffortEvidence };
      Object.assign(operation, { phase: 'VERIFY_COMMITMENT', commitment: 'UNRESOLVED', recoverability: 'OBSERVE_ONLY', observability: 'FRESH_PARTIAL', messageCapability: 'SEALED', sendActivationCount: 1, causalSendReceipt, productModelEvidence, reasoningEffortEvidence, updatedAt: Date.now() });
      return { ...causalSendReceipt };
    });
  };
  const onUserTurnObserved = async (observed) => {
    const userMessageId = requiredText(observed?.observedUserMessageId, 'observedUserMessageId', { max: 512 });
    if (observed?.providerUserMessageCount !== 1 || !['turn_exact', 'turn_causal_exact_rendered_unreadable'].includes(observed?.commitmentClass)) {
      fail('review_observed_user_turn_receipt_invalid');
    }
    await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      const confirmationMode = observed?.turnConfirmationMode ||
        (operation?.causalSendReceipt ? REVIEW_CAUSAL_SUBMISSION_MODEL : REVIEW_OBSERVED_EXACT_TURN_MODEL);
      const activationObserved = operation?.sendActivationCount === 1;
      const exactObservationWithoutActivationReceipt =
        operation?.sendActivationCount === 0 &&
        operation?.commitment === 'UNRESOLVED' &&
        operation?.messageCapability === 'SEALED' &&
        confirmationMode === REVIEW_OBSERVED_EXACT_TURN_MODEL;
      if (
        !operation ||
        operation.operationId !== intake.operation.operationId ||
        (!activationObserved && !exactObservationWithoutActivationReceipt)
      ) fail('review_operation_state_invalid');
      Object.assign(operation, {
        phase: 'WAIT_RESPONSE',
        commitment: 'ONE_EXACT',
        recoverability: 'POSTCOMMIT_RECOVERY',
        observability: 'FRESH_COMPLETE',
        messageCapability: 'SEALED',
        providerUserMessageCount: 1,
        userMessageId,
        observedUserMessageId: userMessageId,
        observedConversationUrl: observed.conversationUrl,
        observedConversationId: observed.conversationId,
        observedAt: observed.observedAt || Date.now(),
        turnConfirmationMode: confirmationMode,
        updatedAt: Date.now()
      });
    });
  };
  const onSubmitted = async (submitted) => {
    const userMessageId = requiredText(submitted?.userMessageId, 'userMessageId', { max: 512 });
    const conversationUrl = requiredText(submitted?.conversationUrl, 'conversationUrl', { max: 2048 });
    const conversationId = requiredText(submitted?.conversationId, 'conversationId', { max: 256 });
    await mutateState(stateDir, async (state) => { const operation = state.operations[request.idempotencyKey]; if (!operation || operation.operationId !== intake.operation.operationId || operation.commitment !== 'ONE_EXACT' || operation.userMessageId !== userMessageId) fail('review_operation_state_invalid'); Object.assign(operation, { conversationUrl, conversationId, submittedAt: submitted?.submittedAt || Date.now(), updatedAt: Date.now() }); if (operation.firstBinding) { const now = Date.now(); state.bindings[request.stableKey] = { stableKey: request.stableKey, provider: request.provider, productModel: request.productModel, reasoningEffort: request.reasoningEffort, conversationUrl, conversationId, createdAt: now, updatedAt: now }; } });
    if (request.firstBinding) tabs.updateTabUrl(tabId, conversationUrl);
  };
  try {
    await mutateState(stateDir, async (state) => { const operation = state.operations[request.idempotencyKey]; operation.tabId = tabId; operation.updatedAt = Date.now(); });
    await onTabResolved?.({ tabId, stableKey: request.stableKey, idempotencyKey: request.idempotencyKey });
    const execution = await runExclusive(async () => {
      const current = (await readStateLocked(stateDir)).operations[request.idempotencyKey];
      if (request.verifyExisting) {
        if (current.commitment === 'UNRESOLVED' && typeof controller?.recoverReviewSubmission === 'function') {
          const recovery = await controller.recoverReviewSubmission({
            prompt: request.prompt,
            baselineMessageIds: current.baselineMessageIds,
            expectedUrl: request.conversationUrl,
            expectedConversationId: request.conversationId,
            productModel: request.productModel,
            reasoningEffort: request.reasoningEffort,
            submittedProductModelEvidence: current.productModelEvidence,
            submittedReasoningEffortEvidence: current.reasoningEffortEvidence,
            timeoutMs: request.timeoutMs,
            causalSubmissionReceipt: current.causalSendReceipt,
            onRecovered: async (recovered) => {
              await onUserTurnObserved({
                observedUserMessageId: recovered.userMessageId,
                providerUserMessageCount: 1,
                commitmentClass: 'turn_exact',
                conversationUrl: recovered.conversationUrl,
                conversationId: recovered.conversationId,
                observedAt: recovered.submittedAt,
                turnConfirmationMode: recovered.identityMode
              });
              await onSubmitted(recovered);
            }
          });
          if (!recovery?.userMessageId) return { waiting: true };
        }
        const rebound = (await readStateLocked(stateDir)).operations[request.idempotencyKey];
        if (rebound.commitment !== 'ONE_EXACT' || typeof controller?.observeReviewResponse !== 'function') fail('review_observation_unavailable');
        return { result: await controller.observeReviewResponse(observeArgs(rebound, request)), expectedUserMessageId: rebound.userMessageId };
      }
      return { result: await controller.reviewQuery({ prompt: request.prompt, expectedUrl: request.conversationUrl, expectedConversationId: request.conversationId, productModel: request.productModel, reasoningEffort: request.reasoningEffort, timeoutMs: request.timeoutMs, onPrepared, onComposerVerified, onSendBoundaryEntered, onSendAction, onUserTurnObserved, onSubmitted, firstBinding: request.firstBinding, requireTargetPreflight: true }) };
    });
    if (execution.waiting || ['SENT_WAITING', 'SENT_UNREADABLE'].includes(execution.result?.status)) return await mutateState(stateDir, async (state) => { const operation = state.operations[request.idempotencyKey]; if (operation.commitment === 'ONE_EXACT') Object.assign(operation, { phase: 'WAIT_RESPONSE', recoverability: 'POSTCOMMIT_RECOVERY', observability: 'FRESH_PARTIAL' }); operation.updatedAt = Date.now(); return publicReceipt(operation); });
    const resultRequest = request.firstBinding ? { ...request, conversationUrl: execution.result.conversationUrl, conversationId: execution.result.conversationId } : request;
    const current = (await readStateLocked(stateDir)).operations[request.idempotencyKey];
    const validated = validateCompletion(execution.result, resultRequest, current.userMessageId);
    await mutateState(stateDir, async (state) => { state.operations[request.idempotencyKey].phase = 'PUBLISH_ARCHIVE'; state.operations[request.idempotencyKey].updatedAt = Date.now(); });
    const archive = await archiveReviewResponse({ responsePath: request.responsePath, text: validated.responseText });
    return await mutateState(stateDir, async (state) => { const operation = state.operations[request.idempotencyKey]; if (operation.commitment !== 'ONE_EXACT' || operation.providerUserMessageCount !== 1) fail('review_send_receipt_invalid'); Object.assign(operation, { phase: 'TERMINAL', recoverability: 'NONE', observability: 'FRESH_COMPLETE', failure: { locus: 'NONE', code: 'NONE' }, userMessageId: validated.userMessageId, assistantMessageId: validated.assistantMessageId, snapshots: validated.snapshots, controls: validated.controls, productModelEvidence: validated.productModelEvidence, reasoningEffortEvidence: validated.reasoningEffortEvidence, archive, completedAt: Date.now(), updatedAt: Date.now() }); delete operation.error; delete operation.errorData; return publicReceipt(operation); });
  } catch (error) {
    await mutateState(stateDir, async (state) => {
      const operation = state.operations[request.idempotencyKey];
      if (!operation || operation.phase === 'TERMINAL') return;
      const noActivation = operation.sendActivationCount === 0 && operation.providerUserMessageCount === 0;
      const directNoActivation = noActivation && (operation.messageCapability === 'AVAILABLE' || (operation.messageCapability === 'RESERVED' && error?.data?.noClickProven === true));
      operation.error = String(error?.message || error); operation.errorData = sanitizeReviewErrorData(error?.data);
      const archiveFailure = operation.phase === 'PUBLISH_ARCHIVE';
      const contradiction = operation.commitment === 'UNRESOLVED' && [
        'review_user_message_content_mismatch',
        'review_user_message_identity_ambiguous',
        'review_observed_user_turn_receipt_invalid'
      ].includes(operation.error);
      operation.failure = {
        locus: directNoActivation ? 'PRECOMMIT_UI' : archiveFailure ? 'ARCHIVE' : contradiction ? 'TURN_CONFIRMATION' : operation.commitment === 'ONE_EXACT' ? 'RESPONSE' : 'COMMIT_BOUNDARY',
        code: directNoActivation && operation.messageCapability === 'RESERVED' ? 'DIRECT_NO_ACTIVATION_RECEIPT' : failureCode(error)
      };
      if (directNoActivation) {
        Object.assign(operation, { phase: 'PREPARE_UI', commitment: 'ZERO_PROVEN', recoverability: 'PRECOMMIT_REPAIR', observability: 'FRESH_COMPLETE', messageCapability: 'AVAILABLE' });
        delete operation.sendBoundaryEnteredAt;
      } else if (operation.commitment === 'ONE_EXACT') {
        Object.assign(operation, { phase: archiveFailure ? 'PUBLISH_ARCHIVE' : 'WAIT_RESPONSE', recoverability: 'POSTCOMMIT_RECOVERY', observability: 'FRESH_PARTIAL', messageCapability: 'SEALED' });
      } else if (contradiction) {
        Object.assign(operation, { phase: 'TERMINAL', commitment: 'VIOLATION', recoverability: 'HUMAN_INTERLOCK', observability: 'CONTRADICTORY', messageCapability: 'SEALED' });
      } else {
        Object.assign(operation, { phase: 'VERIFY_COMMITMENT', commitment: 'UNRESOLVED', recoverability: 'OBSERVE_ONLY', observability: 'FRESH_PARTIAL', messageCapability: 'SEALED' });
      }
      operation.updatedAt = Date.now();
    }).catch(() => {});
    throw error;
  }
}
export async function runReviewQuery(args) {
  const stateDir = args?.stateDir;
  const idempotencyKey = args?.request?.idempotencyKey;
  if (!stateDir || typeof idempotencyKey !== 'string' || !idempotencyKey) {
    return await runReviewQueryExecution(args || {});
  }
  const executionKey = `${path.resolve(stateDir)}\0${idempotencyKey}`;
  if (activeReviewExecutions.has(executionKey)) fail('review_operation_in_progress');
  activeReviewExecutions.add(executionKey);
  try {
    return await runReviewQueryExecution(args);
  } finally {
    activeReviewExecutions.delete(executionKey);
  }
}


export { MAX_REVIEW_TIMEOUT_MS };
