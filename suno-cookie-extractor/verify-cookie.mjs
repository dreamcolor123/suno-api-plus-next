#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { cookie: '', envPath: path.join(ROOT_DIR, '.env') };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--cookie') args.cookie = String(argv[++i] || '');
    else if (token === '--env') args.envPath = path.resolve(String(argv[++i] || args.envPath));
    else if (token === '--help' || token === '-h') {
      console.log(`Usage:
  node verify-cookie.mjs [--cookie "k=v; ..."] [--env PATH]

If --cookie is omitted, reads SUNO_COOKIE from env or .env.
`);
      process.exit(0);
    }
  }
  return args;
}

function readEnvCookie(envPath) {
  if (process.env.SUNO_COOKIE) return process.env.SUNO_COOKIE.trim();
  if (!fs.existsSync(envPath)) return '';
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(/^SUNO_COOKIE=(.*)$/m);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

async function verifyCookie(cookieHeader) {
  if (!cookieHeader || !cookieHeader.includes('__client')) {
    throw new Error('Cookie string must include __client');
  }
  const parsed = Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        if (idx === -1) return [part, ''];
        return [part.slice(0, idx), part.slice(idx + 1)];
      }),
  );
  const client = parsed.__client;
  if (!client) throw new Error('Missing __client cookie value');

  const clerkVersion = '5.102.1';
  const clientUrl = `https://clerk.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${clerkVersion}`;
  const clientResponse = await fetch(clientUrl, {
    headers: {
      Authorization: client,
      Cookie: cookieHeader,
      Origin: 'https://suno.com',
      Referer: 'https://suno.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!clientResponse.ok) throw new Error(`Clerk client check failed: HTTP ${clientResponse.status}`);
  const clientJson = await clientResponse.json();
  const sid = clientJson?.response?.last_active_session_id;
  if (!sid) throw new Error('Clerk session id not found. Cookie may be expired.');

  const tokenUrl = `https://clerk.suno.com/v1/client/sessions/${sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${clerkVersion}`;
  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: client,
      Cookie: cookieHeader,
      Origin: 'https://suno.com',
      Referer: 'https://suno.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!tokenResponse.ok) throw new Error(`Clerk token renew failed: HTTP ${tokenResponse.status}`);
  const tokenJson = await tokenResponse.json();
  const jwt = tokenJson?.jwt;
  if (!jwt) throw new Error('Clerk JWT missing from token response.');

  const billingResponse = await fetch('https://studio-api.prod.suno.com/api/billing/info/', {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Cookie: cookieHeader,
      Origin: 'https://suno.com',
      Referer: 'https://suno.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!billingResponse.ok) throw new Error(`Billing check failed: HTTP ${billingResponse.status}`);
  const billing = await billingResponse.json();
  return {
    ok: true,
    sessionId: sid,
    credits_left: billing.total_credits_left,
    monthly_limit: billing.monthly_limit,
    monthly_usage: billing.monthly_usage,
    period: billing.period,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookie = (args.cookie || readEnvCookie(args.envPath) || '').trim();
  if (!cookie) {
    throw new Error('No cookie provided. Use --cookie or set SUNO_COOKIE in .env');
  }
  const result = await verifyCookie(cookie);
  console.log('[verify-cookie] cookie is valid.');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`[verify-cookie] failed: ${error.message}`);
  process.exit(1);
});
