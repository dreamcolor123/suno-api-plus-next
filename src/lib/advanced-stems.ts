import { createHash, randomUUID } from 'node:crypto';

/**
 * Suno's current Advanced Split picker.  The picker is searchable and Suno
 * does not publish a versioned JSON schema, so we keep the wire names here
 * and expose translated labels separately.  Unknown provider values are
 * retained for diagnostics, but are rejected as user input until reviewed.
 */
export const ADVANCED_STEM_NAMES = [
  'Lead Vocal',
  'Drum Kit',
  'Kick',
  'Snare',
  'Risers',
  'Bass',
  'Backing Vocals',
  'Piano',
  'Electric Guitar',
  'Percussion',
  'String Section',
  'Synth',
  'Acoustic Guitar',
  'Sound Effects',
  'Synth Pad',
  'Synth Bass',
  'Guitar',
  'Brass Section',
  'Organ',
  'Electronic Drum Kit',
  'Lead Electric Guitar',
  'Synth Keys',
  'Rhythm Electric Guitar',
  'Electric Piano',
  'Upright Bass',
  'Keyboards',
  'Distorted Electric Guitar',
  'Synth Strings',
  'Synth Lead',
  'Woodwinds',
  'Rhythm Acoustic Guitar',
  'Flute',
  'Harp',
  'Tambourine',
  'Trumpet',
  'Arpeggiator',
  'Accordion',
  'Fiddle',
  'Pedal Steel Guitar',
  'Synth Voice',
  'Violin',
  'Digital Piano',
  'Synth Brass',
  'Mandolin',
  'Choir',
  'Banjo',
  'Bells',
  'Clarinet',
  'Tenor Saxophone',
  'Trombone',
  'Shaker',
  'French Horn',
  'Glockenspiel',
  'Electric Bass',
  'Cello',
  'Timpani',
  'Harmonica',
  'Marimba',
  'Vibraphone',
  'Lap Steel Guitar',
  'Saxophone',
  'Orchestra',
  'Horns',
  'Cymbals',
  'Hand Clap',
  'Oboe',
  'Celesta',
  'Congas',
  'Drone',
  'Alto Saxophone',
  'Double Bass',
  'Ukulele',
  'Harpsichord',
  'Baritone Saxophone',
  'Xylophone',
  'Tuba',
  'Bass Guitar',
  'Whistle',
  'Lead Guitar',
  'Rhodes',
  '808',
  'Bongos',
  'Bassoon',
  'Cowbell',
  'Viola',
  'Sitar',
  'Steel Drums',
  'Piccolo',
  'Theremin',
  'Bagpipes',
  'Hi-Hat',
  'Music Box',
  'Melodica',
  'Tabla',
  'Koto',
  'Djembe',
  'Taiko',
  'Didgeridoo',
] as const;
export type AdvancedStemName = typeof ADVANCED_STEM_NAMES[number];
export const DEFAULT_ADVANCED_STEM_NAMES = ['Lead Vocal', 'Backing Vocals'] as const;
export const VOCAL_STEM_NAMES = DEFAULT_ADVANCED_STEM_NAMES;
export const ADVANCED_STEM_MAX_SELECTION = 4;

export type AdvancedStemCatalogItem = {
  readonly name: AdvancedStemName;
  readonly label: string;
  readonly category: string;
  readonly beta: boolean;
};

const CATALOG_LABELS: Record<AdvancedStemName, string> = {
  'Lead Vocal': '主唱',
  'Drum Kit': '鼓组',
  Kick: '底鼓',
  Snare: '军鼓',
  Risers: '上升音效',
  Bass: '贝斯',
  'Backing Vocals': '和声',
  Piano: '钢琴',
  'Electric Guitar': '电吉他',
  Percussion: '打击乐',
  'String Section': '弦乐组',
  Synth: '合成器',
  'Acoustic Guitar': '木吉他',
  'Sound Effects': '音效',
  'Synth Pad': '合成器铺底',
  'Synth Bass': '合成器贝斯',
  Guitar: '吉他',
  'Brass Section': '铜管组',
  Organ: '管风琴',
  'Electronic Drum Kit': '电子鼓组',
  'Lead Electric Guitar': '主音电吉他',
  'Synth Keys': '合成器键盘',
  'Rhythm Electric Guitar': '节奏电吉他',
  'Electric Piano': '电钢琴',
  'Upright Bass': '立式贝斯',
  Keyboards: '键盘',
  'Distorted Electric Guitar': '失真电吉他',
  'Synth Strings': '合成弦乐',
  'Synth Lead': '主音合成器',
  Woodwinds: '木管乐',
  'Rhythm Acoustic Guitar': '节奏木吉他',
  Flute: '长笛',
  Harp: '竖琴',
  Tambourine: '铃鼓',
  Trumpet: '小号',
  Arpeggiator: '琶音器',
  Accordion: '手风琴',
  Fiddle: '民谣提琴',
  'Pedal Steel Guitar': '踏板钢棒吉他',
  'Synth Voice': '合成器人声',
  Violin: '小提琴',
  'Digital Piano': '数码钢琴',
  'Synth Brass': '合成铜管',
  Mandolin: '曼陀林',
  Choir: '合唱',
  Banjo: '班卓琴',
  Bells: '铃',
  Clarinet: '单簧管',
  'Tenor Saxophone': '次中音萨克斯',
  Trombone: '长号',
  Shaker: '沙锤',
  'French Horn': '圆号',
  Glockenspiel: '钢片琴',
  'Electric Bass': '电贝斯',
  Cello: '大提琴',
  Timpani: '定音鼓',
  Harmonica: '口琴',
  Marimba: '马林巴',
  Vibraphone: '颤音琴',
  'Lap Steel Guitar': '莱普钢棒吉他',
  Saxophone: '萨克斯',
  Orchestra: '管弦乐',
  Horns: '铜管乐器',
  Cymbals: '镲片',
  'Hand Clap': '拍手',
  Oboe: '双簧管',
  Celesta: '钢片键琴',
  Congas: '康加鼓',
  Drone: '持续音',
  'Alto Saxophone': '中音萨克斯',
  'Double Bass': '低音提琴',
  Ukulele: '尤克里里',
  Harpsichord: '羽管键琴',
  'Baritone Saxophone': '上低音萨克斯',
  Xylophone: '木琴',
  Tuba: '大号',
  'Bass Guitar': '贝斯吉他',
  Whistle: '口哨',
  'Lead Guitar': '主音吉他',
  Rhodes: 'Rhodes 电钢琴',
  '808': '808 鼓/低音',
  Bongos: '邦戈鼓',
  Bassoon: '巴松管',
  Cowbell: '牛铃',
  Viola: '中提琴',
  Sitar: '西塔琴',
  'Steel Drums': '钢鼓',
  Piccolo: '短笛',
  Theremin: '特雷门琴',
  Bagpipes: '风笛',
  'Hi-Hat': '踩镲',
  'Music Box': '八音盒',
  Melodica: '口风琴',
  Tabla: '塔布拉鼓',
  Koto: '日本筝',
  Djembe: '非洲鼓',
  Taiko: '太鼓',
  Didgeridoo: '迪吉里杜管',
};

const CORE_STEM_NAMES = new Set<AdvancedStemName>([
  'Lead Vocal', 'Drum Kit', 'Bass', 'Backing Vocals', 'Piano',
  'Electric Guitar', 'Percussion', 'String Section', 'Synth',
  'Acoustic Guitar', 'Synth Bass', 'Guitar', 'Brass Section', 'Organ',
  'Lead Electric Guitar', 'Electric Piano', 'Keyboards',
]);

export const ADVANCED_STEM_CATALOG: readonly AdvancedStemCatalogItem[] =
  ADVANCED_STEM_NAMES.map((name) => ({
    name,
    label: CATALOG_LABELS[name],
    category: name.includes('Vocal') || name === 'Choir' || name === 'Whistle'
      ? '人声'
      : name.includes('Drum') || ['Kick', 'Snare', 'Timpani', 'Cymbals', 'Hi-Hat'].includes(name)
        ? '鼓组'
        : name.includes('Guitar') || ['Mandolin', 'Banjo', 'Ukulele', 'Sitar', 'Koto', 'Violin', 'Viola', 'Cello', 'Fiddle', 'Harp', 'Double Bass', 'String Section', 'Orchestra'].includes(name)
          ? '弦乐'
          : name.includes('Saxophone') || ['Flute', 'Clarinet', 'Trombone', 'Trumpet', 'French Horn', 'Oboe', 'Bassoon', 'Tuba', 'Piccolo', 'Bagpipes', 'Woodwinds', 'Harmonica', 'Didgeridoo'].includes(name)
            ? '木管'
            : name.includes('Piano') || ['Organ', 'Keyboards', 'Accordion', 'Glockenspiel', 'Celesta', 'Harpsichord', 'Melodica', 'Music Box'].includes(name)
              ? '键盘'
              : name.includes('Bass') || name === 'Bass' || name === '808'
                ? '低音'
                : name.includes('Synth') || name === 'Arpeggiator'
                  ? '合成器'
                  : ['Risers', 'Sound Effects', 'Drone', 'Theremin'].includes(name)
                    ? '效果'
                    : '打击乐',
    beta: !CORE_STEM_NAMES.has(name),
  }));

const STEM_NAME_SET = new Set<string>(ADVANCED_STEM_NAMES);
const STEM_NAME_ALIASES: Record<string, AdvancedStemName> = {
  'drum kit': 'Drum Kit',
  drumkit: 'Drum Kit',
  'drum-kit': 'Drum Kit',
  'drum kit ': 'Drum Kit',
  'electric drum kit': 'Electronic Drum Kit',
  'electronic drum kit': 'Electronic Drum Kit',
  'lead vocals': 'Lead Vocal',
  vocals: 'Lead Vocal',
  'backing vocal': 'Backing Vocals',
  'sound effect': 'Sound Effects',
  fx: 'Sound Effects',
};

function normalizedStemName(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[()[\]{}<>〈〉《》【】]/g, ' ')
    .replace(/[\u2010-\u2015_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalAdvancedStemName(value: unknown): AdvancedStemName | null {
  const raw = String(value || '').trim();
  if (STEM_NAME_SET.has(raw)) return raw as AdvancedStemName;
  const normalized = normalizedStemName(raw);
  const direct = ADVANCED_STEM_NAMES.find((name) => normalizedStemName(name) === normalized);
  if (direct) return direct;
  return STEM_NAME_ALIASES[normalized] || null;
}

export function advancedStemLabel(value: unknown): string {
  const canonical = canonicalAdvancedStemName(value);
  return canonical ? CATALOG_LABELS[canonical] : String(value || '').trim();
}
export type AdvancedStemOutputRole = 'isolated' | 'complement' | 'unknown';

export class AdvancedStemSelectionError extends Error {
  readonly status = 400;
  readonly code = 'invalid_stem_selection';

  constructor(message: string) {
    super(message);
    this.name = 'AdvancedStemSelectionError';
  }
}

export type AdvancedStemClip = {
  id: string;
  clip_id?: string;
  clipId?: string;
  asset?: { id?: string; clip_id?: string; clipId?: string };
  title?: string;
  provider_title?: string;
  requested_stem?: AdvancedStemName;
  output_role?: AdvancedStemOutputRole;
  selectable?: boolean;
  provider_index?: number;
  metadata?: Record<string, any>;
};

export type Downbeat = [number, number];

export type FixedTempoRenderInput = {
  title: string;
  durationSeconds: number;
  downbeats: Downbeat[];
  clips: AdvancedStemClip[];
  pathname?: string;
  idFactory?: () => string;
};

const TRACK_COLORS = ['#E45645', '#E4A345', '#45B5E4', '#45E496'];

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stripStemExportDecorations(value: unknown): string {
  let text = String(value || '')
    .normalize('NFKC')
    .replace(/\.(?:wav|mp3|flac|m4a|aac|ogg)$/iu, '')
    .replace(/\u00a0/gu, ' ')
    .trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text
      .replace(/\s*(?:[([{]\s*)?(?:fixed[\s_-]*tempo|tempo[\s_-]*locked|tempo[\s_-]*lock|time[\s_-]*locked|wav[_\s-]*s16|rendered)(?:\s*[\])}])?\s*$/iu, '')
      .replace(/\s*(?:[(\[]\s*)?\d+(?:\.\d+)?\s*bpm(?:\s*[)\]])?\s*$/iu, '')
      .replace(/\s+(?:v(?:ersion)?|take|rev(?:ision)?)\s*\d+\s*$/iu, '')
      .trim();
    if (text === before) break;
  }
  return text
    .replace(/^\s*(?:(?:track|stem|part|audio)\s*#?\s*\d+|\d{1,2})\s*(?:[-:|._)]\s*|\s+)/iu, '')
    .trim();
}

function normalizedTrackText(value: unknown): string {
  return stripStemExportDecorations(value)
    .toLocaleLowerCase()
    .replace(/[()[\]{}<>〈〉《》【】]/g, ' ')
    .replace(/[\u2010-\u2015_\-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Classify a Provider title with negative forms taking precedence. */
export function classifyAdvancedStemTitle(value: unknown): {
  stem_name: AdvancedStemName | null;
  output_role: AdvancedStemOutputRole;
} {
  const raw = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\.(?:wav|mp3|flac|m4a|aac|ogg)$/i, '')
    .trim();
  const prefixedTail = raw.match(/\s[-:|\u2010-\u2015]\s(.+)$/u)?.[1];
  const text = normalizedTrackText(value);
  if (!text) return { stem_name: null, output_role: 'unknown' };
  // Provider versions commonly add a numeric version suffix or a leading
  // ordinal.  Keep the match exact after removing those decorations so a
  // song title that merely mentions an instrument is not misclassified.
  const withoutDecorations = text;
  const withoutMatch = withoutDecorations.match(/^without\s+(.+)$/iu);
  if (withoutMatch) {
    const name = canonicalAdvancedStemName(withoutMatch[1]);
    if (name) return { stem_name: name, output_role: 'complement' };
  }
  const direct = canonicalAdvancedStemName(withoutDecorations);
  if (direct) return { stem_name: direct, output_role: 'isolated' };

  // Some feed responses prefix the stem with the source title (for example
  // ``My Song - Drum Kit``).  Only accept a known name at the end, preserving
  // the same negative-form precedence as the exact path above.
  if (prefixedTail) {
    const tail = normalizedTrackText(prefixedTail);
    const withoutTail = tail.match(/^without\s+(.+)$/u)?.[1];
    if (withoutTail) {
      const tailName = canonicalAdvancedStemName(withoutTail);
      if (tailName) return { stem_name: tailName, output_role: 'complement' };
    }
    const tailName = canonicalAdvancedStemName(tail);
    if (tailName) return { stem_name: tailName, output_role: 'isolated' };
  }
  return { stem_name: null, output_role: 'unknown' };
}

function explicitStemName(value: unknown): AdvancedStemName | null {
  return canonicalAdvancedStemName(value) || classifyAdvancedStemTitle(value).stem_name;
}

export function classifyAdvancedStemClip(
  clip: AdvancedStemClip,
  requestedStem?: AdvancedStemName,
  providerIndex = 0,
): AdvancedStemClip {
  const metadata = clip.metadata || {};
  const providerTitle = String(
    clip.provider_title || clip.title || metadata.provider_title || '',
  ).trim();
  const titleIdentity = classifyAdvancedStemTitle(providerTitle);
  const metadataIdentity = classifyAdvancedStemTitle(metadata.stem_name);
  const requested = requestedStem
    || explicitStemName(clip.requested_stem)
    || explicitStemName(metadata.requested_stem)
    || explicitStemName(metadata.requested_stem_name)
    || explicitStemName(metadata.stem_type_group_name)
    || explicitStemName(metadata.stem_name)
    || titleIdentity.stem_name
    || undefined;
  const explicitRole = String(
    clip.output_role || metadata.output_role || metadata.stem_output_role || '',
  ).trim() as AdvancedStemOutputRole;
  const roleIsValid = ['isolated', 'complement', 'unknown'].includes(explicitRole);
  let role: AdvancedStemOutputRole = roleIsValid ? explicitRole : titleIdentity.output_role;
  let stemName = requested || titleIdentity.stem_name || undefined;
  let identityConflict = false;
  if (titleIdentity.stem_name && requested && titleIdentity.stem_name !== requested) {
    role = 'unknown';
    identityConflict = true;
  }
  if (role !== 'unknown' && titleIdentity.output_role !== 'unknown' && role !== titleIdentity.output_role) {
    role = 'unknown';
    identityConflict = true;
  }
  if (role === 'unknown' && titleIdentity.output_role === 'unknown'
    && metadataIdentity.output_role !== 'unknown') {
    role = metadataIdentity.output_role;
  }
  if (metadataIdentity.stem_name && requested
    && metadataIdentity.stem_name !== requested
    && metadataIdentity.output_role !== 'unknown') {
    role = 'unknown';
    identityConflict = true;
  }
  // The immediate submission response is tied to the requested instrument,
  // but current Suno responses sometimes reuse the source-song title and omit
  // the stem role.  Treat that trusted request association as isolated unless
  // a title/metadata conflict or explicit ``unknown`` role was supplied.  A
  // ``Without ...`` complement was already classified above and still wins.
  if (role === 'unknown' && requested && explicitRole !== 'unknown' && !identityConflict) {
    role = 'isolated';
  }
  const clipId = String(
    clip.id
    || clip.clip_id
    || clip.clipId
    || clip.asset?.id
    || clip.asset?.clip_id
    || clip.asset?.clipId
    || '',
  ).trim();
  return {
    ...clip,
    id: clipId,
    title: providerTitle || stemName || '',
    provider_title: providerTitle,
    requested_stem: stemName,
    output_role: role,
    selectable: role === 'isolated',
    provider_index: Number.isInteger(clip.provider_index) ? clip.provider_index : providerIndex,
    metadata: { ...metadata },
  };
}

export function validateAdvancedStemRenderClips(value: unknown): AdvancedStemClip[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ADVANCED_STEM_MAX_SELECTION) {
    throw new AdvancedStemSelectionError(
      `Fixed-tempo render requires between 1 and ${ADVANCED_STEM_MAX_SELECTION} isolated tracks.`,
    );
  }
  const clips = value.map((item, index) => {
    const source = item && typeof item === 'object' ? item as AdvancedStemClip : { id: '' };
    const classified = classifyAdvancedStemClip(source, undefined, index);
    if (!classified.id || classified.output_role !== 'isolated' || !classified.requested_stem) {
      throw new AdvancedStemSelectionError(
        'Only completed isolated tracks from the supported Advanced Split catalogue may be rendered.',
      );
    }
    return classified;
  });
  const names = clips.map((clip) => clip.requested_stem);
  if (new Set(names).size !== names.length) {
    throw new AdvancedStemSelectionError(
      'Fixed-tempo render requires one unique track per selected instrument.',
    );
  }
  if (new Set(clips.map((clip) => clip.id)).size !== clips.length) {
    throw new AdvancedStemSelectionError('Stem clip ids must be unique.');
  }
  return clips;
}

export function normalizeAdvancedStemNames(value: unknown): AdvancedStemName[] {
  if (!Array.isArray(value)) throw new AdvancedStemSelectionError('stem_names must be an array.');
  const result: AdvancedStemName[] = [];
  for (const item of value) {
    const name = canonicalAdvancedStemName(item);
    if (!name) {
      throw new AdvancedStemSelectionError(
        `Only supported Advanced Split names may be selected (invalid: ${String(item || '').trim() || 'empty'}).`,
      );
    }
    if (!result.includes(name)) result.push(name);
  }
  if (!result.length) throw new AdvancedStemSelectionError('At least one stem name is required.');
  if (result.length > ADVANCED_STEM_MAX_SELECTION) {
    throw new AdvancedStemSelectionError(
      `At most ${ADVANCED_STEM_MAX_SELECTION} stem names may be selected at once.`,
    );
  }
  return result;
}

export function normalizeDownbeats(value: unknown): Downbeat[] {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? (
      (value as Record<string, unknown>).downbeats
      || (value as Record<string, unknown>).beats
      || (value as Record<string, unknown>).data
    )
    : value;
  if (!Array.isArray(source)) return [];
  const result: Downbeat[] = [];
  for (const item of source) {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined;
    const seconds = finiteNumber(
      Array.isArray(item) ? item[0] : record?.seconds ?? record?.time ?? record?.start_s,
      Number.NaN,
    );
    const beat = finiteNumber(
      Array.isArray(item) ? item[1] : record?.beat ?? record?.beat_index ?? record?.index,
      Number.NaN,
    );
    if (!Number.isFinite(seconds) || !Number.isFinite(beat) || seconds < 0) continue;
    result.push([Math.round(seconds * 10_000) / 10_000, Math.round(beat)]);
  }
  return result
    .sort((left, right) => left[0] - right[0])
    .filter((item, index, items) => index === 0 || item[0] !== items[index - 1][0]);
}

export function fixedTempoBps(downbeats: Downbeat[]): number {
  if (downbeats.length < 2) return 2;
  const elapsed = downbeats[downbeats.length - 1][0] - downbeats[0][0];
  if (!(elapsed > 0)) return 2;
  const raw = (downbeats.length - 1) / elapsed;
  return Math.max(1 / 60, Math.round(raw * 60) / 60);
}

function warpMarkers(downbeats: Downbeat[], durationSeconds: number, bps: number) {
  if (!downbeats.length) return { 0: 0, [durationSeconds]: durationSeconds * bps };
  const anchor = Math.max(downbeats.findIndex(([, beat]) => beat === 1), 0);
  const markers: Record<string, number> = {};
  downbeats.forEach(([seconds], index) => {
    markers[String(seconds)] = index - anchor;
  });
  return markers;
}

function beatAtSeconds(markers: Record<string, number>, seconds: number, fallbackBps: number): number {
  const points = Object.entries(markers)
    .map(([time, beats]) => [Number(time), Number(beats)] as const)
    .filter(([time, beats]) => Number.isFinite(time) && Number.isFinite(beats))
    .sort((left, right) => left[0] - right[0]);
  if (!points.length) return seconds * fallbackBps;
  if (points.length === 1) return points[0][1] + (seconds - points[0][0]) * fallbackBps;
  let left = points[0];
  let right = points[1];
  if (seconds >= points[points.length - 1][0]) {
    left = points[points.length - 2];
    right = points[points.length - 1];
  } else if (seconds > points[0][0]) {
    for (let index = 1; index < points.length; index += 1) {
      if (seconds <= points[index][0]) {
        left = points[index - 1];
        right = points[index];
        break;
      }
    }
  }
  const span = right[0] - left[0];
  const localBps = span > 0 ? (right[1] - left[1]) / span : fallbackBps;
  return left[1] + (seconds - left[0]) * localBps;
}

export function safeTrackName(clip: AdvancedStemClip, index: number): string {
  const classified = classifyAdvancedStemClip(clip, clip.requested_stem, index);
  if (classified.output_role !== 'isolated' || !classified.requested_stem) {
    throw new AdvancedStemSelectionError(
      'Complement or unknown Advanced split tracks cannot be rendered.',
    );
  }
  return classified.requested_stem;
}

function markerRegistryKey(markers: Record<string, number>): string {
  return createHash('sha256')
    .update(JSON.stringify(markers))
    .digest('hex');
}

/**
 * Build the historical server-render payload used by older Stems clients.
 * The active Runtime workflow no longer calls this helper: it saves the
 * Studio project, downloads each Clip as WAV, and creates the ZIP locally.
 */
export function buildFixedTempoRenderPayload(input: FixedTempoRenderInput) {
  const durationSeconds = finiteNumber(input.durationSeconds);
  if (!(durationSeconds > 0 && durationSeconds <= 60 * 60)) {
    throw new Error('A valid source duration is required.');
  }
  const clips = validateAdvancedStemRenderClips(input.clips);
  const idFactory = input.idFactory || randomUUID;
  const downbeats = normalizeDownbeats(input.downbeats);
  const bps = fixedTempoBps(downbeats);
  const markers = warpMarkers(downbeats, durationSeconds, bps);
  const markersHash = markerRegistryKey(markers);
  const startBeats = beatAtSeconds(markers, 0, bps);
  const endBeats = beatAtSeconds(markers, durationSeconds, bps);
  const tracks = clips.map((clip, index) => {
    const name = safeTrackName(clip, index);
    const trackId = idFactory();
    return {
      id: trackId,
      type: 'audio',
      name,
      color: TRACK_COLORS[index % TRACK_COLORS.length],
      amplitude: 1,
      balance: 0,
      mute: false,
      solo: false,
      clips: [{
        type: 'audio',
        streaming: false,
        id: idFactory(),
        asset: { type: 'clip', id: String(clip.id) },
        mute: false,
        reversed: false,
        name,
        color: TRACK_COLORS[index % TRACK_COLORS.length],
        startBeats,
        endBeats,
        readStartBeats: startBeats,
        fadeInBeats: 0,
        fadeOutBeats: 0,
        fadeInCurve: 1,
        fadeOutCurve: 1,
        transposition: 0,
        formantCorrection: 0,
        amplitude: 1,
        loop: { enabled: false, startBeats, endBeats },
        warp: { enabled: true, markersHash, awaitingAnalysis: false },
      }],
      takeLanes: [],
      takeLanesExpanded: false,
      signalChain: [],
    };
  });
  const state = {
    amplitude: 1,
    sections: {},
    lyricsCorrectionsByClipId: {},
    metronome: { enabled: false, amplitude: 1 },
    midiNotePreviewEnabled: true,
    timing: { type: 'manual', bps, bpsAutomation: [], lockBPS: true },
    timeSignatureChanges: [{ startBeats: 0, subdivisionsPerBar: 4, beatsPerSubdivision: 1 }],
    tracks,
    selection: {
      anchorBeats: 0,
      focusBeats: 0,
      trackIds: [],
      focusedTrackId: null,
      focusedTakeLaneId: null,
      focusedArea: null,
      arrangementAnchorBeats: null,
      arrangementFocusBeats: null,
      noteIds: [],
      pluginIds: [],
      warpMarkerSeconds: {},
      automationPointIndices: [],
      contextBeforeBeats: 32,
      contextAfterBeats: 32,
    },
    loop: { enabled: false, startBeats: 0, endBeats: 0 },
    songFadeInBeats: 0,
    songFadeOutBeats: 0,
    masterSignalChain: [],
    midiControllerSignalChain: [],
    masterRoutingMode: 'linear',
    routing: {},
    markersRegistry: { [markersHash]: markers },
  };
  const bpm = Math.round(bps * 60 * 100) / 100;
  const title = String(input.title || 'Suno Stems').trim().slice(0, 200) || 'Suno Stems';
  return {
    title: `${title} (${bpm}BPM)`,
    lyrics: '',
    tags: '',
    negative_tags: '',
    style_summary: '',
    caption: '',
    // Suno validates this field as a JSON dictionary. Serializing the object
    // produces an explicit 400 "State must be a dictionary" response.
    state,
    start_beats: startBeats,
    end_beats: endBeats,
    project_id: null,
    web_client_pathname: input.pathname || '/stems',
    downbeats,
    format: 'wav_s16',
    bpm,
  };
}
