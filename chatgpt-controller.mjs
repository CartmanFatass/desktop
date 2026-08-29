import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  REVIEW_CAUSAL_SUBMISSION_MODEL,
  REVIEW_PLAIN_TEXT_MODEL,
  browserSpaceRebalanceSite,
  canonicalizeReviewPlainText,
  compareReviewPlainText,
  reviewPlainTextIdentity,
  safeReviewPlainTextComparison,
  validateReviewCausalSubmissionReceipt
} from './review-text-identity.mjs';
import {
  REVIEW_COMPOSER_REPLACEMENT_MODEL,
  locateReviewComposer,
  prepareReviewComposerClearSelection,
  positionReviewComposerCaret,
  reviewComposerKind
} from './review-composer-replacement.mjs';
import { NativeOperatorControl } from './operator-control.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const BLOCKED_PAGE_TEXT_PATTERN = /(?:\b403\s+(?:forbidden|error)\b|\bhttp\s*403\b|access denied|request forbidden|unusual traffic|verify you are human|human verification)/i;

export function looksLikeBlockedPage(bodyText) {
  return BLOCKED_PAGE_TEXT_PATTERN.test(String(bodyText || ''));
}

export function classifyBlockedSignals({
  hasTurnstile = false,
  hasArkose = false,
  hasVerifyButton = false,
  looks403 = false,
  loginLike = false,
  promptVisible = false
} = {}) {
  const challenge = !!hasTurnstile || !!hasArkose || !!hasVerifyButton;
  const accessBlocked = !!looks403 && !promptVisible;
  const loginBlocked = !!loginLike && !promptVisible;
  const blocked = challenge || accessBlocked || loginBlocked;
  return {
    blocked,
    kind: !blocked ? null : challenge ? 'captcha' : loginBlocked ? 'login' : 'blocked',
    accessBlocked
  };
}

export function classifyReviewControls(labels, { selectorStop = false, sendVisible = false } = {}) {
  const values = Array.isArray(labels)
    ? labels.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
  const has = (pattern) => values.some((value) => pattern.test(value));
  return {
    stop: !!selectorStop || has(/^(stop|stop generating|stop response|停止|停止生成|停止回答)$/i),
    continue: has(/^(continue|continue generating|continue response|继续|继续生成)$/i),
    retry: has(/^(retry|response retry|try again|retry response|重试|再试一次)$/i),
    answerNow: has(/^(answer now|立即回答)$/i),
    sendVisible: !!sendVisible
  };
}

export function deduplicateReviewModelEvidence(values) {
  const unique = new Map();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').replace(/\s+/g, ' ').trim();
    const token = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (value && token && !unique.has(token)) unique.set(token, value);
  }
  return [...unique.values()];
}

export function modelLabelMatches(actual, expected) {
  const normalize = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const actualLabel = normalize(actual);
  const expectedLabel = normalize(expected);
  return !!actualLabel && actualLabel === expectedLabel;
}

export function chatgptProductModelAlias(expectedModel) {
  const requestedModel = String(expectedModel || '').replace(/\s+/g, ' ').trim();
  const token = requestedModel.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return token === 'gpt56pro' || token === 'gpt56solpro';
}

export function chatgptExpectedModelSpec(expectedModel) {
  const requestedModel = String(expectedModel || '').replace(/\s+/g, ' ').trim();
  if (chatgptProductModelAlias(requestedModel)) {
    return {
      requestedModel,
      visibleLabel: 'Pro',
      canonicalProductModel: 'GPT-5.6 Sol Pro'
    };
  }
  return {
    requestedModel,
    visibleLabel: requestedModel,
    canonicalProductModel: requestedModel
  };
}

export function chatgptModelLabelMatches(actual, expectedModel) {
  const spec = chatgptExpectedModelSpec(expectedModel);
  return modelLabelMatches(actual, spec.requestedModel) ||
    modelLabelMatches(actual, spec.visibleLabel);
}

export function geminiExpectedModelSpec(expectedModel) {
  const original = String(expectedModel || '').replace(/\s+/g, ' ').trim();
  const hasExtendedThinking = /(?:\bextended(?:\s+thinking)?\b|\u6269\u5c55\u601d\u8003|\ud655\uc7a5)/i.test(original);
  const model = original
    .replace(/^gemini\s+/i, '')
    .replace(/(?:\s+extended(?:\s+thinking)?|\s*\u6269\u5c55\u601d\u8003|\s*\ud655\uc7a5)\s*$/i, '')
    .trim();
  return {
    model,
    thinkingMode: hasExtendedThinking ? 'Extended thinking' : null
  };
}

export function geminiModelLabelMatches(actual, expected) {
  const normalize = (value) => String(value || '')
    .replace(/^gemini\s+/i, '')
    .replace(/(?:\s+extended(?:\s+thinking)?|\s*\u6269\u5c55\u601d\u8003)(?:\s|$)/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const actualLabel = normalize(actual);
  const expectedLabel = normalize(expected);
  if (!actualLabel || !expectedLabel) return false;
  if (actualLabel === expectedLabel) return true;
  // Gemini's selected semantic menu label can abbreviate the already-scoped
  // `3.1 Pro` option to `Pro`. This alias is accepted only for that exact
  // expected model; callers still require a visible, menu-scoped selected
  // record and a separately selected thinking-mode record.
  return actualLabel === 'pro' && expectedLabel === '3.1 pro';
}

export function geminiThinkingLabelMatches(actual) {
  const label = String(actual || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return label === 'extended thinking' || label === '\u6269\u5c55\u601d\u8003' || label === '\ud655\uc7a5';
}

export function geminiMenuItemSelected(node) {
  return !!node && (
    /(^|\s)selected(\s|$)/i.test(String(node.className || '')) ||
    node.getAttribute?.('aria-checked') === 'true' ||
    node.getAttribute?.('aria-selected') === 'true' ||
    Array.from(node.querySelectorAll?.('[aria-label]') || [])
      .some((child) => /selected|\u5df2\u9009\u4e2d/i.test(String(child.getAttribute?.('aria-label') || '')))
  );
}

export function geminiMenuItemSemanticLabel(node, visible = () => true) {
  if (!node) return null;
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const labels = Array.from(node.querySelectorAll?.('.label') || [])
    .filter((candidate) => visible(candidate))
    .map((candidate) => normalize(candidate.textContent))
    .filter(Boolean);
  const unique = [...new Set(labels)];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return null;
  const ariaLabel = normalize(node.getAttribute?.('aria-label'));
  return ariaLabel || null;
}

export function canonicalizeGeminiModelEvidence(records, expectedModel) {
  const spec = geminiExpectedModelSpec(expectedModel);
  if (!spec.model) return { matched: false, labels: [], matchedLabel: null, modelLabel: null, thinkingMode: null };
  const accepted = (Array.isArray(records) ? records : [])
    .filter((record) => record?.visible === true && record?.scoped === true)
    .filter((record) => record?.selected === true)
    .map((record) => ({ ...record, label: String(record.label || '').replace(/\s+/g, ' ').trim() }))
    .filter((record) => record.label);
  const cleanModelLabel = (value) => String(value || '')
    .replace(/^gemini\s+/i, '')
    .replace(/(?:\s+extended(?:\s+thinking)?|\s*\u6269\u5c55\u601d\u8003)(?:\s|$)/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const modelRecord = accepted.find((record) => geminiModelLabelMatches(cleanModelLabel(record.label), spec.model)) || null;
  const thinkingRecord = spec.thinkingMode
    ? accepted.find((record) => record !== modelRecord && geminiThinkingLabelMatches(record.label)) || null
    : null;
  const modelLabel = modelRecord ? spec.model : null;
  const matched = !!modelLabel && (!spec.thinkingMode || !!thinkingRecord);
  const matchedLabel = matched
    ? `Gemini ${modelLabel}${spec.thinkingMode ? ' extended' : ''}`
    : null;
  return {
    matched,
    labels: accepted.map((record) => record.label),
    matchedLabel,
    modelLabel,
    thinkingMode: thinkingRecord ? 'Extended thinking' : null
  };
}

export function canonicalizeReviewMessageNodes(nodes, userSelector) {
  const accepted = [];
  for (const node of Array.from(nodes || [])) {
    const role = node?.matches?.(userSelector) ? 'user' : 'assistant';
    const host = node?.closest?.('[data-message-id], [data-turn-id]') || null;
    const identity = String(
      host?.getAttribute?.('data-message-id') || host?.getAttribute?.('data-turn-id') || node?.id || ''
    ).trim();
    const matchingIndex = accepted.findIndex((entry) =>
      entry.role === role && (
        (identity && entry.identity === identity) ||
        entry.node?.contains?.(node) ||
        node?.contains?.(entry.node)
      )
    );
    if (matchingIndex < 0) {
      accepted.push({ node, role, identity });
    } else if (node?.contains?.(accepted[matchingIndex].node)) {
      accepted[matchingIndex] = { node, role, identity };
    }
  }
  return accepted;
}

export const canonicalizeGeminiReviewMessageNodes = canonicalizeReviewMessageNodes;

function reviewConversationId(value) {
  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const marker = parsed.hostname === 'chatgpt.com' ? 'c' : parsed.hostname === 'gemini.google.com' ? 'app' : null;
    const index = marker ? parts.lastIndexOf(marker) : -1;
    return index >= 0 && index + 1 < parts.length ? parts[index + 1] : null;
  } catch {
    return null;
  }
}

function provisionalChatgptConversationId(value) {
  return typeof value === 'string' && value.startsWith('WEB:');
}

export function serializeReviewComposer(root) {
  const inlineTags = new Set([
    'A', 'B', 'CODE', 'EM', 'I', 'MARK', 'S', 'SMALL', 'SPAN', 'STRONG',
    'SUB', 'SUP', 'U'
  ]);
  const blockTags = new Set(['DIV', 'P']);
  const hasButtonRole = (node) => {
    try {
      return String(node?.getAttribute?.('role') || '').toLowerCase() === 'button';
    } catch {
      return true;
    }
  };

  const serializePreCode = (node, requireCodeRoot = false) => {
    if (!node || typeof node !== 'object') {
      return { ok: false, error: 'review_composer_node_unreadable' };
    }
    if (Number(node.nodeType) === 3) {
      return { ok: true, text: String(node.nodeValue ?? '') };
    }
    if (Number(node.nodeType) !== 1) {
      return { ok: false, error: 'review_composer_node_type_unsupported' };
    }
    const tag = String(node.tagName || '').toUpperCase();
    if (hasButtonRole(node)) {
      return { ok: false, error: 'review_composer_element_unsupported', tag };
    }
    if (requireCodeRoot && tag !== 'CODE') {
      return { ok: false, error: 'review_pre_code_shape_unsupported', tag };
    }
    if (!requireCodeRoot && tag === 'BR') return { ok: true, text: '\n' };
    if (!requireCodeRoot && !inlineTags.has(tag)) {
      return { ok: false, error: 'review_pre_code_shape_unsupported', tag };
    }
    let text = '';
    for (const child of Array.from(node.childNodes || [])) {
      const serialized = serializePreCode(child, false);
      if (!serialized.ok) return serialized;
      text += serialized.text;
    }
    return { ok: true, text };
  };

  const serializeNode = (node) => {
    if (!node || typeof node !== 'object') {
      return { ok: false, error: 'review_composer_node_unreadable' };
    }
    if (Number(node.nodeType) === 3) {
      return { ok: true, text: String(node.nodeValue ?? ''), block: false };
    }
    if (Number(node.nodeType) !== 1) {
      return { ok: false, error: 'review_composer_node_type_unsupported' };
    }
    const tag = String(node.tagName || '').toUpperCase();
    if (hasButtonRole(node)) {
      return { ok: false, error: 'review_composer_element_unsupported', tag };
    }
    if (tag === 'BR') return { ok: true, text: '\n', block: false };
    if (tag === 'PRE') {
      const children = Array.from(node.childNodes || []);
      if (
        children.length !== 1 ||
        Number(children[0]?.nodeType) !== 1 ||
        String(children[0]?.tagName || '').toUpperCase() !== 'CODE'
      ) {
        return { ok: false, error: 'review_pre_code_shape_unsupported', tag };
      }
      const code = serializePreCode(children[0], true);
      if (!code.ok) return code;
      return { ok: true, text: code.text, block: true };
    }
    if (!inlineTags.has(tag) && !blockTags.has(tag)) {
      return { ok: false, error: 'review_composer_element_unsupported', tag };
    }
    const children = serializeChildren(node);
    if (!children.ok) return children;
    const childNodes = Array.from(node.childNodes || []);
    const emptyBlockPlaceholder = blockTags.has(tag) &&
      childNodes.length === 1 &&
      Number(childNodes[0]?.nodeType) === 1 &&
      String(childNodes[0]?.tagName || '').toUpperCase() === 'BR';
    return {
      ok: true,
      text: emptyBlockPlaceholder ? '' : children.text,
      block: blockTags.has(tag)
    };
  };

  const serializeChildren = (parent) => {
    const children = Array.from(parent?.childNodes || []);
    let text = '';
    for (let index = 0; index < children.length; index += 1) {
      const current = serializeNode(children[index]);
      if (!current.ok) return current;
      text += current.text;
      if (
        current.block &&
        index + 1 < children.length
      ) {
        text += '\n';
      }
    }
    return { ok: true, text };
  };

  if (!root || typeof root !== 'object' || Number(root.nodeType) !== 1) {
    return { ok: false, error: 'review_composer_root_unreadable' };
  }
  const rootTag = String(root.tagName || '').toUpperCase();
  if (rootTag === 'PRE') {
    const serialized = serializeNode(root);
    return serialized.ok ? { ok: true, text: serialized.text } : serialized;
  }
  if (!inlineTags.has(rootTag) && !blockTags.has(rootTag)) {
    return { ok: false, error: 'review_composer_element_unsupported', tag: rootTag };
  }
  return serializeChildren(root);
}

export function summarizeReviewComposerStructure(root) {
  const tagHistogram = {};
  let elementCount = 0;
  let textNodeCount = 0;
  let otherNodeCount = 0;
  let maxDepth = 0;

  const visit = (node, depth) => {
    if (!node || typeof node !== 'object') return;
    maxDepth = Math.max(maxDepth, depth);
    if (Number(node.nodeType) === 1) {
      elementCount += 1;
      const tag = String(node.tagName || '').toUpperCase() || 'UNKNOWN';
      tagHistogram[tag] = (tagHistogram[tag] || 0) + 1;
    } else if (Number(node.nodeType) === 3) {
      textNodeCount += 1;
    } else {
      otherNodeCount += 1;
    }
    for (const child of Array.from(node.childNodes || [])) visit(child, depth + 1);
  };

  visit(root, 0);
  return {
    rootTag: String(root?.tagName || '').toUpperCase() || null,
    elementCount,
    textNodeCount,
    otherNodeCount,
    maxDepth,
    tagHistogram: Object.fromEntries(Object.entries(tagHistogram).sort(([a], [b]) => a.localeCompare(b)))
  };
}

export function serializeReviewUserMessage(root) {
  if (!root || typeof root !== 'object' || Number(root.nodeType) !== 1) {
    return { ok: false, error: 'review_user_message_root_unreadable' };
  }
  const selector = '[data-message-content], .whitespace-pre-wrap, [class~="whitespace-pre-wrap"]';
  const descendants = typeof root.querySelectorAll === 'function'
    ? Array.from(root.querySelectorAll(selector))
    : [];
  let rootMatches = false;
  try { rootMatches = root.matches?.(selector) === true; } catch {}
  const discovered = [...new Set([...(rootMatches ? [root] : []), ...descendants])];
  const isControl = (node) => {
    const tag = String(node?.tagName || '').toUpperCase();
    const role = String(node?.getAttribute?.('role') || '').toLowerCase();
    return tag === 'BUTTON' || tag === 'A' || role === 'button' || !!node?.closest?.('button, [role="button"], a');
  };
  const contentNodes = discovered.filter((node) => !isControl(node));
  const containsNode = (outer, inner) => {
    if (!outer || !inner || outer === inner) return outer === inner;
    try {
      if (typeof outer.contains === 'function') return outer.contains(inner);
    } catch {}
    for (let parent = inner.parentNode; parent; parent = parent.parentNode) {
      if (parent === outer) return true;
    }
    return false;
  };
  const elementChildren = (node) => Array.from(node?.childNodes || [])
    .filter((child) => Number(child?.nodeType) === 1);
  const testId = (node) => String(node?.getAttribute?.('data-testid') || '');
  const collapsibleRoots = [...new Set([
    ...(testId(root) === 'collapsible-user-message-root' ? [root] : []),
    ...(typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll('[data-testid="collapsible-user-message-root"]'))
        .filter((node) => testId(node) === 'collapsible-user-message-root')
      : [])
  ])];
  let renderedProjection = null;
  let candidates;
  if (collapsibleRoots.length > 0) {
    if (collapsibleRoots.length !== 1) {
      return { ok: false, error: 'review_collapsible_message_structure_unreadable' };
    }
    const directChildren = elementChildren(collapsibleRoots[0]);
    const contents = directChildren.filter((node) => testId(node) === 'collapsible-user-message-content');
    const toggles = directChildren.filter((node) => testId(node) === 'collapsible-user-message-toggle');
    const content = contents[0] || null;
    const toggle = toggles[0] || null;
    const contentId = String(content?.id || content?.getAttribute?.('id') || '');
    const toggleTag = String(toggle?.tagName || '').toUpperCase();
    const toggleType = String(toggle?.getAttribute?.('type') || '').toLowerCase();
    const toggleControls = String(toggle?.getAttribute?.('aria-controls') || '');
    if (
      directChildren.length !== 2 ||
      contents.length !== 1 ||
      toggles.length !== 1 ||
      toggleTag !== 'BUTTON' ||
      toggleType !== 'button' ||
      !contentId ||
      toggleControls !== contentId ||
      containsNode(content, toggle)
    ) {
      return { ok: false, error: 'review_collapsible_message_structure_unreadable' };
    }
    candidates = [content];
    renderedProjection = 'collapsible_inner_text_v1';
  } else {
    candidates = discovered.length
      ? contentNodes.filter((node) => !contentNodes.some((outer) => outer !== node && containsNode(outer, node)))
      : isControl(root) ? [] : [root];
  }
  if (candidates.length === 0) {
    return { ok: false, error: 'review_user_message_content_missing' };
  }
  const serialized = candidates.map((node) => serializeReviewComposer(node));
  const unreadableIndex = serialized.findIndex((entry) => entry.ok !== true);
  const unreadable = unreadableIndex >= 0 ? serialized[unreadableIndex] : null;
  if (unreadable) {
    const structure = summarizeReviewComposerStructure(candidates[unreadableIndex]);
    return {
      ok: false,
      error: unreadable.error || 'review_user_message_content_unreadable',
      tag: unreadable.tag || null,
      candidateCount: candidates.length,
      ...structure
    };
  }
  let projectedTexts;
  if (renderedProjection === 'collapsible_inner_text_v1') {
    projectedTexts = [];
    for (const candidate of candidates) {
      let innerText;
      try { innerText = candidate.innerText; } catch {}
      if (typeof innerText !== 'string') {
        const structure = summarizeReviewComposerStructure(candidate);
        return {
          ok: false,
          error: 'review_collapsible_message_inner_text_unreadable',
          candidateCount: candidates.length,
          ...structure
        };
      }
      projectedTexts.push(innerText);
    }
  } else {
    projectedTexts = serialized.map((entry) => entry.text);
  }
  const exactTexts = [...new Set(projectedTexts)];
  if (exactTexts.length !== 1) {
    return {
      ok: false,
      error: 'review_user_message_content_ambiguous',
      candidateCount: candidates.length,
      distinctTextCount: exactTexts.length
    };
  }
  const structure = candidates.length === 1 ? summarizeReviewComposerStructure(candidates[0]) : {};
  return {
    ok: true,
    text: exactTexts[0],
    candidateCount: candidates.length,
    ...(renderedProjection ? { renderedProjection } : {}),
    ...structure
  };
}

function compareRenderedReviewUserText(expectedPrompt, message, { causalSubmissionAccepted = false } = {}) {
  if (!message || message.textIdentityReadable === false) return null;
  const comparison = safeReviewPlainTextComparison(expectedPrompt, message.text);
  if (comparison.ok === true) return comparison;
  const projection = message.textIdentityDiagnostic?.renderedProjection;
  const expected = canonicalizeReviewPlainText(expectedPrompt);
  const observed = canonicalizeReviewPlainText(message.text);
  if (
    causalSubmissionAccepted &&
    projection === 'collapsible_inner_text_v1' &&
    expected.endsWith('\n') &&
    observed === expected.slice(0, -1)
  ) {
    return {
      ...comparison,
      ok: true,
      identityMode: 'causal_collapsible_inner_text_terminal_lf_projection',
      mismatchClass: null,
      terminalLineFeedElided: true
    };
  }
  return comparison;
}

function jitter(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || 0);
  return Math.floor(min + Math.random() * (max - min + 1));
}

function blockedTitle(kind) {
  if (kind === 'login') return 'Needs sign-in';
  if (kind === 'captcha') return 'Needs CAPTCHA';
  if (kind === 'blocked') return 'Access blocked';
  if (kind === 'ui') return 'Needs page ready';
  return 'Needs attention';
}

class Mutex {
  #p = Promise.resolve();
  async run(fn) {
    const start = this.#p;
    let release;
    this.#p = new Promise((r) => (release = r));
    await start;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ChatGPTController {
  constructor({ page, selectors, onBlocked, onUnblocked, stateDir, operatorControlFactory = null }) {
    this.page = page;
    this.selectors = selectors;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.stateDir = stateDir;
    this.mutex = new Mutex();
    this.blocked = false;
    this.blockedKind = null;
    this.serverId = null;
    this.mouse = { x: 30, y: 30 };
    this.currentRun = null;
    this.operatorControl = typeof operatorControlFactory === 'function'
      ? operatorControlFactory({ page })
      : new NativeOperatorControl({ page });
  }

  async runExclusive(fn) {
    return await this.mutex.run(fn);
  }

  async navigate(url) {
    await this.page.navigate(url);
  }

  async #eval(js) {
    return await this.page.evaluate(js);
  }

  async #emitProgress(patch) {
    if (!this.currentRun?.onProgress || !patch || typeof patch !== 'object') return;
    try {
      await this.currentRun.onProgress({ ...patch });
    } catch {}
  }

  async getUrl() {
    return await this.page.getUrl();
  }

  // The Operator surface is deliberately separate from strict review. It
  // exposes only observed visible controls and one native input event at a
  // time; it has no ledger, provider, or Send capability.
  async operatorObserve({ tabId } = {}) {
    return await this.operatorControl.observe({ tabId });
  }

  async operatorAct(args = {}) {
    return await this.operatorControl.act(args);
  }

  async operatorWait(args = {}) {
    return await this.operatorControl.wait(args);
  }

  async readPageText({ maxChars = 200_000 } = {}) {
    const text = await this.#eval(`(() => {
      const cap = ${maxChars};
      const clean = (s) => String(s || '').replace(/\\u0000/g, '').replace(/\\s+\\n/g, '\\n').trim();
      const root = document.querySelector('main') || document.body || document.documentElement;

      let txt = clean(root?.innerText) || clean(document.body?.innerText) || clean(document.documentElement?.innerText);
      if (!txt) txt = clean(root?.textContent) || clean(document.body?.textContent) || clean(document.documentElement?.textContent);

      // Last fallback for heavily client-rendered/shell pages where innerText may be empty pre-hydration.
      if (!txt) {
        const hints = Array.from(document.querySelectorAll('button, a, input, textarea, [role=\"button\"], [aria-label], [placeholder]'))
          .slice(0, 400)
          .map((n) => [n.getAttribute('aria-label'), n.getAttribute('placeholder'), n.textContent].filter(Boolean).join(' ').trim())
          .filter(Boolean);
        txt = clean(hints.join('\\n'));
      }

      return txt.slice(0, cap);
    })()`);
    return String(text || '');
  }

  async listConversations({ limit = 100 } = {}) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    const conversations = await this.#eval(`(() => {
      const limit = ${cap};
      const seen = new Set();
      const rows = [];
      for (const anchor of document.querySelectorAll('a[href*="/c/"]')) {
        let url = '';
        try { url = new URL(anchor.getAttribute('href') || anchor.href || '', location.href).href; } catch {}
        if (!/^https:\/\/chatgpt\.com\/c\/[^/?#]+/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        const title = String(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        rows.push({ url, title });
        if (rows.length >= limit) break;
      }
      return rows;
    })()`);
    return Array.isArray(conversations) ? conversations : [];
  }

  async newConversation() {
    const current = await this.page.getUrl();
    let target = 'https://chatgpt.com/';
    try {
      const parsed = new URL(current);
      if (parsed.hostname === 'chatgpt.com') target = `${parsed.origin}/`;
    } catch {}
    await this.page.navigate(target);
    return await this.page.getUrl();
  }

  async detectChallenge() {
    const result = await this.#eval(`(() => {
      const classifyBlockedSignals = ${classifyBlockedSignals.toString()};
      const url = location.href || '';
      const title = document.title || '';
      const readyState = document.readyState || '';
      const bodyText = (document.body?.innerText || '').slice(0, 5000);
      const iframeSrcs = Array.from(document.querySelectorAll('iframe'))
        .map(f => String(f.getAttribute('src') || ''))
        .filter(Boolean);
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const hasTurnstile = iframeSrcs.some(s => /turnstile/i.test(s)) || !!document.querySelector('iframe[src*=\"turnstile\" i]');
      const hasArkose = iframeSrcs.some(s => /arkoselabs|arkose/i.test(s)) || !!document.querySelector('iframe[src*=\"arkose\" i], iframe[src*=\"arkoselabs\" i]');
      const hasVerifyButton = Array.from(document.querySelectorAll('button, a'))
        .some(b => /verify you are human|human verification|i am human/i.test((b.textContent || '').trim()));

      const looks403 = new RegExp(${JSON.stringify(BLOCKED_PAGE_TEXT_PATTERN.source)}, 'i').test(bodyText);
      const rawPromptVisible = (() => {
        const pickPrompt = (nodes) => {
          const editable = (n) => {
            if (!n) return false;
            if (!visible(n)) return false;
            if (n.matches('textarea')) return !n.disabled && !n.readOnly;
            if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
            return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
          };
          const score = (n) => {
            const r = n.getBoundingClientRect();
            const label = [
              n.getAttribute('aria-label') || '',
              n.getAttribute('placeholder') || '',
              n.getAttribute('name') || '',
              n.getAttribute('id') || '',
              n.getAttribute('data-testid') || ''
            ].join(' ').toLowerCase();
            let s = 0;
            if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
            if (n.matches('textarea')) s += 50;
            if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
            if (n.getAttribute('role') === 'textbox') s += 25;
            if (r.width >= 260 && r.height >= 26) s += 20;
            s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
            s += Math.max(0, r.y / 8);
            return s;
          };
          let best = null;
          let bestScore = -Infinity;
          for (const n of nodes) {
            if (!editable(n)) continue;
            const s = score(n);
            if (s > bestScore) {
              bestScore = s;
              best = n;
            }
          }
          return best;
        };

        const base = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        return !!pickPrompt(uniq);
      })();

      // Conversation history can legitimately contain authentication language,
      // and ChatGPT can render dormant account controls beside an authenticated
      // conversation. Treat either as an access gate only when there is no
      // usable provider composer; otherwise inspection misclassifies an idle
      // continuation as a login shell before preflight.
      const hasVisiblePasswordInput = Array.from(document.querySelectorAll('input[type=\"password\"], input[name=\"password\"], input[autocomplete=\"current-password\"]'))
        .some(visible);
      const loginLike = hasVisiblePasswordInput
        || (!rawPromptVisible && /log in|sign in|continue with/i.test(bodyText));

      const sendVisible = (() => {
        const labelOf = (n) =>
          [
            n.getAttribute('aria-label') || '',
            n.getAttribute('title') || '',
            n.getAttribute('data-testid') || '',
            n.textContent || ''
          ]
            .join(' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();
        return Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.sendButton)})).some((n) => {
          if (!visible(n)) return false;
          const label = labelOf(n);
          if (/stop|cancel|retry|signin|sign in|log in|login|continue with|google|microsoft|apple/.test(label)) return false;
          return /send|submit|run|go|ask|reply/.test(label) || n.matches('[data-testid=\"send-button\"], [aria-label=\"Send prompt\"], [aria-label=\"Send\"]');
        });
      })();
      // An empty idle composer can deliberately expose a disabled Send control,
      // so writable-composer visibility—not an enabled Send button—is the
      // readiness fact. Strict review validates its unique Send control only
      // after the frozen prompt has been inserted.
      const promptVisible = rawPromptVisible;
      const classification = classifyBlockedSignals({
        hasTurnstile, hasArkose, hasVerifyButton, looks403, loginLike, promptVisible
      });
      const { blocked, kind, accessBlocked } = classification;
      return {
        url, title, readyState,
        blocked,
        promptVisible,
        kind,
        indicators: { hasTurnstile, hasArkose, hasVerifyButton, looks403, accessBlocked, loginLike, rawPromptVisible, sendVisible }
      };
    })()`);

    return result;
  }

  async waitForPromptVisible({ timeoutMs = 10 * 60_000, pollMs = 500 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const st = await this.detectChallenge().catch(() => null);
      if (st?.blocked) await this.#enterBlockedState(st);
      if (st?.promptVisible) return st;

      const elapsed = Date.now() - start;
      if (!this.blocked && elapsed > 5000 && st?.readyState === 'complete') {
        await this.#enterBlockedState({ ...(st || {}), blocked: true, kind: 'ui' });
      }
      await sleep(pollMs);
    }
    const last = await this.detectChallenge().catch(() => null);
    const err = new Error('timeout_waiting_for_prompt');
    err.data = last;
    throw err;
  }

  async ensureReady({ timeoutMs = 10 * 60_000 } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_ready', blocked: false, blockedKind: null, blockedTitle: null });
    const st = await this.detectChallenge().catch(() => null);
    if (st?.blocked) {
      await this.#enterBlockedState(st);
    }
    const ready = await this.waitForPromptVisible({ timeoutMs });
    await this.#exitBlockedStateIfNeeded();
    return ready;
  }

  async #enterBlockedState(st) {
    if (!this.blocked) {
      this.blocked = true;
      this.blockedKind = st?.kind || null;
      await this.#emitProgress({
        phase: 'awaiting_user',
        blocked: true,
        blockedKind: this.blockedKind || 'blocked',
        blockedTitle: blockedTitle(this.blockedKind)
      });
      await this.onBlocked?.(st);
    }
  }

  async #exitBlockedStateIfNeeded() {
    if (this.blocked) {
      this.blocked = false;
      this.blockedKind = null;
      await this.#emitProgress({ blocked: false, blockedKind: null, blockedTitle: null });
      await this.onUnblocked?.();
    }
  }

  async #sendKey(key, { modifiers = [] } = {}) {
    await this.page.sendKey(key, { modifiers });
  }

  #throwIfStopRequested() {
    if (!this.currentRun?.requested) return;
    const err = new Error('query_aborted');
    err.data = {
      reason: this.currentRun.reason || 'user_stop',
      requestedAt: this.currentRun.requestedAt || null
    };
    throw err;
  }

  async #clickVisibleStop() {
    const stopSel = JSON.stringify(this.selectors.stopButton);
    return await this.#eval(`(() => {
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const stop = Array.from(document.querySelectorAll(${stopSel})).find(visible);
      if (!stop) return false;
      try {
        stop.click();
        return true;
      } catch {
        return false;
      }
    })()`);
  }

  async requestStop({ reason = 'user_stop' } = {}) {
    if (this.currentRun) {
      this.currentRun.requested = true;
      this.currentRun.requestedAt = Date.now();
      this.currentRun.reason = reason || 'user_stop';
    }
    const clicked = await this.#clickVisibleStop().catch(() => false);
    return { ok: true, requested: !!this.currentRun || !!clicked, clicked };
  }

  async #typeHuman(text) {
    for (const ch of String(text)) {
      this.#throwIfStopRequested();
      await this.page.insertText(ch);
      await sleep(jitter(12, 45));
    }
  }

  async #moveMouseTo(x, y) {
    const from = { ...this.mouse };
    const steps = Math.max(6, Math.min(22, Math.floor(Math.hypot(x - from.x, y - from.y) / 35)));
    for (let i = 1; i <= steps; i++) {
      this.#throwIfStopRequested();
      const t = i / steps;
      const nx = Math.round(from.x + (x - from.x) * t + jitter(-2, 2));
      const ny = Math.round(from.y + (y - from.y) * t + jitter(-2, 2));
      await this.page.moveMouse(nx, ny);
      await sleep(jitter(6, 18));
      this.mouse = { x: nx, y: ny };
    }
  }

  async #clickAt(x, y) {
    await this.#moveMouseTo(x, y);
    await this.page.mouseDown(x, y, { button: 'left', clickCount: 1 });
    await sleep(jitter(20, 60));
    await this.page.mouseUp(x, y, { button: 'left', clickCount: 1 });
  }

  async #clearReviewComposerOnce() {
    const selector = JSON.stringify(this.selectors.promptTextarea);
    const replacementModel = JSON.stringify(REVIEW_COMPOSER_REPLACEMENT_MODEL);
    const prepared = await this.#eval(`(() => {
      const reviewComposerClearMarker = true;
      const locateReviewComposer = ${locateReviewComposer.toString()};
      const reviewComposerKind = ${reviewComposerKind.toString()};
      const prepareReviewComposerClearSelection = ${prepareReviewComposerClearSelection.toString()};
      const serializeReviewComposer = ${serializeReviewComposer.toString()};
      const summarizeReviewComposerStructure = ${summarizeReviewComposerStructure.toString()};
      const selected = locateReviewComposer(${selector});
      const element = selected.element;
      if (!element) return {
        ok: false,
        error: 'missing_prompt_textarea',
        replacementModel: ${replacementModel},
        candidateCount: selected.candidateCount,
        selectedByPrimary: selected.selectedByPrimary,
        promptInsertCount: 0
      };
      const composerKind = reviewComposerKind(element);
      const initial = composerKind === 'textarea' || composerKind === 'input'
        ? { ok: true, text: String(element.value ?? ''), method: 'value' }
        : { ...serializeReviewComposer(element), method: 'contenteditable_structural' };
      const structure = composerKind === 'textarea' || composerKind === 'input'
        ? {
            rootTag: String(element.tagName || '').toUpperCase() || null,
            elementCount: 1,
            textNodeCount: 0,
            otherNodeCount: 0,
            maxDepth: 0,
            tagHistogram: { [String(element.tagName || '').toUpperCase() || 'UNKNOWN']: 1 }
          }
        : summarizeReviewComposerStructure(element);
      if (initial.ok !== true) return {
        ok: false,
        error: initial.error || 'review_composer_initial_identity_unreadable',
        replacementModel: ${replacementModel},
        composerKind,
        candidateCount: selected.candidateCount,
        selectedByPrimary: selected.selectedByPrimary,
        initialSerializerOk: false,
        initialSerializedLength: null,
        serializerMethod: initial.method,
        serializerError: initial.error || null,
        serializerTag: initial.tag || null,
        promptInsertCount: 0,
        ...structure
      };
      const cleared = prepareReviewComposerClearSelection(element, {
        hasContent: String(initial.text ?? '').length > 0
      });
      return {
        ...cleared,
        replacementModel: ${replacementModel},
        candidateCount: selected.candidateCount,
        selectedByPrimary: selected.selectedByPrimary,
        initialSerializerOk: initial.ok === true,
        initialSerializedLength: initial.ok === true ? String(initial.text ?? '').length : null,
        serializerMethod: initial.method,
        serializerError: initial.error || null,
        serializerTag: initial.tag || null,
        promptInsertCount: 0,
        ...structure
      };
    })()`);
    if (prepared?.ok === true && prepared.deleteKeyRequired === true) {
      await this.#sendKey('Backspace');
      return { ...prepared, deleteKeyCount: 1 };
    }
    return { ...prepared, deleteKeyCount: 0 };
  }

  async #inspectReviewComposerEmpty() {
    const selector = JSON.stringify(this.selectors.promptTextarea);
    const replacementModel = JSON.stringify(REVIEW_COMPOSER_REPLACEMENT_MODEL);
    return await this.#eval(`(() => {
      const reviewComposerEmptyMarker = true;
      const locateReviewComposer = ${locateReviewComposer.toString()};
      const reviewComposerKind = ${reviewComposerKind.toString()};
      const serializeReviewComposer = ${serializeReviewComposer.toString()};
      const summarizeReviewComposerStructure = ${summarizeReviewComposerStructure.toString()};
      const selected = locateReviewComposer(${selector});
      const element = selected.element;
      if (!element) return {
        ok: false,
        error: 'missing_prompt_textarea',
        replacementModel: ${replacementModel},
        candidateCount: selected.candidateCount,
        selectedByPrimary: selected.selectedByPrimary,
        serializedLength: 0
      };
      const composerKind = reviewComposerKind(element);
      const serialized = composerKind === 'textarea' || composerKind === 'input'
        ? { ok: true, text: String(element.value ?? ''), method: 'value' }
        : { ...serializeReviewComposer(element), method: 'contenteditable_structural' };
      const structure = composerKind === 'textarea' || composerKind === 'input'
        ? {
            rootTag: String(element.tagName || '').toUpperCase() || null,
            elementCount: 1,
            textNodeCount: 0,
            otherNodeCount: 0,
            maxDepth: 0,
            tagHistogram: { [String(element.tagName || '').toUpperCase() || 'UNKNOWN']: 1 }
          }
        : summarizeReviewComposerStructure(element);
      return {
        ok: serialized.ok === true && serialized.text === '',
        replacementModel: ${replacementModel},
        composerKind,
        candidateCount: selected.candidateCount,
        serializerOk: serialized.ok === true,
        serializerMethod: serialized.method,
        serializerError: serialized.error || (serialized.text === '' ? null : 'review_composer_not_empty'),
        serializerTag: serialized.tag || null,
        serializedLength: serialized.ok === true ? String(serialized.text ?? '').length : 0,
        ...structure
      };
    })()`);
  }

  async #nativeClearReviewComposerOnce() {
    const selector = JSON.stringify(this.selectors.promptTextarea);
    const focused = await this.#eval(`(() => {
      const reviewComposerNativeClearMarker = true;
      const locateReviewComposer = ${locateReviewComposer.toString()};
      const reviewComposerKind = ${reviewComposerKind.toString()};
      const selected = locateReviewComposer(${selector});
      const element = selected.element;
      if (!element) return {
        ok: false,
        error: 'missing_prompt_textarea',
        candidateCount: selected.candidateCount
      };
      element.focus();
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return {
        ok: false,
        error: 'review_composer_native_clear_target_unavailable',
        candidateCount: selected.candidateCount
      };
      return {
        ok: true,
        composerKind: reviewComposerKind(element),
        candidateCount: selected.candidateCount,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      };
    })()`);
    if (focused?.ok !== true) return { ...(focused || {}), deleteKeyCount: 0 };
    const rect = focused.rect;
    await this.#clickAt(
      Math.round(rect.x + Math.min(rect.w - 6, 18)),
      Math.round(rect.y + Math.min(rect.h - 6, 18))
    );
    const isMac = process.platform === 'darwin';
    await this.#sendKey('A', { modifiers: [isMac ? 'meta' : 'control'] });
    await this.#sendKey('Backspace');
    await sleep(75);
    return {
      ok: true,
      composerKind: focused.composerKind,
      candidateCount: focused.candidateCount,
      clearMethod: 'native_select_all_backspace',
      selectionVerified: false,
      deleteKeyCount: 1
    };
  }

  #composerReplacementError(code, receipt, extra = {}) {
    const error = new Error(code);
    error.data = {
      ...(receipt || {}),
      ...extra,
      ok: false,
      noClickProven: true,
      failureStage: 'before_prompt_insert',
      promptInsertCount: 0
    };
    return error;
  }

  async #verifyReviewComposerEmpty() {
    let last = null;
    for (let index = 0; index < 2; index += 1) {
      if (index > 0) await sleep(75);
      last = await this.#inspectReviewComposerEmpty();
      if (
        last?.ok !== true ||
        last.replacementModel !== REVIEW_COMPOSER_REPLACEMENT_MODEL ||
        last.serializedLength !== 0
      ) {
        throw this.#composerReplacementError('review_composer_clear_failed', last, {
          predicate: last?.error || last?.serializerError || 'review_composer_not_empty',
          emptyVerified: false,
          emptySnapshotCount: index
        });
      }
    }
    return {
      emptyVerified: true,
      emptySnapshotCount: 2,
      composerKind: last.composerKind,
      emptySerializerMethod: last.serializerMethod
    };
  }

  async #prepareReviewComposerInsertion() {
    const selector = JSON.stringify(this.selectors.promptTextarea);
    const replacementModel = JSON.stringify(REVIEW_COMPOSER_REPLACEMENT_MODEL);
    return await this.#eval(`(() => {
      const reviewComposerCaretMarker = true;
      const locateReviewComposer = ${locateReviewComposer.toString()};
      const reviewComposerKind = ${reviewComposerKind.toString()};
      const positionReviewComposerCaret = ${positionReviewComposerCaret.toString()};
      const serializeReviewComposer = ${serializeReviewComposer.toString()};
      const selected = locateReviewComposer(${selector});
      const element = selected.element;
      if (!element) return {
        ok: false,
        error: 'missing_prompt_textarea',
        replacementModel: ${replacementModel},
        candidateCount: selected.candidateCount,
        serializedLength: 0
      };
      const composerKind = reviewComposerKind(element);
      const serialized = composerKind === 'textarea' || composerKind === 'input'
        ? { ok: true, text: String(element.value ?? '') }
        : serializeReviewComposer(element);
      if (serialized.ok !== true || serialized.text !== '') return {
        ok: false,
        error: serialized.error || 'review_composer_not_empty_before_insert',
        replacementModel: ${replacementModel},
        composerKind,
        candidateCount: selected.candidateCount,
        serializerOk: serialized.ok === true,
        serializedLength: serialized.ok === true ? String(serialized.text ?? '').length : 0
      };
      return {
        ...positionReviewComposerCaret(element),
        replacementModel: ${replacementModel},
        candidateCount: selected.candidateCount,
        serializedLength: 0
      };
    })()`);
  }

  async #replacePrompt(prompt, { human = true, verifyExact = false } = {}) {
    await this.#emitProgress({ phase: 'typing_prompt' });
    const existingIdentity = verifyExact
      ? await this.inspectReviewComposerIdentity({ expectedPrompt: prompt })
      : null;
    const exactExisting =
      existingIdentity?.ok === true &&
      existingIdentity.textModel === REVIEW_PLAIN_TEXT_MODEL &&
      existingIdentity.serializerOk === true &&
      ['contenteditable', 'textarea', 'input'].includes(existingIdentity.composerKind) &&
      /^[0-9a-f]{64}$/.test(String(existingIdentity.sourceSha256 || '')) &&
      /^[0-9a-f]{64}$/.test(String(existingIdentity.canonicalPromptSha256 || '')) &&
      existingIdentity.canonicalPromptSha256 === existingIdentity.observedCanonicalSha256;
    if (exactExisting) {
      return {
        ...existingIdentity,
        replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
        composerPreparationMode: 'retained_exact',
        composerKind: existingIdentity.composerKind,
        clearMethod: 'not_required_exact_existing',
        selectionVerified: false,
        deleteKeyCount: 0,
        initialSerializerOk: existingIdentity.serializerOk === true,
        initialSerializedLength: existingIdentity.serializedLength,
        emptyVerified: false,
        emptySnapshotCount: 0,
        caretVerified: false,
        caretMethod: 'not_required_exact_existing',
        promptInsertCount: 0
      };
    }

    let clearAction = await this.#clearReviewComposerOnce();
    let nativeFallback = null;
    const applyNativeFallback = async () => {
      nativeFallback = await this.#nativeClearReviewComposerOnce();
      if (nativeFallback?.ok !== true) {
        throw this.#composerReplacementError('review_composer_clear_failed', nativeFallback, {
          predicate: nativeFallback?.error || 'review_composer_native_clear_failed',
          emptyVerified: false,
          emptySnapshotCount: 0
        });
      }
    };
    if (clearAction?.ok !== true || clearAction.replacementModel !== REVIEW_COMPOSER_REPLACEMENT_MODEL) {
      await applyNativeFallback();
    }
    let emptyReceipt;
    try {
      emptyReceipt = await this.#verifyReviewComposerEmpty();
    } catch (error) {
      if (nativeFallback || error?.message !== 'review_composer_clear_failed') throw error;
      await applyNativeFallback();
      emptyReceipt = await this.#verifyReviewComposerEmpty();
    }
    const caretReceipt = await this.#prepareReviewComposerInsertion();
    if (
      caretReceipt?.ok !== true ||
      caretReceipt.replacementModel !== REVIEW_COMPOSER_REPLACEMENT_MODEL ||
      caretReceipt.serializedLength !== 0
    ) {
      throw this.#composerReplacementError('review_composer_caret_unavailable', caretReceipt, {
        predicate: caretReceipt?.error || 'review_composer_caret_unavailable',
        ...emptyReceipt
      });
    }

    if (human) {
      await this.#typeHuman(prompt);
    } else {
      await this.page.insertText(prompt);
    }
    const promptInsertCount = human ? Array.from(String(prompt)).length : 1;
    const initialDeleteKeyCount = Number(clearAction?.deleteKeyCount || 0);
    const replacementReceipt = {
      replacementModel: REVIEW_COMPOSER_REPLACEMENT_MODEL,
      composerPreparationMode: 'replaced',
      composerKind: caretReceipt.composerKind,
      clearMethod: nativeFallback
        ? clearAction?.ok === true
          ? `${clearAction.clearMethod}_then_native_select_all_backspace`
          : 'native_select_all_backspace'
        : clearAction.clearMethod,
      selectionVerified: clearAction?.selectionVerified === true,
      deleteKeyCount: initialDeleteKeyCount + Number(nativeFallback?.deleteKeyCount || 0),
      initialSerializerOk: clearAction?.initialSerializerOk ?? existingIdentity?.serializerOk ?? null,
      initialSerializedLength: clearAction?.initialSerializedLength ?? existingIdentity?.serializedLength ?? null,
      emptyVerified: emptyReceipt.emptyVerified,
      emptySnapshotCount: emptyReceipt.emptySnapshotCount,
      caretVerified: true,
      caretMethod: caretReceipt.caretMethod,
      promptInsertCount
    };

    let identityReceipt = replacementReceipt;
    if (verifyExact) {
      const verification = await this.inspectReviewComposerIdentity({ expectedPrompt: prompt });
      if (!verification?.ok) {
        const error = new Error('review_composer_identity_mismatch');
        error.data = { ...(verification || {}), ...replacementReceipt };
        throw error;
      }
      identityReceipt = { ...verification, ...replacementReceipt };
    }
    return identityReceipt;
  }

  async #typePrompt(prompt, { human = true, verifyExact = false } = {}) {
    await this.#emitProgress({ phase: 'typing_prompt' });
    const sel = JSON.stringify(this.selectors.promptTextarea);
    const ok = await this.#eval(`(() => {
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const score = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8); // lower on page is more likely the composer
        return s;
      };
      const base = Array.from(document.querySelectorAll(${sel}));
      const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
      const candidates = [];
      const seen = new Set();
      for (const n of [...base, ...fallback]) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        candidates.push(n);
      }
      let el = null;
      let best = -Infinity;
      for (const n of candidates) {
        if (!editable(n)) continue;
        const s = score(n);
        if (s > best) {
          best = s;
          el = n;
        }
      }
      if (!el) return { ok:false, error:'missing_prompt_textarea' };
      el.focus();
      const r = el.getBoundingClientRect();
      return { ok:true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    })()`);
    if (!ok?.ok) {
      const err = new Error(ok?.error || 'type_failed');
      err.data = ok;
      throw err;
    }

    // Human-like click + select-all + type.
    if (ok?.rect?.w > 0 && ok?.rect?.h > 0) {
      const cx = Math.round(ok.rect.x + Math.min(ok.rect.w - 6, 18));
      const cy = Math.round(ok.rect.y + Math.min(ok.rect.h - 6, 18));
      await this.#clickAt(cx, cy);
    }

    const isMac = process.platform === 'darwin';
    await sleep(jitter(25, 80));
    await this.#sendKey('A', { modifiers: [isMac ? 'meta' : 'control'] });
    await sleep(jitter(15, 50));
    await this.#sendKey('Backspace');
    await sleep(jitter(25, 80));
    if (human) {
      await this.#typeHuman(prompt);
    } else {
      await this.page.insertText(prompt);
    }

    let identityReceipt = null;
    if (verifyExact) {
      const verification = await this.inspectReviewComposerIdentity({ expectedPrompt: prompt });
      if (!verification?.ok) {
        const error = new Error('review_composer_identity_mismatch');
        error.data = verification || null;
        throw error;
      }
      identityReceipt = verification;
    }
    return identityReceipt;
  }

  async inspectReviewComposerIdentity({ expectedPrompt = '' } = {}) {
    if (typeof expectedPrompt !== 'string') throw new Error('review_composer_expected_prompt_invalid');
    const sel = JSON.stringify(this.selectors.promptTextarea);
    const expected = JSON.stringify(expectedPrompt);
    const textModel = JSON.stringify(REVIEW_PLAIN_TEXT_MODEL);
    return await this.#eval(`(async () => {
        const reviewComposerDiagnosticMarker = true;
        const expected = ${expected};
        const REVIEW_PLAIN_TEXT_MODEL = ${textModel};
        const canonicalizeReviewPlainText = ${canonicalizeReviewPlainText.toString()};
        const browserSpaceRebalanceSite = ${browserSpaceRebalanceSite.toString()};
        const compareReviewPlainText = ${compareReviewPlainText.toString()};
        const locateReviewComposer = ${locateReviewComposer.toString()};
        const serializeReviewComposer = ${serializeReviewComposer.toString()};
        const summarizeReviewComposerStructure = ${summarizeReviewComposerStructure.toString()};
        const sha256Hex = async (value) => {
          const bytes = new TextEncoder().encode(String(value ?? ''));
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        };
        const selected = locateReviewComposer(${sel});
        const el = selected.element;
        if (!el) {
          return {
            ok: false,
            error: 'missing_prompt_textarea',
            candidateCount: selected.candidateCount,
            selectedByPrimary: selected.selectedByPrimary,
            expectedLength: expected.length
          };
        }
        const serialized = el.matches('textarea, input')
          ? { ok: true, text: String(el.value || ''), method: 'value' }
          : { ...serializeReviewComposer(el), method: 'contenteditable_structural' };
        const structure = el.matches('textarea, input')
          ? {
              rootTag: String(el.tagName || '').toUpperCase() || null,
              elementCount: 1,
              textNodeCount: 0,
              otherNodeCount: 0,
              maxDepth: 0,
              tagHistogram: { [String(el.tagName || '').toUpperCase() || 'UNKNOWN']: 1 }
            }
          : summarizeReviewComposerStructure(el);
        const observed = el.matches('textarea, input')
          ? [String(el.value || '')]
          : [String(el.innerText || ''), String(el.textContent || '')];
        const digestCache = new Map();
        const digest = async (value) => {
          const key = String(value ?? '');
          if (!digestCache.has(key)) digestCache.set(key, await sha256Hex(key));
          return digestCache.get(key);
        };
        const comparison = serialized.ok === true
          ? compareReviewPlainText(expected, serialized.text)
          : null;
        const sourceSha256 = await digest(expected);
        const canonicalPromptSha256 = await digest(canonicalizeReviewPlainText(expected));
        const observedRawSha256 = await digest(serialized.ok === true ? serialized.text : '');
        const observedCanonicalSha256 = await digest(comparison?.canonicalObservedText || '');
        const exactIdentity =
          serialized.ok === true &&
          comparison?.ok === true &&
          canonicalPromptSha256 === observedCanonicalSha256;
        return {
          ok: exactIdentity,
          composerKind: el.matches('textarea') ? 'textarea' : el.matches('input') ? 'input' : 'contenteditable',
          candidateCount: selected.candidateCount,
          selectedByPrimary: selected.selectedByPrimary,
          serializerOk: serialized.ok === true,
          serializerMethod: serialized.method,
          serializerError: serialized.error || null,
          serializerTag: serialized.tag || null,
          serializedLength: String(serialized.text || '').length,
          observedLengths: observed.map(value => value.length),
          expectedLength: expected.length,
          textModel: REVIEW_PLAIN_TEXT_MODEL,
          identityMode: comparison?.identityMode || 'unreadable',
          sourceSha256,
          canonicalPromptSha256,
          observedRawSha256,
          observedCanonicalSha256,
          browserSpaceRebalanceCount: comparison?.browserSpaceRebalanceCount || 0,
          mismatchCount: comparison?.mismatchCount || 0,
          mismatchClass: comparison?.mismatchClass || null,
          firstMismatchCodePointIndex: comparison?.firstMismatchCodePointIndex ?? null,
          firstMismatchExpectedCodePoint: comparison?.firstMismatchExpectedCodePoint || null,
          firstMismatchObservedCodePoint: comparison?.firstMismatchObservedCodePoint || null,
          ...structure
        };
      })()`);
  }

  async #waitForSendSignal({ timeoutMs = 1800, pollMs = 120 } = {}) {
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const stopVisible = Array.from(document.querySelectorAll(${stopSel})).some(visible);
        const send = Array.from(document.querySelectorAll(${sendSel})).find(visible);
        const sendDisabled = !!send && !!send.disabled;

        const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        let promptLen = -1;
        for (const n of uniq) {
          if (!visible(n)) continue;
          if (n.matches('textarea, input')) {
            promptLen = String(n.value || '').trim().length;
            break;
          }
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox') {
            promptLen = String(n.innerText || n.textContent || '').trim().length;
            break;
          }
        }
        return { stopVisible, sendDisabled, promptLen };
      })()`);

      if (snap?.stopVisible || snap?.sendDisabled || snap?.promptLen === 0) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async #composerCleared({ timeoutMs = 2000, pollMs = 150 } = {}) {
    // The authoritative postcondition of a successful send: the composer that
    // held the prompt is empty. #waitForSendSignal can report a false positive
    // when its promptLen probe lands on a different (empty) textbox, so a
    // "sent" signal is only trusted once the real composer has drained.
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const len = await this.#eval(`(() => {
        const composerClearedMarker = true;
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const candidates = Array.from(document.querySelectorAll(${promptSel}))
          .concat(Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"]')));
        let max = 0;
        const seen = new Set();
        for (const n of candidates) {
          if (!n || seen.has(n) || !visible(n)) continue;
          seen.add(n);
          const txt = n.matches('textarea, input') ? String(n.value || '') : String(n.innerText || n.textContent || '');
          max = Math.max(max, txt.trim().length);
        }
        return max;
      })()`);
      if (Number(len) === 0) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async #clickSend() {
    await this.#emitProgress({ phase: 'sending_prompt' });
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const res = await this.#eval(`(() => {
      const stop = Array.from(document.querySelectorAll(${stopSel})).find((n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      if (stop) return { ok:false, error:'already_generating' };
      const host = location.hostname || '';
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const labelOf = (n) =>
        [
          n.getAttribute('aria-label') || '',
          n.getAttribute('title') || '',
          n.getAttribute('data-testid') || '',
          n.textContent || ''
        ]
          .join(' ')
          .replace(/\\s+/g, ' ')
          .trim()
          .toLowerCase();
      const promptScore = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8);
        return s;
      };
      const pickPrompt = () => {
        const base = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const candidates = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          candidates.push(n);
        }
        let best = null;
        let bestScore = -Infinity;
        for (const n of candidates) {
          if (!editable(n)) continue;
          const s = promptScore(n);
          if (s > bestScore) {
            bestScore = s;
            best = n;
          }
        }
        return best;
      };
      const prompt = pickPrompt();
      const composerRoot =
        prompt?.closest('form') ||
        prompt?.closest('[data-testid*=\"composer\" i], [data-testid*=\"prompt\" i], [data-testid*=\"chat-input\" i], [aria-label*=\"message\" i], [aria-label*=\"prompt\" i]') ||
        prompt?.closest('main') ||
        null;
      const promptRect = prompt ? prompt.getBoundingClientRect() : null;
      const score = (n) => {
        const r = n.getBoundingClientRect();
        const label = labelOf(n);
        let s = 0;
        if (n.matches(${sendSel})) s += 120;
        if (/send|submit|run|go|ask|reply/.test(label)) s += 90;
        if (/stop|cancel|retry|signin|sign in|log in|google/.test(label)) s -= 140;
        if (n.getAttribute('type') === 'submit') s += 35;
        if (composerRoot && composerRoot.contains(n)) s += 160;
        if (r.width >= 16 && r.height >= 16) s += 10;
        s += Math.max(0, r.y / 10);
        s += Math.max(0, r.x / 20);
        if (promptRect) {
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const dx = Math.abs(cx - (promptRect.x + promptRect.width));
          const dy = Math.abs(cy - (promptRect.y + promptRect.height / 2));
          s += Math.max(0, 140 - dx / 6 - dy / 4);
        }
        return s;
      };
      const pool = [];
      const seen = new Set();
      const localPool = composerRoot ? [...composerRoot.querySelectorAll(${sendSel}), ...composerRoot.querySelectorAll('button, [role=\"button\"]')] : [];
      for (const n of [...localPool, ...document.querySelectorAll(${sendSel}), ...document.querySelectorAll('button, [role=\"button\"]')]) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        pool.push(n);
      }
      let btn = null;
      let best = -Infinity;
      for (const n of pool) {
        if (!visible(n) || disabled(n)) continue;
        const s = score(n);
        if (s > best) {
          best = s;
          btn = n;
        }
      }
      if (!btn) return { ok:true, fallbackEnter:true, requestSubmit: !!prompt?.closest('form'), host };
      const r = btn.getBoundingClientRect();
      return {
        ok:true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        requestSubmit: !!prompt?.closest('form'),
        host
      };
    })()`);
    if (!res?.ok) {
      const err = new Error(res?.error || 'send_failed');
      err.data = res;
      throw err;
    }

    let sent = false;
    if (res?.rect?.w > 0 && res?.rect?.h > 0) {
      this.#throwIfStopRequested();
      const cx = Math.round(res.rect.x + res.rect.w / 2);
      const cy = Math.round(res.rect.y + res.rect.h / 2);
      await this.#clickAt(cx, cy);
      sent = await this.#waitForSendSignal({ timeoutMs: 2200, pollMs: 120 });
      if (sent && !(await this.#composerCleared())) sent = false;
    }

    if (!sent && !res?.fallbackEnter) {
      this.#throwIfStopRequested();
      await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        const prompt = uniq.find(editable) || document.activeElement;
        const form = prompt?.closest?.('form') || null;
        if (form && typeof form.requestSubmit === 'function') {
          const submitBtn = Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n));
          form.requestSubmit(submitBtn || undefined);
          return true;
        }
        const submitBtn = form
          ? Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n))
          : document.querySelector(${sendSel});
        if (submitBtn) {
          submitBtn.click();
          return true;
        }
        return false;
      })()`);
      sent = await this.#waitForSendSignal({ timeoutMs: 1400, pollMs: 120 });
      if (sent && !(await this.#composerCleared())) sent = false;
    }

    if (!sent) {
      const host = String(res?.host || '');
      const isMac = process.platform === 'darwin';
      const combos = [];
      if (host.includes('aistudio.google.com')) {
        combos.push(['Enter', ['alt']]);
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', []]);
      } else if (host.includes('grok.com')) {
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', []]);
      } else {
        combos.push(['Enter', []]);
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', ['alt']]);
      }

      for (const [key, modifiers] of combos) {
        this.#throwIfStopRequested();
        await sleep(jitter(25, 90));
        await this.#sendKey(key, { modifiers });
        sent = await this.#waitForSendSignal({ timeoutMs: 1500, pollMs: 120 });
        if (sent && !(await this.#composerCleared())) sent = false;
        if (sent) break;
      }
    }

    if (!sent) {
      const err = new Error('send_not_triggered');
      err.data = { host: res?.host || null };
      throw err;
    }
  }

  async #attachFiles(files) {
    if (!files?.length) return;
    await this.#emitProgress({ phase: 'uploading_files' });
    const absFiles = files.map((p) => path.resolve(p));
    for (const f of absFiles) await fs.access(f);

    // Best-effort: click the paperclip/attach UI, then set <input type=file> via DevTools protocol.
    await this.#eval(`(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role=\"button\"]'));
      const attach = candidates.find(b => /attach|upload|paperclip/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')));
      if (attach) attach.click();
      return true;
    })()`);

    await this.page.setFileInputFiles(absFiles);
  }

  async #readExpectedModelState(expectedModel) {
    const expected = String(expectedModel || '').trim();
    if (!expected) return { matched: true, labels: [], matchedLabel: null };
    let isGemini = false;
    try { isGemini = new URL(await this.page.getUrl()).hostname === 'gemini.google.com'; } catch {}
    if (isGemini) {
      return await this.#eval(`(() => {
        const agentifyGeminiModelStateMarker = true;
        const modelLabelMatches = ${modelLabelMatches.toString()};
        const geminiModelLabelMatches = ${geminiModelLabelMatches.toString()};
        const geminiThinkingLabelMatches = ${geminiThinkingLabelMatches.toString()};
        const geminiMenuItemSelected = ${geminiMenuItemSelected.toString()};
        const geminiMenuItemSemanticLabel = ${geminiMenuItemSemanticLabel.toString()};
        const geminiExpectedModelSpec = ${geminiExpectedModelSpec.toString()};
        const canonicalizeGeminiModelEvidence = ${canonicalizeGeminiModelEvidence.toString()};
        const visible = (node) => {
          const rect = node?.getBoundingClientRect?.();
          const style = node ? window.getComputedStyle(node) : null;
          return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
        };
        // Gemini's mode trigger is localized.  Prefer the stable test id when
        // available, but accept the visible semantic trigger observed in the
        // live UI rather than inferring selection from its abbreviated label.
        const triggerRoots = Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i]')).filter(visible);
        const controlledMenuIds = new Set(triggerRoots.flatMap((node) =>
          String(node.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)
        ));
        const menuRoots = Array.from(document.querySelectorAll('[data-test-id="gem-mode-menu"], [role="menu"]'))
          .filter(visible)
          .filter((node) => node.getAttribute('data-test-id') === 'gem-mode-menu' || controlledMenuIds.has(String(node.id || '')))
          .filter((node) => node.querySelector('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]'));
        const records = [];
        for (const root of menuRoots) {
          for (const node of root.querySelectorAll('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]')) {
            records.push({
              label: geminiMenuItemSemanticLabel(node, visible),
              visible: visible(node),
              scoped: true,
              selected: geminiMenuItemSelected(node),
              source: 'menu'
            });
          }
        }
        return canonicalizeGeminiModelEvidence(records, ${JSON.stringify(expected)});
      })()`);
    }
    const expectedSpec = chatgptExpectedModelSpec(expected);
    const visibleExpected = expectedSpec.visibleLabel;
    const productModelRequest = chatgptProductModelAlias(expected);
    // ChatGPT exposes provider-model identity and an optional High/Pro
    // reasoning-strength axis as different controls. The exact caller value
    // decides which surface is relevant; a full model label never creates an
    // implicit requirement to inspect or change the reasoning-strength axis.
    const reasoningModePicker = 'button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]';
    const promptSelector = this.selectors.promptTextarea || '#prompt-textarea';
    const state = await this.#eval(`(() => {
      const agentifyModelStateMarker = true;
      const agentifyReasoningControlScopeMarker = true;
      const modelLabelMatches = ${modelLabelMatches.toString()};
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        const style = node ? window.getComputedStyle(node) : null;
        return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
      };
      const expected = ${JSON.stringify(visibleExpected)};
      const productModelRequest = ${JSON.stringify(productModelRequest)};
      const promptNode = document.querySelector(${JSON.stringify(promptSelector)});
      const composerRoot = promptNode?.closest?.('form') || promptNode?.parentElement?.parentElement?.parentElement || null;
      const semanticLabel = (node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim();
      const expectsReasoningStrength = !productModelRequest && /^(?:high|pro)$/i.test(expected);
      if (!expectsReasoningStrength) {
        const exactModelControls = Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter(visible)
          .filter((node) => !node.closest('[role="menu"], [role="listbox"]'))
          .map((node) => {
            const label = semanticLabel(node);
            const testId = String(node.getAttribute('data-testid') || '');
            const aria = String(node.getAttribute('aria-label') || '');
            const route = testId === 'model-switcher-dropdown-button' || /model/i.test(aria)
              ? 'semantic_model_switcher'
              : !productModelRequest && composerRoot?.contains?.(node) && /^(?:menu|listbox)$/i.test(String(node.getAttribute('aria-haspopup') || ''))
                ? 'composer_model_control'
                : null;
            return { label, route };
          })
          .filter((record) => record.route && modelLabelMatches(record.label, expected));
        const matchedLabel = exactModelControls.length === 1 ? exactModelControls[0].label : null;
        return {
          matched: !!matchedLabel,
          labels: exactModelControls.map((record) => record.label),
          matchedLabel,
          routeEvidence: exactModelControls.length === 1 ? exactModelControls[0].route : null,
          scopedMatchCount: exactModelControls.length
        };
      }
      const modeItems = (root) => Array.from(root?.querySelectorAll?.('[role="menuitemradio"], [role="menuitem"], [role="option"], [data-testid*="model-option" i], [data-radix-collection-item]') || []);
      const routeFor = (node) => {
        if (composerRoot?.contains?.(node)) return 'composer_reasoning_control';
        if (node.getAttribute('data-testid') === 'model-switcher-dropdown-button') return 'semantic_model_switcher';
        const controlledIds = String(node.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
        const controlsModeMenu = controlledIds.some((id) => {
          const root = document.getElementById(id);
          const labels = modeItems(root).map(semanticLabel);
          return labels.some((label) => /^(?:high|pro)$/i.test(label));
        });
        return controlsModeMenu ? 'controlled_reasoning_menu' : null;
      };
      const records = Array.from(document.querySelectorAll(${JSON.stringify(reasoningModePicker)}))
        .filter(visible)
        .filter((node) => !node.closest('[role="menu"], [role="listbox"]'))
        .map((node) => ({ node, label: semanticLabel(node), route: routeFor(node) }))
        .filter((record) => record.route && /^(?:high|pro)$/i.test(record.label));
      const labels = records.map((record) => record.label);
      const matched = records.filter((record) => modelLabelMatches(record.label, expected));
      const matchedLabel = matched.length === 1 ? matched[0].label : null;
      return {
        matched: !!matchedLabel,
        labels,
        matchedLabel,
        routeEvidence: matched.length === 1 ? matched[0].route : null,
        scopedMatchCount: matched.length
      };
    })()`);
    return {
      ...state,
      requestedModel: expectedSpec.requestedModel,
      canonicalProductModel: expectedSpec.canonicalProductModel
    };
  }

  async #ensureExpectedModel(expectedModel, timeoutMs = 20_000) {
    const expected = String(expectedModel || '').trim();
    if (!expected) return null;
    let isGemini = false;
    try { isGemini = new URL(await this.page.getUrl()).hostname === 'gemini.google.com'; } catch {}
    if (isGemini) return await this.#ensureGeminiExpectedModel(expected, timeoutMs);
    const expectedSpec = chatgptExpectedModelSpec(expected);
    const visibleExpected = expectedSpec.visibleLabel;
    const productModelRequest = chatgptProductModelAlias(expected);
    const expectsReasoningStrength = !productModelRequest && /^(?:high|pro)$/i.test(visibleExpected);
    const reasoningModePicker = 'button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]';
    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    let state = null;
    let opened = null;
    await this.#emitProgress({ phase: 'selecting_model' });
    while (Date.now() < deadline) {
      state = await this.#readExpectedModelState(expected);
      if (state?.matched) return {
        ...state,
        selectionMethod: expectsReasoningStrength
          ? 'already_selected_visible_reasoning_mode'
          : 'already_selected_visible_model'
      };
      if (!expectsReasoningStrength) {
        const error = new Error('expected_model_unavailable');
        error.data = {
          expectedModel: expected,
          expectedVisibleLabel: visibleExpected,
          availableModels: state?.labels || []
        };
        throw error;
      }
      opened = await this.#eval(`(() => {
        const agentifyOpenModelPickerMarker = true;
        const visible = (node) => {
          const rect = node?.getBoundingClientRect?.();
          const style = node ? window.getComputedStyle(node) : null;
          return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
        };
        const pickers = Array.from(document.querySelectorAll(${JSON.stringify(reasoningModePicker)}))
          .filter((node) => visible(node) && node.matches('button, [role="button"]'))
          .filter((node) => !node.closest('[role="menu"], [role="listbox"]'))
          .filter((node) => /^(?:high|pro)$/i.test(String(node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
        if (pickers.length !== 1) return { ok: false, error: 'reasoning_mode_selector_unavailable', pickerCount: pickers.length };
        const picker = pickers[0];
        const controlledIds = String(picker.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
        if (!controlledIds.length) return { ok: false, error: 'reasoning_mode_menu_unbound' };
        const rect = picker.getBoundingClientRect();
        return { ok: true, controlledIds, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
      })()`);
      // Some fresh tabs expose the same visible High/Pro trigger directly at
      // the composer but omit aria-controls. Keep it separate from arbitrary
      // composer menus: there must be exactly one visible exact mode label,
      // and post-open selection below still requires one mode-bearing menu.
      if (!opened?.ok && opened?.error === 'reasoning_mode_menu_unbound') {
        opened = await this.#eval(`(() => {
          const agentifyOpenUnboundLocalReasoningModePickerMarker = true;
          const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            const style = node ? window.getComputedStyle(node) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
          };
          const label = (node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim();
          const pickers = Array.from(document.querySelectorAll(${JSON.stringify(reasoningModePicker)}))
            .filter((node) => visible(node) && node.matches('button, [role="button"]'))
            .filter((node) => !node.closest('[role="menu"], [role="listbox"]'))
            .filter((node) => /^(?:high|pro)$/i.test(label(node)))
            .filter((node) => !String(node.getAttribute('aria-controls') || '').trim());
          if (pickers.length !== 1) return { ok: false, error: 'reasoning_mode_unbound_local_selector_unavailable', pickerCount: pickers.length };
          const rect = pickers[0].getBoundingClientRect();
          return { ok: true, controlledIds: [], route: 'local_visible_unbound_reasoning_mode', rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        })()`);
      }
      // The current ChatGPT page can expose its High/Pro reasoning control
      // behind a visible top-level `ChatGPT`/mode trigger rather than beside
      // the composer.  That trigger is eligible only when it explicitly
      // controls one visible menu/listbox, so this is not a generic chrome
      // click or a model/account inference.
      if (!opened?.ok && opened?.error === 'reasoning_mode_selector_unavailable') {
        opened = await this.#eval(`(() => {
          const agentifyOpenPageReasoningModePickerMarker = true;
          const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            const style = node ? window.getComputedStyle(node) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
          };
          const semanticName = (node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim();
          const controls = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter((node) => visible(node) && !node.closest('[role="menu"], [role="listbox"]'))
            .map((node) => ({ node, name: semanticName(node), controlledIds: String(node.getAttribute('aria-controls') || '').split(/\\s+/).filter(Boolean) }))
            .filter(({ node, name, controlledIds }) => {
              const popup = /^(?:menu|listbox)$/i.test(String(node.getAttribute('aria-haspopup') || ''));
              const semantic = /^(?:chatgpt|reasoning(?: mode| strength)?|mode|thinking)$/i.test(name);
              return popup && semantic && controlledIds.length > 0;
            });
          if (controls.length !== 1) return { ok: false, error: 'reasoning_mode_page_selector_unavailable', pickerCount: controls.length };
          const picker = controls[0].node;
          const rect = picker.getBoundingClientRect();
          return { ok: true, controlledIds: controls[0].controlledIds, route: 'page_visible_top_level_controlled_menu', rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        })()`);
      }
      // One observed ChatGPT state exposes its header trigger as the visible
      // semantic `Model Selector` button without aria-controls. It is safe
      // only when this exact visible test-id/name is unique; selection below
      // then accepts one visible mode-bearing menu/listbox only. No unrelated
      // popup may satisfy this fallback.
      if (!opened?.ok && opened?.error === 'reasoning_mode_page_selector_unavailable') {
        opened = await this.#eval(`(() => {
          const agentifyOpenUnboundPageReasoningModePickerMarker = true;
          const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            const style = node ? window.getComputedStyle(node) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
          };
          const semanticName = (node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim();
          const controls = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter((node) => visible(node) && !node.closest('[role="menu"], [role="listbox"]'))
            .filter((node) => /^(?:menu|listbox)$/i.test(String(node.getAttribute('aria-haspopup') || '')))
            .filter((node) => node.getAttribute('data-testid') === 'model-switcher-dropdown-button' || /^model selector$/i.test(semanticName(node)));
          if (controls.length !== 1) return { ok: false, error: 'reasoning_mode_unbound_page_selector_unavailable', pickerCount: controls.length };
          const rect = controls[0].getBoundingClientRect();
          return { ok: true, controlledIds: [], route: 'page_visible_semantic_model_selector', rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        })()`);
      }
      if (opened?.ok) {
        await this.#clickAt(opened.rect.x + opened.rect.w / 2, opened.rect.y + opened.rect.h / 2);
        break;
      }
      await sleep(200);
    }
    if (!opened?.ok) throw new Error(opened?.error || 'model_switcher_unavailable');
    await sleep(250);

    let chosen = null;
    while (Date.now() < deadline) {
      chosen = await this.#eval(`(() => {
        const agentifyChooseModelMarker = true;
        const modelLabelMatches = ${modelLabelMatches.toString()};
        const visible = (node) => {
          const rect = node?.getBoundingClientRect?.();
          const style = node ? window.getComputedStyle(node) : null;
          return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
        };
        const expected = ${JSON.stringify(visibleExpected)};
        const controlledIds = new Set(${JSON.stringify(opened?.controlledIds || [])});
        const route = ${JSON.stringify(opened?.route || '')};
        const menuItems = (root) => Array.from(root.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], [data-testid*="model-option" i], [data-radix-collection-item]')).filter(visible);
        const exactMode = (node) => modelLabelMatches(String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim(), expected);
        const roots = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]'))
          .filter(visible)
          .filter((node) => controlledIds.size > 0 ? controlledIds.has(String(node.id || '')) : /^(?:local_visible_unbound_reasoning_mode|page_visible_semantic_model_selector)$/.test(route) && menuItems(node).some(exactMode));
        if (roots.length !== 1) return { ok: false, error: 'reasoning_mode_menu_ambiguous', labels: roots.flatMap(menuItems).map((node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean) };
        const visibleCandidates = menuItems(roots[0]).filter(exactMode);
        const labels = visibleCandidates
          .map((node) => String(node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const candidates = visibleCandidates
          .filter((node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase() === expected.toLowerCase());
        const target = candidates[0] || null;
        if (!target || candidates.length !== 1) return { ok: false, error: 'expected_reasoning_mode_unavailable', labels };
        const rect = target.getBoundingClientRect();
        return { ok: true, labels, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
      })()`);
      if (chosen?.ok) {
        await this.#clickAt(chosen.rect.x + chosen.rect.w / 2, chosen.rect.y + chosen.rect.h / 2);
        break;
      }
      await sleep(200);
    }
    if (!chosen?.ok) {
      const err = new Error(chosen?.error || 'expected_reasoning_mode_unavailable');
      err.data = {
        expectedModel: expected,
        expectedVisibleLabel: visibleExpected,
        availableModes: chosen?.labels || []
      };
      throw err;
    }

    while (Date.now() < deadline) {
      state = await this.#readExpectedModelState(expected);
      if (state?.matched) return {
        ...state,
        selectionMethod: opened?.route === 'page_visible_top_level_controlled_menu'
          ? 'page_visible_top_level_controlled_menu_exact_reasoning_mode_option'
          : opened?.route === 'page_visible_semantic_model_selector'
            ? 'page_visible_semantic_model_selector_exact_reasoning_mode_option'
            : opened?.route === 'local_visible_unbound_reasoning_mode'
              ? 'local_visible_unbound_reasoning_mode_exact_option'
            : 'visible_exact_reasoning_mode_option'
      };
      await sleep(200);
    }
    throw new Error('expected_reasoning_mode_switch_unconfirmed');
  }

  async #ensureGeminiExpectedModel(expectedModel, timeoutMs = 20_000) {
    const expected = String(expectedModel || '').trim();
    const spec = geminiExpectedModelSpec(expected);
    if (!spec.model) throw new Error('expected_model_unavailable');
    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    await this.#emitProgress({ phase: 'selecting_model' });
    let state = await this.#readExpectedModelState(expected);
    if (state?.matched) return state;

    const choose = async (targetKind, targetLabel) => {
      let last = null;
      while (Date.now() < deadline) {
        last = await this.#eval(`(() => {
          const agentifyGeminiChooseModelPartMarker = true;
          const geminiModelLabelMatches = ${geminiModelLabelMatches.toString()};
          const geminiThinkingLabelMatches = ${geminiThinkingLabelMatches.toString()};
          const geminiMenuItemSelected = ${geminiMenuItemSelected.toString()};
          const geminiMenuItemSemanticLabel = ${geminiMenuItemSemanticLabel.toString()};
          const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            const style = node ? window.getComputedStyle(node) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
          };
          const triggers = Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i]')).filter(visible);
          const controlledMenuIds = new Set(triggers.flatMap((node) => String(node.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)));
          const roots = Array.from(document.querySelectorAll('[data-test-id="gem-mode-menu"], [role="menu"]'))
            .filter(visible)
            .filter((node) => node.getAttribute('data-test-id') === 'gem-mode-menu' || controlledMenuIds.has(String(node.id || '')))
            .filter((node) => node.querySelector('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]'));
          const candidates = roots.flatMap((root) => Array.from(root.querySelectorAll('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]')).filter(visible));
          const labels = candidates.map((node) => geminiMenuItemSemanticLabel(node, visible)).filter(Boolean);
          const target = candidates.find((node) => {
            const label = geminiMenuItemSemanticLabel(node, visible);
            return ${JSON.stringify(targetKind)} === 'thinking'
              ? geminiThinkingLabelMatches(label)
              : geminiModelLabelMatches(label, ${JSON.stringify(targetLabel)});
          }) || null;
          if (!target) return { ok: false, error: 'expected_model_unavailable', labels };
          const rect = target.getBoundingClientRect();
          return { ok: true, alreadySelected: geminiMenuItemSelected(target), labels, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        })()`);
        if (last?.ok) {
          let selected = !!last.alreadySelected;
          if (!last.alreadySelected) {
            // Gemini can accept a CDP press as focus-only (data-active) while
            // leaving the visible menu item unselected.  Activate the exact
            // visible semantic control first, then retain the CDP click only
            // as a bounded fallback when the selected state did not commit.
            // This remains wholly pre-send and the subsequent state read is
            // still authoritative.
            const activation = await this.#eval(`(() => {
              const agentifyGeminiFallbackModelPartMarker = true;
              const geminiModelLabelMatches = ${geminiModelLabelMatches.toString()};
              const geminiThinkingLabelMatches = ${geminiThinkingLabelMatches.toString()};
              const geminiMenuItemSelected = ${geminiMenuItemSelected.toString()};
              const geminiMenuItemSemanticLabel = ${geminiMenuItemSemanticLabel.toString()};
              const visible = (node) => {
                const rect = node?.getBoundingClientRect?.();
                const style = node ? window.getComputedStyle(node) : null;
                return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
              };
              const triggers = Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i]')).filter(visible);
              const controlledMenuIds = new Set(triggers.flatMap((node) => String(node.getAttribute('aria-controls') || '').split(/\\s+/).filter(Boolean)));
              const roots = Array.from(document.querySelectorAll('[data-test-id="gem-mode-menu"], [role="menu"]'))
                .filter(visible)
                .filter((node) => node.getAttribute('data-test-id') === 'gem-mode-menu' || controlledMenuIds.has(String(node.id || '')))
                .filter((node) => node.querySelector('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]'));
              const candidates = roots.flatMap((root) => Array.from(root.querySelectorAll('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]')).filter(visible));
              const target = candidates.find((node) => {
                const label = geminiMenuItemSemanticLabel(node, visible);
                return ${JSON.stringify(targetKind)} === 'thinking'
                  ? geminiThinkingLabelMatches(label)
                  : geminiModelLabelMatches(label, ${JSON.stringify(targetLabel)});
              }) || null;
              if (!target || geminiMenuItemSelected(target)) return { activated: false, selected: !!target && geminiMenuItemSelected(target) };
              try { target.click(); } catch { return { activated: false, selected: false }; }
              return { activated: true, selected: geminiMenuItemSelected(target) };
            })()`);
            selected = activation?.selected === true;
            if (!activation?.selected) {
              await this.#clickAt(last.rect.x + last.rect.w / 2, last.rect.y + last.rect.h / 2);
              await sleep(250);
            }
          }
          await sleep(250);
          return { selected };
        }
        const opened = await this.#eval(`(() => {
          const agentifyGeminiOpenModelMenuMarker = true;
          const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            const style = node ? window.getComputedStyle(node) : null;
            return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
          };
          const localizedModeSelector = String.fromCodePoint(0x6a21, 0x5f0f, 0x9009, 0x62e9, 0x5668);
          const candidates = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
          const target = candidates.find((node) => {
            const aria = String(node.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes(localizedModeSelector) || aria.includes('mode selector');
          }) || null;
          if (!target) return { ok: false, error: 'model_switcher_unavailable' };
          try { target.click(); } catch { return { ok: false, error: 'model_switcher_activation_failed' }; }
          return { ok: true, activated: true };
        })()`);
        if (opened?.ok) {
          await sleep(250);
        } else {
          await sleep(200);
        }
      }
      const error = new Error(last?.error || 'expected_model_unavailable');
      error.data = { expectedModel: expected, expectedPart: targetKind, availableModels: last?.labels || [] };
      throw error;
    };

    const modelSelection = state?.modelLabel ? { selected: true } : await choose('model', spec.model);
    const modelSelected = !!state?.modelLabel || modelSelection?.selected === true;
    const thinkingSelection = spec.thinkingMode && !state?.thinkingMode
      ? await choose('thinking', spec.thinkingMode)
      : { selected: true };
    const thinkingSelected = !spec.thinkingMode || !!state?.thinkingMode || thinkingSelection?.selected === true;
    // The picker closes immediately after a successful Gemini selection.  The
    // direct activation above already observed the same visible semantic menu
    // item in its selected state, so do not discard that fact merely because a
    // later closed-menu read has no records.
    if (modelSelected && thinkingSelected) {
      return {
        matched: true,
        labels: [spec.model, ...(spec.thinkingMode ? [spec.thinkingMode] : [])],
        matchedLabel: `Gemini ${spec.model}${spec.thinkingMode ? ' extended' : ''}`,
        modelLabel: spec.model,
        thinkingMode: spec.thinkingMode || null
      };
    }
    while (Date.now() < deadline) {
      state = await this.#readExpectedModelState(expected);
      if (state?.matched) return state;
      const openedForVerification = await this.#eval(`(() => {
        const agentifyGeminiOpenModelVerificationMarker = true;
        const visible = (node) => {
          const rect = node?.getBoundingClientRect?.();
          const style = node ? window.getComputedStyle(node) : null;
          return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
        };
        const trigger = Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"] button, [data-test-id="bard-mode-menu-button"] [role="button"], [data-test-id="bard-mode-menu-button"], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i]')).find(visible) || null;
        const controlledIds = new Set(trigger ? String(trigger.getAttribute('aria-controls') || trigger.closest('[aria-controls]')?.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean) : []);
        const menuOpen = Array.from(document.querySelectorAll('[data-test-id="gem-mode-menu"], [role="menu"]'))
          .filter(visible)
          .some((node) => node.getAttribute('data-test-id') === 'gem-mode-menu' || controlledIds.has(String(node.id || '')));
        if (menuOpen) return { ok: true, alreadyOpen: true };
        if (!trigger) return { ok: false, error: 'model_switcher_unavailable' };
        try { trigger.click(); } catch { return { ok: false, error: 'model_switcher_activation_failed' }; }
        return { ok: true, alreadyOpen: false, activated: true };
      })()`);
      await sleep(200);
    }
    throw new Error('expected_model_switch_unconfirmed');
  }

  async #captureGeminiSelectedModel(timeoutMs = 20_000) {
    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    while (Date.now() < deadline) {
      const state = await this.#eval(`(() => {
        const visible = (node) => { const r = node?.getBoundingClientRect?.(); const s = node ? window.getComputedStyle(node) : null; return !!r && r.width > 0 && r.height > 0 && s?.visibility !== 'hidden' && s?.display !== 'none'; };
        const selected = (node) => node?.getAttribute('aria-selected') === 'true' || node?.getAttribute('aria-checked') === 'true' || node?.classList?.contains('selected') || !!node?.querySelector?.('[aria-selected="true"], [aria-checked="true"], .selected');
        const label = (node) => String(node?.querySelector?.('.label')?.textContent || node?.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim();
        const roots = Array.from(document.querySelectorAll('[data-test-id="gem-mode-menu"], [role="menu"]')).filter(visible);
        const labels = roots.flatMap((root) => Array.from(root.querySelectorAll('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]')).filter(visible).filter(selected).map(label).filter(Boolean));
        // A bootstrap records the actual selected model; it must not guess a
        // family label (for example, infer Pro from a closed trigger).  The
        // only semantic distinction needed here is the separately selected
        // thinking-mode item.
        const model = labels.filter((value) => !/(?:thinking|思考|확장)/i.test(value));
        const thinking = labels.filter((value) => /(?:thinking|思考|확장)/i.test(value));
        return { model, thinking };
      })()`);
      if (state?.model?.length === 1 && state.thinking?.length <= 1) {
        const matchedLabel = `Gemini ${state.model[0]}${state.thinking[0] ? ' extended' : ''}`;
        await this.#eval(`(() => { const n = Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"] button, [data-test-id="bard-mode-menu-button"] [role="button"], [data-test-id="bard-mode-menu-button"], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i]')).find((x) => { const r=x.getBoundingClientRect(); return r.width>0&&r.height>0; }); n?.click?.(); return !!n; })()`);
        await sleep(150);
        return { matched: true, matchedLabel, modelLabel: state.model[0], thinkingMode: state.thinking[0] || null };
      }
      const opened = await this.#eval(`(() => { const n = Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"] button, [data-test-id="bard-mode-menu-button"] [role="button"], [data-test-id="bard-mode-menu-button"], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i]')).find((x) => { const r=x.getBoundingClientRect(); return r.width>0&&r.height>0; }); if (!n) return { ok:false }; n.click(); return { ok:true }; })()`);
      if (!opened?.ok) throw new Error('model_switcher_unavailable');
      await sleep(250);
    }
    throw new Error('selected_model_unreadable');
  }

  async #completionMetadata(expectedModel = '', verifiedModelState = null) {
    const conversationUrl = await this.page.getUrl();
    const conversationId = reviewConversationId(conversationUrl);
    let hostname = '';
    try { hostname = new URL(conversationUrl).hostname; } catch {}
    if (hostname === 'chatgpt.com' && !conversationId) throw new Error('conversation_identity_unreadable');
    const expected = String(expectedModel || '').trim();
    const modelState = expected && verifiedModelState?.matched && verifiedModelState?.matchedLabel
      ? verifiedModelState
      : expected ? await this.#readExpectedModelState(expected) : null;
    if (expected && !modelState?.matched) throw new Error('expected_model_switch_unconfirmed');
    return {
      status: 'COMPLETE',
      conversationUrl,
      conversationId,
      modelEvidence: modelState?.matchedLabel || null
    };
  }

  async #reviewSnapshot(expectedModel = '') {
    const url = await this.page.getUrl();
    const isGemini = (() => {
      try { return new URL(url).hostname === 'gemini.google.com'; } catch { return false; }
    })();
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const expectedModelLiteral = JSON.stringify(String(expectedModel || ''));
    const reviewUserSel = JSON.stringify(isGemini
      ? 'user-query, [data-test-id="user-query"], [data-message-author-role="user"]'
      : this.selectors.reviewUserMessage || '[data-message-author-role="user"]');
    const reviewAssistantSel = JSON.stringify(isGemini
      ? 'model-response, [data-test-id="model-response"], [data-message-author-role="assistant"]'
      : this.selectors.reviewAssistantMessage || '[data-message-author-role="assistant"]');
    const isGeminiLiteral = JSON.stringify(isGemini);
    const reviewModelSel = JSON.stringify(
      this.selectors.reviewModelEvidence || 'button[data-testid*="model" i], [role="button"][data-testid*="model" i], button[aria-label*="model" i], [role="button"][aria-label*="model" i]'
    );
    const dom = await this.#eval(`(() => {
      const reviewSnapshotMarker = true;
      const serializeReviewComposer = ${serializeReviewComposer.toString()};
      const summarizeReviewComposerStructure = ${summarizeReviewComposerStructure.toString()};
      const serializeReviewUserMessage = ${serializeReviewUserMessage.toString()};
      const deduplicateReviewModelEvidence = ${deduplicateReviewModelEvidence.toString()};
      const canonicalizeReviewMessageNodes = ${canonicalizeReviewMessageNodes.toString()};
      const geminiModelLabelMatches = ${geminiModelLabelMatches.toString()};
      const geminiThinkingLabelMatches = ${geminiThinkingLabelMatches.toString()};
      const geminiMenuItemSelected = ${geminiMenuItemSelected.toString()};
      const geminiMenuItemSemanticLabel = ${geminiMenuItemSemanticLabel.toString()};
      const geminiExpectedModelSpec = ${geminiExpectedModelSpec.toString()};
      const canonicalizeGeminiModelEvidence = ${canonicalizeGeminiModelEvidence.toString()};
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const identity = (node, role, order) => {
        const host = node?.closest?.('[data-message-id], [data-turn-id]') || null;
        const exact = String(
          host?.getAttribute?.('data-message-id') || host?.getAttribute?.('data-turn-id') || node?.id || ''
        ).trim();
        return exact || (${isGeminiLiteral} ? role + ':' + order : '');
      };
      const messageNodes = Array.from(document.querySelectorAll(${reviewUserSel} + ', ' + ${reviewAssistantSel}));
      const messageEntries = canonicalizeReviewMessageNodes(messageNodes, ${reviewUserSel});
      const messages = messageEntries.map(({ node, role, identity: canonicalIdentity }, order) => {
          const serialized = role === 'user'
            ? serializeReviewUserMessage(node)
            : { ok: true, text: String(node.innerText || '') };
          return {
            order,
            role,
            id: canonicalIdentity || identity(node, role, order),
            text: serialized.ok === true ? serialized.text : null,
            textLength: serialized.ok === true ? serialized.text.length : null,
            textIdentityReadable: serialized.ok === true,
            textIdentityError: serialized.error || null,
            textIdentityTag: serialized.tag || null,
            textIdentityDiagnostic: {
              renderedProjection: serialized.renderedProjection || null,
              candidateCount: serialized.candidateCount ?? null,
              rootTag: serialized.rootTag || null,
              elementCount: serialized.elementCount ?? null,
              textNodeCount: serialized.textNodeCount ?? null,
              otherNodeCount: serialized.otherNodeCount ?? null,
              maxDepth: serialized.maxDepth ?? null,
              tagHistogram: serialized.tagHistogram || null
            }
          };
        });
      const controls = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(visible);
      const controlText = controls.flatMap((node) => [
        node.getAttribute('aria-label') || '',
        node.getAttribute('data-testid') || '',
        node.textContent || ''
      ]).map(value => String(value).replace(/\s+/g, ' ').trim()).filter(Boolean);
      const selectorStop = Array.from(document.querySelectorAll(${stopSel})).some(visible);
      const semanticModelNodes = Array.from(document.querySelectorAll(${reviewModelSel}))
        .filter((node) => visible(node) && String(node.textContent || '').trim());
      const normalizeModel = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const expectedModel = ${expectedModelLiteral};
      const promptNode = document.querySelector(${promptSel});
      const composerRoot = promptNode?.closest?.('form') || promptNode?.parentElement?.parentElement?.parentElement || null;
      const composerModelNodes = expectedModel && composerRoot
        ? Array.from(composerRoot.querySelectorAll('button, [role="button"]'))
          .filter(visible)
          .filter((node) => {
            const value = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            return value && normalizeModel(value) === normalizeModel(expectedModel);
          })
        : [];
      // ChatGPT's current composer can expose its selected-model pill outside
      // the prompt root.  Keep the existing composer-scoped check first, then
      // accept one visible menu trigger whose complete visible label is the
      // expected model.  This is selected-model UI evidence, not account-plan
      // text or a menu availability record.
      const fallbackModelPickerNodes = expectedModel && composerModelNodes.length === 0
        ? Array.from(document.querySelectorAll('button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]'))
          .filter(visible)
          .filter((node) => {
            const value = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            return value && normalizeModel(value) === normalizeModel(expectedModel);
          })
        : [];
      const geminiTriggerRoots = ${isGeminiLiteral}
        ? Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i]')).filter(visible)
        : [];
      const geminiControlledMenuIds = new Set(geminiTriggerRoots.flatMap((node) =>
        String(node.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)
      ));
      const geminiMenuRoots = ${isGeminiLiteral}
        ? Array.from(document.querySelectorAll('[data-test-id="gem-mode-menu"], [role="menu"]'))
          .filter(visible)
          .filter((node) => node.getAttribute('data-test-id') === 'gem-mode-menu' || geminiControlledMenuIds.has(String(node.id || '')))
        : [];
      const geminiModeItems = geminiMenuRoots
        .flatMap((root) => Array.from(root.querySelectorAll('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]')))
        .filter(visible);
      const geminiRecords = geminiModeItems.map((node) => ({
        label: geminiMenuItemSemanticLabel(node, visible),
        visible: visible(node),
        scoped: true,
        selected: geminiMenuItemSelected(node),
        source: 'menu'
      }));
      const geminiCanonicalEvidence = ${isGeminiLiteral}
        ? canonicalizeGeminiModelEvidence(geminiRecords, expectedModel).matchedLabel
        : null;
      const modelEvidenceCandidates = deduplicateReviewModelEvidence(
        ${isGeminiLiteral}
          ? [geminiCanonicalEvidence]
          : [...semanticModelNodes, ...composerModelNodes, ...fallbackModelPickerNodes]
            .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim())
      );
      const sendCandidates = Array.from(document.querySelectorAll(${sendSel})).filter(visible);
      return {
        messages,
        modelEvidence: geminiCanonicalEvidence || (modelEvidenceCandidates.length === 1 ? modelEvidenceCandidates[0] : null),
        modelEvidenceCandidates,
        controlText,
        selectorStop,
        sendVisible: sendCandidates.length > 0
      };
    })()`);
    if (
      isGemini &&
      dom &&
      this.currentRun?.verifiedModelEvidence?.expectedModel === String(expectedModel || '') &&
      this.currentRun.verifiedModelEvidence.matchedLabel
    ) {
      dom.modelEvidence = this.currentRun.verifiedModelEvidence.matchedLabel;
      dom.modelEvidenceCandidates = [this.currentRun.verifiedModelEvidence.matchedLabel];
    }
    const conversationId = reviewConversationId(url);
    const controls = classifyReviewControls(dom?.controlText, {
      selectorStop: !!dom?.selectorStop,
      sendVisible: !!dom?.sendVisible
    });
    return { url, conversationId, ...(dom || {}), controls };
  }

  #assertReviewIdentity(snapshot, { expectedUrl, expectedConversationId, expectedModel, allowUnboundRoot = false }) {
    const rootIdentityMatches = allowUnboundRoot && snapshot?.url === expectedUrl && !snapshot?.conversationId;
    if (!rootIdentityMatches && (snapshot?.url !== expectedUrl || snapshot?.conversationId !== expectedConversationId)) {
      const error = new Error('review_conversation_identity_mismatch');
      error.data = { url: snapshot?.url || null, conversationId: snapshot?.conversationId || null };
      throw error;
    }
    const expected = String(expectedModel || '').trim();
    const evidence = Array.isArray(snapshot?.modelEvidenceCandidates)
      ? snapshot.modelEvidenceCandidates
      : snapshot?.modelEvidence ? [snapshot.modelEvidence] : [];
    let isChatgpt = false;
    try { isChatgpt = new URL(snapshot?.url || '').hostname === 'chatgpt.com'; } catch {}
    const matchesExpected = isChatgpt
      ? (label) => chatgptModelLabelMatches(label, expected)
      : (label) => modelLabelMatches(label, expected);
    if (expected && !evidence.some(matchesExpected)) {
      const error = new Error('review_model_mismatch');
      error.data = { expectedModel: expected, modelEvidenceCandidates: evidence };
      throw error;
    }
  }

  async #clickReviewSendOnce({ expectedPrompt, expectedModel, sourcePromptSha256, canonicalPromptSha256 }) {
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const expected = JSON.stringify(expectedPrompt);
    const sourceSha = JSON.stringify(sourcePromptSha256);
    const canonicalSha = JSON.stringify(canonicalPromptSha256);
    const expectedModelLabel = JSON.stringify(String(expectedModel || '').trim());
    const expectedVisibleModelLabel = JSON.stringify(chatgptExpectedModelSpec(expectedModel).visibleLabel);
    const productModelRequest = JSON.stringify(chatgptProductModelAlias(expectedModel));
    const textModel = JSON.stringify(REVIEW_PLAIN_TEXT_MODEL);
    const result = await this.#eval(`(() => {
      const reviewSendOnceMarker = true;
      const expected = ${expected};
      const REVIEW_PLAIN_TEXT_MODEL = ${textModel};
      const locateReviewComposer = ${locateReviewComposer.toString()};
      const canonicalizeReviewPlainText = ${canonicalizeReviewPlainText.toString()};
      const browserSpaceRebalanceSite = ${browserSpaceRebalanceSite.toString()};
      const compareReviewPlainText = ${compareReviewPlainText.toString()};
      const modelLabelMatches = ${modelLabelMatches.toString()};
      const serializeReviewComposer = ${serializeReviewComposer.toString()};
      const selected = locateReviewComposer(${promptSel});
      const composer = selected.element;
      if (!composer) return {
        ok: false,
        error: 'review_composer_identity_unreadable_at_send',
        noClickProven: true,
        candidateCount: selected.candidateCount
      };
      const serialized = composer.matches('textarea, input')
        ? { ok: true, text: String(composer.value ?? ''), method: 'value' }
        : { ...serializeReviewComposer(composer), method: 'contenteditable_structural' };
      const comparison = serialized.ok === true
        ? compareReviewPlainText(expected, serialized.text)
        : null;
      const recoveredExact =
        serialized.ok === true &&
        comparison?.ok === true &&
        comparison.canonicalExpectedText === comparison.canonicalObservedText &&
        comparison.canonicalExpectedText === canonicalizeReviewPlainText(expected);
      if (!recoveredExact) return {
        ok: false,
        error: 'review_composer_identity_mismatch_at_send',
        noClickProven: true,
        serializerOk: serialized.ok === true,
        serializerMethod: serialized.method,
        serializerError: serialized.error || null,
        serializerTag: serialized.tag || null,
        serializedLength: serialized.ok === true ? String(serialized.text ?? '').length : 0,
        expectedLength: expected.length,
        textModel: REVIEW_PLAIN_TEXT_MODEL,
        identityMode: comparison?.identityMode || 'unreadable',
        mismatchClass: comparison?.mismatchClass || null,
        firstMismatchCodePointIndex: comparison?.firstMismatchCodePointIndex ?? null,
        firstMismatchExpectedCodePoint: comparison?.firstMismatchExpectedCodePoint || null,
        firstMismatchObservedCodePoint: comparison?.firstMismatchObservedCodePoint || null,
        browserSpaceRebalanceCount: comparison?.browserSpaceRebalanceCount || 0,
        mismatchCount: comparison?.mismatchCount || 0
      };
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const expectedModel = ${expectedModelLabel};
      const expectedVisibleModel = ${expectedVisibleModelLabel};
      const productModelRequest = ${productModelRequest};
      let clickTimeModelEvidence = null;
      if (location.hostname === 'chatgpt.com' && expectedModel) {
        const agentifyReasoningControlScopeMarker = true;
        const expectsReasoningStrength = !productModelRequest && /^(?:high|pro)$/i.test(expectedVisibleModel);
        const promptNode = document.querySelector(${promptSel});
        const composerRoot = promptNode?.closest?.('form') || promptNode?.parentElement?.parentElement?.parentElement || null;
        const semanticLabel = (node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim();
        const modeItems = (root) => Array.from(root?.querySelectorAll?.('[role="menuitemradio"], [role="menuitem"], [role="option"], [data-testid*="model-option" i], [data-radix-collection-item]') || []);
        const routeFor = (node) => {
          const testId = String(node.getAttribute('data-testid') || '');
          const aria = String(node.getAttribute('aria-label') || '');
          if (testId === 'model-switcher-dropdown-button' || /model/i.test(aria)) return 'semantic_model_switcher';
          if (productModelRequest) return null;
          if (composerRoot?.contains?.(node)) return expectsReasoningStrength ? 'composer_reasoning_control' : 'composer_model_control';
          const controlledIds = String(node.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
          return controlledIds.some((id) => modeItems(document.getElementById(id)).map(semanticLabel).some((label) => /^(?:high|pro)$/i.test(label)))
            ? 'controlled_reasoning_menu'
            : null;
        };
        const selectedReasoningControls = Array.from(document.querySelectorAll('button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]'))
          .filter((node) => visible(node) && !node.closest('[role="menu"], [role="listbox"]'))
          .map((node) => ({ node, label: semanticLabel(node), route: routeFor(node) }))
          .filter((record) => record.route && modelLabelMatches(record.label, expectedVisibleModel));
        if (selectedReasoningControls.length !== 1) return {
          ok: false,
          error: 'review_model_mismatch_at_send',
          noClickProven: true,
          selectedModelMatchCount: selectedReasoningControls.length
        };
        clickTimeModelEvidence = {
          expectedModel,
          matchedLabel: selectedReasoningControls[0].label,
          routeEvidence: selectedReasoningControls[0].route,
          scopedMatchCount: 1
        };
      }
      const label = (node) => [
        node.getAttribute('aria-label') || '',
        node.getAttribute('data-testid') || '',
        node.textContent || ''
      ].join(' ').trim();
      const prohibited = /continue|retry|try again|response retry|answer now|regenerate|stop/i;
      const allCandidates = Array.from(document.querySelectorAll(${sendSel}))
        .filter((node) => visible(node) && !node.disabled && !prohibited.test(label(node)));
      const isGemini = location.hostname === 'gemini.google.com';
      const geminiSend = (node) => {
        const aria = String(node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const dataTestId = String(node.getAttribute('data-test-id') || node.getAttribute('data-testid') || '').trim();
        return /^(send|\u53d1\u9001)$/i.test(aria) || /^send-button$/i.test(dataTestId);
      };
      const geminiCandidatePool = isGemini
        ? Array.from(document.querySelectorAll('button, [role="button"]')).filter((node) => visible(node) && !node.disabled && !prohibited.test(label(node)))
        : allCandidates;
      const explicitGeminiCandidates = isGemini ? geminiCandidatePool.filter(geminiSend) : allCandidates;
      const composerForm = composer.closest('form');
      const candidates = isGemini && explicitGeminiCandidates.length === 0
        ? allCandidates.filter((node) => node.getAttribute('type') === 'submit' && (!!composerForm && composerForm.contains(node)))
        : explicitGeminiCandidates;
      if (candidates.length !== 1) return { ok: false, error: 'review_send_control_ambiguous', count: candidates.length, noClickProven: true };
      // Gemini's Angular control can ignore a synthetic HTMLElement.click()
      // even though the visible button is unique and enabled. Hand off one
      // hit-tested exact control to the native CDP pointer path instead. The
      // caller dispatches exactly one press/release pair; no DOM click is
      // performed first, so this cannot become a duplicate Send.
      if (isGemini) {
        const rect = candidates[0].getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (!hit || (hit !== candidates[0] && !candidates[0].contains(hit))) {
          return { ok: false, error: 'review_send_control_obscured', noClickProven: true };
        }
        return {
          ok: true,
          nativePointer: true,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          label: label(candidates[0]),
          clickTimeIdentity: {
            ok: true,
            recoveredExact: true,
            textModel: REVIEW_PLAIN_TEXT_MODEL,
            identityMode: comparison.identityMode,
            sourceSha256: ${sourceSha},
            canonicalPromptSha256: ${canonicalSha},
            observedCanonicalSha256: ${canonicalSha},
            serializedLength: String(serialized.text ?? '').length,
            expectedLength: expected.length,
            browserSpaceRebalanceCount: comparison.browserSpaceRebalanceCount || 0,
            mismatchCount: comparison.mismatchCount || 0
          },
          clickTimeModelEvidence
        };
      }
      candidates[0].click();
      return {
        ok: true,
        clickCount: 1,
        label: label(candidates[0]),
        clickTimeIdentity: {
          ok: true,
          recoveredExact: true,
          textModel: REVIEW_PLAIN_TEXT_MODEL,
          identityMode: comparison.identityMode,
          sourceSha256: ${sourceSha},
          canonicalPromptSha256: ${canonicalSha},
          observedCanonicalSha256: ${canonicalSha},
          serializedLength: String(serialized.text ?? '').length,
          expectedLength: expected.length,
          browserSpaceRebalanceCount: comparison.browserSpaceRebalanceCount || 0,
          mismatchCount: comparison.mismatchCount || 0
        },
        clickTimeModelEvidence
      };
    })()`);
    if (!result?.ok || (result?.nativePointer !== true && result?.clickCount !== 1)) {
      const error = new Error(result?.error || 'review_send_control_ambiguous');
      error.data = result && result.ok === false
        ? { ...result, noClickProven: true }
        : result || null;
      throw error;
    }
    if (result.nativePointer === true) {
      const rect = result.rect;
      if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h) || rect.w <= 0 || rect.h <= 0) {
        const error = new Error('review_send_control_obscured');
        error.data = { noClickProven: true };
        throw error;
      }
      await this.#clickAt(rect.x + rect.w / 2, rect.y + rect.h / 2);
      return { ...result, clickCount: 1 };
    }
    return result;
  }

  async #waitForReviewUserMessage({
    baselineIds,
    baselineMessageIds,
    deadline,
    identity,
    expectedPrompt,
    firstBinding = false,
    onUserTurnObserved = null,
    causalSubmissionReceipt = null
  }) {
    let submittedUserMessageId = null;
    let persistedObservedKey = null;
    const causalSubmissionAccepted = validateReviewCausalSubmissionReceipt(causalSubmissionReceipt, {
      prompt: expectedPrompt,
      baselineMessageIds
    });
    while (Date.now() < deadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot(identity?.expectedModel);
      if (firstBinding) {
        if (snapshot.url === identity.expectedUrl && !snapshot.conversationId) {
          await sleep(400);
          continue;
        }
        if (!snapshot.conversationId) throw new Error('review_conversation_identity_mismatch');
      } else {
        this.#assertReviewIdentity(snapshot, identity);
      }
      const newUserMessages = (snapshot.messages || []).filter(
        (message) => message.role === 'user' && !baselineIds.has(message.id)
      );
      if (newUserMessages.length) {
        if (newUserMessages.length !== 1) {
          const error = new Error('review_user_message_identity_ambiguous');
          error.data = { newUserMessageCount: newUserMessages.length };
          throw error;
        }
        submittedUserMessageId ||= newUserMessages.at(-1).id;
        const message = newUserMessages.find((candidate) => candidate.id === submittedUserMessageId);
        if (!message) throw new Error('review_user_message_identity_unreadable');
        const textIdentity = compareRenderedReviewUserText(expectedPrompt, message, {
          causalSubmissionAccepted
        });
        const renderedDisplayFidelity = message.textIdentityReadable === false
          ? 'unreadable'
          : textIdentity?.ok === true
            ? 'exact'
            : 'lossy_mismatch';
        const commitmentClass = renderedDisplayFidelity === 'exact'
          ? 'turn_exact'
          : causalSubmissionAccepted
            ? renderedDisplayFidelity === 'unreadable'
              ? 'turn_causal_exact_rendered_unreadable'
              : 'turn_causal_exact_rendered_mismatch'
            : renderedDisplayFidelity === 'unreadable'
              ? 'turn_unreadable'
              : 'turn_content_mismatch';
        const {
          candidateCount: renderedContentCandidateCount = null,
          ...renderedContentDiagnostic
        } = message.textIdentityDiagnostic || {};
        const observed = {
          observedUserMessageId: message.id,
          observedAt: Date.now(),
          conversationUrl: snapshot.url,
          conversationId: snapshot.conversationId,
          modelEvidence: snapshot.modelEvidence || null,
          commitmentClass,
          submissionIdentityMode: causalSubmissionAccepted ? REVIEW_CAUSAL_SUBMISSION_MODEL : null,
          renderedDisplayFidelity,
          serializerOk: message.textIdentityReadable === true,
          serializerMethod: 'rendered_user_message_structural',
          serializerError: message.textIdentityError || (textIdentity?.ok === true ? null : 'review_user_message_content_mismatch'),
          serializerTag: message.textIdentityTag || null,
          serializedLength: Number.isFinite(message.textLength) ? message.textLength : null,
          observedLengths: Number.isFinite(message.textLength) ? [message.textLength] : [],
          expectedLength: String(expectedPrompt || '').length,
          newUserMessageCount: 1,
          readableCandidateCount: message.textIdentityReadable === false ? 0 : 1,
          exactMatchCount: textIdentity?.ok === true ? 1 : 0,
          renderedContentCandidateCount,
          ...(textIdentity || {}),
          ...renderedContentDiagnostic
        };
        const observedKey = `${message.id}\u0000${snapshot.url}\u0000${snapshot.conversationId}\u0000${commitmentClass}`;
        if (persistedObservedKey !== observedKey) {
          await onUserTurnObserved?.(observed);
          persistedObservedKey = observedKey;
        }
        if (firstBinding && provisionalChatgptConversationId(snapshot.conversationId)) {
          await sleep(400);
          continue;
        }
        if (message.textIdentityReadable === false) {
          const error = new Error('review_user_message_identity_unreadable');
          error.data = observed;
          throw error;
        }
        if (textIdentity?.ok !== true) {
          const error = new Error('review_user_message_content_mismatch');
          error.data = observed;
          throw error;
        }
        return {
          snapshot,
          message,
          textIdentity,
          causalSubmissionReceipt: causalSubmissionAccepted ? causalSubmissionReceipt : null,
          submissionIdentityMode: causalSubmissionAccepted ? REVIEW_CAUSAL_SUBMISSION_MODEL : 'rendered_exact',
          renderedDisplayFidelity,
          renderedDisplayEvidence: observed
        };
      }
      await sleep(400);
    }
    const error = new Error('review_user_message_not_observed_after_click');
    error.data = {
      commitmentClass: 'click_no_turn',
      newUserMessageCount: 0,
      expectedLength: String(expectedPrompt || '').length
    };
    throw error;
  }

  async #waitForReviewBaseline({ deadline, identity, stableMs = 3_000 }) {
    let firstStable = null;
    while (Date.now() < deadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot(identity?.expectedModel);
      this.#assertReviewIdentity(snapshot, identity);
      if (snapshot.controls?.stop || snapshot.controls?.continue || snapshot.controls?.retry) {
        firstStable = null;
        await sleep(250);
        continue;
      }
      const signature = JSON.stringify((snapshot.messages || []).map((message) => [
        message.role,
        message.id,
        message.textIdentityReadable === true,
        message.textIdentityError || null,
        message.textIdentityTag || null
      ]));
      const now = Date.now();
      if (!firstStable || firstStable.signature !== signature) {
        firstStable = { signature, observedAt: now, snapshot };
      } else if (now - firstStable.observedAt >= stableMs) {
        return snapshot;
      }
      await sleep(250);
    }
    throw new Error('review_baseline_identity_unstable');
  }

  async #reviewAssistantResult({ snapshot, userMessageId, currentUserMessageId = userMessageId, contentRebind = null }) {
    const userIndex = (snapshot.messages || []).findIndex(
      (message) => message.role === 'user' && message.id === currentUserMessageId
    );
    if (userIndex < 0) throw new Error('review_user_message_identity_unreadable');
    const following = snapshot.messages.slice(userIndex + 1);
    const nextUserOffset = following.findIndex((message) => message.role === 'user');
    const targetTurn = nextUserOffset >= 0 ? following.slice(0, nextUserOffset) : following;
    const assistants = targetTurn.filter((message) => message.role === 'assistant');
    if (assistants.length > 1) throw new Error('review_assistant_message_ambiguous');
    const assistant = assistants[0] || null;
    const active =
      !!snapshot.controls?.stop ||
      !!snapshot.controls?.continue ||
      !!snapshot.controls?.retry ||
      !!snapshot.controls?.answerNow;
    return { userIndex, assistant, active, userMessageId, currentUserMessageId, contentRebind };
  }

  async #resolveReviewUserAnchor({
    userMessageId,
    deadline,
    identity,
    expectedPrompt,
    expectedPromptSha256,
    baselineMessageIds,
    sendCount,
    sendActionCount,
    renderedDisplayFidelity = 'exact'
  }) {
    const originalIdDeadline = Math.min(deadline, Date.now() + 5_000);
    while (Date.now() < originalIdDeadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot(identity?.expectedModel);
      this.#assertReviewIdentity(snapshot, identity);
      if ((snapshot.messages || []).some((message) => message.role === 'user' && message.id === userMessageId)) {
        return { currentUserMessageId: userMessageId, contentRebind: null };
      }
      await sleep(250);
    }

    if (
      typeof expectedPrompt !== 'string' ||
      crypto.createHash('sha256').update(expectedPrompt, 'utf8').digest('hex') !== expectedPromptSha256 ||
      !Array.isArray(baselineMessageIds) ||
      new Set(baselineMessageIds).size !== baselineMessageIds.length ||
      sendCount !== 1 ||
      sendActionCount !== 1
    ) {
      throw new Error('review_content_rebind_receipt_invalid');
    }
    // A causal send receipt plus a persisted user-message anchor can survive a
    // provider DOM reconstruction with a different message id.  For a lossy
    // rendered prompt, permit that rebind only in a one-turn conversation with
    // no baseline messages; it cannot select an older or later user turn.
    const causalSingleTurnLossy =
      renderedDisplayFidelity !== 'exact' && baselineMessageIds.length === 0;
    if (renderedDisplayFidelity !== 'exact' && !causalSingleTurnLossy) {
      throw new Error('review_content_rebind_unavailable_for_lossy_rendering');
    }

    let firstStable = null;
    while (Date.now() < deadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot(identity?.expectedModel);
      this.#assertReviewIdentity(snapshot, identity);
      if (
        snapshot.controls?.stop ||
        snapshot.controls?.continue ||
        snapshot.controls?.retry ||
        snapshot.controls?.answerNow
      ) {
        throw new Error('review_content_rebind_controls_active');
      }
      const users = (snapshot.messages || []).filter((message) => message.role === 'user');
      if (users.some((message) => message.textIdentityReadable !== true)) {
        throw new Error('review_content_rebind_user_content_unreadable');
      }
      let anchor;
      let anchorIdentity = null;
      if (causalSingleTurnLossy) {
        if (users.length !== 1) throw new Error('review_content_rebind_user_match_ambiguous');
        [anchor] = users;
      } else {
        const matches = users.map((message) => ({
          message,
          identity: safeReviewPlainTextComparison(expectedPrompt, message.text)
        })).filter(({ identity }) =>
          identity.ok === true &&
          identity.canonicalPromptSha256 === identity.observedCanonicalSha256
        );
        if (matches.length !== 1) throw new Error('review_content_rebind_user_match_ambiguous');
        ({ message: anchor, identity: anchorIdentity } = matches[0]);
      }
      if (!anchor.id) throw new Error('review_content_rebind_anchor_unreadable');
      if (baselineMessageIds.includes(anchor.id)) throw new Error('review_content_rebind_baseline_collision');
      const turn = await this.#reviewAssistantResult({
        snapshot,
        userMessageId,
        currentUserMessageId: anchor.id
      });
      if (!turn.assistant?.id || !turn.assistant.text) {
        throw new Error('review_content_rebind_assistant_unreadable');
      }
      const laterUsers = users.filter((message) => message.order > anchor.order);
      if (laterUsers.length) throw new Error('review_content_rebind_later_user_ambiguous');
      const signature = JSON.stringify({
        url: snapshot.url,
        conversationId: snapshot.conversationId,
        modelEvidence: snapshot.modelEvidence,
        currentUserMessageId: anchor.id,
        assistantMessageId: turn.assistant?.id || null,
        assistantCount: turn.assistant ? 1 : 0,
        assistantTextSha256: turn.assistant?.text
          ? crypto.createHash('sha256').update(turn.assistant.text, 'utf8').digest('hex')
          : null
      });
      const now = Date.now();
      if (!firstStable || firstStable.signature !== signature) {
        firstStable = { signature, observedAt: now, currentUserMessageId: anchor.id };
      } else if (now - firstStable.observedAt >= 3_000) {
        return {
          currentUserMessageId: anchor.id,
          contentRebind: {
            mode: causalSingleTurnLossy ? 'causal_single_turn_lossy' : 'exact_prompt_content',
            originalUserMessageId: userMessageId,
            currentUserMessageId: anchor.id,
            promptSha256: expectedPromptSha256,
            promptTextModel: causalSingleTurnLossy ? REVIEW_CAUSAL_SUBMISSION_MODEL : anchorIdentity.textModel,
            canonicalPromptSha256: causalSingleTurnLossy ? expectedPromptSha256 : anchorIdentity.canonicalPromptSha256,
            renderedIdentityMode: causalSingleTurnLossy ? 'display_not_source_identity' : anchorIdentity.identityMode,
            baselineMessageCount: baselineMessageIds.length,
            observedAt: now
          }
        };
      }
      await sleep(500);
    }
    throw new Error('review_content_rebind_unstable');
  }

  async #waitForReviewAssistant({
    userMessageId,
    deadline,
    identity,
    currentUserMessageId = userMessageId,
    contentRebind = null
  }) {
    let firstStable = null;
    while (Date.now() < deadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot(identity?.expectedModel);
      this.#assertReviewIdentity(snapshot, identity);
      const { assistant, active } = await this.#reviewAssistantResult({
        snapshot,
        userMessageId,
        currentUserMessageId,
        contentRebind
      });
      if (assistant?.id && assistant.text && !active) {
        const textSha256 = crypto.createHash('sha256').update(assistant.text, 'utf8').digest('hex');
        const observation = {
          observedAt: Date.now(),
          assistantMessageId: assistant.id,
          textSha256
        };
        if (
          firstStable &&
          firstStable.assistantMessageId === observation.assistantMessageId &&
          firstStable.textSha256 === observation.textSha256 &&
          observation.observedAt - firstStable.observedAt >= 3_000
        ) {
          return {
            userMessageId,
            assistantMessageId: assistant.id,
            text: assistant.text,
            snapshots: [firstStable, observation],
            controls: {
              stop: !!snapshot.controls?.stop,
              continue: !!snapshot.controls?.continue,
              retry: !!snapshot.controls?.retry,
              answerNow: !!snapshot.controls?.answerNow
            },
            clickedControls: [],
            conversationUrl: snapshot.url,
            conversationId: snapshot.conversationId,
            modelEvidence: snapshot.modelEvidence,
            contentRebind
          };
        }
        if (
          !firstStable ||
          firstStable.assistantMessageId !== observation.assistantMessageId ||
          firstStable.textSha256 !== observation.textSha256
        ) {
          firstStable = observation;
        }
      } else {
        firstStable = null;
      }
      await sleep(500);
    }
    throw new Error('timeout_waiting_for_response');
  }

  async #waitForReviewIdentity({
    expectedUrl,
    expectedConversationId,
    expectedModel,
    allowUnboundRoot = false,
    deadline
  }) {
    const identity = { expectedUrl, expectedConversationId, expectedModel, allowUnboundRoot };
    const loadDeadline = Math.min(deadline, Date.now() + 30_000);
    let lastSnapshot = null;
    while (Date.now() < loadDeadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot(expectedModel);
      lastSnapshot = snapshot;
      const expectedIdentityVisible =
        (snapshot.url === expectedUrl && snapshot.conversationId === expectedConversationId) ||
        (allowUnboundRoot && snapshot.url === expectedUrl && !snapshot.conversationId);
      if (expectedIdentityVisible) {
        try {
          this.#assertReviewIdentity(snapshot, identity);
          return snapshot;
        } catch (error) {
          if (String(error?.message || error) !== 'review_model_mismatch') throw error;
        }
      } else {
        let transitional = snapshot.url === 'about:blank';
        try {
          const observed = new URL(snapshot.url);
          const expected = new URL(expectedUrl);
          transitional = transitional || (
            observed.origin === expected.origin && !snapshot.conversationId
          );
        } catch {}
        if (!transitional) this.#assertReviewIdentity(snapshot, identity);
      }
      await sleep(200);
    }
    this.#assertReviewIdentity(lastSnapshot, identity);
    return lastSnapshot;
  }

  async reviewQuery({
    prompt,
    expectedUrl,
    expectedConversationId,
    expectedModel,
    timeoutMs,
    onPrepared,
    onComposerVerified,
    onSendBoundaryEntered,
    onSendAction,
    onUserTurnObserved,
    onSubmitted,
    firstBinding = false,
    requireModelPreflight = false
  }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    const deadline = Date.now() + Number(timeoutMs || 0);
    let activeExpectedModel = expectedModel;
    const identity = { expectedUrl, expectedConversationId, expectedModel: activeExpectedModel, allowUnboundRoot: firstBinding };
    const run = { kind: 'review_query', requested: false, requestedAt: null, reason: null, onProgress: null };
    this.currentRun = run;
    try {
      await this.ensureReady({ timeoutMs: Math.max(1, deadline - Date.now()) });
      let provider = null;
      try { provider = new URL(await this.page.getUrl()).hostname; } catch {}
      if (provider === 'chatgpt.com' && requireModelPreflight === true) {
        const verifiedModelState = await this.#ensureExpectedModel(
          expectedModel,
          Math.min(Math.max(1, deadline - Date.now()), 60_000)
        );
        run.verifiedModelEvidence = {
          expectedModel,
          matchedLabel: verifiedModelState?.matchedLabel || null,
          routeEvidence: verifiedModelState?.routeEvidence || null,
          scopedMatchCount: verifiedModelState?.scopedMatchCount || 0
        };
      } else if (provider === 'gemini.google.com' && (geminiExpectedModelSpec(expectedModel).thinkingMode || requireModelPreflight === true)) {
        const verifiedModelState = expectedModel === '__selected__'
          ? await this.#captureGeminiSelectedModel(Math.min(Math.max(1, deadline - Date.now()), 60_000))
          : await this.#ensureExpectedModel(expectedModel, Math.min(Math.max(1, deadline - Date.now()), 60_000));
        activeExpectedModel = verifiedModelState?.matchedLabel || expectedModel;
        identity.expectedModel = activeExpectedModel;
        run.verifiedModelEvidence = {
          expectedModel: activeExpectedModel,
          matchedLabel: verifiedModelState?.matchedLabel || null
        };
      }
      const before = await this.#waitForReviewIdentity({ ...identity, deadline });
      const active = !!before.controls?.stop || !!before.controls?.continue || !!before.controls?.retry;
      if (active) {
        const error = new Error('review_tab_busy');
        error.data = { noClickProven: true };
        throw error;
      }
      const baselineIds = new Set((before.messages || []).map((message) => message.id));
      if (!firstBinding && baselineIds.size === 0) {
        const error = new Error('review_continuation_baseline_empty');
        error.data = {
          noClickProven: true,
          failureStage: 'before_composer_write',
          baselineMessageCount: 0
        };
        throw error;
      }
      await onPrepared?.({
        baselineMessageIds: [...baselineIds],
        preparedAt: Date.now(),
        conversationUrl: before.url,
        conversationId: before.conversationId,
        modelEvidence: before.modelEvidence
      });
      const composerIdentity = await this.#replacePrompt(prompt, { human: false, verifyExact: true });
      const retainedExact =
        composerIdentity?.composerPreparationMode === 'retained_exact' &&
        composerIdentity.clearMethod === 'not_required_exact_existing' &&
        composerIdentity.selectionVerified === false &&
        composerIdentity.deleteKeyCount === 0 &&
        composerIdentity.emptyVerified === false &&
        composerIdentity.emptySnapshotCount === 0 &&
        composerIdentity.caretVerified === false &&
        composerIdentity.caretMethod === 'not_required_exact_existing' &&
        composerIdentity.promptInsertCount === 0;
      const replaced =
        composerIdentity?.composerPreparationMode === 'replaced' &&
        composerIdentity.emptyVerified === true &&
        composerIdentity.emptySnapshotCount === 2 &&
        composerIdentity.caretVerified === true &&
        composerIdentity.promptInsertCount === 1;
      if (
        composerIdentity?.replacementModel !== REVIEW_COMPOSER_REPLACEMENT_MODEL ||
        (!retainedExact && !replaced)
      ) {
        throw this.#composerReplacementError('review_composer_replacement_receipt_invalid', composerIdentity, {
          predicate: 'review_composer_replacement_receipt_invalid'
        });
      }
      await onComposerVerified?.(composerIdentity);
      const promptIdentity = reviewPlainTextIdentity(prompt);
      const clickTimeSnapshot = await this.#reviewSnapshot(activeExpectedModel);
      this.#assertReviewIdentity(clickTimeSnapshot, identity);
      if (clickTimeSnapshot.controls?.stop || clickTimeSnapshot.controls?.continue || clickTimeSnapshot.controls?.retry) {
        const error = new Error('review_tab_busy_at_send');
        error.data = { noClickProven: true };
        throw error;
      }
      let sendTimeModelEvidence = null;
      if (provider === 'chatgpt.com' && requireModelPreflight === true) {
        const modelState = run.verifiedModelEvidence;
        if (modelState?.scopedMatchCount !== 1 || !modelState.matchedLabel || !modelState.routeEvidence) {
          const error = new Error('review_model_mismatch_at_send');
          error.data = { noClickProven: true, selectedModelMatchCount: modelState?.scopedMatchCount || 0 };
          throw error;
        }
        sendTimeModelEvidence = {
          expectedModel: activeExpectedModel,
          matchedLabel: modelState.matchedLabel,
          routeEvidence: modelState.routeEvidence,
          scopedMatchCount: 1
        };
      }
      await onSendBoundaryEntered?.({ enteredAt: Date.now(), modelEvidence: sendTimeModelEvidence });
      const clickReceipt = await this.#clickReviewSendOnce({
        expectedPrompt: prompt,
        expectedModel: activeExpectedModel,
        sourcePromptSha256: promptIdentity.sourceSha256,
        canonicalPromptSha256: promptIdentity.canonicalSha256
      });
      const causalSubmissionReceipt = await onSendAction?.({
        clickCount: clickReceipt?.clickCount || 0,
        sendActionCount: 1,
        sendActionAt: Date.now(),
        clickTimeIdentity: clickReceipt?.clickTimeIdentity || null,
        clickTimeModelEvidence: clickReceipt?.clickTimeModelEvidence || sendTimeModelEvidence
      });
      const submitted = await this.#waitForReviewUserMessage({
        baselineIds,
        baselineMessageIds: [...baselineIds],
        deadline,
        identity,
        expectedPrompt: prompt,
        firstBinding,
        onUserTurnObserved,
        causalSubmissionReceipt
      });
      const submittedIdentity = {
        expectedUrl: submitted.snapshot.url,
        expectedConversationId: submitted.snapshot.conversationId,
        expectedModel: activeExpectedModel
      };
      await onSubmitted?.({
        userMessageId: submitted.message.id,
        submittedAt: Date.now(),
        conversationUrl: submitted.snapshot.url,
        conversationId: submitted.snapshot.conversationId,
        modelEvidence: sendTimeModelEvidence?.matchedLabel || submitted.snapshot.modelEvidence,
        sourcePromptSha256: reviewPlainTextIdentity(prompt).sourceSha256,
        canonicalPromptSha256: reviewPlainTextIdentity(prompt).canonicalSha256,
        submissionIdentityMode: submitted.submissionIdentityMode,
        causalSubmissionReceipt: submitted.causalSubmissionReceipt,
        renderedDisplayFidelity: submitted.renderedDisplayFidelity,
        renderedDisplayEvidence: submitted.renderedDisplayEvidence,
        renderedIdentityMode: submitted.textIdentity?.identityMode || null
      });
      return {
        status: 'SENT_WAITING',
        userMessageId: submitted.message.id,
        conversationUrl: submitted.snapshot.url,
        conversationId: submitted.snapshot.conversationId,
        modelEvidence: sendTimeModelEvidence?.matchedLabel || submitted.snapshot.modelEvidence,
        controls: submitted.snapshot.controls || null
      };
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  // A no-prompt/no-send normalizer for the current ChatGPT reasoning-strength
  // control. A fresh tab may reset Pro to High. This entry point can change
  // only that exact visible mode and returns before baseline capture, composer
  // mutation, ledger creation, or Send.
  async reviewReasoningModePreflight({ expectedMode, timeoutMs = 20_000 } = {}) {
    const expected = String(expectedMode || '').trim();
    if (!expected) throw new Error('missing_expected_reasoning_mode');
    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    await this.ensureReady({ timeoutMs: Math.max(1, deadline - Date.now()) });
    const conversationUrl = await this.page.getUrl();
    let provider = '';
    try { provider = new URL(conversationUrl).hostname; } catch {}
    if (provider !== 'chatgpt.com') throw new Error('review_reasoning_mode_provider_unsupported');
    const modeState = await this.#ensureExpectedModel(expected, Math.max(1, deadline - Date.now()));
    if (!modeState?.matched || !modeState?.matchedLabel) throw new Error('expected_reasoning_mode_switch_unconfirmed');
    const snapshot = await this.#reviewSnapshot(expected);
    this.#assertReviewIdentity(snapshot, {
      expectedUrl: conversationUrl,
      expectedConversationId: snapshot.conversationId,
      expectedModel: expected,
      allowUnboundRoot: !snapshot.conversationId
    });
    if (snapshot.controls?.stop || snapshot.controls?.continue || snapshot.controls?.retry || snapshot.controls?.answerNow) {
      throw new Error('review_active_generation');
    }
    return {
      provider: 'chatgpt',
      conversationUrl,
      reasoningModeEvidence: modeState.matchedLabel,
      reasoningModeReceipt: {
        selectedMode: modeState.matchedLabel,
        expectedMode: expected,
        selectionMethod: modeState.selectionMethod || 'visible_exact_reasoning_mode_option',
        promptInsertCount: 0,
        sendActionCount: 0
      },
      promptInsertCount: 0,
      sendActionCount: 0
    };
  }

  // Visible-DOM-only diagnostic for reasoning-control drift. It never focuses
  // the composer, writes, or sends. The explicit `openModeSelector` option
  // can open one unique visible mode trigger to enumerate its rendered menu.
  // `scope=page` additionally records header/topbar relationships only.
  async reviewReasoningModeDiagnostics({ timeoutMs = 20_000, scope = 'composer', openModeSelector = false } = {}) {
    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    await this.ensureReady({ timeoutMs: Math.max(1, deadline - Date.now()) });
    const conversationUrl = await this.page.getUrl();
    let provider = '';
    try { provider = new URL(conversationUrl).hostname; } catch {}
    if (provider !== 'chatgpt.com') throw new Error('review_reasoning_mode_provider_unsupported');
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const requestedScope = String(scope || 'composer').trim().toLowerCase();
    if (!['composer', 'page'].includes(requestedScope)) throw new Error('review_reasoning_mode_diagnostic_scope_invalid');
    if (openModeSelector && requestedScope !== 'page') throw new Error('review_reasoning_mode_diagnostic_open_requires_page_scope');
    let pickerOpened = false;
    if (openModeSelector) {
      const opener = await this.#eval(`(() => {
        const agentifyOpenReasoningDiagnosticPickerMarker = true;
        const visible = (node) => {
          const rect = node?.getBoundingClientRect?.();
          const style = node ? window.getComputedStyle(node) : null;
          return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
        };
        const semanticName = (node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim();
        const controls = Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter((node) => visible(node) && !node.closest('[role="menu"], [role="listbox"]'))
          .filter((node) => /^(?:menu|listbox)$/i.test(String(node.getAttribute('aria-haspopup') || '')))
          .filter((node) => node.getAttribute('data-testid') === 'model-switcher-dropdown-button' || /^(?:model selector|high|pro)$/i.test(semanticName(node)));
        if (controls.length !== 1) return { ok: false, error: 'reasoning_mode_unbound_page_selector_unavailable', pickerCount: controls.length };
        const rect = controls[0].getBoundingClientRect();
        return { ok: true, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
      })()`);
      if (!opener?.ok) throw new Error(opener?.error || 'reasoning_mode_unbound_page_selector_unavailable');
      await this.#clickAt(opener.rect.x + opener.rect.w / 2, opener.rect.y + opener.rect.h / 2);
      pickerOpened = true;
      await sleep(250);
    }
    const diagnostic = await this.#eval(`(() => {
      const reviewReasoningModeDiagnosticMarker = true;
      const locateReviewComposer = ${locateReviewComposer.toString()};
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        const style = node ? window.getComputedStyle(node) : null;
        return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
      };
      const composerSelection = locateReviewComposer(${promptSel});
      const composer = composerSelection.element;
      const composerRect = composer?.getBoundingClientRect?.() || null;
      const requestedScope = ${JSON.stringify(requestedScope)};
      const candidates = Array.from(document.querySelectorAll(requestedScope === 'page'
        ? 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"]'
        : 'button, [role="button"]'))
        .filter(visible)
        .filter((node) => {
          if (requestedScope === 'page') return true;
          if (!composerRect) return false;
          const r = node.getBoundingClientRect();
          return r.bottom >= composerRect.top - 180 && r.top <= composerRect.bottom + 180 && r.right >= composerRect.left - 240 && r.left <= composerRect.right + 240;
        })
        .filter((node) => {
          const testId = String(node.getAttribute('data-testid') || '');
          const rawName = String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim();
          // History rows can expose science-bearing titles. They are not a
          // reasoning-mode observation surface, so omit them entirely.
          return !/(?:history-item|undefined-options)/i.test(testId) && !/^(?:pin|unpin|open conversation options? for)\b/i.test(rawName);
        })
        .slice(0, requestedScope === 'page' ? 40 : 24)
        .map((node) => ({
          tag: String(node.tagName || ''), role: String(node.getAttribute('role') || ''),
          name: String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          ariaHasPopup: String(node.getAttribute('aria-haspopup') || ''),
          ariaControls: String(node.getAttribute('aria-controls') || ''),
          dataTestId: String(node.getAttribute('data-testid') || ''),
          insideComposerForm: !!composer?.closest?.('form')?.contains?.(node),
          region: (() => {
            const r = node.getBoundingClientRect();
            if (composerRect && r.bottom >= composerRect.top - 180 && r.top <= composerRect.bottom + 180 && r.right >= composerRect.left - 240 && r.left <= composerRect.right + 240) return 'composer_neighborhood';
            if (r.top < Math.max(180, window.innerHeight * 0.28)) return 'header_or_topbar';
            return 'page_other';
          })(),
          semanticModeTrigger: /^(?:high|pro|chatgpt|model selector|reasoning(?: mode| strength)?|mode|thinking)$/i.test(String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim())
        }));
      return { scope: requestedScope, composerFound: !!composer, composerCandidateCount: composerSelection.candidateCount, controls: candidates };
    })()`);
    return { provider: 'chatgpt', conversationUrl, pickerOpened, promptInsertCount: 0, sendActionCount: 0, ...(diagnostic || {}) };
  }

  // No-prompt/no-send profile and root-binding inspection. Cookie results are
  // aggregate presence metadata only and cannot establish authentication.
  async reviewChatGPTProfileSnapshot({ timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    await this.ensureReady({ timeoutMs: Math.max(1, deadline - Date.now()) });
    const conversationUrl = await this.page.getUrl();
    let parsed = null;
    try { parsed = new URL(conversationUrl); } catch {}
    if (parsed?.hostname !== 'chatgpt.com') throw new Error('review_chatgpt_profile_provider_unsupported');
    let cookiePresence = { supported: false, reason: 'page_cookie_presence_unavailable' };
    if (typeof this.page.getCookiePresenceMetadata === 'function') {
      try {
        cookiePresence = await this.page.getCookiePresenceMetadata({ url: 'https://chatgpt.com/' });
      } catch (error) {
        cookiePresence = { supported: false, reason: String(error?.message || 'page_cookie_presence_failed') };
      }
    }
    const visibleControls = await this.reviewReasoningModeDiagnostics({
      timeoutMs: Math.max(1, deadline - Date.now()), scope: 'page'
    });
    return {
      provider: 'chatgpt',
      conversationUrl,
      urlBinding: parsed?.pathname === '/' ? 'provider_root' : /^\/c\/[^/]+\/?$/.test(parsed?.pathname || '') ? 'concrete_conversation' : 'other_chatgpt_path',
      cookiePresence,
      visibleControls,
      promptInsertCount: 0,
      sendActionCount: 0
    };
  }

  // A bounded, non-sending probe for strict provider model preflight. Gemini
  // uses its picker adapter; ChatGPT reads only the already-visible selected
  // model. Both paths stop before baseline capture, composer mutation, or the
  // Send boundary.
  async reviewPreflight({ expectedModel, timeoutMs = 20_000 } = {}) {
    const expected = String(expectedModel || '').trim();
    if (!expected) throw new Error('missing_expected_model');
    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    await this.ensureReady({ timeoutMs: Math.max(1, deadline - Date.now()) });
    const conversationUrl = await this.page.getUrl();
    let provider = '';
    try { provider = new URL(conversationUrl).hostname; } catch {}
    if (provider === 'chatgpt.com') {
      const modelState = await this.#readExpectedModelState(expected);
      const snapshot = await this.#reviewSnapshot('');
      this.#assertReviewIdentity(snapshot, {
        expectedUrl: conversationUrl,
        expectedConversationId: snapshot.conversationId,
        expectedModel: '',
        allowUnboundRoot: !snapshot.conversationId
      });
      if (snapshot.controls?.stop || snapshot.controls?.continue || snapshot.controls?.retry || snapshot.controls?.answerNow) {
        throw new Error('review_active_generation');
      }
      return {
        provider: 'chatgpt',
        conversationUrl,
        modelEvidence: modelState?.matchedLabel || null,
        modelEvidenceCandidates: Array.isArray(modelState?.labels) ? modelState.labels : [],
        modelEvidenceDiagnostics: Array.isArray(modelState?.visibleExactLabels) ? modelState.visibleExactLabels : [],
        preflightVerified: modelState?.matched === true && !!modelState?.matchedLabel,
        sendActionCount: 0,
        promptInsertCount: 0
      };
    }
    if (provider !== 'gemini.google.com') throw new Error('review_preflight_provider_unsupported');

    const verified = await this.#ensureExpectedModel(expected, Math.max(1, deadline - Date.now()));
    // A Gemini selection closes its menu synchronously.  `verified` is the
    // adapter's immediate observation of the exact visible, menu-scoped,
    // selected model and thinking controls; reopening/reading the now-closed
    // menu can only erase that genuine evidence.  Do not substitute the
    // abbreviated trigger label as a replacement proof.
    if (!verified?.matched || !verified.matchedLabel) throw new Error('expected_model_switch_unconfirmed');
    return {
      provider: 'gemini',
      conversationUrl,
      modelEvidence: verified.matchedLabel,
      sendActionCount: 0,
      promptInsertCount: 0
    };
  }

  async observeReviewResponse({
    expectedUrl,
    expectedConversationId,
    expectedModel,
    submittedModelEvidence = expectedModel,
    userMessageId,
    expectedPrompt,
    expectedPromptSha256,
    baselineMessageIds,
    sendCount,
    sendActionCount,
    renderedDisplayFidelity = 'exact',
    timeoutMs
  }) {
    if (renderedDisplayFidelity !== 'exact') {
      throw new Error(renderedDisplayFidelity === 'unreadable'
        ? 'review_user_message_identity_unreadable'
        : 'review_user_message_content_mismatch');
    }
    const deadline = Date.now() + Number(timeoutMs || 0);
    const persistedModelEvidence = String(submittedModelEvidence || expectedModel || '').trim();
    // A replacement tab's reasoning picker describes the next submission,
    // not the model used by this already-persisted user turn. Observation is
    // therefore bound only to the concrete conversation and exact user turn;
    // the send-time model receipt remains immutable evidence for completion.
    let identity = { expectedUrl, expectedConversationId, expectedModel: '' };
    while (provisionalChatgptConversationId(identity.expectedConversationId) && Date.now() < deadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot('');
      const sameUser = (snapshot.messages || []).some(
        (candidate) => candidate.role === 'user' && candidate.id === userMessageId
      );
      if (
        sameUser &&
        snapshot.url?.startsWith('https://chatgpt.com/c/') &&
        snapshot.conversationId &&
        !provisionalChatgptConversationId(snapshot.conversationId)
      ) {
        identity = { expectedUrl: snapshot.url, expectedConversationId: snapshot.conversationId, expectedModel: '' };
        break;
      }
      await sleep(400);
    }
    if (provisionalChatgptConversationId(identity.expectedConversationId)) {
      throw new Error('review_first_binding_canonical_identity_unreadable');
    }
    await this.#waitForReviewIdentity({ ...identity, deadline });
    const anchor = await this.#resolveReviewUserAnchor({
      userMessageId,
      deadline,
      identity,
      expectedPrompt,
      expectedPromptSha256,
      baselineMessageIds,
      sendCount,
      sendActionCount,
      renderedDisplayFidelity
    });
    try {
      const completed = await this.#waitForReviewAssistant({
        userMessageId,
        deadline,
        identity,
        ...anchor
      });
      return { ...completed, modelEvidence: persistedModelEvidence };
    } catch (error) {
      if (String(error?.message || error) !== 'timeout_waiting_for_response') throw error;
      return {
        status: 'SENT_WAITING',
        userMessageId,
        conversationUrl: identity.expectedUrl,
        conversationId: identity.expectedConversationId,
        modelEvidence: persistedModelEvidence
      };
    }
  }

  async inspectReviewSubmissionIdentity({ prompt, baselineMessageIds, expectedUrl, expectedConversationId, expectedModel }) {
    if (typeof prompt !== 'string') throw new Error('review_composer_expected_prompt_invalid');
    if (!Array.isArray(baselineMessageIds)) throw new Error('review_submission_baseline_missing');
    const baselineIds = new Set(baselineMessageIds);
    const snapshot = await this.#reviewSnapshot(expectedModel);
    this.#assertReviewIdentity(snapshot, { expectedUrl, expectedConversationId, expectedModel });
    const newUserMessages = (snapshot.messages || []).filter(
      (message) => message.role === 'user' && !baselineIds.has(message.id)
    );
    const comparisons = new Map(newUserMessages.map((message) => [
      message,
      message.textIdentityReadable === false ? null : safeReviewPlainTextComparison(prompt, message.text)
    ]));
    const exactMatches = newUserMessages.filter((message) => comparisons.get(message)?.ok === true);
    const readableCandidateCount = newUserMessages.filter((message) => message.textIdentityReadable === true).length;
    const message = newUserMessages.length ? newUserMessages[newUserMessages.length - 1] : null;
    const {
      candidateCount: renderedContentCandidateCount = null,
      ...renderedContentDiagnostic
    } = message?.textIdentityDiagnostic || {};
    const textIdentity = message ? comparisons.get(message) : null;
    const comparisonDiagnostic = newUserMessages.length === 1 ? textIdentity || {} : {};
    return {
      ok: exactMatches.length === 1 && newUserMessages.length === 1,
      serializerOk: message?.textIdentityReadable === true,
      serializerMethod: 'rendered_user_message_structural',
      serializerError: message
        ? message.textIdentityError || (textIdentity?.ok === true ? null : 'review_user_message_content_mismatch')
        : 'review_user_message_count_mismatch',
      serializerTag: message?.textIdentityTag || null,
      serializedLength: Number.isInteger(message?.textLength) ? message.textLength : 0,
      observedLengths: Number.isInteger(message?.textLength) ? [message.textLength] : [],
      expectedLength: prompt.length,
      newUserMessageCount: newUserMessages.length,
      renderedContentCandidateCount,
      exactMatchCount: exactMatches.length,
      readableCandidateCount,
      ...comparisonDiagnostic,
      ...renderedContentDiagnostic
    };
  }

  async recoverReviewSubmission({
    prompt,
    baselineMessageIds,
    expectedUrl,
    expectedConversationId,
    expectedModel,
    submittedModelEvidence = expectedModel,
    timeoutMs,
    causalSubmissionReceipt,
    onRecovered
  }) {
    const deadline = Date.now() + Number(timeoutMs || 0);
    const persistedModelEvidence = String(submittedModelEvidence || '').trim();
    const identity = { expectedUrl, expectedConversationId, expectedModel: '' };
    const snapshot = await this.#waitForReviewIdentity({ ...identity, deadline });
    if (!Array.isArray(baselineMessageIds)) throw new Error('review_submission_baseline_missing');
    const baselineIds = new Set(baselineMessageIds);
    const newUserMessages = (snapshot.messages || []).filter(
      (message) => message.role === 'user' && !baselineIds.has(message.id)
    );
    if (!validateReviewCausalSubmissionReceipt(causalSubmissionReceipt, { prompt, baselineMessageIds })) {
      throw new Error('review_composer_causal_binding_missing');
    }
    if (newUserMessages.length !== 1) {
      const message = newUserMessages.length === 1 ? newUserMessages[0] : null;
      const error = new Error('review_user_message_identity_unreadable');
      error.data = message ? {
        serializerOk: message.textIdentityReadable === true,
        serializerMethod: 'rendered_user_message_structural',
        serializerError: message.textIdentityError || 'review_user_message_content_mismatch',
        serializerTag: message.textIdentityTag || null,
        serializedLength: Number.isInteger(message.textLength) ? message.textLength : 0,
        observedLengths: Number.isInteger(message.textLength) ? [message.textLength] : [],
        expectedLength: prompt.length,
        ...(message.textIdentityDiagnostic || {})
      } : { candidateCount: newUserMessages.length, expectedLength: prompt.length };
      throw error;
    }
    const message = newUserMessages[0];
    const renderedIdentity = compareRenderedReviewUserText(prompt, message, {
      causalSubmissionAccepted: true
    });
    const renderedExact = renderedIdentity?.ok === true;
    const {
      candidateCount: renderedContentCandidateCount = null,
      ...renderedContentDiagnostic
    } = message.textIdentityDiagnostic || {};
    await onRecovered?.({
      userMessageId: message.id,
      newUserMessageCount: newUserMessages.length,
      submittedAt: Date.now(),
      conversationUrl: snapshot.url,
      conversationId: snapshot.conversationId,
      modelEvidence: persistedModelEvidence,
      identityMode: REVIEW_CAUSAL_SUBMISSION_MODEL,
      renderedDisplayFidelity: message.textIdentityReadable === false
        ? 'unreadable'
        : renderedExact ? 'exact' : 'lossy_mismatch',
      causalSubmissionReceipt,
      composerPromptSha256: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
      renderedIdentityDiagnostic: {
        newUserMessageCount: newUserMessages.length,
        renderedContentCandidateCount,
        exactMatchCount: renderedExact ? 1 : 0,
        readableCandidateCount: message.textIdentityReadable === true ? 1 : 0,
        ...(renderedIdentity || {}),
        ...renderedContentDiagnostic
      }
    });
    if (!renderedExact) throw new Error('review_recovery_rendered_identity_unreadable');
    return {
      status: 'SENT_WAITING',
      userMessageId: message.id,
      conversationUrl: snapshot.url,
      conversationId: snapshot.conversationId,
      modelEvidence: persistedModelEvidence
    };
  }

  async #waitForAssistantStable({ timeoutMs = 5 * 60_000, stableMs = 3000, pollMs = 400, baselineAssistantCount = 0 } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_response', blocked: false, blockedKind: null, blockedTitle: null });
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const start = Date.now();
    let last = '';
    let lastChange = Date.now();
    let stopGoneAt = null;

    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const stop = Array.from(document.querySelectorAll(${stopSel})).some(visible);
        const send = Array.from(document.querySelectorAll(${sendSel})).find((n) => {
          return visible(n);
        });
        const sendEnabled = send ? !send.disabled : true;
        const nodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastNode = nodes[nodes.length - 1];
        const txt = String(lastNode?.innerText || '').trim();
        const hasContinue = Array.from(document.querySelectorAll('button, a')).some(b => /continue generating/i.test((b.textContent||'').trim()));
        const hasRegenerate = Array.from(document.querySelectorAll('button, a')).some(b => /regenerate/i.test((b.textContent||'').trim()));
        const hasAnswerNow = Array.from(document.querySelectorAll('button, a')).some(b => /answer now/i.test((b.textContent||'').trim()));
        const hasRetry = Array.from(document.querySelectorAll('button, a')).some(b => /^(retry|try again|retry response)$/i.test((b.textContent||'').trim()));
        const hasError = /something went wrong|try again|error/i.test(txt) && txt.length < 500;
        return { stop, sendEnabled, txt, count: nodes.length, hasError, hasContinue, hasRegenerate, hasAnswerNow, hasRetry };
      })()`);

      const txt = String(snap?.txt || '');
      if (txt !== last) {
        last = txt;
        lastChange = Date.now();
      }

      const generating = !!snap?.stop;
      if (generating) stopGoneAt = null;
      else if (stopGoneAt == null) stopGoneAt = Date.now();

      const dynamicStableMs = Math.max(stableMs, txt.length > 8000 ? 3000 : txt.length > 2000 ? 2200 : stableMs);
      const stable = Date.now() - lastChange >= dynamicStableMs;
      const stopGoneLongEnough = stopGoneAt != null && Date.now() - stopGoneAt >= 800;
      const transientPlaceholder = /^(?:(?:gpt[-\s]?\S+|pro)\s+)?thinking(?:[.…]{0,3})?$/i.test(txt.trim());

      const readyByNodes = (snap?.count || 0) > baselineAssistantCount;
      const done =
        !generating && !snap?.hasContinue && !snap?.hasAnswerNow && stopGoneLongEnough &&
        snap?.sendEnabled && stable && txt.length > 0 && !snap?.hasError &&
        !snap?.hasRetry && !transientPlaceholder && readyByNodes;
      if (done) {
        const extra = await this.#eval(`(() => {
          const nodes = Array.from(document.querySelectorAll(${assistantSel}));
          const lastNode = nodes[nodes.length - 1];
          const codes = Array.from(lastNode?.querySelectorAll('pre code') || []).map(c => {
            const cls = String(c.className || '');
            const lang = (cls.match(/language-([a-z0-9_-]+)/i) || [])[1] || null;
            return { language: lang, text: (c.innerText || '').trim() };
          }).filter(c => c.text);
          return { codeBlocks: codes };
        })()`);
        return { text: txt, codeBlocks: extra?.codeBlocks || [], meta: { count: snap?.count || 0, hasError: !!snap?.hasError } };
      }

      await sleep(pollMs);
    }

    const err = new Error('timeout_waiting_for_response');
    err.data = { last };
    throw err;
  }

  async query({ prompt, attachments = [], expectedModel = '', timeoutMs = 10 * 60_000, onProgress = null } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');
    const run = { kind: 'query', requested: false, requestedAt: null, reason: null, onProgress };
    this.currentRun = run;
    try {
      await this.ensureReady({ timeoutMs });
      const verifiedModelState = await this.#ensureExpectedModel(expectedModel, Math.min(timeoutMs, 60_000));
      await this.#attachFiles(attachments);
      await this.#typePrompt(prompt, { human: false });
      const baselineAssistantCount = Number(await this.#eval(`(() => document.querySelectorAll(${JSON.stringify(this.selectors.assistantMessage)}).length)()`)) || 0;
      await this.#clickSend();
      const result = await this.#waitForAssistantStable({ timeoutMs: Math.min(timeoutMs, 45 * 60_000), baselineAssistantCount });
      return { ...result, ...(await this.#completionMetadata(expectedModel, verifiedModelState)) };
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  async waitForCurrentResponse({ timeoutMs = 45 * 60_000, onProgress = null, expectedModel = '' } = {}) {
    const run = { kind: 'wait_response', requested: false, requestedAt: null, reason: null, onProgress };
    this.currentRun = run;
    try {
      const assistantSel = JSON.stringify(this.selectors.assistantMessage);
      const stopSel = JSON.stringify(this.selectors.stopButton);
      const sendSel = JSON.stringify(this.selectors.sendButton);
      const initial = await this.#eval(`(() => {
        const stop = !!document.querySelector(${stopSel});
        const send = Array.from(document.querySelectorAll(${sendSel})).find((n) => {
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const generating = stop && send ? !!send.disabled : stop;
        const hasContinue = Array.from(document.querySelectorAll('button, a')).some(b => /continue generating/i.test((b.textContent||'').trim()));
        const hasAnswerNow = Array.from(document.querySelectorAll('button, a')).some(b => /answer now/i.test((b.textContent||'').trim()));
        const assistants = Array.from(document.querySelectorAll(${assistantSel}));
        const users = Array.from(document.querySelectorAll('[data-message-author-role="user"], user-query, [data-test-id="user-query"]'));
        return {
          count: assistants.length,
          active: generating || hasContinue || hasAnswerNow,
          latestAssistantText: String(assistants[assistants.length - 1]?.innerText || '').trim(),
          latestUserText: String(users[users.length - 1]?.innerText || '').trim()
        };
      })()`);
      if (!initial?.active) {
        const text = String(initial?.latestAssistantText || '');
        if (!text) throw new Error('no_active_response');
        const result = await this.#waitForAssistantStable({
          timeoutMs: Math.min(timeoutMs, 45 * 60_000),
          baselineAssistantCount: Math.max(0, Number(initial.count || 0) - 1)
        });
        result.meta = {
          ...(result.meta || {}),
          recoveredFromIdle: true,
          latestUserText: String(initial?.latestUserText || '')
        };
        return { ...result, ...(await this.#completionMetadata(expectedModel)) };
      }
      const result = await this.#waitForAssistantStable({
        timeoutMs: Math.min(timeoutMs, 45 * 60_000),
        baselineAssistantCount: Math.max(0, Number(initial.count || 0) - 1)
      });
      return { ...result, ...(await this.#completionMetadata(expectedModel)) };
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  async send({ text, timeoutMs = 3 * 60_000, stopAfterSend = false, onProgress = null } = {}) {
    const prompt = String(text || '');
    if (!prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');

    return await this.mutex.run(async () => {
      const run = { kind: 'send', requested: false, requestedAt: null, reason: null, onProgress };
      this.currentRun = run;
      try {
        await this.ensureReady({ timeoutMs });
        await this.#typePrompt(prompt);
        await this.#clickSend();

        if (stopAfterSend) {
          const start = Date.now();
          while (Date.now() - start < 2500) {
            this.#throwIfStopRequested();
            const clicked = await this.#clickVisibleStop();
            if (clicked) break;
            await sleep(120);
          }
        }

        return { ok: true };
      } finally {
        if (this.currentRun === run) this.currentRun = null;
      }
    });
  }

  async getLastAssistantImages({ maxImages = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1] || document.querySelector('main') || document.body;
      if (!last) return [];
      const results = [];
      const seen = new Set();
      const push = (item) => {
        const key = String(item.dataUrl || item.src || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        results.push(item);
      };
      const collectRoot = (root) => Array.from(root.querySelectorAll('img')).filter((img) => {
        const r = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || '';
        return src && r.width >= 64 && r.height >= 64;
      });
      const imgs = [...collectRoot(last), ...collectRoot(document.querySelector('main') || document.body)];
      for (const img of imgs) {
        if (results.length >= ${maxImages}) break;
        const src = img.currentSrc || img.src || '';
        const alt = img.alt || '';
        if (!src) continue;
        if (src.startsWith('blob:') || src.startsWith('https://') || src.startsWith('http://')) {
          try {
            const r = await fetch(src);
            const b = await r.blob();
            if (b.size > 15 * 1024 * 1024) { push({ src, alt }); continue; }
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onerror = () => reject(new Error('file_reader_error'));
              fr.onload = () => resolve(String(fr.result || ''));
              fr.readAsDataURL(b);
            });
            push({ src, alt, dataUrl });
            continue;
          } catch {}
        }
        push({ src, alt });
      }

      const canvases = Array.from(last.querySelectorAll('canvas'));
      for (let i = 0; i < canvases.length && results.length < ${maxImages}; i++) {
        const c = canvases[i];
        try {
          const dataUrl = c.toDataURL('image/png');
          if (dataUrl && dataUrl.startsWith('data:image/')) {
            push({ src: 'canvas:' + (i + 1), alt: 'canvas', dataUrl });
          }
        } catch {}
      }

      if (results.length < ${maxImages}) {
        const bgEls = Array.from((document.querySelector('main') || last).querySelectorAll('*')).filter(el => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s && s.backgroundImage && s.backgroundImage.includes('url(') && r.width >= 64 && r.height >= 64;
        }).slice(0, 50);
        for (const el of bgEls) {
          if (results.length >= ${maxImages}) break;
          const s = getComputedStyle(el).backgroundImage || '';
          const m = s.match(/url\\([\"']?([^\"')]+)[\"']?\\)/i);
          const src = m?.[1] || '';
          if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:'))) push({ src, alt: 'background-image' });
        }
      }

      if (results.length < ${maxImages}) {
        const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
          const href = String(a.href || '');
          return /\\.(png|jpe?g|webp)(\\?|#|$)/i.test(href) || /download|image|generated/i.test((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || ''));
        });
        for (const a of links) {
          if (results.length >= ${maxImages}) break;
          const src = String(a.href || '');
          if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:')) push({ src, alt: (a.textContent || '').trim() || 'link' });
        }
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async downloadLastAssistantImages({ maxImages = 6, outDir = path.join(this.stateDir, 'downloads') } = {}) {
    const imgs = await this.getLastAssistantImages({ maxImages });
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      let dataUrl = img.dataUrl || null;
      let mime = null;
      let buf = null;

      if (dataUrl && /^data:/i.test(dataUrl)) {
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && img.src && /^https?:\/\//i.test(img.src)) {
        const r = await fetch(img.src);
        if (!r.ok) continue;
        mime = r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const ext =
        mime?.includes('png') ? 'png' : mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' : mime?.includes('webp') ? 'webp' : 'bin';
      const name = `agentify-${Date.now()}-${String(i + 1).padStart(2, '0')}.${ext}`;
      const file = path.join(outDir, name);
      await fs.writeFile(file, buf);
      saved.push({ path: file, alt: img.alt || '', mime: mime || null, source: img.src || null });
    }

    return saved;
  }

  async getLastAssistantDownloads({ maxFiles = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1];
      if (!last) return [];
      const anchors = Array.from(last.querySelectorAll('a[href], a[download]'));
      const results = [];
      const seen = new Set();
      for (const a of anchors) {
        if (results.length >= ${maxFiles}) break;
        const href = String(a.href || a.getAttribute('href') || '').trim();
        const download = String(a.getAttribute('download') || '').trim();
        const text = String(a.textContent || '').trim();
        const title = String(a.getAttribute('title') || '').trim();
        const rawName = download || text || title || '';
        if (!href || seen.has(href)) continue;
        if (
          !/^blob:|^data:|^https?:/i.test(href) &&
          !/(download|export|attachment|file|csv|json|zip|pdf|doc|sheet|image)/i.test(rawName)
        ) {
          continue;
        }
        seen.add(href);
        const item = { href, name: rawName || null };
        if (/^blob:|^data:/i.test(href)) {
          try {
            const r = await fetch(href);
            const b = await r.blob();
            if (b.size <= 25 * 1024 * 1024) {
              const dataUrl = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onerror = () => reject(new Error('file_reader_error'));
                fr.onload = () => resolve(String(fr.result || ''));
                fr.readAsDataURL(b);
              });
              item.dataUrl = dataUrl;
            }
            item.mime = b.type || null;
            item.size = b.size || null;
          } catch {}
        }
        results.push(item);
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async downloadLastAssistantFiles({ maxFiles = 6, outDir = path.join(this.stateDir, 'downloads') } = {}) {
    const items = await this.getLastAssistantDownloads({ maxFiles });
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let mime = item.mime || null;
      let buf = null;

      if (item.dataUrl && /^data:/i.test(item.dataUrl)) {
        const m = String(item.dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = mime || m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && item.href && /^https?:\/\//i.test(item.href)) {
        const r = await fetch(item.href);
        if (!r.ok) continue;
        mime = mime || r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const nameHint = String(item.name || '').trim();
      const urlName = (() => {
        try {
          const u = new URL(String(item.href || ''));
          return path.basename(u.pathname || '');
        } catch {
          return '';
        }
      })();
      const extFromMime =
        mime?.includes('json') ? 'json' :
        mime?.includes('csv') ? 'csv' :
        mime?.includes('pdf') ? 'pdf' :
        mime?.includes('zip') ? 'zip' :
        mime?.includes('markdown') ? 'md' :
        mime?.includes('plain') ? 'txt' :
        mime?.includes('png') ? 'png' :
        mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' :
        mime?.includes('webp') ? 'webp' :
        'bin';
      const baseName = (nameHint || urlName || `chatgpt-file-${Date.now()}-${String(i + 1).padStart(2, '0')}`).replace(/[\\/:*?"<>|]+/g, '-');
      const nameWithExt = path.extname(baseName) ? baseName : `${baseName}.${extFromMime}`;
      const parsed = path.parse(nameWithExt);
      let finalName = nameWithExt;
      for (let suffix = 1; suffix < 1000; suffix++) {
        try {
          await fs.access(path.join(outDir, finalName));
          finalName = `${parsed.name}-${suffix}${parsed.ext}`;
        } catch {
          break;
        }
      }
      const file = path.join(outDir, finalName);
      await fs.writeFile(file, buf);
      saved.push({ path: file, name: finalName, mime: mime || null, source: item.href || null });
    }

    return saved;
  }
}
