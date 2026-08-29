import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULES = Object.freeze(['chatgpt-controller.mjs', 'operator-control.mjs']);

function fail(code) {
  throw new Error(code);
}

export async function readControllerRefreshManifest({ moduleRoot = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const root = path.resolve(moduleRoot);
  const entries = [];
  for (const name of MODULES) {
    const candidate = path.resolve(root, name);
    if (path.dirname(candidate) !== root) fail('controller_refresh_module_path_invalid');
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('controller_refresh_module_not_regular_file');
    const bytes = await fs.readFile(candidate);
    entries.push({ name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const canonical = JSON.stringify(entries);
  return Object.freeze({ moduleRoot: root, modules: entries, sourceDigest: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex') });
}

export async function loadControllerGeneration({ moduleRoot, generation, importModule = (specifier) => import(specifier) } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 0) fail('controller_refresh_generation_invalid');
  const manifest = await readControllerRefreshManifest({ moduleRoot });
  const specifier = (name) => {
    const file = path.join(manifest.moduleRoot, name);
    const url = pathToFileURL(file);
    url.searchParams.set('agentifyControllerGeneration', String(generation));
    url.searchParams.set('agentifyControllerSource', manifest.sourceDigest);
    return url.href;
  };
  const [controller, operator] = await Promise.all([importModule(specifier('chatgpt-controller.mjs')), importModule(specifier('operator-control.mjs'))]);
  if (typeof controller?.ChatGPTController !== 'function' || typeof operator?.NativeOperatorControl !== 'function') {
    fail('controller_refresh_module_exports_invalid');
  }
  return Object.freeze({
    generation,
    sourceDigest: manifest.sourceDigest,
    sourceModules: manifest.modules,
    ChatGPTController: controller.ChatGPTController,
    NativeOperatorControl: operator.NativeOperatorControl
  });
}
