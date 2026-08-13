export const REVIEW_COMPOSER_REPLACEMENT_MODEL = 'agentify_review_composer_replace_v2';

export function reviewComposerKind(element) {
  const tag = String(element?.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return 'textarea';
  if (tag === 'INPUT') return 'input';
  if (element?.isContentEditable || element?.getAttribute?.('contenteditable') === 'true') {
    return 'contenteditable';
  }
  return null;
}

export function locateReviewComposer(selector, documentRef = document, windowRef = window) {
  const visible = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = windowRef.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editable = (node) => {
    if (!visible(node)) return false;
    if (node.matches('textarea')) return !node.disabled && !node.readOnly;
    if (node.matches('input')) {
      return !node.disabled && !node.readOnly && String(node.type || 'text').toLowerCase() === 'text';
    }
    return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true';
  };
  const score = (node) => {
    const rect = node.getBoundingClientRect();
    const label = [
      node.getAttribute('aria-label') || '',
      node.getAttribute('placeholder') || '',
      node.getAttribute('name') || '',
      node.getAttribute('id') || '',
      node.getAttribute('data-testid') || ''
    ].join(' ').toLowerCase();
    let value = 0;
    if (/prompt|message|ask|chat|query|input/.test(label)) value += 80;
    if (node.matches('textarea')) value += 50;
    if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') value += 35;
    if (node.getAttribute('role') === 'textbox') value += 25;
    if (rect.width >= 260 && rect.height >= 26) value += 20;
    value += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
    value += Math.max(0, rect.y / 8);
    return value;
  };
  const matchesAny = (node, selectors) => String(selectors || '')
    .split(',')
    .some((part) => part.trim() && node.matches(part.trim()));
  const base = Array.from(documentRef.querySelectorAll(selector));
  const fallback = Array.from(documentRef.querySelectorAll(
    'main textarea, main input, main [role="textbox"], main [contenteditable="true"], textarea, input, [role="textbox"], [contenteditable="true"]'
  ));
  const candidates = [];
  const seen = new Set();
  for (const node of [...base, ...fallback]) {
    if (!node || seen.has(node)) continue;
    seen.add(node);
    candidates.push(node);
  }
  let element = null;
  let best = -Infinity;
  for (const candidate of candidates) {
    if (!editable(candidate)) continue;
    const candidateScore = score(candidate);
    if (candidateScore > best) {
      best = candidateScore;
      element = candidate;
    }
  }
  const selectedByPrimary = !!element && matchesAny(element, selector);
  return { element: selectedByPrimary ? element : null, candidateCount: candidates.length, selectedByPrimary };
}

export function prepareReviewComposerClearSelection(element, { hasContent = true } = {}) {
  const composerKind = reviewComposerKind(element);
  if (!composerKind) {
    return { ok: false, error: 'review_composer_kind_unsupported', composerKind: null };
  }
  try {
    const documentRef = element.ownerDocument;
    const windowRef = documentRef?.defaultView;
    element.focus();
    if (documentRef?.activeElement !== element && !element.contains?.(documentRef?.activeElement)) {
      return { ok: false, error: 'review_composer_focus_failed', composerKind };
    }
    if (!hasContent) {
      return {
        ok: true,
        composerKind,
        clearMethod: 'already_empty',
        selectionVerified: true,
        deleteKeyRequired: false
      };
    }
    if (composerKind === 'textarea' || composerKind === 'input') {
      if (typeof element.setSelectionRange !== 'function') {
        return { ok: false, error: 'review_composer_selection_unsupported', composerKind };
      }
      const length = String(element.value ?? '').length;
      element.setSelectionRange(0, length);
      if (element.selectionStart !== 0 || element.selectionEnd !== length) {
        return { ok: false, error: 'review_composer_selection_failed', composerKind };
      }
      return {
        ok: true,
        composerKind,
        clearMethod: 'verified_selection_backspace',
        selectionVerified: true,
        selectedLength: length,
        deleteKeyRequired: true
      };
    }
    const selection = windowRef?.getSelection?.();
    const range = documentRef?.createRange?.();
    if (!selection || !range) {
      return { ok: false, error: 'review_composer_selection_unsupported', composerKind };
    }
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.rangeCount === 1 ? selection.getRangeAt?.(0) : null;
    const coversRoot = !!selected &&
      selected.startContainer === element && selected.startOffset === 0 &&
      selected.endContainer === element && selected.endOffset === element.childNodes.length;
    const anchorInside = selection.anchorNode === element || element.contains?.(selection.anchorNode);
    const focusInside = selection.focusNode === element || element.contains?.(selection.focusNode);
    if (!coversRoot || selection.isCollapsed === true || !anchorInside || !focusInside) {
      return { ok: false, error: 'review_composer_selection_failed', composerKind };
    }
    return {
      ok: true,
      composerKind,
      clearMethod: 'verified_selection_backspace',
      selectionVerified: true,
      selectedChildCount: element.childNodes.length,
      deleteKeyRequired: true
    };
  } catch {
    return { ok: false, error: 'review_composer_selection_action_failed', composerKind };
  }
}

export function positionReviewComposerCaret(element) {
  const composerKind = reviewComposerKind(element);
  if (!composerKind) {
    return { ok: false, error: 'review_composer_kind_unsupported', composerKind: null };
  }
  try {
    const documentRef = element.ownerDocument;
    const windowRef = documentRef?.defaultView;
    element.focus();
    if (documentRef?.activeElement !== element && !element.contains?.(documentRef?.activeElement)) {
      return { ok: false, error: 'review_composer_focus_failed', composerKind };
    }
    if (composerKind === 'textarea' || composerKind === 'input') {
      if (typeof element.setSelectionRange !== 'function') {
        return { ok: false, error: 'review_composer_selection_unsupported', composerKind };
      }
      element.setSelectionRange(0, 0);
      if (element.selectionStart !== 0 || element.selectionEnd !== 0) {
        return { ok: false, error: 'review_composer_selection_failed', composerKind };
      }
      return { ok: true, composerKind, caretMethod: 'native_selection_range' };
    }
    const selection = windowRef?.getSelection?.();
    const range = documentRef?.createRange?.();
    if (!selection || !range) {
      return { ok: false, error: 'review_composer_selection_unsupported', composerKind };
    }
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const anchorInside = selection.anchorNode === element || element.contains?.(selection.anchorNode);
    const focusInside = selection.focusNode === element || element.contains?.(selection.focusNode);
    if (selection.rangeCount !== 1 || selection.isCollapsed !== true || !anchorInside || !focusInside) {
      return { ok: false, error: 'review_composer_selection_failed', composerKind };
    }
    return { ok: true, composerKind, caretMethod: 'contenteditable_collapsed_range' };
  } catch {
    return { ok: false, error: 'review_composer_caret_action_failed', composerKind };
  }
}

export function inspectReviewComposerEmptyElement(element, serializeContenteditable) {
  const composerKind = reviewComposerKind(element);
  if (!composerKind) {
    return { ok: false, error: 'review_composer_kind_unsupported', composerKind: null, serializedLength: 0 };
  }
  const serialized = composerKind === 'textarea' || composerKind === 'input'
    ? { ok: true, text: String(element.value ?? ''), method: 'value' }
    : { ...serializeContenteditable(element), method: 'contenteditable_structural' };
  return {
    ok: serialized.ok === true && serialized.text === '',
    composerKind,
    serializerOk: serialized.ok === true,
    serializerMethod: serialized.method,
    serializerError: serialized.error || (serialized.text === '' ? null : 'review_composer_not_empty'),
    serializerTag: serialized.tag || null,
    serializedLength: serialized.ok === true ? String(serialized.text ?? '').length : 0
  };
}
