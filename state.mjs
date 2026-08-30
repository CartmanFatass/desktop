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

const REVIEW_TRANSPORT_SCHEMA_VERSION = 4;
const PREVIOUS_REVIEW_TRANSPORT_SCHEMA_VERSION = 3;

const UPPER_CODE = /^[A-Z][A-Z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION = 2;
const LEGACY_REVIEW_STATUSES = new Set([
  'SEND_INTENT',
  'PREPARED',
  'SUBMITTED',
  'OBSERVING',
  'BLOCKED',
  'COMPLETE'
]);
const DIRECTORY_SYNC_UNAVAILABLE = new Set(['EPERM', 'EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR']);


function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function epochMilliseconds(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function absolutePath(value) {
  return typeof value === 'string' && value.length > 0 && (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  );
}


function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validLegacyCount(value, { required = false } = {}) {
  return (!required && value === undefined) || (Number.isInteger(value) && [0, 1].includes(value));
}

function sortedUniqueStrings(value) {
  return Array.isArray(value) &&
    value.every(nonEmptyString) &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function validateLegacyReviewTransportState(value) {
  if (!record(value) || value.schemaVersion !== LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION) {
    throw new Error('review_transport_state_invalid');
  }
  if (!record(value.bindings) || !record(value.operations)) {
    throw new Error('review_transport_state_invalid');
  }
  if (value.migrationHistory !== undefined) {
    const migration = Array.isArray(value.migrationHistory) && value.migrationHistory.length === 1
      ? value.migrationHistory[0]
      : null;
    const inferredKeys = new Set();
    if (
      !record(migration) ||
      migration.migrationId !== 'review_transport_v1_to_v2_complete_send_action_count' ||
      migration.fromSchemaVersion !== 1 ||
      migration.toSchemaVersion !== LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION ||
      !Array.isArray(migration.inferredFields) ||
      migration.inferredFields.some((entry) => {
        if (
          !record(entry) ||
          !nonEmptyString(entry.idempotencyKey) ||
          !nonEmptyString(entry.operationId) ||
          entry.field !== 'sendActionCount' ||
          entry.value !== 1 ||
          entry.basis !== 'validated_complete_send_and_completion_evidence' ||
          inferredKeys.has(entry.idempotencyKey)
        ) return true;
        inferredKeys.add(entry.idempotencyKey);
        const operation = value.operations[entry.idempotencyKey];
        return (
          !record(operation) ||
          operation.operationId !== entry.operationId ||
          operation.status !== 'COMPLETE' ||
          operation.sendActionCount !== 1
        );
      })
    ) throw new Error('review_transport_state_invalid');
  }

  for (const [key, binding] of Object.entries(value.bindings)) {
    if (
      !nonEmptyString(key) ||
      !record(binding) ||
      binding.stableKey !== key ||
      !['chatgpt', 'gemini'].includes(binding.provider) ||
      !nonEmptyString(binding.model) ||
      !nonEmptyString(binding.conversationUrl) ||
      !nonEmptyString(binding.conversationId) ||
      !Number.isFinite(binding.createdAt) ||
      !Number.isFinite(binding.updatedAt)
    ) throw new Error('review_transport_state_invalid');

    if (binding.geminiBootstrap !== undefined) {
      const bootstrap = binding.geminiBootstrap;
      if (
        binding.provider !== 'gemini' ||
        !record(bootstrap) ||
        bootstrap.nonScientific !== true ||
        !nonEmptyString(bootstrap.bootstrapOperationId) ||
        !nonEmptyString(bootstrap.bootstrapModel) ||
        typeof bootstrap.continuationConsumed !== 'boolean'
      ) throw new Error('review_transport_state_invalid');
    }
  }

  for (const [key, operation] of Object.entries(value.operations)) {
    if (
      !nonEmptyString(key) ||
      !record(operation) ||
      operation.idempotencyKey !== key ||
      !nonEmptyString(operation.operationId) ||
      !nonEmptyString(operation.requestFingerprint) ||
      !nonEmptyString(operation.stableKey) ||
      !['chatgpt', 'gemini'].includes(operation.provider) ||
      !nonEmptyString(operation.model) ||
      !nonEmptyString(operation.conversationUrl) ||
      !nonEmptyString(operation.conversationId) ||
      !SHA256.test(String(operation.promptSha256 || '')) ||
      !LEGACY_REVIEW_STATUSES.has(operation.status) ||
      !validLegacyCount(operation.sendCount, { required: true }) ||
      !validLegacyCount(operation.sendActionCount) ||
      !validLegacyCount(operation.newUserMessageCount) ||
      !Number.isFinite(operation.createdAt) ||
      !Number.isFinite(operation.updatedAt) ||
      (operation.responsePath !== undefined && !absolutePath(operation.responsePath)) ||
      (operation.sendBoundaryEnteredAt !== undefined && !Number.isFinite(operation.sendBoundaryEnteredAt)) ||
      (operation.baselineMessageIds !== undefined && (
        !Array.isArray(operation.baselineMessageIds) ||
        operation.baselineMessageIds.some((entry) => !nonEmptyString(entry)) ||
        new Set(operation.baselineMessageIds).size !== operation.baselineMessageIds.length
      )) ||
      (operation.userMessageId !== undefined && !nonEmptyString(operation.userMessageId)) ||
      (operation.assistantMessageId !== undefined && !nonEmptyString(operation.assistantMessageId))
    ) throw new Error('review_transport_state_invalid');

    const observedFields = [
      'observedUserMessageId',
      'observedUserMessageAt',
      'observedConversationUrl',
      'observedConversationId',
      'observedCommitmentClass',
      'observedTurnEvidence'
    ];
    const observedCount = observedFields.filter((field) => operation[field] !== undefined).length;
    if (observedCount !== 0 && (
      observedCount !== observedFields.length ||
      !nonEmptyString(operation.observedUserMessageId) ||
      !Number.isFinite(operation.observedUserMessageAt) ||
      !nonEmptyString(operation.observedConversationUrl) ||
      !nonEmptyString(operation.observedConversationId) ||
      ![
        'turn_exact',
        'turn_unreadable',
        'turn_content_mismatch',
        'turn_causal_exact_rendered_unreadable',
        'turn_causal_exact_rendered_mismatch'
      ].includes(operation.observedCommitmentClass) ||
      !record(operation.observedTurnEvidence) ||
      operation.sendActionCount !== 1 ||
      operation.newUserMessageCount !== 1 ||
      (operation.userMessageId !== undefined && operation.userMessageId !== operation.observedUserMessageId)
    )) throw new Error('review_transport_state_invalid');

    if (operation.causalSendReceipt !== undefined && (
      !record(operation.causalSendReceipt) ||
      operation.causalSendReceipt.identityModel !== 'agentify_review_causal_submission_v1' ||
      operation.causalSendReceipt.operationId !== operation.operationId ||
      operation.causalSendReceipt.sendActionCount !== 1 ||
      operation.causalSendReceipt.clickCount !== 1 ||
      operation.causalSendReceipt.sourceSha256 !== operation.promptSha256 ||
      !SHA256.test(String(operation.causalSendReceipt.canonicalPromptSha256 || '')) ||
      !SHA256.test(String(operation.causalSendReceipt.baselineMessageIdsSha256 || ''))
    )) throw new Error('review_transport_state_invalid');

    if (operation.status === 'PREPARED' && (
      !Array.isArray(operation.baselineMessageIds) ||
      operation.sendCount !== 0 ||
      operation.userMessageId !== undefined
    )) throw new Error('review_transport_state_invalid');
    if (operation.status === 'SUBMITTED' && (
      operation.sendCount !== 1 ||
      !nonEmptyString(operation.userMessageId)
    )) throw new Error('review_transport_state_invalid');
    if (operation.status === 'COMPLETE' && (
      operation.sendCount !== 1 ||
      operation.sendActionCount !== 1 ||
      !nonEmptyString(operation.userMessageId) ||
      !nonEmptyString(operation.assistantMessageId) ||
      operation.terminalState !== 'NATURAL_COMPLETION_VERIFIED' ||
      !Number.isFinite(operation.completedAt)
    )) throw new Error('review_transport_state_invalid');
  }

  return {
    bindingKeys: Object.keys(value.bindings).sort(),
    idempotencyKeys: Object.keys(value.operations).sort()
  };
}

function legacyArchiveBasename(sha256) {
  return `review-transport.v2-${sha256}.json`;
}

function legacyMetadata(rawBytes, legacyState) {
  const { bindingKeys, idempotencyKeys } = validateLegacyReviewTransportState(legacyState);
  const sha256 = sha256Bytes(rawBytes);
  return {
    archiveBasename: legacyArchiveBasename(sha256),
    sha256,
    sourceSchemaVersion: LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION,
    bindingKeys,
    idempotencyKeys
  };
}

function validateLegacyMetadata(value) {
  if (value === undefined) return null;
  if (
    !record(value) ||
    !SHA256.test(String(value.sha256 || '')) ||
    value.archiveBasename !== legacyArchiveBasename(value.sha256) ||
    path.basename(value.archiveBasename) !== value.archiveBasename ||
    value.sourceSchemaVersion !== LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION ||
    !sortedUniqueStrings(value.bindingKeys) ||
    !sortedUniqueStrings(value.idempotencyKeys)
  ) throw new Error('review_transport_state_invalid');
  return value;
}

function sameLegacyMetadata(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.archiveBasename === right.archiveBasename &&
    left.sha256 === right.sha256 &&
    left.sourceSchemaVersion === right.sourceSchemaVersion &&
    sameStrings(left.bindingKeys, right.bindingKeys) &&
    sameStrings(left.idempotencyKeys, right.idempotencyKeys);
}

export function defaultReviewTransportState() {
  return { schemaVersion: REVIEW_TRANSPORT_SCHEMA_VERSION, bindings: {}, operations: {} };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
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



function validateV3ReviewTransportState(value) {
  if (!record(value) || value.schemaVersion !== PREVIOUS_REVIEW_TRANSPORT_SCHEMA_VERSION) {
    throw new Error('review_transport_state_invalid');
  }
  if (!record(value.bindings) || !record(value.operations)) {
    throw new Error('review_transport_state_invalid');
  }
  const legacy = validateLegacyMetadata(value.legacy);
  if (legacy && (
    legacy.bindingKeys.some((key) => Object.hasOwn(value.bindings, key)) ||
    legacy.idempotencyKeys.some((key) => Object.hasOwn(value.operations, key))
  )) throw new Error('review_transport_state_invalid');

  for (const [key, binding] of Object.entries(value.bindings)) {
    if (
      !nonEmptyString(key) ||
      !record(binding) ||
      binding.stableKey !== key ||
      !nonEmptyString(binding.conversationUrl) ||
      !nonEmptyString(binding.conversationId) ||
      !Number.isFinite(binding.createdAt) ||
      !Number.isFinite(binding.updatedAt)
    ) throw new Error('review_transport_state_invalid');
    validateTargetAxes(binding);
  }

  for (const [key, operation] of Object.entries(value.operations)) {
    if (
      !nonEmptyString(key) ||
      !record(operation) ||
      operation.schemaVersion !== PREVIOUS_REVIEW_TRANSPORT_SCHEMA_VERSION ||
      operation.idempotencyKey !== key ||
      !nonEmptyString(operation.operationId) ||
      !nonEmptyString(operation.requestFingerprint) ||
      !nonEmptyString(operation.stableKey) ||
      !nonEmptyString(operation.conversationUrl) ||
      !nonEmptyString(operation.conversationId) ||
      !absolutePath(operation.responsePath) ||
      !SHA256.test(String(operation.promptSha256 || '')) ||
      (operation.sendBoundaryEnteredAt !== undefined && !Number.isFinite(operation.sendBoundaryEnteredAt)) ||
      (operation.providerUserMessageCount !== undefined && ![0, 1].includes(operation.providerUserMessageCount)) ||
      (operation.sendActivationCount !== undefined && ![0, 1].includes(operation.sendActivationCount)) ||
      (operation.userMessageId !== undefined && !nonEmptyString(operation.userMessageId)) ||
      (operation.observedUserMessageId !== undefined && !nonEmptyString(operation.observedUserMessageId)) ||
      (operation.assistantMessageId !== undefined && !nonEmptyString(operation.assistantMessageId)) ||
      !Number.isFinite(operation.createdAt) ||
      !Number.isFinite(operation.updatedAt)
    ) throw new Error('review_transport_state_invalid');
    validateTargetAxes(operation);
  }
  return value;
}

const V4_OPERATION_FIELDS = new Set([
  'schemaVersion',
  'operationId',
  'idempotencyKey',
  'requestFingerprint',
  'stableKey',
  'provider',
  'productModel',
  'reasoningEffort',
  'conversationUrl',
  'conversationId',
  'promptSha256',
  'responsePath',
  'sendAttempted',
  'sendAttemptedAt',
  'providerUserMessageId',
  'providerAssistantMessageId',
  'observedConversationUrl',
  'observedConversationId',
  'archive',
  'error',
  'createdAt',
  'updatedAt'
]);

function validateArchive(archive, responsePath) {
  if (archive === null) return;
  if (
    !record(archive) ||
    !absolutePath(archive.path) ||
    archive.path !== responsePath ||
    !SHA256.test(String(archive.sha256 || '')) ||
    !Number.isInteger(archive.sizeBytes) ||
    archive.sizeBytes <= 0 ||
    archive.projection !== 'exact' ||
    !epochMilliseconds(archive.verifiedAt)
  ) throw new Error('review_transport_state_invalid');
}

function validateReceiptError(error) {
  if (error === null) return;
  if (
    !record(error) ||
    Object.keys(error).length !== 1 ||
    !UPPER_CODE.test(String(error.code || '')) ||
    error.code === 'NONE'
  ) throw new Error('review_transport_state_invalid');
}

function v3ArchiveBasename(sha256) {
  return `review-transport.v3-${sha256}.json`;
}

function v3ArchiveMetadata(rawBytes, state) {
  validateV3ReviewTransportState(state);
  const sha256 = sha256Bytes(rawBytes);
  return {
    archiveBasename: v3ArchiveBasename(sha256),
    sha256,
    sourceSchemaVersion: PREVIOUS_REVIEW_TRANSPORT_SCHEMA_VERSION,
    bindingKeys: Object.keys(state.bindings).sort(),
    idempotencyKeys: Object.keys(state.operations).sort()
  };
}

function validateV3ArchiveMetadata(value) {
  if (value === undefined) return null;
  if (
    !record(value) ||
    !SHA256.test(String(value.sha256 || '')) ||
    value.archiveBasename !== v3ArchiveBasename(value.sha256) ||
    path.basename(value.archiveBasename) !== value.archiveBasename ||
    value.sourceSchemaVersion !== PREVIOUS_REVIEW_TRANSPORT_SCHEMA_VERSION ||
    !sortedUniqueStrings(value.bindingKeys) ||
    !sortedUniqueStrings(value.idempotencyKeys)
  ) throw new Error('review_transport_state_invalid');
  return value;
}

function validateReviewTransportState(value) {
  if (!record(value) || value.schemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION) {
    throw new Error('review_transport_state_invalid');
  }
  if (!record(value.bindings) || !record(value.operations)) {
    throw new Error('review_transport_state_invalid');
  }
  const legacy = validateLegacyMetadata(value.legacy);
  validateV3ArchiveMetadata(value.v3Archive);
  if (legacy && (
    legacy.bindingKeys.some((key) => Object.hasOwn(value.bindings, key)) ||
    legacy.idempotencyKeys.some((key) => Object.hasOwn(value.operations, key))
  )) throw new Error('review_transport_state_invalid');

  for (const [key, binding] of Object.entries(value.bindings)) {
    if (
      !nonEmptyString(key) ||
      !record(binding) ||
      binding.stableKey !== key ||
      !nonEmptyString(binding.conversationUrl) ||
      !nonEmptyString(binding.conversationId) ||
      !epochMilliseconds(binding.createdAt) ||
      !epochMilliseconds(binding.updatedAt)
    ) throw new Error('review_transport_state_invalid');
    validateTargetAxes(binding);
    if (binding.geminiBootstrap !== undefined) {
      const bootstrap = binding.geminiBootstrap;
      if (
        binding.provider !== 'gemini' ||
        !record(bootstrap) ||
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
      !record(operation) ||
      Object.keys(operation).some((field) => !V4_OPERATION_FIELDS.has(field)) ||
      operation.schemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION ||
      operation.idempotencyKey !== key ||
      !nonEmptyString(operation.operationId) ||
      !SHA256.test(String(operation.requestFingerprint || '')) ||
      !nonEmptyString(operation.stableKey) ||
      !nonEmptyString(operation.conversationUrl) ||
      !nonEmptyString(operation.conversationId) ||
      !absolutePath(operation.responsePath) ||
      !SHA256.test(String(operation.promptSha256 || '')) ||
      typeof operation.sendAttempted !== 'boolean' ||
      (operation.sendAttemptedAt !== null && !epochMilliseconds(operation.sendAttemptedAt)) ||
      (operation.providerUserMessageId !== null && !nonEmptyString(operation.providerUserMessageId)) ||
      (operation.providerAssistantMessageId !== null && !nonEmptyString(operation.providerAssistantMessageId)) ||
      (operation.observedConversationUrl !== null && !nonEmptyString(operation.observedConversationUrl)) ||
      (operation.observedConversationId !== null && !nonEmptyString(operation.observedConversationId)) ||
      !epochMilliseconds(operation.createdAt) ||
      !epochMilliseconds(operation.updatedAt)
    ) throw new Error('review_transport_state_invalid');
    validateTargetAxes(operation);
    validateArchive(operation.archive, operation.responsePath);
    validateReceiptError(operation.error);
    if (operation.sendAttempted !== (operation.sendAttemptedAt !== null)) {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.providerUserMessageId !== null && !operation.sendAttempted) {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.providerAssistantMessageId !== null && operation.providerUserMessageId === null) {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.archive !== null && operation.providerAssistantMessageId === null) {
      throw new Error('review_transport_state_invalid');
    }
    const observedUrl = operation.observedConversationUrl !== null;
    const observedId = operation.observedConversationId !== null;
    if (observedUrl !== observedId || (observedUrl && operation.providerUserMessageId === null)) {
      throw new Error('review_transport_state_invalid');
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

async function readReviewTransportBytes(stateDir) {
  try {
    return await fs.readFile(reviewTransportPath(stateDir));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function parseReviewTransportBytes(rawBytes) {
  try {
    return JSON.parse(rawBytes.toString('utf8'));
  } catch (error) {
    throw new Error('review_transport_state_invalid', { cause: error });
  }
}

function v3Error(operation) {
  const code = String(operation?.failure?.code || '').trim();
  if (code && code !== 'NONE') return { code };
  if (!operation?.error) return null;
  const normalized = String(operation.error)
    .replace(/^review_/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return { code: normalized || 'UNKNOWN_FAILURE' };
}

function v3SendAttempted(operation) {
  return Number.isFinite(operation.sendBoundaryEnteredAt) ||
    operation.sendActivationCount === 1 ||
    operation.providerUserMessageCount === 1 ||
    nonEmptyString(operation.userMessageId) ||
    nonEmptyString(operation.observedUserMessageId) ||
    nonEmptyString(operation.assistantMessageId) ||
    operation.messageCapability === 'RESERVED' ||
    operation.messageCapability === 'SEALED' ||
    operation.commitment !== 'ZERO_PROVEN';
}

function v3Projection(rawBytes, parsed) {
  validateV3ReviewTransportState(parsed);
  const operations = {};
  for (const [key, operation] of Object.entries(parsed.operations)) {
    const sendAttempted = v3SendAttempted(operation);
    const providerUserMessageId = operation.userMessageId || operation.observedUserMessageId || null;
    operations[key] = {
      schemaVersion: REVIEW_TRANSPORT_SCHEMA_VERSION,
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      requestFingerprint: operation.requestFingerprint,
      stableKey: operation.stableKey,
      provider: operation.provider,
      productModel: operation.productModel,
      reasoningEffort: operation.reasoningEffort,
      conversationUrl: operation.conversationUrl,
      conversationId: operation.conversationId,
      promptSha256: operation.promptSha256,
      responsePath: operation.responsePath,
      sendAttempted,
      sendAttemptedAt: sendAttempted
        ? operation.sendBoundaryEnteredAt ?? operation.observedAt ?? operation.submittedAt ?? operation.updatedAt
        : null,
      providerUserMessageId,
      providerAssistantMessageId: operation.assistantMessageId || null,
      observedConversationUrl: providerUserMessageId
        ? operation.observedConversationUrl || operation.conversationUrl
        : null,
      observedConversationId: providerUserMessageId
        ? operation.observedConversationId || operation.conversationId
        : null,
      archive: operation.archive || null,
      error: v3Error(operation),
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt
    };
  }
  return validateReviewTransportState({
    schemaVersion: REVIEW_TRANSPORT_SCHEMA_VERSION,
    bindings: structuredClone(parsed.bindings),
    operations,
    ...(parsed.legacy ? { legacy: structuredClone(parsed.legacy) } : {}),
    v3Archive: v3ArchiveMetadata(rawBytes, parsed)
  });
}

async function verifyLegacyArchive(stateDir, metadata) {
  if (!metadata) return;
  try {
    const rawBytes = await fs.readFile(path.join(stateDir, metadata.archiveBasename));
    if (sha256Bytes(rawBytes) !== metadata.sha256) {
      throw new Error('review_transport_state_invalid');
    }
    const observed = legacyMetadata(rawBytes, parseReviewTransportBytes(rawBytes));
    if (
      observed.archiveBasename !== metadata.archiveBasename ||
      observed.sourceSchemaVersion !== metadata.sourceSchemaVersion ||
      !sameStrings(observed.bindingKeys, metadata.bindingKeys) ||
      !sameStrings(observed.idempotencyKeys, metadata.idempotencyKeys)
    ) throw new Error('review_transport_state_invalid');
  } catch (error) {
    if (error?.message === 'review_transport_state_invalid') throw error;
    throw new Error('review_transport_state_invalid', { cause: error });
  }
}

async function verifyV3Archive(stateDir, metadata, expectedLegacy = undefined) {
  if (!metadata) return;
  try {
    const rawBytes = await fs.readFile(path.join(stateDir, metadata.archiveBasename));
    if (sha256Bytes(rawBytes) !== metadata.sha256) {
      throw new Error('review_transport_state_invalid');
    }
    const parsed = parseReviewTransportBytes(rawBytes);
    const observed = v3ArchiveMetadata(rawBytes, parsed);
    if (
      observed.archiveBasename !== metadata.archiveBasename ||
      observed.sourceSchemaVersion !== metadata.sourceSchemaVersion ||
      !sameStrings(observed.bindingKeys, metadata.bindingKeys) ||
      !sameStrings(observed.idempotencyKeys, metadata.idempotencyKeys) ||
      !sameLegacyMetadata(parsed.legacy, expectedLegacy)
    ) throw new Error('review_transport_state_invalid');
  } catch (error) {
    if (error?.message === 'review_transport_state_invalid') throw error;
    throw new Error('review_transport_state_invalid', { cause: error });
  }
}

async function syncDirectory(directoryPath) {
  const directory = await fs.open(directoryPath, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function publishExactArchive(
  stateDir,
  metadata,
  rawBytes,
  { syncDirectory: syncPublishedDirectory = syncDirectory } = {}
) {
  const archivePath = path.join(stateDir, metadata.archiveBasename);
  const verifyExisting = async () => {
    const observed = await fs.readFile(archivePath);
    if (!observed.equals(rawBytes)) throw new Error('review_transport_state_invalid');
  };
  try {
    await verifyExisting();
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = path.join(
    stateDir,
    `.${metadata.archiveBasename}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(rawBytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporaryPath, archivePath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await verifyExisting();
      return;
    }
    try {
      await syncPublishedDirectory(stateDir);
    } catch (error) {
      if (!DIRECTORY_SYNC_UNAVAILABLE.has(error?.code)) throw error;
    }
    await verifyExisting();
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function validateCurrentReviewTransportState(parsed, stateDir) {
  const normalized = validateReviewTransportState(parsed);
  await verifyLegacyArchive(stateDir, normalized.legacy);
  await verifyV3Archive(stateDir, normalized.v3Archive, normalized.legacy);
  return normalized;
}

export async function readReviewTransportStateReadOnly(stateDir = defaultStateDir()) {
  const rawBytes = await readReviewTransportBytes(stateDir);
  if (!rawBytes) return defaultReviewTransportState();
  const parsed = parseReviewTransportBytes(rawBytes);
  if (parsed?.schemaVersion === PREVIOUS_REVIEW_TRANSPORT_SCHEMA_VERSION) {
    const normalized = v3Projection(rawBytes, parsed);
    await verifyLegacyArchive(stateDir, normalized.legacy);
    return normalized;
  }
  if (parsed?.schemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION) {
    throw new Error('review_transport_state_version_unsupported');
  }
  return await validateCurrentReviewTransportState(parsed, stateDir);
}

export async function readReviewTransportState(
  stateDir = defaultStateDir(),
  publishOptions = {}
) {
  const rawBytes = await readReviewTransportBytes(stateDir);
  if (!rawBytes) return defaultReviewTransportState();
  const parsed = parseReviewTransportBytes(rawBytes);
  if (parsed?.schemaVersion === PREVIOUS_REVIEW_TRANSPORT_SCHEMA_VERSION) {
    const normalized = v3Projection(rawBytes, parsed);
    await verifyLegacyArchive(stateDir, normalized.legacy);
    await publishExactArchive(stateDir, normalized.v3Archive, rawBytes, publishOptions);
    await atomicWriteFile(
      reviewTransportPath(stateDir),
      `${JSON.stringify(normalized, null, 2)}\n`,
      { mode: 0o600 }
    );
    return normalized;
  }
  if (parsed?.schemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION) {
    throw new Error('review_transport_state_version_unsupported');
  }
  return await validateCurrentReviewTransportState(parsed, stateDir);
}

export async function writeReviewTransportState(state, stateDir = defaultStateDir()) {
  const normalized = validateReviewTransportState(state);
  await verifyLegacyArchive(stateDir, normalized.legacy);
  await verifyV3Archive(stateDir, normalized.v3Archive, normalized.legacy);
  await ensureStateDir(stateDir);
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
