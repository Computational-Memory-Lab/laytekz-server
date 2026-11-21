# Laytekz: maintainer notes for this fork of Aldine

Laytekz is a deployment of [Aldine](https://github.com/trahloff/Aldine)
(AGPL-3.0) with server, compiler and web patches, published under its own
name (section 5). This branch (`galley`) sits on upstream `v1.16.0-3-gdd6df67`.
"Galley" was the working name; it survives only in internal identifiers that
nobody using the product sees (this file's name, the branch, the `Galley:`
comment marker, `GALLEY_*` variables, `galley-*` file names, the
`galley-source` meta tag). Upstream's own docs (README, CHANGELOG, AGENTS.md)
are left untouched; this file is the only record of what differs.

Every fork hunk inside an upstream file is either in a file listed below as
new, or carries a `Galley:` comment (`git grep -n "Galley:"`), except the
one-line `discardHandoffCodesForUser` calls in `auth.ts`, the source-link
imports in the web app, and the product-name strings of section 5
(`git grep -n "PRODUCT_NAME\|PRODUCT_KIND"` finds every one).

## 1. Listen address (`HOST`)

- **What:** `apps/server/src/index.ts` listens on `process.env.HOST`
  (default `0.0.0.0`, upstream's); `apps/compiler/server.js` does the same
  (default: all interfaces).
- **Why:** on a host without a container network around the two services, both must
  listen on `127.0.0.1`; the Cloudflare Tunnel reaches the app there. The
  compiler also requires a token on loopback (section 6).

## 2. Desktop sign-in handoff

- **What:** a native app (the Electron shell) gets a full web session without
  running the identity provider's page in an embedded webview, which Google
  refuses. RFC 8252 loopback redirect with PKCE (S256).
- **Where:**
  - `apps/server/src/desktop-handoff.ts` (new): redirect URI validation, the
    signed handoff cookie (HMAC under `subkey('desktop-handoff')`), the tie
    between a sign-in attempt and its handoff (`attemptTag`), the confirmation
    form's tag (`confirmationTag`), duplicate-cookie detection
    (`cookieCount`), in-memory one-time codes.
  - `apps/server/src/routes.ts`, directly after the SSO callback:
    `GET /api/auth/desktop/start`, `GET /api/auth/desktop/continue`,
    `POST /api/auth/desktop/approve`, `POST /api/auth/desktop/exchange`.
  - `apps/server/src/routes.ts`, existing routes: `GET
    /api/auth/oauth/:provider` adds `desktop.<attemptTag>` to the OAuth state
    cookie when the link carries `desktop=1` (only the handoff's own redirects
    do) and the browser holds a handoff, and clears a handoff cookie when the
    link does not carry it. The SSO callback refuses a state cookie that
    appears twice in the Cookie header; after a successful sign-in it hands
    the new session to the handoff (a MAC of the session id in the cookie, then
    a redirect to `/api/auth/desktop/continue`) only when the attempt's tag
    matches the handoff the browser holds now; any other sign-in clears the
    handoff and lands on the app. An account waiting for approval clears it
    too.
  - `apps/server/src/auth.ts`: `discardHandoffCodesForUser` next to each
    `discardCodesForUser` (disable, delete, and `revokeAgentAccess`, which a
    password change or reset runs).
  - `apps/server/src/oauth/pkce.ts` (new): `CODE_CHALLENGE_RE`, `VERIFIER_RE`
    and `pkceMatches`, moved verbatim out of `oauth/routes.ts` and
    `oauth/token.ts` (which now import them) so `auth.ts` can reach them
    through `desktop-handoff.ts` without an import cycle.
- **Contract** (binding for the Electron app; `BASE` is `ALDINE_PUBLIC_URL`):
  1. The app makes a verifier (32 random bytes, base64url), the S256
     challenge, and a state (16 to 128 base64url characters), and listens on
     `http://127.0.0.1:<port>/callback` (or `http://[::1]:<port>/callback`),
     port 1024 to 65535.
  2. It opens the system browser at `BASE/api/auth/desktop/start?code_challenge=…&code_challenge_method=S256&redirect_uri=…&state=…[&provider=<id>]`.
     The redirect URI must be exactly in the form the URL parser prints (no
     leading zeros, lowercase scheme, no trailing slash) and at most 200
     characters.
  3. The browser signs in. If it signed in during this flow it is redirected
     straight on; if it was already signed in, it shows a confirmation page
     naming the account, whose Continue and Cancel buttons post to
     `/api/auth/desktop/approve`. Either way it ends at
     `<redirect_uri>?code=…&state=…`, or `<redirect_uri>?error=access_denied&state=…`
     on Cancel.
  4. The app checks state and posts, from its own browser session,
     `BASE/api/auth/desktop/exchange` with `Content-Type: application/json`
     and `{"code","code_verifier","redirect_uri"}`. Success: 200
     `{"user":{…}}` and `Set-Cookie: aldine_session=…`. Failure: 400
     `{"error":"invalid_grant"}`, 415 for a non-JSON body, 429 when rate
     limited, 403 for a bearer token or a foreign `Origin`. Codes are single
     use and live 60 seconds.
  5. The app reloads; sign-out is the web app's `POST /api/auth/logout`.
- **Security properties:**
  - The browser is only ever redirected to a URI that passed
    `validLoopbackRedirect`, re-checked whenever it is read back from the
    cookie, so the flow is no open redirect.
  - A sign-in reaches a handoff only if it started from that handoff's own
    provider link: a second `/start` opened while the person is on the
    provider's page (a local process, another tab), or a handoff cookie
    planted by a sibling subdomain, gets nothing; the sign-in then lands on
    the app and the handoff ends.
  - A browser that was already signed in must confirm on a page that names
    the account before a code exists. The form carries a MAC of the handoff
    and account it shows, and approve acts only when that matches the handoff
    cookie: Continue on one confirmation page never issues a code for another
    handoff started in the same browser since (both end instead). Approve
    also checks `Origin` against the public origin and that the account is
    the one shown. Cancel goes through the server, which ends the handoff
    before redirecting to the app with `access_denied`. A signed-out browser
    at `/continue`, a refused approve and an account waiting for approval all
    end the handoff.
  - In the live layout (no base path, `Secure` cookies) the handoff cookie is
    `__Host-aldine_desktop_handoff`, which a sibling subdomain can neither set
    nor shadow; under a base path it is `aldine_desktop_handoff`. A handoff or
    OAuth state cookie that appears twice in the Cookie header (one scoped to
    the parent domain by a sibling site) counts as none.
  - Codes are stored by SHA-256, burned on first presentation before any
    await, bound to the challenge and redirect URI, at most 5 pending per
    account and 1000 in all. Exchange requires JSON, refuses bearer tokens,
    uses the OAuth token limiter, refuses missing or disabled accounts, ends
    the window's previous session, never puts the session id in a body, and
    answers `cache-control: no-store`. Works for every configured provider;
    with several, `/start` shows a script-free chooser.
- **Known limits:**
  - Codes are in memory (single node; a restart during a sign-in loses it,
    the app retries).
  - A sign-in inside the flow continues without a click. With Google
    (`prompt=select_account`) the person always picks an account first. An
    OIDC provider that signs in silently, and GitHub or ORCID once the person
    has authorized this server's app there (their authorize URLs send no
    `prompt`), would let a local process that opens `/start` obtain a session
    with no click. RFC 8252 flows trust local processes to that extent.
  - Upstream's login CSRF remains: the Google leg has no PKCE or nonce, and
    the OAuth state and session cookies have no `__Host-` prefix, so a sibling
    subdomain that plants its own state cookie can sign the browser in to the
    attacker's account on the web. It no longer reaches the desktop app (the
    planted attempt carries no tie to the handoff). Renaming upstream's
    cookies signs everyone out and touches every upstream OAuth test, so it is
    left for upstream.

## 3. Origin checks

- **What:** `apps/server/src/origin-check.ts` (new). The collab WebSocket
  upgrade (`index.ts`) and every `POST`/`PUT`/`PATCH`/`DELETE` (an `onRequest`
  hook registered first in `app.ts`) are refused with 403 when an `Origin`
  header is present and is not the origin of `ALDINE_PUBLIC_URL`. The only
  exceptions are the cookie-less protocol endpoints browser-based OAuth and
  MCP clients call from their own origin: `/oauth/token`, `/oauth/register`,
  `/oauth/revoke` and `/mcp`.
- **The route, not the URL:** the hook tests the matched route pattern
  (`req.routeOptions.url`), because the router decodes percent-escapes before
  matching: `/%61pi/auth/logout` reaches `/api/auth/logout`, and a test of
  the raw URL let sibling sites through that way. A request no route matched
  is checked like any other.
- **Why:** the session cookie is `SameSite=Lax`, and every subdomain of
  the site's registrable domain counts as the same site, so a sibling site could otherwise
  open an authenticated collab socket or send cookie-carrying POSTs.
- **Unaffected:** requests without `Origin` (bearer-token REST and MCP
  clients, curl), reads, the protocol endpoints above, and everything when
  `ALDINE_PUBLIC_URL` is unset. No upstream test or flow needed another
  exemption.
- **Consequence:** the app accepts state-changing browser requests only from
  `ALDINE_PUBLIC_URL`'s origin; opening it at `http://127.0.0.1:3040` in a
  browser lets you read but not change anything (its cookies are `Secure`
  anyway).

## 4. AGPL source offer

- **What:** `apps/server/src/galley-source.ts` (new) and
  `apps/web/src/source.ts` (new). `GALLEY_SOURCE_URL` (an http(s) URL, or a
  path on this origin) replaces upstream's repository in the web app's
  source links: About's "Get the source" and the project list's
  "Source code" colophon (`components/About.tsx`, `pages/Home.tsx`), and the
  sign-in card's small print (`components/ProductCredit.tsx`). Without
  it, `GALLEY_SOURCE_TARBALL` (a file on the server) is served at
  `<base path>/source.tar.gz` and the links lead there. The server stamps the
  link into `index.html` as `<meta name="galley-source">`.
- **The tarball route:** downloads as `laytekz-source.tar.gz` whatever the
  file is called on the server, sends `ETag` (size and modification time) and
  `Last-Modified` with `cache-control: no-cache`, and answers 304 to a
  matching `If-None-Match` or `If-Modified-Since`. The stamped link carries
  the version (`/source.tar.gz?v=<size>-<time>`), also when
  `GALLEY_SOURCE_URL` names this server's own `/source.tar.gz` (as
  `deploy/config/app.env.template` does): Cloudflare gives browsers a
  4-hour `max-age` whatever the origin sends, and a new link after a deploy is
  a new URL, so nobody keeps an older tarball.
- **`<base path>/source`:** a `no-store` redirect to wherever the offer points
  now (`GALLEY_SOURCE_URL`, the current tarball, or upstream). The desktop
  app's About box and Help menu link there, so they follow the server's
  configuration.
- **Why:** AGPL-3.0 section 13: users of a modified instance over a network
  must be offered the corresponding source of the running version. Upstream
  shows no source link on the sign-in page; this fork does, since signing in
  is where people first meet the app.
- **Keeping it true:** the tarball (or the URL) must match the code that is
  running. Rebuild it on every deploy, for example
  `git archive --format=tar.gz --prefix=laytekz/ -o ~/galley-server/galley-source.tar.gz HEAD`
  plus `git diff HEAD` if the running tree has uncommitted changes.

## 5. Product name (Laytekz), credit and privacy page

- **What:** the product calls itself Laytekz wherever a person sees a name,
  says "Based on Aldine" with a link to upstream, and has a privacy page.
- **The name, in two constants:** `apps/web/src/product.ts` and
  `apps/server/src/product.ts` (new) hold `PRODUCT_NAME`, the upstream name
  and URL, and the rule that an operator name equal to the product name counts
  as unset (`isProductName`; server `productTitle`). Every user-visible string
  imports them: tab titles (`util/documentTitle.ts`), the wordmark, About,
  the project list's colophon, command palette entries, the default commit
  message and git-host token names (`remotes.tsx`, `RemoteSync.tsx`, the push
  routes in `routes.ts`), messages in account settings, admin dialogs,
  sharing, the template sheet, the OAuth consent page and the Claude/ChatGPT
  connect steps (the suggested `claude mcp add` name is the lowercase product
  name); on the server, the sign-in, error and desktop pages (`authPage` in
  `routes.ts`), `index.html`'s title (`instance.ts`), every email
  (`email.ts`, `invites.ts`, the confirmation mail in `routes.ts`), OIDC
  sign-in errors (`oidc.ts`), venue-kit notices written into new projects
  (`venuekits.ts`) and the starting points generated from installed classes
  (`catalog.ts`), the base-path pointer (`app.ts`), the source tarball's
  download name (`galley-source.ts`), the MCP tool texts and `resource_name`
  (`mcp/tools.ts`, `oauth/metadata.ts`) and the MCP PDF viewer
  (`viewer/src/main.ts`, which sets its title and "Open in" label at start).
  `apps/web/index.html` carries the name as plain text;
  `apps/web/src/__tests__/product.test.ts` fails when the three disagree.
- **Mark:** `components/LogoMark.tsx` (new) is the desktop app icon
  (`desktop/build/icon.svg`) drawn from its 32 px source with flat fills;
  `components/Wordmark.tsx` is that mark plus the name in the UI typeface
  (replacing upstream's drawn "aldine." wordmark), `Wordmark.css` keeps the
  links around it from underlining it, and `index.html`'s favicon is the same
  drawing as a data URI.
- **Credit and notices:** `components/ProductCredit.tsx` (new): "Based on
  Aldine" (linking upstream) · Source code · Privacy under the sign-in card;
  About shows the product line, the build, "Based on Aldine `<version>`, with
  changes made for this site. Aldine © 2026 Tobias Rahloff", the AGPL notice,
  the privacy link and "Get the source"; the colophon reads
  `Laytekz · Based on Aldine <version> · AGPL-3.0 · Source code · Privacy`.
  The desktop app's About box says "Based on Aldine" with the upstream link,
  the AGPL note with `<server>/source`, and `<server>/privacy`.
- **Operator branding:** `ALDINE_INSTANCE_NAME` still works as upstream's
  operator name, now after the product's: `Projects – Laytekz · Kiel
  University`. Set to the product's own name (any case) it counts as unset,
  so nothing reads "Laytekz · Laytekz". Server-rendered pages are titled
  `… · Laytekz` (`… · Laytekz · <operator>`); the desktop pages say "the
  Laytekz desktop app".
- **Privacy page:** `GET <base path>/privacy` (route in `routes.ts`, next to
  the sign-in pages) renders `apps/server/src/privacy.ts` in the sign-in
  pages' script-free shell, readable signed out. The text is plain HTML at
  the top of that file, written for latex.devon7y.com as it runs now; it
  fills in the product name and the support contact (`ALDINE_SUPPORT` or the
  one set on /admin), or says to ask the person who invited you. Review it
  whenever the deployment changes (email, backups, AI, error tracking).
  `vite.config.ts` proxies `/privacy`, `/source` and `/source.tar.gz` for
  `npm run dev`.
- **Machine names left as upstream's on purpose:** `ALDINE_*` variables,
  `aldine.*` storage keys, `aldine_*` cookies, `X-Aldine-Token`,
  `"name":"aldine"` in `/api/health`, the MCP server name and
  `ui://aldine/pdf-viewer`, `createdByAldine`, the `[aldine]` log prefix and
  operator-only log and startup messages, outgoing `User-Agent`/`X-Title`
  headers, and the git identity `Aldine` and the `aldine:` subject prefix of
  autosave commits. Those two are seen on commits pushed to a connected
  GitHub or GitLab repository; History and `gitops.ts` recognise system
  commits by that author name and `util/history.ts` parses the prefix, so
  renaming them would change behaviour and split old histories (a rename
  needs both names recognised; not done).

## 6. Compile path hardening

Upstream leaves several weaknesses of the compile service to its Docker
sandbox (an internal network, a container per service). On a shared host
they matter, so the fork closes them in the code. Fork hunks carry
`Galley:` comments; `apps/compiler/guard.js` is new.

- **Main document names reach a shell.** latexmk runs the engine through
  `/bin/sh` with the root file name inside double quotes, and its own refusal
  list leaves out the backtick, so a main document named
  ``p1`cd .aldine-out;touch PWNED`.tex`` ran that command (confirmed on a
  throwaway instance; the deployment's sandbox contained it to the project's
  writable folders). Both validators now use one allowlist per path segment:
  letters and combining marks of any script, digits, the space and
  `. _ - ( ) +`; no segment starting with `-`, no `..`, no empty or `.`
  segment, nothing inside `.git` or `.aldine*`, at most 255 bytes per name
  and 900 per path. Server: `invalidRootFile` in `apps/server/src/util.ts`
  (the settings route, and every typeset in `compile.ts`). Compiler:
  `rootFileProblem` in `apps/compiler/guard.js` (`/compile`, `/synctex`).
  `test/rootfile-guard.test.mjs` keeps the two in step.
- **Existing projects.** A stored main document that breaks the rules (made
  before them, or arriving through git, an import or a project created from
  such a file) is not typeset. The typeset answers 400 with
  `Can’t typeset “…”. Main document name cannot contain …: rename the file
  using letters, digits, spaces and . _ - ( ) + only, then typeset again.`
  (`rootFileRenameMessage`), and the compiler is not called. Template-repo
  previews skip such a root with a logged reason. Automatic main-document
  detection (`root.ts`) and file create/rename still accept such names; using
  one as the main document is what is refused.
- **The compiler API had no authentication.** With `COMPILER_TOKEN` set on
  the compiler, every route except `GET /health` answers 401 unless the
  request carries the same value in `x-compiler-token`. The check runs before
  the body is read and compares SHA-256 digests with `timingSafeEqual`. The
  app sends the header on every call (`compilerHeaders()` in `util.ts`:
  typeset, stop, SyncTeX and format in `compile.ts`, `/health` there and in
  `templatepreviews.ts`, the catalog in `catalog.ts`, template-preview
  typesets). A 401 or 403 becomes `CompilerAuthError` (a 503 that names the
  setting, logged at most once a minute, never with the value).
- **Startup rule** (`startupProblem`): the compiler exits with status 78 when
  `HOST` is set to a loopback or all-interfaces address (`127.x`, `::1`,
  `localhost`, `0.0.0.0`, `::`) and no token is set, unless
  `COMPILER_ALLOW_UNAUTHENTICATED=1`. **`HOST` unset (upstream's default and
  its compose files) needs no token**: there the compiler is alone in its
  network namespace on an internal network, so upstream's container
  deployment keeps working unchanged. A specific interface address is taken
  as the operator's isolated network. A token, when set, must be at least 32
  visible ASCII characters. The compiler deletes the token from
  `process.env` right after reading it, so no tool it starts inherits it, and
  its startup line says `auth=token` or `auth=none`, never the value.
- **Bounded input and output.** Bodies of `/compile`, `/synctex` and `/stop`
  over 64 KB get 413 (`/format` keeps its own limit). A child's captured
  output keeps its first 256 KB and last 1 MB (`OutputBuffer`), the format
  build's 64 KB, the catalog probes' 8 MB. SyncTeX lookups accept only
  integer lines, columns and pages and finite coordinates.
- **Exact directory checks.** A `projectDir` must resolve strictly inside
  `DATA_DIR`: a sibling sharing its prefix (`data2/`) and `DATA_DIR` itself
  are refused (`projectRootIn`), for `/compile`, `/stop` and `/synctex`.
- **Time limits under a proxy.** `/compile` takes `timeoutMs`, the caller's
  budget for the whole request: the wait for a compile slot counts, each
  latexmk run gets `min(COMPILE_TIMEOUT_MS, time left)`, and a typeset that
  runs out answers `timedOut: true` with a first error row saying it was
  stopped. On the app, `COMPILE_DEADLINE_MS` (unset: no limit, upstream's
  behaviour) bounds a typeset request from its arrival, the wait behind the
  branch's earlier typesets included: the app passes the time left to the
  compiler, answers a typeset with less than 3 s left as timed out without
  sending it, and if the compiler has not answered shortly after the deadline
  it sends `/stop` and answers timed out. Set it below the proxy's limit
  (Cloudflare: about 100 s), so people see "Typesetting was stopped: this
  server answers a typeset within N s …" instead of the proxy's error page.

## Environment for these patches

| Variable | Side | Value for latex.devon7y.com | Default | Section |
| --- | --- | --- | --- | --- |
| `HOST` | app and compiler | `127.0.0.1` | all interfaces | 1 |
| `ALDINE_PUBLIC_URL` | app | `https://latex.devon7y.com` | unset: the Origin checks are off, cookies not `Secure` | 2, 3 |
| `AUTH_ENABLED` | app | `1` | off | 2 |
| `TRUST_PROXY` | app | `1` (the tunnel is one hop) | off: every client behind the tunnel shares one rate-limit bucket, the exchange's included | 2 |
| `GALLEY_SOURCE_TARBALL` and/or `GALLEY_SOURCE_URL` | app | a tarball path, or a public URL of this fork's source | unset: upstream's repository | 4 |
| `ALDINE_INSTANCE_NAME` | app | unset (the product name is built in; a value equal to it counts as unset) | unset | 5 |
| `ALDINE_SUPPORT` | app | optional: an address or https page; the privacy page names it for deletion requests | unset | 5 |
| `COMPILER_TOKEN` | app and compiler, same value | 64 random base64url characters, generated on the server by `deploy/setup.sh` (or `deploy.sh` when missing) | unset: no token sent or required | 6 |
| `COMPILER_ALLOW_UNAUTHENTICATED` | compiler | unset | unset (`1` starts on loopback without a token) | 6 |
| `COMPILE_DEADLINE_MS` | app | `90000` | unset: no limit | 6 |
| `COMPILE_TIMEOUT_MS` | compiler | `85000` (one latexmk run) | `120000` | 6 |

## Tests

`npm run test:unit -w apps/server` runs every `apps/server/test/*.test.mjs`.
The fork's own:

- `desktop-handoff.test.mjs`: validation, the whole chain under a base path,
  the exchange, refused codes and confirmations, Cancel through the server,
  the chooser.
- `desktop-handoff-attacks.test.mjs`: the live layout (no base path, `Secure`,
  `__Host-` handoff cookie): a second `/start` while the person is on the
  provider's page, a planted OAuth state cookie, two confirmation pages,
  Cancel then a stale Continue, an account waiting for approval, a signed-out
  `/continue`, duplicate cookies, `revokeAgentAccess`, the exchange ending the
  window's previous session, concurrent exchanges and the cap on codes.
- `origin-check.test.mjs`: the helper, percent-encoded paths, unknown routes,
  the protocol endpoints, the WebSocket handshake (on a standalone server,
  not `index.ts`'s handler).
- `galley-source.test.mjs`, `privacy.test.mjs`.
- `rootfile-guard.test.mjs` (both validators, the rename message),
  `compiler-guard.test.mjs` (token check, startup rule, directory checks,
  body and output caps), `compiler-auth.test.mjs` (the real compiler with a
  stand-in latexmk: startup refusal, 401s, 413, refused names, the token not
  reaching latexmk, request budgets), `compiler-token-app.test.mjs` (the app
  against a mock compiler: the header on every call, `CompilerAuthError`,
  refused stored roots, the deadline).

`npm run test -w apps/web` adds `apps/web/src/util/__tests__/source.test.ts`
and `apps/web/src/__tests__/product.test.ts`. Upstream tests that asserted
"Aldine" in titles, mails, token pages and messages now assert Laytekz (server:
`instance`, `signup-approval`, `welcome-mail`, `admin-reset-mail`,
`venue-kits`, `oidc`, `templates`; web: `remotes`, `instance`; e2e:
`01-home`, `54-menus-appearance`, `33-remotes`, `40-connect-claude`,
`base-path-tests/`, `auth-tests/`). No Playwright spec covers the handoff in
a real browser yet (form-action on the redirect to the loopback, SameSite on
the provider round trip, Chrome's Local Network Access). On the server,
`deploy/libexec/verify-compiler.sh` and `deploy/libexec/smoke-instance.sh
--verify` check section 6 against the live sandbox.

## Rebasing onto a new upstream release

```bash
git fetch upstream --tags
git switch galley
git rebase vX.Y.Z            # or: git merge vX.Y.Z
git grep -n "Galley:"        # every fork hunk in an upstream file
npm install && npm run typecheck -w apps/web && npm run build
npm run test:unit -w apps/server && npm run test -w apps/web
```

Likely conflicts: `routes.ts` around the provider start, the SSO callback
and `signInFailed` (the shell was factored into `authPage`; re-apply by
keeping upstream's markup inside it), `auth.ts` near `discardCodesForUser`,
`oauth/token.ts` and `oauth/routes.ts` if upstream changes the PKCE helpers
(move any change into `oauth/pkce.ts`), the upgrade handler in `index.ts`,
the source link constants in `About.tsx` and `Home.tsx`, and any
user-visible string upstream reworded that this fork routes through
`PRODUCT_NAME` (keep upstream's new wording, put the constant back). Then run
`git grep -n "Aldine" apps/web/src apps/server/src apps/server/viewer` and
route any new user-visible "Aldine" through the constants.

Check also that upstream added no state-changing route that a client on
another origin must reach with a browser `Origin` (it now gets 403 unless
it joins `PROTOCOL_ROUTES` in `origin-check.ts`), no new way to sign in that
skips the SSO callback (a desktop handoff would not continue from it), and no
new reader of the OAuth state cookie that would not expect the `desktop`
purpose. On the compiler: keep `guard.js` in the Dockerfile's `COPY` line. If
upstream adds a route to the compiler, it is behind the token automatically
(the check runs before routing); if it adds a call from the app to the
compiler, pass `compilerHeaders()`. If upstream changes `invalidRootFile` in
either place, merge it into the allowlist rather than back to a blocklist.

## Trademark (TRADEMARK.md)

The AGPL covers the code; "Aldine" and its logo are the upstream author's
marks. Permission is not needed to run Aldine, but upstream asks to be asked
first for "a modified version distributed under the Aldine name" (name it
something of your own and say "based on Aldine") and for "a hosted service
whose name or domain is built on 'Aldine'". Its test: if users could
reasonably think they get the thing maintained at github.com/trahloff/Aldine,
use the name; if they would be wrong, use your own. Registering "Aldine" or a
confusingly similar name as a trademark, company name or domain for such
software is not allowed. Laytekz runs modified code under its own name,
mark and domain and says "Based on Aldine" (section 5), which is what the
page asks for. Licence notices and attribution must stay.
