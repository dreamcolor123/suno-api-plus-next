import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'app', 'docs', 'swagger-suno-api.json');
const publicCopy = path.join(root, 'public', 'swagger-suno-api.json');

const summaries = {
  '/api/advanced_stems': 'List or submit one Studio Advanced Split stem.',
  '/api/advanced_stems/wav': 'Legacy Advanced Split WAV download; permanently disabled.',
  '/api/advanced_stems/render': 'Legacy Advanced Split multitrack render; permanently disabled.',
  '/api/upload_audio/reconcile': 'Read-only reconciliation for a Studio Fast Upload operation.',
  '/api/clip/{clip_id}/download': 'Download a validated public or Studio clip.',
  '/api/clip/{clip_id}/metadata': 'Update authorized clip metadata.',
  '/api/studio/clip/{clip_id}/downbeats': 'Read Studio clip downbeat timing.',
  '/api/studio/clip/{clip_id}/download': 'Download a Studio clip as WAV.',
  '/api/studio/clips/{clip_id}/projects': 'List Studio projects associated with a clip.',
  '/api/studio/create-or-load-project-for-clip/{clip_id}': 'Create or load a Studio project for a clip.',
  '/api/studio/project/{project_id}': 'Read a Studio project.',
  '/api/studio/project/{project_id}/save': 'Save a Studio project state.',
  '/api/studio/project/{project_id}/trash': 'Archive a temporary Studio project.',
  '/api/admin/captcha/probe': 'Probe configured CAPTCHA providers.',
  '/api/admin/accounts/refresh': 'Refresh account-pool status.',
  '/api/admin/accounts/verify': 'Verify an account-pool entry.',
};

const ignored = new Set(['page.tsx', 'layout.tsx', 'loading.tsx', 'error.tsx', 'route.js']);

async function routeFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'components') continue;
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await routeFiles(absolute, relative));
    else if (entry.name === 'route.ts' || entry.name === 'route.tsx') out.push({ relative, absolute });
  }
  return out;
}

function openapiPath(relative) {
  const without = relative.replace(/[/\\]route\.(?:tsx?|jsx?)$/, '');
  return '/' + without
    .split(/[\\/]/)
    .filter(Boolean)
    .map((part) => part.startsWith('[') && part.endsWith(']') ? `{${part.slice(1, -1)}}` : part)
    .join('/');
}

function operation(method, apiPath, relative) {
  const summary = summaries[apiPath] || `Handle ${method} ${apiPath}.`;
  const disabled = apiPath === '/api/advanced_stems/wav' || apiPath === '/api/advanced_stems/render';
  const unsupported = apiPath === '/v1/images/generations' || apiPath === '/v1/videos';
  const status = disabled ? '410' : unsupported ? '501' : '200';
  return {
    summary,
    description: `Implemented by ${relative.replaceAll('\\', '/')}. Credentials and account affinity are runtime values; never commit them.`,
    operationId: `${method.toLowerCase()}_${apiPath.replaceAll(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
    responses: {
      [status]: { description: disabled ? 'Legacy route disabled.' : unsupported ? 'Capability is not implemented.' : 'Successful response.' },
      '400': { description: 'Invalid request.' },
      '401': { description: 'Authentication or API key required.' },
      '409': { description: 'Conflict, active operation, or submission is unknown.' },
      '429': { description: 'Concurrency limit exceeded.' },
      '503': { description: 'Provider or local runtime unavailable.' },
    },
  };
}

const spec = JSON.parse(await readFile(source, 'utf8'));
spec.openapi = spec.openapi || '3.0.0';
spec.info = {
  ...(spec.info || {}),
  title: 'Suno API Plus Next',
  version: '2.0.0',
  description: 'Unofficial self-hosted Suno API gateway with account affinity, Studio workflows, Advanced Split, Fast Upload and OpenAI-compatible routes.',
};
spec.externalDocs = { description: 'Project documentation', url: 'https://github.com/dreamcolor123/suno-api-plus-next' };
spec.paths ||= {};

for (const family of ['api', 'v1']) {
  const files = await routeFiles(path.join(root, 'src', 'app', family), family);
  for (const file of files) {
    const text = await readFile(file.absolute, 'utf8');
    const apiPath = openapiPath(file.relative);
    spec.paths[apiPath] ||= {};
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(text)) {
        spec.paths[apiPath][method.toLowerCase()] ||= operation(method, apiPath, path.join('src', 'app', file.relative));
      }
    }
  }
}

const serialized = JSON.stringify(spec, null, 2) + '\n';
await writeFile(source, serialized, 'utf8');
await writeFile(publicCopy, serialized, 'utf8');
console.log(`Synchronized ${Object.keys(spec.paths).length} OpenAPI paths.`);
