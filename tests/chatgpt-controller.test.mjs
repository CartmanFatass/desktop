import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  ChatGPTController,
  canonicalizeGeminiReviewMessageNodes,
  canonicalizeGeminiModelEvidence,
  classifyBlockedSignals,
  classifyReviewControls,
  deduplicateReviewModelEvidence,
  looksLikeBlockedPage,
  geminiMenuItemSelected,
  geminiMenuItemSemanticLabel,
  modelLabelMatches,
  serializeReviewComposer,
  serializeReviewUserMessage,
  summarizeReviewComposerStructure
} from '../chatgpt-controller.mjs';
import {
  REVIEW_CAUSAL_SUBMISSION_MODEL,
  REVIEW_PLAIN_TEXT_MODEL,
  compareReviewPlainText,
  reviewBaselineMessageIdsSha256,
  reviewPlainTextIdentity,
  safeReviewPlainTextComparison
} from '../review-text-identity.mjs';
import { REVIEW_COMPOSER_REPLACEMENT_MODEL } from '../review-composer-replacement.mjs';

const textNode = (value) => ({ nodeType: 3, nodeValue: value });
const elementNode = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes });
const causalReceipt = (prompt, baselineMessageIds = [], operationId = 'test-operation') => ({
  ok: true,
  persisted: true,
  identityModel: REVIEW_CAUSAL_SUBMISSION_MODEL,
  operationId,
  sendActionCount: 1,
  clickCount: 1,
  sourceSha256: reviewPlainTextIdentity(prompt).sourceSha256,
  canonicalPromptSha256: reviewPlainTextIdentity(prompt).canonicalSha256,
  baselineMessageIdsSha256: reviewBaselineMessageIdsSha256(baselineMessageIds)
});

function strictComposerEvaluateFixture({ prompt, existingDraft = '', failEmpty = false, failCaret = false } = {}) {
  let current = String(existingDraft);
  let emptyReads = 0;
  return {
    evaluate(js) {
      if (js.includes('reviewComposerClearMarker')) {
        const initialSerializedLength = current.length;
        return {
          ok: true,
          replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
          composerKind: 'contenteditable',
          clearMethod: initialSerializedLength ? 'verified_selection_backspace' : 'already_empty',
          selectionVerified: true,
          deleteKeyRequired: initialSerializedLength > 0,
          initialSerializerOk: true,
          initialSerializedLength,
          inputEventDispatched: true,
          promptInsertCount: 0,
          candidateCount: 1
        };
      }
      if (js.includes('reviewComposerEmptyMarker')) {
        emptyReads += 1;
        if (failEmpty && emptyReads === 2) current = existingDraft || 'rehydrated';
        return {
          ok: current === '',
          replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
          composerKind: 'contenteditable',
          serializerOk: true,
          serializerMethod: 'contenteditable_structural',
          serializerError: current === '' ? null : 'review_composer_not_empty',
          serializedLength: current.length,
          candidateCount: 1
        };
      }
      if (js.includes('reviewComposerCaretMarker')) {
        return failCaret
          ? {
              ok: false,
              error: 'review_composer_selection_failed',
              replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
              composerKind: 'contenteditable',
              serializedLength: 0,
              candidateCount: 1
            }
          : {
              ok: true,
              replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
              composerKind: 'contenteditable',
              caretMethod: 'contenteditable_collapsed_range',
              serializedLength: 0,
              candidateCount: 1
            };
      }
      if (js.includes('reviewComposerDiagnosticMarker')) {
        return {
          ok: current === prompt,
          serializerOk: true,
          serializerMethod: 'contenteditable_structural',
          serializedLength: current.length,
          expectedLength: prompt.length,
          textModel: REVIEW_PLAIN_TEXT_MODEL,
          identityMode: 'canonical_exact',
          sourceSha256: reviewPlainTextIdentity(prompt).sourceSha256,
          canonicalPromptSha256: reviewPlainTextIdentity(prompt).canonicalSha256,
          observedCanonicalSha256: reviewPlainTextIdentity(current).canonicalSha256
        };
      }
      return null;
    },
    deleteSelection() { current = ''; },
    insert(text) { current += text; },
    replace(text) { current = String(text); },
    get current() { return current; }
  };
}

function legacyStrictComposerEval(js) {
  if (js.includes('reviewComposerClearMarker')) return {
    ok: true,
    replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
    composerKind: 'contenteditable',
    clearMethod: 'already_empty',
    selectionVerified: true,
    deleteKeyRequired: false,
    initialSerializerOk: true,
    initialSerializedLength: 0,
    promptInsertCount: 0,
    candidateCount: 1
  };
  if (js.includes('reviewComposerEmptyMarker')) return {
    ok: true,
    replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
    composerKind: 'contenteditable',
    serializerOk: true,
    serializerMethod: 'contenteditable_structural',
    serializedLength: 0,
    candidateCount: 1
  };
  if (js.includes('reviewComposerCaretMarker')) return {
    ok: true,
    replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
    composerKind: 'contenteditable',
    caretMethod: 'contenteditable_collapsed_range',
    serializedLength: 0,
    candidateCount: 1
  };
  return null;
}

test('chatgpt-controller: Gemini nested selectors canonicalize to one node per turn and role', () => {
  const turn = (id) => ({ getAttribute: (name) => name === 'data-turn-id' ? id : null });
  const node = ({ role, id, parent = null }) => ({
    id: '',
    matches: () => role === 'user',
    closest: () => turn(id),
    contains: (other) => other === parent
  });
  const userNested = node({ role: 'user', id: 'turn-user' });
  const userHost = node({ role: 'user', id: 'turn-user', parent: userNested });
  const assistantNested = node({ role: 'assistant', id: 'turn-assistant' });
  const assistantHost = node({ role: 'assistant', id: 'turn-assistant', parent: assistantNested });
  const result = canonicalizeGeminiReviewMessageNodes(
    [userHost, userNested, assistantHost, assistantNested],
    'user-query'
  );
  assert.deepEqual(result.map(({ role, identity }) => [role, identity]), [
    ['user', 'turn-user'],
    ['assistant', 'turn-assistant']
  ]);
});

test('chatgpt-controller: ordinary verify wording is not an access block', () => {
  assert.equal(looksLikeBlockedPage('Please verify the estimator before reporting. Prompt visible.'), false);
  assert.equal(looksLikeBlockedPage('403 Forbidden'), true);
  assert.equal(looksLikeBlockedPage('Access denied'), true);
  assert.equal(looksLikeBlockedPage('Forbidden'), false);
  assert.equal(looksLikeBlockedPage('The estimator returned 403 samples'), false);
  assert.equal(looksLikeBlockedPage('Unusual traffic'), true);
  assert.equal(looksLikeBlockedPage('Verify you are human'), true);
  assert.equal(looksLikeBlockedPage('Human verification'), true);
});

test('chatgpt-controller: access-error wording does not block a usable composer', () => {
  assert.deepEqual(classifyBlockedSignals({ looks403: true, promptVisible: true }), {
    blocked: false,
    kind: null,
    accessBlocked: false
  });
  assert.deepEqual(classifyBlockedSignals({ looks403: true, promptVisible: false }), {
    blocked: true,
    kind: 'blocked',
    accessBlocked: true
  });
});

test('chatgpt-controller: Gemini canonical model evidence requires two visible scoped selected controls', () => {
  const expected = 'Gemini 3.1 Pro extended';
  const valid = canonicalizeGeminiModelEvidence([
    { label: '3.1 Pro', visible: true, scoped: true, selected: true, source: 'menu' },
    { label: '扩展思考', visible: true, scoped: true, selected: true, source: 'menu' }
  ], expected);
  assert.equal(valid.matched, true);
  assert.equal(valid.matchedLabel, expected);
  assert.equal(valid.modelLabel, '3.1 Pro');
  assert.equal(valid.thinkingMode, 'Extended thinking');

  for (const invalid of [
    [
      { label: '3.1 Pro', visible: false, scoped: true, selected: true, source: 'menu' },
      { label: 'Extended thinking', visible: false, scoped: true, selected: true, source: 'menu' }
    ],
    [
      { label: '3.1 Pro', visible: true, scoped: false, selected: true, source: 'menu' },
      { label: 'Extended thinking', visible: true, scoped: false, selected: true, source: 'menu' }
    ],
    [
      { label: 'Pro', visible: true, scoped: true, selected: true, source: 'menu' },
      { label: 'Extended thinking', visible: true, scoped: true, selected: true, source: 'menu' }
    ],
    [
      { label: '3.1 Pro', visible: true, scoped: true, selected: false, dataActive: true, source: 'menu' },
      { label: 'Extended thinking', visible: true, scoped: true, selected: false, dataActive: true, source: 'menu' }
    ],
    [{ label: expected, visible: true, scoped: true, selected: true, source: 'trigger' }]
  ]) {
    assert.equal(canonicalizeGeminiModelEvidence(invalid, expected).matched, false);
  }
});

test('chatgpt-controller: Gemini menu evidence uses the visible semantic label and not description or focus state', () => {
  const labelNode = (textContent, isVisible = true) => ({ textContent, isVisible });
  const menuItem = ({
    textContent = '',
    className = '',
    dataActive = null,
    ariaLabel = null,
    semanticLabels = [],
    descendantAriaLabels = []
  } = {}) => ({
    textContent,
    className,
    getAttribute(name) {
      if (name === 'data-active') return dataActive;
      if (name === 'aria-label') return ariaLabel;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.label') return semanticLabels;
      if (selector === '[aria-label]') {
        return descendantAriaLabels.map((value) => ({ getAttribute: () => value }));
      }
      return [];
    }
  });
  const visible = (node) => node.isVisible !== false;
  const selectedModel = menuItem({
    textContent: '3.1 Pro 高阶数学与代码',
    className: 'selected ng-star-inserted',
    semanticLabels: [labelNode('3.1 Pro')]
  });
  const focusedFlash = menuItem({
    textContent: '3.5 Flash-Lite 极速回答 新',
    className: 'active',
    dataActive: 'true',
    semanticLabels: [labelNode('3.5 Flash-Lite')]
  });
  assert.equal(geminiMenuItemSemanticLabel(selectedModel, visible), '3.1 Pro');
  assert.equal(geminiMenuItemSelected(selectedModel), true);
  assert.equal(geminiMenuItemSelected(focusedFlash), false);
  assert.equal(geminiMenuItemSemanticLabel(menuItem({
    semanticLabels: [labelNode('3.1 Pro'), labelNode('spoof')]
  }), visible), null);
  assert.equal(geminiMenuItemSemanticLabel(menuItem({
    ariaLabel: '3.1 Pro',
    semanticLabels: [labelNode('hidden', false)]
  }), visible), '3.1 Pro');
  assert.equal(geminiMenuItemSelected(menuItem({ descendantAriaLabels: ['已选中'] })), true);
  assert.equal(canonicalizeGeminiModelEvidence([
    { label: selectedModel.textContent, visible: true, scoped: true, selected: true, source: 'menu' },
    { label: '扩展思考 擅长解决复杂问题', visible: true, scoped: true, selected: true, source: 'menu' }
  ], 'Gemini 3.1 Pro extended').matched, false);
});

test('chatgpt-controller: structural composer serialization preserves exact multiline plain text', () => {
  const composer = elementNode(
    'DIV',
    elementNode('P', textNode('alpha'), elementNode('SPAN', textNode(' beta'))),
    elementNode('P', elementNode('BR')),
    elementNode('P', textNode('gamma'), elementNode('BR'), textNode('delta'))
  );
  assert.deepEqual(serializeReviewComposer(composer), {
    ok: true,
    text: 'alpha beta\n\ngamma\ndelta'
  });
});

test('chatgpt-controller: review plain-text model recovers only reversible browser line endings and space rebalance', () => {
  const source = [
    '# Synthetic 7024-shape fixture',
    '',
    '- list item',
    '1. ordered item',
    '  nested two-space item',
    '   nested three-space item',
    '',
    '```text',
    'combining=e\u0301 astral=\u{1f680} zero=\u200b',
    '```',
    ''
  ].join('\r\n');
  const browser = source
    .replace(/\r\n/g, '\n')
    .replace('  nested', '\u00a0 nested')
    .replace('   nested', '\u00a0  nested');
  const result = compareReviewPlainText(source, browser);
  assert.equal(result.ok, true);
  assert.equal(result.identityMode, 'browser_space_rebalanced');
  assert.equal(result.browserSpaceRebalanceCount, 2);
  assert.equal(result.lineEndingCanonicalized, true);
  const identity = reviewPlainTextIdentity(source);
  assert.equal(identity.textModel, REVIEW_PLAIN_TEXT_MODEL);
  assert.notEqual(identity.sourceSha256, identity.canonicalSha256);
  assert.equal(safeReviewPlainTextComparison(source, browser).observedCanonicalSha256, identity.canonicalSha256);
});

test('chatgpt-controller: review plain-text model preserves meaningful Unicode and whitespace distinctions', () => {
  const exactPairs = [
    ['line\r\n\r\nnext', 'line\n\nnext'],
    ['```text\r\ncode\r\n```\r\n', '```text\ncode\n```\n'],
    ['e\u0301 \u{1f680} \u200b', 'e\u0301 \u{1f680} \u200b']
  ];
  for (const [source, browser] of exactPairs) assert.equal(compareReviewPlainText(source, browser).ok, true);
  for (const [source, corrupted] of [
    ['e\u0301', '\u00e9'],
    ['\u{1f680}', '\u{1f681}'],
    ['a\u200bb', 'ab'],
    ['a b', 'a\u00a0b'],
    ['  ', '\u00a0 '],
    ['a\u00a0b', 'a b'],
    ['a  b', 'a b '],
    ['a\n\nb', 'a\nb\n']
  ]) {
    const result = compareReviewPlainText(source, corrupted);
    assert.equal(result.ok, false, `${JSON.stringify(source)} must differ from ${JSON.stringify(corrupted)}`);
    assert.ok(result.mismatchClass);
  }
});

test('chatgpt-controller: 7024-character structural fixture remains collision-resistant without science content', () => {
  const skeleton = [
    '# Synthetic revision', '', '## Audit', '', '- item', '', '1. first',
    '  branch', '   subbranch', '', '```text', 'x=1', '```', ''
  ].join('\n');
  const pad = 'x'.repeat(7024 - skeleton.length);
  const source = `${skeleton}${pad}`;
  assert.equal(source.length, 7024);
  const browser = source.replace('  branch', '\u00a0 branch').replace('   subbranch', '\u00a0  subbranch');
  const accepted = safeReviewPlainTextComparison(source, browser);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.canonicalPromptSha256, accepted.observedCanonicalSha256);
  const corrupted = `${browser.slice(0, -1)}y`;
  const rejected = safeReviewPlainTextComparison(source, corrupted);
  assert.equal(rejected.ok, false);
  assert.notEqual(rejected.canonicalPromptSha256, rejected.observedCanonicalSha256);
});

test('chatgpt-controller: content-rebind receipt accepts browser space rebalance only under the same canonical hash', () => {
  const expected = '  branch\n   nested\n';
  const rendered = '\u00a0 branch\n\u00a0  nested\n';
  const receipt = safeReviewPlainTextComparison(expected, rendered);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.identityMode, 'browser_space_rebalanced');
  assert.equal(receipt.canonicalPromptSha256, receipt.observedCanonicalSha256);

  const corrupted = safeReviewPlainTextComparison(expected, `${rendered.slice(0, -2)}x\n`);
  assert.equal(corrupted.ok, false);
  assert.notEqual(corrupted.canonicalPromptSha256, corrupted.observedCanonicalSha256);
});

test('chatgpt-controller: fenced-block shape preserves blank lines and one trailing LF', () => {
  const prompt = [
    '# Synthetic compatibility fixture',
    '',
    '```text',
    'block=one',
    '```',
    '',
    '```text',
    'block=two',
    '```',
    ''
  ].join('\n');
  const composer = elementNode(
    'DIV',
    ...prompt.split('\n').map((line) =>
      elementNode('P', line ? textNode(line) : elementNode('BR'))
    )
  );
  assert.equal(serializeReviewComposer(composer).text, prompt);
  assert.equal(prompt.endsWith('\n'), true);
});

test('chatgpt-controller: structural composer serialization rejects unsupported or altered content', () => {
  const unsupported = elementNode('DIV', elementNode('IMG'));
  assert.deepEqual(serializeReviewComposer(unsupported), {
    ok: false,
    error: 'review_composer_element_unsupported',
    tag: 'IMG'
  });

  const altered = elementNode('DIV', elementNode('P', textNode('exact')), textNode('!'));
  assert.notEqual(serializeReviewComposer(altered).text, 'exact');

  assert.deepEqual(serializeReviewComposer(elementNode('BUTTON', textNode('exact'))), {
    ok: false,
    error: 'review_composer_element_unsupported',
    tag: 'BUTTON'
  });
});

test('chatgpt-controller: composer structure summary exposes no text content', () => {
  const composer = elementNode(
    'DIV',
    elementNode('P', textNode('secret-before')),
    elementNode('PRE', elementNode('CODE', textNode('secret-fence'))),
    elementNode('P', elementNode('BR'))
  );
  assert.deepEqual(summarizeReviewComposerStructure(composer), {
    rootTag: 'DIV',
    elementCount: 6,
    textNodeCount: 2,
    otherNodeCount: 0,
    maxDepth: 3,
    tagHistogram: { BR: 1, CODE: 1, DIV: 1, P: 2, PRE: 1 }
  });
  assert.equal(JSON.stringify(summarizeReviewComposerStructure(composer)).includes('secret'), false);
});

test('chatgpt-controller: composer diagnosis is observe-only and returns metadata only', async () => {
  let evaluateCalls = 0;
  let actionCalls = 0;
  const page = {
    async evaluate(js) {
      evaluateCalls += 1;
      assert.equal(js.includes('reviewComposerDiagnosticMarker'), true);
      return {
        ok: false,
        candidateCount: 1,
        serializerOk: false,
        serializerMethod: 'contenteditable_structural',
        serializerError: 'review_composer_element_unsupported',
        serializerTag: 'PRE',
        serializedLength: 0,
        observedLengths: [22, 20],
        expectedLength: 21,
        rootTag: 'DIV',
        elementCount: 6,
        textNodeCount: 2,
        otherNodeCount: 0,
        maxDepth: 3,
        tagHistogram: { BR: 1, CODE: 1, DIV: 1, P: 2, PRE: 1 }
      };
    },
    async sendKey() { actionCalls += 1; },
    async insertText() { actionCalls += 1; },
    async moveMouse() { actionCalls += 1; },
    async mouseDown() { actionCalls += 1; },
    async mouseUp() { actionCalls += 1; }
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt-textarea' } });
  const result = await controller.inspectReviewComposerIdentity({ expectedPrompt: 'not returned' });
  assert.equal(result.serializerTag, 'PRE');
  assert.equal(JSON.stringify(result).includes('not returned'), false);
  assert.equal(evaluateCalls, 1);
  assert.equal(actionCalls, 0);
});

test('chatgpt-controller: composer mismatch diagnostics identify the first code-point class without content', async () => {
  const expectedPrompt = '  synthetic\u200b';
  const observedPrompt = '\u00a0 syntheticx';
  const page = {
    async evaluate(js) {
      const document = {
        querySelectorAll() { return [element]; }
      };
      const crypto = globalThis.crypto;
      const TextEncoder = globalThis.TextEncoder;
      const element = {
        nodeType: 1,
        tagName: 'DIV',
        childNodes: [textNode(observedPrompt)],
        isContentEditable: true,
        innerText: observedPrompt,
        textContent: observedPrompt,
        matches() { return false; },
        getAttribute(name) { return name === 'contenteditable' ? 'true' : null; },
        getBoundingClientRect() { return { width: 500, height: 60, y: 600 }; }
      };
      const window = { getComputedStyle() { return { visibility: 'visible', display: 'block' }; } };
      return await Function('document', 'window', 'crypto', 'TextEncoder', `return ${js}`)(document, window, crypto, TextEncoder);
    }
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt' } });
  const result = await controller.inspectReviewComposerIdentity({ expectedPrompt });
  assert.equal(result.ok, false);
  assert.equal(result.browserSpaceRebalanceCount, 1);
  assert.equal(result.mismatchClass, 'non_reversible_code_point_mismatch');
  assert.equal(result.firstMismatchExpectedCodePoint, 'U+200B');
  assert.equal(result.firstMismatchObservedCodePoint, 'U+0078');
  assert.notEqual(result.canonicalPromptSha256, result.observedCanonicalSha256);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});

test('chatgpt-controller: strict persisted draft is cleared, verified empty twice, then inserted exactly once', async () => {
  const skeleton = '# Synthetic revision\n\n- item\n\n1. first\n  branch\n```text\nx=1\n```\n';
  const prompt = `${skeleton}${'x'.repeat(7024 - skeleton.length)}`;
  assert.equal(prompt.length, 7024);
  const composer = strictComposerEvaluateFixture({ prompt, existingDraft: prompt });
  let inserted = 0;
  let deleteKeys = 0;
  let clicked = 0;
  const page = {
    async getUrl() { return 'https://chatgpt.com/c/draft-replace'; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const composerResult = composer.evaluate(js);
      if (composerResult) return composerResult;
      if (js.includes('reviewSendOnceMarker')) {
        clicked += 1;
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: clicked ? [
            { order: 0, role: 'user', id: 'draft-history', text: 'history', textIdentityReadable: true },
            { order: 1, role: 'user', id: 'draft-user', text: prompt, textIdentityReadable: true },
            { order: 2, role: 'assistant', id: 'draft-assistant', text: 'DONE' }
          ] : [{ order: 0, role: 'user', id: 'draft-history', text: 'history', textIdentityReadable: true }],
          modelEvidence: 'GPT-5.6 Pro', modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [], selectorStop: false, sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText(text) { inserted += 1; composer.insert(text); },
    async sendKey(key) {
      if (key === 'Backspace') { deleteKeys += 1; composer.deleteSelection(); }
    }, async moveMouse() {}, async mouseDown() {}, async mouseUp() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' }
  });
  let composerReceipt = null;
  const result = await controller.reviewQuery({
    prompt,
    expectedUrl: 'https://chatgpt.com/c/draft-replace',
    expectedConversationId: 'draft-replace',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 8_000,
    onComposerVerified: async (receipt) => { composerReceipt = receipt; }
  });
  assert.equal(inserted, 1);
  assert.equal(deleteKeys, 1);
  assert.equal(clicked, 1);
  assert.equal(composer.current, prompt);
  assert.equal(composerReceipt.initialSerializedLength, prompt.length);
  assert.equal(composerReceipt.clearMethod, 'verified_selection_backspace');
  assert.equal(composerReceipt.selectionVerified, true);
  assert.equal(composerReceipt.deleteKeyCount, 1);
  assert.equal(composerReceipt.emptyVerified, true);
  assert.equal(composerReceipt.emptySnapshotCount, 2);
  assert.equal(composerReceipt.promptInsertCount, 1);
  assert.equal(result.text, 'DONE');
});

test('chatgpt-controller: asynchronously rehydrated draft fails before prompt insertion or Send', async () => {
  const prompt = 'frozen prompt';
  const composer = strictComposerEvaluateFixture({ prompt, existingDraft: prompt, failEmpty: true });
  let inserted = 0;
  let clicked = 0;
  const page = {
    async getUrl() { return 'https://chatgpt.com/c/draft-rehydrate'; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const composerResult = composer.evaluate(js);
      if (composerResult) return composerResult;
      if (js.includes('reviewSendOnceMarker')) { clicked += 1; return { ok: true, clickCount: 1 }; }
      if (js.includes('reviewSnapshotMarker')) return {
        messages: [{ order: 0, role: 'user', id: 'draft-rehydrate-history', text: 'history', textIdentityReadable: true }], modelEvidence: 'GPT-5.6 Pro', modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [], selectorStop: false, sendVisible: true
      };
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText() { inserted += 1; },
    async sendKey(key) { if (key === 'Backspace') composer.deleteSelection(); },
    async moveMouse() {}, async mouseDown() {}, async mouseUp() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' }
  });
  await assert.rejects(
    controller.reviewQuery({
      prompt,
      expectedUrl: 'https://chatgpt.com/c/draft-rehydrate',
      expectedConversationId: 'draft-rehydrate',
      expectedModel: 'GPT-5.6 Pro', timeoutMs: 8_000
    }),
    (error) => {
      assert.equal(error.message, 'review_composer_clear_failed');
      assert.equal(error.data.noClickProven, true);
      assert.equal(error.data.promptInsertCount, 0);
      assert.equal(error.data.serializedLength, prompt.length);
      return true;
    }
  );
  assert.equal(inserted, 0);
  assert.equal(clicked, 0);
});

test('chatgpt-controller: failed contenteditable caret binding fails before prompt insertion or Send', async () => {
  const prompt = 'frozen prompt';
  const composer = strictComposerEvaluateFixture({ prompt, existingDraft: prompt, failCaret: true });
  let inserted = 0;
  let clicked = 0;
  const page = {
    async getUrl() { return 'https://chatgpt.com/c/caret-fail'; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const composerResult = composer.evaluate(js);
      if (composerResult) return composerResult;
      if (js.includes('reviewSendOnceMarker')) { clicked += 1; return { ok: true, clickCount: 1 }; }
      if (js.includes('reviewSnapshotMarker')) return {
        messages: [{ order: 0, role: 'user', id: 'caret-fail-history', text: 'history', textIdentityReadable: true }], modelEvidence: 'GPT-5.6 Pro', modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [], selectorStop: false, sendVisible: true
      };
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText() { inserted += 1; },
    async sendKey(key) { if (key === 'Backspace') composer.deleteSelection(); },
    async moveMouse() {}, async mouseDown() {}, async mouseUp() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' }
  });
  await assert.rejects(
    controller.reviewQuery({
      prompt,
      expectedUrl: 'https://chatgpt.com/c/caret-fail',
      expectedConversationId: 'caret-fail',
      expectedModel: 'GPT-5.6 Pro', timeoutMs: 8_000
    }),
    (error) => {
      assert.equal(error.message, 'review_composer_caret_unavailable');
      assert.equal(error.data.noClickProven, true);
      assert.equal(error.data.promptInsertCount, 0);
      return true;
    }
  );
  assert.equal(inserted, 0);
  assert.equal(clicked, 0);
});

test('chatgpt-controller: click-time composer mutation is rejected atomically with zero click', async () => {
  const prompt = 'frozen prompt';
  const composer = strictComposerEvaluateFixture({ prompt, existingDraft: '' });
  let clicked = 0;
  const page = {
    async getUrl() { return 'https://chatgpt.com/c/click-time-mutation'; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const composerResult = composer.evaluate(js);
      if (composerResult) return composerResult;
      if (js.includes('reviewSendOnceMarker')) {
        assert.equal(js.includes('compareReviewPlainText'), true);
        if (composer.current !== prompt) return {
          ok: false,
          error: 'review_composer_identity_mismatch_at_send',
          noClickProven: true,
          serializedLength: composer.current.length,
          expectedLength: prompt.length,
          textModel: REVIEW_PLAIN_TEXT_MODEL,
          identityMode: 'mismatch',
          mismatchClass: 'code_point_length_mismatch'
        };
        clicked += 1;
        return { ok: true, clickCount: 1 };
      }
      if (js.includes('reviewSnapshotMarker')) return {
        messages: [{ order: 0, role: 'user', id: 'click-time-history', text: 'history', textIdentityReadable: true }], modelEvidence: 'GPT-5.6 Pro', modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [], selectorStop: false, sendVisible: true
      };
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText(text) { composer.insert(text); },
    async sendKey() {}, async moveMouse() {}, async mouseDown() {}, async mouseUp() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' }
  });
  await assert.rejects(
    controller.reviewQuery({
      prompt,
      expectedUrl: 'https://chatgpt.com/c/click-time-mutation',
      expectedConversationId: 'click-time-mutation', expectedModel: 'GPT-5.6 Pro', timeoutMs: 8_000,
      onComposerVerified: async () => { composer.replace(`${prompt}${prompt}`); }
    }),
    (error) => {
      assert.equal(error.message, 'review_composer_identity_mismatch_at_send');
      assert.equal(error.data.noClickProven, true);
      return true;
    }
  );
  assert.equal(clicked, 0);
});

test('chatgpt-controller: click-time reversible NBSP receipt performs exactly one click', async () => {
  const prompt = '  frozen prompt';
  const browserPrompt = '\u00a0 frozen prompt';
  const composer = strictComposerEvaluateFixture({ prompt, existingDraft: '' });
  let clicked = 0;
  const identity = reviewPlainTextIdentity(prompt);
  const page = {
    async getUrl() { return 'https://chatgpt.com/c/click-time-nbsp'; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const composerResult = composer.evaluate(js);
      if (composerResult) return composerResult;
      if (js.includes('reviewSendOnceMarker')) {
        assert.equal(js.includes('browserSpaceRebalanceSite'), true);
        assert.equal(safeReviewPlainTextComparison(prompt, browserPrompt).ok, true);
        clicked += 1;
        return {
          ok: true,
          clickCount: 1,
          label: 'Send prompt',
          clickTimeIdentity: {
            ok: true,
            recoveredExact: true,
            textModel: REVIEW_PLAIN_TEXT_MODEL,
            identityMode: 'browser_space_rebalanced',
            sourceSha256: identity.sourceSha256,
            canonicalPromptSha256: identity.canonicalSha256,
            observedCanonicalSha256: identity.canonicalSha256,
            serializedLength: browserPrompt.length,
            expectedLength: prompt.length,
            browserSpaceRebalanceCount: 1,
            mismatchCount: 1
          }
        };
      }
      if (js.includes('reviewSnapshotMarker')) return {
        messages: clicked ? [
          { order: 0, role: 'user', id: 'nbsp-history', text: 'history', textIdentityReadable: true },
          { order: 1, role: 'user', id: 'nbsp-user', text: browserPrompt, textIdentityReadable: true },
          { order: 2, role: 'assistant', id: 'nbsp-assistant', text: 'DONE' }
        ] : [{ order: 0, role: 'user', id: 'nbsp-history', text: 'history', textIdentityReadable: true }],
        modelEvidence: 'GPT-5.6 Pro', modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [], selectorStop: false, sendVisible: true
      };
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText(text) { composer.insert(text); },
    async sendKey() {}, async moveMouse() {}, async mouseDown() {}, async mouseUp() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' }
  });
  const result = await controller.reviewQuery({
    prompt,
    expectedUrl: 'https://chatgpt.com/c/click-time-nbsp',
    expectedConversationId: 'click-time-nbsp', expectedModel: 'GPT-5.6 Pro', timeoutMs: 8_000,
    onComposerVerified: async () => { composer.replace(browserPrompt); }
  });
  assert.equal(clicked, 1);
  assert.equal(result.text, 'DONE');
});

test('chatgpt-controller: submission diagnosis injects the structure summarizer dependency', async () => {
  const url = 'https://chatgpt.com/c/conversation-diagnostic';
  const prompt = 'exact';
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      assert.equal(js.includes('reviewSnapshotMarker'), true);
      assert.equal(js.includes('const summarizeReviewComposerStructure ='), true);
      return {
        messages: [{
          order: 0,
          role: 'user',
          id: 'user-diagnostic',
          text: prompt,
          textLength: prompt.length,
          textIdentityReadable: true,
          textIdentityError: null,
          textIdentityTag: null,
          textIdentityDiagnostic: {
            candidateCount: 1,
            rootTag: 'DIV',
            elementCount: 1,
            textNodeCount: 1,
            otherNodeCount: 0,
            maxDepth: 1,
            tagHistogram: { DIV: 1 }
          }
        }],
        modelEvidence: 'GPT-5.6 Pro',
        modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [],
        selectorStop: false,
        sendVisible: true
      };
    }
  };
  const controller = new ChatGPTController({ page, selectors: {} });
  const result = await controller.inspectReviewSubmissionIdentity({
    prompt,
    baselineMessageIds: [],
    expectedUrl: url,
    expectedConversationId: 'conversation-diagnostic',
    expectedModel: 'GPT-5.6 Pro'
  });
  assert.equal(result.ok, true);
  assert.equal(result.serializedLength, prompt.length);
});

test('chatgpt-controller: submission diagnosis rejects multiple new user message identities', async () => {
  const url = 'https://chatgpt.com/c/conversation-multiple';
  const page = {
    async getUrl() { return url; },
    async evaluate() {
      return {
        messages: [
          { order: 0, role: 'user', id: 'user-1', text: 'exact', textLength: 5, textIdentityReadable: true },
          { order: 1, role: 'user', id: 'user-2', text: 'exact', textLength: 5, textIdentityReadable: true }
        ],
        modelEvidence: 'GPT-5.6 Pro',
        modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [],
        selectorStop: false,
        sendVisible: true
      };
    }
  };
  const controller = new ChatGPTController({ page, selectors: {} });
  const result = await controller.inspectReviewSubmissionIdentity({
    prompt: 'exact',
    baselineMessageIds: [],
    expectedUrl: url,
    expectedConversationId: 'conversation-multiple',
    expectedModel: 'GPT-5.6 Pro'
  });
  assert.equal(result.ok, false);
  assert.equal(result.newUserMessageCount, 2);
  assert.equal(result.exactMatchCount, 2);
});

test('chatgpt-controller: user-message identity reads the unique content leaf and excludes controls', () => {
  const content = elementNode('DIV', textNode('alpha\n\nbeta'));
  content.querySelectorAll = () => [];
  const editControl = elementNode('BUTTON', textNode('Edit'));
  const outer = elementNode('DIV', content, editControl);
  outer.querySelectorAll = () => [content];
  assert.deepEqual(serializeReviewUserMessage(outer), {
    ok: true,
    text: 'alpha\n\nbeta',
    candidateCount: 1,
    rootTag: 'DIV',
    elementCount: 1,
    textNodeCount: 1,
    otherNodeCount: 0,
    maxDepth: 1,
    tagHistogram: { DIV: 1 }
  });
});

test('chatgpt-controller: exact PRE/CODE rendered wrapper preserves the complete structural prompt byte-for-text identity', () => {
  const prompt = [
    '# Synthetic transport canary',
    '',
    '- outer',
    '  - inner',
    '',
    '```text',
    'line \u2014 canary',
    '```',
    '',
    'Return exactly `D94_CG_OK` and nothing else.',
    ''
  ].join('\n');
  assert.equal(prompt.length, 121);
  assert.equal(
    crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
    '7c357f0bf15e01e8962b5df121d3ee993dd7f97ba0fb75861a46708ceca9fad8'
  );
  const content = elementNode('PRE', elementNode('CODE', textNode(prompt)));
  content.querySelectorAll = () => [];
  const outer = elementNode('DIV', content);
  outer.querySelectorAll = () => [content];
  const result = serializeReviewUserMessage(outer);
  assert.deepEqual(result, {
    ok: true,
    text: prompt,
    candidateCount: 1,
    rootTag: 'PRE',
    elementCount: 2,
    textNodeCount: 1,
    otherNodeCount: 0,
    maxDepth: 2,
    tagHistogram: { CODE: 1, PRE: 1 }
  });
  const accepted = safeReviewPlainTextComparison(prompt, result.text);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.canonicalPromptSha256, accepted.observedCanonicalSha256);
  const corrupted = safeReviewPlainTextComparison(prompt, result.text.replace('\u2014', '-'));
  assert.equal(corrupted.ok, false);
  assert.equal(corrupted.mismatchClass, 'non_reversible_code_point_mismatch');
  assert.notEqual(corrupted.canonicalPromptSha256, corrupted.observedCanonicalSha256);
});

test('chatgpt-controller: outer rendered content candidate cannot be shadowed by a nested PRE selector hit', () => {
  const prompt = '# Exact\n\n```text\nx\n```\n';
  const pre = elementNode('PRE', elementNode('CODE', textNode(prompt)));
  pre.querySelectorAll = () => [];
  const content = elementNode('DIV', pre);
  content.querySelectorAll = () => [pre];
  content.contains = (node) => node === pre;
  const outer = elementNode('DIV', content);
  outer.querySelectorAll = () => [content, pre];
  const result = serializeReviewUserMessage(outer);
  assert.equal(result.ok, true);
  assert.equal(result.text, prompt);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.rootTag, 'DIV');
  assert.deepEqual(result.tagHistogram, { CODE: 1, DIV: 1, PRE: 1 });
});

test('chatgpt-controller: malformed PRE wrapper remains unreadable and diagnostics disclose no content', () => {
  const content = elementNode(
    'PRE',
    elementNode('CODE', textNode('secret-code')),
    elementNode('BUTTON', textNode('secret-control'))
  );
  content.querySelectorAll = () => [];
  const outer = elementNode('DIV', content);
  outer.querySelectorAll = () => [content];
  const result = serializeReviewUserMessage(outer);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'review_pre_code_shape_unsupported');
  assert.equal(result.tag, 'PRE');
  assert.equal(result.rootTag, 'PRE');
  assert.deepEqual(result.tagHistogram, { BUTTON: 1, CODE: 1, PRE: 1 });
  assert.equal(JSON.stringify(result).includes('secret'), false);

  assert.deepEqual(
    serializeReviewComposer(elementNode('PRE', elementNode('CODE', elementNode('DIV', textNode('secret-nested'))))),
    { ok: false, error: 'review_pre_code_shape_unsupported', tag: 'DIV' }
  );
});

test('chatgpt-controller: user-message identity fails closed on distinct content leaves', () => {
  const first = elementNode('DIV', textNode('alpha'));
  const second = elementNode('DIV', textNode('beta'));
  first.querySelectorAll = () => [];
  second.querySelectorAll = () => [];
  const outer = elementNode('DIV', first, second);
  outer.querySelectorAll = () => [first, second];
  assert.deepEqual(serializeReviewUserMessage(outer), {
    ok: false,
    error: 'review_user_message_content_ambiguous',
    candidateCount: 2,
    distinctTextCount: 2
  });
});

test('chatgpt-controller: user-message identity rejects selector-matching control content', () => {
  const control = elementNode('BUTTON', textNode('exact prompt'));
  control.querySelectorAll = () => [];
  control.getAttribute = () => null;
  const outer = elementNode('DIV', control);
  outer.querySelectorAll = () => [control];
  assert.deepEqual(serializeReviewUserMessage(outer), {
    ok: false,
    error: 'review_user_message_content_missing'
  });
});

test('chatgpt-controller: duplicate identical model evidence collapses while conflicting evidence remains', () => {
  assert.deepEqual(
    deduplicateReviewModelEvidence([' Pro ', 'Pro', 'PRO']),
    ['Pro']
  );
  assert.deepEqual(
    deduplicateReviewModelEvidence(['Pro', 'Thinking']),
    ['Pro', 'Thinking']
  );
});

test('chatgpt-controller: review model evidence is not restricted to semantic header or nav containers', () => {
  const selectors = JSON.parse(readFileSync(new URL('../selectors.json', import.meta.url), 'utf8'));
  assert.match(selectors.reviewModelEvidence, /^button\[data-testid/);
  assert.doesNotMatch(selectors.reviewModelEvidence, /(?:header|nav) /);
});

function readyState() {
  return {
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    readyState: 'complete',
    blocked: false,
    promptVisible: true,
    kind: null,
    indicators: {
      hasTurnstile: false,
      hasArkose: false,
      hasVerifyButton: false,
      looks403: false,
      loginLike: false,
      rawPromptVisible: true,
      sendVisible: true
    }
  };
}

test('chatgpt-controller: strict control classifier rejects bare Continue and Retry labels', () => {
  assert.equal(classifyReviewControls(['Continue']).continue, true);
  assert.equal(classifyReviewControls(['Retry']).retry, true);
  assert.equal(classifyReviewControls(['Answer now']).answerNow, true);
  assert.equal(classifyReviewControls(['Continue with Google']).continue, false);
});

test('chatgpt-controller: Pro aliases match but High never satisfies Pro', () => {
  assert.equal(modelLabelMatches('Pro', 'Pro'), true);
  assert.equal(modelLabelMatches('GPT-5.6 Pro', 'Pro'), true);
  assert.equal(modelLabelMatches('Pro', 'GPT-5.6 Pro'), true);
  assert.equal(modelLabelMatches('High', 'Pro'), false);
});

test('chatgpt-controller: send falls back to requestSubmit on the active composer before Enter', async () => {
  const events = [];
  let waitForSendChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes("form.requestSubmit")) {
        events.push('requestSubmit');
        return true;
      }
      if (js.includes('already_generating')) return { ok: true, requestSubmit: true, host: 'chatgpt.com' };
      if (js.includes('promptLen')) {
        waitForSendChecks += 1;
        return waitForSendChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: 7 };
      }
      if (js.includes('composerClearedMarker')) return 0;
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey(key) {
      events.push(`key:${key}`);
    },
    async insertText(text) {
      events.push(`text:${text}`);
    },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('requestSubmit'), true);
  assert.equal(events.includes('key:Enter'), false);
});

test('chatgpt-controller: public query inserts a multiline prompt once', async () => {
  const prompt = 'first line\nsecond line\nthird line';
  const inserted = [];
  let requestSubmitCount = 0;
  let promptChecks = 0;
  let responseChecks = 0;
  let baselineChecks = 0;
  let modelSelected = false;
  let modelPickerClicks = 0;
  let modelOptionClicks = 0;
  const trustedClicks = [];
  const page = {
    async navigate() {},
    async getUrl() { return 'https://chatgpt.com/c/public-query'; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('agentifyModelStateMarker')) {
        assert.match(js, /data-composer-transition-slot/);
        return {
          matched: modelSelected,
          labels: [modelSelected ? 'Pro' : 'High'],
          matchedLabel: modelSelected ? 'Pro' : null
        };
      }
      if (js.includes('agentifyOpenModelPickerMarker')) {
        assert.match(js, /data-composer-transition-slot/);
        assert.doesNotMatch(js, /textContent[^;]*===/);
        assert.doesNotMatch(js, /picker\.click\(\)/);
        modelPickerClicks += 1;
        return { ok: true, rect: { x: 20, y: 30, w: 80, h: 20 } };
      }
      if (js.includes('agentifyChooseModelMarker')) {
        assert.match(js, /menuitemradio/);
        assert.doesNotMatch(js, /target\.click\(\)/);
        modelOptionClicks += 1;
        if (modelOptionClicks === 1) return { ok: false, error: 'expected_model_unavailable' };
        modelSelected = true;
        return { ok: true, labels: ['Medium', 'Pro'], rect: { x: 30, y: 40, w: 100, h: 24 } };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('form.requestSubmit')) { requestSubmitCount += 1; return true; }
      if (js.includes('already_generating')) return { ok: true, requestSubmit: true, host: 'chatgpt.com' };
      if (js.includes('promptLen')) {
        promptChecks += 1;
        return promptChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: prompt.length };
      }
      if (js.includes('composerClearedMarker')) return 0;
      if (js.includes('document.querySelectorAll') && js.includes('.length)()')) {
        baselineChecks += 1;
        return 1;
      }
      if (js.includes('const codes =')) return { codeBlocks: [] };
      if (js.includes('const nodes = Array.from(document.querySelectorAll')) {
        responseChecks += 1;
        if (responseChecks < 2) {
          return { stop: false, sendEnabled: true, txt: 'old response', count: 1, usedFallback: false, hasError: false, hasContinue: false, hasRegenerate: false, hasAnswerNow: false };
        }
        return { stop: false, sendEnabled: true, txt: 'done', count: 2, usedFallback: false, hasError: false, hasContinue: false, hasRegenerate: false, hasAnswerNow: responseChecks < 4 };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async sendKey() {},
    async insertText(text) { inserted.push(text); },
    async moveMouse() {},
    async mouseDown(x, y) { trustedClicks.push([x, y]); },
    async mouseUp() {},
    async setFileInputFiles() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.query({ prompt, expectedModel: 'Pro', timeoutMs: 5_000 });
  assert.equal(result.text, 'done');
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.conversationUrl, 'https://chatgpt.com/c/public-query');
  assert.equal(result.conversationId, 'public-query');
  assert.equal(result.modelEvidence, 'Pro');
  assert.deepEqual(inserted, [prompt]);
  assert.equal(requestSubmitCount, 1);
  assert.equal(baselineChecks, 1);
  assert.equal(modelPickerClicks, 1);
  assert.equal(modelOptionClicks, 2);
  assert.deepEqual(trustedClicks.slice(0, 2), [[60, 40], [80, 52]]);
  assert.ok(responseChecks >= 4);
});

test('chatgpt-controller: public query allows the full 45-minute response window', () => {
  const source = readFileSync(new URL('../chatgpt-controller.mjs', import.meta.url), 'utf8');
  assert.match(source, /Math\.min\(timeoutMs, 45 \* 60_000\)/);
  assert.match(source, /#ensureExpectedModel\(expectedModel, Math\.min\(timeoutMs, 60_000\)\)/);
});

test('chatgpt-controller: public query never returns page chrome as an assistant response', () => {
  const source = readFileSync(new URL('../chatgpt-controller.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fallbackMainText/);
  assert.doesNotMatch(source, /fallbackStableLongEnough/);
});

test('chatgpt-controller: public query rejects transient thinking placeholders as completion', () => {
  const source = readFileSync(new URL('../chatgpt-controller.mjs', import.meta.url), 'utf8');
  assert.match(source, /transientPlaceholder/);
  assert.match(source, /!transientPlaceholder/);
});

test('chatgpt-controller: wait response observes one active answer without sending', async () => {
  let responseChecks = 0;
  let insertCalls = 0;
  let sendCalls = 0;
  const page = {
    async navigate() {},
    async getUrl() { return 'https://chatgpt.com/c/current'; },
    async evaluate(js) {
      if (js.includes('active: generating || hasContinue || hasAnswerNow')) {
        return { count: 2, active: true };
      }
      if (js.includes('const codes =')) return { codeBlocks: [] };
      if (js.includes('const nodes = Array.from(document.querySelectorAll')) {
        responseChecks += 1;
        return {
          stop: false,
          sendEnabled: true,
          txt: 'completed current answer',
          count: 2,
          usedFallback: false,
          hasError: false,
          hasContinue: false,
          hasRegenerate: false,
          hasAnswerNow: responseChecks < 3
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async insertText() { insertCalls += 1; },
    async sendKey() { sendCalls += 1; }
  };
  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.waitForCurrentResponse({ timeoutMs: 6_000 });
  assert.equal(result.text, 'completed current answer');
  assert.equal(insertCalls, 0);
  assert.equal(sendCalls, 0);
  assert.ok(responseChecks >= 3);
});

test('chatgpt-controller: lists visible conversations and opens a clean conversation', async () => {
  const navigations = [];
  const page = {
    async navigate(url) { navigations.push(url); },
    async getUrl() { return navigations[navigations.length - 1] || 'https://chatgpt.com/c/current'; },
    async evaluate(js) {
      assert.match(js, /a\[href\*="\/c\/"\]/);
      return [
        { title: 'Research review', url: 'https://chatgpt.com/c/research' },
        { title: 'UAV review', url: 'https://chatgpt.com/c/uav' }
      ];
    }
  };
  const controller = new ChatGPTController({ page, selectors: {} });

  assert.deepEqual(await controller.listConversations(), [
    { title: 'Research review', url: 'https://chatgpt.com/c/research' },
    { title: 'UAV review', url: 'https://chatgpt.com/c/uav' }
  ]);
  assert.equal(await controller.newConversation(), 'https://chatgpt.com/');
  assert.deepEqual(navigations, ['https://chatgpt.com/']);
});

test('chatgpt-controller: wait response recovers the completed latest exchange from an idle page', async () => {
  let initialRead = true;
  const page = {
    async getUrl() { return 'https://chatgpt.com/c/completed'; },
    async evaluate(js) {
      if (js.includes('latestAssistantText') && initialRead) {
        initialRead = false;
        return {
          count: 3,
          active: false,
          latestAssistantText: 'completed answer',
          latestUserText: 'current scientific question'
        };
      }
      if (js.includes('const nodes = Array.from(document.querySelectorAll')) {
        return {
          stop: false,
          sendEnabled: true,
          txt: 'completed answer',
          count: 3,
          hasError: false,
          hasContinue: false,
          hasRegenerate: true,
          hasAnswerNow: false,
          hasRetry: false
        };
      }
      if (js.includes('const codes =')) return { codeBlocks: [] };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  };
  const controller = new ChatGPTController({
    page,
    selectors: {
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.waitForCurrentResponse({ timeoutMs: 5_000 });
  assert.equal(result.text, 'completed answer');
  assert.equal(result.meta.recoveredFromIdle, true);
  assert.equal(result.meta.latestUserText, 'current scientific question');
});

test('chatgpt-controller: strict review submits with one send control and returns two stable exact-message snapshots', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  const prompt = 'x';
  const keys = [];
  let strictClicks = 0;
  let reviewSnapshotCalls = 0;
  let submitted = 0;
  let prepared = 0;
  let insertedPrompt = '';
  const response = 'STRICT_OK';
  const page = {
    async navigate() {},
    async getUrl() {
      return url;
    },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('observedLengths')) {
        return { ok: insertedPrompt === prompt, observedLengths: [insertedPrompt.length], expectedLength: prompt.length };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        reviewSnapshotCalls += 1;
        const historyReady = reviewSnapshotCalls > 0;
        const historical = historyReady
          ? [{ order: 0, role: 'user', id: 'historical-user-1', text: 'historical' }]
          : [];
        const messages = strictClicks
          ? [
              ...historical,
              { order: 1, role: 'user', id: 'user-1', text: prompt },
              { order: 2, role: 'assistant', id: 'assistant-1', text: response }
            ]
          : historical;
        return {
          messages,
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [],
          selectorStop: false,
          sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async sendKey(key) {
      keys.push(key);
    },
    async insertText(text) {
      insertedPrompt += text;
    },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });
  const result = await controller.reviewQuery({
    prompt,
    expectedUrl: url,
    expectedConversationId: 'conversation-1',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 8_000,
    onPrepared: async ({ baselineMessageIds }) => {
      prepared += 1;
      assert.deepEqual(baselineMessageIds, ['historical-user-1']);
    },
    onSubmitted: async () => {
      submitted += 1;
    }
  });
  assert.equal(strictClicks, 1);
  assert.equal(insertedPrompt, prompt);
  assert.equal(prepared, 1);
  assert.equal(submitted, 1);
  assert.equal(keys.includes('Enter'), false);
  assert.equal(result.userMessageId, 'user-1');
  assert.equal(result.assistantMessageId, 'assistant-1');
  assert.equal(result.text, response);
  assert.equal(result.snapshots.length, 2);
  assert.ok(result.snapshots[1].observedAt - result.snapshots[0].observedAt >= 3_000);
  assert.equal(result.snapshots[0].textSha256, crypto.createHash('sha256').update(response).digest('hex'));
  assert.deepEqual(result.clickedControls, []);
  assert.equal(result.controls.answerNow, false);
});

test('chatgpt-controller: continuation with an empty baseline fails before composer write', async () => {
  const url = 'https://chatgpt.com/c/empty-baseline';
  let inserted = 0;
  let strictClicks = 0;
  let prepared = 0;
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: [],
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [],
          selectorStop: false,
          sendVisible: true
        };
      }
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText() { inserted += 1; },
    async sendKey() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };
  const controller = new ChatGPTController({ page, selectors: {} });
  await assert.rejects(
    controller.reviewQuery({
      prompt: 'must not reach the composer',
      expectedUrl: url,
      expectedConversationId: 'empty-baseline',
      expectedModel: 'GPT-5.6 Pro',
      timeoutMs: 5_000,
      onPrepared: async () => { prepared += 1; }
    }),
    (error) =>
      error?.message === 'review_continuation_baseline_empty' &&
      error?.data?.noClickProven === true &&
      error?.data?.failureStage === 'before_composer_write'
  );
  assert.equal(prepared, 0);
  assert.equal(inserted, 0);
  assert.equal(strictClicks, 0);
});

test('chatgpt-controller: first binding pastes once and follows the created ChatGPT conversation', async () => {
  const prompt = 'raw scientific question';
  let currentUrl = 'https://chatgpt.com/';
  let strictClicks = 0;
  let insertCalls = 0;
  let postSendSnapshots = 0;
  const page = {
    async getUrl() { return currentUrl; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('observedLengths')) return { ok: true, observedLengths: [prompt.length], expectedLength: prompt.length };
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        currentUrl = 'https://chatgpt.com/c/WEB:temporary-conversation';
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        if (strictClicks && ++postSendSnapshots >= 2) {
          currentUrl = 'https://chatgpt.com/c/created-conversation';
        }
        return {
          messages: strictClicks ? [
            { order: 0, role: 'user', id: 'created-user', text: prompt },
            { order: 1, role: 'assistant', id: 'created-assistant', text: 'CREATED_OK' }
          ] : [],
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [],
          selectorStop: false,
          sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async sendKey() {},
    async insertText(text) { insertCalls += 1; assert.equal(text, prompt); },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {}
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' } });
  let submitted = null;
  const result = await controller.reviewQuery({
    prompt,
    expectedUrl: 'https://chatgpt.com/',
    expectedConversationId: '__new__',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 8_000,
    firstBinding: true,
    onSubmitted: async (value) => { submitted = value; }
  });
  assert.equal(insertCalls, 1);
  assert.equal(strictClicks, 1);
  assert.equal(submitted.conversationId, 'created-conversation');
  assert.equal(result.conversationUrl, 'https://chatgpt.com/c/created-conversation');
});

test('chatgpt-controller: strict review recognizes a Gemini app conversation identity', async () => {
  const url = 'https://gemini.google.com/app/gemini-review';
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      assert.equal(js.includes('reviewSnapshotMarker'), true);
      assert.equal(js.includes('user-query'), true);
      assert.equal(js.includes('model-response'), true);
      return {
        messages: [{ order: 0, role: 'user', id: 'gemini-user', text: 'question', textLength: 8, textIdentityReadable: true }],
        modelEvidence: 'Gemini 2.5 Pro',
        modelEvidenceCandidates: ['Gemini 2.5 Pro'],
        controlText: [],
        selectorStop: false,
        sendVisible: true
      };
    }
  };
  const controller = new ChatGPTController({ page, selectors: {} });
  const result = await controller.inspectReviewSubmissionIdentity({
    prompt: 'question',
    baselineMessageIds: [],
    expectedUrl: url,
    expectedConversationId: 'gemini-review',
    expectedModel: 'Gemini 2.5 Pro'
  });
  assert.equal(result.ok, true);
});

test('chatgpt-controller: Gemini strict review inserts once and completes on the same app identity', async () => {
  const url = 'https://gemini.google.com/app/gemini-strict';
  const prompt = 'scientific question';
  let insertCalls = 0;
  let strictClicks = 0;
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('observedLengths')) return { ok: true, observedLengths: [prompt.length], expectedLength: prompt.length };
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        assert.equal(js.includes('user-query'), true);
        assert.equal(js.includes('model-response'), true);
        return {
          messages: strictClicks ? [
            { order: 0, role: 'user', id: 'gemini-strict-history', text: 'history', textIdentityReadable: true },
            { order: 1, role: 'user', id: 'user:0', text: prompt },
            { order: 2, role: 'assistant', id: 'assistant:1', text: 'GEMINI_OK' }
          ] : [{ order: 0, role: 'user', id: 'gemini-strict-history', text: 'history', textIdentityReadable: true }],
          modelEvidence: 'Gemini 2.5 Pro',
          modelEvidenceCandidates: ['Gemini 2.5 Pro'],
          controlText: [],
          selectorStop: false,
          sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText(text) { insertCalls += 1; assert.equal(text, prompt); },
    async sendKey() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {}
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' } });
  const result = await controller.reviewQuery({
    prompt,
    expectedUrl: url,
    expectedConversationId: 'gemini-strict',
    expectedModel: 'Gemini 2.5 Pro',
    timeoutMs: 8_000
  });
  assert.equal(insertCalls, 1);
  assert.equal(strictClicks, 1);
  assert.equal(result.text, 'GEMINI_OK');
});

test('chatgpt-controller: Gemini strict preflight selects model and Extended thinking through the shared adapter', async () => {
  const url = 'https://gemini.google.com/app/gemini-composite';
  const expectedModel = 'Gemini 3.1 Pro extended';
  const prompt = 'exact question';
  let selectedModel = false;
  let selectedThinking = false;
  let pendingSelection = null;
  let strictClicks = 0;
  const selectionOrder = [];
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('agentifyGeminiModelStateMarker')) {
        return {
          matched: selectedModel && selectedThinking,
          labels: [selectedModel ? '3.1 Pro' : '2.5 Pro', ...(selectedThinking ? ['Extended thinking'] : [])],
          matchedLabel: selectedModel && selectedThinking ? expectedModel : null,
          modelLabel: selectedModel ? '3.1 Pro' : null,
          thinkingMode: selectedThinking ? 'Extended thinking' : null
        };
      }
      if (js.includes('agentifyGeminiChooseModelPartMarker')) {
        assert.match(js, /geminiMenuItemSemanticLabel/);
        assert.match(js, /geminiMenuItemSelected/);
        assert.doesNotMatch(js, /getAttribute\('data-active'\)/);
        pendingSelection = js.includes('"thinking" === \'thinking\'') ? 'thinking' : 'model';
        return { ok: true, labels: ['3.1 Pro', 'Extended thinking'], rect: { x: 10, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('reviewComposerDiagnosticMarker')) {
        return { ok: true, serializerOk: true, serializedLength: prompt.length, expectedLength: prompt.length };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: strictClicks ? [
            { order: 0, role: 'user', id: 'gemini-composite-history', text: 'history', textIdentityReadable: true },
            { order: 1, role: 'user', id: 'gemini-composite-user', text: prompt, textIdentityReadable: true },
            { order: 2, role: 'assistant', id: 'gemini-composite-assistant', text: 'DONE' }
          ] : [{ order: 0, role: 'user', id: 'gemini-composite-history', text: 'history', textIdentityReadable: true }],
          modelEvidence: expectedModel,
          modelEvidenceCandidates: [expectedModel],
          controlText: [], selectorStop: false, sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText(text) { assert.equal(text, prompt); },
    async sendKey() {},
    async moveMouse() {},
    async mouseDown() {
      if (pendingSelection === 'model') selectedModel = true;
      if (pendingSelection === 'thinking') selectedThinking = true;
      if (pendingSelection) selectionOrder.push(pendingSelection);
      pendingSelection = null;
    },
    async mouseUp() {}
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' } });
  const result = await controller.reviewQuery({
    prompt,
    expectedUrl: url,
    expectedConversationId: 'gemini-composite',
    expectedModel,
    timeoutMs: 10_000
  });
  assert.deepEqual(selectionOrder, ['model', 'thinking']);
  assert.equal(strictClicks, 1);
  assert.equal(result.modelEvidence, expectedModel);
});

test('chatgpt-controller: strict review accepts structural exactness when browser text projections bracket the prompt', async () => {
  const url = 'https://chatgpt.com/c/conversation-structural';
  const prompt = 'alpha\n\nbeta';
  let strictClicks = 0;
  const page = {
    async navigate() {},
    async getUrl() { return url; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('observedLengths')) {
        return {
          ok: true,
          serializerOk: true,
          serializerMethod: 'contenteditable_structural',
          serializedLength: prompt.length,
          observedLengths: [prompt.length + 1, prompt.length - 1],
          expectedLength: prompt.length
        };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: strictClicks ? [
            { order: 0, role: 'user', id: 'structural-history', text: 'history', textIdentityReadable: true },
            { order: 1, role: 'user', id: 'user-structural', text: prompt },
            { order: 2, role: 'assistant', id: 'assistant-structural', text: 'OK' }
          ] : [{ order: 0, role: 'user', id: 'structural-history', text: 'history', textIdentityReadable: true }],
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [],
          selectorStop: false,
          sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt-textarea', sendButton: '#send', stopButton: '#stop' } });
  const result = await controller.reviewQuery({
    prompt,
    expectedUrl: url,
    expectedConversationId: 'conversation-structural',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 8_000
  });
  assert.equal(strictClicks, 1);
  assert.equal(result.userMessageId, 'user-structural');
});

test('chatgpt-controller: strict review rejects a non-exact composer before its send boundary', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  let strictClicks = 0;
  let insertCalls = 0;
  const page = {
    async navigate() {},
    async getUrl() {
      return url;
    },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('observedLengths')) return { ok: false, observedLengths: [7], expectedLength: 8 };
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1 };
      }
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: strictClicks ? [
            { order: 0, role: 'user', id: 'mismatch-history', text: 'history', textIdentityReadable: true },
            { order: 1, role: 'user', id: 'user-mismatch', text: 'Pasted_text.txt' },
            { order: 2, role: 'assistant', id: 'assistant-mismatch', text: 'OK' }
          ] : [{ order: 0, role: 'user', id: 'mismatch-history', text: 'history', textIdentityReadable: true }],
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [],
          selectorStop: false,
          sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async sendKey() {},
    async insertText() {
      insertCalls += 1;
    },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });
  await assert.rejects(controller.reviewQuery({
      prompt: 'mismatch',
      expectedUrl: url,
      expectedConversationId: 'conversation-1',
      expectedModel: 'GPT-5.6 Pro',
      timeoutMs: 8_000
    }), /review_composer_identity_mismatch/);
  assert.equal(insertCalls, 1);
  assert.equal(strictClicks, 0);
});

test('chatgpt-controller: post-send rendered user mismatch is ambiguous and never acknowledged as submitted', async () => {
  const url = 'https://chatgpt.com/c/rendered-mismatch';
  const prompt = 'exact frozen prompt';
  let strictClicks = 0;
  let submitted = false;
  let observed = null;
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('reviewComposerDiagnosticMarker')) {
        return { ok: true, serializerOk: true, serializedLength: prompt.length, expectedLength: prompt.length };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: strictClicks ? [{
            order: 0, role: 'user', id: 'rendered-mismatch-history', text: 'history', textIdentityReadable: true
          }, {
            order: 1,
            role: 'user',
            id: 'rendered-mismatch-user',
            text: 'Pasted_text.txt',
            textLength: 15,
            textIdentityReadable: true
          }] : [{ order: 0, role: 'user', id: 'rendered-mismatch-history', text: 'history', textIdentityReadable: true }],
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [], selectorStop: false, sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText() {}, async sendKey() {}, async moveMouse() {}, async mouseDown() {}, async mouseUp() {}
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' } });
  await assert.rejects(
    controller.reviewQuery({
      prompt,
      expectedUrl: url,
      expectedConversationId: 'rendered-mismatch',
      expectedModel: 'GPT-5.6 Pro',
      timeoutMs: 5_000,
      onUserTurnObserved: async (receipt) => { observed = receipt; },
      onSubmitted: async () => { submitted = true; }
    }),
    (error) => {
      assert.equal(error.message, 'review_user_message_content_mismatch');
      assert.equal(error.data.exactMatchCount, 0);
      return true;
    }
  );
  assert.equal(strictClicks, 1);
  assert.equal(observed.observedUserMessageId, 'rendered-mismatch-user');
  assert.equal(observed.commitmentClass, 'turn_content_mismatch');
  assert.equal(observed.serializerOk, true);
  assert.equal(submitted, false);
});

test('chatgpt-controller: exact click-bound submission binds one Markdown-rendered turn while display fidelity remains lossy', async () => {
  let currentUrl = 'https://chatgpt.com/';
  const canonicalUrl = 'https://chatgpt.com/c/rendered-markdown-loss';
  const prompt = [
    '# Synthetic rendered-identity canary',
    '',
    '- outer',
    '  - inner',
    '',
    '```text',
    'line \u2014 exact',
    '```',
    '',
    'Return exactly `PRECODE_CG_OK` and nothing else.',
    ''
  ].join('\n');
  const rendered = prompt.replace('```text\n', '\n\n').replace('```\n', '\n\n');
  assert.equal(prompt.length, 132);
  assert.equal(rendered.length, 124);
  let strictClicks = 0;
  let postClickSnapshots = 0;
  let submitted = null;
  let observed = null;
  const receipt = causalReceipt(prompt, [], 'rendered-markdown-loss-operation');
  const page = {
    async getUrl() { return currentUrl; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('reviewComposerDiagnosticMarker')) {
        return { ok: true, serializerOk: true, serializedLength: prompt.length, expectedLength: prompt.length };
      }
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        currentUrl = 'https://chatgpt.com/c/WEB:rendered-markdown-loss';
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        if (strictClicks && ++postClickSnapshots >= 2) currentUrl = canonicalUrl;
        return {
        messages: strictClicks ? [
          {
            order: 0,
            role: 'user',
            id: 'rendered-markdown-user',
            text: rendered,
            textLength: rendered.length,
            textIdentityReadable: true,
            textIdentityDiagnostic: { candidateCount: 1, rootTag: 'DIV', tagHistogram: { CODE: 2, DIV: 1, PRE: 1 } }
          },
          { order: 1, role: 'assistant', id: 'rendered-markdown-assistant', text: 'PRECODE_CG_OK' }
        ] : [],
        modelEvidence: 'GPT-5.6 Pro',
        modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [], selectorStop: false, sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText() {}, async sendKey() {}, async moveMouse() {}, async mouseDown() {}, async mouseUp() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' }
  });
  const result = await controller.reviewQuery({
    prompt,
    expectedUrl: 'https://chatgpt.com/',
    expectedConversationId: '__new__',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 8_000,
    firstBinding: true,
    onSendAction: async () => receipt,
    onUserTurnObserved: async (value) => { observed = value; },
    onSubmitted: async (value) => { submitted = value; }
  });
  assert.equal(strictClicks, 1);
  assert.equal(observed.commitmentClass, 'turn_causal_exact_rendered_mismatch');
  assert.equal(observed.renderedDisplayFidelity, 'lossy_mismatch');
  assert.equal(submitted.submissionIdentityMode, REVIEW_CAUSAL_SUBMISSION_MODEL);
  assert.equal(submitted.causalSubmissionReceipt, receipt);
  assert.equal(submitted.renderedDisplayFidelity, 'lossy_mismatch');
  assert.equal(submitted.conversationUrl, canonicalUrl);
  assert.equal(result.userMessageId, 'rendered-markdown-user');
  assert.equal(result.text, 'PRECODE_CG_OK');
});

test('chatgpt-controller: ambiguous send control fails before a click', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  let sendEvaluationReached = false;
  const page = {
    async navigate() {},
    async getUrl() {
      return url;
    },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('observedLengths')) return { ok: true, observedLengths: [4], expectedLength: 4 };
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        sendEvaluationReached = true;
        return { ok: false, error: 'review_send_control_ambiguous', count: 0 };
      }
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: [{ order: 0, role: 'user', id: 'send-control-history', text: 'history', textIdentityReadable: true }],
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [],
          selectorStop: false,
          sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt-textarea', sendButton: '#send', stopButton: '#stop' } });
  await assert.rejects(
    controller.reviewQuery({
      prompt: 'safe',
      expectedUrl: url,
      expectedConversationId: 'conversation-1',
      expectedModel: 'GPT-5.6 Pro',
      timeoutMs: 5_000
    }),
    /review_send_control_ambiguous/
  );
  assert.equal(sendEvaluationReached, true);
});

test('chatgpt-controller: post-send unreadable rendered user content is ambiguous and never submitted', async () => {
  const url = 'https://chatgpt.com/c/conversation-rendered';
  const prompt = '```text\nsynthetic\n```\n';
  let strictClicks = 0;
  let submittedReceipt = null;
  let observedReceipt = null;
  const page = {
    async navigate() {},
    async getUrl() { return url; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('reviewComposerDiagnosticMarker')) {
        return {
          ok: true,
          serializerOk: true,
          serializerMethod: 'contenteditable_structural',
          serializedLength: prompt.length,
          observedLengths: [prompt.length],
          expectedLength: prompt.length
        };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: strictClicks ? [{
            order: 0, role: 'user', id: 'rendered-history', text: 'history', textIdentityReadable: true
          }, {
            order: 1,
            role: 'user',
            id: 'user-rendered',
            text: null,
            textLength: null,
            textIdentityReadable: false,
            textIdentityError: 'review_composer_element_unsupported',
            textIdentityTag: 'PRE',
            textIdentityDiagnostic: {
              candidateCount: 4,
              rootTag: 'PRE',
              elementCount: 2,
              textNodeCount: 1,
              otherNodeCount: 0,
              maxDepth: 2,
              tagHistogram: { CODE: 1, PRE: 1 }
            }
          }, {
            order: 1,
            role: 'assistant',
            id: 'assistant-rendered',
            text: 'SMOKE_OK'
          }] : [{ order: 0, role: 'user', id: 'rendered-history', text: 'history', textIdentityReadable: true }],
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: [],
          selectorStop: false,
          sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {}
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt-textarea', sendButton: '#send', stopButton: '#stop' } });
  await assert.rejects(controller.reviewQuery({
      prompt,
      expectedUrl: url,
      expectedConversationId: 'conversation-rendered',
      expectedModel: 'GPT-5.6 Pro',
      timeoutMs: 8_000,
      onUserTurnObserved: async (receipt) => { observedReceipt = receipt; },
      onSubmitted: async (receipt) => { submittedReceipt = receipt; }
    }), /review_user_message_identity_unreadable/);
  assert.equal(strictClicks, 1);
  assert.equal(observedReceipt.observedUserMessageId, 'user-rendered');
  assert.equal(observedReceipt.commitmentClass, 'turn_unreadable');
  assert.equal(observedReceipt.serializerError, 'review_composer_element_unsupported');
  assert.equal(observedReceipt.serializerTag, 'PRE');
  assert.equal(observedReceipt.renderedContentCandidateCount, 4);
  assert.equal(submittedReceipt, null);
});

test('chatgpt-controller: click with no visible new user turn has a distinct terminal classification', async () => {
  const url = 'https://chatgpt.com/c/no-turn-after-click';
  let strictClicks = 0;
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      const legacyComposer = legacyStrictComposerEval(js);
      if (legacyComposer) return legacyComposer;
      if (js.includes('reviewComposerDiagnosticMarker')) {
        return { ok: true, serializerOk: true, serializedLength: 6, expectedLength: 6 };
      }
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) return {
        messages: [{ order: 0, role: 'user', id: 'no-turn-history', text: 'history', textIdentityReadable: true }],
        modelEvidence: 'GPT-5.6 Pro',
        modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [], selectorStop: false, sendVisible: true
      };
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async sendKey() {}, async insertText() {}, async moveMouse() {}, async mouseDown() {}, async mouseUp() {}
  };
  const controller = new ChatGPTController({
    page,
    selectors: { promptTextarea: '#prompt', sendButton: '#send', stopButton: '#stop' }
  });
  await assert.rejects(controller.reviewQuery({
    prompt: 'frozen',
    expectedUrl: url,
    expectedConversationId: 'no-turn-after-click',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 3_700
  }), (error) => {
    assert.equal(error.message, 'review_user_message_not_observed_after_click');
    assert.equal(error.data.commitmentClass, 'click_no_turn');
    assert.equal(error.data.newUserMessageCount, 0);
    return true;
  });
  assert.equal(strictClicks, 1);
});

test('chatgpt-controller: fresh strict review fails busy on an active prior turn', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  let inserted = false;
  let snapshots = 0;
  const page = {
    async navigate() {},
    async getUrl() {
      return url;
    },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('reviewSnapshotMarker')) {
        snapshots += 1;
        return {
          messages: [
            { order: 0, role: 'user', id: 'user-active', text: 'question' },
            { order: 1, role: 'assistant', id: 'assistant-active', text: 'answer' }
          ],
          modelEvidence: 'dynamic label',
          modelEvidenceCandidates: ['GPT-5.6 Pro', 'GPT-5.6 Thinking'],
          controlText: snapshots < 3 ? ['Stop'] : [],
          selectorStop: snapshots < 3,
          sendVisible: true
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText() {
      inserted = true;
    }
  };
  const controller = new ChatGPTController({ page, selectors: { promptTextarea: '#prompt-textarea', sendButton: '#send', stopButton: '#stop' } });
  await assert.rejects(controller.reviewQuery({
      prompt: 'safe',
      expectedUrl: url,
      expectedConversationId: 'conversation-1',
      expectedModel: 'GPT-5.6 Pro',
      timeoutMs: 8_000
    }), /review_tab_busy/);
  assert.equal(inserted, false);
  assert.equal(snapshots, 1);
});

test('chatgpt-controller: crash recovery excludes historical identical prompts by persisted baseline', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  const prompt = 'same prompt';
  let recoveredId = null;
  const page = {
    async getUrl() {
      return url;
    },
    async evaluate(js) {
      assert.equal(js.includes('.click()'), false);
      assert.equal(js.includes('serializeReviewComposer'), true);
      return {
        messages: [
          { order: 0, role: 'user', id: 'historical-user', text: prompt },
          { order: 1, role: 'assistant', id: 'historical-assistant', text: 'old' },
          { order: 2, role: 'user', id: 'current-user', text: prompt },
          { order: 3, role: 'assistant', id: 'current-assistant', text: 'new' }
        ],
        modelEvidence: 'GPT-5.6 Pro',
        modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [],
        selectorStop: false,
        sendVisible: true
      };
    }
  };
  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });
  const result = await controller.recoverReviewSubmission({
    prompt,
    baselineMessageIds: ['historical-user', 'historical-assistant'],
    expectedUrl: url,
    expectedConversationId: 'conversation-1',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 5_000,
    causalSubmissionReceipt: causalReceipt(prompt, ['historical-user', 'historical-assistant']),
    onRecovered: async ({ userMessageId }) => {
      recoveredId = userMessageId;
    }
  });
  assert.equal(recoveredId, 'current-user');
  assert.equal(result.userMessageId, 'current-user');
  assert.equal(result.assistantMessageId, 'current-assistant');
  assert.equal(result.text, 'new');
});

test('chatgpt-controller: crash recovery accepts one attachment-backed message under exact composer causality', async () => {
  const url = 'https://chatgpt.com/c/conversation-attachment';
  const prompt = 'long exact prompt';
  let receipt = null;
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      assert.equal(js.includes('.click()'), false);
      return {
        messages: [
          {
            order: 0,
            role: 'user',
            id: 'attachment-user',
            text: 'Pasted_text.txt',
            textLength: 15,
            textIdentityReadable: false,
            textIdentityDiagnostic: { candidateCount: 4, rootTag: 'PRE' }
          },
          { order: 1, role: 'assistant', id: 'attachment-assistant', text: 'done' }
        ],
        modelEvidence: 'GPT-5.6 Pro',
        modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [],
        selectorStop: false,
        sendVisible: true
      };
    }
  };
  const controller = new ChatGPTController({ page, selectors: {} });
  const result = await controller.recoverReviewSubmission({
    prompt,
    baselineMessageIds: [],
    expectedUrl: url,
    expectedConversationId: 'conversation-attachment',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 5_000,
    causalSubmissionReceipt: causalReceipt(prompt),
    onRecovered: async (value) => { receipt = value; }
  });
  assert.equal(receipt.identityMode, REVIEW_CAUSAL_SUBMISSION_MODEL);
  assert.equal(receipt.newUserMessageCount, 1);
  assert.equal(receipt.renderedIdentityDiagnostic.renderedContentCandidateCount, 4);
  assert.equal(result.userMessageId, 'attachment-user');
  assert.equal(result.assistantMessageId, 'attachment-assistant');
});

test('chatgpt-controller: crash recovery rejects missing causal receipt and ambiguous new messages', async () => {
  const url = 'https://chatgpt.com/c/conversation-recovery-negative';
  let messageCount = 1;
  const page = {
    async getUrl() { return url; },
    async evaluate() {
      return {
        messages: Array.from({ length: messageCount }, (_, index) => ({
          order: index,
          role: 'user',
          id: `user-${index}`,
          text: 'attachment'
        })),
        modelEvidence: 'GPT-5.6 Pro',
        modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: [],
        selectorStop: false,
        sendVisible: true
      };
    }
  };
  const controller = new ChatGPTController({ page, selectors: {} });
  const base = {
    prompt: 'exact prompt',
    baselineMessageIds: [],
    expectedUrl: url,
    expectedConversationId: 'conversation-recovery-negative',
    expectedModel: 'GPT-5.6 Pro',
    timeoutMs: 5_000
  };
  await assert.rejects(controller.recoverReviewSubmission(base), /review_composer_causal_binding_missing/);
  messageCount = 0;
  await assert.rejects(
    controller.recoverReviewSubmission({ ...base, causalSubmissionReceipt: causalReceipt(base.prompt) }),
    /review_user_message_identity_unreadable/
  );
  messageCount = 2;
  await assert.rejects(
    controller.recoverReviewSubmission({ ...base, causalSubmissionReceipt: causalReceipt(base.prompt) }),
    /review_user_message_identity_unreadable/
  );
});

test('chatgpt-controller: observe-only review never activates continuation controls', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  let evalCalls = 0;
  const page = {
    async getUrl() {
      return url;
    },
    async evaluate(js) {
      evalCalls += 1;
      assert.equal(js.includes('.click()'), false);
      return {
        messages: [
          { order: 0, role: 'user', id: 'user-1', text: 'prompt' },
          { order: 1, role: 'assistant', id: 'assistant-1', text: 'partial' }
        ],
        modelEvidence: 'GPT-5.6 Pro',
        modelEvidenceCandidates: ['GPT-5.6 Pro'],
        controlText: ['Continue'],
        selectorStop: false,
        sendVisible: true
      };
    }
  };
  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });
  await assert.rejects(
    controller.observeReviewResponse({
      expectedUrl: url,
      expectedConversationId: 'conversation-1',
      expectedModel: 'GPT-5.6 Pro',
      userMessageId: 'user-1',
      timeoutMs: 650
    }),
    /timeout_waiting_for_response/
  );
  assert.ok(evalCalls >= 1);
});
