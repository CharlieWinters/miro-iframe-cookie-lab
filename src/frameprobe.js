/**
 * Card 6 — Embed ↔ app frame channel.
 *
 * The question: can a widget embedded on a board (an iframe with NO Miro SDK)
 * reach one of this app's own iframes (panel or headless, which DO have the
 * SDK) and get board data back?
 *
 * Why it is not obvious: the embed has no window reference to the app's frames,
 * they are siblings under miro.com's top-level document, and Miro may sandbox
 * the embed. This module is the app-side half; `embed-probe.html` is the embed
 * side. Four channels are tried independently so the result is a matrix rather
 * than a yes/no:
 *
 *   postMessage   walk the frame tree from window.top and post to each frame.
 *                 `length` and indexed access are on the cross-origin property
 *                 allowlist, so this is the only channel that would also work
 *                 if the embed were on a DIFFERENT origin than the app.
 *   BroadcastChannel / localStorage / SharedWorker
 *                 same-origin only, and additionally require both contexts to
 *                 share a storage partition key. They are available here only
 *                 because this app's sdkUri and the embed page are the same
 *                 origin.
 *
 * Auth note: the token lives in the embed widget's own URL on the board, so
 * checking it proves the sender can see that widget. Origin is not sufficient —
 * a sandboxed embed arrives as the literal "null".
 */

import { loadSdk } from './miro.js';

const PROBE_PAGE = 'embed-probe.html';
const BC_NAME = 'clab-probe';
const LS_REQ = 'clab-probe:req';
const LS_RESP = 'clab-probe:resp';
const WORKER_URL = './src/probe-sharedworker.js';

const MSG = {
  hello: 'clab-probe:hello',
  here: 'clab-probe:here',
  read: 'clab-probe:read-connected',
  connected: 'clab-probe:connected',
  error: 'clab-probe:error',
  appReady: 'clab-probe:app-ready',
  openPanel: 'clab-probe:open-panel',
  panelResult: 'clab-probe:panel-result',
};

/* --------------------------------------------------------------- utilities */

function stripHtml(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/** Cards keep their text in title/description, not content — and a connected
 * card is the case this probe exists to demonstrate. */
function readText(item) {
  if (item.type === 'sticky_note' || item.type === 'text' || item.type === 'shape') {
    return stripHtml(item.content) || null;
  }
  if (item.type === 'card' || item.type === 'app_card') {
    const parts = [stripHtml(item.title), stripHtml(item.description)].filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (item.type === 'frame') return stripHtml(item.title) || null;
  return null;
}

function itemLink(boardId, itemId) {
  return `https://miro.com/app/board/${boardId}/?moveToWidget=${itemId}&cot=14`;
}

/** Which app surface is this? Useful data: it tells you whether the headless
 * iframe alone is enough, or whether the panel has to be open. */
function surfaceName() {
  const file = location.pathname.split('/').pop() || 'index.html';
  if (file === '' || file === 'index.html') return 'headless (sdkUri)';
  const ctx = new URLSearchParams(location.search).get('ctx');
  return ctx ? `lab.html (${ctx})` : 'lab.html';
}

/* ------------------------------------------------------- board-side reading */

/** Found by URL rather than metadata: the widget may have been created by
 * another surface, or by REST, so it carries no metadata under our key. */
async function findProbeEmbed(probeId) {
  const miro = await loadSdk();
  const embeds = await miro.board.get({ type: 'embed' });
  let match =
    embeds.find((e) => typeof e.url === 'string' && probeId && e.url.includes(`probeId=${probeId}`)) ||
    embeds.find((e) => typeof e.url === 'string' && e.url.includes(PROBE_PAGE));
  if (!match) {
    const all = await miro.board.get();
    match = all.find((i) => typeof i.url === 'string' && i.url.includes(PROBE_PAGE));
  }
  if (!match) return null;
  let urlToken = null;
  try {
    urlToken = new URL(match.url).searchParams.get('token');
  } catch (e) {
    urlToken = null;
  }
  return { widget: match, urlToken };
}

async function readConnected(widget) {
  const miro = await loadSdk();
  const info = await miro.board.getInfo();
  const connectorIds = widget.connectorIds || [];
  if (!connectorIds.length) {
    return { count: 0, items: [], boardId: info.id, boardName: info.title || info.id };
  }

  const connectors = await miro.board.get({ id: connectorIds });
  const pairs = [];
  for (const c of connectors) {
    const startItem = c.start && c.start.item;
    const endItem = c.end && c.end.item;
    const other = startItem === widget.id ? endItem : endItem === widget.id ? startItem : undefined;
    if (!other) continue;
    const caption = stripHtml(c.captions && c.captions[0] && c.captions[0].content);
    pairs.push({ itemId: other, caption: caption || null });
  }
  if (!pairs.length) {
    return { count: 0, items: [], boardId: info.id, boardName: info.title || info.id };
  }

  const fetched = await miro.board.get({ id: pairs.map((p) => p.itemId) });
  const byId = new Map(fetched.map((i) => [i.id, i]));
  const items = [];
  for (const { itemId, caption } of pairs) {
    const item = byId.get(itemId);
    if (!item) continue;
    items.push({
      id: itemId,
      type: item.type,
      connectorCaption: caption,
      text: readText(item),
      link: itemLink(info.id, itemId),
    });
  }
  return { count: items.length, items, boardId: info.id, boardName: info.title || info.id };
}

/* -------------------------------------------------------------- responder */

/**
 * Answers probe requests on all four channels. Safe to call from every app
 * surface — the embed reports which one replied first, which is itself a
 * finding (does the headless iframe suffice, or must the panel be open?).
 */
export function initResponder() {
  const surface = surfaceName();
  const sendBack = {
    postMessage: null, // filled per-event
    broadcast: null,
    localstorage: null,
    sharedworker: null,
  };

  async function buildReply(data) {
    const found = await findProbeEmbed(data.probeId);
    if (!found) {
      return {
        type: MSG.error,
        token: data.token,
        via: data.via,
        surface,
        error: `No embed whose URL contains ${PROBE_PAGE} was found on this board.`,
      };
    }
    if (found.urlToken && data.token && found.urlToken !== data.token) {
      return null; // token mismatch: stay silent
    }
    if (data.type === MSG.hello) {
      return {
        type: MSG.here,
        token: data.token,
        via: data.via,
        surface,
        appOrigin: location.origin,
      };
    }
    const payload = await readConnected(found.widget);
    return {
      type: MSG.connected,
      token: data.token,
      via: data.via,
      surface,
      appOrigin: location.origin,
      embedWidgetFound: true,
      embedWidgetId: found.widget.id,
      ...payload,
    };
  }

  /**
   * Opens a panel at an arbitrary URL, on behalf of whichever surface asked.
   *
   * Two things are being measured, and both decide real design questions:
   *
   * 1. Does openPanel accept an ABSOLUTE cross-origin URL, the way openModal
   *    turned out to? If it does, a spawner panel can be served from a
   *    developer's own machine and keep calling its local server directly
   *    (/api/browse, /api/pty/start) even while the app's sdkUri is public.
   * 2. Does a second openPanel REPLACE the open one, or sit beside it? That
   *    settles whether several panels can be laid out at once — the docs cap
   *    modals at one explicitly but say nothing about panels.
   *
   * Routed through the headless iframe deliberately: the SDK documents
   * openPanel as being called from there, and a surface asking for its own
   * replacement is exactly the signalling path a real spawner would use.
   */
  async function doOpenPanel(url) {
    if (!/headless/i.test(surface)) {
      throw new Error(`refusing: this is "${surface}", not the headless iframe`);
    }
    const miro = await loadSdk();
    await miro.board.ui.openPanel({ url });
  }

  function handlePanel(data, respond) {
    doOpenPanel(data.url)
      .then(() => respond({ type: MSG.panelResult, token: data.token, surface, ok: true, url: data.url }))
      .catch((err) =>
        respond({
          type: MSG.panelResult,
          token: data.token,
          surface,
          ok: false,
          url: data.url,
          error: String((err && err.message) || err),
        })
      );
  }

  function handle(data, respond) {
    if (!data || typeof data !== 'object') return;
    if (data.type === MSG.openPanel) { handlePanel(data, respond); return; }
    if (data.type !== MSG.hello && data.type !== MSG.read) return;
    buildReply(data)
      .then((reply) => {
        if (reply) respond(reply);
      })
      .catch((err) => {
        respond({
          type: MSG.error,
          token: data.token,
          via: data.via,
          surface,
          error: String((err && err.message) || err),
        });
      });
  }

  // --- channel 1: postMessage ----------------------------------------------
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== MSG.hello && data.type !== MSG.read && data.type !== MSG.openPanel) return;
    handle({ ...data, via: 'postMessage' }, (reply) => {
      // A sandboxed embed has an opaque origin, which no exact targetOrigin can
      // ever match, so '*' is the only way to answer it at all.
      const target = event.origin === 'null' ? '*' : event.origin;
      try {
        event.source.postMessage(reply, target);
      } catch (e) {
        /* frame went away */
      }
    });
  });

  // --- channel 2: BroadcastChannel -----------------------------------------
  let bc = null;
  try {
    bc = new BroadcastChannel(BC_NAME);
    bc.addEventListener('message', (event) => {
      handle({ ...(event.data || {}), via: 'broadcast' }, (reply) => bc.postMessage(reply));
    });
  } catch (e) {
    console.warn('[probe] BroadcastChannel unavailable in this surface:', e.name);
  }

  // --- channel 3: localStorage + storage event ------------------------------
  try {
    window.addEventListener('storage', (event) => {
      if (event.key !== LS_REQ || !event.newValue) return;
      let data = null;
      try {
        data = JSON.parse(event.newValue);
      } catch (e) {
        return;
      }
      handle({ ...data, via: 'localstorage' }, (reply) => {
        try {
          localStorage.setItem(LS_RESP, JSON.stringify({ ...reply, nonce: Math.random() }));
        } catch (e) {
          /* storage refused */
        }
      });
    });
  } catch (e) {
    console.warn('[probe] storage events unavailable:', e.name);
  }

  // --- channel 4: SharedWorker ----------------------------------------------
  try {
    const worker = new SharedWorker(new URL(WORKER_URL, location.href), { name: BC_NAME });
    worker.port.start();
    worker.port.addEventListener('message', (event) => {
      handle({ ...(event.data || {}), via: 'sharedworker' }, (reply) =>
        worker.port.postMessage(reply)
      );
    });
  } catch (e) {
    console.warn('[probe] SharedWorker unavailable in this surface:', e.name);
  }

  console.log(`[probe] responder listening — surface: ${surface}, origin: ${location.origin}`);
  void sendBack;
}

/* ----------------------------------------------------- fixture construction */

/**
 * Creates the probe embed plus three connected items in one call.
 *
 * mode:'inline' is load-bearing: only an inline embed renders as a live iframe
 * that can run the probe script. A URL-preview embed would show a link card and
 * the test would never start.
 */
export async function createProbeFixture() {
  const miro = await loadSdk();
  const probeId = crypto.randomUUID();
  const token = crypto.randomUUID();

  const url = new URL(PROBE_PAGE, location.href);
  url.searchParams.set('probeId', probeId);
  url.searchParams.set('token', token);
  url.searchParams.set('appOrigins', location.origin);

  const vp = await miro.board.viewport.get();
  const cx = vp.x + vp.width / 2;
  const cy = vp.y + vp.height / 2;

  const embed = await miro.board.createEmbed({
    url: url.toString(),
    mode: 'inline',
    x: cx + 340,
    y: cy,
    origin: 'center',
    width: 860,
    height: 760,
  });

  // One item per case the reader has to handle: a card (title + description), a
  // sticky (content), and a "LINK_" caption that should resolve to a link.
  const card = await miro.board.createCard({
    title: 'Embed reads this card',
    description: 'Text came from the board, through the app iframe, into the embed.',
    x: cx - 760,
    y: cy - 280,
  });
  const sticky = await miro.board.createStickyNote({
    content: 'Uncaptioned connector — feeds the flat input list',
    x: cx - 760,
    y: cy + 20,
  });
  const text = await miro.board.createText({
    content: 'Captioned LINK_1 — expect a board link, not content',
    x: cx - 820,
    y: cy + 320,
    width: 360,
  });

  await miro.board.createConnector({
    start: { item: card.id },
    end: { item: embed.id },
    captions: [{ content: 'BRIEF' }],
    shape: 'straight',
  });
  await miro.board.createConnector({
    start: { item: sticky.id },
    end: { item: embed.id },
    shape: 'straight',
  });
  await miro.board.createConnector({
    start: { item: text.id },
    end: { item: embed.id },
    captions: [{ content: 'LINK_1' }],
    shape: 'straight',
  });

  await miro.board.viewport.zoomTo([embed, card, sticky, text]);
  return { probeId, token, embedId: embed.id, url: url.toString() };
}
