import { spawn } from 'node:child_process';

export class AudioDurationError extends Error {
  readonly status = 422;
  readonly code = 'audio_duration_unavailable';
  readonly submissionState = 'not_submitted';

  constructor(message = 'The uploaded audio duration could not be determined.') {
    super(message);
    this.name = 'AudioDurationError';
  }
}

export function resolveFfprobeExecutable(): string {
  return String(process.env.SUNO_STUDIO_FFPROBE_EXE || 'ffprobe').trim();
}

export async function probeAudioDuration(
  filePath: string,
  signal?: AbortSignal,
): Promise<number> {
  const executable = resolveFfprobeExecutable();
  return new Promise<number>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (error?: Error, duration?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(duration!);
    };
    const stop = () => {
      try { child.kill('SIGKILL'); } catch {}
    };
    const onAbort = () => {
      stop();
      finish(new AudioDurationError('The upload was cancelled before duration probing completed.'));
    };
    const timeout = setTimeout(() => {
      stop();
      finish(new AudioDurationError('FFprobe timed out while reading the uploaded audio.'));
    }, 30_000);
    timeout.unref();

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4096) stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk);
    });
    child.on('error', (error) => {
      finish(new AudioDurationError(`FFprobe could not start: ${error.message}`));
    });
    child.on('exit', (code) => {
      if (settled) return;
      const duration = Number.parseFloat(stdout.trim());
      if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300);
        finish(new AudioDurationError(
          detail
            ? `The uploaded audio duration could not be determined: ${detail}`
            : 'The uploaded audio duration could not be determined.',
        ));
        return;
      }
      finish(undefined, duration);
    });
  });
}
