import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ignoredNames = new Set(['.git', 'node_modules', '.next', 'data', '__pycache__', 'tsconfig.tsbuildinfo']);

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (ignoredNames.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(full));
    else result.push(full);
  }
  return result;
}

test('publish tree has no private native runtime or obvious credential literals', async () => {
  const all = await files(root);
  assert.equal(all.some((file) => /\.pyd$|\.pyc$|\.log$|\.pid$|\.env$|\.tsbuildinfo$/i.test(file)), false);
  const textFiles = all.filter((file) => /\.(?:ts|tsx|js|mjs|py|md|json|yml|yaml|toml|bat|txt)$/i.test(file));
  const content = (await Promise.all(textFiles.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(content, /gho_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(content, /Bearer\s+[A-Za-z0-9._-]{32,}/);
  assert.doesNotMatch(content, /suno_studio_tool\.cp311-win_amd64\.pyd/);
  assert.doesNotMatch(content, /C:\\\\Users\\\\admin/);
  assert.doesNotMatch(content, /suno_generator[\\/]/);
});
