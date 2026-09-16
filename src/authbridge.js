/**
 * Cross-frame auth handshake.
 *
 * The pattern: the panel cannot collect credentials (identity providers refuse to render in an
 * iframe, and a cross-site frame often cannot write a session cookie anyway), so it opens a
 * top-level tab. That tab is first-party, so login and cookie writes behave normally. It then
 * hands the session back over `postMessage` to the frame that opened it.
 *
 * postMessage is the right channel here because it is unaffected by storage partitioning —
 * localStorage events and BroadcastChannel do not cross between the top-level partition and the
 * partition the panel runs in, but a window reference does.
 *
 * The token below is an unsigned demo stub. Real deployments must return an opaque session
 * reference or a signed assertion the panel's backend can verify.
 */

export const MESSAGE_TYPE = 'demo-auth/v1';
export const AUTH_PATH = 'auth.html';

export function makeNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)));
}

/** Demo-only. No signature: do not copy this into anything real. */
export function mintToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'iframe-lab', sub: user, iat: now, exp: now + 3600, demo: true };
  return { token: `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`, claims };
}

export function decodeToken(token) {
  try {
    return unb64url(String(token).split('.')[1]);
  } catch (e) {
    return null;
  }
}

/** Short human-readable code, for when the popup has no `window.opener` to talk back to. */
export function pairingCode(token) {
  let hash = 0;
  for (const ch of token) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash.toString(36).toUpperCase().padStart(6, '0').slice(-6);
}

/**
 * Open the login tab. Must be called synchronously from a click, or the popup blocker wins.
 * Returns the window handle (null when blocked) plus the nonce to match the reply against.
 */
export function openLogin({ nonce, origin = location.origin }) {
  const url = new URL(AUTH_PATH, location.href);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('replyTo', origin);
  const handle = window.open(url.toString(), 'lab-login', 'popup=yes,width=520,height=660');
  return { handle, url: url.toString(), blocked: !handle };
}

/**
 * Listen for the reply. Both checks matter: the origin check stops any other frame on the page
 * from injecting a session, and the nonce check ties the reply to this specific login attempt.
 */
export function listen({ expectedOrigin = location.origin, getNonce, onAuth, onNoise }) {
  function handler(event) {
    const data = event.data;
    if (!data || data.type !== MESSAGE_TYPE) return;
    if (event.origin !== expectedOrigin) {
      onNoise && onNoise({ reason: `origin mismatch: ${event.origin}`, event });
      return;
    }
    const expected = getNonce();
    if (!expected || data.nonce !== expected) {
      onNoise && onNoise({ reason: 'nonce mismatch or no login in flight', event });
      return;
    }
    onAuth(data);
  }
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

/** Called from the login tab once credentials are accepted. */
export function reply({ nonce, replyTo, user, token, claims, wroteCookies }) {
  const payload = { type: MESSAGE_TYPE, nonce, user, token, claims, wroteCookies };
  const targets = [];
  if (window.opener) targets.push({ name: 'window.opener', win: window.opener });
  if (window.parent && window.parent !== window) targets.push({ name: 'window.parent', win: window.parent });

  const results = targets.map((t) => {
    try {
      t.win.postMessage(payload, replyTo);
      return { target: t.name, ok: true };
    } catch (e) {
      return { target: t.name, ok: false, error: e.message };
    }
  });

  // Secondary channel, included to demonstrate that it does *not* cross a partition boundary.
  let broadcast = { ok: false, error: 'BroadcastChannel unavailable' };
  try {
    const bc = new BroadcastChannel('demo-auth');
    bc.postMessage(payload);
    bc.close();
    broadcast = { ok: true, note: 'sent, but only arrives if both contexts share a partition' };
  } catch (e) {
    broadcast = { ok: false, error: e.message };
  }

  return { results, broadcast, delivered: results.some((r) => r.ok) };
}
