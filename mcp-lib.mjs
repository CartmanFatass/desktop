import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { readState, readToken } from './state.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function electronLaunch({ platform, allowFallback = false }) {
  const override = String(process.env.AGENTIFY_DESKTOP_ELECTRON_BIN || '').trim();
  if (override) {
    return {
      command: override,
      argsPrefix: [],
      shell: platform === 'win32' && /\.(cmd|bat)$/i.test(override)
    };
  }

  const electronCli = path.resolve(__dirname, 'node_modules', 'electron', 'cli.js');
  if (await fileExists(electronCli)) {
    return { command: process.execPath, argsPrefix: [electronCli], shell: false };
  }

  if (allowFallback) {
    return { command: 'electron', argsPrefix: [], shell: platform === 'win32' };
  }

  throw new Error('missing_electron_binary');
}

export async function loadConnection({ stateDir }) {
  const state = await readState(stateDir);
  const token = await readToken(stateDir);
  if (!state?.port || !token) return null;
  return { baseUrl: `http://127.0.0.1:${state.port}`, token, serverId: state.serverId || null };
}

async function validateConn({ conn, fetchImpl }) {
  // 1) Health: ensures something is listening, and optionally matches serverId.
  const health = await fetchImpl(`${conn.baseUrl}/health`);
  const healthData = await health.json().catch(() => ({}));
  if (!health.ok) return { ok: false, reason: 'health_not_ok' };
  if (conn.serverId && healthData?.serverId && conn.serverId !== healthData.serverId) return { ok: false, reason: 'server_id_mismatch' };

  // 2) Authenticated status: ensures token matches and the server is ours.
  const status = await fetchImpl(`${conn.baseUrl}/status`, { headers: { authorization: `Bearer ${conn.token}` } });
  const statusData = await status.json().catch(() => ({}));
  if (!status.ok) return { ok: false, reason: 'status_not_ok', status: status.status };
  if (statusData?.error === 'unauthorized') return { ok: false, reason: 'unauthorized' };
  if (statusData?.ok !== true) return { ok: false, reason: 'unexpected_status_payload' };
  return { ok: true, serverId: healthData?.serverId || null };
}

async function requestJsonNoTimeout({ url, method, headers, body }) {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? https.request : http.request;
  return await new Promise((resolve, reject) => {
    const req = request(target, { method, headers, timeout: 0 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        let data = {};
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Match Response.json() failure handling below: an unreadable payload
          // is represented as an empty object for normal HTTP error reporting.
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function requestJson({ baseUrl, token, method, path: pth, body, fetchImpl }) {
  const url = `${baseUrl}${pth}`;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`
  };
  const serializedBody = body ? JSON.stringify(body) : undefined;
  const response = fetchImpl
    ? await fetchImpl(url, { method, headers, body: serializedBody })
    : await requestJsonNoTimeout({ url, method, headers, body: serializedBody });
  const data = 'data' in response ? response.data : await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const err = new Error(data?.message || data?.error || `http_${response.status}`);
    err.data = { status: response.status, body: data };
    throw err;
  }
  return data;
}

export async function ensureDesktopRunning({
  stateDir,
  fetchImpl = fetch,
  spawnImpl = spawn,
  timeoutMs = 30_000,
  showTabs = false,
  platform = process.platform
}) {
  const conn = await loadConnection({ stateDir });
  if (conn) {
    try {
      const v = await validateConn({ conn, fetchImpl });
      if (v.ok) return conn;
    } catch {
      // fallthrough to spawn
    }
  }

  const entry = path.join(__dirname, 'main.mjs');
  const launch = await electronLaunch({ platform, allowFallback: spawnImpl !== spawn });
  if (!(await fileExists(entry))) throw new Error('missing_desktop_entry');

  spawnImpl(launch.command, [...launch.argsPrefix, entry], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENTIFY_DESKTOP_STATE_DIR: stateDir,
      ...(showTabs ? { AGENTIFY_DESKTOP_SHOW_TABS: 'true' } : {})
    },
    shell: launch.shell
  })?.unref?.();

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = await loadConnection({ stateDir });
    if (c) {
      try {
        const v = await validateConn({ conn: c, fetchImpl });
        if (v.ok) return c;
      } catch {}
    }
    await sleep(300);
  }
  throw new Error('desktop_start_timeout');
}
