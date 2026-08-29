import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadControllerGeneration, readControllerRefreshManifest } from '../controller-refresh.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('controller refresh: fixed manifest is source-digest-bound and cache-busted', async () => {
  const manifest = await readControllerRefreshManifest({ moduleRoot: root });
  assert.equal(manifest.modules.length, 2);
  assert.deepEqual(manifest.modules.map(({ name }) => name), ['chatgpt-controller.mjs', 'operator-control.mjs']);
  assert.match(manifest.sourceDigest, /^[0-9a-f]{64}$/);
  const specifiers = [];
  const loaded = await loadControllerGeneration({
    moduleRoot: root,
    generation: 7,
    importModule: async (specifier) => {
      specifiers.push(specifier);
      return specifier.includes('chatgpt-controller') ? { ChatGPTController: class {} } : { NativeOperatorControl: class {} };
    }
  });
  assert.equal(loaded.generation, 7);
  assert.equal(loaded.sourceDigest, manifest.sourceDigest);
  assert.equal(specifiers.length, 2);
  for (const specifier of specifiers) {
    assert.match(specifier, /agentifyControllerGeneration=7/);
    assert.match(specifier, /agentifyControllerSource=/);
    assert.doesNotMatch(specifier, /\.\.[/\\]/);
  }
});

test('controller refresh: real fixed modules load as one usable generation', async () => {
  const loaded = await loadControllerGeneration({ moduleRoot: root, generation: 3 });
  assert.equal(typeof loaded.ChatGPTController, 'function');
  assert.equal(typeof loaded.NativeOperatorControl, 'function');
  assert.match(loaded.sourceDigest, /^[0-9a-f]{64}$/);
});
