export type VoiceSelection = {
  id: string;
  clipId?: string;
};

export type SunoVoice = Record<string, any> & {
  id: string;
  voice_id: string;
  voice_clip_id?: string;
  name?: string;
  persona_type?: string;
  is_vox_persona?: boolean;
  root_clip_id?: string;
};

export class VoiceRequestError extends Error {
  readonly code = 'invalid_voice_selection';
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'VoiceRequestError';
  }
}

const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';
const VOICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function optionalVoiceClipId(value: unknown): string | undefined {
  const normalized = optionalString(value);
  if (!normalized || normalized.toLowerCase() === EMPTY_UUID) return undefined;
  return normalized;
}

export function normalizeVoiceId(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  let candidate = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new VoiceRequestError('voice_id must be a Suno public Voice id or URL.');
    }
    if (!['suno.com', 'www.suno.com'].includes(url.hostname.toLowerCase())) {
      throw new VoiceRequestError('voice_id URL must use the suno.com host.');
    }
    const match = url.pathname.match(/^\/voice\/([^/]+)\/?$/i);
    if (!match) throw new VoiceRequestError('voice_id URL must use https://suno.com/voice/<id>.');
    candidate = match[1];
  }
  if (!VOICE_ID.test(candidate)) {
    throw new VoiceRequestError('voice_id must be a valid Suno Voice UUID or public Voice URL.');
  }
  return candidate.toLowerCase();
}

export function isVoxPersona(value: Record<string, any>): boolean {
  return value.persona_type === 'vox' || value.is_vox_persona === true;
}

export function assertPublicVoice(value: Record<string, any>): void {
  if (!isVoxPersona(value)) {
    throw new VoiceRequestError(`Persona ${String(value.id || '')} is not a Suno Voice.`);
  }
  if (value.is_public !== true) {
    throw new VoiceRequestError('Only public Suno Voices are supported.');
  }
}

export function normalizeVoice(value: Record<string, any>): SunoVoice {
  const id = normalizeVoiceId(value.id);
  if (!id) throw new VoiceRequestError('Suno returned a voice without an id.');
  // Current Suno `vox` generation uses artist_clip_id only when the persona has
  // a real root clip. Voice recordings and some public Voices expose an empty
  // root UUID plus vocal_clip_id/persona_clips for other UI modes; those are
  // not artist_clip_id substitutes in Advanced generation.
  const clipId = optionalVoiceClipId(value.root_clip_id)
    || optionalVoiceClipId(value.clip?.id);
  return {
    ...value,
    id,
    voice_id: id,
    ...(clipId ? { root_clip_id: optionalVoiceClipId(value.root_clip_id) || clipId, voice_clip_id: clipId } : {}),
  };
}

export function voiceSelectionFromBody(
  body: Record<string, any>,
  options: { allowPersonaAlias?: boolean } = {},
): VoiceSelection | undefined {
  const voiceId = normalizeVoiceId(body.voice_id);
  const personaId = normalizeVoiceId(body.persona_id);
  const personaModel = optionalString(body.persona_model)?.toLowerCase();
  const allowPersonaAlias = options.allowPersonaAlias || personaModel === 'voice_persona';

  if (voiceId && personaId && voiceId !== personaId) {
    throw new VoiceRequestError('voice_id and persona_id must identify the same voice when both are supplied.');
  }

  const suppliedClipId = optionalVoiceClipId(body.voice_clip_id)
    || optionalVoiceClipId(body.artist_clip_id)
    || optionalVoiceClipId(body.root_clip_id);
  if (suppliedClipId) {
    throw new VoiceRequestError('voice_clip_id is not accepted; the API resolves public Voice data by voice_id.');
  }
  const id = voiceId || (allowPersonaAlias ? personaId : undefined);
  if (!id) return undefined;
  return { id };
}

export function assertVoiceCanGenerate(
  voice: VoiceSelection | undefined,
  makeInstrumental: boolean,
): void {
  if (voice && makeInstrumental) {
    throw new VoiceRequestError('voice_id cannot be combined with make_instrumental=true.');
  }
}

export function applyVoiceToPayload(
  payload: Record<string, any>,
  voice: VoiceSelection,
  options: { cover: boolean },
): void {
  payload.task = options.cover ? 'vox_cover' : 'vox';
  payload.persona_id = voice.id;
  payload.artist_clip_id = voice.clipId || null;
  payload.artist_start_s = null;
  payload.artist_end_s = null;
  payload.override_fields = ['prompt', 'tags'];
  delete payload.persona_model;
}
