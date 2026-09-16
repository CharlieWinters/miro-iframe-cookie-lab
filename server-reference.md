# What a real deployment sends

The lab writes cookies from JavaScript because GitHub Pages cannot send response headers. The
browser applies identical rules either way, but a production integration should set them
server-side. These are the exact headers the partner app would need.

## Session cookie

The pattern that works in every current browser: the session is established **inside the
partition that will use it**, and the cookie is partitioned.

```
Set-Cookie: demo_session=<opaque-ref>; Path=/; Max-Age=3600;
            HttpOnly; Secure; SameSite=None; Partitioned
```

- `SameSite=None` — mandatory, or the cookie is never sent from a cross-site iframe.
- `Secure` — mandatory alongside `SameSite=None`.
- `Partitioned` (CHIPS) — the cookie is keyed on (top-level site, our site). A session established
  under `miro.com` is separate from one established in a normal tab. That is the intended
  behaviour: it is what makes the cookie acceptable to browsers that would otherwise refuse or
  partition it anyway.
- `HttpOnly` — the lab omits it because the demo has to read the value from script. Production
  should keep it on.

If a browser does not implement CHIPS it ignores the unknown attribute and treats the cookie as a
plain `SameSite=None` third-party cookie — so the header above degrades to "works where third-party
cookies are allowed" rather than breaking.

## Framing

```
Content-Security-Policy: frame-ancestors https://miro.com https://*.miro.com
```

Notes that cost people time:

- `frame-ancestors` replaces `X-Frame-Options`. If both are sent, CSP wins in modern browsers, but
  a stale `X-Frame-Options: SAMEORIGIN` in front of a CDN will still blank the panel in older ones.
  Remove it rather than relying on precedence.
- `frame-ancestors` is **ignored** in `<meta http-equiv="Content-Security-Policy">`. It only works
  as a response header. This is why the in-app policy switcher is a JavaScript stand-in.
- The directive must be sent by the **framed** document (the partner app), not by Miro.
- `https://*.miro.com` does not match `https://miro.com`; list both.

## nginx

```nginx
location / {
  add_header Content-Security-Policy "frame-ancestors https://miro.com https://*.miro.com" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  # Do not send X-Frame-Options at all.
}
```

## CloudFront / ALB

Set the same value in a response-headers policy. Watch for an origin that also sets
`X-Frame-Options` — CloudFront will happily forward both.

## If the surface needs the unpartitioned session

Two supported routes, in preference order:

1. **Establish the session in-partition** (what this lab does): a top-level tab authenticates, hands
   a session reference back over `postMessage`, and the frame exchanges it for its own partitioned
   cookie. No special browser permission, no prompt, works in Safari.
2. **Storage Access API**: the frame calls `document.requestStorageAccess()` from a user gesture.
   Grants the frame the unpartitioned jar, but requires recent first-party interaction with the
   embedded site and may show a prompt. Good as an upgrade path, not as the only path.
