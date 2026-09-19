// Incident-scoped, no-send verifier for one already committed first-binding
// operation. It attaches to the existing Agentify-managed disposable tab,
// exposes only ChatGPTController.observeReviewResponse through runReviewQuery,
// and prints metadata only. It has no prompt insertion, action, Send, retry,
// navigation, tab close, or arbitrary-operation surface.
import { readFile, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChromeCdpConnection, ChromeCdpPageAdapter } from '../chrome-cdp-backend.mjs';
import { ChatGPTController } from '../chatgpt-controller.mjs';
import { runReviewQuery } from '../review-transport.mjs';

const OPERATION = Object.freeze({
  operationId: '87b5fa79-c1c1-4514-9193-35135088bfd6',
  tabId: '701ee9be-ac5f-4636-b36d-4485c9866aa3',
  stableKey: 'DISH-RBHR-R05-CHATGPT-PRO-POST-RECOVERY-FRESH-FIRST-BINDING-20260822-01-68c94fa6-9b83-4550-afef-44551b990155',
  idempotencyKey: 'DISH-RBHR-R05-PRO-POST-RECOVERY-FRESH-FIRST-BINDING-CLOSURE-20260822-01-d7f94f60-f221-4aed-9515-2f4c4f1c90cf',
  url: 'https://chatgpt.com/c/6a89accf-8cf4-83e8-8e50-9e564b866e18',
  questionPath: 'C:/Projects/HMASD/docs/research/candidates/degraded_incumbent_shadow_handover/DISH_RBHR_R05_CHATGPT_PRO_STANDALONE_FIRST_BINDING_CLOSURE_QUESTION_20260821.md',
  promptSha256: 'edabebd4ebdf40dfbdf992fcb94628123f33876468ca6ba13b27a38d4867be41'
});
const STATE_DIR = 'C:/Users/fires/.agentify-desktop';
const ARCHIVE_PATH = 'C:/Projects/HMASD/temp/sessions/agentify_transport_operator/independent_research_explorer/dish_rbhr_r05_chatgpt_pro_post_recovery_fresh_first_binding_closure_20260822_02/NATURAL_COMPLETION_ARCHIVE.json';
const ROOT_REQUEST = Object.freeze({
  provider: 'chatgpt', model: 'Pro', stableKey: OPERATION.stableKey,
  idempotencyKey: OPERATION.idempotencyKey, conversationUrl: 'https://chatgpt.com/',
  conversationId: '__new__', firstBinding: true, verifyExisting: true,
  promptPath: OPERATION.questionPath, promptSha256: OPERATION.promptSha256,
  timeoutMs: 60_000
});

async function main() {
  const pages = (await (await fetch('http://127.0.0.1:9222/json/list')).json())
    .filter((entry) => entry?.type === 'page' && entry?.url === OPERATION.url);
  if (pages.length !== 1) throw new Error('dish_existing_review_target_ambiguous');
  const client = new ChromeCdpConnection(pages[0].webSocketDebuggerUrl);
  await client.connect();
  let sessionId = null;
  try {
    sessionId = (await client.send('Target.attachToTarget', { targetId: pages[0].id, flatten: true })).sessionId;
    const page = new ChromeCdpPageAdapter({ client, targetId: pages[0].id, sessionId });
    await page.initialize();
    if (await page.getUrl() !== OPERATION.url) throw new Error('dish_existing_review_url_mismatch');
    const selectors = JSON.parse(await readFile(new URL('../selectors.json', import.meta.url), 'utf8'));
    const prompt = await readFile(OPERATION.questionPath, 'utf8');
    const controller = new ChatGPTController({ page, selectors, stateDir: STATE_DIR });
    const tabs = {
      ensureTab: async () => OPERATION.tabId,
      getControllerById: (id) => id === OPERATION.tabId ? controller : null,
      updateTabUrl: () => {}
    };
    const completed = await runReviewQuery({ stateDir: STATE_DIR, tabs, request: { ...ROOT_REQUEST, prompt } });
    if (completed.status !== 'COMPLETE' || completed.terminalState !== 'NATURAL_COMPLETION_VERIFIED' || typeof completed.responseText !== 'string' || !completed.responseText.length) throw new Error('dish_existing_review_not_archivable');
    const archive = {
      schema: 'agentify_review_natural_completion_archive_v1',
      operationId: completed.operationId, idempotencyKey: completed.idempotencyKey,
      stableKey: completed.stableKey, provider: completed.provider, model: completed.model,
      conversationUrl: completed.conversationUrl, conversationId: completed.conversationId,
      terminalState: completed.terminalState, sendCount: completed.sendCount,
      sendActionCount: completed.sendActionCount, userMessageId: completed.userMessageId,
      assistantMessageId: completed.assistantMessageId, responseSha256: completed.responseSha256,
      responseText: completed.responseText, completedAt: completed.completedAt
    };
    const bytes = Buffer.from(`${JSON.stringify(archive)}\n`, 'utf8');
    await mkdir(path.dirname(ARCHIVE_PATH), { recursive: true });
    const tmp = `${ARCHIVE_PATH}.${crypto.randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx');
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    try { await rename(tmp, ARCHIVE_PATH); } catch (error) { await import('node:fs/promises').then(({ unlink }) => unlink(tmp).catch(() => {})); throw error; }
    process.stdout.write(`${JSON.stringify({ ok: true, operationId: completed.operationId, status: completed.status, terminalState: completed.terminalState, sendCount: completed.sendCount, sendActionCount: completed.sendActionCount, userMessageIdPresent: !!completed.userMessageId, assistantMessageIdPresent: !!completed.assistantMessageId, responseSha256: completed.responseSha256 || null, responseLength: completed.responseText.length, archivePath: ARCHIVE_PATH, archiveSha256: crypto.createHash('sha256').update(bytes).digest('hex') })}\n`);
  } finally {
    if (sessionId) await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || 'dish_existing_review_archive_error') })}\n`);
  process.exitCode = 1;
});
