import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);

async function loadHelper() {
  const filename = new URL('../src/lib/advanced-stems.ts', import.meta.url);
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

test('accepts the versioned Advanced Split catalogue and limits each request to four tracks', async () => {
  const helper = await loadHelper();
  assert.deepEqual(
    helper.normalizeAdvancedStemNames(['Lead Vocal', 'Drum Kit', 'Theremin', 'Didgeridoo', 'Lead Vocal']),
    ['Lead Vocal', 'Drum Kit', 'Theremin', 'Didgeridoo'],
  );
  assert.equal(helper.ADVANCED_STEM_NAMES.length, 98);
  assert.equal(helper.advancedStemLabel('Electronic Drum Kit'), '电子鼓组');
  assert.throws(() => helper.normalizeAdvancedStemNames(['Drums']), /supported Advanced Split/i);
  assert.throws(
    () => helper.normalizeAdvancedStemNames(['Lead Vocal', 'Drum Kit', 'Bass', 'Piano', 'Theremin']),
    /At most 4/,
  );
});

test('classifies Without outputs before positive vocal names', async () => {
  const helper = await loadHelper();
  assert.deepEqual(
    helper.classifyAdvancedStemTitle('(Without Lead Vocal)'),
    { stem_name: 'Lead Vocal', output_role: 'complement' },
  );
  assert.deepEqual(
    helper.classifyAdvancedStemTitle(' without_backing-vocals '),
    { stem_name: 'Backing Vocals', output_role: 'complement' },
  );
  assert.deepEqual(
    helper.classifyAdvancedStemTitle('(Lead Vocals)'),
    { stem_name: 'Lead Vocal', output_role: 'isolated' },
  );
  assert.deepEqual(
    helper.classifyAdvancedStemTitle('Example Song - Didgeridoo'),
    { stem_name: 'Didgeridoo', output_role: 'isolated' },
  );
  assert.deepEqual(
    helper.classifyAdvancedStemTitle('01 - Bass (Fixed Tempo).wav'),
    { stem_name: 'Bass', output_role: 'isolated' },
  );
  assert.deepEqual(
    helper.classifyAdvancedStemTitle('Track 2 - Piano (120 BPM).wav'),
    { stem_name: 'Piano', output_role: 'isolated' },
  );
});

test('accepts one to four arbitrary isolated tracks and rejects complements or duplicate instruments', async () => {
  const helper = await loadHelper();
  assert.deepEqual(
    helper.validateAdvancedStemRenderClips([
      { id: 'drums', title: 'Drum Kit', requested_stem: 'Drum Kit' },
      { id: 'bass', title: 'Bass', requested_stem: 'Bass' },
      { id: 'violin', title: 'Violin', requested_stem: 'Violin' },
      { id: 'theremin', title: 'Theremin', requested_stem: 'Theremin' },
    ]).map((clip) => clip.requested_stem),
    ['Drum Kit', 'Bass', 'Violin', 'Theremin'],
  );
  assert.equal(
    helper.validateAdvancedStemRenderClips([
      { id: 'piano', title: 'Piano', requested_stem: 'Piano' },
    ])[0].requested_stem,
    'Piano',
  );
  assert.deepEqual(
    helper.validateAdvancedStemRenderClips([
      {
        id: '',
        clipId: 'provider-bass',
        title: 'Original song title',
        requested_stem: 'Bass',
      },
    ]).map((clip) => [clip.id, clip.requested_stem, clip.output_role]),
    [['provider-bass', 'Bass', 'isolated']],
  );
  assert.throws(
    () => helper.validateAdvancedStemRenderClips([
      { id: 'without-lead', title: '(Without Lead Vocal)', requested_stem: 'Lead Vocal' },
      { id: 'backing', title: '(Backing Vocals)', requested_stem: 'Backing Vocals' },
    ]),
    (error) => error?.code === 'invalid_stem_selection',
  );
  assert.throws(
    () => helper.validateAdvancedStemRenderClips([
      { id: 'lead-a', title: '(Lead Vocal)', requested_stem: 'Lead Vocal' },
      { id: 'lead-b', title: '(Lead Vocal)', requested_stem: 'Lead Vocal' },
    ]),
    /one unique track per selected instrument/i,
  );
  assert.throws(
    () => helper.validateAdvancedStemRenderClips([
      { id: 'a', title: 'Lead Vocal', requested_stem: 'Lead Vocal' },
      { id: 'b', title: 'Drum Kit', requested_stem: 'Drum Kit' },
      { id: 'c', title: 'Bass', requested_stem: 'Bass' },
      { id: 'd', title: 'Piano', requested_stem: 'Piano' },
      { id: 'e', title: 'Theremin', requested_stem: 'Theremin' },
    ]),
    /between 1 and 4/,
  );
});

test('rounds fixed tempo to one beat per minute precision', async () => {
  const helper = await loadHelper();
  const downbeats = [[0, 1], [0.51, 2], [1.01, 3], [1.5, 4]];
  assert.equal(helper.fixedTempoBps(downbeats), 2);
  assert.deepEqual(
    helper.normalizeDownbeats({ data: [{ seconds: 0, beat: 1 }, { seconds: 0.5, beat: 2 }] }),
    [[0, 1], [0.5, 2]],
  );
});

test('builds object-valued wav_s16 Studio state with arbitrary selected instruments', async () => {
  const helper = await loadHelper();
  let index = 0;
  const payload = helper.buildFixedTempoRenderPayload({
    title: 'Example',
    durationSeconds: 12,
    downbeats: [[0, 1], [0.5, 2], [1, 3]],
    clips: [
      { id: 'drums-1', metadata: { stem_name: 'Drum Kit' } },
      { id: 'bass-1', metadata: { stem_name: 'Bass' } },
      { id: 'piano-1', metadata: { stem_name: 'Piano' } },
      { id: 'theremin-1', metadata: { stem_name: 'Theremin' } },
    ],
    idFactory: () => `id-${++index}`,
  });
  assert.equal(payload.format, 'wav_s16');
  assert.equal(typeof payload.state, 'object');
  const state = payload.state;
  assert.equal(state.timing.type, 'manual');
  assert.equal(state.timing.lockBPS, true);
  assert.deepEqual(state.tracks.map((track) => track.name), ['Drum Kit', 'Bass', 'Piano', 'Theremin']);
  assert.deepEqual(
    state.tracks.map((track) => track.clips[0].asset.id),
    ['drums-1', 'bass-1', 'piano-1', 'theremin-1'],
  );
});

test('API routes preserve affinity and use the discovered provider endpoints', async () => {
  const apiSource = await readFile(new URL('../src/lib/SunoApi.ts', import.meta.url), 'utf8');
  const routeSource = await readFile(new URL('../src/app/api/advanced_stems/route.ts', import.meta.url), 'utf8');
  const wavRoute = await readFile(new URL('../src/app/api/advanced_stems/wav/route.ts', import.meta.url), 'utf8');
  const renderRoute = await readFile(new URL('../src/app/api/advanced_stems/render/route.ts', import.meta.url), 'utf8');
  const downbeatsRoute = await readFile(new URL('../src/app/api/studio/clip/[clip_id]/downbeats/route.ts', import.meta.url), 'utf8');
  const saveRoute = await readFile(new URL('../src/app/api/studio/project/[project_id]/save/route.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /task: 'gen_stem'/);
  assert.match(apiSource, /mv: 'chirp-v3-5-b'/);
  assert.match(apiSource, /project_id: normalizedProjectId/);
  assert.match(apiSource, /stem_type_id: 91/);
  assert.match(apiSource, /prompt: ''/);
  assert.match(apiSource, /create_surface: 'studio'/);
  assert.match(apiSource, /generate\/v2-web/);
  assert.match(apiSource, /for \(let page = 0; page < pageLimit; page \+= 1\)/);
  assert.doesNotMatch(apiSource, /convert_wav/);
  assert.doesNotMatch(apiSource, /render-state-multitrack/);
  assert.match(routeSource, /runSunoRequestWithAffinity/);
  assert.match(routeSource, /withGenerationConcurrency/);
  assert.match(routeSource, /addAccountAffinity/);
  assert.match(routeSource, /Exactly one stem is required per request/);
  assert.match(wavRoute, /advanced_stems_legacy_download_disabled/);
  assert.match(renderRoute, /advanced_stems_legacy_download_disabled/);
  assert.match(downbeatsRoute, /api\.getDownbeats/);
  assert.match(saveRoute, /api\.saveStudioProject/);
  assert.match(saveRoute, /studioMutationUnknown/);
});
