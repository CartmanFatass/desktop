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

const REVIEW_TRANSPORT_SCHEMA_VERSION = 2;
const LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION = 1;
const LEGACY_SEND_ACTION_MIGRATION_ID = 'review_transport_v1_to_v2_complete_send_action_count';
const LEGACY_SEND_ACTION_MIGRATION_BASIS = 'validated_complete_send_and_completion_evidence';

export function defaultReviewTransportState() {
  return { schemaVersion: REVIEW_TRANSPORT_SCHEMA_VERSION, bindings: {}, operations: {} };
}

function validateMigrationHistory(value, nonEmptyString) {
  if (value.migrationHistory === undefined) return;
  if (!Array.isArray(value.migrationHistory) || value.migrationHistory.length !== 1) {
    throw new Error('review_transport_state_invalid');
  }
  const migration = value.migrationHistory[0];
  if (
    !migration ||
    typeof migration !== 'object' ||
    Array.isArray(migration) ||
    migration.migrationId !== LEGACY_SEND_ACTION_MIGRATION_ID ||
    migration.fromSchemaVersion !== LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION ||
    migration.toSchemaVersion !== REVIEW_TRANSPORT_SCHEMA_VERSION ||
    !Array.isArray(migration.inferredFields)
  ) {
    throw new Error('review_transport_state_invalid');
  }
  const seen = new Set();
  for (const inference of migration.inferredFields) {
    const operation = value.operations?.[inference?.idempotencyKey];
    if (
      !inference ||
      typeof inference !== 'object' ||
      Array.isArray(inference) ||
      !nonEmptyString(inference.idempotencyKey) ||
      !nonEmptyString(inference.operationId) ||
      inference.field !== 'sendActionCount' ||
      inference.value !== 1 ||
      inference.basis !== LEGACY_SEND_ACTION_MIGRATION_BASIS ||
      seen.has(inference.idempotencyKey) ||
      !operation ||
      operation.operationId !== inference.operationId ||
      operation.status !== 'COMPLETE' ||
      operation.sendActionCount !== 1
    ) {
      throw new Error('review_transport_state_invalid');
    }
    seen.add(inference.idempotencyKey);
  }
}

function validateReviewTransportState(value, { allowLegacyCompleteMissingSendActionCount = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('review_transport_state_invalid');
  const expectedSchemaVersion = allowLegacyCompleteMissingSendActionCount
    ? LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION
    : REVIEW_TRANSPORT_SCHEMA_VERSION;
  if (value.schemaVersion !== expectedSchemaVersion) throw new Error('review_transport_state_invalid');
  if (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) {
    throw new Error('review_transport_state_invalid');
  }
  if (!value.operations || typeof value.operations !== 'object' || Array.isArray(value.operations)) {
    throw new Error('review_transport_state_invalid');
  }
  const nonEmptyString = (entry) => typeof entry === 'string' && entry.length > 0;
  for (const [key, binding] of Object.entries(value.bindings)) {
    if (
      !nonEmptyString(key) ||
      !binding ||
      typeof binding !== 'object' ||
      Array.isArray(binding) ||
      binding.stableKey !== key ||
      !nonEmptyString(binding.provider) ||
      !nonEmptyString(binding.model) ||
      !nonEmptyString(binding.conversationUrl) ||
      !nonEmptyString(binding.conversationId) ||
      !Number.isFinite(binding.createdAt) ||
      !Number.isFinite(binding.updatedAt)
    ) {
      throw new Error('review_transport_state_invalid');
    }
  }
  const statuses = new Set(['SEND_INTENT', 'PREPARED', 'SUBMITTED', 'BLOCKED', 'COMPLETE']);
  for (const [key, operation] of Object.entries(value.operations)) {
    if (
      !nonEmptyString(key) ||
      !operation ||
      typeof operation !== 'object' ||
      Array.isArray(operation) ||
      operation.idempotencyKey !== key ||
      !nonEmptyString(operation.operationId) ||
      !nonEmptyString(operation.requestFingerprint) ||
      !nonEmptyString(operation.stableKey) ||
      !nonEmptyString(operation.provider) ||
      !nonEmptyString(operation.model) ||
      !nonEmptyString(operation.conversationUrl) ||
      !nonEmptyString(operation.conversationId) ||
      !/^[0-9a-f]{64}$/.test(String(operation.promptSha256 || '')) ||
      !statuses.has(operation.status) ||
      !Number.isInteger(operation.sendCount) ||
      operation.sendCount < 0 ||
      operation.sendCount > 1 ||
      !Number.isFinite(operation.createdAt) ||
      !Number.isFinite(operation.updatedAt) ||
      !Number.isFinite(operation.deadlineAt) ||
      operation.deadlineAt <= operation.createdAt
    ) {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.baselineMessageIds !== undefined) {
      if (
        !Array.isArray(operation.baselineMessageIds) ||
        operation.baselineMessageIds.some((id) => !nonEmptyString(id)) ||
        new Set(operation.baselineMessageIds).size !== operation.baselineMessageIds.length
      ) {
        throw new Error('review_transport_state_invalid');
      }
    }
    if (operation.userMessageId !== undefined && !nonEmptyString(operation.userMessageId)) {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.assistantMessageId !== undefined && !nonEmptyString(operation.assistantMessageId)) {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.status === 'PREPARED' && (!operation.baselineMessageIds || operation.sendCount !== 0 || operation.userMessageId)) {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.status === 'SUBMITTED' && (operation.sendCount !== 1 || !operation.userMessageId)) {
      throw new Error('review_transport_state_invalid');
    }
    if (operation.status === 'COMPLETE') {
      const responseText = operation.responseText;
      const responseSha256 = typeof responseText === 'string'
        ? crypto.createHash('sha256').update(responseText, 'utf8').digest('hex')
        : null;
      const snapshots = operation.snapshots;
      const controls = operation.controls;
      const validSendActionCount = operation.sendActionCount === 1 || (
        allowLegacyCompleteMissingSendActionCount && operation.sendActionCount === undefined
      );
      if (
        operation.sendCount !== 1 ||
        !validSendActionCount ||
        !operation.userMessageId ||
        !operation.assistantMessageId ||
        operation.terminalState !== 'NATURAL_COMPLETION_VERIFIED' ||
        !nonEmptyString(responseText) ||
        operation.responseSha256 !== responseSha256 ||
        !Array.isArray(snapshots) ||
        snapshots.length !== 2 ||
        snapshots.some((snapshot) =>
          !snapshot ||
          snapshot.assistantMessageId !== operation.assistantMessageId ||
          snapshot.textSha256 !== responseSha256 ||
          !Number.isFinite(snapshot.observedAt)
        ) ||
        snapshots[1].observedAt - snapshots[0].observedAt < 3_000 ||
        !controls ||
        typeof controls !== 'object' ||
        controls.stop !== false ||
        controls.continue !== false ||
        controls.retry !== false ||
        typeof controls.answerNow !== 'boolean' ||
        !Array.isArray(operation.clickedControls) ||
        operation.clickedControls.length !== 0 ||
        !nonEmptyString(operation.modelEvidence) ||
        !Number.isFinite(operation.completedAt)
      ) {
        throw new Error('review_transport_state_invalid');
      }
    }
  }
  if (!allowLegacyCompleteMissingSendActionCount) validateMigrationHistory(value, nonEmptyString);
  return value;
}

function migrateLegacyReviewTransportState(value) {
  validateReviewTransportState(value, { allowLegacyCompleteMissingSendActionCount: true });
  const inferredFields = [];
  const operations = {};
  for (const [idempotencyKey, operation] of Object.entries(value.operations)) {
    const migratedOperation = { ...operation };
    if (operation.status === 'COMPLETE' && operation.sendActionCount === undefined) {
      migratedOperation.sendActionCount = 1;
      inferredFields.push({
        idempotencyKey,
        operationId: operation.operationId,
        field: 'sendActionCount',
        value: 1,
        basis: LEGACY_SEND_ACTION_MIGRATION_BASIS
      });
    }
    operations[idempotencyKey] = migratedOperation;
  }
  inferredFields.sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
  return validateReviewTransportState({
    ...value,
    schemaVersion: REVIEW_TRANSPORT_SCHEMA_VERSION,
    operations,
    migrationHistory: [{
      migrationId: LEGACY_SEND_ACTION_MIGRATION_ID,
      fromSchemaVersion: LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION,
      toSchemaVersion: REVIEW_TRANSPORT_SCHEMA_VERSION,
      inferredFields
    }]
  });
}

function normalizeReviewTransportState(value, { migrateLegacy = false } = {}) {
  if (migrateLegacy && value?.schemaVersion === LEGACY_REVIEW_TRANSPORT_SCHEMA_VERSION) {
    return migrateLegacyReviewTransportState(value);
  }
  return validateReviewTransportState(value);
}

export function defaultSettings() {
  return {
    browserBackend: 'chrome-cdp',
    chromeDebugPort: 9222,
    chromeExecutablePath: null,
    chromeProfileMode: 'isolated',
    chromeProfileName: 'Default',

    // Governor defaults (intentionally conservative).
    maxInflightQueries: 2,
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

export async function readReviewTransportState(stateDir = defaultStateDir()) {
  try {
    const raw = await fs.readFile(reviewTransportPath(stateDir), 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeReviewTransportState(parsed, { migrateLegacy: true });
    if (parsed.schemaVersion !== normalized.schemaVersion) {
      await atomicWriteFile(
        reviewTransportPath(stateDir),
        `${JSON.stringify(normalized, null, 2)}\n`,
        { mode: 0o600 }
      );
    }
    return normalized;
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultReviewTransportState();
    if (String(error?.message || '') === 'review_transport_state_invalid') throw error;
    throw new Error('review_transport_state_invalid', { cause: error });
  }
}

export async function writeReviewTransportState(state, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  const normalized = normalizeReviewTransportState(state);
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
