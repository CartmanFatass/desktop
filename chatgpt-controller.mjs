import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const BLOCKED_PAGE_TEXT_PATTERN = /\b403\b|access denied|forbidden|unusual traffic|verify you are human|human verification/i;

export function looksLikeBlockedPage(bodyText) {
  return BLOCKED_PAGE_TEXT_PATTERN.test(String(bodyText || ''));
}

export function classifyReviewControls(labels, { selectorStop = false, sendVisible = false } = {}) {
  const values = Array.isArray(labels)
    ? labels.map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
  const has = (pattern) => values.some((value) => pattern.test(value));
  return {
    stop: !!selectorStop || has(/^(stop|stop generating|stop response)$/i),
    continue: has(/^(continue|continue generating|continue response)$/i),
    retry: has(/^(retry|response retry|try again|retry response)$/i),
    answerNow: has(/^answer now$/i),
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

export function canonicalizeGeminiReviewMessageNodes(nodes, userSelector) {
  const accepted = [];
  for (const node of Array.from(nodes || [])) {
    const role = node?.matches?.(userSelector) ? 'user' : 'assistant';
    const host = node?.closest?.('[data-message-id], [data-turn-id]') || null;
    const identity = String(
      host?.getAttribute?.('data-message-id') || host?.getAttribute?.('data-turn-id') || node?.id || ''
    ).trim();
    const duplicate = accepted.some((entry) =>
      entry.role === role && (
        (identity && entry.identity === identity) || entry.node?.contains?.(node)
      )
    );
    if (!duplicate) accepted.push({ node, role, identity });
  }
  return accepted;
}

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
    if (tag === 'BR') return { ok: true, text: '\n', block: false };
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
  const discovered = typeof root.querySelectorAll === 'function'
    ? Array.from(root.querySelectorAll(selector))
    : [];
  const isControl = (node) => {
    const tag = String(node?.tagName || '').toUpperCase();
    const role = String(node?.getAttribute?.('role') || '').toLowerCase();
    return tag === 'BUTTON' || tag === 'A' || role === 'button' || !!node?.closest?.('button, [role="button"], a');
  };
  const candidates = discovered.length
    ? discovered.filter((node) => {
      if (isControl(node)) return false;
      if (typeof node?.querySelectorAll !== 'function') return true;
      return Array.from(node.querySelectorAll(selector)).length === 0;
    })
    : isControl(root) ? [] : [root];
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
  const exactTexts = [...new Set(serialized.map((entry) => entry.text))];
  if (exactTexts.length !== 1) {
    return {
      ok: false,
      error: 'review_user_message_content_ambiguous',
      candidateCount: candidates.length,
      distinctTextCount: exactTexts.length
    };
  }
  const structure = candidates.length === 1 ? summarizeReviewComposerStructure(candidates[0]) : {};
  return { ok: true, text: exactTexts[0], candidateCount: candidates.length, ...structure };
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
  constructor({ page, selectors, onBlocked, onUnblocked, stateDir }) {
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

  async detectChallenge() {
    const result = await this.#eval(`(() => {
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
      const loginLike = !!document.querySelector('input[type=\"password\"], input[name=\"password\"], input[autocomplete=\"current-password\"]')
        || /log in|sign in|continue with/i.test(bodyText);

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
      const promptVisible = rawPromptVisible && (!loginLike || sendVisible);

      const blocked = hasTurnstile || hasArkose || hasVerifyButton || looks403 || (loginLike && !promptVisible);
      const kind = (hasTurnstile || hasArkose || hasVerifyButton) ? 'captcha' : (loginLike ? 'login' : (looks403 ? 'blocked' : null));
      return {
        url, title, readyState,
        blocked,
        promptVisible,
        kind,
        indicators: { hasTurnstile, hasArkose, hasVerifyButton, looks403, loginLike, rawPromptVisible, sendVisible }
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
    return await this.#eval(`(() => {
        const reviewComposerDiagnosticMarker = true;
        const expected = ${expected};
        const serializeReviewComposer = ${serializeReviewComposer.toString()};
        const summarizeReviewComposerStructure = ${summarizeReviewComposerStructure.toString()};
        const visible = (n) => {
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const editable = (n) => {
          if (!n || !visible(n)) return false;
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
        const base = Array.from(document.querySelectorAll(${sel}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
        const candidates = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          if (editable(n)) candidates.push(n);
        }
        candidates.sort((a, b) => score(b) - score(a));
        const el = candidates[0] || null;
        if (!el) {
          return {
            ok: false,
            error: 'missing_prompt_textarea',
            candidateCount: candidates.length,
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
        return {
          ok: serialized.ok === true && serialized.text === expected,
          candidateCount: candidates.length,
          serializerOk: serialized.ok === true,
          serializerMethod: serialized.method,
          serializerError: serialized.error || null,
          serializerTag: serialized.tag || null,
          serializedLength: String(serialized.text || '').length,
          observedLengths: observed.map(value => value.length),
          expectedLength: expected.length,
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

  async #ensureExpectedModel(expectedModel, timeoutMs = 20_000) {
    const expected = String(expectedModel || '').trim();
    if (!expected) return null;
    const modelSel = JSON.stringify(
      this.selectors.reviewModelEvidence || 'button[data-testid*="model" i], [role="button"][data-testid*="model" i], button[aria-label*="model" i], [role="button"][aria-label*="model" i]'
    );
    const readModel = async () => await this.#eval(`(() => {
      const agentifyModelStateMarker = true;
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        const style = node ? window.getComputedStyle(node) : null;
        return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
      };
      const canonical = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^(?:chatgpt|gpt)/, '');
      const expected = ${JSON.stringify(expected)};
      const labels = Array.from(document.querySelectorAll(${modelSel}))
        .filter(visible)
        .map((node) => String(node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return { matched: labels.some((label) => canonical(label) === canonical(expected)), labels };
    })()`);
    let state = await readModel();
    if (state?.matched) return state;

    await this.#emitProgress({ phase: 'selecting_model' });
    const opened = await this.#eval(`(() => {
      const agentifyOpenModelPickerMarker = true;
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        const style = node ? window.getComputedStyle(node) : null;
        return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
      };
      const preferred = Array.from(document.querySelectorAll('button[data-testid*="model-switcher" i], [role="button"][data-testid*="model-switcher" i]')).filter(visible);
      const fallback = Array.from(document.querySelectorAll(${modelSel})).filter((node) => visible(node) && node.matches('button, [role="button"]'));
      const picker = preferred[0] || fallback[0] || null;
      if (!picker) return { ok: false, error: 'model_switcher_unavailable' };
      picker.click();
      return { ok: true };
    })()`);
    if (!opened?.ok) throw new Error(opened?.error || 'model_switcher_unavailable');
    await sleep(250);

    const chosen = await this.#eval(`(() => {
      const agentifyChooseModelMarker = true;
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        const style = node ? window.getComputedStyle(node) : null;
        return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
      };
      const canonical = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^(?:chatgpt|gpt)/, '');
      const expected = ${JSON.stringify(expected)};
      const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [data-testid*="model-option" i], [data-radix-collection-item]'))
        .filter(visible)
        .filter((node) => canonical(node.textContent || node.getAttribute('aria-label') || '') === canonical(expected));
      const target = candidates[0] || null;
      if (!target) return { ok: false, error: 'expected_model_unavailable' };
      target.click();
      return { ok: true };
    })()`);
    if (!chosen?.ok) throw new Error(chosen?.error || 'expected_model_unavailable');

    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    while (Date.now() < deadline) {
      state = await readModel();
      if (state?.matched) return state;
      await sleep(200);
    }
    throw new Error('expected_model_switch_unconfirmed');
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
      const canonicalizeGeminiReviewMessageNodes = ${canonicalizeGeminiReviewMessageNodes.toString()};
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
      const messageEntries = ${isGeminiLiteral}
        ? canonicalizeGeminiReviewMessageNodes(messageNodes, ${reviewUserSel})
        : messageNodes.map((node) => ({
          node,
          role: String(node.getAttribute('data-message-author-role') || '').trim(),
          identity: ''
        }));
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
      const modelEvidenceCandidates = deduplicateReviewModelEvidence(
        [...semanticModelNodes, ...composerModelNodes]
          .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim())
      );
      const sendCandidates = Array.from(document.querySelectorAll(${sendSel})).filter(visible);
      return {
        messages,
        modelEvidence: modelEvidenceCandidates.length === 1 ? modelEvidenceCandidates[0] : null,
        modelEvidenceCandidates,
        controlText,
        selectorStop,
        sendVisible: sendCandidates.length > 0
      };
    })()`);
    const conversationId = reviewConversationId(url);
    const controls = classifyReviewControls(dom?.controlText, {
      selectorStop: !!dom?.selectorStop,
      sendVisible: !!dom?.sendVisible
    });
    return { url, conversationId, ...(dom || {}), controls };
  }

  #assertReviewIdentity(snapshot, { expectedUrl, expectedConversationId, expectedModel, allowUnboundRoot = false }) {
    if (allowUnboundRoot && snapshot?.url === expectedUrl && !snapshot?.conversationId) return;
    if (snapshot?.url !== expectedUrl || snapshot?.conversationId !== expectedConversationId) {
      const error = new Error('review_conversation_identity_mismatch');
      error.data = { url: snapshot?.url || null, conversationId: snapshot?.conversationId || null };
      throw error;
    }
  }

  async #clickReviewSendOnce() {
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const result = await this.#eval(`(() => {
      const reviewSendOnceMarker = true;
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const label = (node) => [
        node.getAttribute('aria-label') || '',
        node.getAttribute('data-testid') || '',
        node.textContent || ''
      ].join(' ').trim();
      const prohibited = /continue|retry|try again|response retry|answer now|regenerate|stop/i;
      const candidates = Array.from(document.querySelectorAll(${sendSel}))
        .filter((node) => visible(node) && !node.disabled && !prohibited.test(label(node)));
      if (candidates.length !== 1) return { ok: false, error: 'review_send_control_ambiguous', count: candidates.length };
      candidates[0].click();
      return { ok: true, clickCount: 1, label: label(candidates[0]) };
    })()`);
    if (!result?.ok || result?.clickCount !== 1) {
      const error = new Error(result?.error || 'review_send_control_ambiguous');
      error.data = result && result.ok === false
        ? { ...result, noClickProven: true }
        : result || null;
      throw error;
    }
    return result;
  }

  async #waitForReviewUserMessage({ baselineIds, deadline, identity, firstBinding = false }) {
    let submittedUserMessageId = null;
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
        submittedUserMessageId ||= newUserMessages.at(-1).id;
        const message = newUserMessages.find((candidate) => candidate.id === submittedUserMessageId);
        if (!message) throw new Error('review_user_message_identity_unreadable');
        if (firstBinding && provisionalChatgptConversationId(snapshot.conversationId)) {
          await sleep(400);
          continue;
        }
        return { snapshot, message };
      }
      await sleep(400);
    }
    throw new Error('review_user_message_identity_unreadable');
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

  async #waitForReviewAssistant({ userMessageId, deadline, identity }) {
    let firstStable = null;
    while (Date.now() < deadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot(identity?.expectedModel);
      this.#assertReviewIdentity(snapshot, identity);
      const userIndex = (snapshot.messages || []).findIndex((message) => message.role === 'user' && message.id === userMessageId);
      if (userIndex < 0) throw new Error('review_user_message_identity_unreadable');
      const following = snapshot.messages.slice(userIndex + 1);
      const nextUserOffset = following.findIndex((message) => message.role === 'user');
      const targetTurn = nextUserOffset >= 0 ? following.slice(0, nextUserOffset) : following;
      const assistants = targetTurn.filter((message) => message.role === 'assistant');
      if (assistants.length > 1) throw new Error('review_assistant_message_ambiguous');
      const assistant = assistants[0] || null;
      const active = !!snapshot.controls?.stop || !!snapshot.controls?.continue || !!snapshot.controls?.retry;
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
            modelEvidence: snapshot.modelEvidence
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

  async reviewQuery({
    prompt,
    expectedUrl,
    expectedConversationId,
    expectedModel,
    timeoutMs,
    onPrepared,
    onSendAction,
    onSubmitted,
    firstBinding = false
  }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    const deadline = Date.now() + Number(timeoutMs || 0);
    const identity = { expectedUrl, expectedConversationId, expectedModel, allowUnboundRoot: firstBinding };
    const run = { kind: 'review_query', requested: false, requestedAt: null, reason: null, onProgress: null };
    this.currentRun = run;
    try {
      await this.ensureReady({ timeoutMs: Math.max(1, deadline - Date.now()) });
      const before = await this.#reviewSnapshot(expectedModel);
      this.#assertReviewIdentity(before, identity);
      const active = !!before.controls?.stop || !!before.controls?.continue || !!before.controls?.retry;
      if (active) {
        const latestUser = [...(before.messages || [])].reverse().find((message) => message.role === 'user' && message.id);
        if (!latestUser) throw new Error('review_user_message_identity_unreadable');
        return await this.#waitForReviewAssistant({ userMessageId: latestUser.id, deadline, identity });
      }
      const baselineIds = new Set((before.messages || []).map((message) => message.id));
      await onPrepared?.({
        baselineMessageIds: [...baselineIds],
        preparedAt: Date.now(),
        conversationUrl: before.url,
        conversationId: before.conversationId,
        modelEvidence: before.modelEvidence
      });
      await this.#typePrompt(prompt, { human: false });
      const clickReceipt = await this.#clickReviewSendOnce();
      await onSendAction?.({
        clickCount: clickReceipt?.clickCount || 0,
        sendActionCount: 1,
        sendActionAt: Date.now()
      });
      const submitted = await this.#waitForReviewUserMessage({ baselineIds, deadline, identity, firstBinding });
      const submittedIdentity = {
        expectedUrl: submitted.snapshot.url,
        expectedConversationId: submitted.snapshot.conversationId,
        expectedModel
      };
      await onSubmitted?.({
        userMessageId: submitted.message.id,
        submittedAt: Date.now(),
        conversationUrl: submitted.snapshot.url,
        conversationId: submitted.snapshot.conversationId,
        modelEvidence: submitted.snapshot.modelEvidence
      });
      return await this.#waitForReviewAssistant({
        userMessageId: submitted.message.id,
        deadline,
        identity: firstBinding ? submittedIdentity : identity
      });
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  async observeReviewResponse({ expectedUrl, expectedConversationId, expectedModel, userMessageId, timeoutMs }) {
    const deadline = Date.now() + Number(timeoutMs || 0);
    let identity = { expectedUrl, expectedConversationId, expectedModel };
    while (provisionalChatgptConversationId(identity.expectedConversationId) && Date.now() < deadline) {
      this.#throwIfStopRequested();
      const snapshot = await this.#reviewSnapshot(expectedModel);
      const sameUser = (snapshot.messages || []).some(
        (candidate) => candidate.role === 'user' && candidate.id === userMessageId
      );
      if (
        sameUser &&
        snapshot.url?.startsWith('https://chatgpt.com/c/') &&
        snapshot.conversationId &&
        !provisionalChatgptConversationId(snapshot.conversationId)
      ) {
        identity = { expectedUrl: snapshot.url, expectedConversationId: snapshot.conversationId, expectedModel };
        break;
      }
      await sleep(400);
    }
    if (provisionalChatgptConversationId(identity.expectedConversationId)) {
      throw new Error('review_first_binding_canonical_identity_unreadable');
    }
    return await this.#waitForReviewAssistant({
      userMessageId,
      deadline,
      identity
    });
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
    const exactMatches = newUserMessages.filter((message) => message.text === prompt);
    const readableCandidateCount = newUserMessages.filter((message) => message.textIdentityReadable === true).length;
    const message = newUserMessages.length ? newUserMessages[newUserMessages.length - 1] : null;
    const {
      candidateCount: renderedContentCandidateCount = null,
      ...renderedContentDiagnostic
    } = message?.textIdentityDiagnostic || {};
    return {
      ok: exactMatches.length === 1 && newUserMessages.length === 1,
      serializerOk: message?.textIdentityReadable === true,
      serializerMethod: 'rendered_user_message_structural',
      serializerError: message
        ? message.textIdentityError || (message.text === prompt ? null : 'review_user_message_content_mismatch')
        : 'review_user_message_count_mismatch',
      serializerTag: message?.textIdentityTag || null,
      serializedLength: Number.isInteger(message?.textLength) ? message.textLength : 0,
      observedLengths: Number.isInteger(message?.textLength) ? [message.textLength] : [],
      expectedLength: prompt.length,
      newUserMessageCount: newUserMessages.length,
      renderedContentCandidateCount,
      exactMatchCount: exactMatches.length,
      readableCandidateCount,
      ...renderedContentDiagnostic
    };
  }

  async recoverReviewSubmission({
    prompt,
    baselineMessageIds,
    expectedUrl,
    expectedConversationId,
    expectedModel,
    timeoutMs,
    exactComposerCausalBinding,
    onRecovered
  }) {
    const deadline = Date.now() + Number(timeoutMs || 0);
    const identity = { expectedUrl, expectedConversationId, expectedModel };
    const snapshot = await this.#reviewSnapshot(expectedModel);
    this.#assertReviewIdentity(snapshot, identity);
    if (!Array.isArray(baselineMessageIds)) throw new Error('review_submission_baseline_missing');
    const baselineIds = new Set(baselineMessageIds);
    const newUserMessages = (snapshot.messages || []).filter(
      (message) => message.role === 'user' && !baselineIds.has(message.id)
    );
    if (exactComposerCausalBinding !== true) throw new Error('review_composer_causal_binding_missing');
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
    const renderedExact = message.text === prompt;
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
      modelEvidence: snapshot.modelEvidence,
      identityMode: renderedExact ? 'rendered_exact' : 'exact_composer_causal_binding',
      composerPromptSha256: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
      renderedIdentityDiagnostic: {
        newUserMessageCount: newUserMessages.length,
        renderedContentCandidateCount,
        exactMatchCount: renderedExact ? 1 : 0,
        readableCandidateCount: message.textIdentityReadable === true ? 1 : 0,
        ...renderedContentDiagnostic
      }
    });
    return await this.#waitForReviewAssistant({ userMessageId: message.id, deadline, identity });
  }

  async #waitForAssistantStable({ timeoutMs = 5 * 60_000, stableMs = 1500, pollMs = 400, baselineAssistantCount = 0 } = {}) {
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
        const stop = !!document.querySelector(${stopSel});
        const send = Array.from(document.querySelectorAll(${sendSel})).find((n) => {
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const sendEnabled = send ? !send.disabled : true;
        const nodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastNode = nodes[nodes.length - 1];
        const fallbackMainText = ((document.querySelector('main') || document.body)?.innerText || '').trim();
        const txt = (lastNode?.innerText || fallbackMainText).trim();
        const hasContinue = Array.from(document.querySelectorAll('button, a')).some(b => /continue generating/i.test((b.textContent||'').trim()));
        const hasRegenerate = Array.from(document.querySelectorAll('button, a')).some(b => /regenerate/i.test((b.textContent||'').trim()));
        const hasAnswerNow = Array.from(document.querySelectorAll('button, a')).some(b => /answer now/i.test((b.textContent||'').trim()));
        const hasError = /something went wrong|try again|error/i.test(txt) && txt.length < 500;
        return { stop, sendEnabled, txt, count: nodes.length, usedFallback: !lastNode, hasError, hasContinue, hasRegenerate, hasAnswerNow };
      })()`);

      const txt = String(snap?.txt || '');
      if (txt !== last) {
        last = txt;
        lastChange = Date.now();
      }

      // Some providers expose unrelated visible "stop/cancel" controls.
      // Treat "generating" as stop-visible only when send is not enabled.
      const generating = !!snap?.stop && !snap?.sendEnabled;
      if (generating) stopGoneAt = null;
      else if (stopGoneAt == null) stopGoneAt = Date.now();

      const dynamicStableMs = Math.max(stableMs, txt.length > 8000 ? 3000 : txt.length > 2000 ? 2200 : stableMs);
      const stable = Date.now() - lastChange >= dynamicStableMs;
      const stopGoneLongEnough = stopGoneAt != null && Date.now() - stopGoneAt >= 800;

      const readyByNodes = (snap?.count || 0) > baselineAssistantCount;
      const fallbackWaited = !!snap?.usedFallback && (Date.now() - start >= 2500);
      const fallbackStableLongEnough = txt.length > 0 && (Date.now() - lastChange >= Math.max(dynamicStableMs, 5000));
      const done =
        (!generating && !snap?.hasContinue && !snap?.hasAnswerNow && stopGoneLongEnough && snap?.sendEnabled && stable && txt.length > 0 && (readyByNodes || fallbackWaited)) ||
        (!generating && !snap?.hasContinue && !snap?.hasAnswerNow && fallbackStableLongEnough && (readyByNodes || fallbackWaited));
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
      await this.#ensureExpectedModel(expectedModel, Math.min(timeoutMs, 20_000));
      await this.#attachFiles(attachments);
      await this.#typePrompt(prompt, { human: false });
      const baselineAssistantCount = Number(await this.#eval(`(() => document.querySelectorAll(${JSON.stringify(this.selectors.assistantMessage)}).length)()`)) || 0;
      await this.#clickSend();
      return await this.#waitForAssistantStable({ timeoutMs: Math.min(timeoutMs, 45 * 60_000), baselineAssistantCount });
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  async waitForCurrentResponse({ timeoutMs = 45 * 60_000, onProgress = null } = {}) {
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
        return { count: document.querySelectorAll(${assistantSel}).length, active: generating || hasContinue || hasAnswerNow };
      })()`);
      if (!initial?.active) throw new Error('no_active_response');
      return await this.#waitForAssistantStable({
        timeoutMs: Math.min(timeoutMs, 45 * 60_000),
        baselineAssistantCount: Math.max(0, Number(initial.count || 0) - 1)
      });
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
