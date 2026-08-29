#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { defaultStateDir } from './state.mjs';
import { ensureDesktopRunning, requestJson } from './mcp-lib.mjs';
import { prepareReviewPromptInput } from './review-transport.mjs';

const server = new McpServer({ name: 'agentify-desktop', version: '0.1.0' });
const stateDir = defaultStateDir();
const showTabs = process.argv.includes('--show-tabs');

function resolveLocalPaths(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => (path.isAbsolute(item) ? item : path.resolve(process.cwd(), item)));
}

function registerTool(name, def, handler) {
  server.registerTool(name, def, handler);
}

async function getConn() {
  return await ensureDesktopRunning({ stateDir, showTabs });
}

registerTool(
  'agentify_query',
  {
    description:
      'Send a prompt to a local Agentify Desktop browser session and return the latest assistant response. If a CAPTCHA/login challenge appears, the browser window will ask for user intervention and resume automatically.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      expectedModel: z.string().optional().describe('Exact visible reviewer model to select before sending (e.g., "GPT-5.6 Pro").'),
      tabId: z.string().optional().describe('Tab/session id to use (for parallel jobs).'),
      key: z.string().optional().describe('Stable tab key (e.g., project name); creates a tab if missing.'),
      bundleName: z.string().optional().describe('Named context bundle to merge into this query before sending.'),
      prompt: z.string().optional().describe('Prompt to send to the selected AI web UI. Use either prompt or promptPath.'),
      promptPath: z.string().optional().describe('Local UTF-8 text file whose exact content is sent as the prompt. Use either promptPath or prompt.'),
      promptPrefix: z.string().optional().describe('Optional reusable instruction block prepended before packed context and prompt.'),
      attachments: z.array(z.string()).optional().describe('Local file paths to upload before sending the prompt.'),
      contextPaths: z.array(z.string()).optional().describe('Local files/folders to pack into the prompt and/or attach automatically.'),
      maxContextChars: z.number().optional().describe('Maximum packed inline context characters to add before the prompt.'),
      maxContextFiles: z.number().optional().describe('Maximum number of files to scan from contextPaths.'),
      maxContextFileChars: z.number().optional().describe('Maximum sampled characters per text file before chunking.'),
      maxContextChunkChars: z.number().optional().describe('Maximum characters per inline chunk when a text file is split.'),
      maxContextChunksPerFile: z.number().optional().describe('Maximum number of chunks to inline for any single file.'),
      maxContextInlineFiles: z.number().optional().describe('Maximum number of text files to inline into the prompt.'),
      maxContextAttachments: z.number().optional().describe('Maximum binary/image files auto-attached from contextPaths.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.')
    }
  },
  async ({
    model,
    expectedModel,
    tabId,
    key,
    bundleName,
    prompt,
    promptPath,
    promptPrefix,
    attachments,
    contextPaths,
    maxContextChars,
    maxContextFiles,
    maxContextFileChars,
    maxContextChunkChars,
    maxContextChunksPerFile,
    maxContextInlineFiles,
    maxContextAttachments,
    timeoutMs
  }) => {
    const hasPrompt = typeof prompt === 'string';
    const hasPromptPath = typeof promptPath === 'string' && promptPath.trim().length > 0;
    if (hasPrompt === hasPromptPath) throw new Error('exactly_one_of_prompt_or_promptPath_required');
    const resolvedPromptPath = hasPromptPath
      ? (path.isAbsolute(promptPath) ? promptPath : path.resolve(process.cwd(), promptPath))
      : null;
    const exactPrompt = resolvedPromptPath
      ? await fs.readFile(resolvedPromptPath, 'utf8')
      : prompt;
    const resolvedAttachments = resolveLocalPaths(attachments || []);
    const resolvedContextPaths = resolveLocalPaths(contextPaths || []);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: {
        source: 'mcp',
        model,
        expectedModel,
        tabId,
        key,
        bundleName,
        prompt: exactPrompt,
        promptPrefix,
        attachments: resolvedAttachments,
        contextPaths: resolvedContextPaths,
        maxContextChars: maxContextChars || undefined,
        maxContextFiles: maxContextFiles || undefined,
        maxContextFileChars: maxContextFileChars || undefined,
        maxContextChunkChars: maxContextChunkChars || undefined,
        maxContextChunksPerFile: maxContextChunksPerFile || undefined,
        maxContextInlineFiles: maxContextInlineFiles || undefined,
        maxContextAttachments: maxContextAttachments || undefined,
        timeoutMs: timeoutMs || 10 * 60_000
      }
    });
    const structuredContent = {
      status: data.result?.status || 'COMPLETE',
      text: data.result?.text || '',
      codeBlocks: data.result?.codeBlocks || [],
      meta: data.result?.meta || null,
      conversationUrl: data.result?.conversationUrl || null,
      conversationId: data.result?.conversationId || null,
      modelEvidence: data.result?.modelEvidence || null,
      packedContext: data.packedContext || null,
      packedContextSummary: data.packedContextSummary || data.packedContext?.summary || null,
      bundle: data.bundle || null
    };
    return {
      content: [{ type: 'text', text: structuredContent.text }],
      structuredContent: { tabId: data.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_review_query',
  {
    description:
      'Strict receipt-bearing ChatGPT or Gemini review transport. Binds one stable key to one exact provider conversation, records immutable model evidence per operation, submits at most once per idempotency key, and verifies natural completion from exact message identities.',
    inputSchema: {
      stableKey: z.string().describe('Persistent stable binding key.'),
      provider: z.enum(['chatgpt', 'gemini']).describe('Exact provider identity.'),
      model: z.string().describe('Exact visible Pro model label expected in the conversation UI.'),
      conversationUrl: z.string().describe('Exact registered conversation URL, or the provider root for first binding.'),
      conversationId: z.string().describe('Exact conversation identity contained in conversationUrl, or __new__ for first binding.'),
      idempotencyKey: z.string().describe('Immutable operation idempotency key.'),
      prompt: z.string().optional().describe('Exact prompt bytes to submit once. Use either prompt or promptPath.'),
      promptPath: z.string().optional().describe('Local UTF-8 text file whose exact content is submitted once. Use either promptPath or prompt.'),
      promptSha256: z.string().optional().describe('Optional tool-local integrity check. When omitted Agentify computes it internally.'),
      responsePath: z.string().describe('Absolute local path for the full naturally completed response. COMPLETE is unavailable until this exact file is atomically committed and verified.'),
      timeoutMs: z.number().optional().describe('Natural-completion wait window, up to 45 minutes. Agentify returns a nonterminal state when generation continues.'),
      verifyExisting: z.boolean().optional().describe('Observe and re-verify an existing operation without sending again.'),
      firstBinding: z.boolean().optional().describe('Bind a clean provider-root conversation to its concrete identity created by the one send.'),
      geminiBootstrap: z.boolean().optional().describe('Gemini-only, non-scientific first-binding bootstrap. Requires firstBinding and bootstrapNonScientific.'),
      geminiBootstrapContinuation: z.boolean().optional().describe('Gemini-only one-time authorized continuation after a committed non-scientific bootstrap; allows one recorded model transition.'),
      bootstrapNonScientific: z.boolean().optional().describe('Required true for geminiBootstrap; records that the bootstrap is not the scientific request.'),
      existingTabId: z.string().optional().describe('Adopt this exact already-inspected provider tab for a new operation.')
    }
  },
  async ({
    stableKey,
    provider,
    model,
    conversationUrl,
    conversationId,
    idempotencyKey,
    prompt,
    promptPath,
    promptSha256,
    responsePath,
    timeoutMs,
    verifyExisting,
    firstBinding,
    geminiBootstrap,
    geminiBootstrapContinuation,
    bootstrapNonScientific,
    existingTabId
  }) => {
    const exactPrompt = await prepareReviewPromptInput({ prompt, promptPath, promptSha256 });
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/review-query',
      body: {
        stableKey,
        provider,
        model,
        conversationUrl,
        conversationId,
        idempotencyKey,
        prompt: exactPrompt,
        promptSha256,
        responsePath,
        timeoutMs: timeoutMs ?? 45 * 60_000,
        verifyExisting: verifyExisting === true,
        firstBinding: firstBinding === true,
        geminiBootstrap: geminiBootstrap === true,
        geminiBootstrapContinuation: geminiBootstrapContinuation === true,
        bootstrapNonScientific: bootstrapNonScientific === true,
        existingTabId: existingTabId || undefined
      }
    });
    const receipt = data.receipt || null;
    const { responseText: _inlineResponse, ...publicReceipt } = receipt || {};
    return {
      content: [{ type: 'text', text: JSON.stringify(publicReceipt, null, 2) }],
      structuredContent: { receipt: publicReceipt }
    };
  }
);

// This deliberately has no prompt input and therefore cannot enter a provider
// turn.  It exposes the strict controller's genuine Gemini picker preflight
// through the same native MCP boundary used by production transport.
registerTool(
  'agentify_review_preflight',
  {
    description:
      'Non-sending strict Gemini model preflight on an already inspected Agentify tab. Verifies the visible selected model and thinking controls without creating a review operation, editing a composer, or sending a provider turn.',
    inputSchema: {
      expectedModel: z.string().describe('Exact Gemini model/mode required by the later strict review.'),
      tabId: z.string().describe('Exact existing Gemini tab to inspect; this tool never creates a tab.'),
      timeoutMs: z.number().optional().describe('Bounded preflight timeout, maximum one minute.')
    }
  },
  async ({ expectedModel, tabId, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/review-preflight',
      body: {
        expectedModel,
        tabId,
        timeoutMs: timeoutMs ?? 20_000
      }
    });
    const result = data.result || null;
    return {
      content: [{ type: 'text', text: JSON.stringify(result || {}, null, 2) }],
      structuredContent: { tabId: data.tabId || tabId, result }
    };
  }
);

// No prompt, stable key, or idempotency key is accepted here. This native
// primitive can only normalize ChatGPT's visible High/Pro reasoning mode and
// returns before any composer, ledger, or Send surface.
registerTool(
  'agentify_review_reasoning_mode_preflight',
  {
    description:
      'Non-sending ChatGPT reasoning-mode preflight on an already inspected tab. A fresh tab may read High; it selects exact Pro only from one unambiguous visible controlled-menu option and returns a zero-send receipt.',
    inputSchema: {
      expectedMode: z.string().describe('Exact ChatGPT reasoning mode required before a later strict review.'),
      tabId: z.string().describe('Exact existing ChatGPT tab to inspect; this tool never creates a tab.'),
      timeoutMs: z.number().optional().describe('Bounded preflight timeout, maximum one minute.')
    }
  },
  async ({ expectedMode, tabId, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/review-reasoning-mode-preflight',
      body: { expectedMode, tabId, timeoutMs: timeoutMs ?? 20_000 }
    });
    const result = data.result || null;
    return {
      content: [{ type: 'text', text: JSON.stringify(result || {}, null, 2) }],
      structuredContent: { tabId: data.tabId || tabId, result }
    };
  }
);

// Read-only visible-control observer for the same no-send reasoning-mode
// surface. It has no composer, prompt, ledger, or Send input.
registerTool(
  'agentify_review_reasoning_mode_diagnostics',
  {
    description:
      'Visible ChatGPT reasoning-control diagnostic. scope=page reports only visible interactive role/name/ARIA/controlled-menu relationships; optional openModeSelector opens exactly one visible High/Pro or Model Selector control to inspect its rendered menu, never edits a composer or sends.',
    inputSchema: {
      tabId: z.string().describe('Exact existing ChatGPT tab to inspect; this tool never creates a tab.'),
      scope: z.enum(['composer', 'page']).optional().describe('Visible control scope; page includes header/topbar and composer.'),
      openModeSelector: z.boolean().optional().describe('When true with scope=page, opens only one unambiguous visible High/Pro or Model Selector control and reports visible menu controls; it never types or sends.'),
      timeoutMs: z.number().optional().describe('Bounded diagnostic timeout, maximum one minute.')
    }
  },
  async ({ tabId, scope, openModeSelector, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/review-reasoning-mode-diagnostics',
      body: { tabId, scope: scope ?? 'composer', openModeSelector: openModeSelector === true, timeoutMs: timeoutMs ?? 20_000 }
    });
    const result = data.result || null;
    return {
      content: [{ type: 'text', text: JSON.stringify(result || {}, null, 2) }],
      structuredContent: { tabId: data.tabId || tabId, result }
    };
  }
);

// Aggregate-only ChatGPT profile/session observer. It deliberately cannot
// return cookie values or create/send a provider operation.
registerTool(
  'agentify_review_chatgpt_profile_snapshot',
  {
    description:
      'Non-sending ChatGPT profile/root-binding snapshot for one existing tab. Returns visible control state and aggregate cookie-presence metadata only; never cookie values, composer input, or provider turns.',
    inputSchema: {
      tabId: z.string().describe('Exact existing ChatGPT tab to inspect; this tool never creates a tab.'),
      timeoutMs: z.number().optional().describe('Bounded snapshot timeout, maximum one minute.')
    }
  },
  async ({ tabId, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/review-chatgpt-profile-snapshot',
      body: { tabId, timeoutMs: timeoutMs ?? 20_000 }
    });
    const result = data.result || null;
    return {
      content: [{ type: 'text', text: JSON.stringify(result || {}, null, 2) }],
      structuredContent: { tabId: data.tabId || tabId, result }
    };
  }
);

// Closed-loop, result-blind native UI control. Observation returns only visible
// control metadata/composer hashes. Mutation rejects the protected default,
// stale URL/revision, ambiguous or forbidden response controls.
registerTool(
  'agentify_operator_observe',
  {
    description: 'Observe one existing Agentify tab for closed-loop UI control. Returns current URL, visible hit-tested controls, nested rendered High/Pro reasoning-text mappings only when they resolve to one actionable ancestor, composer metadata, generation controls, and an action-bound observation revision; it never sends.',
    inputSchema: { tabId: z.string().describe('Exact existing tab; this tool never creates or mutates a tab.') }
  },
  async ({ tabId }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/operator-observe', body: { tabId } });
    return { content: [{ type: 'text', text: JSON.stringify(data.result || {}, null, 2) }], structuredContent: { tabId: data.tabId || tabId, result: data.result || null } };
  }
);

registerTool(
  'agentify_operator_act',
  {
    description: 'Perform one native pointer, key, text, or paste action only on a current observed visible target. It rejects protected-default mutation, stale URL/revision, ambiguous/hidden targets, and Send/Stop/Retry/Continue controls; returns an after-action observation receipt.',
    inputSchema: {
      tabId: z.string(), url: z.string(), revision: z.string(), targetId: z.string(), action: z.enum(['click', 'key', 'text', 'paste']),
      key: z.string().optional(), modifiers: z.array(z.string()).optional(), textPath: z.string().optional(), textSha256: z.string().optional()
    }
  },
  async ({ tabId, url, revision, targetId, action, key, modifiers, textPath, textSha256 }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/operator-act', body: { tabId, url, revision, targetId, action, key, modifiers, textPath, textSha256 } });
    return { content: [{ type: 'text', text: JSON.stringify(data.result || {}, null, 2) }], structuredContent: { tabId: data.tabId || tabId, result: data.result || null } };
  }
);

registerTool(
  'agentify_operator_wait',
  {
    description: 'Boundedly re-observe one existing tab with backoff until visible interactive state or an exact visible target predicate settles. A timeout is LOAD_OR_POSTCONDITION_UNRESOLVED with its result-blind observation timeline; it never acts or sends.',
    inputSchema: { tabId: z.string(), url: z.string().optional(), role: z.string().optional(), label: z.string().optional(), selected: z.boolean().optional(), timeoutMs: z.number().optional() }
  },
  async ({ tabId, url, role, label, selected, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/operator-wait', body: { tabId, url, role, label, selected, timeoutMs } });
    return { content: [{ type: 'text', text: JSON.stringify(data.result || {}, null, 2) }], structuredContent: { tabId: data.tabId || tabId, result: data.result || null } };
  }
);

// Native local lifecycle control. It has no tab, provider, prompt, or source
// path input and therefore cannot become a transport or browser-control path.
registerTool(
  'agentify_runtime_controller_refresh_status',
  {
    description: 'Read the loaded Agentify controller generation and fixed-source digest. This is local runtime metadata only and never opens or changes a tab.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/runtime-controller-refresh-status' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_runtime_controller_refresh',
  {
    description: 'Locally refresh the fixed Agentify controller/observer modules without restarting Agentify, Chrome, profile, or tabs. Requires the exact currently loaded generation and source digest; refuses while any query or strict operation is active. It cannot send or create a provider operation.',
    inputSchema: {
      expectedGeneration: z.number().int().nonnegative(),
      expectedSourceDigest: z.string().regex(/^[0-9a-f]{64}$/)
    }
  },
  async ({ expectedGeneration, expectedSourceDigest }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/runtime-controller-refresh', body: { expectedGeneration, expectedSourceDigest } });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

// This ledger-only operation deliberately has no page or prompt input. It
// exposes durable strict-operation facts without providing a route to prepare,
// send, or recover a provider turn.
registerTool(
  'agentify_review_observe',
  {
    description:
      'Observe one durable strict-review ledger operation without opening a tab, reading a prompt, editing a composer, or sending a provider turn.',
    inputSchema: {
      idempotencyKey: z.string().describe('Exact immutable strict operation key.'),
      operationId: z.string().optional().describe('Optional exact durable operation id for identity cross-check.')
    }
  },
  async ({ idempotencyKey, operationId }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/review-observe',
      body: { idempotencyKey, operationId }
    });
    const result = data.result || null;
    return {
      content: [{ type: 'text', text: JSON.stringify(result || {}, null, 2) }],
      structuredContent: { result }
    };
  }
);

registerTool(
  'agentify_read_page',
  {
    description: 'Read text content from the active tab in the local Agentify Desktop window.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      maxChars: z.number().optional().describe('Maximum characters to return.')
    }
  },
  async ({ model, tabId, key, maxChars }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/read-page',
      body: { model, tabId, key, maxChars: maxChars || 200_000 }
    });
    return { content: [{ type: 'text', text: data.text || '' }] };
  }
);

registerTool(
  'agentify_list_conversations',
  {
    description: 'List ChatGPT conversations currently visible in the selected Agentify page so an operator can choose the appropriate session.',
    inputSchema: {
      model: z.string().optional().describe('Target provider hint (normally "chatgpt").'),
      tabId: z.string().optional().describe('Tab id to inspect.'),
      key: z.string().optional().describe('Stable tab key to inspect or create.'),
      limit: z.number().optional().describe('Maximum visible conversations to return.')
    }
  },
  async ({ model, tabId, key, limit }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/conversations/list',
      body: { model, tabId, key, limit: limit || 100 }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.conversations || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_open_conversation',
  {
    description: 'Open an exact ChatGPT conversation URL in the selected Agentify page.',
    inputSchema: {
      model: z.string().optional().describe('Target provider hint (normally "chatgpt").'),
      tabId: z.string().optional().describe('Tab id to use.'),
      key: z.string().optional().describe('Stable tab key to use or create.'),
      url: z.string().describe('Exact ChatGPT conversation URL returned by the page or supplied by the task.')
    }
  },
  async ({ model, tabId, key, url }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/navigate', body: { model, tabId, key, url } });
    return { content: [{ type: 'text', text: data.url || 'ok' }], structuredContent: data };
  }
);

registerTool(
  'agentify_new_conversation',
  {
    description: 'Open a clean new ChatGPT conversation composer in the selected Agentify page.',
    inputSchema: {
      model: z.string().optional().describe('Target provider hint (normally "chatgpt").'),
      tabId: z.string().optional().describe('Tab id to use.'),
      key: z.string().optional().describe('Stable tab key to use or create.')
    }
  },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/conversations/new', body: { model, tabId, key } });
    return { content: [{ type: 'text', text: data.url || 'ok' }], structuredContent: data };
  }
);

registerTool(
  'agentify_wait_response',
  {
    description: 'Wait for the currently generating assistant response on an existing Agentify tab. A long generation returns IN_PROGRESS before the MCP client deadline; call this same tool again. This tool never sends a prompt or activates a response control.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Existing tab/session id to use.'),
      key: z.string().optional().describe('Existing stable tab key to use.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for natural completion.'),
      expectedModel: z.string().optional().describe('Exact visible model that must remain selected through terminal completion.')
    }
  },
  async ({ model, tabId, key, timeoutMs, expectedModel }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/wait-response',
      body: { model, tabId, key, expectedModel, timeoutMs: timeoutMs || 45 * 60_000 }
    });
    const inProgress = data.inProgress === true;
    const text = data.result?.text || '';
    return {
      content: [{ type: 'text', text: inProgress ? 'IN_PROGRESS' : text }],
      structuredContent: {
        status: inProgress ? 'IN_PROGRESS' : 'COMPLETE',
        tabId: data.tabId || tabId || null,
        text,
        meta: data.result?.meta || null,
        conversationUrl: data.result?.conversationUrl || null,
        conversationId: data.result?.conversationId || null,
        modelEvidence: data.result?.modelEvidence || null
      }
    };
  }
);

registerTool(
  'agentify_navigate',
  {
    description: 'Navigate the Agentify Desktop browser window to a URL (local UI automation).',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      url: z.string().describe('URL to navigate to.')
    }
  },
  async ({ model, tabId, key, url }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/navigate', body: { model, tabId, key, url } });
    return { content: [{ type: 'text', text: data.url || 'ok' }], structuredContent: data };
  }
);

registerTool(
  'agentify_ensure_ready',
  {
    description:
      'Wait until the selected AI web UI is ready for input (e.g., after login/CAPTCHA). Triggers local user handoff if needed and resumes when the prompt textarea is visible.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for readiness.')
    }
  },
  async ({ model, tabId, key, timeoutMs }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/ensure-ready',
      body: { model, tabId, key, timeoutMs: timeoutMs || 10 * 60_000 }
    });
    return { content: [{ type: 'text', text: JSON.stringify(data.state || {}, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_show',
  { description: 'Bring the Agentify Desktop window to the front.', inputSchema: { model: z.string().optional(), tabId: z.string().optional(), key: z.string().optional() } },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/show', body: { model, tabId, key } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_hide',
  { description: 'Minimize the Agentify Desktop window.', inputSchema: { model: z.string().optional(), tabId: z.string().optional(), key: z.string().optional() } },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/hide', body: { model, tabId, key } });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

registerTool(
  'agentify_status',
  {
    description: 'Get current URL, blocked/ready state, and actual provider-browser provenance. Strict transport requires attached existing Google Chrome CDP; Electron control-center state is not provider provenance.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to inspect.'),
      key: z.string().optional().describe('Stable tab key to inspect.'),
      vendorId: z.string().optional().describe('Target vendor id to inspect.')
    }
  },
  async ({ model, tabId, key, vendorId }) => {
    const conn = await getConn();
    const qs = new URLSearchParams();
    if (tabId) qs.set('tabId', tabId);
    if (key) qs.set('key', key);
    if (vendorId) qs.set('vendorId', vendorId);
    if (model) qs.set('model', model);
    const path = qs.size ? `/status?${qs.toString()}` : '/status';
    const data = await requestJson({ ...conn, method: 'GET', path });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_stop_query',
  {
    description: 'Break-glass stop for a running query/send on a tab. Best-effort: requests cancellation and clicks the provider stop button if visible.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to stop.'),
      key: z.string().optional().describe('Stable tab key to stop.'),
      vendorId: z.string().optional().describe('Target vendor id to stop.')
    }
  },
  async ({ model, tabId, key, vendorId }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query/stop',
      body: { model, tabId, key, vendorId }
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_image_gen',
  {
    description:
      'Generate images via the selected AI web UI (best-effort): sends the prompt, then downloads images from the page to a local folder and returns file paths.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      prompt: z.string().describe('Prompt to send for image generation.'),
      timeoutMs: z.number().optional().describe('Maximum time to wait for completion.'),
      maxImages: z.number().optional().describe('Maximum images to download.')
    }
  },
  async ({ model, tabId, key, prompt, timeoutMs, maxImages }) => {
    const conn = await getConn();
    const q = await requestJson({
      ...conn,
      method: 'POST',
      path: '/query',
      body: { source: 'mcp', model, tabId, key, prompt, attachments: [], timeoutMs: timeoutMs || 10 * 60_000 }
    });
    const d = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId: q.tabId || tabId, key, mode: 'images', maxImages: maxImages || 6 }
    });
    const structuredContent = { text: q.result?.text || '', files: d.artifacts || [], dir: d.dir || null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: { tabId: q.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_download_images',
  {
    description:
      'Download images from the latest assistant message (best-effort). Useful if you generated images manually in the UI or via agentify_query.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; creates a tab if missing.'),
      maxImages: z.number().optional().describe('Maximum images to download.')
    }
  },
  async ({ model, tabId, key, maxImages }) => {
    const conn = await getConn();
    const d = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId, key, mode: 'images', maxImages: maxImages || 6 }
    });
    const structuredContent = { files: d.artifacts || [], dir: d.dir || null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent: { tabId: d.tabId || tabId || null, ...structuredContent }
    };
  }
);

registerTool(
  'agentify_list_watch_folders',
  {
    description: 'List local watch/ingest folders that Agentify indexes into artifacts automatically.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/watch-folders/list' });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.folders || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_add_watch_folder',
  {
    description: 'Add a local folder to Agentify watch/ingest folders.',
    inputSchema: {
      name: z.string().optional().describe('Friendly folder name. If omitted, Agentify derives one from the path.'),
      folderPath: z.string().describe('Local folder path to watch. Relative paths resolve from the MCP client working directory.')
    }
  },
  async ({ name, folderPath }) => {
    const rawPath = String(folderPath || '').trim();
    if (!rawPath) throw new Error('missing_watch_folder_path');
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/add',
      body: { name: name || '', path: resolvedPath }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.folder || null, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_remove_watch_folder',
  {
    description: 'Remove a configured watch/ingest folder by name.',
    inputSchema: {
      name: z.string().describe('Configured watch folder name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/delete',
      body: { name }
    });
    return {
      content: [{ type: 'text', text: data.deleted ? 'deleted' : 'not_found' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_open_watch_folder',
  {
    description: 'Open the local watch/ingest folder in Finder/Explorer so you can drop files there for automatic indexing.',
    inputSchema: {
      name: z.string().optional().describe('Watch folder name. Defaults to inbox.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/watch-folders/open',
      body: { name: name || 'inbox' }
    });
    return {
      content: [{ type: 'text', text: data.folder?.path || 'ok' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_scan_watch_folder',
  {
    description: 'Force an immediate scan of the watch/ingest folder and index any newly dropped files as artifacts.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/watch-folders/scan', body: {} });
    return {
      content: [{ type: 'text', text: JSON.stringify({ folders: data.folders || [], ingested: data.ingested || [] }, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_save_bundle',
  {
    description:
      'Save a named reusable bundle of prompt prefix, attachments, and context paths. Useful for recurring project workflows.',
    inputSchema: {
      name: z.string().describe('Stable bundle name, e.g. repo-review.'),
      promptPrefix: z.string().optional().describe('Reusable instruction prefix.'),
      attachments: z.array(z.string()).optional().describe('Local files to always attach with this bundle.'),
      contextPaths: z.array(z.string()).optional().describe('Local files/folders to pack when this bundle is used.')
    }
  },
  async ({ name, promptPrefix, attachments, contextPaths }) => {
    const resolvedAttachments = resolveLocalPaths(attachments || []);
    const resolvedContextPaths = resolveLocalPaths(contextPaths || []);
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/bundles/save',
      body: { name, promptPrefix, attachments: resolvedAttachments, contextPaths: resolvedContextPaths }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundle || {}, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_list_bundles',
  {
    description: 'List saved context bundles.',
    inputSchema: {}
  },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/bundles/list' });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundles || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_get_bundle',
  {
    description: 'Fetch a saved context bundle by name.',
    inputSchema: {
      name: z.string().describe('Bundle name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/bundles/get', body: { name } });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.bundle || null, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_delete_bundle',
  {
    description: 'Delete a saved context bundle by name.',
    inputSchema: {
      name: z.string().describe('Bundle name.')
    }
  },
  async ({ name }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/bundles/delete', body: { name } });
    return {
      content: [{ type: 'text', text: data.deleted ? 'deleted' : 'not_found' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_save_artifacts',
  {
    description:
      'Save the latest assistant-generated images/files from a tab to the local artifacts folder. Returns local paths you can reuse as attachments in the next prompt.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to use.'),
      key: z.string().optional().describe('Stable tab key; uses the existing tab.'),
      mode: z.enum(['images', 'files', 'all']).optional().describe('What to save from the latest assistant response.'),
      maxImages: z.number().optional().describe('Maximum images to save when mode includes images.'),
      maxFiles: z.number().optional().describe('Maximum files/links to save when mode includes files.')
    }
  },
  async ({ model, tabId, key, mode, maxImages, maxFiles }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/save',
      body: { model, tabId, key, mode: mode || 'all', maxImages: maxImages || 6, maxFiles: maxFiles || 6 }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ dir: data.dir || null, artifacts: data.artifacts || [] }, null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_list_artifacts',
  {
    description: 'List locally saved artifacts for a tab/session so you can reuse their paths in later prompts.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id to inspect.'),
      key: z.string().optional().describe('Stable tab key to inspect.'),
      limit: z.number().optional().describe('Maximum number of artifacts to return.')
    }
  },
  async ({ model, tabId, key, limit }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/list',
      body: { model, tabId, key, limit: limit || 50 }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(data.artifacts || [], null, 2) }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_open_artifacts_folder',
  {
    description: 'Open the local artifacts folder in Finder/Explorer for the whole app or for a specific tab/session.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      tabId: z.string().optional().describe('Tab/session id whose artifacts folder should open.'),
      key: z.string().optional().describe('Stable tab key whose artifacts folder should open.')
    }
  },
  async ({ model, tabId, key }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/artifacts/open-folder',
      body: { model, tabId, key }
    });
    return {
      content: [{ type: 'text', text: data.folderPath || 'ok' }],
      structuredContent: data
    };
  }
);

registerTool(
  'agentify_tabs',
  { description: 'List current tabs/sessions (for parallel jobs).', inputSchema: {} },
  async () => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'GET', path: '/tabs' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
);

registerTool(
  'agentify_tab_create',
  {
    description: 'Create (or ensure) a tab/session for a given key.',
    inputSchema: {
      model: z.string().optional().describe('Target model/provider hint (e.g., "chatgpt").'),
      key: z.string().optional(),
      name: z.string().optional(),
      show: z.boolean().optional().describe('Show the tab window immediately.')
    }
  },
  async ({ model, key, name, show }) => {
    const conn = await getConn();
    const data = await requestJson({
      ...conn,
      method: 'POST',
      path: '/tabs/create',
      body: { model, key, name, show: typeof show === 'boolean' ? show : undefined }
    });
    return { content: [{ type: 'text', text: data.tabId || '' }], structuredContent: data };
  }
);

registerTool(
  'agentify_tab_close',
  { description: 'Close a tab/session by tabId.', inputSchema: { tabId: z.string().describe('Tab id to close.') } },
  async ({ tabId }) => {
    const conn = await getConn();
    const data = await requestJson({ ...conn, method: 'POST', path: '/tabs/close', body: { tabId } });
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }
);

registerTool('agentify_shutdown', { description: 'Gracefully shut down the Agentify Desktop app.', inputSchema: {} }, async () => {
  const conn = await getConn();
  await requestJson({ ...conn, method: 'POST', path: '/shutdown', body: { scope: 'app' } });
  return { content: [{ type: 'text', text: 'ok' }] };
});

registerTool(
  'agentify_rotate_token',
  { description: 'Rotate the local HTTP API bearer token (requires reconnect on subsequent calls).', inputSchema: {} },
  async () => {
    const conn = await getConn();
    await requestJson({ ...conn, method: 'POST', path: '/rotate-token' });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('agentify-desktop MCP server running on stdio');
}

main().catch((e) => {
  console.error('agentify-desktop MCP fatal:', e);
  process.exit(1);
});
