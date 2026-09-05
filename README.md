# Suno API Plus Next

Unofficial, self-hosted Suno API gateway. This clean-history release is maintained by `dreamcolor123` and is based on the public [`ShowSnowBlood/suno-api-plus`](https://github.com/ShowSnowBlood/suno-api-plus) project, which incorporates [`gcui-art/suno-api`](https://github.com/gcui-art/suno-api). See [`NOTICE`](./NOTICE) and [`LICENSE`](./LICENSE).

> Use only with an account and content you are authorized to use. Respect Suno's terms, applicable law, CAPTCHA-provider terms, and the licenses of all dependencies. This project is not affiliated with Suno, Inc.

## Highlights

- Native generation, custom mode, Cover, Extend, lyrics, clip metadata and clip queries.
- OpenAI-compatible `/v1/models`, `/v1/chat/completions`, `/v1/responses` and billing endpoints.
- Account pools with `basic`, `super` and `heavy` tiers, quota refresh, affinity tokens and global concurrency limits.
- YesCaptcha and 2Captcha integrations with bounded deadlines, provider health and safe error codes.
- Direct uploads for short files and Studio Fast Upload for long files, with idempotency, checkpoints and read-only reconciliation.
- Studio Advanced Split submission and Studio project APIs. Legacy Advanced Split WAV/render routes intentionally return `410`.
- Admin console for accounts, API keys, CAPTCHA, billing, concurrency and generation diagnostics.

## Quick start

### Docker Compose

```bash
git clone https://github.com/dreamcolor123/suno-api-plus-next.git
cd suno-api-plus-next
cp .env.example .env
# Edit .env and/or create data/accounts.json with your own account settings.
docker compose up --build -d
```

The service listens on `127.0.0.1:3000` by default. Persistent account and job data is stored in `./data`; keep that directory private and back it up securely. Credentials are runtime inputs only and are never Docker build arguments.

### Local development

Requirements: Node.js 20+, Python 3.10+, FFmpeg/FFprobe, and a supported Chromium browser when browser-based CAPTCHA solving is enabled.

```bash
npm ci
python -m pip install -r requirements-fast-upload.txt
npm run dev
```

Use `npm run build && npm run start` for a production-like local run. `npm test` runs the Node contract suite; `npm run test:python` runs Python tests.

## Configuration

Copy `.env.example` and change every placeholder before exposing the service. Important settings include:

| Variable | Purpose |
| --- | --- |
| `SUNO_COOKIE` | Optional single-account development cookie. Prefer admin-managed accounts for production. |
| `ACCOUNT_DATA_PATH` | JSON account-pool database; defaults to `./data/accounts.json`. |
| `ACCOUNT_ENCRYPTION_KEY` | Encrypts stored account cookies. Use a long random value and rotate through a planned migration. |
| `ADMIN_PASSWORD` | Admin console password. Set it before first use. |
| `API_KEY` / `SUNO_API_KEY` | Optional key required by `/v1/*` when enabled. |
| `CAPTCHA_PROVIDER` | `auto`, `yescaptcha` or `2captcha`. |
| `YESCAPTCHA_KEY`, `TWOCAPTCHA_KEY` | CAPTCHA provider credentials, supplied only at runtime. |
| `SUNO_PROXY_URL` | Optional proxy for Suno/Clerk traffic. Do not use untrusted public proxies. |
| `SUNO_STUDIO_FFMPEG_EXE`, `SUNO_STUDIO_FFPROBE_EXE` | Optional explicit media-tool paths. Docker supplies both. |
| `SUNO_FAST_UPLOAD_*` | Fast Upload timeout and bounded concurrency controls. |

The admin panel can persist account-pool, API-key, CAPTCHA, billing and concurrency settings under the configured data directory. Do not commit that directory.

## Authentication and account affinity

Public OpenAI-compatible routes accept `Authorization: Bearer <API_KEY>` (or `x-api-key` / `api-key`) when API-key authentication is enabled. Admin routes use the `suno_admin_session` cookie established by `/admin`.

Operations involving uploaded or private Studio material are account-owned. Responses may include an opaque `account_affinity` value in JSON and/or `X-Suno-Account-Affinity`. Pass that value unchanged to subsequent operations on the same private source. Never log, publish, decode, or substitute affinity tokens.

## Uploads and Fast Upload

`POST /api/upload_audio` accepts multipart `audio_file` (or `file`). The server probes duration with FFprobe:

- `<= 30.000` seconds: direct Suno upload.
- `> 30.000` seconds: Studio Fast Upload; no direct-upload fallback.

Send a stable `Idempotency-Key` for long uploads. A completed key replays the recorded result; a running key returns a conflict; an ambiguous submission is exposed for read-only reconciliation at `POST /api/upload_audio/reconcile` and is never blindly replayed. Temporary segments and task evidence are removed only when ownership is proven.

Fast Upload is source-only and does not include the private native extension or a bundled browser profile. The public worker uses runtime Token input, FFmpeg, multipart fields from the presigned target, bounded retries, atomic checkpoints and Studio project reconciliation. It must not be used to bypass Suno access controls or content restrictions.

## Studio Advanced Split

`POST /api/advanced_stems` accepts one stem per request:

```json
{
  "audio_id": "<source-clip-id>",
  "project_id": "<studio-project-id>",
  "stem_name": "Bass",
  "account_affinity": "<opaque-affinity>"
}
```

The API Plus endpoint mirrors Studio's extraction request and returns the provider result. Use the Studio project, downbeats and save routes to build a project context. Downloading isolated clips is done with `POST /api/studio/clip/{clip_id}/download`; `GET /api/studio/clip/{clip_id}/downbeats` exposes timing data. The old `/api/advanced_stems/wav` and `/api/advanced_stems/render` endpoints are disabled with HTTP `410` because they depended on an unavailable legacy download path.

The desktop Runtime's automatic multi-stage WAV/ZIP orchestration is outside this repository. API Plus exposes the primitives; callers are responsible for their own workflow and artifact storage.

## OpenAI-compatible API

```bash
curl "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $API_KEY"

curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"suno-music","messages":[{"role":"user","content":"An energetic synth-pop song about a night train"}]}'
```

The public model catalog exposes stable aliases such as `suno-music`, `suno-v5.5`, `suno-v5`, `suno-v4.5+` and legacy aliases. Unknown model IDs are passed through for forward compatibility. `/v1/images/generations` and `/v1/videos` currently return a documented `501` unsupported response.

## Native routes

The interactive Swagger page is available at `/docs`. The current contract includes:

- Generation: `/api/generate`, `/api/custom_generate`, `/api/cover`, `/api/extend_audio`, `/api/generate_lyrics`, `/api/generate_stems`, `/api/concat`.
- Reading: `/api/get`, `/api/get_limit`, `/api/get_aligned_lyrics`, `/api/clip`, `/api/persona`, `/api/voices`.
- Upload and metadata: `/api/upload_audio`, `/api/upload_audio/reconcile`, `/api/clip/{clip_id}/metadata`, `/api/clip/{clip_id}/download`.
- Studio: project load, create-or-load, save, archive, downbeats, project listings and Studio clip download.
- Advanced Split: `/api/advanced_stems`, plus the explicit legacy `410` routes.
- Administration: accounts, verification/refresh, CAPTCHA, API key, billing, concurrency, songs and admin generation.

See [`src/app/docs/swagger-suno-api.json`](./src/app/docs/swagger-suno-api.json) for request and response schemas. The checked-in `public/swagger-suno-api.json` is generated from that source and must remain identical.

## Security checklist

- Keep `.env`, `data/`, logs, PID files, browser profiles, token files, generated media and backups outside Git.
- Use HTTPS or a private reverse proxy when serving beyond localhost; see [`deploy/HTTPS.md`](./deploy/HTTPS.md).
- Set a strong admin password, encryption key and API key. Rotate them deliberately, not during an active upload.
- Restrict account-pool files and artifact directories to the service account.
- Do not expose provider cookies, CAPTCHA keys, affinity tokens or signed URLs in logs or issue reports.
- Do not use the public demo or a third-party proxy as an account store.

## Migration from `suno-api-plus`

This release uses a clean Git history and is not a drop-in replacement for the old repository's Git remote. Copy only intentional runtime configuration into `data/`; do not copy `.env`, logs, `.next`, `node_modules`, browser profiles or old Fast Upload private runtimes. Review clients for the following changes:

1. Legacy Advanced Split WAV/render downloads now return `410`; use Studio project and clip-download routes.
2. Long uploads require `Idempotency-Key` for reliable replay/reconciliation.
3. Uploaded/private operations must keep the returned account affinity.
4. Fast Upload is source-only and uses the public Python worker; private native extensions are not supported.
5. `/api/generate_lyrics` is self-contained and uses Suno's native lyrics endpoint.

## Development and tests

```bash
npm test
npm run test:python
npm run typecheck
npm run build
```

Tests are contract and synthetic-fixture tests. They do not contain real cookies or provider credentials and do not make real Suno requests.

## License and credits

Licensed under LGPL-3.0-or-later. Preserve the license and notices in redistributed copies. Upstream credits: `gcui.ai/suno-api` and `ShowSnowBlood/suno-api-plus`. Current changes and the source-only Fast Upload rewrite are maintained by `dreamcolor123`; see [`NOTICE`](./NOTICE).
