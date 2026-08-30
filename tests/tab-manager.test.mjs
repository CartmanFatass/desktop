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

test('tab-manager: failed close retains the tab for observable cleanup recovery', async () => {
  const browserBackend = {
    async createSession() {
      return {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {
          throw new Error('chrome_cdp_disconnected');
        }
      };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });
  const tabId = await manager.createTab({ key: 'cleanup-observation', url: 'https://gemini.google.com/app' });

  await assert.rejects(async () => await manager.closeTab(tabId), /chrome_cdp_disconnected/);
  assert.equal(manager.listTabs().length, 1);
  assert.equal(manager.listTabs()[0].id, tabId);
});
test('tab-manager: stale browser target close releases the exact non-protected logical row', async () => {
  class ErrorEvent extends Error {}
  const browserBackend = {
    async createSession() {
      return {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => { throw new ErrorEvent('opaque browser target event'); }
      };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });
  const tabId = await manager.createTab({ key: 'stale-target', url: 'https://chatgpt.com/c/stale' });

  assert.deepEqual(await manager.closeTab(tabId), { status: 'ALREADY_RELEASED', tabId });
  assert.deepEqual(manager.listTabs(), []);
  assert.deepEqual(await manager.closeTab(tabId), { status: 'ALREADY_RELEASED', tabId });
});

test('tab-manager: protected tab close remains refused', async () => {
  const browserBackend = {
    async createSession() {
      return { page: {}, presenter: {}, isClosed: () => false, close: async () => {} };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });
  const tabId = await manager.createTab({ key: 'default', protectedTab: true, url: 'https://chatgpt.com/' });

  await assert.rejects(manager.closeTab(tabId), /default_tab_protected/);
  assert.equal(manager.listTabs().length, 1);
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

test('tab-manager: ensureTab replaces a stale closed tab instead of reusing its locator', async () => {
  let creates = 0;
  const sessions = [];
  const manager = new TabManager({
    browserBackend: {
      async createSession() {
        creates += 1;
        const session = {
          page: {},
          presenter: {},
          closed: false,
          isClosed() { return this.closed; },
          async close() { this.closed = true; }
        };
        sessions.push(session);
        return session;
      }
    },
    createController: async () => ({})
  });
  const first = await manager.ensureTab({
    key: 'recoverable-tab',
    vendorId: 'chatgpt',
    url: 'https://chatgpt.com/c/persistent-conversation'
  });
  sessions[0].closed = true;
  const replacement = await manager.ensureTab({
    key: 'recoverable-tab',
    vendorId: 'chatgpt',
    url: 'https://chatgpt.com/c/persistent-conversation'
  });
  assert.notEqual(replacement, first);
  assert.equal(creates, 2);
  assert.deepEqual(manager.listTabs().map((tab) => tab.id), [replacement]);
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

test('tab-manager: tab rows disclose Chrome-CDP provenance and reject Electron eligibility', async () => {
  const chromeManager = new TabManager({
    browserBackend: {
      getState: () => ({
        kind: 'chrome-cdp',
        browserProduct: 'Chrome/151.0.7922.138',
        debugPort: 9222,
        attachedToExisting: true,
        launchedByAgentify: false
      }),
      async createSession() {
        return { page: {}, presenter: {}, isClosed: () => false, close: async () => {} };
      }
    },
    createController: async () => ({})
  });
  await chromeManager.createTab({ key: 'chrome-origin', url: 'https://chatgpt.com/' });
  assert.deepEqual(chromeManager.listTabs()[0].browser, {
    kind: 'chrome-cdp',
    browserProduct: 'Chrome/151.0.7922.138',
    debugPort: 9222,
    attachedToExisting: true,
    launchedByAgentify: false,
    strictTransportEligible: true
  });

  const electronManager = new TabManager({
    browserBackend: {
      getState: () => ({ kind: 'electron', attachedToExisting: false, launchedByAgentify: true }),
      async createSession() {
        return { page: {}, presenter: {}, isClosed: () => false, close: async () => {} };
      }
    },
    createController: async () => ({})
  });
  await electronManager.createTab({ key: 'electron-origin', url: 'https://chatgpt.com/' });
  assert.equal(electronManager.listTabs()[0].browser.strictTransportEligible, false);
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

test('tab-manager: refreshControllers atomically rebinds live sessions and rolls back on prepare failure', async () => {
  let creates = 0;
  const sessions = [];
  const manager = new TabManager({
    browserBackend: {
      async createSession() {
        creates += 1;
        const session = { page: { session: creates }, presenter: {}, isClosed: () => false, close: async () => {} };
        sessions.push(session);
        return session;
      }
    },
    createController: async ({ page }) => ({ generation: 0, page })
  });
  const defaultId = await manager.createTab({ key: 'default', url: 'https://chatgpt.com/', protectedTab: true });
  const tabId = await manager.createTab({ key: 'disposable', url: 'https://chatgpt.com/' });
  const before = [manager.getControllerById(defaultId), manager.getControllerById(tabId)];
  const result = await manager.refreshControllers({
    createController: async ({ page }) => ({ generation: 1, page }),
    validateController: async ({ controller }) => assert.equal(controller.generation, 1)
  });
  assert.deepEqual(result.reboundTabIds.sort(), [defaultId, tabId].sort());
  assert.equal(creates, 2);
  assert.equal(manager.getControllerById(defaultId).generation, 1);
  assert.equal(manager.getControllerById(tabId).generation, 1);
  const refreshed = [manager.getControllerById(defaultId), manager.getControllerById(tabId)];
  await assert.rejects(
    manager.refreshControllers({
      createController: async ({ tabId: candidateTabId }) => {
        if (candidateTabId === tabId) throw new Error('candidate_load_failed');
        return { generation: 2 };
      }
    }),
    /candidate_load_failed/
  );
  assert.equal(manager.getControllerById(defaultId), refreshed[0]);
  assert.equal(manager.getControllerById(tabId), refreshed[1]);
  assert.notEqual(refreshed[0], before[0]);
});
