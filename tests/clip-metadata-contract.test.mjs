import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('clip metadata route updates lyrics and audio description independently', async () => {
  const route = await source('src/app/api/clip/[clip_id]/metadata/route.ts');
  assert.match(route, /setUploadedClipMetadata\(clipId, \{ lyrics \}\)/);
  assert.match(route, /setUploadedClipAudioDescription\(clipId, description/);
  assert.match(route, /setUploadedClipDisplayTags\(clipId, description/);
  assert.match(route, /const clip: any = await api\.getClip\(clipId\)/);
  assert.match(route, /clipType === 'upload'/);
  assert.match(route, /runSunoRequestWithAffinity/);
  assert.match(route, /readAccountAffinity/);
  assert.match(route, /'partial'/);
  assert.match(route, /retryable/);
  assert.doesNotMatch(route, /JSON\.stringify\(error/);
});

test('clip metadata route requires a valid affinity and cannot fall back to another account', async () => {
  const route = await source('src/app/api/clip/[clip_id]/metadata/route.ts');
  assert.match(route, /account_affinity_required/);
  assert.match(route, /invalid_account_affinity/);
  assert.match(route, /error instanceof AccountAffinityError/);
  assert.match(
    route,
    /runSunoRequestWithAffinity\(\s*undefined,\s*tier,\s*accountId,/,
  );
  assert.doesNotMatch(route, /from 'next\/headers'/);
});

test('SunoApi sends Song Details description through the native endpoint', async () => {
  const api = await source('src/lib/SunoApi.ts');
  assert.match(api, /setUploadedClipAudioDescription/);
  assert.match(api, /set_audio_description/);
  assert.match(api, /user_corrected_description/);
  assert.match(api, /setUploadedClipDisplayTags/);
  assert.match(api, /set_display_tags/);
  assert.match(api, /display_tags/);
  assert.match(api, /providerMutationError/);
  assert.match(api, /error_type/);
  assert.match(api, /assertProviderMutationSuccess/);
  assert.match(api, /keepAlive\(false\)/);
});

test('clip metadata errors retain safe provider codes and retryability', async () => {
  const route = await source('src/app/api/clip/[clip_id]/metadata/route.ts');
  assert.match(route, /function safeProviderCode/);
  assert.match(route, /data\?\.error_type/);
  assert.match(route, /typeof error\?\.retryable === 'boolean'/);
  assert.match(route, /code,\s+retryable: retryableError\(error\)/);
});

test('deferred fast uploads do not send a placeholder prompt and remain idempotent', async () => {
  const runner = await source('src/lib/fast-upload.ts');
  const route = await source('src/app/api/upload_audio/route.ts');
  assert.match(runner, /deferMetadata\?: boolean/);
  assert.match(runner, /defer_metadata: Boolean\(input\.metadata\.deferMetadata\)/);
  assert.match(runner, /input\.metadata\.deferMetadata \? \{\} : \{ prompt/);
  assert.match(route, /getBoolean\(form, 'defer_metadata'\)/);
  assert.match(runner, /deferMetadata/);
  assert.match(route, /defer_metadata/);
});
