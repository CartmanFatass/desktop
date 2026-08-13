import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearReviewComposerElement,
  inspectReviewComposerEmptyElement,
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
  windowRef.HTMLTextAreaElement = function HTMLTextAreaElement() {};
  Object.defineProperty(windowRef.HTMLTextAreaElement.prototype, 'value', {
    set(next) { nativeValue = String(next); }, configurable: true
  });
  const events = [];
  const documentRef = { defaultView: windowRef, activeElement: null };
  const element = {
    tagName: 'TEXTAREA', ownerDocument: documentRef, disabled: false, readOnly: false,
    get value() { return nativeValue; },
    set value(_) { throw new Error('instance setter must not be used'); },
    getAttribute() { return null; },
    matches(selector) { return selector === 'textarea'; },
    focus() { documentRef.activeElement = element; },
    dispatchEvent(event) { events.push(event.type); return true; },
    setSelectionRange(start, end) { element.selectionStart = start; element.selectionEnd = end; },
    selectionStart: null, selectionEnd: null
  };
  return { element, events, setNativeValue: (next) => { nativeValue = next; } };
}

function contenteditableFixture(text = 'persisted draft') {
  const windowRef = eventWindow();
  const events = [];
  const documentRef = {
    defaultView: windowRef,
    activeElement: null,
    createRange() {
      return {
        selectNodeContents() {}, collapse() {}
      };
    }
  };
  const element = {
    tagName: 'DIV', ownerDocument: documentRef, isContentEditable: true,
    childNodes: text ? [{ nodeType: 3, nodeValue: text }] : [],
    get innerHTML() { return element.childNodes.map((node) => node.nodeValue || '').join(''); },
    getAttribute(name) { return name === 'contenteditable' ? 'true' : null; },
    matches() { return false; },
    focus() { documentRef.activeElement = element; },
    contains(node) { return node === element; },
    replaceChildren(...nodes) { element.childNodes = nodes; },
    dispatchEvent(event) { events.push(event.type); return true; }
  };
  return { element, events };
}

const serialize = (element) => ({
  ok: true,
  text: element.childNodes.map((node) => String(node.nodeValue || '')).join('')
});

test('review composer replacement: textarea uses native setter, input event, empty verification, then caret zero', () => {
  const fixture = textareaFixture();
  const cleared = clearReviewComposerElement(fixture.element);
  assert.deepEqual(cleared, {
    ok: true,
    composerKind: 'textarea',
    clearMethod: 'native_value_setter',
    clearRevision: '',
    inputEventDispatched: true
  });
  assert.deepEqual(fixture.events, ['input']);
  assert.equal(inspectReviewComposerEmptyElement(fixture.element, serialize).ok, true);
  assert.deepEqual(positionReviewComposerCaret(fixture.element), {
    ok: true, composerKind: 'textarea', caretMethod: 'native_selection_range'
  });
});

test('review composer replacement: contenteditable replaceChildren dispatches input and exposes an empty DOM', () => {
  const fixture = contenteditableFixture();
  const cleared = clearReviewComposerElement(fixture.element);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.clearMethod, 'replace_children');
  assert.equal(cleared.clearRevision, '');
  assert.deepEqual(fixture.events, ['input']);
  assert.equal(inspectReviewComposerEmptyElement(fixture.element, serialize).ok, true);
});

test('review composer replacement: asynchronous draft rehydration is detected by the later empty snapshot', async () => {
  const fixture = contenteditableFixture();
  assert.equal(clearReviewComposerElement(fixture.element).ok, true);
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

test('review composer replacement: textarea persistence rehydration is detected after native clearing', () => {
  const fixture = textareaFixture();
  assert.equal(clearReviewComposerElement(fixture.element).ok, true);
  assert.equal(inspectReviewComposerEmptyElement(fixture.element, serialize).ok, true);
  fixture.setNativeValue('rehydrated draft');
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
