// One-shot native CDP sidecar for an already-running Agentify Chrome instance.
// It has no composer, prompt, ledger, navigation, or Send capability. The
// only permitted input is a pointer click on one unique visible High/Pro or
// Model Selector control and, after that control opens, one unique exact Pro
// option. Cookie output is aggregate presence metadata only.
import { ChromeCdpConnection } from '../chrome-cdp-backend.mjs';

const expectedMode = 'Pro';
const timeoutMs = Math.max(1_000, Number(process.argv[2] || 20_000));
const cdpPort = Math.max(1, Number(process.argv[3] || 9222));
const snapshotOnly = process.argv[4] === '--snapshot-only';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (fn) => `(${fn.toString()})()`;

async function targetForRootTab() {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`sidecar_cdp_list_${response.status}`);
  const pages = (await response.json()).filter((item) => item?.type === 'page' && item?.url === 'https://chatgpt.com/');
  if (pages.length !== 1) {
    const error = new Error('sidecar_root_target_ambiguous');
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
    const attached = await connection.send('Target.attachToTarget', { targetId: target.id, flatten: true });
    sessionId = attached.sessionId;
    const evaluateSource = async (expression) => {
      const reply = await connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (reply?.exceptionDetails) {
        const error = new Error('sidecar_runtime_evaluation_failed');
        error.data = { text: String(reply.exceptionDetails?.text || ''), description: String(reply.exceptionDetails?.exception?.description || '').slice(0, 240) };
        throw error;
      }
      return reply?.result?.value;
    };
    const evaluate = async (fn) => await evaluateSource(js(fn));
    const click = async (rect) => {
      const x = Math.round(rect.x + rect.w / 2);
      const y = Math.round(rect.y + rect.h / 2);
      await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sessionId);
      await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
      await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    };
    const cookies = await connection.send('Network.getCookies', { urls: ['https://chatgpt.com/'] }, sessionId);
    const scopedCookies = (cookies?.cookies || []).filter((cookie) => {
      const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
      return domain === 'chatgpt.com' || 'chatgpt.com'.endsWith(`.${domain}`);
    });
    const cookiePresence = {
      supported: true, host: 'chatgpt.com', matchingCookieCount: scopedCookies.length,
      secureCookieCount: scopedCookies.filter((cookie) => cookie?.secure === true).length,
      httpOnlyCookieCount: scopedCookies.filter((cookie) => cookie?.httpOnly === true).length,
      sessionCookieCount: scopedCookies.filter((cookie) => Number(cookie?.expires) < 0).length,
      persistentCookieCount: scopedCookies.filter((cookie) => Number(cookie?.expires) >= 0).length,
      nonEmpty: scopedCookies.length > 0
    };
    const readClosed = async () => await evaluate(() => {
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.(); const style = node ? getComputedStyle(node) : null;
        return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
      };
      const label = (node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim();
      const controls = Array.from(document.querySelectorAll('button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]')).filter((node) => visible(node) && !node.closest('[role="menu"], [role="listbox"]'));
      const modes = controls.map((node) => ({ node, label: label(node) })).filter(({ label }) => /^(?:low|medium|high|pro)$/i.test(label));
      const headers = controls.map((node) => ({ node, label: label(node) })).filter(({ node, label }) => node.getAttribute('data-testid') === 'model-switcher-dropdown-button' || /^model selector$/i.test(label));
      const receipt = ({ node, label }, route) => { const rect = node.getBoundingClientRect(); return { label, route, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } }; };
      return { url: location.href, directModes: modes.map(({ label }) => label), headerSelectorCount: headers.length, selectedPro: modes.filter(({ label }) => /^pro$/i.test(label)).length === 1, directPicker: modes.length === 1 ? receipt(modes[0], 'visible_direct_reasoning_mode') : null, headerPicker: modes.length === 0 && headers.length === 1 ? receipt(headers[0], 'visible_semantic_model_selector') : null };
    });
    const readOpenedMenu = async (pickerRect) => await evaluateSource(`(() => {
      const pickerRect = ${JSON.stringify(pickerRect)};
      const visible = (node) => { const rect = node?.getBoundingClientRect?.(); const style = node ? getComputedStyle(node) : null; return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none'; };
      const lines = (node) => String(node.getAttribute('aria-label') || node.innerText || node.textContent || '').split(/\\n+/).map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3).map((value) => value.slice(0, 96));
      const semanticLabel = (node) => lines(node)[0] || '';
      const nearPicker = (node) => { const rect = node.getBoundingClientRect(); return rect.bottom >= pickerRect.y - 120 && rect.top <= pickerRect.y + pickerRect.h + 900 && rect.right >= pickerRect.x - 700 && rect.left <= pickerRect.x + pickerRect.w + 700; };
      const interactive = (root) => Array.from(root.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], button, [role="button"]')).filter((node) => visible(node) && node !== root);
      const rootCandidates = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], [data-headlessui-state~="open"]'))
        // ChatGPT can portal the visible picker menu inside the composer form.
        // The role/visibility/proximity/interactive constraints below are the
        // safety boundary; excluding every form root hides that legitimate
        // menu and leaves no actionable candidate.
        .filter(visible).filter(nearPicker).filter((root) => interactive(root).length > 0);
      const roots = rootCandidates.filter((root, index) => !rootCandidates.some((other, otherIndex) => otherIndex !== index && other.contains(root)));
      const ancestry = (node, root) => { const out = []; let current = node.parentElement; while (current && current !== root && out.length < 3) { out.push({ tag: String(current.tagName || ''), role: String(current.getAttribute('role') || ''), dataTestId: String(current.getAttribute('data-testid') || '').slice(0, 96) }); current = current.parentElement; } return out; };
      const hitTested = (node) => { const rect = node.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return !!hit && (hit === node || node.contains(hit)); };
      const item = (node, rootIndex, root) => ({ node, rootIndex, role: String(node.getAttribute('role') || ''), name: semanticLabel(node), ariaLabel: String(node.getAttribute('aria-label') || '').slice(0, 96), ariaSelected: String(node.getAttribute('aria-selected') || ''), ariaChecked: String(node.getAttribute('aria-checked') || ''), ariaControls: String(node.getAttribute('aria-controls') || '').slice(0, 96), ariaHasPopup: String(node.getAttribute('aria-haspopup') || ''), semanticChildText: lines(node), ancestry: ancestry(node, root), hitTested: hitTested(node) });
      let descendants = roots.flatMap((root, rootIndex) => interactive(root).filter(hitTested).map((node) => item(node, rootIndex, root)));
      // Some current ChatGPT disclosures expose no role-bearing popup root.
      // Admit only exact visible, nearby, hit-tested reasoning bridge/options;
      // this is a narrow accessible-control fallback, not a page-text scan.
      let fallbackVisibleInteractiveCount = 0;
      if (descendants.length === 0) {
        descendants = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]')).filter(visible).filter(hitTested).filter((node) => /^(?:show advanced options?|effort|pro)$/i.test(semanticLabel(node))).map((node) => item(node, -1, document.body));
        fallbackVisibleInteractiveCount = descendants.length;
      }
      const pro = descendants.filter((item) => /^pro$/i.test(item.name));
      const nested = descendants.filter((item) => /^(?:low|medium|high|pro)$/i.test(item.name) && /^(?:menu|listbox)$/i.test(item.ariaHasPopup));
      // ChatGPT's first disclosure is a command, not a popup-bearing item; it
      // remains eligible only under its unique exact visible semantic label.
      const showAdvanced = descendants.filter((item) => /^show advanced options?$/i.test(item.name));
      const effortHigh = descendants.filter((item) => /^effort$/i.test(item.name) && item.semanticChildText.some((value) => /^high$/i.test(value)) && /^(?:menu|listbox)$/i.test(item.ariaHasPopup));
      const targetRect = (item) => { const rect = item?.node?.getBoundingClientRect?.(); return item && rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null; };
      // A first-root onboarding dialog can visually intercept the picker. It
      // may be dismissed only when the dialog itself has exactly the semantic
      // pair Get started + Close; no generic dialog/button action is allowed.
      const onboardingClose = descendants.filter((item) => item.role === '' && /^close$/i.test(item.ariaLabel) && roots[item.rootIndex]?.getAttribute('role') === 'dialog' && descendants.some((other) => other.rootIndex === item.rootIndex && /^get started$/i.test(other.name)));
      return { menuRootCount: roots.length, fallbackVisibleInteractiveCount, hasVisibleMenu: roots.length > 0 || fallbackVisibleInteractiveCount > 0, menuRoots: roots.map((root) => ({ role: String(root.getAttribute('role') || ''), ariaLabel: String(root.getAttribute('aria-label') || '').slice(0, 96), ariaControls: String(root.getAttribute('aria-controls') || '').slice(0, 96) })), descendants: descendants.map(({ node, ...item }) => item), exactProCount: pro.length, proTarget: pro.length === 1 ? targetRect(pro[0]) : null, nestedModeCount: nested.length, nestedTarget: nested.length === 1 ? targetRect(nested[0]) : null, showAdvancedCount: showAdvanced.length, showAdvancedTarget: showAdvanced.length === 1 ? targetRect(showAdvanced[0]) : null, effortHighCount: effortHigh.length, effortHighTarget: effortHigh.length === 1 ? targetRect(effortHigh[0]) : null, onboardingCloseCount: onboardingClose.length, onboardingCloseTarget: onboardingClose.length === 1 ? targetRect(onboardingClose[0]) : null };
    })()`);
    if (snapshotOnly) {
      const state = await readClosed();
      process.stdout.write(`${JSON.stringify({ ok: true, provider: 'chatgpt', conversationUrl: state.url, urlBinding: state.url === 'https://chatgpt.com/' ? 'provider_root' : 'unexpected', cookiePresence, visibleReasoningControls: { directModes: state.directModes, headerSelectorCount: state.headerSelectorCount }, promptInsertCount: 0, sendActionCount: 0 })}\n`);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    let state = null; let picker = null;
    while (Date.now() < deadline) {
      state = await readClosed();
      if (state.selectedPro) {
        process.stdout.write(`${JSON.stringify({ ok: true, provider: 'chatgpt', conversationUrl: state.url, urlBinding: state.url === 'https://chatgpt.com/' ? 'provider_root' : 'unexpected', cookiePresence, reasoningModeReceipt: { selectedMode: 'Pro', expectedMode, selectionMethod: 'already_selected_visible_reasoning_mode', promptInsertCount: 0, sendActionCount: 0 }, promptInsertCount: 0, sendActionCount: 0 })}\n`); return;
      }
      picker = state.directPicker || state.headerPicker; if (picker) break; await sleep(200);
    }
    if (!picker) throw new Error('sidecar_reasoning_mode_selector_unavailable');
    // A fresh React hydration can absorb one otherwise valid visible picker
    // click. Re-read the same direct, visible picker and retry it at most twice
    // with short bounded waits; never retain a stale rect or target a different
    // control.
    const openPickerMenu = async (initialPicker) => {
      let currentPicker = initialPicker;
      let latest = null;
      for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
        if (attempt > 0) {
          const current = await readClosed();
          currentPicker = current.directPicker || current.headerPicker || null;
          if (!currentPicker || current.selectedPro) break;
        }
        await click(currentPicker.rect);
        const menuDeadline = Math.min(deadline, Date.now() + 5_000);
        while (Date.now() < menuDeadline) {
          latest = await readOpenedMenu(currentPicker.rect);
          if (latest?.hasVisibleMenu) return { picker: currentPicker, options: latest };
          await sleep(200);
        }
      }
      return { picker: currentPicker, options: latest };
    };
    // The native diagnostic may already have opened this same visible picker.
    // Reuse only a currently observed menu adjacent to it; do not click the
    // trigger again and accidentally close a valid disclosure.
    const alreadyOpen = await readOpenedMenu(picker.rect);
    let opened = alreadyOpen?.hasVisibleMenu
      ? { picker, options: alreadyOpen }
      : await openPickerMenu(picker);
    picker = opened.picker;
    let options = opened.options;
    if (options?.onboardingCloseCount === 1 && options?.onboardingCloseTarget) {
      await click(options.onboardingCloseTarget);
      opened = await openPickerMenu(picker);
      picker = opened.picker;
      options = opened.options;
      if (!picker) throw new Error('sidecar_reasoning_mode_selector_unavailable_after_onboarding');
    }
    // A selector can first render a structured model/menu wrapper and then a
    // visible High/Pro reasoning submenu. Open that submenu only when its
    // semantic label and popup relationship are both uniquely visible.
    // The currently observed menu is progressive: root -> Show advanced
    // options -> EffortHigh -> exact Pro. Every bridge remains a unique
    // visible menu item with an explicit popup relation; no profile/plan text
    // or coordinate guess can take this route.
    for (let reveals = 0; options?.exactProCount !== 1 && reveals < 3 && Date.now() < deadline; reveals += 1) {
      const bridge = options?.showAdvancedCount === 1 && options?.showAdvancedTarget
        ? options.showAdvancedTarget
        : options?.effortHighCount === 1 && options?.effortHighTarget
          ? options.effortHighTarget
          : options?.nestedModeCount === 1 && options?.nestedTarget
            ? options.nestedTarget
            : null;
      if (!bridge) break;
      await click(bridge);
      let next = null;
      while (Date.now() < deadline) {
        next = await readOpenedMenu(picker.rect);
        if (next?.exactProCount === 1 || next?.hasVisibleMenu) break;
        await sleep(200);
      }
      options = next || options;
    }
    if (options?.exactProCount !== 1 || !options?.proTarget) { const error = new Error('sidecar_reasoning_mode_menu_unavailable'); error.data = { cookiePresence, pickerRoute: picker.route, visibleMenuEvidence: options || null }; throw error; }
    await click(options.proTarget);
    while (Date.now() < deadline) {
      state = await readClosed();
      if (state.selectedPro) {
        process.stdout.write(`${JSON.stringify({ ok: true, provider: 'chatgpt', conversationUrl: state.url, urlBinding: state.url === 'https://chatgpt.com/' ? 'provider_root' : 'unexpected', cookiePresence, reasoningModeReceipt: { selectedMode: 'Pro', expectedMode, selectionMethod: `${picker.route}_unique_exact_pro`, promptInsertCount: 0, sendActionCount: 0 }, promptInsertCount: 0, sendActionCount: 0 })}\n`); return;
      }
      await sleep(200);
    }
    throw new Error('sidecar_expected_reasoning_mode_switch_unconfirmed');
  } finally {
    if (sessionId) await connection.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    await connection.close().catch(() => {});
  }
}
main().catch((error) => { process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || 'sidecar_error'), data: error?.data || null, promptInsertCount: 0, sendActionCount: 0 })}\n`); process.exitCode = 1; });
