import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/clip-download.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function('exports', 'module', 'require', compiled)(module.exports, module, require);
const { normalizeStudioClipDownloadResponse } = module.exports;

test('normalizes Studio WAV ready response', () => {
  assert.deepEqual(
    normalizeStudioClipDownloadResponse('clip-1', 'wav', {
      ok: true,
      status: 'ready',
      download_url: 'https://cdn.example/signed.wav?signature=secret',
    }),
    {
      clip_id: 'clip-1',
      format: 'wav',
      status: 'ready',
      download_url: 'https://cdn.example/signed.wav?signature=secret',
    },
  );
});

test('normalizes Studio processing response and clamps retry', () => {
  assert.deepEqual(
    normalizeStudioClipDownloadResponse('clip-2', 'wav', {
      status: 'processing',
      retry_after_seconds: 60,
    }),
    {
      clip_id: 'clip-2',
      format: 'wav',
      status: 'processing',
      retry_after_seconds: 30,
    },
  );
});

test('rejects non-HTTPS Studio download URLs', () => {
  const result = normalizeStudioClipDownloadResponse('clip-3', 'wav', {
    status: 'ready',
    download_url: 'file:///tmp/not-a-download.wav',
  });
  assert.equal(result.status, 'error');
  assert.equal(result.download_url, undefined);
});

test('Studio routes and provider endpoints remain distinct from paid feed download', () => {
  const api = readFileSync(new URL('../src/lib/SunoApi.ts', import.meta.url), 'utf8');
  assert.match(api, /\/api\/studio\/create-or-load-project-for-clip/);
  assert.match(api, /\/api\/studio\/clip\/\$\{encodeURIComponent\(normalized\)\}\/download/);
  assert.match(api, /\/api\/studio\/project\/\$\{encodeURIComponent\(normalized\)\}\/archive/);
  assert.doesNotMatch(api, /SunoApi\.BASE_URL\}\/api\/project\/trash/);
  assert.match(api, /getStudioClipDownloadStatus/);
});
