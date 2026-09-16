# Cookie & Frame Lab — a Miro Web SDK app

Built to answer one question, the kind that comes up whenever a software vendor wants to put their
own editing surface inside a Miro board:

> Can a third-party app render an authenticated, interactive editing surface inside a Miro board —
> third-party cookies, SSO, session persistence?

The short answer is yes, with one design constraint: **the session has to be established inside the
partition the panel runs in.** This app demonstrates that rather than asserting it — every claim on
screen is measured at runtime, in whichever browser you are holding.

**Live app:** https://charliewinters.github.io/miro-iframe-cookie-lab/
**The lab surface:** https://charliewinters.github.io/miro-iframe-cookie-lab/lab.html

## What it does

A three.js viewer floats extruded 3D text in a board panel. The text is not app state — it is
whatever a cookie says it is. So "did the cookie survive?" is answered by looking at the 3D scene:
your word, or the `HELLO MIRO` default.

One page, `lab.html`, runs in three contexts — Miro panel, Miro modal, and an ordinary top-level
tab — and labels which one it is in. Comparing the same page across contexts is the whole
experiment.

| Card | Question it answers |
| --- | --- |
| 1. Cookie & storage write matrix | Which `SameSite` / `Partitioned` combination can actually be written and read from inside the board iframe, and whether `localStorage` still works when none of them do |
| 2. Is this context partitioned? | Whether the panel and a normal tab share one storage jar or two |
| 3. Authenticating from inside the board | The popup → `postMessage` → in-frame cookie handshake, plus the Storage Access API alternative |
| 4. Framing policy | What `frame-ancestors` does to the panel, and what it costs to get it wrong |
| 5. Environment & export | Raw diagnostics, a findings JSON, and a button that writes the results onto the board |

## Install it on a board

1. https://miro.com/app/settings/user-profile/apps → **Create new app**, pick a developer team.
2. Paste `app-manifest.yaml` into the app's **App manifest** editor and save. It sets
   `sdkUri` to the GitHub Pages URL and requests `boards:read` + `boards:write`.
3. **Install app and get OAuth token** → install on your developer team.
4. Open a board on that team. The app appears in the left toolbar; clicking it opens the lab panel.

Nothing needs building or hosting — the app is plain static files with a vendored copy of three.js,
served straight from Pages. `boards:write` is only used by the "Write findings onto the board"
button; drop it from the manifest if you would rather not grant it.

## Suggested run-through for Tuesday

Roughly ten minutes, and it builds to the architectural point.

1. **Open the panel.** Banner reads *Miro board iframe — panel (third-party)*. The 3D text shows
   the default, so nothing has been stored yet.
2. **Type `dog` and press Set on `SameSite=Lax`.** The row reports the write as dropped and the
   viewer does not change. Lax cookies are invisible to a cross-site frame — this is the failure
   most integrations hit first.
3. **Set the same value via `SameSite=None; Secure; Partitioned`.** In Chrome it sticks, and the
   3D text becomes `dog`. Reload the panel: still `dog`. That is session persistence inside the
   board. In Safari expect this row to be dropped too — WebKit has not shipped CHIPS and gives a
   third-party frame no cookies at all. Fall to the last row, `localStorage`, which does persist
   there. The 3D text does not care which store won, which is the point.
4. **Click "Open this lab in a new tab".** Same URL, now first-party. Note the partition id and
   context stamp in card 2 — in a browser that partitions, they differ from the panel's, and the
   3D text falls back to the default even though the panel still says `dog`. Two jars, one origin.
5. **Card 3, "Sign in".** A top-level tab opens. Point out that this is the only place credentials
   can be collected: identity providers refuse to be framed, and the frame often cannot write a
   session cookie anyway. Sign in; the tab writes its own first-party cookies, hands the session
   back over `postMessage`, and closes itself.
6. **Back in the panel:** signed in. The log shows the panel re-persisting the session into *its
   own* partition, and says which stores accepted it — in Safari that will be `localStorage` alone.
   Reload — still signed in. The handshake is what works everywhere; which store catches the
   session afterwards is per-browser, and the log tells you.
7. **"Request storage access".** The supported route to the *unpartitioned* jar. Useful as an
   upgrade path, but it needs a user gesture and recent first-party interaction, so it cannot be
   the only route.
8. **Card 4, switch the policy to `frame-ancestors 'self'`.** The panel goes blank with the reason.
   This is what the partner app's panel will look like if the header is not right, and it is the one thing
   Miro cannot fix from its side.

Finish with **"Write findings onto the board"** so the measured results land next to the discussion.

## Things worth knowing before you demo

- **Run it in the browsers that matter**, ideally Chrome and Safari side by side. The answers
  differ, which is why the app measures rather than predicts. Chrome with default settings still
  allows third-party cookies, so almost everything works and the partitioning story is easy to
  under-sell.

  Measured in a headless WebKit 26.4 (Safari's engine) with the live app framed cross-site: every
  cookie write was dropped, including the `Partitioned` one, and `navigator.cookieEnabled` read
  `false` — while `localStorage` stayed readable and writable. Repeat runs were not consistent:
  after a first-party visit to the app, the same frame reported `hasStorageAccess() === true` and
  cookie writes succeeded. Automation builds also differ from shipping Safari on ITP heuristics.
  Treat all of that as a reason to run the lab live on the machine you are presenting from rather
  than as a settled result — and expect `localStorage` to be the row that carries Safari.
- **`frame-ancestors` cannot be demonstrated for real from GitHub Pages** — Pages sends no custom
  headers, and the directive is ignored in a `<meta>` tag. Card 4 enforces the same allowlist in
  JavaScript, which is both a truthful reproduction of the user-visible effect and what you are
  left with on a host that cannot set headers. For the genuine header, `_headers` in this repo works
  as-is on Netlify or Cloudflare Pages (`netlify deploy --dir=.`), and the "Probe a host that
  refuses framing" button shows a real header-level refusal using github.com.
- **Text written onto the board is rewritten first.** Miro's WAF rejects payloads that look like
  cookie headers, and the findings are almost entirely `name=value; attribute` strings, so
  `src/miro.js` reshapes them (`SameSite=None; Secure` becomes `SameSite None + Secure`) before the
  board write. Same information, no 403.
- **The session token is an unsigned stub minted in the browser.** It exists so the demo has
  something to pass through the handshake. `server-reference.md` has the headers and the token
  handling a real deployment needs.
- **GitHub Pages project sites share a cookie host.** Everything under
  `charliewinters.github.io` is one cookie origin, and `github.io` is on the Public Suffix List, so
  a cookie cannot be scoped to the whole account. The lab scopes its cookies to its own deployment
  path to stay out of the way. A production integration on its own domain has no such problem —
  worth saying out loud if anyone asks whether the constraints here are Miro's. They are not.

## Local development

```bash
python3 -m http.server 8099        # then open http://localhost:8099/lab.html
```

`embed-test.html` frames the lab at panel and modal widths, standing in for the board. Serve it from
a *different* origin than the lab (e.g. `http://127.0.0.1:8098/embed-test.html?base=http://localhost:8099/`)
or the frames are same-origin and the browser applies no cross-site rules at all.

## Layout

```
index.html              app entry — registers the toolbar handler, opens the panel
lab.html                the lab, used as panel / modal / tab
auth.html               top-level login tab; postMessages the session back
embed-test.html         local stand-in for the board
src/cookies.js          write strategies, read-back verification
src/probes.js           context, storage, partition id, Storage Access API
src/localstore.js       localStorage fallback store, for frames that get no cookies
src/framepolicy.js      frame-ancestors simulation and real-header probe
src/authbridge.js       nonce, token stub, postMessage handshake
src/viewer3d.js         three.js floating 3D text
src/miro.js             Web SDK wrapper (loaded only inside a board)
src/lab.js              wiring
vendor/                 three.js r180 + helvetiker fonts, MIT
app-manifest.yaml       paste into the Miro developer dashboard
_headers                real frame-ancestors header, for a host that can send it
server-reference.md     the headers a production the partner app deployment would set
```
