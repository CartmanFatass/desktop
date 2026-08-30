import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  ChatGPTController,
  canonicalizeReviewMessageNodes,
  canonicalizeGeminiReviewMessageNodes,
  canonicalizeGeminiModelEvidence,
  classifyChatgptModelControlRoute,
  chatgptExpectedModelSpec,
  chatgptModelLabelMatches,
  classifyBlockedSignals,
  classifyReviewControls,
  deduplicateReviewModelEvidence,
  geminiModelLabelMatches,
  geminiThinkingLabelMatches,
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
        if (failEmpty === true && emptyReads === 2) current = existingDraft || 'rehydrated';
        if (failEmpty === 'persistent' && current === '') current = existingDraft || 'rehydrated';
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
          composerKind: 'contenteditable',
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

  const koreanShortLabels = canonicalizeGeminiModelEvidence([
    { label: 'Pro', visible: true, scoped: true, selected: true, source: 'menu' },
    { label: '확장', visible: true, scoped: true, selected: true, source: 'menu' }
  ], expected);
  assert.equal(koreanShortLabels.matched, true);
  assert.equal(koreanShortLabels.matchedLabel, expected);
  assert.equal(koreanShortLabels.modelLabel, '3.1 Pro');
  assert.equal(koreanShortLabels.thinkingMode, 'Extended thinking');
  assert.equal(geminiModelLabelMatches('Pro', '3.1 Pro'), true);
  assert.equal(geminiModelLabelMatches('Pro', '3.0 Pro'), false);
  assert.equal(geminiThinkingLabelMatches('확장'), true);

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
        matches(selector) { return selector === '#prompt'; },
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


test('chatgpt-controller: submission diagnosis injects the structure summarizer dependency', async () => {
  const url = 'https://chatgpt.com/c/conversation-diagnostic';
  const prompt = 'exact';
  const page = {
    async getUrl() { return url; },
    async evaluate(js) {
      assert.equal(js.includes('reviewSnapshotMarker'), true);
      assert.equal(js.includes('const summarizeReviewComposerStructure ='), true);
      assert.equal(js.includes('renderedProjection: serialized.renderedProjection || null'), true);
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
  assert.equal(result.providerUserMessageCount, 2);
  assert.equal(result.exactMatchCount, 2);
});

test('chatgpt-controller: canonical turn entries collapse duplicate ChatGPT user wrappers but retain distinct turns', () => {
  const turn = (id) => ({ getAttribute: (name) => name === 'data-message-id' ? id : null });
  const node = ({ id, outer = null, inner = null }) => ({
    id: '',
    matches: (selector) => selector === '[data-message-author-role="user"]',
    closest: () => turn(id),
    contains: (other) => other === inner || (outer && other === outer)
  });
  const inner = node({ id: 'same-turn' });
  const outer = node({ id: 'same-turn', inner });
  const distinct = node({ id: 'different-turn' });
  const entries = canonicalizeReviewMessageNodes(
    [inner, outer, distinct],
    '[data-message-author-role="user"]'
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].node, outer);
  assert.deepEqual(entries.map((entry) => entry.identity), ['same-turn', 'different-turn']);
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

test('chatgpt-controller: user-message identity selects the trusted collapsible content sibling', () => {
  const prompt = 'Read https://example.test/repo\nReturn a bounded scientific assessment.';
  const link = elementNode('A', textNode('https://example.test/repo'));
  const toggle = elementNode('BUTTON', textNode('Show moreShow less'));
  toggle.getAttribute = (name) => ({
    'data-testid': 'collapsible-user-message-toggle',
    type: 'button',
    'aria-controls': 'collapsed-content'
  }[name] || null);
  const content = elementNode(
    'DIV',
    elementNode('P', textNode('Read '), link),
    elementNode('P', textNode('Return a bounded scientific assessment.'))
  );
  content.id = 'collapsed-content';
  content.innerText = prompt;
  content.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-content' : null;
  content.querySelectorAll = () => [];
  content.contains = (candidate) => candidate === content || candidate === link;
  const collapsibleRoot = elementNode('DIV', content, toggle);
  collapsibleRoot.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-root' : null;
  const outer = elementNode('DIV', collapsibleRoot);
  outer.querySelectorAll = (selector) => selector.includes('collapsible-user-message-root')
    ? [collapsibleRoot]
    : [content];
  const result = serializeReviewUserMessage(outer);
  assert.equal(result.ok, true);
  assert.equal(result.text, prompt);
  assert.equal(result.tagHistogram.BUTTON, undefined);
  assert.equal(result.tagHistogram.A, 1);
  assert.equal(result.renderedProjection, 'collapsible_inner_text_v1');
});

test('chatgpt-controller: trusted collapsible rendering uses innerText after structural validation', () => {
  const prompt = [
    'Read the remote research context.',
    '',
    'Assess the mechanism and its discriminator.',
    ''
  ].join('\n');
  const paragraphs = Array.from({ length: 9 }, (_, index) => {
    const inline = index === 0
      ? elementNode('A', textNode('remote research context'))
      : textNode(`paragraph-${index}`);
    return elementNode(
      'P',
      inline,
      ...Array.from({ length: index < 8 ? 8 : 7 }, () => elementNode('BR'))
    );
  });
  const content = elementNode('DIV', ...paragraphs);
  content.id = 'collapsed-live-shape';
  content.innerText = prompt.slice(0, -1);
  content.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-content' : null;
  content.querySelectorAll = () => [];
  const toggle = elementNode('BUTTON', textNode('Show moreShow less'));
  toggle.getAttribute = (name) => ({
    'data-testid': 'collapsible-user-message-toggle',
    type: 'button',
    'aria-controls': content.id
  }[name] || null);
  const collapsibleRoot = elementNode('DIV', content, toggle);
  collapsibleRoot.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-root' : null;
  const outer = elementNode('DIV', collapsibleRoot);
  outer.querySelectorAll = (selector) => selector.includes('collapsible-user-message-root')
    ? [collapsibleRoot]
    : [content];

  assert.notEqual(serializeReviewComposer(content).text, content.innerText);
  const result = serializeReviewUserMessage(outer);
  assert.equal(result.ok, true);
  assert.equal(result.text, prompt.slice(0, -1));
  assert.equal(result.renderedProjection, 'collapsible_inner_text_v1');
  assert.deepEqual(result.tagHistogram, { A: 1, BR: 71, DIV: 1, P: 9 });
});

test('chatgpt-controller: collapsible innerText projection never bypasses structural controls', () => {
  for (const control of [
    elementNode('BUTTON', textNode('hidden button')),
    Object.assign(elementNode('DIV', textNode('hidden role control')), {
      getAttribute: (name) => name === 'role' ? 'button' : null
    }),
    elementNode('IMG')
  ]) {
    const content = elementNode('DIV', textNode('exact prompt'), control);
    content.id = 'controlled-content';
    content.innerText = 'exact prompt';
    content.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-content' : null;
    content.querySelectorAll = () => [];
    const toggle = elementNode('BUTTON', textNode('Show moreShow less'));
    toggle.getAttribute = (name) => ({
      'data-testid': 'collapsible-user-message-toggle',
      type: 'button',
      'aria-controls': content.id
    }[name] || null);
    const collapsibleRoot = elementNode('DIV', content, toggle);
    collapsibleRoot.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-root' : null;
    const outer = elementNode('DIV', collapsibleRoot);
    outer.querySelectorAll = (selector) => selector.includes('collapsible-user-message-root')
      ? [collapsibleRoot]
      : [content];

    const result = serializeReviewUserMessage(outer);
    assert.equal(result.ok, false);
    assert.match(result.error, /review_(?:composer_element_unsupported|collapsible_message_structure_unreadable)/);
    assert.equal(JSON.stringify(result).includes('hidden'), false);
  }
});

test('chatgpt-controller: collapsible message chrome fails closed unless it is an exact external sibling', () => {
  const toggle = elementNode('BUTTON', textNode('Show moreShow less'));
  toggle.getAttribute = (name) => ({
    'data-testid': 'collapsible-user-message-toggle',
    type: 'button',
    'aria-controls': 'collapsed-content'
  }[name] || null);
  const content = elementNode('DIV', textNode('prompt'), toggle);
  content.id = 'collapsed-content';
  content.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-content' : null;
  const collapsibleRoot = elementNode('DIV', content);
  collapsibleRoot.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-root' : null;
  const outer = elementNode('DIV', collapsibleRoot);
  outer.querySelectorAll = (selector) => selector.includes('collapsible-user-message-root')
    ? [collapsibleRoot]
    : [content];
  assert.deepEqual(serializeReviewUserMessage(outer), {
    ok: false,
    error: 'review_collapsible_message_structure_unreadable'
  });

  const validContent = elementNode('DIV', textNode('prompt'));
  validContent.id = 'valid-content';
  validContent.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-content' : null;
  const validToggle = elementNode('BUTTON', textNode('Show moreShow less'));
  validToggle.getAttribute = (name) => ({
    'data-testid': 'collapsible-user-message-toggle',
    type: 'button',
    'aria-controls': 'valid-content'
  }[name] || null);
  const extraRoleButton = elementNode('DIV', textNode('unexpected control'));
  extraRoleButton.getAttribute = (name) => name === 'role' ? 'button' : null;
  for (const extraSibling of [
    elementNode('DIV', textNode('unexpected content')),
    elementNode('BUTTON', textNode('unexpected button')),
    extraRoleButton
  ]) {
    const rootWithExtraSibling = elementNode('DIV', validContent, validToggle, extraSibling);
    rootWithExtraSibling.getAttribute = (name) => name === 'data-testid' ? 'collapsible-user-message-root' : null;
    const outerWithExtraSibling = elementNode('DIV', rootWithExtraSibling);
    outerWithExtraSibling.querySelectorAll = (selector) => selector.includes('collapsible-user-message-root')
      ? [rootWithExtraSibling]
      : [validContent];
    assert.deepEqual(serializeReviewUserMessage(outerWithExtraSibling), {
      ok: false,
      error: 'review_collapsible_message_structure_unreadable'
    });
  }
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

test('chatgpt-controller: strict model labels match only after whitespace and case normalization', () => {
  assert.equal(modelLabelMatches('Pro', 'Pro'), true);
  assert.equal(modelLabelMatches('  PRO  ', 'Pro'), true);
  assert.equal(modelLabelMatches('GPT-5.6 Pro', 'Pro'), false);
  assert.equal(modelLabelMatches('Pro', 'GPT-5.6 Pro'), false);
  assert.equal(modelLabelMatches('Pro Extended', 'Pro'), false);
  assert.equal(modelLabelMatches('Pro Standard', 'Pro Extended'), false);
  assert.equal(modelLabelMatches('High', 'Pro'), false);
});

function combinedProControlFixture(scopedMatchCount = 1) {
  let sendActions = 0;
  let pointerActivations = 0;
  let keyActivations = 0;
  const page = {
    async getUrl() { return 'https://chatgpt.com/'; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('agentifyChatgptCombinedProControlStateMarker')) {
        return {
          matched: scopedMatchCount === 1,
          providerVisibleLabel: scopedMatchCount === 1 ? 'Pro' : null,
          selectionView: 'chatgpt_combined_pro_control',
          role: 'button',
          scopedMatchCount
        };
      }
      if (js.includes('reviewSendOnceMarker')) sendActions += 1;
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async moveMouse() { pointerActivations += 1; },
    async mouseDown() { pointerActivations += 1; },
    async mouseUp() { pointerActivations += 1; },
    async sendKey() { keyActivations += 1; }
  };
  return {
    page,
    state: () => ({ sendActions, pointerActivations, keyActivations })
  };
}

test('chatgpt-controller: one visible composer Pro control binds product and effort without UI mutation', async () => {
  const fixture = combinedProControlFixture();
  const controller = new ChatGPTController({ page: fixture.page, selectors: {} });
  const result = await controller.reviewPreflight({
    productModel: 'GPT-5.6 Sol',
    reasoningEffort: 'Pro',
    timeoutMs: 5_000
  });

  assert.equal(result.productModelEvidence.matchedLabel, 'GPT-5.6 Sol');
  assert.equal(result.productModelEvidence.providerVisibleLabel, 'Pro');
  assert.equal(result.productModelEvidence.selectionView, 'chatgpt_combined_pro_control');
  assert.equal(result.reasoningEffortEvidence.matchedLabel, 'Pro');
  assert.equal(result.reasoningEffortEvidence.providerVisibleLabel, 'Pro');
  assert.equal(result.reasoningEffortEvidence.stepCount, 0);
  assert.deepEqual(fixture.state(), {
    sendActions: 0,
    pointerActivations: 0,
    keyActivations: 0
  });
});

test('chatgpt-controller: ambiguous composer Pro controls fail before UI mutation', async () => {
  const fixture = combinedProControlFixture(2);
  const controller = new ChatGPTController({ page: fixture.page, selectors: {} });

  await assert.rejects(
    controller.reviewPreflight({
      productModel: 'GPT-5.6 Sol',
      reasoningEffort: 'Pro',
      timeoutMs: 5_000
    }),
    /chatgpt_combined_pro_control_ambiguous/
  );
  assert.deepEqual(fixture.state(), {
    sendActions: 0,
    pointerActivations: 0,
    keyActivations: 0
  });
});

test('chatgpt-controller: ChatGPT profile snapshot reports aggregate cookie presence and root binding without composer input', async () => {
  const page = {
    async getUrl() { return 'https://chatgpt.com/'; },
    async getCookiePresenceMetadata() {
      return { supported: true, host: 'chatgpt.com', matchingCookieCount: 3, secureCookieCount: 3, httpOnlyCookieCount: 2, sessionCookieCount: 2, persistentCookieCount: 1, nonEmpty: true };
    },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('reviewReasoningEffortDiagnosticMarker')) return { sliderRootCount: 1, sliderCount: 1, min: 0, max: 4, value: 4, renderedLabels: ['Pro'] };
      throw new Error(`unexpected_eval:${js.slice(0, 100)}`);
    },
    async insertText() { throw new Error('profile_snapshot_must_not_insert_prompt'); },
    async sendKey() { throw new Error('profile_snapshot_must_not_send_key'); }
  };
  const controller = new ChatGPTController({ page, selectors: {} });
  const result = await controller.reviewChatGPTProfileSnapshot({ timeoutMs: 5_000 });
  assert.equal(result.urlBinding, 'provider_root');
  assert.equal(result.cookiePresence.matchingCookieCount, 3);
  assert.equal(result.cookiePresence.nonEmpty, true);
  assert.equal(result.visibleControls.promptInsertCount, 0);
  assert.equal(result.sendActivationCount, 0);
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
        assert.doesNotMatch(js, /data-composer-transition-slot/);
        return {
          matched: modelSelected,
          labels: [modelSelected ? 'Pro' : 'High'],
          matchedLabel: modelSelected ? 'Pro' : null
        };
      }
      if (js.includes('agentifyOpenModelPickerMarker')) {
        assert.doesNotMatch(js, /data-composer-transition-slot/);
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
