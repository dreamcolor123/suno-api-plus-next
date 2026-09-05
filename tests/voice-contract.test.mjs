import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/voice.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function('exports', 'module', 'require', compiled)(module.exports, module, require);

const {
  applyVoiceToPayload,
  assertPublicVoice,
  assertVoiceCanGenerate,
  normalizeVoice,
  normalizeVoiceId,
  voiceSelectionFromBody,
} = module.exports;

const VOICE_1 = '11111111-1111-4111-8111-111111111111';
const VOICE_2 = '22222222-2222-4222-8222-222222222222';

test('normalizes current Suno vox persona records for API callers', () => {
  const voice = normalizeVoice({
    id: VOICE_1,
    root_clip_id: 'clip-1',
    persona_type: 'vox',
  });
  assert.equal(voice.voice_id, VOICE_1);
  assert.equal(voice.voice_clip_id, 'clip-1');

  const recordedVoice = normalizeVoice({
    id: VOICE_2,
    root_clip_id: '00000000-0000-0000-0000-000000000000',
    vocal_clip_id: 'not-an-artist-clip',
    persona_type: 'vox',
  });
  assert.equal(recordedVoice.voice_id, VOICE_2);
  assert.equal(recordedVoice.voice_clip_id, undefined);
});

test('accepts voice_id and legacy voice_persona aliases', () => {
  assert.deepEqual(
    voiceSelectionFromBody({ voice_id: `https://suno.com/voice/${VOICE_1}` }),
    { id: VOICE_1 },
  );
  assert.deepEqual(
    voiceSelectionFromBody({ persona_id: VOICE_2, persona_model: 'voice_persona' }),
    { id: VOICE_2 },
  );
  assert.throws(
    () => voiceSelectionFromBody({ voice_id: VOICE_1, persona_id: VOICE_2 }),
    /must identify the same voice/,
  );
  assert.throws(
    () => voiceSelectionFromBody({ voice_id: VOICE_1, voice_clip_id: 'clip-1' }),
    /voice_clip_id is not accepted/,
  );
  assert.throws(
    () => voiceSelectionFromBody({ voice_clip_id: 'clip-1' }),
    /voice_clip_id is not accepted/,
  );
  assert.equal(normalizeVoiceId(`https://www.suno.com/voice/${VOICE_1}/`), VOICE_1);
});

test('accepts only public vox personas', () => {
  assert.doesNotThrow(() => assertPublicVoice({ id: VOICE_1, persona_type: 'vox', is_public: true }));
  assert.throws(
    () => assertPublicVoice({ id: VOICE_1, persona_type: 'vox', is_public: false }),
    /Only public Suno Voices/,
  );
  assert.throws(
    () => assertPublicVoice({ id: VOICE_1, persona_type: 'legacy', is_public: true }),
    /is not a Suno Voice/,
  );
});

test('builds current Suno vox and vox_cover payload contracts', () => {
  const generatePayload = { task: undefined, persona_model: 'voice_persona' };
  applyVoiceToPayload(generatePayload, { id: VOICE_1, clipId: 'clip-1' }, { cover: false });
  assert.deepEqual(generatePayload, {
    task: 'vox',
    persona_id: VOICE_1,
    artist_clip_id: 'clip-1',
    artist_start_s: null,
    artist_end_s: null,
    override_fields: ['prompt', 'tags'],
  });

  const coverPayload = { task: 'cover', cover_clip_id: 'source-1' };
  applyVoiceToPayload(coverPayload, { id: VOICE_1 }, { cover: true });
  assert.equal(coverPayload.task, 'vox_cover');
  assert.equal(coverPayload.cover_clip_id, 'source-1');
  assert.equal(coverPayload.persona_id, VOICE_1);
  assert.equal(coverPayload.artist_clip_id, null);
});

test('rejects Voice plus instrumental generation', () => {
  assert.throws(
    () => assertVoiceCanGenerate({ id: VOICE_1 }, true),
    /make_instrumental=true/,
  );
  assert.doesNotThrow(() => assertVoiceCanGenerate({ id: VOICE_1 }, false));
});
