import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);

async function loadPool() {
  const filename = new URL('../src/lib/account-pool.ts', import.meta.url);
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

async function fixture(maxConcurrent = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'suno-affinity-queue-'));
  process.env.ACCOUNT_DATA_PATH = path.join(directory, 'accounts.json');
  process.env.ACCOUNT_ENCRYPTION_KEY = 'affinity-queue-test-key';
  delete process.env.SUNO_COOKIE;
  delete global.accountPool;
  const helper = await loadPool();
  const pool = helper.getAccountPool();
  const account = await pool.add({
    name: 'affinity-test',
    tier: 'heavy',
    cookie: '__client=queue-test',
    maxConcurrent,
  });
  return { account, directory, helper, pool };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('bound account waiters enter in FIFO order', async () => {
  const before = {
    dataPath: process.env.ACCOUNT_DATA_PATH,
    key: process.env.ACCOUNT_ENCRYPTION_KEY,
    cookie: process.env.SUNO_COOKIE,
  };
  const { account, directory, pool } = await fixture(1);
  try {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const entered = [];
    const first = pool.executeForAccount('heavy', account.id, async () => {
      entered.push('first');
      await firstRelease.promise;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = pool.executeForAccount('heavy', account.id, async () => {
      entered.push('second');
      await secondRelease.promise;
    }, { maxWaitMs: 1_000 });
    const third = pool.executeForAccount('heavy', account.id, async () => {
      entered.push('third');
    }, { maxWaitMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(entered, ['first']);
    firstRelease.resolve();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(entered, ['first', 'second']);
    secondRelease.resolve();
    await Promise.all([second, third]);
    assert.deepEqual(entered, ['first', 'second', 'third']);
    assert.equal((await pool.list())[0].inflight, 0);
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

test('long post-processing waits before leasing and leaves a slot for short reads', async () => {
  const before = {
    dataPath: process.env.ACCOUNT_DATA_PATH,
    key: process.env.ACCOUNT_ENCRYPTION_KEY,
    cookie: process.env.SUNO_COOKIE,
  };
  const { account, directory, pool } = await fixture(2);
  try {
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const entered = [];
    const first = pool.executeLongForAccount('heavy', account.id, async () => {
      entered.push('long-1');
      await releaseFirst.promise;
    }, { maxWaitMs: 1_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const second = pool.executeLongForAccount('heavy', account.id, async () => {
      entered.push('long-2');
      await releaseSecond.promise;
    }, { maxWaitMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(entered, ['long-1']);
    assert.equal((await pool.list())[0].inflight, 1);
    const short = await pool.executeForAccount('heavy', account.id, async () => 'short');
    assert.equal(short, 'short');
    assert.equal((await pool.list())[0].inflight, 1);
    releaseFirst.resolve();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(entered, ['long-1', 'long-2']);
    releaseSecond.resolve();
    await second;
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

test('bound account timeout and queue overflow stay pre-submission', async () => {
  const before = {
    dataPath: process.env.ACCOUNT_DATA_PATH,
    key: process.env.ACCOUNT_ENCRYPTION_KEY,
    cookie: process.env.SUNO_COOKIE,
    limit: process.env.ACCOUNT_AFFINITY_QUEUE_LIMIT,
  };
  const { account, directory, pool } = await fixture(1);
  process.env.ACCOUNT_AFFINITY_QUEUE_LIMIT = '1';
  try {
    const release = deferred();
    const held = pool.executeForAccount('heavy', account.id, async () => release.promise);
    await new Promise((resolve) => setImmediate(resolve));
    const waiter = pool.executeForAccount(
      'heavy', account.id, async () => undefined, { maxWaitMs: 80 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => pool.executeForAccount('heavy', account.id, async () => undefined, { maxWaitMs: 80 }),
      (error) => error?.code === 'account_affinity_queue_full' && error?.status === 429,
    );
    await assert.rejects(
      () => waiter,
      (error) => error?.code === 'account_affinity_busy' && error?.status === 429,
    );
    release.resolve();
    await held;
  } finally {
    delete global.accountPool;
    if (before.dataPath === undefined) delete process.env.ACCOUNT_DATA_PATH;
    else process.env.ACCOUNT_DATA_PATH = before.dataPath;
    if (before.key === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = before.key;
    if (before.cookie === undefined) delete process.env.SUNO_COOKIE;
    else process.env.SUNO_COOKIE = before.cookie;
    if (before.limit === undefined) delete process.env.ACCOUNT_AFFINITY_QUEUE_LIMIT;
    else process.env.ACCOUNT_AFFINITY_QUEUE_LIMIT = before.limit;
    await rm(directory, { recursive: true, force: true });
  }
});

test('pool only changes accounts after a conclusive not-submitted error', async () => {
  const before = {
    dataPath: process.env.ACCOUNT_DATA_PATH,
    key: process.env.ACCOUNT_ENCRYPTION_KEY,
    cookie: process.env.SUNO_COOKIE,
  };
  const { directory, pool } = await fixture(1);
  try {
    await pool.add({
      name: 'affinity-test-2', tier: 'heavy', cookie: '__client=queue-test-2', maxConcurrent: 1,
    });
    const entered = [];
    const selected = await pool.execute('heavy', async (_cookie, account) => {
      entered.push(account.id);
      if (entered.length === 1) {
        const error = new Error('captcha busy');
        error.code = 'suno_captcha_unavailable';
        error.status = 503;
        error.submissionState = 'not_submitted';
        error.recordAccountFailure = false;
        error.allowAccountFailover = true;
        throw error;
      }
      return account.id;
    }, 3);
    assert.equal(entered.length, 2);
    assert.notEqual(entered[0], entered[1]);
    assert.equal(selected, entered[1]);

    let unknownCalls = 0;
    await assert.rejects(
      pool.execute('heavy', async () => {
        unknownCalls += 1;
        throw new Error('response lost after POST');
      }, 3),
      /response lost/,
    );
    assert.equal(unknownCalls, 1);
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
