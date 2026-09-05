export const SUNO_CAPTCHA_BROWSER_USER_AGENT = (
  process.env.SUNO_CAPTCHA_BROWSER_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
).trim();

export type SunoBrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  sameSite: 'Lax';
};

/** Build one valid browser cookie jar and refresh every Clerk session namespace. */
export function buildSunoBrowserCookies(
  cookies: Record<string, string | undefined>,
  currentToken: string,
): SunoBrowserCookie[] {
  const values = new Map<string, string>();
  for (const [name, raw] of Object.entries(cookies)) {
    const value = String(raw || '');
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    // Chromium rejects raw delimiters/control bytes in Storage.setCookies.
    if (!value || /[\x00-\x1f\x7f;]/.test(value)) continue;
    values.set(name, name === '__session' || name.startsWith('__session_')
      ? currentToken
      : value);
  }
  values.set('__session', currentToken);
  return [...values.entries()].map(([name, value]) => ({
    name,
    value,
    domain: '.suno.com',
    path: '/',
    sameSite: 'Lax',
  }));
}
