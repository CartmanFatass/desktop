// One-shot native CDP observation sidecar for a disposable Gemini root tab.
// It has no prompt, composer, ledger, navigation, or Send capability. It only
// opens the unique visible Gemini mode picker and confirms its selected,
// visible, menu-scoped composite model/mode evidence.
import { ChromeCdpConnection } from '../chrome-cdp-backend.mjs';

const expectedModel = 'Gemini 3.1 Pro extended';
const timeoutMs = Math.max(1_000, Number(process.argv[2] || 20_000));
const cdpPort = Math.max(1, Number(process.argv[3] || 9222));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targetForRootTab() {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`sidecar_cdp_list_${response.status}`);
  const pages = (await response.json()).filter((item) => {
    try {
      const url = new URL(item?.url || '');
      // Gemini's provider-root composer is currently `/app`; a concrete
      // conversation is `/app/<id>` and is deliberately excluded.
      return item?.type === 'page' && url.hostname === 'gemini.google.com' && url.pathname === '/app';
    } catch { return false; }
  });
  if (pages.length !== 1) {
    const error = new Error('sidecar_gemini_root_target_ambiguous');
    error.data = { rootTargetCount: pages.length };
    throw error;
  }
  return pages[0];
}

async function main() {
  const target = await targetForRootTab();
  const connection = new ChromeCdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  let sessionId = null;
  try {
    sessionId = (await connection.send('Target.attachToTarget', { targetId: target.id, flatten: true })).sessionId;
    const evaluate = async (expression) => {
      const reply = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      return reply?.result?.value;
    };
    const deadline = Date.now() + timeoutMs;
    const readPicker = async () => await evaluate(`(() => {
      const visible = (node) => { const r = node?.getBoundingClientRect?.(); const s = node ? getComputedStyle(node) : null; return !!r && r.width > 0 && r.height > 0 && s?.visibility !== 'hidden' && s?.display !== 'none'; };
      const roots = Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"]'))
        .filter((node) => visible(node) && !node.closest('[role="menu"]'));
      const candidates = roots.flatMap((root) => root.matches('button, [role="button"]')
        ? [root]
        : Array.from(root.querySelectorAll('button, [role="button"]')).filter(visible));
      if (candidates.length !== 1) return { ok: false, error: 'gemini_mode_selector_unavailable', visibleSelectorCount: candidates.length };
      const target = candidates[0];
      const rect = target.getBoundingClientRect();
      const controlledIds = String(target.getAttribute('aria-controls') || target.closest('[aria-controls]')?.getAttribute('aria-controls') || '').split(/\\s+/).filter(Boolean);
      const alreadyOpen = Array.from(document.querySelectorAll('[data-test-id="gem-mode-menu"], [role="menu"], [role="listbox"]')).some((node) => visible(node) && (node.getAttribute('data-test-id') === 'gem-mode-menu' || controlledIds.includes(String(node.id || ''))));
      if (!alreadyOpen) {
        try { target.click(); } catch { return { ok: false, error: 'gemini_mode_selector_activation_failed' }; }
      }
      return { ok: true, alreadyOpen, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, controlledIds };
    })()`);
    let picker = null;
    while (Date.now() < deadline) {
      picker = await readPicker();
      if (picker?.ok) break;
      await sleep(200);
    }
    if (!picker?.ok) { const error = new Error(picker?.error || 'gemini_mode_selector_unavailable'); error.data = picker || null; throw error; }
    let evidence = null;
    let needsRereadAfterSelection = false;
    let reopenedForReread = false;
    while (Date.now() < deadline) {
      evidence = await evaluate(`(() => {
        const controlledIds = new Set(${JSON.stringify(picker.controlledIds || [])});
        const visible = (node) => { const r = node?.getBoundingClientRect?.(); const s = node ? getComputedStyle(node) : null; return !!r && r.width > 0 && r.height > 0 && s?.visibility !== 'hidden' && s?.display !== 'none'; };
        const selected = (node) => /(^|\\s)selected(\\s|$)/i.test(String(node?.className || '')) || node?.getAttribute('aria-checked') === 'true' || node?.getAttribute('aria-selected') === 'true' || Array.from(node?.querySelectorAll?.('[aria-label]') || []).some((child) => /selected|已选中/i.test(String(child.getAttribute('aria-label') || '')));
        const label = (node) => { const values = [...new Set(Array.from(node.querySelectorAll('.label')).filter(visible).map((child) => String(child.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean))]; return values.length === 1 ? values[0] : String(node.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim() || null; };
        const roots = Array.from(document.querySelectorAll('[data-test-id="gem-mode-menu"], [role="menu"], [role="listbox"]')).filter(visible).filter((root) => root.getAttribute('data-test-id') === 'gem-mode-menu' || controlledIds.has(String(root.id || '')));
        const items = roots.flatMap((root) => Array.from(root.querySelectorAll('[data-test-id^="bard-mode-option-"], gem-menu-item, [role="menuitem"], [role="menuitemradio"]')).filter(visible).map((node) => ({ node, label: label(node), selected: selected(node), role: String(node.getAttribute('role') || ''), ariaSelected: String(node.getAttribute('aria-selected') || ''), ariaChecked: String(node.getAttribute('aria-checked') || '') })));
        const isModel = (record) => /^(?:3\\.1 )?pro$/i.test(record.label || '');
        const isThinking = (record) => /^(?:extended thinking|扩展思考|확장)$/i.test(record.label || '');
        let selectedRecords = items.filter((record) => record.selected && record.label);
        let model = selectedRecords.filter(isModel);
        let thinking = selectedRecords.filter(isThinking);
        // Reversible normalization is allowed only for the one visible exact
        // thinking option after the selected model itself was uniquely proven.
        // This is the same direct visible-menu interaction as the controller;
        // it cannot type, submit, or touch the composer.
        let thinkingSelectionMethod = 'already_selected_visible_thinking_option';
        const thinkingOptions = items.filter(isThinking);
        if (model.length === 1 && thinking.length === 0 && thinkingOptions.length === 1) {
          try { thinkingOptions[0].node.click(); } catch {}
          thinkingOptions[0].selected = selected(thinkingOptions[0].node);
          selectedRecords = items.filter((record) => record.selected && record.label);
          model = selectedRecords.filter(isModel);
          thinking = selectedRecords.filter(isThinking);
          thinkingSelectionMethod = 'unique_visible_exact_thinking_option';
        }
        const records = items.map(({ node, ...record }) => record);
        // Bounded page-wide diagnostic: only visible interactive controls
        // that themselves advertise a model/mode/thinking semantic. It never
        // reads composer text, conversation text, account text, or hidden DOM.
        const safeName = (node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 96);
        const visibleControls = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"]'))
          .filter(visible).filter((node) => !node.closest('form'))
          .map((node) => ({ role: String(node.getAttribute('role') || ''), name: safeName(node), ariaLabel: String(node.getAttribute('aria-label') || '').slice(0, 96), ariaControls: String(node.getAttribute('aria-controls') || '').slice(0, 96), ariaHasPopup: String(node.getAttribute('aria-haspopup') || ''), dataTestId: String(node.getAttribute('data-test-id') || '').slice(0, 96) }))
          .filter((record) => /(?:model|mode|thinking|pro|扩展|확장)/i.test(record.name + ' ' + record.ariaLabel + ' ' + record.dataTestId)).slice(0, 24);
        return { menuRootCount: roots.length, visibleRecords: records, visibleControls, selectedModelCount: model.length, selectedThinkingCount: thinking.length, thinkingSelectionMethod, matched: model.length === 1 && thinking.length === 1 };
      })()`);
      if (evidence?.matched) break;
      if (evidence?.thinkingSelectionMethod === 'unique_visible_exact_thinking_option') needsRereadAfterSelection = true;
      // Gemini closes this menu after the visible thinking-option selection.
      // Reopen only the same unique control once, then require the second
      // visible selected-state read; this is still pre-send and does not
      // inspect or modify a composer.
      if (needsRereadAfterSelection && evidence?.menuRootCount === 0 && !reopenedForReread) {
        const reopened = await evaluate(`(() => {
          const visible = (node) => { const r = node?.getBoundingClientRect?.(); const s = node ? getComputedStyle(node) : null; return !!r && r.width > 0 && r.height > 0 && s?.visibility !== 'hidden' && s?.display !== 'none'; };
          const roots = Array.from(document.querySelectorAll('[data-test-id="bard-mode-menu-button"], button[aria-label*="mode selector" i], [role="button"][aria-label*="mode selector" i], button[aria-label*="模式选择器"], [role="button"][aria-label*="模式选择器"]')).filter((node) => visible(node) && !node.closest('[role="menu"]'));
          const candidates = roots.flatMap((root) => root.matches('button, [role="button"]') ? [root] : Array.from(root.querySelectorAll('button, [role="button"]')).filter(visible));
          if (candidates.length !== 1) return false;
          try { candidates[0].click(); return true; } catch { return false; }
        })()`);
        reopenedForReread = reopened === true;
        await sleep(200);
      }
      await sleep(200);
    }
    if (!evidence?.matched) { const error = new Error('expected_model_switch_unconfirmed'); error.data = { expectedModel, visibleMenuEvidence: evidence || null }; throw error; }
    process.stdout.write(`${JSON.stringify({ ok: true, provider: 'gemini', conversationUrl: target.url, expectedModel, modelEvidence: expectedModel, selectedModel: '3.1 Pro', thinkingMode: 'Extended thinking', thinkingSelectionMethod: evidence.thinkingSelectionMethod, visibleMenuEvidence: evidence.visibleRecords, promptInsertCount: 0, sendActionCount: 0, operationCreated: false })}\n`);
  } finally {
    if (sessionId) await connection.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    await connection.close().catch(() => {});
  }
}

main().catch((error) => { process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || 'sidecar_error'), data: error?.data || null, promptInsertCount: 0, sendActionCount: 0, operationCreated: false })}\n`); process.exitCode = 1; });
