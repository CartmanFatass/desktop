import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  ChatGPTController,
  classifyReviewControls,
  deduplicateReviewModelEvidence,
  serializeReviewComposer,
  serializeReviewUserMessage,
  summarizeReviewComposerStructure
} from '../chatgpt-controller.mjs';

const textNode = (value) => ({ nodeType: 3, nodeValue: value });
const elementNode = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes });

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

test('chatgpt-controller: user-message identity reads the unique content leaf and excludes controls', () => {
  const content = elementNode('DIV', textNode('alpha\n\nbeta'));
  content.querySelectorAll = () => [];
  const editControl = elementNode('BUTTON', textNode('Edit'));
  const outer = elementNode('DIV', content, editControl);
  outer.querySelectorAll = () => [content];
  assert.deepEqual(serializeReviewUserMessage(outer), {
    ok: true,
    text: 'alpha\n\nbeta',
    candidateCount: 1
  });
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

test('chatgpt-controller: strict review submits with one send control and returns two stable exact-message snapshots', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  const prompt = 'x';
  const keys = [];
  let strictClicks = 0;
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
      if (js.includes('observedLengths')) {
        return { ok: insertedPrompt === prompt, observedLengths: [insertedPrompt.length], expectedLength: prompt.length };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1, label: 'Send prompt' };
      }
      if (js.includes('reviewSnapshotMarker')) {
        const messages = strictClicks
          ? [
              { order: 0, role: 'user', id: 'user-1', text: prompt },
              { order: 1, role: 'assistant', id: 'assistant-1', text: response }
            ]
          : [];
        return {
          messages,
          modelEvidence: 'GPT-5.6 Pro',
          modelEvidenceCandidates: ['GPT-5.6 Pro'],
          controlText: ['Answer now'],
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
      assert.deepEqual(baselineMessageIds, []);
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
  assert.equal(result.controls.answerNow, true);
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
            { order: 0, role: 'user', id: 'user-structural', text: prompt },
            { order: 1, role: 'assistant', id: 'assistant-structural', text: 'OK' }
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

test('chatgpt-controller: strict review fails before send when the composer is not exact', async () => {
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
      if (js.includes('observedLengths')) return { ok: false, observedLengths: [7], expectedLength: 8 };
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        strictClicks += 1;
        return { ok: true, clickCount: 1 };
      }
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
  await assert.rejects(
    controller.reviewQuery({
      prompt: 'mismatch',
      expectedUrl: url,
      expectedConversationId: 'conversation-1',
      expectedModel: 'GPT-5.6 Pro',
      timeoutMs: 8_000
    }),
    /review_composer_identity_mismatch/
  );
  assert.equal(insertCalls, 1);
  assert.equal(strictClicks, 0);
});

test('chatgpt-controller: strict review rechecks exact composer in the send evaluation', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  let sendEvaluationReached = false;
  const page = {
    async navigate() {},
    async getUrl() {
      return url;
    },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('observedLengths')) return { ok: true, observedLengths: [4], expectedLength: 4 };
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('reviewSendOnceMarker')) {
        sendEvaluationReached = true;
        return { ok: false, error: 'review_composer_identity_mismatch' };
      }
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
    /review_composer_identity_mismatch/
  );
  assert.equal(sendEvaluationReached, true);
});

test('chatgpt-controller: strict review rejects conflicting model controls before send', async () => {
  const url = 'https://chatgpt.com/c/conversation-1';
  let inserted = false;
  const page = {
    async navigate() {},
    async getUrl() {
      return url;
    },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('reviewSnapshotMarker')) {
        return {
          messages: [],
          modelEvidence: null,
          modelEvidenceCandidates: ['GPT-5.6 Pro', 'GPT-5.6 Thinking'],
          controlText: [],
          selectorStop: false,
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
  await assert.rejects(
    controller.reviewQuery({
      prompt: 'safe',
      expectedUrl: url,
      expectedConversationId: 'conversation-1',
      expectedModel: 'GPT-5.6 Pro',
      timeoutMs: 5_000
    }),
    /review_model_identity_mismatch/
  );
  assert.equal(inserted, false);
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
          { order: 3, role: 'assistant', id: 'current-assistant', text: 'new' },
          { order: 4, role: 'user', id: 'later-user', text: 'later' },
          { order: 5, role: 'assistant', id: 'later-assistant', text: 'later response' }
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
    onRecovered: async ({ userMessageId }) => {
      recoveredId = userMessageId;
    }
  });
  assert.equal(recoveredId, 'current-user');
  assert.equal(result.userMessageId, 'current-user');
  assert.equal(result.assistantMessageId, 'current-assistant');
  assert.equal(result.text, 'new');
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
