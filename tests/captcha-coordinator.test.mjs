import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const realRequire = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function loadCoordinator() {
  const filename = path.join(root, 'src', 'lib', 'captcha-coordinator.ts');
  const source = await readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === '@/lib/captcha-provider') return { configuredCaptchaProviders: () => [] };
    return realRequire(specifier);
  };
  new Function('exports', 'module', 'require', '__filename', '__dirname', compiled)(
    module.exports, module, localRequire, filename, path.dirname(filename),
  );
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const context = {
  schemaVersion: 'suno-hcaptcha-challenge/v1',
  websiteURL: 'https://suno.com/create',
  websiteKey: 'site-key',
  rqdata: 'rqdata',
  userAgent: 'UA',
  invisible: true,
  source: 'network',
};

test('same account CAPTCHA is single-flight', async () => {
  const { CaptchaCoordinator } = await loadCoordinator();
  const coordinator = new CaptchaCoordinator({ maxConcurrent: 2 });
  const gate = deferred();
  const order = [];
  const first = coordinator.run('account-a', new AbortController().signal, async () => {
    order.push('first-enter');
    await gate.promise;
    order.push('first-exit');
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = coordinator.run('account-a', new AbortController().signal, async () => {
    order.push('second-enter');
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ['first-enter']);
  assert.equal(coordinator.snapshot().active, 1);
  assert.equal(coordinator.snapshot().waiting, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter']);
  assert.equal(coordinator.snapshot().active, 0);
});

test('different accounts can solve concurrently but global peak is capped at two', async () => {
  const { CaptchaCoordinator } = await loadCoordinator();
  const coordinator = new CaptchaCoordinator({ maxConcurrent: 2 });
  const gates = [deferred(), deferred(), deferred()];
  let active = 0;
  let peak = 0;
  const runs = ['a', 'b', 'c'].map((account, index) => coordinator.run(
    account,
    new AbortController().signal,
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gates[index].promise;
      active -= 1;
    },
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  assert.equal(coordinator.snapshot().waiting, 1);
  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(runs);
  assert.equal(peak, 2);
});

test('primary and backup providers run sequentially and circuit skips repeated failure', async () => {
  const { CaptchaCoordinator } = await loadCoordinator();
  const coordinator = new CaptchaCoordinator({
    maxConcurrent: 2,
    failureThreshold: 1,
    circuitCooldownMs: 60_000,
    primaryTimeoutMs: 1_000,
    fallbackTimeoutMs: 1_000,
  });
  const calls = [];
  const primary = {
    name: 'yescaptcha',
    configured: true,
    solve: async () => {
      calls.push('primary');
      const error = new Error('timeout');
      error.code = 'provider_timeout';
      throw error;
    },
    report: async () => {},
    health: async () => ({}),
  };
  const backup = {
    name: '2captcha',
    configured: true,
    solve: async () => {
      calls.push('backup');
      return {
        provider: '2captcha', taskId: `task-${calls.length}`, token: 'token',
        userAgent: 'UA', durationMs: 12, workerMode: 'proxyless',
      };
    },
    report: async () => {},
    health: async () => ({}),
  };
  const solve = (account) => coordinator.run(
    account,
    new AbortController().signal,
    (session) => session.solve(context, [primary, backup]),
  );

  assert.equal((await solve('account-a')).provider, '2captcha');
  assert.equal((await solve('account-b')).provider, '2captcha');
  assert.deepEqual(calls, ['primary', 'backup', 'backup']);
  assert.equal(coordinator.snapshot().providers.yescaptcha.circuit.state, 'open');
});

test('provider failures retain safe reason codes and expose the latest diagnostic', async () => {
  const { CaptchaCoordinator } = await loadCoordinator();
  let now = 10_000;
  const coordinator = new CaptchaCoordinator({
    failureThreshold: 1,
    circuitCooldownMs: 60_000,
    primaryTimeoutMs: 1_000,
    fallbackTimeoutMs: 1_000,
    now: () => now,
  });
  const failed = (name, code) => ({
    name,
    configured: true,
    solve: async () => {
      now += 125;
      const error = new Error(code);
      error.code = code;
      throw error;
    },
    report: async () => {},
    health: async () => ({}),
  });
  const primary = failed('yescaptcha', 'provider_timeout');
  const backup = failed('2captcha', 'ERROR_CAPTCHA_UNSOLVABLE');

  await assert.rejects(
    coordinator.run('account-a', new AbortController().signal, (session) => (
      session.solve(context, [primary, backup])
    )),
    (error) => {
      assert.deepEqual(error.providerCodes, [
        'yescaptcha:provider_timeout',
        '2captcha:ERROR_CAPTCHA_UNSOLVABLE',
      ]);
      return true;
    },
  );

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.providers.yescaptcha.solve.lastCode, 'provider_timeout');
  assert.equal(snapshot.providers.yescaptcha.solve.lastDurationMs, 125);
  assert.equal(snapshot.providers['2captcha'].solve.lastCode, 'ERROR_CAPTCHA_UNSOLVABLE');

  await assert.rejects(
    coordinator.run('account-b', new AbortController().signal, (session) => (
      session.solve(context, [primary, backup])
    )),
    (error) => {
      assert.deepEqual(error.providerCodes, [
        'yescaptcha:circuit_open',
        '2captcha:circuit_open',
      ]);
      return true;
    },
  );
});

test('Good and Bad reports are tied to the provider task that produced the proof', async () => {
  const { CaptchaCoordinator } = await loadCoordinator();
  const coordinator = new CaptchaCoordinator({ maxConcurrent: 1 });
  const reports = [];
  let sequence = 0;
  const provider = {
    name: 'yescaptcha', configured: true,
    solve: async () => ({
      provider: 'yescaptcha', taskId: `task-${++sequence}`, token: 'token',
      userAgent: 'UA', durationMs: 10, workerMode: 'proxyless',
    }),
    report: async (proof, verdict) => reports.push([proof.taskId, verdict]),
    health: async () => ({}),
  };
  await coordinator.run('account-a', new AbortController().signal, async (session) => {
    const proof = await session.solve(context, [provider]);
    await session.report(proof, 'good');
  });
  await coordinator.run('account-b', new AbortController().signal, async (session) => {
    const proof = await session.solve(context, [provider]);
    await session.report(proof, 'bad');
  });

  assert.deepEqual(reports, [['task-1', 'good'], ['task-2', 'bad']]);
  assert.deepEqual(coordinator.snapshot().providers.yescaptcha.suno, {
    accepted: 1, captchaRejected: 1, indeterminate: 0,
  });
});

test('aborted queued CAPTCHA is removed without entering the operation', async () => {
  const { CaptchaCoordinator } = await loadCoordinator();
  const coordinator = new CaptchaCoordinator({ maxConcurrent: 1 });
  const gate = deferred();
  const first = coordinator.run('account-a', new AbortController().signal, () => gate.promise);
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  let entered = false;
  const queued = coordinator.run('account-b', controller.signal, async () => { entered = true; });
  controller.abort(new Error('cancelled'));
  await assert.rejects(queued, /cancelled/);
  assert.equal(entered, false);
  assert.equal(coordinator.snapshot().waiting, 0);
  gate.resolve();
  await first;
});
