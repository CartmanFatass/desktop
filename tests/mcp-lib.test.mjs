import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { ensureToken, writeState } from '../state.mjs';
import { ensureDesktopRunning, requestJson } from '../mcp-lib.mjs';

async function tempDir() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  return base;
}

function makeFetch({ getServerId, acceptToken = 't' }) {
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, serverId: getServerId() };
        }
      };
    }
    if (u.endsWith('/status')) {
      const hdr = String(opts?.headers?.authorization || '');
      const okAuth = hdr === `Bearer ${acceptToken}`;
      return {
        ok: okAuth,
        status: okAuth ? 200 : 401,
        async json() {
          return okAuth ? { ok: true, url: 'https://chatgpt.com/', tabs: [] } : { error: 'unauthorized' };
        }
      };
    }
    throw new Error(`unexpected_url:${url}`);
  };
}

test('mcp-lib: requestJson throws with status and body', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    async json() {
      return { error: 'forbidden', message: 'nope' };
    }
  });

  await assert.rejects(
    () => requestJson({ baseUrl: 'http://x', token: 't', method: 'GET', path: '/status', fetchImpl }),
    (err) => {
      assert.equal(err.message, 'nope');
      assert.equal(err.data.status, 403);
      assert.equal(err.data.body.error, 'forbidden');
      return true;
    }
  );
});

test('mcp-lib: default loopback client bypasses fetch for delayed headers and body', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer t');
    assert.equal(req.headers['content-type'], 'application/json');
    if (req.url === '/delayed-headers') {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, delayed: 'headers' }));
      }, 80);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ ok: true, delayed: 'body' })), 80);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('default_fetch_must_not_be_called');
  };
  try {
    const { port } = server.address();
    const delayedHeaders = await requestJson({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 't',
      method: 'POST',
      path: '/delayed-headers',
      body: { request: 'long-running' }
    });
    const delayedBody = await requestJson({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 't',
      method: 'POST',
      path: '/delayed-body',
      body: { request: 'long-running' }
    });
    assert.deepEqual(delayedHeaders, { ok: true, delayed: 'headers' });
    assert.deepEqual(delayedBody, { ok: true, delayed: 'body' });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('mcp-lib: ensureDesktopRunning uses existing connection when serverId matches', async () => {
  const dir = await tempDir();
  await ensureToken(dir);
  await writeState({ ok: true, port: 12345, serverId: 'sid-a' }, dir);

  const token = 't';
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');

  const conn = await ensureDesktopRunning({
    stateDir: dir,
    fetchImpl: makeFetch({ getServerId: () => 'sid-a', acceptToken: token }),
    spawnImpl: () => {
      throw new Error('should_not_spawn');
    },
    timeoutMs: 1000
  });
  assert.equal(conn.serverId, 'sid-a');
});

test('mcp-lib: ensureDesktopRunning spawns if serverId mismatches and then recovers', async () => {
  const dir = await tempDir();
  const token = 't';
  await ensureToken(dir);
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');
  await writeState({ ok: true, port: 12345, serverId: 'sid-old' }, dir);

  let fetchServerId = 'sid-wrong';
  const fetchImpl = makeFetch({ getServerId: () => fetchServerId, acceptToken: token });

  let spawned = 0;
  const spawnImpl = (_cmd, _args, opts) => {
    spawned += 1;
    assert.equal(opts?.env?.AGENTIFY_DESKTOP_SHOW_TABS, 'true');
    assert.equal(opts?.detached, true);
    // Simulate that the spawned app writes a new state with matching serverId.
    fetchServerId = 'sid-new';
    void writeState({ ok: true, port: 12345, serverId: 'sid-new' }, dir);
    return { unref() {} };
  };

  const conn = await ensureDesktopRunning({ stateDir: dir, fetchImpl, spawnImpl, timeoutMs: 3000, showTabs: true });
  assert.ok(spawned >= 1);
  assert.equal(conn.serverId, 'sid-new');
});

test('mcp-lib: Windows spawn uses Node-hosted Electron CLI without shell', async () => {
  const dir = await tempDir();
  const token = 't';
  await ensureToken(dir);
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');
  await writeState({ ok: true, port: 12345, serverId: 'sid-old' }, dir);

  let fetchServerId = 'sid-wrong';
  let spawnedCmd = null;
  let spawnedArgs = null;
  let spawnShell = null;
  const conn = await ensureDesktopRunning({
    stateDir: dir,
    fetchImpl: makeFetch({ getServerId: () => fetchServerId, acceptToken: token }),
    platform: 'win32',
    spawnImpl: (cmd, args, opts) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      spawnShell = opts?.shell;
      fetchServerId = 'sid-new';
      void writeState({ ok: true, port: 12345, serverId: 'sid-new' }, dir);
      return { unref() {} };
    },
    timeoutMs: 3000
  });
  assert.equal(conn.serverId, 'sid-new');
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(spawnedCmd, process.execPath);
  assert.equal(spawnedArgs?.[0], path.join(packageRoot, 'node_modules', 'electron', 'cli.js'));
  assert.equal(spawnedArgs?.[1], path.join(packageRoot, 'main.mjs'));
  assert.equal(spawnShell, false);
});

test('mcp-lib: ensureDesktopRunning resolves bundled electron relative to desktop package, not cwd', async () => {
  const dir = await tempDir();
  const token = 't';
  await ensureToken(dir);
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');

  const originalCwd = process.cwd();
  const fakeCwd = await tempDir();
  let spawnedCmd = null;
  let spawnedArgs = null;
  let running = false;
  try {
    process.chdir(fakeCwd);
    const fetchImpl = makeFetch({ getServerId: () => (running ? 'sid-new' : 'sid-missing'), acceptToken: token });
    const spawnImpl = (cmd, args, opts) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      assert.equal(opts?.detached, true);
      running = true;
      void writeState({ ok: true, port: 12345, serverId: 'sid-new' }, dir);
      return { unref() {} };
    };

    const conn = await ensureDesktopRunning({ stateDir: dir, fetchImpl, spawnImpl, timeoutMs: 3000 });
    assert.equal(conn.serverId, 'sid-new');
    assert.equal(path.isAbsolute(spawnedCmd), true);
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    assert.equal(spawnedCmd, process.execPath);
    assert.equal(spawnedArgs?.[0], path.join(packageRoot, 'node_modules', 'electron', 'cli.js'));
    assert.equal(spawnedArgs?.[1], path.join(packageRoot, 'main.mjs'));
  } finally {
    process.chdir(originalCwd);
  }
});
