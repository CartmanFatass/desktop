import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readReviewTransportState, writeReviewTransportState } from './state.mjs';
import {
  REVIEW_CAUSAL_SUBMISSION_MODEL,
  REVIEW_PLAIN_TEXT_MODEL,
  reviewBaselineMessageIdsSha256,
  reviewPlainTextIdentity,
  validateReviewCausalSubmissionReceipt
} from './review-text-identity.mjs';
import { REVIEW_COMPOSER_REPLACEMENT_MODEL } from './review-composer-replacement.mjs';

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

export async function archiveReviewResponse({ responsePath, text, allowTerminalLfProjection = false }) {
  if (typeof responsePath !== 'string' || !path.isAbsolute(responsePath) || !responsePath.trim()) {
    fail('review_response_path_invalid');
  }
  if (typeof text !== 'string' || !text.trim()) fail('review_response_invalid');
  const exactPath = path.resolve(responsePath);
  const parent = path.dirname(exactPath);
  const responseSha256 = sha256(text);
  const responseBytes = Buffer.byteLength(text, 'utf8');
  await fs.mkdir(parent, { recursive: true });

  try {
    const existing = await fs.readFile(exactPath, 'utf8');
    const responseArchiveProjection = existing === text
      ? 'exact'
      : allowTerminalLfProjection === true && !text.endsWith('\n') && existing === `${text}\n`
        ? 'terminal_lf_v1'
        : null;
    if (!responseArchiveProjection) fail('review_response_path_conflict');
    return {
      responsePath: exactPath,
      responseSha256: sha256(existing),
      responseBytes: Buffer.byteLength(existing, 'utf8'),
      responseArchiveProjection
    };
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
    await fs.rename(temporaryPath, exactPath);
    const observed = await fs.readFile(exactPath, 'utf8');
    if (observed !== text) fail('review_response_archive_verification_failed');
    return {
      responsePath: exactPath,
      responseSha256,
      responseBytes,
      responseArchiveProjection: 'exact'
    };
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
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
  if (promptSha256 == null) return sha256(prompt);
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
  for (const field of [
    'ok', 'serializerOk', 'noClickProven', 'initialSerializerOk',
    'emptyVerified', 'caretVerified', 'recoveredExact', 'selectionVerified'
  ]) {
    if (typeof data[field] === 'boolean') output[field] = data[field];
  }
  for (const field of [
    'serializerMethod', 'serializerError', 'serializerTag', 'rootTag',
    'predicate', 'failureStage', 'textModel', 'identityMode', 'mismatchClass',
    'firstMismatchExpectedCodePoint', 'firstMismatchObservedCodePoint',
    'replacementModel', 'composerKind', 'clearMethod', 'caretMethod',
    'commitmentClass', 'submissionIdentityMode', 'renderedDisplayFidelity', 'identityModel'
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
    'newUserMessageCount', 'sendActionCount', 'baselineMessageCount', 'expectedRawLength',
    'expectedCanonicalLength', 'observedRawLength', 'observedCanonicalLength',
    'browserSpaceRebalanceCount', 'mismatchCount', 'firstMismatchCodePointIndex',
    'initialSerializedLength', 'emptySnapshotCount', 'promptInsertCount',
    'deleteKeyCount'
  ]) {
    if (Number.isInteger(data[field]) && data[field] >= 0 && data[field] <= 10_000_000) {
      output[field] = data[field];
    }
  }
  for (const field of [
    'sourceSha256', 'canonicalPromptSha256', 'observedRawSha256', 'observedCanonicalSha256',
    'baselineMessageIdsSha256'
  ]) {
    if (/^[0-9a-f]{64}$/.test(String(data[field] || ''))) output[field] = data[field];
  }
  if (typeof data.lineEndingCanonicalized === 'boolean') {
    output.lineEndingCanonicalized = data.lineEndingCanonicalized;
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
  const geminiBootstrap = request.geminiBootstrap === true;
  const geminiBootstrapContinuation = request.geminiBootstrapContinuation === true;
  const bootstrapNonScientific = request.bootstrapNonScientific === true;
  if (geminiBootstrap && (provider !== 'gemini' || !firstBinding || !bootstrapNonScientific || geminiBootstrapContinuation)) {
    fail('review_invalid_request', { field: 'geminiBootstrap' });
  }
  if (model === '__selected__' && !geminiBootstrap) fail('review_invalid_request', { field: 'model' });
  if (geminiBootstrapContinuation && (provider !== 'gemini' || firstBinding || geminiBootstrap)) {
    fail('review_invalid_request', { field: 'geminiBootstrapContinuation' });
  }
  if (firstBinding) {
    const supportedRoot =
      (provider === 'chatgpt' && conversationUrl === 'https://chatgpt.com/') ||
      (provider === 'gemini' && conversationUrl === 'https://gemini.google.com/app');
    if (!supportedRoot || conversationId !== '__new__') {
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
  const verifyExisting = request.verifyExisting === true;
  const responsePath = request.responsePath == null
    ? null
    : requiredText(request.responsePath, 'responsePath', { max: 32_768 });
  if (!verifyExisting && !responsePath) fail('review_invalid_request', { field: 'responsePath' });
  if (responsePath && !path.isAbsolute(responsePath)) fail('review_invalid_request', { field: 'responsePath' });
  const timeoutMs = Number(request.timeoutMs ?? MAX_REVIEW_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_REVIEW_TIMEOUT_MS || timeoutMs > MAX_REVIEW_TIMEOUT_MS) {
    fail('review_timeout_out_of_range');
  }
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
    responsePath: responsePath ? path.resolve(responsePath) : null,
    timeoutMs,
    verifyExisting,
    diagnoseExisting,
    firstBinding,
    geminiBootstrap,
    geminiBootstrapContinuation,
    bootstrapNonScientific,
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
      responsePath: request.responsePath,
      timeoutMs: request.timeoutMs,
      firstBinding: request.firstBinding,
      geminiBootstrap: request.geminiBootstrap,
      geminiBootstrapContinuation: request.geminiBootstrapContinuation,
      bootstrapNonScientific: request.bootstrapNonScientific
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

export async function inspectReviewAdmission({ stateDir, request: rawRequest }) {
  if (!stateDir) fail('review_transport_misconfigured');
  const request = normalizeRequest(rawRequest);
  const fingerprint = requestFingerprint(request);
  const state = await readStateLocked(stateDir);
  const existing = state.operations[request.idempotencyKey] || null;
  if (existing && existing.requestFingerprint !== fingerprint && !matchesExistingObservation(existing, request)) fail('review_idempotency_conflict');
  const exactExisting = !!existing;
  const observationOnly = request.verifyExisting || request.diagnoseExisting || exactExisting;
  return {
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprint,
    exactExisting,
    observationOnly,
    requiresSendCapacity: !observationOnly
  };
}

// Read one durable strict-operation record without accepting prompt text,
// opening a tab, or acquiring a send-capacity slot. This is intentionally
// narrower than verifyExisting: it establishes ledger facts only and cannot
// promote an operation, recover a turn, or create a resend path.
export async function observeReviewOperation({ stateDir, idempotencyKey, operationId = null }) {
  if (!stateDir) fail('review_transport_misconfigured');
  const key = requiredText(idempotencyKey, 'idempotencyKey', { max: 512 });
  const expectedOperationId = operationId == null
    ? null
    : requiredText(operationId, 'operationId', { max: 512 });
  const state = await readStateLocked(stateDir);
  const operation = state.operations[key];
  if (!operation) fail('review_operation_not_found');
  if (expectedOperationId && operation.operationId !== expectedOperationId) {
    fail('review_operation_identity_mismatch');
  }
  const zeroCommitPreClick =
    operation.sendCount === 0 &&
    operation.sendActionCount === 0 &&
    noClickBoundaryResolved(operation) &&
    !operation.userMessageId &&
    !operation.observedUserMessageId &&
    operation.errorData?.noClickProven === true &&
    ['before_composer_write', 'before_send_click'].includes(operation.failureStage);
  return {
    observationKind: 'ledger_only',
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
    requestFingerprint: operation.requestFingerprint,
    stableKey: operation.stableKey,
    provider: operation.provider,
    model: operation.model,
    conversationUrl: operation.conversationUrl,
    conversationId: operation.conversationId,
    observedConversationUrl: operation.observedConversationUrl || null,
    observedConversationId: operation.observedConversationId || null,
    tabId: operation.tabId || null,
    status: operation.status,
    terminalState: operation.terminalState,
    failureStage: operation.failureStage || null,
    sendCount: operation.sendCount,
    sendActionCount: operation.sendActionCount,
    newUserMessageCount: operation.newUserMessageCount || 0,
    hasUserMessageId: !!operation.userMessageId,
    hasObservedUserMessageId: !!operation.observedUserMessageId,
    baselineMessageCount: Array.isArray(operation.baselineMessageIds) ? operation.baselineMessageIds.length : 0,
    error: operation.error || null,
    zeroCommitPreClick
  };
}

function sameBinding(binding, request) {
  return (
    binding?.stableKey === request.stableKey &&
    binding?.provider === request.provider &&
    binding?.conversationUrl === request.conversationUrl &&
    binding?.conversationId === request.conversationId
  );
}

function matchesExistingObservation(existing, request) {
  // A first binding becomes a concrete conversation after its single send.  A
  // later verify-existing request must therefore use that concrete identity and
  // cannot repeat the historical firstBinding/root fields.  Those fields are
  // transport history, not identity of the already committed turn.
  const exactOperationConversation =
    existing.conversationUrl === request.conversationUrl &&
    existing.conversationId === request.conversationId;
  const exactObservedConversation =
    existing.firstBinding === true &&
    existing.observedConversationUrl === request.conversationUrl &&
    existing.observedConversationId === request.conversationId;
  return request.verifyExisting === true &&
    existing?.stableKey === request.stableKey &&
    existing.provider === request.provider &&
    existing.model === request.model &&
    existing.idempotencyKey === request.idempotencyKey &&
    existing.promptSha256 === request.promptSha256 &&
    (!request.responsePath || !existing.responsePath || existing.responsePath === request.responsePath) &&
    (exactOperationConversation || exactObservedConversation);
}

function causalRecoveryEligible(existing, request) {
  if (
    !existing ||
    existing.status !== 'OBSERVING' ||
    !['COMMITMENT_UNKNOWN', 'SENT_UNREADABLE'].includes(existing.terminalState) ||
    existing.sendCount !== 0 ||
    existing.sendActionCount !== 1 ||
    existing.userMessageId ||
    !Array.isArray(existing.baselineMessageIds) ||
    !validateReviewCausalSubmissionReceipt(existing.causalSendReceipt, {
      prompt: request.prompt,
      baselineMessageIds: existing.baselineMessageIds
    })
  ) return false;
  if (existing.terminalState === 'SENT_UNREADABLE') {
    return !!existing.observedUserMessageId &&
      existing.observedCommitmentClass === 'turn_causal_exact_rendered_unreadable' &&
      existing.observedConversationUrl === request.conversationUrl &&
      existing.observedConversationId === request.conversationId;
  }
  return (
    existing.conversationUrl === request.conversationUrl &&
    existing.conversationId === request.conversationId
  ) || (
    existing.observedConversationUrl === request.conversationUrl &&
    existing.observedConversationId === request.conversationId
  );
}

const CHATGPT_MODEL_ROUTES = new Set([
  'composer_reasoning_control',
  'semantic_model_switcher',
  'controlled_reasoning_menu'
]);

function exactModelLabelMatches(actual, expected) {
  const normalize = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const actualLabel = normalize(actual);
  return !!actualLabel && actualLabel === normalize(expected);
}

function requireChatgptModelSelection(value, expectedModel) {
  const selection = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (
    !selection ||
    !exactModelLabelMatches(selection.expectedModel, expectedModel) ||
    !exactModelLabelMatches(selection.matchedLabel, expectedModel) ||
    !CHATGPT_MODEL_ROUTES.has(selection.routeEvidence) ||
    selection.scopedMatchCount !== 1
  ) {
    fail('review_send_model_receipt_invalid');
  }
  return {
    expectedModel: String(selection.expectedModel),
    matchedLabel: String(selection.matchedLabel),
    routeEvidence: String(selection.routeEvidence),
    scopedMatchCount: 1
  };
}

function noClickBoundaryResolved(candidate) {
  return !candidate?.sendBoundaryEnteredAt || candidate.boundaryResolution === 'no_click_proven';
}

function operationProvesZeroSend(candidate) {
  return candidate?.status === 'BLOCKED' &&
    candidate.terminalState === 'ZERO_SEND_FAILED' &&
    candidate.sendCount === 0 &&
    candidate.sendActionCount === 0 &&
    noClickBoundaryResolved(candidate) &&
    !candidate.userMessageId &&
    !candidate.observedUserMessageId &&
    !candidate.causalSendReceipt &&
    !candidate.submissionIdentity &&
    candidate.errorData?.noClickProven === true;
}

function authorizedBindingModel(binding, request) {
  if (request.geminiBootstrapContinuation === true) {
    return binding?.model !== request.model &&
      binding?.provider === 'gemini' &&
      binding?.geminiBootstrap?.nonScientific === true &&
      binding.geminiBootstrap.continuationConsumed !== true;
  }
  return binding?.model === request.model;
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
    renderedResponseBytes: Buffer.byteLength(text, 'utf8'),
    snapshots,
    controls: {
      stop: !!controls.stop,
      continue: !!controls.continue,
      retry: !!controls.retry,
      answerNow: !!controls.answerNow
    },
    conversationUrl: result.conversationUrl,
    conversationId: result.conversationId,
    modelEvidence: requiredText(result.modelEvidence, 'modelEvidence', { max: 256 }),
    clickedControls: [],
    contentRebind: result.contentRebind && typeof result.contentRebind === 'object'
      ? { ...result.contentRebind }
      : null
  };
}

async function observePersistedReview({ observeReviewResponse, operation, request }) {
  return await observeReviewResponse({
    expectedUrl: operation.conversationUrl,
    expectedConversationId: operation.conversationId,
    expectedModel: request.model,
    submittedModelEvidence: operation.modelEvidence || operation.causalSendReceipt?.modelSelection?.matchedLabel || '',
    userMessageId: operation.userMessageId,
    expectedPrompt: request.prompt,
    expectedPromptSha256: operation.promptSha256,
    baselineMessageIds: operation.baselineMessageIds,
    sendCount: operation.sendCount,
    sendActionCount: operation.sendActionCount,
    renderedDisplayFidelity: operation.renderedDisplay?.fidelity || 'exact',
    timeoutMs: request.timeoutMs
  });
}

export async function runReviewQuery({ stateDir, tabs, request: rawRequest, onTabResolved = null }) {
  if (!stateDir || !tabs) fail('review_transport_misconfigured');
  const request = normalizeRequest(rawRequest);
  const fingerprint = requestFingerprint(request);
  const promptIdentity = reviewPlainTextIdentity(request.prompt);
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
    if (existing && existing.requestFingerprint !== fingerprint && !matchesExistingObservation(existing, request)) fail('review_idempotency_conflict');
    if (request.verifyExisting) {
      const canRecoverCausally = causalRecoveryEligible(existing, request);
      if (!existing || (!existing.userMessageId && !canRecoverCausally)) fail('review_observation_unavailable');
      if (!request.responsePath && existing.responsePath) request.responsePath = existing.responsePath;
      if (!request.responsePath) fail('review_observation_unavailable');
      if (!existing.responsePath) {
        existing.responsePath = request.responsePath;
        existing.requestFingerprint = fingerprint;
        existing.updatedAt = now;
      }
      return { existing: true, operation: { ...existing }, binding: binding ? { ...binding } : null };
    }
    if (request.firstBinding) {
      if (binding && !existing) fail('review_binding_mismatch');
    } else {
      if (binding && (!sameBinding(binding, request) || !authorizedBindingModel(binding, request))) fail('review_binding_mismatch');
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
    // A ChatGPT root binding ("__new__") does not name a conversation. Each
    // accepted first-binding send creates a distinct provider conversation, so
    // it cannot be compared with a concrete prior conversation here. HMASD's
    // owner-level replacement policy decides whether opening that new
    // conversation is authorized; this tool only prevents reinjection into an
    // already identified provider conversation.
    const conflictingOperation = request.conversationId === '__new__' ? null : Object.values(state.operations).find((candidate) => {
      const exactOperationConversation =
        candidate?.conversationUrl === request.conversationUrl &&
        candidate?.conversationId === request.conversationId;
      const exactObservedConversation =
        candidate?.observedConversationUrl === request.conversationUrl &&
        candidate?.observedConversationId === request.conversationId;
      return candidate?.provider === request.provider &&
        (exactOperationConversation || exactObservedConversation) &&
        candidate?.promptSha256 === request.promptSha256 &&
        !operationProvesZeroSend(candidate);
    });
    if (conflictingOperation) fail('review_conversation_request_nonrepeatable');
    const operation = {
      operationId: crypto.randomUUID(),
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint,
      stableKey: request.stableKey,
      provider: request.provider,
      model: request.model,
      conversationUrl: request.conversationUrl,
      conversationId: request.conversationId,
      firstBinding: request.firstBinding,
      geminiBootstrap: request.geminiBootstrap,
      geminiBootstrapContinuation: request.geminiBootstrapContinuation,
      bootstrapNonScientific: request.bootstrapNonScientific,
      promptSha256: request.promptSha256,
      responsePath: request.responsePath,
      promptTextModel: promptIdentity.textModel,
      canonicalPromptSha256: promptIdentity.canonicalSha256,
      timeoutMs: request.timeoutMs,
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
  // A durable zero-send receipt is an immutable terminal transport fact.  A
  // same-key replay must return that receipt without reopening a browser or
  // passing through the generic error path, which could otherwise degrade the
  // proven boundary into COMMITMENT_UNKNOWN.
  if (
    intake.existing &&
    operationProvesZeroSend(intake.operation) &&
    !request.diagnoseExisting
  ) return intake.operation;
  if (!request.responsePath && intake.operation.responsePath) request.responsePath = intake.operation.responsePath;
  if (request.verifyExisting && request.existingTabId) {
    await tabs.adoptTab({
      id: request.existingTabId,
      key: request.stableKey,
      name: request.stableKey,
      url: request.conversationUrl,
      vendorId: request.provider,
      vendorName: request.provider === 'gemini' ? 'Gemini' : 'ChatGPT'
    });
  }
  const liveIdentity = request.verifyExisting ? request : intake.binding || request;
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
    if (submitted?.renderedDisplayFidelity === 'lossy_mismatch') fail('review_user_message_content_mismatch');
    if (submitted?.renderedDisplayFidelity === 'unreadable') fail('review_user_message_identity_unreadable');
    if (
      submitted?.sourcePromptSha256 !== request.promptSha256 ||
      submitted?.canonicalPromptSha256 !== promptIdentity.canonicalSha256 ||
      submitted?.submissionIdentityMode !== REVIEW_CAUSAL_SUBMISSION_MODEL ||
      submitted?.renderedDisplayFidelity !== 'exact'
    ) {
      fail('review_user_message_identity_receipt_invalid');
    }
    const safeRenderedDisplay = sanitizeReviewErrorData(submitted?.renderedDisplayEvidence);
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.status === 'COMPLETE') return;
      if (op.sendActionCount !== 1) fail('review_send_action_receipt_missing');
      if (
        !validateReviewCausalSubmissionReceipt(submitted?.causalSubmissionReceipt, {
          prompt: request.prompt,
          baselineMessageIds: op.baselineMessageIds
        }) ||
        !op.causalSendReceipt ||
        op.causalSendReceipt.operationId !== op.operationId ||
        submitted.causalSubmissionReceipt.operationId !== op.operationId ||
        JSON.stringify(submitted.causalSubmissionReceipt) !== JSON.stringify(op.causalSendReceipt)
      ) {
        fail('review_causal_submission_receipt_mismatch');
      }
      const persistedModelSelection = request.provider === 'chatgpt'
        ? requireChatgptModelSelection(op.causalSendReceipt.modelSelection, request.model)
        : null;
      if (op.observedUserMessageId !== userMessageId) {
        fail('review_observed_user_message_identity_mismatch');
      }
      const expectedCommitmentClass = submitted.renderedDisplayFidelity === 'exact'
        ? 'turn_exact'
        : submitted.renderedDisplayFidelity === 'unreadable'
          ? 'turn_causal_exact_rendered_unreadable'
          : 'turn_causal_exact_rendered_mismatch';
      if (
        op.observedCommitmentClass !== expectedCommitmentClass ||
        op.observedConversationUrl !== submittedUrl ||
        op.observedConversationId !== submittedId ||
        op.newUserMessageCount !== 1
      ) {
        fail('review_observed_user_turn_receipt_invalid');
      }
      op.status = 'SUBMITTED';
      op.terminalState = 'SENT_WAITING';
      op.sendCount = 1;
      op.userMessageId = userMessageId;
      op.conversationUrl = submittedUrl;
      op.conversationId = submittedId;
      op.tabId = tabId;
      op.submittedAt = submitted?.submittedAt || Date.now();
      op.modelEvidence = persistedModelSelection?.matchedLabel || submitted?.modelEvidence || null;
      if (request.geminiBootstrap && op.modelEvidence) op.model = op.modelEvidence;
      op.observedConversationUrl = submittedUrl;
      op.observedConversationId = submittedId;
      op.submissionIdentity = {
        identityModel: REVIEW_CAUSAL_SUBMISSION_MODEL,
        sourceSha256: request.promptSha256,
        canonicalPromptSha256: promptIdentity.canonicalSha256,
        baselineMessageIdsSha256: op.causalSendReceipt.baselineMessageIdsSha256,
        sendActionCount: 1,
        clickCount: 1,
        userMessageId,
        conversationUrl: submittedUrl,
        conversationId: submittedId
      };
      op.renderedDisplay = {
        fidelity: submitted.renderedDisplayFidelity,
        ...(safeRenderedDisplay || {})
      };
      op.renderedIdentity = {
        textModel: promptIdentity.textModel,
        sourceSha256: request.promptSha256,
        canonicalPromptSha256: promptIdentity.canonicalSha256,
        identityMode: submitted.renderedIdentityMode
      };
      op.updatedAt = Date.now();
      if (op.firstBinding) {
        const now = Date.now();
        state.bindings[request.stableKey] = {
          stableKey: request.stableKey,
          provider: request.provider,
          model: op.modelEvidence || request.model,
          conversationUrl: submittedUrl,
          conversationId: submittedId,
          createdAt: now,
          updatedAt: now
        };
        if (op.geminiBootstrap) {
          state.bindings[request.stableKey].geminiBootstrap = {
            nonScientific: true,
            bootstrapOperationId: op.operationId,
            bootstrapModel: op.modelEvidence || request.model,
            continuationConsumed: false
          };
        }
      } else if (request.geminiBootstrapContinuation) {
        const bound = state.bindings[request.stableKey];
        if (!bound || !authorizedBindingModel(bound, request)) fail('review_binding_mismatch');
        bound.model = request.model;
        bound.geminiBootstrap = {
          ...bound.geminiBootstrap,
          continuationConsumed: true,
          continuationOperationId: op.operationId,
          continuationModel: request.model
        };
        bound.updatedAt = Date.now();
      }
    });
    if (intake.operation.firstBinding) tabs.updateTabUrl(tabId, submittedUrl);
  };

  const onSendBoundaryEntered = async (boundary) => {
    const preSendModelEvidence = request.provider === 'chatgpt'
      ? requireChatgptModelSelection(boundary?.modelEvidence, request.model)
      : null;
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (!['PREPARED', 'SEND_INTENT'].includes(op.status) || op.sendCount !== 0 || op.sendActionCount !== 0 || op.userMessageId) {
        fail('review_operation_state_invalid');
      }
      op.sendBoundaryEnteredAt = Number.isFinite(boundary?.enteredAt) ? boundary.enteredAt : Date.now();
      op.boundaryResolution = 'unresolved';
      if (preSendModelEvidence) op.preSendModelEvidence = preSendModelEvidence;
      op.terminalState = 'COMMITMENT_UNKNOWN';
      op.failureStage = 'send_capable_boundary';
      op.updatedAt = Date.now();
    });
  };

  const onSendAction = async (action) => {
    const clickTimeIdentity = action?.clickTimeIdentity;
    const clickTimeModelEvidence = request.provider === 'chatgpt'
      ? requireChatgptModelSelection(action?.clickTimeModelEvidence, request.model)
      : null;
    if (
      Number(action?.clickCount) !== 1 ||
      Number(action?.sendActionCount) !== 1 ||
      clickTimeIdentity?.ok !== true ||
      clickTimeIdentity.recoveredExact !== true ||
      clickTimeIdentity.textModel !== REVIEW_PLAIN_TEXT_MODEL ||
      !['canonical_exact', 'browser_space_rebalanced'].includes(clickTimeIdentity.identityMode) ||
      clickTimeIdentity.sourceSha256 !== request.promptSha256 ||
      clickTimeIdentity.canonicalPromptSha256 !== promptIdentity.canonicalSha256 ||
      clickTimeIdentity.observedCanonicalSha256 !== promptIdentity.canonicalSha256
    ) {
      fail('review_send_action_receipt_invalid');
    }
    const safeClickTimeIdentity = sanitizeReviewErrorData(clickTimeIdentity);
    return await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (!['PREPARED', 'SEND_INTENT'].includes(op.status) || !Number.isFinite(op.sendBoundaryEnteredAt) || op.sendActionCount !== 0 || op.userMessageId) {
        fail('review_operation_state_invalid');
      }
      const baselineMessageIdsSha256 = reviewBaselineMessageIdsSha256(op.baselineMessageIds);
      if (!baselineMessageIdsSha256) fail('review_submission_baseline_missing');
      if (
        request.provider === 'chatgpt' &&
        JSON.stringify(op.preSendModelEvidence) !== JSON.stringify(clickTimeModelEvidence)
      ) {
        fail('review_send_model_receipt_mismatch');
      }
      const causalSendReceipt = {
        ok: true,
        persisted: true,
        identityModel: REVIEW_CAUSAL_SUBMISSION_MODEL,
        operationId: op.operationId,
        sendActionCount: 1,
        clickCount: 1,
        sourceSha256: request.promptSha256,
        canonicalPromptSha256: promptIdentity.canonicalSha256,
        baselineMessageIdsSha256,
        ...(clickTimeModelEvidence ? { modelSelection: clickTimeModelEvidence } : {})
      };
      op.status = 'SEND_INTENT';
      op.terminalState = 'COMMITMENT_UNKNOWN';
      op.sendActionCount = 1;
      op.clickCount = 1;
      op.clickTimeIdentity = safeClickTimeIdentity;
      op.causalSendReceipt = causalSendReceipt;
      op.boundaryResolution = 'send_action_observed';
      if (clickTimeModelEvidence) op.modelEvidence = clickTimeModelEvidence.matchedLabel;
      op.sendActionAt = action?.sendActionAt || Date.now();
      op.updatedAt = Date.now();
      return { ...causalSendReceipt };
    });
  };

  const onUserTurnObserved = async (observed) => {
    const observedUserMessageId = requiredText(observed?.observedUserMessageId, 'observedUserMessageId', { max: 512 });
    const observedUrl = requiredText(observed?.conversationUrl, 'conversationUrl', { max: 2048 });
    const observedId = requiredText(observed?.conversationId, 'conversationId', { max: 256 });
    const observedIdentity = conversationIdentityFromUrl(observedUrl);
    const allowedClasses = new Set([
      'turn_exact',
      'turn_unreadable',
      'turn_content_mismatch',
      'turn_causal_exact_rendered_unreadable',
      'turn_causal_exact_rendered_mismatch'
    ]);
    if (
      observedIdentity.provider !== request.provider ||
      observedIdentity.conversationId !== observedId ||
      !allowedClasses.has(observed?.commitmentClass) ||
      observed?.newUserMessageCount !== 1 ||
      (observed?.commitmentClass.startsWith('turn_causal_exact_') &&
        observed?.submissionIdentityMode !== REVIEW_CAUSAL_SUBMISSION_MODEL)
    ) {
      fail('review_observed_user_turn_receipt_invalid');
    }
    if (!request.firstBinding && (observedUrl !== request.conversationUrl || observedId !== request.conversationId)) {
      fail('review_conversation_identity_mismatch');
    }
    const safeEvidence = sanitizeReviewErrorData(observed);
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.status === 'COMPLETE') return;
      if (op.sendActionCount !== 1 || op.sendCount !== 0 || op.userMessageId) {
        fail('review_operation_state_invalid');
      }
      if (observed.commitmentClass.startsWith('turn_causal_exact_') && !op.causalSendReceipt) {
        fail('review_causal_submission_receipt_missing');
      }
      if (op.observedUserMessageId && op.observedUserMessageId !== observedUserMessageId) {
        fail('review_observed_user_message_identity_mismatch');
      }
      op.observedUserMessageId = observedUserMessageId;
      op.observedUserMessageAt = Number.isFinite(observed?.observedAt) ? observed.observedAt : Date.now();
      op.observedConversationUrl = observedUrl;
      op.observedConversationId = observedId;
      op.observedCommitmentClass = observed.commitmentClass;
      op.observedTurnEvidence = safeEvidence;
      op.newUserMessageCount = 1;
      op.updatedAt = Date.now();
    });
  };

  const onComposerVerified = async (identity) => {
    if (
      identity?.ok !== true ||
      identity.textModel !== REVIEW_PLAIN_TEXT_MODEL ||
      identity.replacementModel !== REVIEW_COMPOSER_REPLACEMENT_MODEL ||
      !['contenteditable', 'textarea', 'input'].includes(identity.composerKind) ||
      typeof identity.clearMethod !== 'string' || !identity.clearMethod ||
      identity.emptyVerified !== true ||
      identity.emptySnapshotCount !== 2 ||
      identity.selectionVerified !== true ||
      !Number.isInteger(identity.deleteKeyCount) ||
      identity.deleteKeyCount < 0 || identity.deleteKeyCount > 1 ||
      identity.caretVerified !== true ||
      typeof identity.caretMethod !== 'string' || !identity.caretMethod ||
      identity.promptInsertCount !== 1 ||
      identity.sourceSha256 !== request.promptSha256 ||
      identity.canonicalPromptSha256 !== promptIdentity.canonicalSha256 ||
      identity.observedCanonicalSha256 !== promptIdentity.canonicalSha256
    ) {
      fail('review_composer_identity_receipt_invalid');
    }
    const safeIdentity = sanitizeReviewErrorData(identity);
    const allowedIdentityModes = new Set(['canonical_exact', 'browser_space_rebalanced']);
    const verifiedIdentity = {
      ...(safeIdentity || {}),
      ok: true,
      textModel: REVIEW_PLAIN_TEXT_MODEL,
      identityMode: allowedIdentityModes.has(identity.identityMode) ? identity.identityMode : 'canonical_exact',
      sourceSha256: request.promptSha256,
      canonicalPromptSha256: promptIdentity.canonicalSha256,
      observedCanonicalSha256: promptIdentity.canonicalSha256
    };
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.sendCount !== 0 || op.sendActionCount !== 0 || op.userMessageId) {
        fail('review_operation_state_invalid');
      }
      op.composerIdentity = { ...verifiedIdentity, verified: true, verifiedAt: Date.now() };
      op.updatedAt = Date.now();
    });
  };

  const onPrepared = async (prepared) => {
    const baselineMessageIds = Array.isArray(prepared?.baselineMessageIds)
      ? prepared.baselineMessageIds.map((value) => requiredText(value, 'baselineMessageId', { max: 512 }))
      : null;
    if (!baselineMessageIds) fail('review_submission_baseline_missing');
    if (new Set(baselineMessageIds).size !== baselineMessageIds.length) fail('review_submission_baseline_invalid');
    if (!request.firstBinding && baselineMessageIds.length === 0) {
      fail('review_continuation_baseline_empty', {
        noClickProven: true,
        failureStage: 'before_composer_write',
        baselineMessageCount: 0
      });
    }
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
    await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      op.tabId = tabId;
      op.updatedAt = Date.now();
    });
    if (typeof onTabResolved === 'function') {
      await onTabResolved({
        tabId,
        stableKey: request.stableKey,
        idempotencyKey: request.idempotencyKey
      });
    }
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
        if (!intake.existing) {
          fail('review_observation_unavailable');
        }
        if (currentOperation.userMessageId) {
          if (!observeReviewResponse) fail('review_observation_unavailable');
          const result = await observePersistedReview({ observeReviewResponse, operation: currentOperation, request });
          return { result, expectedUserMessageId: currentOperation.userMessageId };
        }
        const canRecoverCausally = causalRecoveryEligible(currentOperation, request);
        if (!canRecoverCausally || typeof controller?.recoverReviewSubmission !== 'function') {
          fail('review_observation_unavailable');
        }
        const recovery = await controller.recoverReviewSubmission({
          prompt: request.prompt,
          baselineMessageIds: currentOperation.baselineMessageIds,
          expectedUrl: request.conversationUrl,
           expectedConversationId: request.conversationId,
           expectedModel: request.model,
           submittedModelEvidence: currentOperation.modelEvidence || currentOperation.causalSendReceipt?.modelSelection?.matchedLabel || '',
          timeoutMs: request.timeoutMs,
          causalSubmissionReceipt: currentOperation.causalSendReceipt,
          onRecovered: async (recovered) => {
            const userMessageId = requiredText(recovered?.userMessageId, 'userMessageId', { max: 512 });
            const conversationUrl = requiredText(recovered?.conversationUrl, 'conversationUrl', { max: 2048 });
            const conversationId = requiredText(recovered?.conversationId, 'conversationId', { max: 256 });
            const renderedDisplayFidelity = recovered?.renderedDisplayFidelity;
            // This operation lost its original observed-turn anchor.  A causal
            // click receipt alone cannot distinguish an old rendered message
            // from the post-click turn after a later reload, so rebind only an
            // exact visible rendering; lossy/unreadable display remains
            // permanently observe-only without an already persisted turn ID.
            if (renderedDisplayFidelity !== 'exact') fail('review_recovery_rendered_identity_unreadable');
            const rendered = recovered?.renderedIdentityDiagnostic || {};
            const commitmentClass = renderedDisplayFidelity === 'exact'
              ? 'turn_exact'
              : renderedDisplayFidelity === 'unreadable'
                ? 'turn_causal_exact_rendered_unreadable'
                : 'turn_causal_exact_rendered_mismatch';
            const observed = {
              observedUserMessageId: userMessageId,
              observedAt: recovered?.submittedAt || Date.now(),
              conversationUrl,
              conversationId,
              modelEvidence: recovered?.modelEvidence || null,
              commitmentClass,
              submissionIdentityMode: REVIEW_CAUSAL_SUBMISSION_MODEL,
              renderedDisplayFidelity,
              serializerOk: rendered.serializerOk === true,
              serializerMethod: rendered.serializerMethod || 'rendered_user_message_structural',
              serializerError: rendered.serializerError || null,
              serializerTag: rendered.serializerTag || null,
              serializedLength: Number.isInteger(rendered.serializedLength) ? rendered.serializedLength : null,
              observedLengths: Array.isArray(rendered.observedLengths) ? rendered.observedLengths : [],
              expectedLength: request.prompt.length,
              newUserMessageCount: 1,
              readableCandidateCount: Number.isInteger(rendered.readableCandidateCount) ? rendered.readableCandidateCount : 0,
              exactMatchCount: Number.isInteger(rendered.exactMatchCount) ? rendered.exactMatchCount : 0,
              ...rendered
            };
            await onUserTurnObserved(observed);
            await onSubmitted({
              ...recovered,
              userMessageId,
              conversationUrl,
              conversationId,
              sourcePromptSha256: request.promptSha256,
              canonicalPromptSha256: promptIdentity.canonicalSha256,
              submissionIdentityMode: REVIEW_CAUSAL_SUBMISSION_MODEL,
              causalSubmissionReceipt: currentOperation.causalSendReceipt,
              renderedDisplayFidelity,
              renderedDisplayEvidence: observed,
              renderedIdentityMode: renderedDisplayFidelity === 'exact'
                ? recovered?.identityMode || 'canonical_exact'
                : null
            });
          }
        });
        if (
          recovery?.status !== 'SENT_WAITING' ||
          recovery?.conversationUrl !== request.conversationUrl ||
          recovery?.conversationId !== request.conversationId
        ) fail('review_recovery_receipt_invalid');
        const reboundState = await readStateLocked(stateDir);
        const reboundOperation = reboundState.operations[request.idempotencyKey];
        if (
          !reboundOperation ||
          reboundOperation.operationId !== currentOperation.operationId ||
          !reboundOperation.userMessageId ||
          reboundOperation.userMessageId !== recovery.userMessageId ||
          reboundOperation.sendCount !== 1 ||
          reboundOperation.sendActionCount !== 1
        ) fail('review_recovery_receipt_invalid');
        if (!observeReviewResponse) fail('review_observation_unavailable');
        const result = await observePersistedReview({
          observeReviewResponse,
          operation: reboundOperation,
          request
        });
        return { result, expectedUserMessageId: reboundOperation.userMessageId };
      }
      if (currentOperation.status === 'COMPLETE') {
        return { completedOperation: { ...currentOperation } };
      }
      const result = intake.existing
        ? currentOperation.userMessageId
          ? await observePersistedReview({ observeReviewResponse, operation: currentOperation, request })
          : fail('review_operation_closed_create_fresh')
        : await controller.reviewQuery({
          prompt: request.prompt,
          expectedUrl: request.conversationUrl,
          expectedConversationId: request.conversationId,
          expectedModel: request.model,
          timeoutMs: request.timeoutMs,
          onPrepared,
          onComposerVerified,
          onSendBoundaryEntered,
          onSendAction,
          onUserTurnObserved,
          onSubmitted,
          firstBinding: request.firstBinding,
          requireModelPreflight: true
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
    if (['SENT_WAITING', 'SENT_UNREADABLE'].includes(execution.result?.status)) {
      return await mutateState(stateDir, async (state) => {
        const op = state.operations[request.idempotencyKey];
        if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
        if (op.status === 'COMPLETE') return { ...op };
        if (op.sendCount !== 1 || op.sendActionCount !== 1 || !op.userMessageId) fail('review_send_receipt_invalid');
        op.status = 'SUBMITTED';
        op.terminalState = execution.result.status;
        op.lastObservedAt = Date.now();
        op.updatedAt = op.lastObservedAt;
        return { ...op };
      });
    }
    const resultRequest = request.firstBinding
      ? { ...request, conversationUrl: execution.result.conversationUrl, conversationId: execution.result.conversationId }
      : request;
    const validated = validateResult(execution.result, resultRequest, execution.expectedUserMessageId);
    let archived;
    try {
      archived = await archiveReviewResponse({
        responsePath: request.responsePath,
        text: validated.responseText,
        allowTerminalLfProjection:
          request.verifyExisting === true && request.provider === 'chatgpt' && intake.existing === true
      });
    } catch (error) {
      return await mutateState(stateDir, async (state) => {
        const op = state.operations[request.idempotencyKey];
        if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
        if (op.status === 'COMPLETE') return { ...op };
        op.status = 'SUBMITTED';
        op.terminalState = 'SENT_UNREADABLE';
        op.error = String(error?.message || error);
        op.failureStage = 'response_archive';
        op.errorData = sanitizeReviewErrorData({
          predicate: op.error,
          failureStage: op.failureStage,
          commitmentClass: op.observedCommitmentClass || null,
          sendActionCount: op.sendActionCount || 0,
          newUserMessageCount: op.newUserMessageCount || 0,
          noClickProven: false
        });
        op.lastObservedAt = Date.now();
        op.updatedAt = op.lastObservedAt;
        return { ...op };
      });
    }
    const { responseText: _archivedResponseText, ...validatedReceipt } = validated;
    let canonicalizedExistingBinding = false;
    const completed = await mutateState(stateDir, async (state) => {
      const op = state.operations[request.idempotencyKey];
      if (!op || op.operationId !== intake.operation.operationId) fail('review_operation_identity_mismatch');
      if (op.status === 'COMPLETE') return { ...op };
      if (op.sendActionCount !== 1 || op.sendCount !== 1 || !op.userMessageId) {
        fail('review_send_receipt_invalid');
      }
      op.userMessageId = validated.userMessageId;
      Object.assign(op, validatedReceipt, archived, {
        status: 'COMPLETE',
        terminalState: 'NATURAL_COMPLETION_VERIFIED',
        tabId,
        completedAt: Date.now(),
        updatedAt: Date.now()
      });
      delete op.error;
      delete op.errorData;
      delete op.failureStage;
      if (op.submissionIdentity) {
        op.submissionIdentity = {
          ...op.submissionIdentity,
          userMessageId: validated.userMessageId,
          conversationUrl: validated.conversationUrl,
          conversationId: validated.conversationId
        };
      }
      if (op.firstBinding && provisionalChatgptConversationId(state.bindings[request.stableKey]?.conversationId)) {
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
      const predicate = String(error?.message || error);
      const noClickProven = op.sendActionCount === 0 && !op.userMessageId && (
        safeErrorData?.noClickProven === true || !Number.isFinite(op.sendBoundaryEnteredAt)
      );
      if (noClickProven) op.boundaryResolution = 'no_click_proven';
      const preSendFailure = noClickProven;
      const preComposerWriteFailure =
        preSendFailure &&
        !request.firstBinding &&
        predicate === 'review_continuation_baseline_empty' &&
        safeErrorData?.noClickProven === true &&
        safeErrorData?.failureStage === 'before_composer_write';
      op.failureStage = preSendFailure
        ? preComposerWriteFailure ? 'before_composer_write' : 'before_send_click'
        : 'send_occurred_or_uncertain';
      const inputMismatch = predicate === 'review_user_message_content_mismatch';
      const modelMismatch = predicate === 'review_model_mismatch' || predicate === 'review_model_mismatch_at_send';
      const responseUnreadable = predicate === 'review_user_message_identity_unreadable' || predicate === 'review_recovery_rendered_identity_unreadable';
      const exactSubmissionPersisted = op.sendCount === 1 && !!op.userMessageId && op.renderedDisplay?.fidelity === 'exact';
      op.status = preSendFailure || inputMismatch || modelMismatch
        ? 'BLOCKED'
        : exactSubmissionPersisted ? 'SUBMITTED' : 'OBSERVING';
      op.terminalState = preSendFailure
        ? 'ZERO_SEND_FAILED'
        : inputMismatch
          ? 'SENT_INPUT_MISMATCH'
          : modelMismatch
            ? 'SENT_MODEL_MISMATCH'
            : responseUnreadable
              ? 'SENT_UNREADABLE'
              : exactSubmissionPersisted ? 'SENT_WAITING' : 'COMMITMENT_UNKNOWN';
      op.error = predicate;
      const newUserMessageCount = Number.isInteger(safeErrorData?.newUserMessageCount)
        ? safeErrorData.newUserMessageCount
        : Number.isInteger(op.newUserMessageCount) ? op.newUserMessageCount : 0;
      const mechanicalErrorData = sanitizeReviewErrorData({
        ...(safeErrorData || {}),
        predicate,
        failureStage: op.failureStage,
        sendActionCount: op.sendActionCount || 0,
        newUserMessageCount,
        commitmentClass: safeErrorData?.commitmentClass || op.observedCommitmentClass || null,
        noClickProven
      });
      if (mechanicalErrorData) op.errorData = mechanicalErrorData;
      op.updatedAt = Date.now();
    }).catch(() => {});
    throw error;
  }
}

export { MAX_REVIEW_TIMEOUT_MS };
