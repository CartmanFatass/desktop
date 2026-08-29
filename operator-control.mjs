import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MODEL = 'agentify_native_operator_observe_act_v1';
const FORBIDDEN = /(?:^|\b)(?:send|submit|stop|retry|continue|regenerate|answer now|response retry|发送|提交|停止|重试|继续|重新生成|立即回答)(?:\b|$)/i;
const KEY_ALLOWLIST = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape', 'Enter', ' ', 'Backspace', 'Delete', 'Home', 'End', 'a']);

function fail(message, data = null) {
  const error = new Error(message);
  if (data) error.data = data;
  throw error;
}

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function boundedText(value, limit = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function targetId(url, item) {
  return `target:${digest(JSON.stringify({ url, role: item.role, label: item.label, kind: item.kind, testId: item.testId, bounds: item.bounds, reasoningText: item.reasoningText || '' }))}`;
}

// This is deliberately a small, data-only resolver so that the same strict
// admission rule is used by the page snapshot and its offline fixtures. Text
// alone is never a target: it must resolve to one current, visible, hit-tested
// actionable ancestor. High is a picker trigger; Pro is an item in its already
// rendered menu. Both branches fail closed on ambiguity.
export function resolveVisibleReasoningTargets(candidates = []) {
  const exact = new Set(['High', 'Pro']);
  const eligible = (c) => exact.has(String(c?.text || ''))
    && c?.visible === true && c?.inViewport === true && c?.hitTested === true
    && c?.actionable === true && c?.ambiguous !== true && c?.forbidden !== true
    && /^(?:button|a|input|role:button|menuitem|menuitemradio|option)$/i.test(String(c?.role || ''));
  const exclusionReasons = (text, c) => {
    const reasons = [];
    if (c?.visible !== true) reasons.push('not_visible');
    if (c?.inViewport !== true) reasons.push('outside_viewport');
    if (c?.hitTested !== true) reasons.push('hit_test_failed');
    if (c?.actionable !== true) reasons.push('not_actionable');
    if (c?.ambiguous === true) reasons.push('ambiguous_ancestor');
    if (c?.forbidden === true) reasons.push('forbidden_control');
    if (!/^(?:button|a|input|role:button|menuitem|menuitemradio|option)$/i.test(String(c?.role || ''))) reasons.push('unsupported_role');
    if (text === 'High' && c?.popupRelation !== true) reasons.push('high_missing_popup_relation');
    if (text === 'High' && c?.menuScoped === true) reasons.push('high_is_menu_scoped');
    if (text === 'Pro' && c?.menuScoped !== true) reasons.push('pro_not_menu_scoped');
    return reasons;
  };
  const result = { targets: [], diagnostics: {} };
  for (const text of ['High', 'Pro']) {
    const scoped = candidates.filter((c) => String(c?.text || '') === text);
    const valid = scoped.filter((c) => eligible(c)
      && (text === 'High' ? c.popupRelation === true && c.menuScoped !== true : c.menuScoped === true));
    const unique = [...new Map(valid.map((c) => [String(c.ancestorKey || ''), c])).values()];
    const reason = unique.length === 1
      ? 'unique_visible_actionable_reasoning_ancestor'
      : scoped.length === 0 ? 'not_observed' : unique.length > 1 ? 'ambiguous_actionable_ancestors' : 'no_eligible_visible_actionable_ancestor';
    // Keep diagnosis result-blind: it records only control shape and exclusion
    // predicates, never arbitrary ancestor labels or page text.
    const candidateAudit = scoped.map((c) => ({
      source: c?.source || '', ancestorKey: c?.ancestorKey || '', role: c?.role || '',
      bounds: c?.bounds || null, visible: c?.visible === true, inViewport: c?.inViewport === true,
      hitTested: c?.hitTested === true, actionable: c?.actionable === true,
      ambiguous: c?.ambiguous === true, forbidden: c?.forbidden === true,
      popupRelation: c?.popupRelation === true, menuScoped: c?.menuScoped === true,
      exclusionReasons: exclusionReasons(text, c)
    }));
    result.diagnostics[text] = { observedCount: scoped.length, eligibleCount: unique.length, accepted: unique.length === 1, reason, candidates: candidateAudit };
    if (unique.length === 1) {
      const c = unique[0];
      result.targets.push({ text, ancestorKey: c.ancestorKey, role: c.role, label: c.label, bounds: c.bounds, hitTested: true, menuScoped: c.menuScoped === true, source: c.source });
    }
  }
  return result;
}

const SNAPSHOT = `(() => {
  const resolveVisibleReasoningTargets = ${resolveVisibleReasoningTargets.toString()};
  const painted = (node) => {
    const r = node?.getBoundingClientRect?.(); const s = node ? window.getComputedStyle(node) : null;
    return !!r && r.width > 0 && r.height > 0 && s?.display !== 'none' && s?.visibility !== 'hidden' && s?.pointerEvents !== 'none';
  };
  const inViewport = (node) => { const r = node?.getBoundingClientRect?.(); return !!r && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight; };
  const visible = (node) => painted(node) && inViewport(node);
  const label = (node) => {
    const aria = node.getAttribute('aria-label');
    if (aria) return aria.replace(/\\s+/g, ' ').trim();
    const ids = String(node.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
    const named = ids.map((id) => document.getElementById(id)?.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
    return named || String(node.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  const isEditable = (n) => !!(n?.isContentEditable || /^(textarea|input)$/i.test(n?.tagName || ''));
  const composer = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')).filter(visible).find(isEditable) || null;
  const controlSelector = 'button, a[href], input, textarea, [contenteditable="true"], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="checkbox"], [role="textbox"]';
  const nodes = Array.from(document.querySelectorAll(controlSelector));
  const records = nodes.map((node, index) => {
      const r = node.getBoundingClientRect(); const x = r.x + r.width / 2; const y = r.y + r.height / 2;
      const hit = visible(node) ? document.elementFromPoint(x, y) : null;
      const text = label(node).slice(0, 160);
      return { node, ancestorKey: 'control:' + index, role: String(node.getAttribute('role') || node.tagName || '').toLowerCase(), label: text, kind: isEditable(node) ? 'editable' : 'interactive', testId: String(node.getAttribute('data-testid') || '').slice(0, 120), selected: node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-checked') === 'true' || node.classList.contains('selected'), expanded: node.getAttribute('aria-expanded') === 'true', focused: document.activeElement === node, bounds: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, visible: visible(node), inViewport: inViewport(node), hitTested: !!hit && (hit === node || node.contains(hit) || hit.contains(node)), forbidden: /(?:send|submit|stop|retry|continue|regenerate|answer now|response retry|发送|提交|停止|重试|继续|重新生成|立即回答)/i.test(text + ' ' + String(node.getAttribute('data-testid') || '')), popupRelation: /^(?:menu|listbox)$/i.test(String(node.getAttribute('aria-haspopup') || '')) || !!node.getAttribute('aria-controls'), menuScoped: !!node.closest('[role="menu"], [role="listbox"]') };
    });
  const duplicate = new Map(); for (const c of records.filter((c) => c.visible && (c.label || c.testId))) { const k = [c.role, c.label, c.kind].join('\\0'); duplicate.set(k, (duplicate.get(k) || 0) + 1); }
  for (const c of records) c.ambiguous = (duplicate.get([c.role, c.label, c.kind].join('\\0')) || 0) !== 1;
  for (const c of records) c.actionable = !!c.visible && !!c.hitTested && !c.forbidden && !c.ambiguous;
  const byNode = new Map(records.map((c) => [c.node, c]));
  const reasoningCandidates = [];
  const addCandidate = (text, node, source) => {
    const ancestor = node?.closest?.(controlSelector); const c = ancestor ? byNode.get(ancestor) : null;
    reasoningCandidates.push({ text, source, ancestorKey: c?.ancestorKey || '', role: c?.role || '', label: c?.label || '', bounds: c?.bounds || null, visible: c?.visible === true, inViewport: c?.inViewport === true, hitTested: c?.hitTested === true, actionable: c?.actionable === true, ambiguous: c?.ambiguous === true, forbidden: c?.forbidden === true, popupRelation: c?.popupRelation === true, menuScoped: c?.menuScoped === true });
  };
  for (const c of records) if (/^(?:High|Pro)$/.test(c.label)) addCandidate(c.label, c.node, 'accessible_label');
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) { const text = String(textNode.nodeValue || '').replace(/\\s+/g, ' ').trim(); if (/^(?:High|Pro)$/.test(text)) addCandidate(text, textNode.parentElement, 'rendered_text'); }
  const reasoning = resolveVisibleReasoningTargets(reasoningCandidates);
  const reasoningByAncestor = new Map(reasoning.targets.map((t) => [t.ancestorKey, t]));
  for (const c of records) { const target = reasoningByAncestor.get(c.ancestorKey); if (target) { c.reasoningStrength = true; c.reasoningText = target.text; c.reasoningSource = target.source; } }
  const prioritized = [...records.filter((c) => c.visible && reasoningByAncestor.has(c.ancestorKey)), ...records.filter((c) => c.visible && !reasoningByAncestor.has(c.ancestorKey))];
  const controls = prioritized.filter((item) => item.label || item.testId).slice(0, 80).map(({ node, ancestorKey, visible: _visible, inViewport: _inViewport, popupRelation, menuScoped, ...item }) => item);
  const activeLabels = controls.filter((c) => c.forbidden).map((c) => c.label);
  const composerText = composer ? (composer.isContentEditable ? (composer.textContent || '') : (composer.value || '')) : '';
  return { url: location.href, readyState: document.readyState, controls, reasoning, composer: composer ? { present: true, kind: composer.isContentEditable ? 'contenteditable' : String(composer.tagName || '').toLowerCase(), empty: composerText.length === 0, textLength: composerText.length, textSha256: '' } : { present: false }, generation: { activeForbiddenControlLabels: activeLabels }, targetCount: controls.length };
})()`;

export class NativeOperatorControl {
  constructor({ page }) { this.page = page; this.observations = new Map(); }

  async #snapshot(tabId) {
    const raw = await this.page.evaluate(SNAPSHOT);
    const url = String(raw?.url || '');
    const controls = (raw?.controls || []).map((item) => ({ ...item, targetId: targetId(url, item), actionable: !!item.hitTested && !item.forbidden && !item.ambiguous }));
    const composer = raw?.composer || { present: false };
    if (composer.present) composer.textSha256 = digest(await this.page.evaluate(`(() => { const n = Array.from(document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"]')).find((x) => { const r=x.getBoundingClientRect(), s=getComputedStyle(x); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; }); return n ? (n.isContentEditable ? (n.textContent || '') : (n.value || '')) : ''; })()`));
    const state = { model: MODEL, tabId, url, readyState: String(raw?.readyState || 'loading'), controls, reasoning: raw?.reasoning || { targets: [], diagnostics: {} }, composer, generation: raw?.generation || { activeForbiddenControlLabels: [] } };
    const revision = `obs:${digest(JSON.stringify(state))}`;
    const observation = { ...state, revision };
    this.observations.set(revision, observation);
    return observation;
  }

  async observe({ tabId }) { return await this.#snapshot(tabId); }

  async wait({ tabId, url = '', role = '', label = '', selected = null, timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + Math.max(250, Math.min(60_000, Number(timeoutMs || 0)));
    const timeline = [];
    let delay = 80;
    while (true) {
      const observed = await this.#snapshot(tabId);
      const urlMatches = !url || observed.url === String(url);
      const candidates = observed.controls.filter((item) => (!role || item.role === String(role).toLowerCase()) && (!label || item.label === String(label)) && (selected === null || item.selected === selected));
      const interactive = observed.readyState !== 'loading' && observed.controls.some((item) => item.actionable);
      const satisfied = urlMatches && (label || role ? candidates.length === 1 && candidates[0].actionable : interactive);
      timeline.push({ at: Date.now(), url: observed.url, readyState: observed.readyState, targetCount: observed.controls.length, candidateCount: candidates.length, interactive, revision: observed.revision });
      if (satisfied) return { model: MODEL, status: 'SATISFIED', tabId, predicate: { url, role, label, selected }, attempts: timeline.length, observation: observed, timeline };
      if (Date.now() >= deadline) fail('LOAD_OR_POSTCONDITION_UNRESOLVED', { tabId, predicate: { url, role, label, selected }, timeline });
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(800, Math.ceil(delay * 1.8));
    }
  }

  async act({ tabId, url, revision, targetId: wantedTargetId, action, key, modifiers = [], textPath, textSha256 }) {
    const prior = this.observations.get(String(revision || ''));
    if (!prior) fail('operator_observation_unknown');
    if (prior.tabId !== tabId || prior.url !== String(url || '')) fail('operator_observation_binding_mismatch');
    const currentUrl = String(await this.page.getUrl());
    if (currentUrl !== prior.url) fail('operator_url_changed');
    const current = await this.#snapshot(tabId);
    if (current.revision !== prior.revision) fail('operator_observation_stale');
    const target = current.controls.filter((item) => item.targetId === wantedTargetId);
    if (target.length !== 1 || !target[0].actionable || FORBIDDEN.test(`${target[0].label} ${target[0].testId}`)) fail('operator_target_unavailable');
    const kind = String(action || '').trim().toLowerCase();
    if (kind === 'click') {
      const b = target[0].bounds; await this.page.moveMouse(b.x + b.w / 2, b.y + b.h / 2); await this.page.mouseDown(b.x + b.w / 2, b.y + b.h / 2, { button: 'left', clickCount: 1 }); await this.page.mouseUp(b.x + b.w / 2, b.y + b.h / 2, { button: 'left', clickCount: 1 });
    } else if (kind === 'key') {
      if (!target[0].focused || !KEY_ALLOWLIST.has(String(key || ''))) fail('operator_key_target_not_focused');
      await this.page.sendKey(String(key), { modifiers: Array.isArray(modifiers) ? modifiers : [] });
    } else if (kind === 'text' || kind === 'paste') {
      if (target[0].kind !== 'editable' || !textPath || !textSha256 || !path.isAbsolute(String(textPath))) fail('operator_text_preparation_invalid');
      const bytes = await fs.readFile(path.resolve(String(textPath))); const actualSha = digest(bytes);
      if (actualSha !== String(textSha256).toLowerCase()) fail('operator_text_sha_mismatch');
      await this.page.insertText(bytes.toString('utf8'));
    } else fail('operator_action_unsupported');
    const after = await this.#snapshot(tabId);
    return { model: MODEL, tabId, url: current.url, action: kind, targetId: wantedTargetId, beforeRevision: revision, afterRevision: after.revision, promptInsertCount: kind === 'text' || kind === 'paste' ? 1 : 0, sendActionCount: 0, operationCreated: false, after };
  }
}
