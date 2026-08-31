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
const REVIEW_TRANSPORT_FIELDS = new Set([
  'schemaVersion',
  'bindings',
  'operations',
  'retiredIdempotencyKeys',
  'retiredStableKeys'
]);
const UPPER_CODE = /^[A-Z][A-Z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

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

function sortedUniqueStrings(value) {
  return Array.isArray(value) &&
    value.every(nonEmptyString) &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry);
}

export function defaultReviewTransportState() {
  return {
    schemaVersion: REVIEW_TRANSPORT_SCHEMA_VERSION,
    bindings: {},
    operations: {},
    retiredIdempotencyKeys: [],
    retiredStableKeys: []
  };
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


function validateReviewTransportState(value) {
  if (
    !record(value) ||
    value.schemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION ||
    Object.keys(value).some((field) => !REVIEW_TRANSPORT_FIELDS.has(field)) ||
    !record(value.bindings) ||
    !record(value.operations) ||
    !sortedUniqueStrings(value.retiredIdempotencyKeys) ||
    !sortedUniqueStrings(value.retiredStableKeys) ||
    value.retiredIdempotencyKeys.some((key) => Object.hasOwn(value.operations, key)) ||
    value.retiredStableKeys.some((key) => Object.hasOwn(value.bindings, key))
  ) throw new Error('review_transport_state_invalid');

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

export async function readReviewTransportState(stateDir = defaultStateDir()) {
  const rawBytes = await readReviewTransportBytes(stateDir);
  if (!rawBytes) return defaultReviewTransportState();
  return validateReviewTransportState(parseReviewTransportBytes(rawBytes));
}

export async function writeReviewTransportState(state, stateDir = defaultStateDir()) {
  const normalized = validateReviewTransportState(state);
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
