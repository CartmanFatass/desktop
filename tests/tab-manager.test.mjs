import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TabManager } from '../tab-manager.mjs';

test('tab-manager: ensureTab rejects vendor mismatch using URL fallback when stored vendorId is missing', async () => {
  const sessions = new Map();
  const browserBackend = {
    async createSession({ tabId, url }) {
      const session = {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {
          sessions.delete(tabId);
        }
      };
      sessions.set(tabId, { url, session });
      return session;
    }
  };

  const manager = new TabManager({
    browserBackend,
    createController: async () => ({})
  });

  const tabId = await manager.createTab({ key: 'projA', url: 'https://chatgpt.com/' });
  assert.ok(tabId);

  await assert.rejects(
    async () =>
      await manager.ensureTab({
        key: 'projA',
        vendorId: 'claude',
        vendorName: 'Claude',
        url: 'https://claude.ai/'
      }),
    /key_vendor_mismatch/
  );
});

test('tab-manager: createTab closes session if controller creation fails', async () => {
  let closeCalls = 0;
  const browserBackend = {
    async createSession() {
      return {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {
          closeCalls += 1;
        }
      };
    }
  };

  const manager = new TabManager({
    browserBackend,
    createController: async () => {
      throw new Error('controller_init_failed');
    }
  });

  await assert.rejects(async () => await manager.createTab({ key: 'projB', url: 'https://chatgpt.com/' }), /controller_init_failed/);
  assert.equal(closeCalls, 1);
  assert.deepEqual(manager.listTabs(), []);
});

test('tab-manager: exact stable binding rejects another conversation URL for the same key', async () => {
  const browserBackend = {
    async createSession() {
      return { page: {}, presenter: {}, isClosed: () => false, close: async () => {} };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });
  await manager.createTab({ key: 'hmasd-formal-pro', vendorId: 'chatgpt', url: 'https://chatgpt.com/c/conversation-a' });
  await assert.rejects(
    manager.ensureTab({
      key: 'hmasd-formal-pro',
      vendorId: 'chatgpt',
      url: 'https://chatgpt.com/c/conversation-b',
      exactUrl: true
    }),
    /key_url_mismatch/
  );
});

test('tab-manager: repeated exact stable binding reuses one live tab session', async () => {
  let sessionCreates = 0;
  const browserBackend = {
    async createSession() {
      sessionCreates += 1;
      return { page: {}, presenter: {}, isClosed: () => false, close: async () => {} };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });
  const binding = {
    key: 'hmasd-formal-pro',
    name: 'hmasd-formal-pro',
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT',
    url: 'https://chatgpt.com/c/conversation-a',
    exactUrl: true
  };

  const first = await manager.ensureTab(binding);
  const second = await manager.ensureTab(binding);

  assert.equal(second, first);
  assert.equal(sessionCreates, 1);
  assert.equal(manager.listTabs().length, 1);
});

test('tab-manager: first binding updates the stable tab to the created conversation URL', async () => {
  const browserBackend = {
    async createSession() {
      return { page: {}, presenter: {}, isClosed: () => false, close: async () => {} };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });
  const tabId = await manager.createTab({ key: 'first-binding', vendorId: 'chatgpt', url: 'https://chatgpt.com/' });
  manager.updateTabUrl(tabId, 'https://chatgpt.com/c/new-conversation');
  assert.equal(manager.listTabs()[0].url, 'https://chatgpt.com/c/new-conversation');
  assert.equal(await manager.ensureTab({
    key: 'first-binding',
    vendorId: 'chatgpt',
    url: 'https://chatgpt.com/c/new-conversation',
    exactUrl: true
  }), tabId);
});

test('tab-manager: scoped live URL reconciliation updates only same-origin provider navigation', async () => {
  const browserBackend = {
    async createSession() {
      return { page: {}, presenter: {}, isClosed: () => false, close: async () => {} };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });
  const tabId = await manager.createTab({ key: 'gemini-live', vendorId: 'gemini', url: 'https://gemini.google.com/app' });
  assert.equal(manager.reconcileLiveTabUrl(tabId, 'https://gemini.google.com/app/conversation-live'), true);
  assert.equal(manager.listTabs()[0].url, 'https://gemini.google.com/app/conversation-live');
  assert.equal(manager.reconcileLiveTabUrl(tabId, 'https://chatgpt.com/c/wrong-provider'), false);
  assert.equal(manager.reconcileLiveTabUrl(tabId, 'not-a-url'), false);
  assert.equal(manager.listTabs()[0].url, 'https://gemini.google.com/app/conversation-live');
});

test('tab-manager: scoped status wires its successful live URL read into reconciliation', () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(url\) tabs\.reconcileLiveTabUrl\(resolvedTabId, url\)/);
});

test('tab-manager: adopts the exact default tab without creating or navigating', async () => {
  let sessionCreates = 0;
  const browserBackend = {
    async createSession() {
      sessionCreates += 1;
      return { page: {}, presenter: {}, isClosed: () => false, close: async () => {} };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });
  const tabId = await manager.createTab({
    key: 'default',
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT',
    url: 'https://chatgpt.com/c/conversation-a'
  });

  assert.equal(await manager.adoptTab({
    id: tabId,
    key: 'hmasd-uav-formal-pro',
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT',
    url: 'https://chatgpt.com/c/conversation-a'
  }), tabId);
  assert.equal(sessionCreates, 1);
  assert.equal(manager.listTabs()[0].key, 'hmasd-uav-formal-pro');
  assert.equal(await manager.ensureTab({
    key: 'hmasd-uav-formal-pro',
    vendorId: 'chatgpt',
    url: 'https://chatgpt.com/c/conversation-a',
    exactUrl: true
  }), tabId);
});
