# suno-cookie-extractor

Playwright helper that opens suno.com, captures Clerk authentication cookies, and optionally verifies them against the Suno API.

## Install once

```bash
cd suno-cookie-extractor
npm install
```

## Usage (from repo root)

```bash
# Headed browser login, print cookie, write SUNO_COOKIE into .env
npm run get-cookie -- --save

# Google / Apple SSO or 2FA: open browser and wait for manual login
npm run get-cookie -- --manual --save

# Email / password autofill (still confirm captcha / 2FA manually if prompted)
npm run get-cookie -- --email you@example.com --password '***' --save

# Verify an existing cookie
npm run verify-cookie
npm run verify-cookie -- --cookie "cookie_string_here"
```

Windows users can also double-click `playwright-cookie-login.bat` in the project
root. Every run uses a fresh isolated Playwright browser context, reads
`SUNO_PROXY_URL` and `ADMIN_PASSWORD` from the root `.env`, imports the captured
cookie through `/api/admin/accounts`, and opens the admin account page after a
successful import. This flow does not write the captured cookie to `.env`.

Useful flags for `get-cookie`:

| Flag | Description |
| --- | --- |
| `--save` | Write `SUNO_COOKIE` into project root `.env` |
| `--manual` | Always wait for interactive browser login |
| `--email` / `--password` | Prefill email/password form when available |
| `--env <path>` | Custom `.env` path (default: `../.env`) |
| `--timeout <ms>` | Max wait for login (default: 300000) |
| `--headless` | Run browser headless (usually needs an already valid session, not recommended for first login) |

The extractor waits until a Clerk `__client` cookie appears, then prints a ready-to-paste cookie string for the admin console or `SUNO_COOKIE`.
