export const SUPPORTED_BROWSER_BACKENDS = ['chrome-cdp', 'electron'];
export const STRICT_TRANSPORT_BROWSER_BACKEND = 'chrome-cdp';

export function normalizeBrowserBackend(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'chrome-cdp';
  if (raw === 'chrome' || raw === 'chrome_cdp' || raw === 'cdp') return 'chrome-cdp';
  if (SUPPORTED_BROWSER_BACKENDS.includes(raw)) return raw;
  return 'chrome-cdp';
}

export function resolveBrowserBackend({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--browser-backend') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  return normalizeBrowserBackend(argValue || env.AGENTIFY_DESKTOP_BROWSER_BACKEND || settings.browserBackend);
}

function configuredBrowserBackend({ argv = process.argv, env = process.env, settings = {} } = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--browser-backend') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  return normalizeBrowserBackend(argValue || env.AGENTIFY_DESKTOP_BROWSER_BACKEND || settings.browserBackend);
}

// The desktop shell may still be Electron, but provider transport must never
// use an Electron BrowserWindow. Reject an explicit Electron setting instead
// of silently falling back, so a strict runtime cannot create a provider tab on
// the wrong surface.
export function resolveStrictTransportBrowserBackend(options = {}) {
  const backend = configuredBrowserBackend(options);
  if (backend !== STRICT_TRANSPORT_BROWSER_BACKEND) {
    const error = new Error('strict_transport_requires_chrome_cdp');
    error.data = { configuredBackend: backend };
    throw error;
  }
  return backend;
}

export function resolveChromeExecutablePath({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-binary') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = argValue || env.AGENTIFY_DESKTOP_CHROME_BIN || settings.chromeExecutablePath || '';
  const trimmed = String(raw || '').trim();
  return trimmed || null;
}

export function resolveChromeDebugPort({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-debug-port') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = argValue || env.AGENTIFY_DESKTOP_CHROME_DEBUG_PORT || settings.chromeDebugPort;
  const port = Math.floor(Number(raw));
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return 9222;
  return port;
}

export function resolveChromeProfileMode({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-profile-mode') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = String(argValue || env.AGENTIFY_DESKTOP_CHROME_PROFILE_MODE || settings.chromeProfileMode || '').trim().toLowerCase();
  return raw === 'existing' ? 'existing' : 'isolated';
}

export function resolveChromeProfileName({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-profile-name') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = String(argValue || env.AGENTIFY_DESKTOP_CHROME_PROFILE_NAME || settings.chromeProfileName || '').trim();
  return raw || 'Default';
}

export function resolveChromeAttachExisting({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-attach-existing') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = argValue ?? env.AGENTIFY_DESKTOP_CHROME_ATTACH_EXISTING ?? settings.chromeAttachExisting;
  return raw === true || String(raw || '').trim().toLowerCase() === 'true';
}

export async function createBrowserBackend({
  kind,
  stateDir,
  windowDefaults,
  userAgent,
  popupPolicy,
  onChanged,
  chromeExecutablePath,
  chromeDebugPort,
  chromeProfileMode,
  chromeProfileName,
  chromeAttachExisting
} = {}) {
  const normalized = normalizeBrowserBackend(kind);
  if (normalized === 'chrome-cdp') {
    const { ChromeCdpBrowserBackend } = await import('./chrome-cdp-backend.mjs');
    return new ChromeCdpBrowserBackend({
      stateDir,
      userAgent,
      onChanged,
      executablePath: chromeExecutablePath,
      debugPort: chromeDebugPort,
      profileMode: chromeProfileMode,
      profileName: chromeProfileName,
      attachExisting: chromeAttachExisting
    });
  }
  const { ElectronBrowserBackend } = await import('./electron-browser-backend.mjs');
  return new ElectronBrowserBackend({
    windowDefaults,
    userAgent,
    popupPolicy,
    onChanged
  });
}
