import crypto from 'node:crypto';

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

function normalizeVendorToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function tabMatchesVendor(tab, { vendorId = null, url = null } = {}) {
  if (!vendorId && !url) return true;
  const requestedId = normalizeVendorToken(vendorId);
  const currentId = normalizeVendorToken(tab?.vendorId || '');
  if (requestedId && currentId) return requestedId === currentId;
  const currentUrl = String(tab?.url || '').trim();
  const requestedUrl = String(url || '').trim();
  if (currentUrl && requestedUrl) return currentUrl.startsWith(requestedUrl) || requestedUrl.startsWith(currentUrl);
  return false;
}
function missingBrowserTargetCloseError(error) {
  const message = String(error?.message || error || '');
  return /No target with given id found|target (?:is )?(?:closed|missing|not found)|session closed/i.test(message) ||
    error?.constructor?.name === 'ErrorEvent';
}

function browserProvenance(browserBackend) {
  const raw = browserBackend?.getState?.();
  if (!raw || typeof raw !== 'object' || typeof raw.then === 'function') {
    return { kind: 'unobserved', attachedToExisting: false, launchedByAgentify: null };
  }
  const kind = String(raw.kind || '').trim() || 'unobserved';
  return {
    kind,
    browserProduct: typeof raw.browserProduct === 'string' ? raw.browserProduct : null,
    debugPort: Number.isInteger(raw.debugPort) ? raw.debugPort : null,
    attachedToExisting: raw.attachedToExisting === true,
    launchedByAgentify: raw.launchedByAgentify === true,
    strictTransportEligible:
      kind === 'chrome-cdp' && typeof raw.browserProduct === 'string' && /^Chrome\/\d+(?:\.\d+){1,3}$/.test(raw.browserProduct)
  };
}

export class TabManager {
  constructor({ browserBackend, createController, maxTabs = 12, onNeedsAttention, onChanged }) {
    this.browserBackend = browserBackend;
    this.createController = createController;
    this.maxTabs = Math.max(1, Number(maxTabs) || 12);
    this.onNeedsAttention = onNeedsAttention;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;

    this.tabs = new Map(); // tabId -> { id, key, name, vendorId, vendorName, url, session, presenter, controller, createdAt, lastUsedAt }
    this.keyToId = new Map();
    this.forcedFocusTabs = new Set();
    this.releasedTabIds = new Set();
    this.mutex = new Mutex();
    this.quitting = false;
  }

  setQuitting(v = true) {
    this.quitting = !!v;
    this.browserBackend?.setQuitting?.(this.quitting);
  }

  async #createTabUnlocked({ key = null, name = null, url = 'https://chatgpt.com/', show = false, protectedTab = false, vendorId = null, vendorName = null } = {}) {
    if (key && this.keyToId.has(key)) return this.keyToId.get(key);
    if (this.tabs.size >= this.maxTabs) throw new Error('max_tabs_reached');

    const id = crypto.randomUUID();
    let finalized = false;
    const finalizeClose = () => {
      if (finalized) return;
      finalized = true;
      this.tabs.delete(id);
      if (key) this.keyToId.delete(key);
      this.releasedTabIds.add(id);
      if (this.releasedTabIds.size > 512) this.releasedTabIds.delete(this.releasedTabIds.values().next().value);
      this.forcedFocusTabs.delete(id);
      this.onChanged?.();
    };

    const session = await this.browserBackend.createSession({
      tabId: id,
      url,
      show,
      protectedTab,
      vendorId,
      vendorName,
      onClosed: finalizeClose
    });
    let controller = null;
    try {
      controller = await this.createController({ tabId: id, page: session.page, session });
    } catch (error) {
      try {
        await session?.close?.();
      } catch {}
      finalizeClose();
      throw error;
    }

    const tab = {
      id,
      key,
      name: name || key || `tab-${id.slice(0, 8)}`,
      vendorId: vendorId || null,
      vendorName: vendorName || null,
      url: String(url || ''),
      session,
      presenter: session.presenter,
      controller,
      protectedTab: !!protectedTab,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    };

    this.tabs.set(id, tab);
    if (key) this.keyToId.set(key, id);
    this.onChanged?.();
    return id;
  }

  async createTab(options = {}) {
    return await this.mutex.run(async () => await this.#createTabUnlocked(options));
  }

  async ensureTab({ key, name, url, vendorId, vendorName, show, exactUrl = false } = {}) {
    if (!key) throw new Error('missing_key');
    return await this.mutex.run(async () => {
      const existing = this.keyToId.get(key);
      if (existing) {
        const tab = this.tabs.get(existing);
        if (!tab || tab.session?.isClosed?.()) {
          this.keyToId.delete(key);
          this.releasedTabIds.add(existing);
          if (this.releasedTabIds.size > 512) this.releasedTabIds.delete(this.releasedTabIds.values().next().value);
          if (tab) this.tabs.delete(existing);
          this.onChanged?.();
          return await this.#createTabUnlocked({ key, name, show: !!show, url, vendorId, vendorName });
        }
        if (!tabMatchesVendor(tab, { vendorId, url })) throw new Error('key_vendor_mismatch');
        if (exactUrl && String(tab.url || '') !== String(url || '')) throw new Error('key_url_mismatch');
        return existing;
      }
      return await this.#createTabUnlocked({ key, name, show: !!show, url, vendorId, vendorName });
    });
  }


  async adoptTab({ id, key, name, url, vendorId, vendorName } = {}) {
    return await this.mutex.run(async () => {
      if (!id) throw new Error('missing_tabId');
      if (!key) throw new Error('missing_key');
      const tab = this.tabs.get(id);
      if (!tab || tab.session?.isClosed?.()) throw new Error('tab_not_found');
      const existing = this.keyToId.get(key);
      if (existing && existing !== id) throw new Error('key_already_bound');
      if (String(tab.url || '') !== String(url || '')) throw new Error('tab_url_mismatch');
      if (!tabMatchesVendor(tab, { vendorId, url })) throw new Error('tab_vendor_mismatch');
      if (tab.key && tab.key !== key && tab.key !== 'default') throw new Error('tab_key_mismatch');
      if (tab.key && this.keyToId.get(tab.key) === id) this.keyToId.delete(tab.key);
      tab.key = key;
      tab.name = name || key;
      tab.vendorId = tab.vendorId || vendorId || null;
      tab.vendorName = tab.vendorName || vendorName || null;
      tab.lastUsedAt = Date.now();
      this.keyToId.set(key, id);
      this.onChanged?.();
      return id;
    });
  }

  updateTabUrl(id, url) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    const nextUrl = String(url || '').trim();
    if (!nextUrl) throw new Error('missing_url');
    tab.url = nextUrl;
    tab.lastUsedAt = Date.now();
    this.onChanged?.();
  }

  reconcileLiveTabUrl(id, url) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    let current;
    let observed;
    try {
      current = new URL(String(tab.url || ''));
      observed = new URL(String(url || ''));
    } catch {
      return false;
    }
    if (!['http:', 'https:'].includes(observed.protocol) || current.origin !== observed.origin) return false;
    if (tab.url === observed.href) return true;
    tab.url = observed.href;
    tab.lastUsedAt = Date.now();
    this.onChanged?.();
    return true;
  }

  listTabs() {
    const out = [];
    const backend = browserProvenance(this.browserBackend);
    for (const t of this.tabs.values()) {
      out.push({
        id: t.id,
        key: t.key || null,
        name: t.name,
        vendorId: t.vendorId || null,
        vendorName: t.vendorName || null,
        url: t.url || null,
        browser: backend,
        protectedTab: !!t.protectedTab,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt
      });
    }
    out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return out;
  }

  getControllerById(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    if (tab.session?.isClosed?.()) throw new Error('tab_closed');
    tab.lastUsedAt = Date.now();
    return tab.controller;
  }

  getWindowById(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    if (tab.session?.isClosed?.()) throw new Error('tab_closed');
    tab.lastUsedAt = Date.now();
    return tab.presenter;
  }

  async closeTab(id) {
    return await this.mutex.run(async () => {
      const tab = this.tabs.get(id);
      if (!tab) {
        if (this.releasedTabIds.has(id)) return { status: 'ALREADY_RELEASED', tabId: id };
        throw new Error('tab_not_found');
      }
      if (tab.protectedTab) throw new Error('default_tab_protected');
      let status = 'CLOSED';
      try {
        await tab.session?.close?.();
      } catch (error) {
        if (!missingBrowserTargetCloseError(error)) throw error;
        status = 'ALREADY_RELEASED';
      }
      if (tab.key && this.keyToId.get(tab.key) === id) this.keyToId.delete(tab.key);
      this.tabs.delete(id);
      this.forcedFocusTabs.delete(id);
      this.onChanged?.();
      this.releasedTabIds.add(id);
      if (this.releasedTabIds.size > 512) this.releasedTabIds.delete(this.releasedTabIds.values().next().value);
      return { status, tabId: id };
    });
  }

  async needsAttention(tabId, reason) {
    this.forcedFocusTabs.add(tabId);
    try {
      const presenter = this.getWindowById(tabId);
      if (presenter.isMinimized?.()) presenter.restore?.();
      presenter.show?.();
      presenter.focus?.();
    } catch {}
    await this.onNeedsAttention?.({ tabId, reason });
  }

  async resolvedAttention(tabId) {
    const wasForced = this.forcedFocusTabs.has(tabId);
    this.forcedFocusTabs.delete(tabId);
    if (wasForced) {
      try {
        const presenter = this.getWindowById(tabId);
        if (presenter.isVisible?.()) presenter.minimize?.();
      } catch {}
    }
    if (this.forcedFocusTabs.size === 0) {
      await this.onNeedsAttention?.({ tabId: null, reason: 'all_clear' });
    }
  }
}
