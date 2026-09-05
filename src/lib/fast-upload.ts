import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountTier, AccountView } from '@/lib/account-pool';
import { createAccountAffinity } from '@/lib/account-affinity';
import {
  withSunoAccountAffinity,
  withSunoAccountExclusive,
  type SunoApi,
} from '@/lib/SunoApi';
import { fastUploadFingerprint, idempotencyStorageId } from '@/lib/fast-upload-policy';

export type FastUploadMetadata = {
  title: string;
  prompt?: string;
  imageUrl?: string;
  /**
   * Song Cover uses the portable upload as a source clip and fills in its
   * Song Details after lyric conversion.  When set, do not send the prompt as
   * placeholder lyrics during the upload; title/image metadata may still be
   * applied immediately.
   */
  deferMetadata?: boolean;
};

export type StudioFastUploadResult = {
  upload_method: 'studio_fast';
  upload_id: string;
  upload_id_kind: 'studio_project';
  studio_project_id: string;
  clip_id: string;
  song_url: string;
  duration_seconds: number;
  portable_clip: true;
  account_affinity: string;
  title: string;
  image_url?: string;
  has_vocal?: boolean;
  status: string;
  inferred_description?: string;
  copyright_muted?: boolean;
  metadata_warning?: string;
  metadata_deferred?: boolean;
};

/**
 * A read-only view of a locally persisted fast-upload operation.  This is
 * deliberately smaller than FastUploadJob so the reconciliation endpoint
 * cannot accidentally expose worker logs, tokens, or upload evidence.
 */
export type StudioFastUploadReconciliation = {
  status: FastUploadJobState | 'not_found';
  studio_project_id?: string;
  result?: StudioFastUploadResult;
  retry_after_seconds?: number;
};

type SubmissionState = 'not_submitted' | 'submission_unknown';

export class FastUploadError extends Error {
  readonly status: number;
  readonly code: string;
  readonly submissionState: SubmissionState;
  readonly retryAfterSeconds?: number;
  readonly studioProjectId?: string;
  readonly recordAccountFailure = false;

  constructor(input: {
    message: string;
    code: string;
    status: number;
    submissionState: SubmissionState;
    retryAfterSeconds?: number;
    studioProjectId?: string;
  }) {
    super(input.message);
    this.name = 'FastUploadError';
    this.code = input.code;
    this.status = input.status;
    this.submissionState = input.submissionState;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.studioProjectId = input.studioProjectId;
  }
}

type FastUploadJobState =
  | 'running'
  | 'complete'
  | 'not_submitted'
  | 'submission_unknown';

type FastUploadJob = {
  version: 1;
  storage_id: string;
  fingerprint: string;
  state: FastUploadJobState;
  job_id: string;
  created_at: string;
  updated_at: string;
  owner_pid: number;
  /** Account and task prefix are written before the worker crosses upload. */
  account_id?: string;
  tier?: AccountTier;
  task_prefix?: string;
  studio_project_id?: string;
  song_url?: string;
  result?: StudioFastUploadResult;
  error?: { code: string; message: string };
  evidence?: Record<string, unknown>;
};

type RuntimePaths = {
  python: string;
  worker: string;
  coreDir: string;
  ffmpeg: string;
};

type WorkerOutcome = {
  exitCode: number;
  projectId?: string;
  songUrl?: string;
  finalEvent?: Record<string, any>;
  cancelled?: 'request_aborted' | 'timeout';
  logTail: string;
};

type GlobalFastUploadState = { active: number };
const globalWithFastUpload = global as typeof globalThis & {
  __sunoFastUploadState?: GlobalFastUploadState;
};

function globalState(): GlobalFastUploadState {
  if (!globalWithFastUpload.__sunoFastUploadState) {
    globalWithFastUpload.__sunoFastUploadState = { active: 0 };
  }
  return globalWithFastUpload.__sunoFastUploadState;
}

function nowIso(): string {
  return new Date().toISOString();
}

function fastUploadRoot(): string {
  if (process.env.SUNO_FAST_UPLOAD_DATA_DIR) {
    return path.resolve(process.env.SUNO_FAST_UPLOAD_DATA_DIR);
  }
  const accounts = path.resolve(
    process.env.ACCOUNT_DATA_PATH || path.join(process.cwd(), 'data', 'accounts.json'),
  );
  return path.join(path.dirname(accounts), 'fast-upload');
}

function timeoutSeconds(): number {
  return Math.max(60, Number(process.env.SUNO_FAST_UPLOAD_TIMEOUT_SEC) || 1800);
}

function fastConcurrency(): number {
  return Math.max(1, Math.min(8, Number(process.env.SUNO_FAST_UPLOAD_MAX_CONCURRENT) || 4));
}

function segmentConcurrency(): number {
  // The bundled Studio uploader writes several multipart segments through the
  // same proxy connection.  A second concurrent write can starve the first
  // one and surface as ``The write operation timed out`` after a project has
  // already been created.  Serial is the reliable default; installations that
  // have a demonstrably stable egress can opt back into 2..8 explicitly.
  return Math.max(1, Math.min(8, Number(process.env.SUNO_FAST_UPLOAD_SEGMENT_CONCURRENCY) || 1));
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown error');
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 800);
}

async function pathIsFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function pathIsDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function findOnPath(executable: string): Promise<string | undefined> {
  const suffixes = process.platform === 'win32' ? ['', '.exe'] : [''];
  for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
    if (!folder) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(folder.replace(/^"|"$/g, ''), executable + suffix);
      if (await pathIsFile(candidate)) return candidate;
    }
  }
  return undefined;
}

async function resolveRuntimePaths(): Promise<RuntimePaths> {
  const sourceWorker = path.join(process.cwd(), 'python', 'fast_upload_worker.py');
  const componentRoot = path.resolve(
    process.env.SUNO_FAST_UPLOAD_RUNTIME_DIR || path.join(process.cwd(), 'runtime', 'tools', 'suno-fast-upload'),
  );
  const configuredPython = String(process.env.SUNO_FAST_UPLOAD_PYTHON || '').trim();
  const python = configuredPython
    ? path.resolve(configuredPython)
    : ((await findOnPath(process.platform === 'win32' ? 'python' : 'python3'))
      || (await findOnPath('python')) || 'python');
  const bundledWorker = path.join(componentRoot, 'worker', 'fast_upload_worker.py');
  const worker = path.resolve(
    process.env.SUNO_FAST_UPLOAD_WORKER
      || ((await pathIsFile(bundledWorker)) ? bundledWorker : sourceWorker),
  );
  const configuredCore = path.resolve(
    process.env.SUNO_FAST_UPLOAD_CORE || path.join(process.cwd(), 'python'),
  );
  const coreDir = configuredCore;
  const coreModule = path.extname(configuredCore).toLowerCase() === '.py'
    ? configuredCore
    : path.join(configuredCore, 'suno_studio_tool.py');
  const configuredFfmpeg = String(process.env.SUNO_STUDIO_FFMPEG_EXE || '').trim();
  const ffmpeg = configuredFfmpeg
    ? path.resolve(configuredFfmpeg)
    : (await findOnPath('ffmpeg')) || '';

  const missing: string[] = [];
  if (!(await pathIsFile(python)) && python !== 'python') missing.push('Python 3.11+');
  if (!(await pathIsFile(worker))) missing.push('fast upload worker');
  if (!(await pathIsFile(coreModule))) {
    missing.push('public suno_studio_tool.py');
  }
  if (!ffmpeg || !(await pathIsFile(ffmpeg))) missing.push('FFmpeg');
  if (missing.length) {
    throw new FastUploadError({
      message: `Studio fast upload runtime is incomplete: ${missing.join(', ')}.`,
      code: 'fast_upload_runtime_unavailable',
      status: 503,
      submissionState: 'not_submitted',
      retryAfterSeconds: 30,
    });
  }
  return { python, worker, coreDir, ffmpeg };
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readJob(file: string): Promise<FastUploadJob | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as FastUploadJob;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function jobFileForIdempotencyKey(idempotencyKey: string): string {
  const root = fastUploadRoot();
  return path.join(root, 'jobs', `${idempotencyStorageId(idempotencyKey)}.json`);
}

const CLIP_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SONG_URL_RE = /https:\/\/suno\.com\/song\/([a-f0-9-]{36})(?:[/?#]|$)/i;

function recordValue(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function stringField(value: Record<string, any>, keys: string[]): string {
  for (const key of keys) {
    const candidate = String(value[key] ?? '').trim();
    if (candidate) return candidate;
  }
  return '';
}

function clipIdFromValue(value: unknown, options: { allowGenericId?: boolean } = {}): string {
  const row = recordValue(value);
  if (!row) return '';
  const direct = stringField(row, [
    'clip_id', 'clipId', 'clipID', 'song_id', 'songId', 'songID',
  ]);
  if (CLIP_ID_RE.test(direct)) return direct;
  const url = stringField(row, ['song_url', 'songUrl', 'clip_url', 'clipUrl', 'url']);
  const match = SONG_URL_RE.exec(url);
  if (match?.[1]) return match[1];
  // A generic ``id`` is intentionally not accepted by default.  Studio
  // project summaries, account records and Feed envelopes all contain UUIDs
  // that are not Clip ids; treating one as a rendered song can incorrectly
  // complete an otherwise unknown upload.  Callers that have already proved
  // the record is a Clip may opt in explicitly.
  if (options.allowGenericId) {
    const id = stringField(row, ['id']);
    return CLIP_ID_RE.test(id) ? id : '';
  }
  return '';
}

function songUrlFromValue(value: unknown): string {
  const row = recordValue(value);
  if (!row) return '';
  const direct = stringField(row, [
    'song_url', 'songUrl', 'songURL', 'clip_url', 'clipUrl', 'public_url', 'publicUrl',
  ]);
  if (SONG_URL_RE.test(direct)) return direct.match(SONG_URL_RE)![0];
  const rowType = stringField(row, ['type', 'kind', 'object_type', 'objectType']).toLowerCase();
  const clipShaped = /^(clip|song|audio|generation|output)$/.test(rowType)
    || Boolean(stringField(row, ['audio_url', 'audioUrl', 'video_url', 'videoUrl']));
  const id = clipIdFromValue(row, { allowGenericId: clipShaped });
  return id ? `https://suno.com/song/${id}` : '';
}

function uploadedRowClipIds(job: FastUploadJob): string[] {
  const rows = job.evidence?.uploaded_rows;
  if (!Array.isArray(rows)) return [];
  return Array.from(new Set(
    rows.map((row) => clipIdFromValue(row)).filter(Boolean),
  ));
}

function taskPrefixFromJob(job: FastUploadJob): string {
  if (job.task_prefix) return String(job.task_prefix);
  const evidencePrefix = String(job.evidence?.task_prefix || '').trim();
  if (evidencePrefix) return evidencePrefix;
  const log = String(job.evidence?.log_tail || '');
  const match = /["']?taskPrefix["']?\s*[:=]\s*["'](__sfp_[a-f0-9-]{36}_)\b/i.exec(log);
  return match?.[1] || '';
}

function providerRecords(value: unknown, limit = 500): Record<string, any>[] {
  const records: Record<string, any>[] = [];
  const seen = new Set<any>();
  const visit = (item: unknown, depth: number) => {
    if (records.length >= limit || depth > 8 || item === null || item === undefined) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    const row = recordValue(item);
    if (!row || seen.has(row)) return;
    seen.add(row);
    records.push(row);
    for (const child of Object.values(row)) {
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return records;
}

function isNotFoundError(error: any): boolean {
  return Number(error?.response?.status || error?.status || 0) === 404;
}

function safeReconciliationEvidence(input: {
  projectFound: boolean;
  feedQueried: boolean;
  knownClipCount: number;
  candidateCount: number;
  observedAt: string;
  errorCode?: string;
}): Record<string, unknown> {
  return {
    reconciliation: {
      project_found: input.projectFound,
      feed_queried: input.feedQueried,
      known_clip_count: input.knownClipCount,
      candidate_count: input.candidateCount,
      ...(input.errorCode ? { error_code: input.errorCode } : {}),
      observed_at: input.observedAt,
    },
  };
}

async function reconcileWithAccount<T>(
  job: FastUploadJob,
  operation: (api: SunoApi, account: AccountView | null) => Promise<T>,
): Promise<T> {
  const tier: AccountTier = job.tier === 'super' || job.tier === 'heavy' ? job.tier : 'basic';
  const accountId = String(job.account_id || '').trim();
  if (!accountId) {
    // A fast-upload project and its rendered Clip are account-private.  A
    // legacy job without the owner id cannot be safely reconciled by leasing a
    // random pool account; doing so can inspect another user's project and
    // would make a later Cover/download cross-account.  Keep the unknown
    // fence intact and require an operator to restore the owning account.
    throw new FastUploadError({
      message: 'The fast-upload owner account is missing; reconciliation is blocked to prevent cross-account access.',
      code: 'fast_upload_account_affinity_missing',
      status: 409,
      submissionState: 'submission_unknown',
      studioProjectId: String(job.studio_project_id || '').trim() || undefined,
    });
  }
  return withSunoAccountAffinity(
    tier,
    accountId,
    operation as (api: SunoApi, account: AccountView) => Promise<T>,
  );
}

function candidateFromProvider(
  value: Record<string, any>,
  projectId: string,
  knownIds: Set<string>,
  taskPrefix: string,
  options: { requireScope?: boolean; scopeTitle?: string } = {},
): Record<string, any> | null {
  const rowType = stringField(value, ['type', 'kind', 'object_type', 'objectType']).toLowerCase();
  const explicitClip = Boolean(
    stringField(value, [
      'clip_id', 'clipId', 'clipID', 'song_id', 'songId', 'songID',
      'song_url', 'songUrl', 'songURL', 'clip_url', 'clipUrl', 'public_url', 'publicUrl',
      'url', 'audio_url', 'audioUrl', 'video_url', 'videoUrl',
    ])
  );
  const clipShaped = /^(clip|song|audio|generation|output)$/.test(rowType)
    || Boolean(stringField(value, ['audio_url', 'audioUrl', 'video_url', 'videoUrl']));
  const clipId = clipIdFromValue(value, {
    // Generic ids are accepted only for records whose shape explicitly says
    // they are clips/songs.  Never infer that from a project summary.
    allowGenericId: clipShaped,
  });
  if (!clipId || clipId === projectId || knownIds.has(clipId)) return null;
  if (!explicitClip && !clipShaped) return null;
  const name = stringField(value, ['title', 'name', 'displayName', 'filename', 'file_name']);
  // Segment names are task-scoped and must never be promoted to the portable
  // source result.  A final rendered clip may share the title, but it will not
  // carry the private task prefix.
  if (taskPrefix && name.includes(taskPrefix)) return null;
  if (options.requireScope) {
    const serialized = JSON.stringify(value).toLowerCase();
    const associated = Boolean(
      serialized.includes(projectId.toLowerCase())
      || (taskPrefix && serialized.includes(taskPrefix.toLowerCase()))
    );
    if (!associated) return null;
  }
  const status = stringField(value, ['status', 'state']).toLowerCase();
  if (['failed', 'error', 'rejected', 'deleted', 'trashed'].includes(status)) return null;
  const songUrl = songUrlFromValue(value);
  if (!songUrl) return null;
  return {
    ...value,
    clip_id: clipId,
    song_url: songUrl,
    title: name || 'Uploaded song',
  };
}

function findReconciledCandidate(
  project: unknown,
  feed: unknown,
  projectId: string,
  knownIds: string[],
  taskPrefix: string,
): Record<string, any> | null {
  const known = new Set(knownIds);
  const all = [...providerRecords(project), ...providerRecords(feed)];
  // Prefer explicit project output fields and non-segment records from the
  // project before considering a broad Feed page.
  const projectRecords = providerRecords(project);
  const feedRecords = providerRecords(feed);
  const projectTitle = projectRecords
    .map((row) => stringField(row, ['title', 'name', 'project_title', 'projectTitle']))
    .find(Boolean) || '';
  for (const row of projectRecords) {
    const candidate = candidateFromProvider(row, projectId, known, taskPrefix);
    if (candidate) return candidate;
  }
  for (const row of [...feedRecords, ...all]) {
    const candidate = candidateFromProvider(row, projectId, known, taskPrefix, {
      requireScope: true,
      scopeTitle: projectTitle,
    });
    if (candidate) return candidate;
  }
  return null;
}

// Deliberately narrow test surface for the pure reconciliation classifier.
// It performs no network or filesystem work and is not exposed by any route.
export const __fastUploadReconciliationTestOnly = {
  findReconciledCandidate,
};

function buildReconciledResult(
  candidate: Record<string, any>,
  job: FastUploadJob,
  projectId: string,
  accountId: string,
): StudioFastUploadResult {
  const duration = Number(
    candidate.duration_seconds
      ?? candidate.durationSeconds
      ?? candidate.duration
      ?? job.evidence?.duration_seconds
      ?? 0,
  );
  const metadata = recordValue(candidate.metadata) || {};
  return {
    upload_method: 'studio_fast',
    upload_id: projectId,
    upload_id_kind: 'studio_project',
    studio_project_id: projectId,
    clip_id: String(candidate.clip_id),
    song_url: String(candidate.song_url),
    duration_seconds: Number.isFinite(duration) ? duration : 0,
    portable_clip: true,
    account_affinity: accountId ? createAccountAffinity(accountId) : '',
    title: String(candidate.title || candidate.name || 'Uploaded song'),
    image_url: String(candidate.image_url || candidate.imageUrl || '').trim() || undefined,
    has_vocal: typeof candidate.has_vocal === 'boolean' ? candidate.has_vocal : metadata.has_vocal,
    status: String(candidate.status || 'complete'),
    inferred_description: String(
      candidate.inferred_description || metadata.inferred_description || '',
    ).trim() || undefined,
    copyright_muted: typeof candidate.copyright_muted === 'boolean'
      ? candidate.copyright_muted
      : metadata.copyright_muted,
  };
}

/**
 * Inspect a fast-upload operation without replaying it.
 *
 * A project id alone is never treated as a successful upload: callers must
 * receive a concrete Clip/Song URL before they can continue.  This preserves
 * the submission-unknown fence while allowing a completed operation to be
 * recovered after a Runtime restart.
 */
export async function reconcileStudioFastUpload(
  idempotencyKey: string,
): Promise<StudioFastUploadReconciliation> {
  const key = String(idempotencyKey || '').trim();
  if (!key || key.length > 512) {
    throw new FastUploadError({
      message: 'Idempotency-Key must be between 1 and 512 characters.',
      code: 'invalid_idempotency_key',
      status: 400,
      submissionState: 'not_submitted',
    });
  }
  const file = jobFileForIdempotencyKey(key);
  let job = await readJob(file);
  if (!job) return { status: 'not_found' };
  if (job.state === 'running' && !processIsAlive(job.owner_pid)) {
    job = {
      ...job,
      state: job.studio_project_id ? 'submission_unknown' : 'not_submitted',
      updated_at: nowIso(),
      error: job.studio_project_id
        ? {
            code: 'fast_upload_submission_unknown',
            message: 'The owning process stopped after creating a Studio project.',
          }
        : {
            code: 'fast_upload_process_terminated',
            message: 'The owning process stopped before a Studio project was observed.',
          },
    };
    await atomicWriteJson(file, job);
  }
  if (job.state === 'complete' && job.result) {
    return {
      status: 'complete',
      studio_project_id: job.studio_project_id,
      result: job.result,
    };
  }
  if (job.state === 'running') {
    return {
      status: 'running',
      studio_project_id: job.studio_project_id,
      retry_after_seconds: 10,
    };
  }
  if (job.state === 'submission_unknown') {
    const projectId = String(job.studio_project_id || '').trim();
    const knownIds = uploadedRowClipIds(job);
    const taskPrefix = taskPrefixFromJob(job);
    const observedAt = nowIso();
    if (!projectId) {
      // There is no remote identifier to inspect.  Keep the fence intact;
      // callers may explicitly authorize a fresh operation, but reconciliation
      // must never guess that an upload was rejected.
      return { status: 'submission_unknown', retry_after_seconds: 30 };
    }

    let project: any;
    let feed: any;
    let projectFound = false;
    let feedQueried = false;
    let projectNotFound = false;
    let accountId = String(job.account_id || '').trim();
    try {
      const remote = await reconcileWithAccount(job, async (api, account) => {
        if (account && !accountId) accountId = account.id;
        let projectValue: any;
        try {
          projectValue = await api.getStudioProject(projectId);
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
          projectNotFound = true;
        }
        let feedValue: any;
        // First query the exact known segment ids.  If the project response
        // does not expose a final clip, a bounded recent Feed query is needed
        // to discover the rendered portable clip after Studio finishes.
        try {
          feedValue = await api.getRawFeed(knownIds.length ? knownIds : undefined, null);
          feedQueried = true;
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
        if (!findReconciledCandidate(projectValue, feedValue, projectId, knownIds, taskPrefix)) {
          // The exact-id query contains only uploaded segments.  Ask for one
          // recent page as a bounded fallback; filtering below requires both
          // the private task prefix and a non-segment clip id.
          try {
            const recent = await api.getRawFeed(undefined, null);
            feedValue = { exact: feedValue, recent };
            feedQueried = true;
          } catch (error) {
            if (!isNotFoundError(error)) throw error;
          }
        }
        return { projectValue, feedValue };
      });
      project = remote?.projectValue;
      feed = remote?.feedValue;
      projectFound = !projectNotFound && project !== undefined;
    } catch (error: any) {
      if (error instanceof FastUploadError && error.code === 'fast_upload_account_affinity_missing') {
        // Missing owner affinity is a local data-integrity problem, not a
        // transient remote read failure.  Surface it explicitly instead of
        // repeatedly returning an opaque submission_unknown state.
        throw error;
      }
      // Remote read failures are not evidence that the project disappeared.
      // Persist only a bounded diagnostic and ask the Runtime to retry later.
      const code = /^[a-z0-9_.-]{1,80}$/i.test(String(error?.code || ''))
        ? String(error.code)
        : undefined;
      job.evidence = {
        ...(job.evidence || {}),
        ...safeReconciliationEvidence({
          projectFound,
          feedQueried,
          knownClipCount: knownIds.length,
          candidateCount: 0,
          observedAt,
          errorCode: code,
        }),
      };
      job.updated_at = observedAt;
      await atomicWriteJson(file, job);
      return {
        status: 'submission_unknown',
        studio_project_id: projectId,
        retry_after_seconds: 30,
      };
    }

    const candidate = findReconciledCandidate(
      project,
      feed,
      projectId,
      knownIds,
      taskPrefix,
    );
    if (candidate && accountId) {
      const result = buildReconciledResult(candidate, job, projectId, accountId);
      job.state = 'complete';
      job.updated_at = observedAt;
      job.song_url = result.song_url;
      job.result = result;
      job.account_id = accountId;
      delete job.error;
      job.evidence = {
        ...(job.evidence || {}),
        ...safeReconciliationEvidence({
          projectFound,
          feedQueried,
          knownClipCount: knownIds.length,
          candidateCount: 1,
          observedAt,
        }),
      };
      await atomicWriteJson(file, job);
      return { status: 'complete', studio_project_id: projectId, result };
    }

    // A project 404 is only safe to turn into not_submitted when the worker
    // explicitly recorded that its task-owned fragments were cleaned.  Legacy
    // jobs do not carry that proof, so they remain unknown rather than risking
    // duplicate uploads or deleting another account's clips.
    const cleanupConfirmed = job.evidence?.cleanup_confirmed === true;
    if (projectNotFound && !knownIds.length && cleanupConfirmed) {
      job.state = 'not_submitted';
      job.updated_at = observedAt;
      job.evidence = {
        ...(job.evidence || {}),
        ...safeReconciliationEvidence({
          projectFound: false,
          feedQueried,
          knownClipCount: 0,
          candidateCount: 0,
          observedAt,
        }),
      };
      await atomicWriteJson(file, job);
      return { status: 'not_submitted' };
    }

    job.updated_at = observedAt;
    job.evidence = {
      ...(job.evidence || {}),
      ...safeReconciliationEvidence({
        projectFound,
        feedQueried,
        knownClipCount: knownIds.length,
        candidateCount: 0,
        observedAt,
      }),
    };
    await atomicWriteJson(file, job);
    return {
      status: 'submission_unknown',
      studio_project_id: projectId,
      retry_after_seconds: 30,
    };
  }
  return { status: 'not_submitted' };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function jobError(job: FastUploadJob): FastUploadError {
  if (job.state === 'running') {
    return new FastUploadError({
      message: 'An upload with this Idempotency-Key is still running.',
      code: 'idempotency_in_progress',
      status: 409,
      submissionState: 'not_submitted',
      retryAfterSeconds: 10,
      studioProjectId: job.studio_project_id,
    });
  }
  return new FastUploadError({
    message: 'This upload may already have created a Studio project; automatic replay is blocked.',
    code: 'fast_upload_submission_unknown',
    status: 502,
    submissionState: 'submission_unknown',
    studioProjectId: job.studio_project_id,
  });
}

async function claimJob(
  idempotencyKey: string,
  fingerprint: string,
): Promise<{ job: FastUploadJob; file: string; replay?: StudioFastUploadResult }> {
  const root = fastUploadRoot();
  const storageId = idempotencyStorageId(idempotencyKey);
  const file = path.join(root, 'jobs', `${storageId}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });

  const existing = await readJob(file);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new FastUploadError({
        message: 'This Idempotency-Key was already used for different audio or metadata.',
        code: 'idempotency_key_reused',
        status: 409,
        submissionState: 'not_submitted',
      });
    }
    if (existing.state === 'complete' && existing.result) {
      return { job: existing, file, replay: existing.result };
    }
    if (existing.state === 'running' && !processIsAlive(existing.owner_pid)) {
      existing.state = existing.studio_project_id ? 'submission_unknown' : 'not_submitted';
      existing.updated_at = nowIso();
      existing.error = {
        code: existing.studio_project_id
          ? 'fast_upload_submission_unknown'
          : 'fast_upload_process_terminated',
        message: existing.studio_project_id
          ? 'The owning process stopped after creating a Studio project.'
          : 'The owning process stopped before a Studio project was observed.',
      };
      await atomicWriteJson(file, existing);
    }
    if (existing.state === 'running' || existing.state === 'submission_unknown') {
      throw jobError(existing);
    }
  }

  const timestamp = nowIso();
  const job: FastUploadJob = {
    version: 1,
    storage_id: storageId,
    fingerprint,
    state: 'running',
    job_id: crypto.randomUUID(),
    created_at: existing?.created_at || timestamp,
    updated_at: timestamp,
    owner_pid: process.pid,
  };

  if (!existing) {
    const handle = await fs.open(file, 'wx', 0o600).catch(async (error: any) => {
      if (error?.code !== 'EEXIST') throw error;
      return undefined;
    });
    if (!handle) {
      const raced = await readJob(file);
      if (!raced || raced.fingerprint !== fingerprint) {
        throw new FastUploadError({
          message: 'This Idempotency-Key was claimed by another request.',
          code: 'idempotency_key_reused',
          status: 409,
          submissionState: 'not_submitted',
        });
      }
      if (raced.state === 'complete' && raced.result) {
        return { job: raced, file, replay: raced.result };
      }
      throw jobError(raced);
    }
    try {
      await handle.writeFile(JSON.stringify(job, null, 2));
    } finally {
      await handle.close();
    }
  } else {
    await atomicWriteJson(file, job);
  }
  return { job, file };
}

function acquireFastSlot(): () => void {
  const state = globalState();
  if (state.active >= fastConcurrency()) {
    throw new FastUploadError({
      message: 'The Studio fast upload worker is busy.',
      code: 'fast_upload_busy',
      status: 429,
      submissionState: 'not_submitted',
      retryAfterSeconds: 10,
    });
  }
  state.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
  };
}

async function atomicWriteToken(
  tokenFile: string,
  token: string,
  account: AccountView,
): Promise<void> {
  await atomicWriteJson(tokenFile, {
    token,
    account_id: account.id,
    updated_at: nowIso(),
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
    try { child.kill('SIGKILL'); } catch {}
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function runWorker(input: {
  runtime: RuntimePaths;
  api: SunoApi;
  account: AccountView;
  source: string;
  taskDir: string;
  tokenFile: string;
  taskPrefix: string;
  workerTitle: string;
  signal?: AbortSignal;
  onProject: (projectId: string) => void;
}): Promise<WorkerOutcome> {
  const workDir = path.join(input.taskDir, 'work');
  const logFile = path.join(input.taskDir, 'worker.log');
  await fs.mkdir(workDir, { recursive: true });
  await fs.rm(path.join(input.taskDir, 'cancelled'), { force: true }).catch(() => undefined);
  const proxy = String(process.env.SUNO_PROXY_URL || '').trim();
  const child = spawn(input.runtime.python, [
    input.runtime.worker,
    input.source,
    '--work-dir', workDir,
    '--core-dir', input.runtime.coreDir,
    '--ffmpeg-exe', input.runtime.ffmpeg,
    '--token-file', input.tokenFile,
    '--task-prefix', input.taskPrefix,
    '--title', input.workerTitle,
    '--concurrency', String(segmentConcurrency()),
  ], {
    cwd: input.taskDir,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPYCACHEPREFIX: path.join(input.taskDir, 'pycache'),
      SUNO_PROXY_URL: proxy,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
    },
  });
  const log = createWriteStream(logFile, { flags: 'a', encoding: 'utf8', mode: 0o600 });
  let pending = '';
  let projectId = '';
  let songUrl = '';
  let finalEvent: Record<string, any> | undefined;
  let cancelled: WorkerOutcome['cancelled'];
  let stopping = false;
  let refreshRunning = false;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || trimmed.length > 1_000_000) return;
    try {
      const event = JSON.parse(trimmed) as Record<string, any>;
      if (event.projectId) {
        projectId = String(event.projectId);
        input.onProject(projectId);
      }
      if (event.songUrl) songUrl = String(event.songUrl);
      if (event.event === 'worker_finished') finalEvent = event;
    } catch {}
  };
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    log.write(text);
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) consumeLine(line);
  });
  child.stderr.on('data', (chunk) => log.write(String(chunk)));

  const stop = async (reason: WorkerOutcome['cancelled']) => {
    if (stopping) return;
    stopping = true;
    cancelled = reason;
    // The public Python core checks this task-local fence before every
    // mutation.  Persist it before terminating the process so a racing
    // request cannot start another upload/save after cancellation.
    await fs.writeFile(path.join(input.taskDir, 'cancelled'), `${reason || 'cancelled'}\n`, { mode: 0o600 }).catch(() => undefined);
    await terminateProcessTree(child);
  };
  const onAbort = () => { void stop('request_aborted'); };
  if (input.signal?.aborted) void stop('request_aborted');
  else input.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => { void stop('timeout'); }, timeoutSeconds() * 1000);
  timeout.unref();

  const refreshMs = Math.max(15, Number(process.env.SUNO_FAST_UPLOAD_TOKEN_REFRESH_SEC) || 30) * 1000;
  const refresh = setInterval(() => {
    if (refreshRunning || stopping) return;
    refreshRunning = true;
    void input.api.getAccessToken()
      .then((token) => atomicWriteToken(input.tokenFile, token, input.account))
      .catch((error) => log.write(`\n[token_refresh_error] ${safeMessage(error)}\n`))
      .finally(() => { refreshRunning = false; });
  }, refreshMs);
  refresh.unref();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  }).catch((error) => {
    log.write(`\n[worker_spawn_error] ${safeMessage(error)}\n`);
    return -1;
  });

  clearTimeout(timeout);
  clearInterval(refresh);
  input.signal?.removeEventListener('abort', onAbort);
  if (pending) consumeLine(pending);
  await new Promise<void>((resolve) => log.end(resolve));
  const rawLog = await fs.readFile(logFile, 'utf8').catch(() => '');
  const logTail = rawLog.slice(-12_000)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
  return { exitCode, projectId, songUrl, finalEvent, cancelled, logTail };
}

async function safeRemoveTaskDir(taskDir: string): Promise<void> {
  const root = path.resolve(fastUploadRoot(), 'tasks') + path.sep;
  const target = path.resolve(taskDir);
  if (!target.startsWith(root)) throw new Error('Refusing to remove a path outside fast-upload tasks.');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
}

async function preserveTaskEvidence(
  taskDir: string,
  source: string,
  tokenFile: string,
): Promise<Record<string, unknown>> {
  // Keep work/uploaded_rows.json and worker.log.  They are the only durable
  // proof available after a segment-level failure.  Remove credentials and
  // source media from the temporary task directory.
  const removed: string[] = [];
  const taskRoot = path.resolve(taskDir);
  const candidates: string[] = [tokenFile, source, path.join(taskRoot, 'work', 'normalized_input.wav')];

  // The Python core can leave the original/repaired media under a generated
  // ``source.*`` or ``source_*`` name, including inside ``work``.  Walk only
  // this task's private directory and retain progress/log evidence files.
  const visit = async (directory: string): Promise<void> => {
    let entries: any[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true }) as any[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile() && (/^source(?:\.|_)/i.test(entry.name))) {
        candidates.push(candidate);
      }
    }
  };
  await visit(taskRoot);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved !== taskRoot && !resolved.startsWith(`${taskRoot}${path.sep}`)) continue;
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      await fs.rm(candidate, { force: true });
      removed.push(path.basename(candidate));
    } catch {}
  }
  return {
    ok: true,
    skipped: true,
    reason: 'failure_preserve_evidence',
    removed_sensitive_files: removed,
  };
}

async function recordFailure(
  job: FastUploadJob,
  jobFile: string,
  error: FastUploadError,
  evidence: Record<string, unknown>,
): Promise<void> {
  job.state = error.submissionState;
  job.updated_at = nowIso();
  job.studio_project_id = error.studioProjectId || job.studio_project_id;
  job.error = { code: error.code, message: safeMessage(error) };
  job.evidence = evidence;
  await atomicWriteJson(jobFile, job);
}

function clipIdFromSongUrl(songUrl: string): string {
  const match = /^https:\/\/suno\.com\/song\/([a-f0-9-]{36})(?:[/?#]|$)/i.exec(songUrl.trim());
  return match?.[1] || '';
}

async function waitForRenderedClip(api: SunoApi, clipId: string, initial: any): Promise<any> {
  let clip = initial || {};
  const attempts = Math.max(1, Math.min(60, Number(process.env.SUNO_FAST_UPLOAD_FINAL_POLL_ATTEMPTS) || 24));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = String(clip?.status || '').toLowerCase();
    if (['complete', 'completed', 'error', 'failed', 'rejected'].includes(status)) return clip;
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    clip = await api.getClip(clipId);
  }
  return clip;
}

export async function executeStudioFastUpload(input: {
  audio: Buffer;
  filename: string;
  metadata: FastUploadMetadata;
  durationSeconds: number;
  idempotencyKey?: string;
  tier: AccountTier;
  signal?: AbortSignal;
}): Promise<StudioFastUploadResult> {
  const contentSha256 = crypto.createHash('sha256').update(input.audio).digest('hex');
  const fingerprint = fastUploadFingerprint(contentSha256, {
    filename: path.basename(input.filename),
    title: input.metadata.title,
    prompt: input.metadata.prompt,
    image_url: input.metadata.imageUrl,
    defer_metadata: Boolean(input.metadata.deferMetadata),
  });
  const idempotencyKey = String(input.idempotencyKey || `auto:${fingerprint}`).trim();
  if (idempotencyKey.length > 512) {
    throw new FastUploadError({
      message: 'Idempotency-Key must be no longer than 512 characters.',
      code: 'invalid_idempotency_key',
      status: 400,
      submissionState: 'not_submitted',
    });
  }
  const claimed = await claimJob(idempotencyKey, fingerprint);
  if (claimed.replay) return claimed.replay;
  const { job, file: jobFile } = claimed;
  const taskDir = path.resolve(fastUploadRoot(), 'tasks', job.job_id);
  let releaseSlot: (() => void) | undefined;
  let projectId = '';
  let sourcePath = '';
  let tokenPath = '';

  try {
    releaseSlot = acquireFastSlot();
    const runtime = await resolveRuntimePaths();
    await fs.mkdir(taskDir, { recursive: true });
    const extension = path.extname(path.basename(input.filename)).toLowerCase();
    const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.audio';
    const source = path.join(taskDir, `source${safeExtension}`);
    const tokenFile = path.join(taskDir, 'token.json');
    sourcePath = source;
    tokenPath = tokenFile;
    await fs.writeFile(source, input.audio, { mode: 0o600 });

    const result = await withSunoAccountExclusive(input.tier, async (api, account) => {
      if (!account) {
        throw new FastUploadError({
          message: 'Studio fast upload requires a configured account-pool account.',
          code: 'fast_upload_account_required',
          status: 503,
          submissionState: 'not_submitted',
          retryAfterSeconds: 30,
        });
      }
      await atomicWriteToken(tokenFile, await api.getAccessToken(), account);
      const taskPrefix = `__sfp_${job.job_id}_`;
      // Persist ownership before the first project/upload request.  This is
      // needed for post-crash reconciliation and keeps legacy jobs (which may
      // lack these fields) distinguishable from a new operation.
      job.account_id = account.id;
      job.tier = input.tier;
      job.task_prefix = taskPrefix;
      job.updated_at = nowIso();
      await atomicWriteJson(jobFile, job);
      const cleanTitle = input.metadata.title.replace(/[\r\n\0]/g, ' ').trim() || 'Uploaded song';
      const workerTitle = `${taskPrefix}${cleanTitle}`.slice(0, 180);
      let persistQueue = Promise.resolve();
      const outcome = await runWorker({
        runtime,
        api,
        account,
        source,
        taskDir,
        tokenFile,
        taskPrefix,
        workerTitle,
        signal: input.signal,
        onProject: (value) => {
          projectId = value;
          job.studio_project_id = value;
          job.updated_at = nowIso();
          persistQueue = persistQueue.then(() => atomicWriteJson(jobFile, job));
        },
      });
      await persistQueue;
      projectId = outcome.projectId || projectId;
      const songUrl = outcome.songUrl || String(outcome.finalEvent?.songUrl || '');
      const clipId = clipIdFromSongUrl(songUrl);

      if (outcome.cancelled || outcome.exitCode !== 0 || !clipId || !projectId) {
        const unknown = Boolean(projectId);
        throw new FastUploadError({
          message: outcome.cancelled === 'timeout'
            ? 'Studio fast upload exceeded its 1800-second timeout.'
            : outcome.cancelled === 'request_aborted'
              ? 'Studio fast upload was cancelled by the client.'
              : `Studio fast upload did not return a complete result (exit ${outcome.exitCode}).`,
          code: unknown ? 'fast_upload_submission_unknown' : 'fast_upload_failed',
          status: outcome.cancelled === 'timeout' ? 504 : unknown ? 502 : 422,
          submissionState: unknown ? 'submission_unknown' : 'not_submitted',
          studioProjectId: projectId || undefined,
        });
      }

      let clip: any = {};
      let metadataWarning: string | undefined;
      try {
        clip = await api.getClip(clipId);
        await api.setUploadedClipMetadata(clipId, {
          title: cleanTitle,
          // The Song Cover source upload is intentionally metadata-deferred.
          // Sending its placeholder prompt here would make that text appear in
          // Song Details and could leak it into a later cover request.
          ...(input.metadata.deferMetadata ? {} : { prompt: input.metadata.prompt }),
          image_url: input.metadata.imageUrl,
        });
        clip = await api.getClip(clipId);
      } catch (error) {
        metadataWarning = safeMessage(error);
      }
      try {
        clip = await waitForRenderedClip(api, clipId, clip);
      } catch (error) {
        metadataWarning = [metadataWarning, safeMessage(error)].filter(Boolean).join('; ').slice(0, 800);
      }
      const metadata = clip?.metadata || {};
      return {
        upload_method: 'studio_fast' as const,
        upload_id: projectId,
        upload_id_kind: 'studio_project' as const,
        studio_project_id: projectId,
        clip_id: clipId,
        song_url: songUrl,
        duration_seconds: input.durationSeconds,
        portable_clip: true as const,
        account_affinity: createAccountAffinity(account.id),
        title: clip?.title || cleanTitle,
        image_url: clip?.image_url || input.metadata.imageUrl,
        has_vocal: metadata?.has_vocal,
        status: clip?.status || 'complete',
        inferred_description: metadata?.inferred_description,
        copyright_muted: metadata?.copyright_muted,
        ...(input.metadata.deferMetadata ? { metadata_deferred: true } : {}),
        ...(metadataWarning ? { metadata_warning: metadataWarning } : {}),
      };
    });

    job.state = 'complete';
    job.updated_at = nowIso();
    job.studio_project_id = result.studio_project_id;
    job.song_url = result.song_url;
    job.result = result;
    delete job.error;
    delete job.evidence;
    await atomicWriteJson(jobFile, job);
    await safeRemoveTaskDir(taskDir);
    return result;
  } catch (error) {
    const internalCode = String((error as any)?.code || '');
    const accountPoolRejection = !projectId && [
      'account_pool_busy',
      'account_pool_credentials_unavailable',
      'account_pool_unavailable',
    ].includes(internalCode);
    const fastError = error instanceof FastUploadError
      ? error
      : accountPoolRejection
        ? new FastUploadError({
          message: safeMessage(error),
          code: internalCode,
          status: Number((error as any)?.status) || 503,
          submissionState: 'not_submitted',
          retryAfterSeconds: Number((error as any)?.retryAfterSeconds) || 5,
        })
        : new FastUploadError({
          message: safeMessage(error),
          code: projectId ? 'fast_upload_submission_unknown' : 'fast_upload_failed',
          status: projectId ? 502 : 503,
          submissionState: projectId ? 'submission_unknown' : 'not_submitted',
          studioProjectId: projectId || undefined,
        });
    let uploadedRows: unknown;
    let logTail = '';
    try {
      uploadedRows = JSON.parse(await fs.readFile(path.join(taskDir, 'work', 'uploaded_rows.json'), 'utf8'));
    } catch {}
    try {
      logTail = (await fs.readFile(path.join(taskDir, 'worker.log'), 'utf8')).slice(-12_000);
    } catch {}
    await recordFailure(job, jobFile, fastError, {
      studio_project_id: fastError.studioProjectId || projectId || undefined,
      uploaded_rows: uploadedRows,
      account_id: job.account_id,
      tier: job.tier,
      task_prefix: job.task_prefix,
      log_tail: logTail
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/(token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'),
    });
    const hasEvidence = Boolean(
      fastError.studioProjectId
      || projectId
      || (Array.isArray(uploadedRows) && uploadedRows.length)
      || logTail,
    );
    if (hasEvidence) {
      const preserved = await preserveTaskEvidence(taskDir, sourcePath, tokenPath);
      // A cleanup marker is intentionally separate from the uploaded rows:
      // reconciliation may only downgrade an unknown job after it has proof
      // that the project and all task-owned fragments were removed.
      job.evidence = {
        ...(job.evidence || {}),
        cleanup_confirmed: false,
        cleanup: preserved,
      };
      await atomicWriteJson(jobFile, job);
    } else {
      await safeRemoveTaskDir(taskDir).catch(() => undefined);
    }
    throw fastError;
  } finally {
    releaseSlot?.();
  }
}
