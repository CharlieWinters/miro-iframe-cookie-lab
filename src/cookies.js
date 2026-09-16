/**
 * Cookie helpers for the lab.
 *
 * Everything here is written with `document.cookie` from JavaScript, because the app is
 * hosted on GitHub Pages and GitHub Pages cannot send `Set-Cookie` response headers.
 * The attribute semantics are identical either way — SameSite / Secure / Partitioned mean
 * the same thing to the browser whether they arrive over HTTP or via script.
 */

/**
 * GitHub Pages project sites are served from `<user>.github.io/<repo>/`, and `github.io` is on
 * the Public Suffix List. That means every project site on the same user account shares one
 * cookie host. Scoping cookies to the deployment path keeps this demo from colliding with
 * anything else published under the same account.
 */
export const BASE_PATH = location.pathname.replace(/[^/]*$/, '') || '/';

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** The four write strategies the lab compares, in the order the viewer prefers them. */
export const TEXT_VARIANTS = [
  {
    key: 'chips',
    name: 'demo_text_chips',
    attrs: `SameSite=None; Secure; Partitioned`,
    label: 'SameSite=None; Secure; Partitioned',
    short: 'Partitioned (CHIPS)',
    note:
      'Sent in cross-site iframes, but stored against the pair (top-level site, this site). ' +
      'The board panel and a normal tab therefore see two different cookies with this name.',
  },
  {
    key: 'none',
    name: 'demo_text_none',
    attrs: `SameSite=None; Secure`,
    label: 'SameSite=None; Secure',
    short: 'SameSite=None',
    note:
      'The classic third-party cookie. One shared jar across every top-level site, which is ' +
      'exactly why Safari blocks it outright and Firefox partitions it.',
  },
  {
    key: 'lax',
    name: 'demo_text_lax',
    attrs: `SameSite=Lax`,
    label: 'SameSite=Lax',
    short: 'SameSite=Lax',
    note:
      'Never sent or readable in a cross-site iframe. Writing it from inside the board panel ' +
      'is not an error — the value just is not visible to a cross-site frame.',
  },
  {
    key: 'strict',
    name: 'demo_text_strict',
    attrs: `SameSite=Strict`,
    label: 'SameSite=Strict',
    short: 'SameSite=Strict',
    note: 'Same as Lax for our purposes, and additionally withheld on top-level cross-site navigations.',
  },
];

/** Session cookies used by the auth bridge. */
export const SESSION_COOKIES = [
  {
    key: 'session-chips',
    name: 'demo_session_p',
    attrs: `SameSite=None; Secure; Partitioned`,
    label: 'SameSite=None; Secure; Partitioned',
    short: 'Session (Partitioned)',
    note: 'Durable session inside whichever partition wrote it. Survives a panel reload in every browser.',
  },
  {
    key: 'session-none',
    name: 'demo_session',
    attrs: `SameSite=None; Secure`,
    label: 'SameSite=None; Secure',
    short: 'Session (unpartitioned)',
    note: 'Shared session jar. Only reaches the panel where third-party cookies are allowed or storage access was granted.',
  },
];

export const ALL_COOKIES = [...TEXT_VARIANTS, ...SESSION_COOKIES];

/** Marker recording which context last wrote a cookie, used to prove partitioning. */
export const STAMP_COOKIE = {
  key: 'stamp',
  name: 'demo_ctx_stamp',
  attrs: `SameSite=None; Secure; Partitioned`,
  label: 'SameSite=None; Secure; Partitioned',
  short: 'Context stamp',
  note: 'Written on every visit. If the panel and a tab disagree, cookie storage is partitioned.',
};

function fullAttrs(spec, extra = '') {
  return `Path=${BASE_PATH}; Max-Age=${MAX_AGE}; ${spec.attrs}${extra}`;
}

/** Parse `document.cookie` into a plain object. Returns `{}` if cookies are unreadable. */
export function readAll() {
  const out = {};
  let raw = '';
  try {
    raw = document.cookie || '';
  } catch (e) {
    return out;
  }
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch (e) {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function read(spec) {
  const jar = readAll();
  return Object.prototype.hasOwnProperty.call(jar, spec.name) ? jar[spec.name] : null;
}

/**
 * Write a cookie and immediately read it back.
 *
 * A blocked write does not throw — `document.cookie = ...` is a silent no-op when the browser
 * refuses it. The read-back is the only way to tell success from failure, which is the whole
 * reason this function returns a result object rather than void.
 */
export function write(spec, value) {
  const str = `${spec.name}=${encodeURIComponent(value)}; ${fullAttrs(spec)}`;
  let threw = null;
  try {
    document.cookie = str;
  } catch (e) {
    threw = e.message;
  }
  const readBack = read(spec);
  return {
    spec,
    attempted: str,
    error: threw,
    persisted: readBack === value,
    readBack,
  };
}

export function remove(spec) {
  // Deleting a partitioned cookie requires repeating Partitioned, otherwise the expiry lands on
  // a different (and probably non-existent) cookie.
  try {
    document.cookie = `${spec.name}=; ${fullAttrs(spec)}`.replace(
      `Max-Age=${MAX_AGE}`,
      'Max-Age=0'
    );
  } catch (e) {
    /* nothing we can do */
  }
  return read(spec) === null;
}

export function removeAll() {
  const specs = [...ALL_COOKIES, STAMP_COOKIE];
  for (const spec of specs) remove(spec);
  // Also clear anything left over from an earlier deployment path.
  for (const name of Object.keys(readAll())) {
    if (!name.startsWith('demo_')) continue;
    for (const path of [BASE_PATH, '/']) {
      for (const extra of ['', '; Partitioned']) {
        try {
          document.cookie = `${name}=; Path=${path}; Max-Age=0; SameSite=None; Secure${extra}`;
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
  return readAll();
}

/** Snapshot of every lab cookie: is it there, and what does it hold? */
export function snapshot() {
  const jar = readAll();
  return [...ALL_COOKIES, STAMP_COOKIE].map((spec) => ({
    spec,
    present: Object.prototype.hasOwnProperty.call(jar, spec.name),
    value: jar[spec.name] ?? null,
  }));
}
