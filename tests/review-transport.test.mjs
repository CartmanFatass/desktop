import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { archiveReviewResponse, prepareReviewPromptInput, resolveReviewPromptInput, runReviewQuery } from '../review-transport.mjs';
import { readReviewTransportState, writeReviewTransportState } from '../state.mjs';
import { ChatGPTController } from '../chatgpt-controller.mjs';
import { REVIEW_PLAIN_TEXT_MODEL, reviewPlainTextIdentity } from '../review-text-identity.mjs';
import { REVIEW_COMPOSER_REPLACEMENT_MODEL } from '../review-composer-replacement.mjs';

// These tests exercise the current v4 product/effort + sendAttempted protocol.
// The retired v3 diagnostic APIs are intentionally not emulated by the fixture.
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
async function fixture(t) {
  const parent = path.resolve('temp/tests');
  await fs.mkdir(parent, { recursive: true });
  const stateDir = await fs.mkdtemp(path.join(parent, 'review-admission-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const request = { stableKey: 'question', idempotencyKey: 'question', provider: 'chatgpt',
    productModel: 'GPT-6 Astra', reasoningEffort: 'Pro',
    conversationUrl: 'https://chatgpt.com/c/fixture', conversationId: 'fixture',
    prompt: 'exact\r\n中文  prompt', responsePath: path.join(stateDir, 'answer.md'), timeoutMs: 1000 };
  request.promptSha256 = sha(request.prompt);
  const calls = { review: 0, clicks: 0, observe: 0, recover: 0, tabs: 0 };
  const mode = { crash: false, presend: false, waiting: false, skipComposer: false, baseline: ['old-user'], recoveredId: 'new-user', controls: {}, snapshotGap: 3100, resultUser: null, identityOverride: null, preparedProductModel: null };
  let tail = Promise.resolve();
  const operation = async () => (await readReviewTransportState(stateDir)).operations[request.idempotencyKey];
  const identity = (args) => {
    if (mode.identityOverride) return mode.identityOverride;
    if (!args.firstBinding) return { conversationUrl: args.expectedUrl, conversationId: args.expectedConversationId };
    return new URL(args.expectedUrl).hostname === 'gemini.google.com'
      ? { conversationUrl: 'https://gemini.google.com/app/created', conversationId: 'created' }
      : { conversationUrl: 'https://chatgpt.com/c/created', conversationId: 'created' };
  };
  const controller = {
    async runExclusive(fn) { const prev = tail; let release; tail = new Promise(r => { release = r; }); await prev; try { return await fn(); } finally { release(); } },
    async reviewQuery(args) {
      calls.review++;
      assert.equal(args.requireTargetPreflight, true);
      assert.equal(typeof args.prompt, 'string');
      await args.onPrepared({ baselineMessageIds: mode.baseline,
        productModelEvidence: { matchedLabel: mode.preparedProductModel || args.productModel } });
      if (!mode.skipComposer) {
        const canonical = reviewPlainTextIdentity(args.prompt).canonicalSha256;
        await args.onComposerVerified({ ok: true, textModel: REVIEW_PLAIN_TEXT_MODEL,
          replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL, sourceSha256: sha(args.prompt),
          canonicalPromptSha256: canonical, observedCanonicalSha256: canonical });
      }
      if (mode.presend) throw new Error('preflight_failed');
      await args.onSendAttempted();
      const persisted = await readReviewTransportState(stateDir);
      const op = Object.values(persisted.operations).find(o => o.sendAttempted);
      assert.deepEqual(op.baselineMessageIds, mode.baseline); // before a click
      if (mode.crash) throw new Error('crash_between_intent_and_observation');
      calls.clicks++;
      await args.onUserTurnObserved({ userMessageId: 'new-user', ...identity(args) });
      return { userMessageId: 'new-user', ...identity(args) };
    },
    async observeReviewUserTurn(args) {
      calls.recover++;
      assert.deepEqual(args.baselineMessageIds, mode.baseline);
      return { userMessageId: mode.recoveredId, ...identity(args) };
    },
    async observeReviewResponse(args) {
      calls.observe++;
      if (mode.waiting) return { status: 'SENT_WAITING' };
      const text = '完整回答\r\nexact bytes\n';
      return { text, userMessageId: mode.resultUser || args.userMessageId, assistantMessageId: 'assistant',
        conversationUrl: args.expectedUrl, conversationId: args.expectedConversationId,
        snapshots: [1000, 1000 + mode.snapshotGap].map(observedAt => ({ observedAt, assistantMessageId: 'assistant', textSha256: sha(text) })),
        controls: mode.controls };
    }
  };
  const tabs = { async ensureTab() { calls.tabs++; return 'tab'; }, async adoptTab() {}, getWindowById() { return { async show() {} }; }, getControllerById() { return controller; }, updateTabUrl() {} };
  return { stateDir, request, calls, mode, operation, controller, tabs,
    run: (overrides = {}) => runReviewQuery({ stateDir, tabs, request: { ...request, ...overrides } }) };
}

test('one exact send persists a baseline and immutable archive; duplicate is read-only', async t => {
  const f = await fixture(t); const first = await f.run(); const second = await f.run();
  assert.deepEqual(second, first); assert.equal(f.calls.clicks, 1);
  assert.equal(first.sendAttempted, true); assert.equal(first.providerUserMessageId, 'new-user');
  assert.equal(first.archive.sha256, sha(await fs.readFile(f.request.responsePath, 'utf8')));
});
test('same-key concurrent callers send once', async t => {
  const f = await fixture(t); await Promise.all([f.run(), f.run()]); assert.equal(f.calls.clicks, 1);
});
test('same conversation/prompt cannot be resent by changing keys, including concurrent intake', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.run(), f.run({ stableKey: 'replacement', idempotencyKey: 'replacement' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(String(results.find(r => r.status === 'rejected').reason), /review_duplicate_submission/);
  assert.equal(f.calls.clicks, 1);
});
test('pre-send failure remains repairable using the same operation', async t => {
  const f = await fixture(t); f.mode.presend = true; await assert.rejects(f.run(), /preflight_failed/);
  assert.equal((await f.operation()).sendAttempted, false);
  f.mode.presend = false; await f.run(); assert.equal(f.calls.clicks, 1);
});
test('missing composer verification cannot cross the send boundary', async t => {
  const f = await fixture(t); f.mode.skipComposer = true;
  await assert.rejects(f.run(), /review_operation_state_invalid/);
  assert.equal((await f.operation()).sendAttempted, false); assert.equal(f.calls.clicks, 0);
});
test('restart after intent preserves the baseline and never sends again', async t => {
  const f = await fixture(t); f.mode.crash = true; await assert.rejects(f.run(), /crash_between/);
  assert.deepEqual((await f.operation()).baselineMessageIds, ['old-user']);
  f.mode.crash = false; await f.run({ verifyExisting: true });
  assert.equal(f.calls.review, 1); assert.equal(f.calls.clicks, 0); assert.equal(f.calls.recover, 1);
});
test('intent without any new matching turn remains unknown without resending', async t => {
  const f = await fixture(t); f.mode.crash = true; await assert.rejects(f.run());
  f.mode.recoveredId = null; const receipt = await f.run({ verifyExisting: true });
  assert.equal(receipt.sendAttempted, true); assert.equal(receipt.providerUserMessageId, null);
  assert.equal(receipt.archive, null); assert.equal(f.calls.review, 1);
});
test('a historical ID cannot be adopted even if a controller returns it', async t => {
  const f = await fixture(t); f.mode.crash = true; await assert.rejects(f.run());
  f.mode.recoveredId = 'old-user'; await assert.rejects(f.run({ verifyExisting: true }), /review_operation_state_invalid/);
  assert.equal((await f.operation()).providerUserMessageId, null);
});
for (const baseline of [undefined, null]) test(`legacy unpaired receipt with ${baseline} baseline fails closed`, async t => {
  const f = await fixture(t); f.mode.crash = true; await assert.rejects(f.run());
  const state = await readReviewTransportState(f.stateDir);
  if (baseline === undefined) delete state.operations.question.baselineMessageIds;
  else state.operations.question.baselineMessageIds = baseline;
  await writeReviewTransportState(state, f.stateDir);
  await assert.rejects(f.run({ verifyExisting: true }), /review_submission_baseline_unavailable/);
  assert.equal(f.calls.recover, 0); assert.equal(f.calls.review, 1);
});
test('legacy already-paired receipt remains observable without a baseline', async t => {
  const f = await fixture(t); f.mode.waiting = true; await f.run();
  const state = await readReviewTransportState(f.stateDir); delete state.operations.question.baselineMessageIds;
  await writeReviewTransportState(state, f.stateDir); f.mode.waiting = false;
  assert.ok((await f.run({ verifyExisting: true })).archive); assert.equal(f.calls.review, 1);
});
for (const baseline of [['duplicate', 'duplicate'], [23], 'not-array']) test(`invalid persisted baseline rejected: ${JSON.stringify(baseline)}`, async t => {
  const f = await fixture(t); f.mode.waiting = true; await f.run();
  const state = await readReviewTransportState(f.stateDir); state.operations.question.baselineMessageIds = baseline;
  await assert.rejects(writeReviewTransportState(state, f.stateDir), /state_invalid/);
});
test('fresh verifyExisting cannot create a send', async t => {
  const f = await fixture(t); await assert.rejects(f.run({ verifyExisting: true }), /review_observation_unavailable/);
  assert.equal(f.calls.tabs, 0); assert.equal(f.calls.review, 0);
});
test('waiting receipts resume observation without another send', async t => {
  const f = await fixture(t); f.mode.waiting = true; assert.equal((await f.run()).archive, null);
  f.mode.waiting = false; assert.ok((await f.run({ verifyExisting: true })).archive); assert.equal(f.calls.clicks, 1);
});
test('first binding records the actual created conversation', async t => {
  const f = await fixture(t); const result = await f.run({ conversationUrl: 'https://chatgpt.com/', conversationId: '__new__', firstBinding: true });
  assert.equal(result.observedConversationId, 'created'); assert.ok(result.archive);
});
test('first binding rejects a user turn observed on the wrong provider before binding it', async t => {
  const f = await fixture(t);
  f.mode.identityOverride = { conversationUrl: 'https://gemini.google.com/app/wrong', conversationId: 'wrong' };
  await assert.rejects(
    f.run({ conversationUrl: 'https://chatgpt.com/', conversationId: '__new__', firstBinding: true }),
    /review_conversation_identity_mismatch/
  );
  const state = await readReviewTransportState(f.stateDir);
  assert.equal(state.bindings[f.request.stableKey], undefined);
  assert.equal(state.operations[f.request.idempotencyKey].providerUserMessageId, null);
});
test('Gemini uses explicit product and null effort through the same durable boundary', async t => {
  const f = await fixture(t); const result = await f.run({ provider: 'gemini', productModel: 'Gemini 3.1 Pro', reasoningEffort: null, conversationUrl: 'https://gemini.google.com/app/fixture', conversationId: 'fixture' });
  assert.ok(result.archive); assert.equal(f.calls.clicks, 1);
});
test('Gemini bootstrap records the selected model and permits one reserved continuation transition', async t => {
  const f = await fixture(t);
  f.mode.preparedProductModel = 'Gemini 2.5 Flash';
  await f.run({ provider: 'gemini', productModel: '__selected__', reasoningEffort: null,
    conversationUrl: 'https://gemini.google.com/app', conversationId: '__new__', firstBinding: true,
    geminiBootstrap: true, bootstrapNonScientific: true });
  let state = await readReviewTransportState(f.stateDir);
  assert.equal(state.bindings.question.productModel, 'Gemini 2.5 Flash');
  assert.deepEqual(state.bindings.question.geminiBootstrap, {
    nonScientific: true,
    bootstrapOperationId: state.operations.question.operationId,
    bootstrapProductModel: 'Gemini 2.5 Flash',
    continuationConsumed: false
  });

  const continuation = { provider: 'gemini', productModel: 'Gemini 3.1 Pro', reasoningEffort: null,
    conversationUrl: 'https://gemini.google.com/app/created', conversationId: 'created',
    idempotencyKey: 'question-continuation', prompt: 'continuation prompt', promptSha256: sha('continuation prompt'),
    responsePath: path.join(f.stateDir, 'continuation.md'), geminiBootstrapContinuation: true };
  await f.run(continuation);
  state = await readReviewTransportState(f.stateDir);
  assert.equal(state.bindings.question.productModel, 'Gemini 3.1 Pro');
  assert.equal(state.bindings.question.geminiBootstrap.continuationConsumed, true);
  assert.equal(state.bindings.question.geminiBootstrap.continuationOperationId, state.operations['question-continuation'].operationId);
  assert.equal(state.bindings.question.geminiBootstrap.continuationProductModel, 'Gemini 3.1 Pro');

  await assert.rejects(f.run({ ...continuation, idempotencyKey: 'question-continuation-2',
    prompt: 'second continuation', promptSha256: sha('second continuation'),
    responsePath: path.join(f.stateDir, 'continuation-2.md') }), /review_binding_mismatch/);
});
test('Gemini bootstrap recovery retains the selected model across a post-intent crash', async t => {
  const f = await fixture(t);
  f.mode.preparedProductModel = 'Gemini 2.5 Flash';
  f.mode.crash = true;
  const bootstrap = { provider: 'gemini', productModel: '__selected__', reasoningEffort: null,
    conversationUrl: 'https://gemini.google.com/app', conversationId: '__new__', firstBinding: true,
    geminiBootstrap: true, bootstrapNonScientific: true };
  await assert.rejects(f.run(bootstrap), /crash_between_intent_and_observation/);
  let state = await readReviewTransportState(f.stateDir);
  assert.equal(state.operations.question.preparedProductModel, 'Gemini 2.5 Flash');
  assert.equal(state.bindings.question, undefined);
  f.mode.crash = false;
  await f.run({ ...bootstrap, verifyExisting: true });
  state = await readReviewTransportState(f.stateDir);
  assert.equal(state.bindings.question.productModel, 'Gemini 2.5 Flash');
  assert.equal(f.calls.clicks, 0);
  assert.equal(f.calls.review, 1);
});
test('concurrent Gemini bootstrap continuations reserve exactly one transition', async t => {
  const f = await fixture(t);
  f.mode.preparedProductModel = 'Gemini 2.5 Flash';
  await f.run({ provider: 'gemini', productModel: '__selected__', reasoningEffort: null,
    conversationUrl: 'https://gemini.google.com/app', conversationId: '__new__', firstBinding: true,
    geminiBootstrap: true, bootstrapNonScientific: true });
  const continuation = (suffix) => ({ provider: 'gemini', productModel: 'Gemini 3.1 Pro', reasoningEffort: null,
    conversationUrl: 'https://gemini.google.com/app/created', conversationId: 'created',
    idempotencyKey: `continuation-${suffix}`, prompt: `continuation ${suffix}`,
    promptSha256: sha(`continuation ${suffix}`), responsePath: path.join(f.stateDir, `continuation-${suffix}.md`),
    geminiBootstrapContinuation: true });
  const results = await Promise.allSettled([f.run(continuation('a')), f.run(continuation('b'))]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(String(results.find((result) => result.status === 'rejected').reason), /review_binding_mismatch/);
  const state = await readReviewTransportState(f.stateDir);
  const continuationOperationIds = Object.entries(state.operations)
    .filter(([key]) => key !== 'question')
    .map(([, operation]) => operation.operationId);
  assert.equal(continuationOperationIds.length, 1);
  assert.ok(continuationOperationIds.includes(state.bindings.question.geminiBootstrap.continuationOperationId));
  assert.equal(state.bindings.question.geminiBootstrap.continuationConsumed, true);
  assert.equal(f.calls.clicks, 2); // bootstrap plus exactly one continuation
});
test('a stale unsent Gemini operation cannot cross a completed model transition', async t => {
  const f = await fixture(t);
  f.mode.preparedProductModel = 'Gemini 2.5 Flash';
  await f.run({ provider: 'gemini', productModel: '__selected__', reasoningEffort: null,
    conversationUrl: 'https://gemini.google.com/app', conversationId: '__new__', firstBinding: true,
    geminiBootstrap: true, bootstrapNonScientific: true });
  const stale = { provider: 'gemini', productModel: 'Gemini 2.5 Flash', reasoningEffort: null,
    conversationUrl: 'https://gemini.google.com/app/created', conversationId: 'created',
    idempotencyKey: 'stale-flash', prompt: 'stale flash prompt', promptSha256: sha('stale flash prompt'),
    responsePath: path.join(f.stateDir, 'stale-flash.md') };
  f.mode.presend = true;
  await assert.rejects(f.run(stale), /preflight_failed/);
  f.mode.presend = false;
  await f.run({ provider: 'gemini', productModel: 'Gemini 3.1 Pro', reasoningEffort: null,
    conversationUrl: 'https://gemini.google.com/app/created', conversationId: 'created',
    idempotencyKey: 'transition-pro', prompt: 'transition pro prompt', promptSha256: sha('transition pro prompt'),
    responsePath: path.join(f.stateDir, 'transition-pro.md'), geminiBootstrapContinuation: true });
  const reviewsBeforeRetry = f.calls.review;
  const clicksBeforeRetry = f.calls.clicks;
  await assert.rejects(f.run(stale), /review_binding_mismatch/);
  assert.equal(f.calls.review, reviewsBeforeRetry);
  assert.equal(f.calls.clicks, clicksBeforeRetry);
});
test('existing-tab adoption uses the exact assigned key and identity', async t => {
  const f = await fixture(t); const adopted = [];
  f.tabs.adoptTab = async args => adopted.push(args);
  await f.run({ existingTabId: 'assigned-tab' });
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].id, 'assigned-tab');
  assert.equal(adopted[0].key, f.request.stableKey);
  assert.equal(adopted[0].url, f.request.conversationUrl);
});
test('stable key cannot be rebound to another conversation before tab adoption', async t => {
  const f = await fixture(t); await f.run(); const before = f.calls.tabs;
  await assert.rejects(f.run({ idempotencyKey: 'other', conversationUrl: 'https://chatgpt.com/c/other', conversationId: 'other' }), /review_binding_mismatch/);
  assert.equal(f.calls.tabs, before); assert.equal(f.calls.clicks, 1);
});
test('first-bound submitted prompt cannot be repeated under a new key at its observed URL', async t => {
  const f = await fixture(t);
  await f.run({ conversationUrl: 'https://chatgpt.com/', conversationId: '__new__', firstBinding: true });
  await assert.rejects(f.run({ stableKey: 'new-key', idempotencyKey: 'new-key', conversationUrl: 'https://chatgpt.com/c/created', conversationId: 'created' }), /review_duplicate_submission/);
  assert.equal(f.calls.clicks, 1);
});
for (const changes of [{ responsePath: path.resolve('different.md') }, { prompt: 'changed', promptSha256: sha('changed') }, { productModel: 'Latest' }]) test(`same-key immutable inputs cannot change: ${Object.keys(changes)}`, async t => {
  const f = await fixture(t); await f.run(); await assert.rejects(f.run(changes), /review_idempotency_conflict/); assert.equal(f.calls.clicks, 1);
});
for (const changes of [{ promptSha256: '0'.repeat(64) }, { timeoutMs: 2700001 }, { productModel: 'GPT-5.6 Sol' }, { reasoningEffort: 'High' }, { model: 'retired-field' }]) test(`invalid input rejected before tab resolution: ${Object.keys(changes)}`, async t => {
  const f = await fixture(t); await assert.rejects(f.run(changes)); assert.equal(f.calls.tabs, 0); assert.equal(f.calls.review, 0);
});
for (const control of ['stop', 'continue', 'retry']) test(`active ${control} prevents completion and can only be observed later`, async t => {
  const f = await fixture(t); f.mode.controls = { [control]: true }; await assert.rejects(f.run(), /review_completion_controls_active/);
  f.mode.controls = {}; await f.run(); assert.equal(f.calls.clicks, 1);
});
test('unstable snapshots and wrong user pairing cannot archive an answer', async t => {
  const f = await fixture(t); f.mode.snapshotGap = 10; await assert.rejects(f.run(), /review_completion_unstable/);
  f.mode.snapshotGap = 3100; f.mode.resultUser = 'wrong-user'; await assert.rejects(f.run(), /review_user_message_identity_mismatch/);
  assert.equal((await f.operation()).archive, null); assert.equal(f.calls.clicks, 1);
});
test('exact response archive preserves conflicts, including a terminal newline difference', async t => {
  const f = await fixture(t); await fs.writeFile(f.request.responsePath, 'answer\n');
  await assert.rejects(archiveReviewResponse({ responsePath: f.request.responsePath, text: 'answer' }), /review_response_path_conflict/);
  assert.equal(await fs.readFile(f.request.responsePath, 'utf8'), 'answer\n');
  assert.equal((await archiveReviewResponse({ responsePath: f.request.responsePath, text: 'answer\n' })).projection, 'exact');
});
test('prompt input preserves UTF-8 and rejects conflicting input/hash before send', async t => {
  const f = await fixture(t); const promptPath = path.join(f.stateDir, 'prompt.txt'); await fs.writeFile(promptPath, f.request.prompt);
  assert.equal(await resolveReviewPromptInput({ promptPath }), f.request.prompt);
  assert.equal(await prepareReviewPromptInput({ promptPath, promptSha256: f.request.promptSha256 }), f.request.prompt);
  await assert.rejects(resolveReviewPromptInput({ promptPath, prompt: 'also inline' }));
  await assert.rejects(prepareReviewPromptInput({ promptPath, promptSha256: '0'.repeat(64) }));
});

function pageController(messages, url = 'https://chatgpt.com/c/fixture') {
  return new ChatGPTController({ selectors: {}, page: { async getUrl() { return url; }, async evaluate() { return { messages, modelEvidence: 'GPT-6 Astra', modelEvidenceCandidates: ['GPT-6 Astra'], controlText: [], selectorStop: false, sendVisible: true }; } } });
}
const observerArgs = { prompt: 'same text', expectedUrl: 'https://chatgpt.com/c/fixture', expectedConversationId: 'fixture', productModel: 'GPT-6 Astra', reasoningEffort: 'Pro', timeoutMs: 1000 };
const turn = id => ({ id, role: 'user', text: 'same text', textIdentityReadable: true });
test('real controller refuses missing baseline and excludes old identical text', async () => {
  const controller = pageController([turn('old')]);
  await assert.rejects(controller.observeReviewUserTurn(observerArgs), /review_submission_baseline_unavailable/);
  assert.equal((await controller.observeReviewUserTurn({ ...observerArgs, baselineMessageIds: ['old'] })).userMessageId, null);
});
test('real controller admits only one new matching turn', async () => {
  const controller = pageController([turn('old'), turn('new')]);
  assert.equal((await controller.observeReviewUserTurn({ ...observerArgs, baselineMessageIds: ['old'] })).userMessageId, 'new');
  await assert.rejects(controller.observeReviewUserTurn({ ...observerArgs, baselineMessageIds: [] }), /review_user_message_identity_ambiguous/);
});
test('real controller first-binding recovery rejects a wrong provider snapshot', async () => {
  const controller = pageController([turn('new')], 'https://gemini.google.com/app/wrong');
  await assert.rejects(controller.observeReviewUserTurn({ ...observerArgs,
    expectedUrl: 'https://chatgpt.com/', expectedConversationId: '__new__', firstBinding: true,
    baselineMessageIds: [], timeoutMs: 10 }), /review_conversation_identity_mismatch/);
});
