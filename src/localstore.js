/**
 * localStorage as a session store, for the case where the frame gets no cookies at all.
 *
 * Measured in WebKit: a cross-site frame can have every `document.cookie` write dropped —
 * including a `Partitioned` one, since WebKit has not shipped CHIPS — while `localStorage`
 * remains readable and writable. In that browser this is the only place a session can live.
 *
 * The trade-offs, which matter when recommending it:
 *   - It is partitioned by top-level site in every current browser, so it behaves like a CHIPS
 *     cookie: a value written in the board panel is invisible to a normal tab, and vice versa.
 *   - It is never attached to requests automatically. The frame has to read it and send it
 *     explicitly, e.g. as an Authorization header, so the backend contract differs from a cookie.
 *   - It is script-readable by definition, so it cannot be HttpOnly. Store a short-lived,
 *     narrowly-scoped session reference, never a long-lived credential.
 *   - Safari's ITP evicts script-written storage after roughly seven days without interaction, so
 *     treat it as a cache for a session the login handshake can always re-establish.
 */

const TEXT_KEY = 'demo_text_ls';
const SESSION_KEY = 'demo_session_ls';

export const SPEC = {
  key: 'localstorage',
  name: TEXT_KEY,
  label: 'localStorage (not a cookie)',
  short: 'localStorage',
  note:
    'Partitioned by top-level site in every current browser, and still available in browsers that ' +
    'refuse cookies to a third-party frame. Never sent automatically — the frame must read it and ' +
    'attach it to requests itself.',
};

export const SESSION_SPEC = {
  key: 'session-localstorage',
  name: SESSION_KEY,
  label: 'localStorage (not a cookie)',
  short: 'Session (localStorage)',
  note: 'Last-resort session store for frames that are given no cookies at all.',
};

function store() {
  try {
    return window.localStorage || null;
  } catch (e) {
    return null;
  }
}

export function available() {
  return store() !== null;
}

function get(key) {
  const s = store();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch (e) {
    return null;
  }
}

/** Mirrors the cookie writer's contract: write, then read back, because a write can be a no-op. */
function set(key, value) {
  const s = store();
  if (!s) return { persisted: false, readBack: null, error: 'localStorage unavailable' };
  try {
    s.setItem(key, value);
  } catch (e) {
    return { persisted: false, readBack: get(key), error: e.name + ': ' + e.message };
  }
  const readBack = get(key);
  return { persisted: readBack === value, readBack, error: null };
}

function del(key) {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch (e) {
    /* nothing to do */
  }
}

export const text = {
  read: () => get(TEXT_KEY),
  write: (value) => ({ spec: SPEC, attempted: `${TEXT_KEY}=${value}`, ...set(TEXT_KEY, value) }),
  remove: () => del(TEXT_KEY),
};

export const session = {
  read: () => get(SESSION_KEY),
  write: (value) => ({ spec: SESSION_SPEC, attempted: `${SESSION_KEY}=<token>`, ...set(SESSION_KEY, value) }),
  remove: () => del(SESSION_KEY),
};

export function removeAll() {
  text.remove();
  session.remove();
}
