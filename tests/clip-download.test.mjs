import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/clip-download.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function('exports', 'module', 'require', compiled)(module.exports, module, require);

const { normalizeClipDownloadResponse } = module.exports;

test('normalizes a ready MP3 preparation response', () => {
  assert.deepEqual(
    normalizeClipDownloadResponse('clip-1', 'mp3', {
      ok: true,
      status: 'ready',
      download_url: 'https://cdn.example/signed.mp3?signature=secret',
    }),
    {
      clip_id: 'clip-1',
      format: 'mp3',
      status: 'ready',
      download_url: 'https://cdn.example/signed.mp3?signature=secret',
    },
  );
});

test('keeps a processing download out of the failure path', () => {
  assert.deepEqual(
    normalizeClipDownloadResponse('clip-2', 'mp3', {
      ok: true,
      status: 'processing',
      retry_after: 4.2,
    }),
    {
      clip_id: 'clip-2',
      format: 'mp3',
      status: 'processing',
      retry_after_seconds: 5,
    },
  );
});

test('rejects an unsafe ready URL', () => {
  const result = normalizeClipDownloadResponse('clip-3', 'mp3', {
    status: 'ready',
    download_url: 'file:///tmp/not-a-download.mp3',
  });
  assert.equal(result.status, 'error');
  assert.equal(result.download_url, undefined);
});
