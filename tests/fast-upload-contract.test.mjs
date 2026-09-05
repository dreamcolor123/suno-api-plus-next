import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);

async function loadTypeScript(relativePath) {
  const filename = new URL(relativePath, import.meta.url);
  const source = await readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', '__filename', '__dirname', compiled)(
    module.exports,
    module,
    require,
    filename.pathname,
    path.dirname(filename.pathname),
  );
  return module.exports;
}

async function loadFastUploadModule() {
  const filename = new URL('../src/lib/fast-upload.ts', import.meta.url);
  const source = await readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === '@/lib/account-affinity') {
      return { createAccountAffinity: (id) => `affinity:${id}` };
    }
    if (specifier === '@/lib/SunoApi') {
      return {
        withSunoAccount: async () => { throw new Error('network disabled in classifier test'); },
        withSunoAccountAffinity: async () => { throw new Error('network disabled in classifier test'); },
        withSunoAccountExclusive: async () => { throw new Error('network disabled in classifier test'); },
      };
    }
    if (specifier === '@/lib/fast-upload-policy') {
      return {
        fastUploadFingerprint: () => 'fingerprint',
        idempotencyStorageId: () => 'storage',
      };
    }
    return require(specifier);
  };
  new Function('exports', 'module', 'require', '__filename', '__dirname', compiled)(
    module.exports,
    module,
    localRequire,
    filename.pathname,
    path.dirname(filename.pathname),
  );
  return module.exports;
}

test('uses the exact 30.000-second server-side routing boundary', async () => {
  const policy = await loadTypeScript('../src/lib/fast-upload-policy.ts');
  assert.equal(policy.uploadMethodForDuration(29.999999), 'direct');
  assert.equal(policy.uploadMethodForDuration(30), 'direct');
  assert.equal(policy.uploadMethodForDuration(30.000001), 'studio_fast');
  assert.throws(() => policy.uploadMethodForDuration(Number.NaN), /finite positive/);
});

test('builds a stable content and metadata fingerprint', async () => {
  const policy = await loadTypeScript('../src/lib/fast-upload-policy.ts');
  const first = policy.fastUploadFingerprint('abc', { title: 'Song', prompt: 'Words' });
  const reordered = policy.fastUploadFingerprint('abc', { prompt: 'Words', title: 'Song' });
  assert.equal(first, reordered);
  assert.notEqual(first, policy.fastUploadFingerprint('def', { title: 'Song', prompt: 'Words' }));
  assert.notEqual(first, policy.fastUploadFingerprint('abc', { title: 'Other', prompt: 'Words' }));
});

test('exclusive account lease reserves every slot on exactly one account', async () => {
  const before = {
    dataPath: process.env.ACCOUNT_DATA_PATH,
    key: process.env.ACCOUNT_ENCRYPTION_KEY,
    cookie: process.env.SUNO_COOKIE,
  };
  const directory = await mkdtemp(path.join(tmpdir(), 'suno-account-exclusive-'));
  process.env.ACCOUNT_DATA_PATH = path.join(directory, 'accounts.json');
  process.env.ACCOUNT_ENCRYPTION_KEY = 'fast-upload-contract-test-key';
  delete process.env.SUNO_COOKIE;
  delete global.accountPool;
  try {
    const { getAccountPool } = await loadTypeScript('../src/lib/account-pool.ts');
    const pool = getAccountPool();
    await pool.add({
      name: 'exclusive-test',
      tier: 'heavy',
      cookie: '__client=test-cookie',
      maxConcurrent: 2,
    });
    let enter;
    let release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const running = pool.executeExclusive('heavy', async () => {
      enter();
      await held;
      return 'complete';
    });
    await entered;
    const [view] = await pool.list();
    assert.equal(view.inflight, 2);
    await assert.rejects(
      () => pool.execute('heavy', async () => 'unexpected', 1),
      (error) => error?.code === 'account_pool_busy',
    );
    release();
    assert.equal(await running, 'complete');
    assert.equal((await pool.list())[0].inflight, 0);
    const permission = new Error('clip belongs to another account');
    permission.response = { status: 403, data: { detail: 'permission denied' } };
    await assert.rejects(
      () => pool.execute('heavy', async () => { throw permission; }, 1),
      /clip belongs to another account/,
    );
    const afterPermission = (await pool.list())[0];
    assert.equal(afterPermission.status, 'active');
    assert.equal(afterPermission.failures, 0);
    assert.equal(afterPermission.health, 1);
  } finally {
    delete global.accountPool;
    if (before.dataPath === undefined) delete process.env.ACCOUNT_DATA_PATH;
    else process.env.ACCOUNT_DATA_PATH = before.dataPath;
    if (before.key === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = before.key;
    if (before.cookie === undefined) delete process.env.SUNO_COOKIE;
    else process.env.SUNO_COOKIE = before.cookie;
    await rm(directory, { recursive: true, force: true });
  }
});

test('fast upload route has no direct-upload fallback after Studio selection', async () => {
  const route = await readFile(new URL('../src/app/api/upload_audio/route.ts', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../src/lib/fast-upload.ts', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../python/fast_upload_worker.py', import.meta.url), 'utf8');
  assert.match(route, /const automaticUploadMethod = uploadMethodForDuration\(durationSeconds\)/);
  assert.match(route, /requestedUploadMethod \|\| automaticUploadMethod/);
  assert.match(route, /if \(uploadMethod === 'studio_fast'\)/);
  assert.match(route, /getText\(form, 'upload_method'\)/);
  assert.match(route, /executeStudioFastUpload/);
  assert.match(route, /upload_method: 'direct'/);
  assert.match(route, /portable_clip: false/);
  assert.match(route, /duration_seconds: durationSeconds/);
  assert.doesNotMatch(route, /catch[\s\S]{0,300}uploadAudio\(audio/);
  assert.match(runner, /Idempotency-Key|idempotency/i);
  assert.match(runner, /taskkill\.exe/);
  assert.match(runner, /HTTP_PROXY: proxy/);
  assert.match(runner, /SUNO_FAST_UPLOAD_TOKEN_REFRESH_SEC/);
  assert.match(runner, /Math\.min\(8, Number\(process\.env\.SUNO_FAST_UPLOAD_MAX_CONCURRENT\) \|\| 4\)/);
  assert.match(runner, /SUNO_FAST_UPLOAD_SEGMENT_CONCURRENCY\) \|\| 1/);
  assert.match(runner, /reconcileStudioFastUpload/);
  assert.match(runner, /if \(job\.state === 'submission_unknown'\)/);
  assert.match(runner, /PYTHONDONTWRITEBYTECODE: '1'/);
  assert.match(runner, /PYTHONPYCACHEPREFIX: path\.join\(input\.taskDir, 'pycache'\)/);
  assert.doesNotMatch(worker, /fetch_workspace_part_ids|cleanup_workspace_uploaded_parts/);
});

test('fast upload reconciliation is read-only and cannot replay an unknown job', async () => {
  const route = await readFile(
    new URL('../src/app/api/upload_audio/reconcile/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /reconcileStudioFastUpload/);
  assert.match(route, /idempotency_key/);
  assert.doesNotMatch(route, /executeStudioFastUpload/);
  assert.doesNotMatch(route, /uploadAudio\(/);
});

test('fast upload persists segment ownership before failure and reconciles remotely', async () => {
  const worker = await readFile(
    new URL('../python/fast_upload_worker.py', import.meta.url),
    'utf8',
  );
  const runner = await readFile(new URL('../src/lib/fast-upload.ts', import.meta.url), 'utf8');
  const api = await readFile(new URL('../src/lib/SunoApi.ts', import.meta.url), 'utf8');
  assert.match(worker, /record_uploaded_row/);
  assert.match(worker, /uploaded_rows\.json/);
  assert.match(worker, /failure_preserve_evidence/);
  assert.match(runner, /account_id\?: string/);
  assert.match(runner, /getStudioProject/);
  assert.match(runner, /getRawFeed/);
  assert.match(runner, /cleanup_confirmed/);
  assert.match(api, /public async getStudioProject/);
  assert.match(api, /public async getRawFeed/);
});

test('reconciliation ignores project UUIDs and unrelated same-title Feed clips', async () => {
  const fastUpload = await loadFastUploadModule();
  const find = fastUpload.__fastUploadReconciliationTestOnly.findReconciledCandidate;
  const projectId = '11111111-1111-4111-8111-111111111111';
  const unrelatedClip = '22222222-2222-4222-8222-222222222222';
  const project = { id: projectId, type: 'studio_project', title: 'Same title' };
  const feed = {
    clips: [{
      id: unrelatedClip,
      type: 'audio',
      title: 'Same title',
      audio_url: `https://cdn.example/${unrelatedClip}.mp3`,
    }],
  };
  assert.equal(find(project, feed, projectId, [], '__sfp_task_'), null);
});

test('reconciliation accepts only a concrete output nested in the exact project', async () => {
  const fastUpload = await loadFastUploadModule();
  const find = fastUpload.__fastUploadReconciliationTestOnly.findReconciledCandidate;
  const projectId = '11111111-1111-4111-8111-111111111111';
  const clipId = '33333333-3333-4333-8333-333333333333';
  const project = {
    id: projectId,
    type: 'studio_project',
    outputs: [{
      id: clipId,
      type: 'audio',
      title: 'Rendered source',
      audio_url: `https://cdn.example/${clipId}.mp3`,
    }],
  };
  const candidate = find(project, {}, projectId, [], '__sfp_task_');
  assert.equal(candidate.clip_id, clipId);
  assert.equal(candidate.song_url, `https://suno.com/song/${clipId}`);
});

test('clip operation routes use the pool and return affinity headers', async () => {
  for (const endpoint of ['cover', 'extend_audio', 'generate_stems', 'concat']) {
    const source = await readFile(
      new URL(`../src/app/api/${endpoint}/route.ts`, import.meta.url),
      'utf8',
    );
    assert.match(source, /runSunoRequestWithAffinity/);
    assert.match(source, /addAccountAffinity/);
    assert.match(source, /affinityResponseHeaders/);
  }
});

test('documents that public and portable clips cannot use Stems across accounts', async () => {
  const swagger = await readFile(
    new URL('../src/app/docs/swagger-suno-api.json', import.meta.url),
    'utf8',
  );
  assert.match(swagger, /Cross-account public\/portable Stems are not supported upstream/);
  assert.match(swagger, /pass the owning account affinity/);
});
