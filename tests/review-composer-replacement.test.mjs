import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectReviewComposerEmptyElement,
  prepareReviewComposerClearSelection,
  positionReviewComposerCaret
} from '../review-composer-replacement.mjs';

function eventWindow() {
  return {
    Event: class {
      constructor(type) { this.type = type; }
    },
    InputEvent: class {
      constructor(type) { this.type = type; }
    }
  };
}

function textareaFixture(value = 'persisted draft') {
  let nativeValue = value;
  const windowRef = eventWindow();
  const documentRef = { defaultView: windowRef, activeElement: null };
  const element = {
    tagName: 'TEXTAREA', ownerDocument: documentRef, disabled: false, readOnly: false,
    get value() { return nativeValue; },
    set value(next) { nativeValue = String(next); },
    getAttribute() { return null; },
    matches(selector) { return selector === 'textarea'; },
    focus() { documentRef.activeElement = element; },
    setSelectionRange(start, end) { element.selectionStart = start; element.selectionEnd = end; },
    selectionStart: null, selectionEnd: null
  };
  return { element, setValue: (next) => { nativeValue = next; } };
}

function contenteditableFixture(text = 'persisted draft') {
  const windowRef = eventWindow();
  let selectedRange = null;
  const selection = {
    rangeCount: 0,
    isCollapsed: true,
    anchorNode: null,
    focusNode: null,
    removeAllRanges() { selectedRange = null; selection.rangeCount = 0; },
    addRange(range) {
      selectedRange = range;
      selection.rangeCount = 1;
      selection.isCollapsed = false;
      selection.anchorNode = element;
      selection.focusNode = element;
    },
    getRangeAt() { return selectedRange; }
  };
  const documentRef = {
    defaultView: windowRef,
    activeElement: null,
    createRange() {
      return {
        startContainer: null, startOffset: null, endContainer: null, endOffset: null,
        selectNodeContents(node) {
          this.startContainer = node;
          this.startOffset = 0;
          this.endContainer = node;
          this.endOffset = node.childNodes.length;
        },
        collapse() {
          selection.isCollapsed = true;
          this.endContainer = this.startContainer;
          this.endOffset = this.startOffset;
        }
      };
    }
  };
  windowRef.getSelection = () => selection;
  const element = {
    tagName: 'DIV', ownerDocument: documentRef, isContentEditable: true,
    childNodes: text ? [{ nodeType: 3, nodeValue: text }] : [],
    get innerHTML() { return element.childNodes.map((node) => node.nodeValue || '').join(''); },
    getAttribute(name) { return name === 'contenteditable' ? 'true' : null; },
    matches() { return false; },
    focus() { documentRef.activeElement = element; },
    contains(node) { return node === element; },
    replaceChildren(...nodes) { element.childNodes = nodes; }
  };
  return { element, selection };
}

const serialize = (element) => ({
  ok: true,
  text: element.childNodes.map((node) => String(node.nodeValue || '')).join('')
});

test('review composer replacement: textarea verifies a full native selection before one Backspace', () => {
  const fixture = textareaFixture();
  const prepared = prepareReviewComposerClearSelection(fixture.element, { hasContent: true });
  assert.deepEqual(prepared, {
    ok: true,
    composerKind: 'textarea',
    clearMethod: 'verified_selection_backspace',
    selectionVerified: true,
    selectedLength: 'persisted draft'.length,
    deleteKeyRequired: true
  });
  fixture.setValue('');
  assert.equal(inspectReviewComposerEmptyElement(fixture.element, serialize).ok, true);
  assert.deepEqual(positionReviewComposerCaret(fixture.element), {
    ok: true, composerKind: 'textarea', caretMethod: 'native_selection_range'
  });
});

test('review composer replacement: contenteditable verifies a range covering the entire editable root', () => {
  const fixture = contenteditableFixture();
  const prepared = prepareReviewComposerClearSelection(fixture.element, { hasContent: true });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.clearMethod, 'verified_selection_backspace');
  assert.equal(prepared.selectionVerified, true);
  assert.equal(prepared.deleteKeyRequired, true);
  fixture.element.replaceChildren();
  assert.equal(inspectReviewComposerEmptyElement(fixture.element, serialize).ok, true);
});

test('review composer replacement: asynchronous draft rehydration is detected by the later empty snapshot', async () => {
  const fixture = contenteditableFixture();
  assert.equal(prepareReviewComposerClearSelection(fixture.element, { hasContent: true }).ok, true);
  fixture.element.replaceChildren();
  assert.equal(inspectReviewComposerEmptyElement(fixture.element, serialize).ok, true);
  await new Promise((resolve) => setTimeout(() => {
    fixture.element.childNodes = [{ nodeType: 3, nodeValue: 'rehydrated draft' }];
    resolve();
  }, 5));
  const second = inspectReviewComposerEmptyElement(fixture.element, serialize);
  assert.equal(second.ok, false);
  assert.equal(second.serializerError, 'review_composer_not_empty');
  assert.equal(second.serializedLength, 'rehydrated draft'.length);
});

test('review composer replacement: textarea persistence rehydration is detected after verified key clearing', () => {
  const fixture = textareaFixture();
  assert.equal(prepareReviewComposerClearSelection(fixture.element, { hasContent: true }).ok, true);
  fixture.setValue('');
  assert.equal(inspectReviewComposerEmptyElement(fixture.element, serialize).ok, true);
  fixture.setValue('rehydrated draft');
  assert.equal(inspectReviewComposerEmptyElement(fixture.element, serialize).ok, false);
});

test('review composer replacement: selection failure is fail-closed for contenteditable', () => {
  const fixture = contenteditableFixture('');
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: fixture.element,
    focusNode: fixture.element,
    removeAllRanges() {}, addRange() {}
  };
  fixture.element.ownerDocument.defaultView.getSelection = () => selection;
  assert.deepEqual(positionReviewComposerCaret(fixture.element), {
    ok: false,
    error: 'review_composer_selection_failed',
    composerKind: 'contenteditable'
  });
});
