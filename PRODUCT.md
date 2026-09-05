# Product

## Purpose

Suno API Plus Next is an unofficial, self-hosted gateway for integrating
authorized Suno accounts into applications that need music generation,
Studio uploads, clip operations and OpenAI-compatible requests.

## Audience

- Developers running their own Suno account pool.
- Teams integrating Suno into private tools or agent platforms.
- Operators who need explicit account affinity, bounded concurrency and
  recoverable long-running uploads.

## Product principles

1. Credentials stay in runtime storage, never in source or container layers.
2. Account ownership is explicit; affinity is preserved across dependent calls.
3. A possibly accepted mutation is never blindly replayed.
4. Long-running work exposes checkpoints and safe read-only reconciliation.
5. Public API behavior is documented in OpenAPI and tested with synthetic data.
6. Provider terms, copyright, privacy and local law remain the operator's responsibility.

## Included capabilities

- Native Suno generation, custom mode, Cover, Extend, lyrics and clip APIs.
- OpenAI-compatible model, chat, response and billing surfaces.
- Account pool, quota refresh, API-key authentication, admin controls and CAPTCHA adapters.
- Direct and Studio Fast Upload with source-only Python implementation, idempotency and recovery.
- Studio project, Downbeats, Advanced Split, Clip download and metadata primitives.

## Explicit boundaries

- This repository does not include the desktop application, outer Python task Runtime,
  automatic local WAV/ZIP artifact orchestration, private native Fast Upload binaries,
  browser profiles, account databases or generated media.
- Legacy Advanced Split WAV/render routes return `410`; callers must use Studio clip download.
- Image and video generation compatibility routes are present only as explicit `501` responses.
- Suno service availability, account quotas, CAPTCHA providers and upstream contracts can change.

## Release policy

The `v2.0.0` release is published only after independent checkout tests, OpenAPI validation,
container build checks, sensitive-data scanning and Fast Upload behavioral acceptance. A source
reconstruction is described as a reconstruction; it is not represented as Suno's official source.

## Accessibility and operations

The admin UI should remain keyboard navigable and readable without color-only state cues.
Operators should monitor account availability, CAPTCHA health, mutation journals, upload
checkpoints and disk usage for temporary artifacts.
