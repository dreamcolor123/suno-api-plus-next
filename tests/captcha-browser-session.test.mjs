import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function loadModule() {
  const filename = path.join(root, 'src', 'lib', 'captcha-browser-session.ts');
  const source = await readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', '__filename', '__dirname', compiled)(
    module.exports, module, require, filename, path.dirname(filename),
  );
  return module.exports;
}

test('browser cookie jar replaces every Clerk session namespace and rejects invalid values', async () => {
  const session = await loadModule();
  const cookies = session.buildSunoBrowserCookies({
    __client: 'client-cookie',
    __session: 'expired-base',
    '__session_Jnxw-muT': 'expired-scoped',
    OptanonConsent: 'groups=1;landingPath=old',
    normal: 'kept',
  }, 'fresh-jwt');
  const byName = Object.fromEntries(cookies.map((item) => [item.name, item]));

  assert.equal(byName.__session.value, 'fresh-jwt');
  assert.equal(byName['__session_Jnxw-muT'].value, 'fresh-jwt');
  assert.equal(byName.__client.value, 'client-cookie');
  assert.equal(byName.normal.value, 'kept');
  assert.equal(byName.OptanonConsent, undefined);
  assert.equal(cookies.filter((item) => item.name === '__session').length, 1);
  assert.ok(cookies.every((item) => item.domain === '.suno.com' && item.sameSite === 'Lax'));
});

test('browser UA is pinned to the packaged Chromium major version', async () => {
  const session = await loadModule();
  assert.match(session.SUNO_CAPTCHA_BROWSER_USER_AGENT, /Windows NT 10\.0/);
  assert.match(session.SUNO_CAPTCHA_BROWSER_USER_AGENT, /Chrome\/131\.0\.0\.0/);
});
