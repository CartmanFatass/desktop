import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeOperatorControl, resolveVisibleReasoningTargets } from '../operator-control.mjs';

function reasoningCandidate(overrides = {}) {
  return {
    text: 'High', ancestorKey: 'high-trigger', role: 'button', label: 'High',
    bounds: { x: 10, y: 10, w: 40, h: 20 }, visible: true, inViewport: true,
    hitTested: true, actionable: true, ambiguous: false, forbidden: false,
    popupRelation: true, menuScoped: false, source: 'rendered_text', ...overrides
  };
}

function page({ label = 'Pro', url = 'https://chatgpt.com/', kind = 'interactive', focused = false } = {}) {
  const calls = [];
  return {
    calls,
    async getUrl() { return url; },
    async evaluate(js) {
      if (String(js).includes('const visible')) return {
        url,
        controls: [{ role: kind === 'editable' ? 'textbox' : 'button', label, kind, testId: 'mode-picker', selected: false, expanded: false, focused, bounds: { x: 10, y: 20, w: 40, h: 20 }, hitTested: true, forbidden: false }],
        composer: { present: false }, generation: { activeForbiddenControlLabels: [] }
      };
      return '';
    },
    async moveMouse(...args) { calls.push(['move', ...args]); },
    async mouseDown(...args) { calls.push(['down', ...args]); },
    async mouseUp(...args) { calls.push(['up', ...args]); },
    async sendKey(...args) { calls.push(['key', ...args]); },
    async insertText(...args) { calls.push(['text', ...args]); }
  };
}

test('operator control: click is bound to a current visible observation and returns zero-send receipt', async () => {
  const p = page(); const control = new NativeOperatorControl({ page: p });
  const observed = await control.observe({ tabId: 'tab-1' });
  const result = await control.act({ tabId: 'tab-1', url: observed.url, revision: observed.revision, targetId: observed.controls[0].targetId, action: 'click' });
  assert.equal(result.sendActionCount, 0);
  assert.equal(result.operationCreated, false);
  assert.equal(p.calls.filter(([kind]) => kind === 'down').length, 1);
});

test('operator control: forbidden and stale controls fail closed before native input', async () => {
  const p = page({ label: 'Send' }); const control = new NativeOperatorControl({ page: p });
  const observed = await control.observe({ tabId: 'tab-1' });
  await assert.rejects(control.act({ tabId: 'tab-1', url: observed.url, revision: observed.revision, targetId: observed.controls[0].targetId, action: 'click' }), /operator_target_unavailable/);
  assert.equal(p.calls.length, 0);
});

test('operator control: URL drift rejects an observed target before native input', async () => {
  const p = page(); const control = new NativeOperatorControl({ page: p });
  const observed = await control.observe({ tabId: 'tab-1' });
  p.getUrl = async () => 'https://chatgpt.com/c/changed';
  await assert.rejects(control.act({ tabId: 'tab-1', url: observed.url, revision: observed.revision, targetId: observed.controls[0].targetId, action: 'click' }), /operator_url_changed/);
  assert.equal(p.calls.length, 0);
});

test('operator control: Enter on a focused editable target cannot bypass the strict send actuator', async () => {
  const p = page({ label: 'Message', kind: 'editable', focused: true });
  const control = new NativeOperatorControl({ page: p });
  const observed = await control.observe({ tabId: 'tab-1' });
  await assert.rejects(
    control.act({ tabId: 'tab-1', url: observed.url, revision: observed.revision, targetId: observed.controls[0].targetId, action: 'key', key: 'Enter' }),
    /operator_send_capable_key_forbidden/
  );
  assert.equal(p.calls.length, 0);
});

test('operator control: an unbound provider-root composer cannot be mutated outside strict first binding', async () => {
  const p = page({ label: 'Message', kind: 'editable', focused: true });
  const control = new NativeOperatorControl({ page: p });
  const observed = await control.observe({ tabId: 'tab-1' });
  await assert.rejects(
    control.act({ tabId: 'tab-1', url: observed.url, revision: observed.revision, targetId: observed.controls[0].targetId, action: 'key', key: 'Backspace' }),
    /operator_unbound_root_composer_mutation_forbidden/
  );
  assert.equal(p.calls.length, 0);
});

test('operator control: wait distinguishes delayed visible success from evidence-bearing timeout', async () => {
  let calls = 0;
  const delayed = {
    async getUrl() { return 'https://chatgpt.com/'; },
    async evaluate() {
      calls += 1;
      const ready = calls > 1;
      return { url: 'https://chatgpt.com/', readyState: ready ? 'complete' : 'loading', controls: ready ? [{ role: 'button', label: 'Pro', kind: 'interactive', testId: 'mode', selected: true, expanded: false, focused: false, bounds: { x: 1, y: 1, w: 20, h: 20 }, hitTested: true, forbidden: false }] : [], composer: { present: false }, generation: { activeForbiddenControlLabels: [] } };
    }
  };
  const control = new NativeOperatorControl({ page: delayed });
  const success = await control.wait({ tabId: 'tab-1', role: 'button', label: 'Pro', selected: true, timeoutMs: 1_000 });
  assert.equal(success.status, 'SATISFIED');
  assert.ok(success.attempts >= 2);
  const absent = new NativeOperatorControl({ page: page({ label: 'High' }) });
  await assert.rejects(absent.wait({ tabId: 'tab-1', role: 'button', label: 'Pro', selected: true, timeoutMs: 250 }), (error) => error.message === 'LOAD_OR_POSTCONDITION_UNRESOLVED' && error.data.timeline.length >= 1);
});

test('operator control: delayed nested visible High maps to one actionable picker ancestor', () => {
  const early = resolveVisibleReasoningTargets([]);
  assert.equal(early.diagnostics.High.accepted, false);
  const settled = resolveVisibleReasoningTargets([reasoningCandidate()]);
  assert.deepEqual(settled.targets, [{ text: 'High', ancestorKey: 'high-trigger', role: 'button', label: 'High', bounds: { x: 10, y: 10, w: 40, h: 20 }, hitTested: true, menuScoped: false, source: 'rendered_text' }]);
});

test('operator control: ordinary noninteractive High is rejected', () => {
  const result = resolveVisibleReasoningTargets([reasoningCandidate({ role: '', actionable: false, popupRelation: false, ancestorKey: '' })]);
  assert.equal(result.diagnostics.High.accepted, false);
  assert.equal(result.targets.length, 0);
});

test('operator control: hidden, occluded, offscreen, and hit-test-failing High candidates are rejected', () => {
  for (const override of [{ visible: false }, { inViewport: false }, { hitTested: false }, { actionable: false }]) {
    const result = resolveVisibleReasoningTargets([reasoningCandidate(override)]);
    assert.equal(result.diagnostics.High.accepted, false);
  }
});

test('operator control: duplicate visible High ancestors fail closed', () => {
  const result = resolveVisibleReasoningTargets([reasoningCandidate(), reasoningCandidate({ ancestorKey: 'other-high', bounds: { x: 60, y: 10, w: 40, h: 20 } })]);
  assert.equal(result.diagnostics.High.reason, 'ambiguous_actionable_ancestors');
  assert.equal(result.targets.length, 0);
});

test('operator control: generic profile Pro popup is rejected and only an exact Pro menu option is accepted', () => {
  const unrelated = resolveVisibleReasoningTargets([reasoningCandidate({ text: 'Pro', label: 'Pro', popupRelation: false, menuScoped: false })]);
  assert.equal(unrelated.diagnostics.Pro.accepted, false);
  assert.deepEqual(unrelated.diagnostics.Pro.candidates, [{
    source: 'rendered_text', ancestorKey: 'high-trigger', role: 'button', bounds: { x: 10, y: 10, w: 40, h: 20 },
    visible: true, inViewport: true, hitTested: true, actionable: true, ambiguous: false, forbidden: false,
    popupRelation: false, menuScoped: false, exclusionReasons: ['pro_not_menu_scoped']
  }]);
  const accountPopup = resolveVisibleReasoningTargets([reasoningCandidate({
    text: 'Pro', label: 'Open profile menu', popupRelation: true, menuScoped: false,
    ancestorKey: 'account-profile-trigger'
  })]);
  assert.equal(accountPopup.diagnostics.Pro.accepted, false);
  assert.equal(accountPopup.targets.length, 0);
  assert.deepEqual(accountPopup.diagnostics.Pro.candidates[0].exclusionReasons, ['pro_not_menu_scoped']);
  const afterMenu = resolveVisibleReasoningTargets([reasoningCandidate({ text: 'Pro', label: 'Pro', ancestorKey: 'pro-option', popupRelation: false, menuScoped: true, source: 'accessible_label' })]);
  assert.equal(afterMenu.diagnostics.Pro.accepted, true);
  assert.deepEqual(afterMenu.diagnostics.Pro.candidates[0].exclusionReasons, []);
  assert.equal(afterMenu.targets[0].ancestorKey, 'pro-option');
});

test('operator control: Send-family labels remain ineligible reasoning targets', () => {
  for (const label of ['Send', 'Stop', 'Retry', 'Continue']) {
    const result = resolveVisibleReasoningTargets([reasoningCandidate({ text: 'High', label, forbidden: true, actionable: false })]);
    assert.equal(result.diagnostics.High.accepted, false);
  }
});
