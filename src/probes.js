/**
 * Environment probes: where am I embedded, what storage can I reach, and is this browsing
 * context partitioned away from the one next door?
 */

const MIRO_HOST = /(^|\.)miro\.com$/i;

function hostOf(origin) {
  try {
    return new URL(origin).hostname;
  } catch (e) {
    return '';
  }
}

/** Ancestor origins, outermost last. Chrome and Safari expose this; Firefox does not. */
export function ancestorOrigins() {
  try {
    const list = location.ancestorOrigins;
    if (!list) return { supported: false, origins: [] };
    return { supported: true, origins: Array.from(list) };
  } catch (e) {
    return { supported: false, origins: [] };
  }
}

export function context() {
  const params = new URLSearchParams(location.search);
  const declared = params.get('ctx'); // 'panel' | 'modal' | null
  const framed = window.top !== window.self;
  const { supported, origins } = ancestorOrigins();
  const referrerHost = hostOf(document.referrer);

  // Trust the measured embedder first. The `?ctx=` hint is only allowed to decide the question
  // when the browser refuses to name the embedder at all (Firefox exposes no ancestorOrigins, and
  // a strict referrer policy can leave us with nothing else to go on).
  const embedderKnown = origins.length > 0 || !!referrerHost;
  const inMiro =
    origins.some((o) => MIRO_HOST.test(hostOf(o))) ||
    (framed && MIRO_HOST.test(referrerHost)) ||
    (framed && !!declared && !embedderKnown);

  let label;
  if (!framed) label = 'Top-level tab (first-party)';
  else if (inMiro) label = `Miro board iframe${declared ? ` — ${declared}` : ''} (third-party)`;
  else label = 'Cross-site iframe, non-Miro embedder (third-party)';

  return {
    label,
    framed,
    inMiro,
    declared,
    origin: location.origin,
    ancestorOriginsSupported: supported,
    ancestorOrigins: origins,
    embedder: origins.length ? origins[origins.length - 1] : referrerHost ? `(referrer) ${referrerHost}` : null,
    referrer: document.referrer || null,
  };
}

/** Read the iframe's sandbox flags if the embedder set any. */
export function sandboxInfo() {
  const opaque = location.origin === 'null' || window.origin === 'null';
  let frameElementReadable = false;
  let sandboxAttr = null;
  try {
    // Cross-origin embedding makes this throw, which is itself the expected answer inside Miro.
    if (window.frameElement) {
      frameElementReadable = true;
      sandboxAttr = window.frameElement.getAttribute('sandbox');
    }
  } catch (e) {
    frameElementReadable = false;
  }
  return { opaqueOrigin: opaque, frameElementReadable, sandboxAttr };
}

function probeStorage(store, key) {
  try {
    const s = window[store];
    if (!s) return { available: false, reason: 'not exposed' };
    s.setItem(key, '1');
    const ok = s.getItem(key) === '1';
    s.removeItem(key);
    return { available: ok, reason: ok ? null : 'write silently dropped' };
  } catch (e) {
    return { available: false, reason: e.name + ': ' + e.message };
  }
}

/**
 * A random id minted once per storage partition. Compare the value shown in the board panel
 * against the value shown in a normal tab: same id means one shared jar, different ids mean the
 * browser has partitioned this origin's storage by top-level site.
 */
export function partitionId() {
  const KEY = 'demo_partition_id';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 8).toUpperCase();
      localStorage.setItem(KEY, id);
      return { id, minted: true, available: true };
    }
    return { id, minted: false, available: true };
  } catch (e) {
    return { id: null, minted: false, available: false, reason: e.name };
  }
}

export function storage() {
  return {
    local: probeStorage('localStorage', 'demo_probe'),
    session: probeStorage('sessionStorage', 'demo_probe'),
    partition: partitionId(),
    cookieEnabled: navigator.cookieEnabled,
  };
}

/** Storage Access API — the supported route back to the unpartitioned cookie jar. */
export const storageAccess = {
  supported: typeof document.requestStorageAccess === 'function',
  async has() {
    if (typeof document.hasStorageAccess !== 'function') return null;
    try {
      return await document.hasStorageAccess();
    } catch (e) {
      return null;
    }
  },
  /** Must be called directly from a user gesture or the browser rejects it. */
  async request() {
    if (typeof document.requestStorageAccess !== 'function') {
      return { granted: false, error: 'requestStorageAccess is not implemented in this browser' };
    }
    try {
      await document.requestStorageAccess();
      return { granted: true };
    } catch (e) {
      return {
        granted: false,
        error:
          (e && e.message) ||
          'Rejected. Browsers require a user gesture plus recent first-party interaction with this site.',
      };
    }
  },
};

/** Coarse browser label for the results matrix. Good enough to annotate a screenshot. */
export function browserLabel() {
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const brand = brands.find((b) => !/not.a.brand/i.test(b.brand));
  let name = brand ? `${brand.brand} ${brand.version}` : 'unknown';
  if (!brand) {
    if (/Firefox\/(\d+)/.test(ua)) name = 'Firefox ' + RegExp.$1;
    else if (/Edg\/(\d+)/.test(ua)) name = 'Edge ' + RegExp.$1;
    else if (/Chrome\/(\d+)/.test(ua)) name = 'Chrome ' + RegExp.$1;
    else if (/Version\/(\d+).*Safari/.test(ua)) name = 'Safari ' + RegExp.$1;
  }
  return { name, platform: navigator.platform, ua };
}

export function fullReport() {
  return {
    at: new Date().toISOString(),
    browser: browserLabel(),
    context: context(),
    sandbox: sandboxInfo(),
    storage: storage(),
    storageAccessSupported: storageAccess.supported,
    url: location.href,
  };
}
