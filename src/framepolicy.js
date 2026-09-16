/**
 * Framing policy experiments.
 *
 * The real control is a response header:
 *
 *   Content-Security-Policy: frame-ancestors https://miro.com https://*.miro.com
 *
 * GitHub Pages cannot send response headers, and `frame-ancestors` is explicitly ignored when it
 * arrives in a `<meta http-equiv>` tag, so this module does two things instead:
 *
 *   1. Enforces the same allowlist in JavaScript, which is what you are left with on a host that
 *      cannot set headers. It shows the user-visible effect — a blank panel — and it is a genuine
 *      (if bypassable) control: an attacker who controls the embedder cannot fake ancestorOrigins.
 *   2. Offers a live check against a site that really does refuse framing, so the header-level
 *      behaviour can be seen next to the simulated one.
 *
 * `_headers` and `nginx.conf.example` in the repo root carry the real thing for a host that can.
 */

const KEY = 'demo_frame_policy';
const MIRO_ALLOW = ['https://miro.com', 'https://*.miro.com'];

export const POLICIES = {
  off: {
    label: 'No policy (any site may embed)',
    header: "frame-ancestors *",
    allow: null,
  },
  miro: {
    label: "Allow Miro only",
    header: "frame-ancestors https://miro.com https://*.miro.com",
    allow: MIRO_ALLOW,
  },
  self: {
    label: "frame-ancestors 'self' (blocks Miro)",
    header: "frame-ancestors 'self'",
    allow: [],
  },
  wrong: {
    label: 'Allow a different partner only (blocks Miro)',
    header: 'frame-ancestors https://app.partner.example',
    allow: ['https://app.partner.example'],
  },
};

function store() {
  try {
    return localStorage;
  } catch (e) {
    return null;
  }
}

export function getPolicyName() {
  const params = new URLSearchParams(location.search);
  const override = params.get('policy');
  if (override && POLICIES[override]) return override;
  const s = store();
  const saved = s && s.getItem(KEY);
  return saved && POLICIES[saved] ? saved : 'off';
}

export function setPolicyName(name) {
  const s = store();
  if (s && POLICIES[name]) s.setItem(KEY, name);
}

function matches(pattern, origin) {
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+') + '$'
  );
  return re.test(origin);
}

/**
 * Decide whether the current embedder is allowed under the selected policy.
 * `determined` is false when the browser will not tell us who the embedder is — Firefox does not
 * implement `location.ancestorOrigins`, so a JS gate has to fail open there. A real header does
 * not have this problem, which is the point worth making out loud.
 */
export function evaluate() {
  const name = getPolicyName();
  const policy = POLICIES[name];
  const framed = window.top !== window.self;

  if (!framed) {
    return { name, policy, framed, allowed: true, determined: true, reason: 'Loaded at top level; frame-ancestors does not apply.' };
  }
  if (policy.allow === null) {
    return { name, policy, framed, allowed: true, determined: true, reason: 'Policy allows any embedder.' };
  }

  let origins = [];
  let determined = false;
  try {
    if (location.ancestorOrigins) {
      origins = Array.from(location.ancestorOrigins);
      determined = true;
    }
  } catch (e) {
    determined = false;
  }
  if (!determined && document.referrer) {
    try {
      origins = [new URL(document.referrer).origin];
      determined = true;
    } catch (e) {
      /* leave undetermined */
    }
  }

  if (!determined) {
    return {
      name,
      policy,
      framed,
      allowed: true,
      determined: false,
      reason:
        'Embedder origin is not exposed to script in this browser (no location.ancestorOrigins, no referrer). ' +
        'A JS gate must fail open here; the CSP header would still be enforced.',
    };
  }

  const blocked = origins.filter((o) => !policy.allow.some((p) => matches(p, o)));
  return {
    name,
    policy,
    framed,
    origins,
    allowed: blocked.length === 0,
    determined: true,
    reason: blocked.length
      ? `Embedder ${blocked.join(', ')} is not in the allowlist (${policy.allow.join(' ') || 'empty'}).`
      : `Embedder ${origins.join(', ')} matches the allowlist.`,
  };
}

/** Render the "blocked" screen a real frame-ancestors violation would produce. */
export function renderBlocked(root, verdict) {
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'blocked';
  box.innerHTML = `
    <h2>Blocked by framing policy</h2>
    <p class="mono">${verdict.policy.header}</p>
    <p>${verdict.reason}</p>
    <p class="muted">
      This is the JavaScript stand-in for a <code>Content-Security-Policy: frame-ancestors</code>
      header. With the real header the browser refuses the load outright and the app never runs —
      the panel is simply empty, with a console error on the Miro side.
    </p>
    <button id="unblock" class="primary">Reset policy to "no policy" and reload</button>
  `;
  root.appendChild(box);
  box.querySelector('#unblock').addEventListener('click', () => {
    setPolicyName('off');
    location.reload();
  });
}

/**
 * Load a URL that really does send a restrictive framing header, to show the header-level
 * behaviour. A blocked cross-origin frame never fires `load`, and its `contentWindow.length`
 * stays 0 — that difference is all script is allowed to observe.
 */
export function probeRealHeader(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      iframe.remove();
      resolve({ url, ...result });
    };
    const timer = setTimeout(
      () => done({ framed: false, verdict: 'No load event — the host refuses to be framed.' }),
      timeoutMs
    );
    iframe.addEventListener('load', () =>
      done({ framed: true, verdict: 'Loaded — this host permits framing from our origin.' })
    );
    iframe.addEventListener('error', () => done({ framed: false, verdict: 'Load error.' }));
    iframe.src = url;
    document.body.appendChild(iframe);
  });
}
