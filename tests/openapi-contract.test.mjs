import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('OpenAPI source and public copy are synchronized and cover all route families', async () => {
  const sourcePath = path.join(root, 'src', 'app', 'docs', 'swagger-suno-api.json');
  const publicPath = path.join(root, 'public', 'swagger-suno-api.json');
  const sourceText = await readFile(sourcePath, 'utf8');
  const publicText = await readFile(publicPath, 'utf8');
  assert.equal(sourceText, publicText);
  const spec = JSON.parse(sourceText);
  const paths = Object.keys(spec.paths);
  assert.ok(paths.length >= 47);
  for (const required of [
    '/api/advanced_stems',
    '/api/advanced_stems/wav',
    '/api/advanced_stems/render',
    '/api/upload_audio/reconcile',
    '/api/clip/{clip_id}/download',
    '/api/clip/{clip_id}/metadata',
    '/api/studio/clip/{clip_id}/downbeats',
    '/api/studio/clip/{clip_id}/download',
    '/api/studio/project/{project_id}/save',
    '/api/studio/project/{project_id}/trash',
    '/api/admin/captcha/probe',
    '/v1/images/generations',
    '/v1/videos',
  ]) assert.ok(paths.includes(required), `missing ${required}`);
  assert.equal(spec.info.version, '2.0.0');
});
