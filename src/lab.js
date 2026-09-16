/**
 * Lab wiring. One page, three contexts: Miro panel, Miro modal, top-level tab.
 *
 * Everything on screen is measured at runtime rather than asserted, because the answers differ
 * per browser and per browser setting, and a demo that states them from memory is worthless in
 * front of a customer.
 */

import * as cookies from './cookies.js';
import * as probes from './probes.js';
import * as framepolicy from './framepolicy.js';
import * as bridge from './authbridge.js';
import * as miroSdk from './miro.js';
import { createViewer } from './viewer3d.js';

const DEFAULT_TEXT = 'HELLO MIRO';

const $ = (sel) => document.querySelector(sel);

const state = {
  ctx: probes.context(),
  viewer: null,
  writeResults: {}, // variant key -> last write result
  auth: null, // { user, token, claims, source }
  nonce: null,
  frameVerdict: null,
  storageAccess: { supported: probes.storageAccess.supported, has: null, lastRequest: null },
  probeLog: [],
};

/* ------------------------------------------------------------------ helpers */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function kv(dl, rows) {
  dl.innerHTML = '';
  for (const [k, v, cls] of rows) {
    dl.appendChild(el('dt', {}, k));
    dl.appendChild(el('dd', { class: cls || '' }, String(v)));
  }
}

function pill(text, kind) {
  return el('span', { class: `pill ${kind}` }, text);
}

function logTo(target, message, kind = '') {
  const box = $(target);
  const line = el('div', { class: `log-line ${kind}` }, `${new Date().toLocaleTimeString()}  ${message}`);
  box.prepend(line);
  while (box.children.length > 40) box.lastChild.remove();
}

/* ----------------------------------------------------------- 3D text source */

/** First readable cookie wins; the order in TEXT_VARIANTS is the preference order. */
function resolveText() {
  for (const spec of cookies.TEXT_VARIANTS) {
    const value = cookies.read(spec);
    if (value !== null && value !== '') {
      return { text: value, source: spec, fallback: false };
    }
  }
  return { text: DEFAULT_TEXT, source: null, fallback: true };
}

function renderViewerText({ unsaved = null } = {}) {
  if (!state.viewer) return;
  const resolved = resolveText();
  const text = unsaved !== null ? unsaved : resolved.text;
  // Kept short: this string is extruded into the 3D scene, not laid out as HTML.
  let sub;
  if (unsaved !== null) sub = 'unsaved - no cookie yet';
  else if (resolved.fallback) sub = 'default - no cookie readable here';
  else sub = `from ${resolved.source.name}`;

  const clean = state.viewer.setText(text, sub);
  const meta = $('#viewer-meta');
  meta.innerHTML = '';
  meta.append(
    resolved.fallback && unsaved === null
      ? pill('default text', 'warn')
      : pill(unsaved !== null ? 'unsaved' : resolved.source.short, unsaved !== null ? 'warn' : 'ok'),
    el('span', {}, ` ${sub}`),
    clean.dropped
      ? el('span', { class: 'muted' }, `  ·  ${clean.dropped} character(s) dropped: the vendored font is Latin-only`)
      : ''
  );
}

/* ------------------------------------------------------------ cookie matrix */

function renderCookieTable() {
  const tbody = $('#cookie-table tbody');
  tbody.innerHTML = '';
  const jar = cookies.readAll();

  for (const spec of cookies.TEXT_VARIANTS) {
    const present = Object.prototype.hasOwnProperty.call(jar, spec.name);
    const result = state.writeResults[spec.key];

    const writeCell = el('td', {});
    if (!result) writeCell.append(el('span', { class: 'muted' }, 'not tried'));
    else if (result.persisted) writeCell.append(pill('kept', 'ok'));
    else writeCell.append(pill('dropped', 'bad'));

    tbody.appendChild(
      el(
        'tr',
        {},
        el('td', {}, el('div', { class: 'strong' }, spec.short), el('div', { class: 'mono tiny' }, spec.label)),
        writeCell,
        el('td', {}, present ? pill('yes', 'ok') : pill('no', 'bad')),
        el('td', { class: 'mono tiny wrap' }, present ? jar[spec.name] : '—'),
        el(
          'td',
          {},
          el(
            'button',
            {
              class: 'small-btn',
              onclick: () => setVia(spec),
              title: spec.note,
            },
            'Set'
          )
        )
      )
    );
  }

  const note = $('#cookie-note');
  note.innerHTML = '';
  const ul = el('ul', { class: 'note-list' });
  for (const spec of cookies.TEXT_VARIANTS) {
    ul.appendChild(el('li', {}, el('span', { class: 'strong' }, `${spec.short}: `), spec.note));
  }
  note.appendChild(ul);
}

function setVia(spec) {
  const value = ($('#text-input').value || '').trim() || DEFAULT_TEXT;
  const result = cookies.write(spec, value);
  state.writeResults[spec.key] = result;

  if (result.persisted) {
    logTo('#auth-log', `Wrote ${spec.name} (${spec.label}) = "${value}"`, 'ok');
  } else {
    logTo(
      '#auth-log',
      `Write of ${spec.name} (${spec.label}) did not stick in this context. read-back=${JSON.stringify(result.readBack)}`,
      'bad'
    );
  }
  renderCookieTable();
  renderViewerText();
  renderPartitionReport();
}

/* ------------------------------------------------- partitioning + env cards */

function renderPartitionReport() {
  const s = probes.storage();
  const stamp = cookies.read(cookies.STAMP_COOKIE);
  kv($('#partition-report'), [
    ['Context', state.ctx.label],
    ['Origin', state.ctx.origin],
    ['Embedder', state.ctx.embedder || 'none (top level)'],
    ['localStorage partition id', s.partition.available ? s.partition.id + (s.partition.minted ? '  (minted just now)' : '') : `unavailable — ${s.partition.reason}`],
    ['Context stamp cookie', stamp || 'not readable here'],
    ['navigator.cookieEnabled', String(s.cookieEnabled)],
    ['localStorage', s.local.available ? 'readable/writable' : `blocked — ${s.local.reason}`],
    ['sessionStorage', s.session.available ? 'readable/writable' : `blocked — ${s.session.reason}`],
  ]);
}

async function renderEnvReport() {
  const b = probes.browserLabel();
  const sandbox = probes.sandboxInfo();
  state.storageAccess.has = await probes.storageAccess.has();
  kv($('#env-report'), [
    ['Browser', `${b.name} · ${b.platform}`],
    ['This URL', location.href],
    ['top === self', String(window.top === window.self)],
    ['location.ancestorOrigins', state.ctx.ancestorOriginsSupported ? JSON.stringify(state.ctx.ancestorOrigins) : 'not implemented in this browser'],
    ['document.referrer', state.ctx.referrer || '(empty)'],
    ['Opaque origin (sandboxed)', String(sandbox.opaqueOrigin)],
    ['frameElement readable', String(sandbox.frameElementReadable) + (sandbox.sandboxAttr ? ` · sandbox="${sandbox.sandboxAttr}"` : '')],
    ['Storage Access API', state.storageAccess.supported ? 'available' : 'not implemented'],
    ['document.hasStorageAccess()', state.storageAccess.has === null ? 'n/a' : String(state.storageAccess.has)],
  ]);
}

/* --------------------------------------------------------------- frame card */

function renderFrameCard() {
  const select = $('#policy-select');
  if (!select.options.length) {
    for (const [name, policy] of Object.entries(framepolicy.POLICIES)) {
      select.appendChild(el('option', { value: name }, policy.label));
    }
    select.value = framepolicy.getPolicyName();
    select.addEventListener('change', () => {
      framepolicy.setPolicyName(select.value);
      logTo('#frame-log', `Policy set to "${select.value}". Reloading to apply.`);
      setTimeout(() => location.reload(), 350);
    });
  }

  const v = state.frameVerdict;
  $('#policy-header').textContent = `Content-Security-Policy: ${v.policy.header}`;
  kv($('#frame-report'), [
    ['Embedded', String(v.framed)],
    ['Embedder origin(s)', v.origins ? v.origins.join(', ') : 'n/a'],
    ['Verdict', v.allowed ? 'allowed' : 'blocked'],
    ['Embedder determinable by script', String(v.determined)],
    ['Reason', v.reason],
  ]);
}

async function probeFrame(url, label) {
  logTo('#frame-log', `Probing ${label}…`);
  const result = await framepolicy.probeRealHeader(url);
  state.probeLog.push(result);
  logTo('#frame-log', `${label}: ${result.verdict}`, result.framed ? 'ok' : 'bad');
}

/* ---------------------------------------------------------------- auth card */

function readSession() {
  for (const spec of cookies.SESSION_COOKIES) {
    const raw = cookies.read(spec);
    if (!raw) continue;
    const claims = bridge.decodeToken(raw);
    if (!claims) continue;
    if (claims.exp && claims.exp * 1000 < Date.now()) {
      cookies.remove(spec);
      continue;
    }
    return { user: claims.sub, token: raw, claims, source: spec };
  }
  return null;
}

function renderAuthState() {
  const box = $('#auth-state');
  box.innerHTML = '';
  const session = state.auth;
  if (!session) {
    box.append(pill('signed out', 'warn'), el('span', {}, ' No readable session cookie in this context.'));
    return;
  }
  const expires = session.claims.exp ? new Date(session.claims.exp * 1000).toLocaleTimeString() : 'n/a';
  box.append(
    pill('signed in', 'ok'),
    el('span', {}, ` ${session.user}`),
    el(
      'div',
      { class: 'muted small' },
      `session read from ${session.source ? session.source.name + ' (' + session.source.short + ')' : 'postMessage only — not persisted'} · expires ${expires}`
    )
  );
}

/** Persist the session inside *this* frame, which is the partition that matters for the panel. */
function persistSession(token) {
  const outcomes = cookies.SESSION_COOKIES.map((spec) => {
    const r = cookies.write(spec, token);
    logTo(
      '#auth-log',
      `${r.persisted ? 'Persisted' : 'Could not persist'} session in ${spec.name} (${spec.label})`,
      r.persisted ? 'ok' : 'bad'
    );
    return r;
  });
  return outcomes;
}

function applyToken(token, { via }) {
  const claims = bridge.decodeToken(token);
  if (!claims || !claims.sub) {
    logTo('#auth-log', 'That does not decode as a demo session token.', 'bad');
    return;
  }
  persistSession(token);
  state.auth = readSession() || { user: claims.sub, token, claims, source: null };
  logTo('#auth-log', `Session accepted via ${via}: ${claims.sub} (checksum ${bridge.pairingCode(token)})`, 'ok');
  renderAuthState();
  renderPartitionReport();
  renderCookieTable();
}

function startLogin() {
  state.nonce = bridge.makeNonce();
  try {
    sessionStorage.setItem('demo_nonce', state.nonce);
  } catch (e) {
    /* in-memory nonce is enough for the demo */
  }
  const { handle, url, blocked } = bridge.openLogin({ nonce: state.nonce });
  if (blocked) {
    logTo('#auth-log', 'window.open was blocked. Open this URL manually, then paste the token back:', 'bad');
    const box = $('#auth-log');
    box.prepend(el('div', { class: 'log-line' }, el('a', { href: url, target: '_blank', rel: 'noopener' }, url)));
    return;
  }
  logTo('#auth-log', `Opened top-level login tab. Waiting for postMessage (nonce ${state.nonce.slice(0, 8)}…)`);
  // The popup may be closed without finishing; nothing breaks, the nonce simply goes unused.
  const poll = setInterval(() => {
    if (handle.closed) {
      clearInterval(poll);
      logTo('#auth-log', 'Login tab closed.');
    }
  }, 800);
}

async function requestStorageAccess() {
  const before = cookies.SESSION_COOKIES.map((s) => [s.name, cookies.read(s) ? 'visible' : 'hidden']);
  const result = await probes.storageAccess.request();
  state.storageAccess.lastRequest = result;
  if (result.granted) {
    logTo('#auth-log', 'Storage access granted — this frame now shares the unpartitioned cookie jar.', 'ok');
  } else {
    logTo('#auth-log', `Storage access refused: ${result.error}`, 'bad');
  }
  const after = cookies.SESSION_COOKIES.map((s) => [s.name, cookies.read(s) ? 'visible' : 'hidden']);
  for (let i = 0; i < before.length; i++) {
    if (before[i][1] !== after[i][1]) {
      logTo('#auth-log', `${before[i][0]}: ${before[i][1]} → ${after[i][1]}`, 'ok');
    }
  }
  state.auth = readSession();
  renderAuthState();
  await renderEnvReport();
  renderCookieTable();
  renderViewerText();
}

/* ------------------------------------------------------------------- export */

function collectFindings() {
  return {
    ...probes.fullReport(),
    framePolicy: {
      selected: state.frameVerdict.name,
      header: state.frameVerdict.policy.header,
      allowed: state.frameVerdict.allowed,
      determined: state.frameVerdict.determined,
      reason: state.frameVerdict.reason,
    },
    cookies: cookies.snapshot().map((row) => ({
      name: row.spec.name,
      attributes: row.spec.label,
      readable: row.present,
      value: row.value,
      lastWrite: state.writeResults[row.spec.key]
        ? { persisted: state.writeResults[row.spec.key].persisted, readBack: state.writeResults[row.spec.key].readBack }
        : null,
    })),
    viewerText: resolveText().text,
    viewerTextSource: resolveText().source ? resolveText().source.name : 'default',
    auth: state.auth
      ? { user: state.auth.user, source: state.auth.source ? state.auth.source.name : 'postMessage only', exp: state.auth.claims.exp }
      : null,
    storageAccess: state.storageAccess,
    framingProbes: state.probeLog,
  };
}

function findingsLines(f) {
  const lines = [
    `Context: ${f.context.label}`,
    `Browser: ${f.browser.name} (${f.browser.platform})`,
    `Embedder: ${f.context.embedder || 'none'}`,
    `localStorage partition id: ${f.storage.partition.id || 'n/a'}`,
    `Context stamp: ${(f.cookies.find((c) => c.name === 'demo_ctx_stamp') || {}).value || 'not readable'}`,
    '',
    'Cookie readability in this context:',
  ];
  for (const c of f.cookies) {
    if (c.name === 'demo_ctx_stamp') continue;
    lines.push(`  ${c.name} [${c.attributes}] -> ${c.readable ? 'readable' : 'not readable'}${c.lastWrite ? `, write ${c.lastWrite.persisted ? 'kept' : 'dropped'}` : ''}`);
  }
  lines.push('', `3D text shown: "${f.viewerText}" (source: ${f.viewerTextSource})`);
  lines.push(`Auth: ${f.auth ? f.auth.user + ' via ' + f.auth.source : 'signed out'}`);
  lines.push(`Storage Access API: ${f.storageAccess.supported ? 'available' : 'not implemented'}, hasStorageAccess=${f.storageAccess.has}`);
  lines.push(`Framing policy: ${f.framePolicy.header} -> ${f.framePolicy.allowed ? 'allowed' : 'blocked'}`);
  return lines;
}

/* --------------------------------------------------------------------- init */

async function init() {
  // Framing gate runs before anything else, exactly as a real CSP would.
  state.frameVerdict = framepolicy.evaluate();
  if (!state.frameVerdict.allowed) {
    framepolicy.renderBlocked($('#root'), state.frameVerdict);
    return;
  }

  // Stamp this context so another context can compare notes.
  cookies.write(cookies.STAMP_COOKIE, `${state.ctx.label} @ ${new Date().toLocaleTimeString()}`);

  $('#ctx-label').textContent = state.ctx.label;
  $('#ctx-detail').textContent = state.ctx.embedder
    ? `embedded by ${state.ctx.embedder}`
    : 'no embedder — this is a first-party page';
  document.body.classList.add(state.ctx.framed ? 'is-framed' : 'is-top');
  if (state.ctx.inMiro) document.body.classList.add('in-miro');

  // Viewer
  try {
    state.viewer = await createViewer($('#scene'));
    if (state.viewer.fontError) {
      $('#viewer-meta').textContent = 'Font failed to load: ' + state.viewer.fontError;
    }
  } catch (e) {
    $('#viewer-meta').textContent = 'WebGL unavailable: ' + e.message;
  }

  const resolved = resolveText();
  $('#text-input').value = resolved.fallback ? '' : resolved.text;
  $('#text-input').placeholder = DEFAULT_TEXT;
  renderViewerText();

  renderCookieTable();
  renderPartitionReport();
  renderFrameCard();
  await renderEnvReport();

  state.auth = readSession();
  renderAuthState();
  if (state.auth) logTo('#auth-log', `Restored session for ${state.auth.user} from ${state.auth.source.name}`, 'ok');

  // Live preview while typing; persistence still requires choosing a strategy.
  $('#text-input').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    renderViewerText({ unsaved: v === '' ? null : v });
  });

  $('#btn-reread').addEventListener('click', async () => {
    renderCookieTable();
    renderPartitionReport();
    renderViewerText();
    await renderEnvReport();
    logTo('#auth-log', 'Re-read cookies and storage.');
  });

  $('#btn-clear').addEventListener('click', () => {
    cookies.removeAll();
    state.writeResults = {};
    state.auth = null;
    renderCookieTable();
    renderPartitionReport();
    renderAuthState();
    renderViewerText();
    logTo('#auth-log', 'Cleared every demo_* cookie visible in this context.', 'warn');
  });

  $('#btn-reload').addEventListener('click', () => location.reload());

  $('#btn-login').addEventListener('click', startLogin);
  $('#btn-logout').addEventListener('click', () => {
    for (const spec of cookies.SESSION_COOKIES) cookies.remove(spec);
    state.auth = null;
    renderAuthState();
    renderCookieTable();
    logTo('#auth-log', 'Signed out and removed session cookies.', 'warn');
  });
  $('#btn-storage-access').addEventListener('click', requestStorageAccess);
  $('#btn-recheck').addEventListener('click', async () => {
    state.auth = readSession();
    renderAuthState();
    renderCookieTable();
    renderPartitionReport();
    await renderEnvReport();
    logTo('#auth-log', `Re-checked. Session: ${state.auth ? state.auth.user : 'none visible'}`);
  });
  $('#btn-token-apply').addEventListener('click', () => {
    const token = $('#token-input').value.trim();
    if (token) applyToken(token, { via: 'manual paste' });
  });

  $('#btn-probe-blocked').addEventListener('click', () => probeFrame('https://github.com/', 'github.com (sends X-Frame-Options: deny)'));
  $('#btn-probe-self').addEventListener('click', () => probeFrame(new URL('./index.html', location.href).href, 'this origin (no framing restriction)'));

  $('#btn-open-tab').addEventListener('click', () => {
    const url = new URL('./lab.html', location.href);
    url.searchParams.set('ctx', 'tab');
    window.open(url.toString(), '_blank', 'noopener');
  });

  $('#btn-open-modal').addEventListener('click', async () => {
    try {
      await miroSdk.openModal('lab.html?ctx=modal');
    } catch (e) {
      $('#export-note').textContent = 'Modal needs the Miro SDK: ' + e.message;
    }
  });

  $('#btn-copy').addEventListener('click', async () => {
    const json = JSON.stringify(collectFindings(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      $('#export-note').textContent = 'Findings JSON copied to the clipboard.';
    } catch (e) {
      $('#export-note').textContent = 'Clipboard blocked in this context — JSON logged to the console instead.';
      console.log(json);
    }
  });

  $('#btn-to-board').addEventListener('click', async () => {
    const f = collectFindings();
    try {
      await miroSdk.logToBoard({
        title: `Cookie & frame findings — ${f.context.label} — ${f.browser.name}`,
        lines: findingsLines(f),
      });
      $('#export-note').textContent = 'Findings written onto the board.';
    } catch (e) {
      $('#export-note').textContent = 'Could not write to the board: ' + e.message;
    }
  });

  // Reply channel from the login tab.
  bridge.listen({
    getNonce: () => {
      if (state.nonce) return state.nonce;
      try {
        return sessionStorage.getItem('demo_nonce');
      } catch (e) {
        return null;
      }
    },
    onAuth: (data) => {
      logTo('#auth-log', `postMessage received from the login tab for ${data.user}.`, 'ok');
      if (data.wroteCookies) {
        logTo(
          '#auth-log',
          `The login tab wrote its own cookies first-party: ${data.wroteCookies.join(', ')}. Whether this frame can see them is the interesting part.`
        );
      }
      applyToken(data.token, { via: 'postMessage from top-level tab' });
      state.nonce = null;
      try {
        sessionStorage.removeItem('demo_nonce');
      } catch (e) {
        /* ignore */
      }
    },
    onNoise: ({ reason }) => logTo('#auth-log', `Ignored a message: ${reason}`, 'warn'),
  });

  // Secondary channel, kept to demonstrate that it usually does not cross a partition.
  try {
    const bc = new BroadcastChannel('demo-auth');
    bc.addEventListener('message', (e) => {
      if (e.data && e.data.type === bridge.MESSAGE_TYPE) {
        logTo('#auth-log', 'BroadcastChannel delivered the session — this context shares a partition with the login tab.', 'ok');
      }
    });
  } catch (e) {
    /* not available; nothing to report */
  }

  if (state.ctx.inMiro) {
    miroSdk
      .boardInfo()
      .then((info) => {
        $('#ctx-detail').textContent += ` · board ${info.boardTitle || info.boardId}`;
      })
      .catch(() => {
        /* SDK not reachable; the rest of the lab still works */
      });
  } else {
    $('#btn-open-modal').disabled = true;
    $('#btn-to-board').disabled = true;
    $('#export-note').textContent = 'Board actions are disabled outside a Miro board.';
  }
}

init().catch((err) => {
  document.body.prepend(el('div', { class: 'banner bad' }, 'Lab failed to start: ' + err.message));
  console.error(err);
});
