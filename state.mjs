import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

async function atomicWriteFile(filePath, data, { mode } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, data, mode ? { encoding: 'utf8', mode } : { encoding: 'utf8' });
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

export function defaultStateDir() {
  return process.env.AGENTIFY_DESKTOP_STATE_DIR || path.join(os.homedir(), '.agentify-desktop');
}

export function tokenPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'token.txt');
}

export function statePath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'state.json');
}

export function settingsPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'settings.json');
}

export function reviewTransportPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'review-transport.json');
}

const REVIEW_TRANSPORT_SCHEMA_VERSION = 3;

const REVIEW_PHASES = new Set([
  'VALIDATE',
  'PREPARE_UI',
  'ARMED',
  'VERIFY_COMMITMENT',
  'WAIT_RESPONSE',
  'READ_RESPONSE',
  'PUBLISH_ARCHIVE',
  'TERMINAL'
]);
const REVIEW_COMMITMENTS = new Set(['ZERO_PROVEN', 'UNRESOLVED', 'ONE_EXACT', 'VIOLATION']);
const REVIEW_RECOVERABILITY = new Set([
  'PRECOMMIT_REPAIR',
  'OBSERVE_ONLY',
  'POSTCOMMIT_RECOVERY',
  'HUMAN_INTERLOCK',
  'NONE'
]);
const REVIEW_OBSERVABILITY = new Set([
  'UNOBSERVED',
  'FRESH_COMPLETE',
  'FRESH_PARTIAL',
  'STALE',
  'LOST',
  'CONTRADICTORY'
]);
const REVIEW_MESSAGE_CAPABILITIES = new Set(['AVAILABLE', 'RESERVED', 'SEALED']);
const REVIEW_FAILURE_LOCI = new Set([
  'NONE',
  'SPEC',
  'AUTH',
  'TAB_OWNERSHIP',
  'PRECOMMIT_UI',
  'COMMIT_BOUNDARY',
  'TURN_CONFIRMATION',
  'RESPONSE',
  'ARCHIVE'
]);
const UPPER_CODE = /^[A-Z][A-Z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LEGACY_TRANSPORT_FIELDS = [
  'model',
  'expectedModel',
  'expectedMode',
  'modelEvidence',
  'status',
  'terminalState',
  'sendCount',
  'sendActionCount',
  'newUserMessageCount'
];

export function defaultReviewTransportState() {
  return { schemaVersion: REVIEW_TRANSPORT_SCHEMA_VERSION, bindings: {}, operations: {} };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function rejectLegacyFields(value) {
  if (LEGACY_TRANSPORT_FIELDS.some((field) => Object.hasOwn(value, field))) {
    throw new Error('review_transport_state_invalid');
  }
}

function validateTargetAxes(value) {
  if (!nonEmptyString(value.productModel)) throw new Error('review_transport_state_invalid');
  if (value.provider === 'chatgpt') {
    if (value.productModel !== 'GPT-5.6 Sol' || value.reasoningEffort !== 'Pro') {
      throw new Error('review_transport_state_invalid');
    }
  } else if (value.provider === 'gemini') {
    if (value.reasoningEffort !== null) throw new Error('review_transport_state_invalid');
  } else {
    throw new Error('review_transport_state_invalid');
  }
}

function validateEvidence(value, { required = false } = {}) {
  const product = value.productModelEvidence;
  const reasoning = value.reasoningEffortEvidence;
  if (product !== undefined && product !== null && (typeof product !== 'object' || Array.isArray(product))) {
    throw new Error('review_transport_state_invalid');
  }
  if (required && (
    !product ||
    product.requestedProductModel !== value.productModel ||
    product.matchedLabel !== value.productModel ||
    product.scopedMatchCount !== 1
  )) throw new Error('review_transport_state_invalid');
  if (value.provider === 'chatgpt') {
    if (reasoning !== undefined && reasoning !== null && (typeof reasoning !== 'object' || Array.isArray(reasoning))) {
      throw new Error('review_transport_state_invalid');
    }
    if (required && (
      !reasoning ||
      reasoning.requestedReasoningEffort !== value.reasoningEffort ||
      reasoning.matchedLabel !== value.reasoningEffort ||
      reasoning.scopedMatchCount !== 1 ||
      reasoning.role !== 'slider' ||
      reasoning.actionOwner !== 'Power' ||
      !Number.isFinite(reasoning.min) ||
      !Number.isFinite(reasoning.max) ||
      reasoning.max - reasoning.min !== 4 ||
      reasoning.value !== reasoning.max
    )) throw new Error('review_transport_state_invalid');
  } else if (reasoning !== undefined && reasoning !== null) {
    throw new Error('review_transport_state_invalid');
  }
}

function validateFailure(failure) {
  if (
    !failure ||
    typeof failure !== 'object' ||
    Array.isArray(failure) ||
    !REVIEW_FAILURE_LOCI.has(failure.locus) ||
    !UPPER_CODE.test(String(failure.code || '')) ||
    ((failure.locus === 'NONE') !== (failure.code === 'NONE'))
  ) {
    throw new Error('review_transport_state_invalid');
  }
}

function validateReviewTransportState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION) {
    throw new Error('review_transport_state_invalid');
  }
  if (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) {
    throw new Error('review_transport_state_invalid');
  }
  if (!value.operations || typeof value.operations !== 'object' || Array.isArray(value.operations)) {
    throw new Error('review_transport_state_invalid');
  }

  for (const [key, binding] of Object.entries(value.bindings)) {
    if (
      !nonEmptyString(key) ||
      !binding ||
      typeof binding !== 'object' ||
      Array.isArray(binding) ||
      binding.stableKey !== key ||
      !nonEmptyString(binding.conversationUrl) ||
      !nonEmptyString(binding.conversationId) ||
      !Number.isFinite(binding.createdAt) ||
      !Number.isFinite(binding.updatedAt)
    ) throw new Error('review_transport_state_invalid');
    rejectLegacyFields(binding);
    validateTargetAxes(binding);
    if (binding.geminiBootstrap !== undefined) {
      const bootstrap = binding.geminiBootstrap;
      if (
        binding.provider !== 'gemini' ||
        !bootstrap ||
        typeof bootstrap !== 'object' ||
        Array.isArray(bootstrap) ||
        bootstrap.nonScientific !== true ||
        !nonEmptyString(bootstrap.bootstrapOperationId) ||
        !nonEmptyString(bootstrap.bootstrapProductModel) ||
        typeof bootstrap.continuationConsumed !== 'boolean'
      ) throw new Error('review_transport_state_invalid');
    }
  }

  for (const [key, operation] of Object.entries(value.operations)) {
    if (
      !nonEmptyString(key) ||
      !operation ||
      typeof operation !== 'object' ||
      Array.isArray(operation) ||
      operation.schemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION ||
      operation.idempotencyKey !== key ||
      !nonEmptyString(operation.operationId) ||
      !nonEmptyString(operation.requestFingerprint) ||
      !nonEmptyString(operation.stableKey) ||
      !nonEmptyString(operation.conversationUrl) ||
      !nonEmptyString(operation.conversationId) ||
      !path.isAbsolute(String(operation.responsePath || '')) ||
      !SHA256.test(String(operation.promptSha256 || '')) ||
      !REVIEW_PHASES.has(operation.phase) ||
      !REVIEW_COMMITMENTS.has(operation.commitment) ||
      !REVIEW_RECOVERABILITY.has(operation.recoverability) ||
      !REVIEW_OBSERVABILITY.has(operation.observability) ||
      !REVIEW_MESSAGE_CAPABILITIES.has(operation.messageCapability) ||
      ![0, 1].includes(operation.providerUserMessageCount) ||
      ![0, 1].includes(operation.sendActivationCount) ||
      !Number.isInteger(operation.attemptCount) ||
      operation.attemptCount < 1 ||
      !Number.isFinite(operation.createdAt) ||
      !Number.isFinite(operation.updatedAt)
    ) throw new Error('review_transport_state_invalid');
    rejectLegacyFields(operation);
    validateTargetAxes(operation);
    validateEvidence(operation, { required: operation.commitment === 'ONE_EXACT' });
    validateFailure(operation.failure);

    if (
      operation.messageCapability === 'AVAILABLE' &&
      !(operation.phase === 'PREPARE_UI' && operation.commitment === 'ZERO_PROVEN' && operation.recoverability === 'PRECOMMIT_REPAIR')
    ) throw new Error('review_transport_state_invalid');
    if (operation.messageCapability === 'RESERVED' && operation.phase !== 'ARMED') {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.commitment === 'UNRESOLVED' && (
      operation.phase !== 'VERIFY_COMMITMENT' ||
      operation.recoverability !== 'OBSERVE_ONLY' ||
      operation.messageCapability !== 'SEALED'
    )) throw new Error('review_transport_state_invalid');
    if (operation.commitment === 'ONE_EXACT' && (
      operation.providerUserMessageCount !== 1 ||
      operation.messageCapability !== 'SEALED' ||
      !nonEmptyString(operation.userMessageId) ||
      !['agentify_review_causal_submission_v1', 'agentify_review_observed_exact_turn_v3'].includes(operation.turnConfirmationMode) ||
      (operation.sendActivationCount === 0 && operation.turnConfirmationMode !== 'agentify_review_observed_exact_turn_v3')
    )) throw new Error('review_transport_state_invalid');
    if (operation.commitment === 'ZERO_PROVEN' && (
      operation.providerUserMessageCount !== 0 ||
      operation.sendActivationCount !== 0 ||
      operation.userMessageId !== undefined
    )) throw new Error('review_transport_state_invalid');

    if (operation.phase === 'TERMINAL' && operation.failure.locus === 'NONE') {
      const archive = operation.archive;
      if (
        operation.commitment !== 'ONE_EXACT' ||
        operation.recoverability !== 'NONE' ||
        operation.observability !== 'FRESH_COMPLETE' ||
        !nonEmptyString(operation.assistantMessageId) ||
        !archive ||
        typeof archive !== 'object' ||
        Array.isArray(archive) ||
        !path.isAbsolute(String(archive.path || '')) ||
        archive.path !== operation.responsePath ||
        !SHA256.test(String(archive.sha256 || '')) ||
        !Number.isInteger(archive.sizeBytes) ||
        archive.sizeBytes <= 0 ||
        archive.projection !== 'exact' ||
        !Number.isFinite(archive.verifiedAt)
      ) throw new Error('review_transport_state_invalid');
    }
  }
  return value;
}

export function defaultSettings() {
  return {
    browserBackend: 'chrome-cdp',
    chromeDebugPort: 9222,
    chromeExecutablePath: null,
    chromeProfileMode: 'isolated',
    chromeProfileName: 'Default',
    chromeAttachExisting: false,

    // Governor defaults (intentionally conservative).
    maxInflightQueries: 6,
    maxQueriesPerMinute: 12,
    minTabGapMs: 1200,
    minGlobalGapMs: 200,

    // UX defaults.
    showTabsByDefault: false,
    allowAuthPopups: true,

    // Acknowledgment for changing settings (UX only; not required for operation).
    acknowledgedAt: null
  };
}

export function normalizeSettings(input) {
  const d = defaultSettings();
  const s = input && typeof input === 'object' ? input : {};

  const clampInt = (v, { min, max, fallback }) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return Math.max(min, Math.min(max, i));
  };

  const clampMs = (v, { min, max, fallback }) => clampInt(v, { min, max, fallback });

  const out = {
    browserBackend: ['electron', 'chrome-cdp'].includes(String(s.browserBackend || '').trim().toLowerCase())
      ? String(s.browserBackend || '').trim().toLowerCase()
      : d.browserBackend,
    chromeDebugPort: clampInt(s.chromeDebugPort, { min: 1024, max: 65535, fallback: d.chromeDebugPort }),
    chromeExecutablePath:
      typeof s.chromeExecutablePath === 'string' && s.chromeExecutablePath.trim() ? s.chromeExecutablePath.trim() : null,
    chromeProfileMode: ['isolated', 'existing'].includes(String(s.chromeProfileMode || '').trim().toLowerCase())
      ? String(s.chromeProfileMode || '').trim().toLowerCase()
      : d.chromeProfileMode,
    chromeProfileName:
      typeof s.chromeProfileName === 'string' && s.chromeProfileName.trim() ? s.chromeProfileName.trim() : d.chromeProfileName,
    chromeAttachExisting: typeof s.chromeAttachExisting === 'boolean' ? s.chromeAttachExisting : d.chromeAttachExisting,
    maxInflightQueries: clampInt(s.maxInflightQueries, { min: 1, max: 12, fallback: d.maxInflightQueries }),
    maxQueriesPerMinute: clampInt(s.maxQueriesPerMinute, { min: 1, max: 600, fallback: d.maxQueriesPerMinute }),
    minTabGapMs: clampMs(s.minTabGapMs, { min: 0, max: 60_000, fallback: d.minTabGapMs }),
    minGlobalGapMs: clampMs(s.minGlobalGapMs, { min: 0, max: 10_000, fallback: d.minGlobalGapMs }),
    showTabsByDefault: !!s.showTabsByDefault,
    allowAuthPopups: typeof s.allowAuthPopups === 'boolean' ? s.allowAuthPopups : d.allowAuthPopups,
    acknowledgedAt: typeof s.acknowledgedAt === 'string' && s.acknowledgedAt.trim() ? s.acknowledgedAt.trim() : null
  };
  return out;
}

export async function ensureStateDir(stateDir = defaultStateDir()) {
  await fs.mkdir(stateDir, { recursive: true });
}

export async function readToken(stateDir = defaultStateDir()) {
  const tokenFromEnv = (process.env.AGENTIFY_DESKTOP_TOKEN || '').trim();
  if (tokenFromEnv) return tokenFromEnv;
  try {
    return (await fs.readFile(tokenPath(stateDir), 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function writeToken(token, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(tokenPath(stateDir), `${token}\n`, { mode: 0o600 });
}

export async function ensureToken(stateDir = defaultStateDir()) {
  const existing = await readToken(stateDir);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  await writeToken(token, stateDir);
  return token;
}

export async function readState(stateDir = defaultStateDir()) {
  try {
    return JSON.parse(await fs.readFile(statePath(stateDir), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(state, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(statePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readReviewTransportStateReadOnly(stateDir = defaultStateDir()) {
  try {
    const raw = await fs.readFile(reviewTransportPath(stateDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION) {
      throw new Error('review_transport_state_version_unsupported');
    }
    return validateReviewTransportState(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultReviewTransportState();
    if (['review_transport_state_invalid', 'review_transport_state_version_unsupported'].includes(String(error?.message || ''))) throw error;
    throw new Error('review_transport_state_invalid', { cause: error });
  }
}

export async function readReviewTransportState(stateDir = defaultStateDir()) {
  return await readReviewTransportStateReadOnly(stateDir);
}

export async function writeReviewTransportState(state, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  const normalized = validateReviewTransportState(state);
  await atomicWriteFile(reviewTransportPath(stateDir), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

export async function readSettings(stateDir = defaultStateDir()) {
  try {
    const raw = await fs.readFile(settingsPath(stateDir), 'utf8');
    return normalizeSettings(JSON.parse(raw || '{}'));
  } catch {
    return defaultSettings();
  }
}

export async function writeSettings(settings, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  const normalized = normalizeSettings(settings);
  await atomicWriteFile(settingsPath(stateDir), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}
