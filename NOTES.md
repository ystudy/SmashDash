# Smash Dash — developer notes / handoff

Working notes for continuing this project in a fresh session. User-facing docs are in [README.md](README.md); this file is the engineering handoff.

Last updated: 2026-06-26 (session 2). Status: **v1 complete + 3 follow-up fixes (below), verified in-browser. Not yet committed.**

---

## Session 2 changes (2026-06-26)

1. **Reorder now persists in-session (bug fix).** Drag-reorder of pages/sections/items wrote to the DB but never updated the in-memory `state`, so the next full re-render (exiting edit mode, switching pages) repainted from stale state and the order appeared to "snap back". Fixed in `app.js`: the reorder callbacks now keep local state in sync — `applyOrder(arr, ids)` for pages and sections, `syncItemsFromDom()` for items (handles cross-section moves). Verified via simulated drag: DOM, `state`, and DB agree and survive a `renderApp()`.
2. **Profile avatars.** New nullable `users.avatar` column (migration in `db.js` via `PRAGMA table_info` + `ALTER TABLE`). Value convention matches icons (`ti-xxx` / `img:URL`; null → initials). `avatarHtml()` renders it in the topbar and user lists. Admins set it in the user form; any user sets their own via the new **Edit profile** item in the user-menu dropdown (`openProfile()` → `PUT /me/prefs {avatar}`). `getUserByToken` (auth.js) and `publicUser`/users routes (api.js) now carry `avatar`.
3. **"More than one category per page" — already supported.** User confirmed it was a discoverability gap, not a missing feature. Multiple sections (= categories) per page already work; **Add section** appears at the bottom of any page in Edit mode. No code change.
4. **Per-tile appearance (width / height / colour / icon size).** New nullable `items.width`, `items.height`, `items.color`, `items.icon_size` columns (migration in `db.js`; an earlier single `size` column is renamed to `width` via `ALTER TABLE … RENAME COLUMN`). Tile editor controls: a one-line **Size** control — `Width × Height`, each a `.cyc` button that cycles S→M→L→S on click (`cycleBtnHtml`/`wireCycle`/`readCycle`, with ↔/↕ glyphs marking the axis); an Icon size `.seg` segmented control; and a `tileColorPickerHtml` swatch row (palette + a `default` neutral). Render in `app.js` via classes `w-{sm,md,lg}` / `h-{sm,md,lg}` / `ic-{sm,md,lg}` and, when colour ≠ default, a `tinted` class + inline `--tile-c` consumed by CSS `color-mix()`. **Layout:** `.tiles` grid base track is `minmax(110px,1fr)` with `align-items:start` (so heights are independent, not equalised per row). Width = column span (sm=1, md=2, lg=3); `w-sm` goes compact-vertical (centred icon, no subtitle). Height = `min-height` (54/68/108px) with content vertically centred. `md`/`md` is the legacy look, so untouched tiles are unchanged. Verified end-to-end via the editor UI + computed styles (widths 119/250/381px, heights 54/80/108px); `color-mix` resolves correctly in-engine.
5. **Product-logo picker (Heimdall-style).** A **Logos** button in the icon field (`iconFieldHtml`/`wireIconField`) opens a search box + results grid of real product logos from [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons). The slug index (~2,798) is lazy-loaded once from `tree.json` on jsDelivr (`loadLogoIndex`, cached in `LOGO_INDEX`); search ranks `startsWith` then `includes`, caps at 60 results. Picking one stores `img:https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/<slug>.png` — **no data-model change** (reuses the existing `img:` icon convention, so it works for pages/sections/items/avatars alike). Tile + preview `<img>` switched to `object-fit: contain` so logos aren't cropped. **Online dependency:** the logo list and the logos themselves load from the jsDelivr CDN, so this picker needs internet — the Tabler icon set and the rest of the app remain fully offline. Offline-bundling the set is the agreed possible follow-up.
6. **Adjustable name/subtitle font size + Appearance sub-popup.** New `items.name_size`/`items.sub_size` columns drive `.tile` classes `nm-{sm,md,lg}` (12/14/16px) and `sb-{sm,md,lg}` (11/12/13.5px). To keep the tile editor short, all look controls (Size, Colour, Icon size, Name font, Subtitle font) moved out of the main form into an **Appearance** sub-popup: `openSubModal()` appends a second stacked `.modal-overlay.sub` (z-index 60) to `#modal-root` without destroying the parent; `openAppearance(ap, onApply)` live-syncs every control into a shared `ap` object (so closing any way keeps changes) and the main form's save reads from `ap`. Escape closes the topmost sub first. Verified: stacking (2 overlays, parent preserved), Done returns to parent, fonts persist + render (name 16px / subtitle 11px).
7. **Theme-switch tint flash fix + custom tile colours.** (a) Tinted tiles use `color-mix(... var(--card))`; on a theme change `--card` flips and `.tile`'s `transition: background` animated the mix through a washed, light **oklab** midpoint — looked like the colour "broke" mid-switch. Fix: `applyTheme()` adds `.theme-switching` to `<html>` (CSS `.theme-switching * { transition: none !important }`), flushes, then removes it on the next `requestAnimationFrame` — so theme swaps are instant, hover transitions still work. (b) Colour picker was limited to 9 palette keys; added a **custom-colour** swatch (rainbow `conic-gradient` wrapping a hidden `<input type="color">`) — any hex is stored directly in `items.color` (e.g. `#ff8800`) and `tileColorVar()` returns a leading-`#` value as-is. Verified: no-flash (immediate == settled), custom hex flows picker→summary→tile→DB.
8. **Phase 2 — status monitoring (built).** Live up/down dots via a backend pinger + `GET /api/status` + client poll. Full detail in the Phase 2 section below.

---

## What this is

A self-hosted dashboard for servers/services/links, **configured entirely in the browser — no YAML, no config files**. The organizing idea (and the thing that differentiates it from Heimdall, which the user finds "clunky") is a three-level hierarchy:

**Pages (tabs in a side rail) → Sections (titled panels) → Tiles (the link/server cards).**

Self-contained project in its own git repo.

## Stack

- **Backend:** Node.js (ESM) + Fastify 4. Single process.
- **DB:** SQLite via `better-sqlite3` (synchronous). One file under `DATA_DIR`.
- **Frontend:** Vanilla JS, no build step. One `index.html` + `app.js` + `styles.css`.
- **Icons:** Tabler icon **webfont**, self-hosted from `node_modules` (works offline).
- **Auth:** bcryptjs + opaque session token in an httpOnly cookie, sessions table in SQLite.
- **Deploy:** single Docker container, single SQLite file on a volume.

## File map

```
src/server.js   Fastify bootstrap, static serving, /vendor/tabler mount, SPA fallback
src/db.js       SQLite open + schema migrate() + seed() (admin, themes, settings, sample layout)
src/auth.js     hashPassword/verifyPassword, createSession/getUserByToken/destroySession
src/api.js      ALL /api routes (one Fastify plugin). Auth via preHandler that sets req.user.
public/index.html  shell: loads tabler css, styles.css, app.js, has #app + #modal-root
public/app.js      the entire SPA: state, render*, forms, icon picker, theme mgr, users, DnD
public/styles.css  all styling; CSS variables are the theming layer
Dockerfile, docker-compose.yml, .dockerignore, .gitignore, README.md
```

## Data model (SQLite)

- `users` — id, username (unique), password_hash, role (`admin`|`viewer`), theme (name pref, nullable), sidebar_collapsed (0/1), **avatar** (nullable; `ti-xxx` or `img:URL`, same convention as icons — null = initials), created_at
- `sessions` — id (random 32-byte hex token), user_id, expires_at (epoch ms)
- `pages` — id, name, icon, position, created_at
- `sections` — id, page_id (FK→pages, cascade), title, icon, color, position
- `items` — id, section_id (FK→sections, cascade), name, url, subtitle, icon, open_new_tab, **health_url** (reserved, phase 2), **width** (`sm`|`md`|`lg`, null=md; grid column span 1/2/3), **height** (`sm`|`md`|`lg`, null=md; min-height 54/80/108px), **color** (palette key, custom `#hex`, or `default`/null), **icon_size** (`sm`|`md`|`lg`|`xl`, null=md), **name_size**/**sub_size** (`sm`|`md`|`lg`|`xl`, null=md; name/subtitle font size), position
- `themes` — id, name (unique), is_dark, is_builtin, tokens (JSON string)
- `settings` — key/value (`app_title`, `default_theme`)

Icon value convention: `ti-xxx` (Tabler class), or `img:https://…` (custom image). Rendered by `iconHtml()` in app.js.

Section color value: one of `accent|blue|teal|green|purple|amber|red|pink|gray` (see `SECTION_COLORS` in app.js); `accent` maps to the theme accent, others to fixed hex tinted at 0.16 alpha.

## API surface (all under `/api`, JSON)

- Auth: `POST /login`, `POST /logout`, `GET /me`, `GET /public` (unauthenticated — login screen title+theme)
- Bootstrap: `GET /bootstrap` → `{ user, pages, themes, settings }`
- Prefs: `PUT /me/prefs` `{ theme?, sidebar_collapsed?, avatar? }` (any logged-in user; `avatar` powers self-service profile pic)
- Pages: `GET /pages`, `GET /pages/:id/full` (nested sections+items), `POST/PUT/DELETE /pages/:id`, `POST /pages/reorder {ids}`
- Sections: `POST/PUT/DELETE /sections/:id`, `POST /sections/reorder {ids}`
- Items: `POST/PUT/DELETE /items/:id`, `POST /items/reorder {section_id, ids}` (supports cross-section move)
- Themes: `GET /themes`, `POST/PUT/DELETE /themes/:id` (built-ins can't be deleted)
- Users: `GET/POST /users`, `PUT/DELETE /users/:id` (last-admin protection on demote/delete)
- Settings: `GET /settings`, `PUT /settings`

Write routes require admin (`requireAdmin`); reads require auth (`requireAuth`).

## Theming model

Themes are **data, not code** — same philosophy as the rest of the app. The whole UI renders from CSS variables (`--bg`, `--surface`, `--card`, `--text`, `--accent`, …). A theme is a row in `themes` whose `tokens` JSON maps to those vars. `applyTheme(tokens)` sets them on `document.documentElement`. `accentSoft` is auto-derived from `accent` at 0.16 alpha if absent. 5 built-ins: Dark, Light, Midnight, Slate, Nord. Per-user choice saved to `users.theme`; admin default in `settings.default_theme` (also styles the login screen).

## Gotchas / decisions worth knowing

- **better-sqlite3 must be v12+** for local dev: the user's machine has Node 24, and v11 has no prebuilt binary for it → it tried to compile from source and failed (no MSVC). v12 ships Node 24 prebuilds. Docker base is `node:20-bookworm-slim` (also has prebuilds; build tools included as fallback).
- **`DATA_DIR` defaults to a path next to the app** (`src/../data`), not `process.cwd()`. This was deliberate — otherwise launching from a different cwd (e.g. the preview tool) creates a stray `data/` wherever it was launched. Docker sets `DATA_DIR=/data` explicitly.
- **db.js seed ordering:** `migrate()`/`seed()` are called at the *bottom* of the module, after `const BUILTIN_THEMES`. They used to be at the top and hit a temporal-dead-zone `ReferenceError`. Don't move them back up.
- **Tabler webfont path:** served from `node_modules/@tabler/icons-webfont/dist` at `/vendor/tabler/`. The css is `tabler-icons.min.css` and references fonts via relative `./fonts/…`, which resolves correctly under that mount. Outline icons only (no `-filled`).
- **Seed is idempotent** per-entity (checks counts), so a partial first run recovers on restart. Admin user is seeded once from `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
- **Frontend is full-re-render** on state change (`renderApp`/`renderSidebar`/`renderContent`), with one delegated `click` handler dispatching on `data-act`. Modals/forms attach their own listeners directly (not delegated). Dropdowns (theme/user menus) are appended to `<body>` and closed on outside-click.

## How to run / test

```bash
npm install            # needs Node 20+; v24 fine with better-sqlite3 v12
npm start              # http://localhost:3000  (login admin/admin on fresh DB)
# or
docker compose up -d --build
```

Quick API smoke test (login → bootstrap):
```bash
curl -s -c c.txt -X POST localhost:3000/api/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}'
curl -s -b c.txt localhost:3000/api/bootstrap
```

## Verified this session

In-browser (via preview): login, dashboard render, page switching, **edit mode** affordances (drag handles, section edit/delete, add-service/add-section), **theme switch** (Midnight) persisting across reload, **sidebar collapse** persisting across reload (width 66px, localStorage `sd_collapsed=1`), **icon picker** (97-icon grid + name/URL inputs). Via curl: all CRUD, reorder endpoints, auth guards (401/403), static assets, SPA fallback.

**Drag-reorder:** exercised in session 2 via a simulated DragEvent sequence on the page nav — reorder now updates DOM, in-memory `state`, and DB consistently and survives a full re-render (see Session 2 change #1). Still worth a real human mouse-drag of a **tile across sections** and a **section** to sanity-check the `dragAfter` grid heuristic (nearest-center + before/after by x/y), which remains the riskiest bit.

## Phase 2 — status monitoring (BUILT, this session)

Implemented end-to-end; tiles' `.status-dot` now reflects live reachability.

- **Pinger** (`src/monitor.js`): `startMonitor()` is called from `server.js` after `listen`; checks every item on boot and on an interval. Interval precedence: the **`check_interval` setting** (seconds, set in the Settings dialog) > `CHECK_INTERVAL_MS` env > 30s; `rescheduleMonitor()` (called from `PUT /settings`) re-arms the timer live on change, and `0` clears the status map (dots → grey). `getIntervalMs()`/`rescheduleMonitor()` are exported. Target = `health_url` if set else `url` (must be `http(s)://…`, otherwise unknown/skipped). Uses node `http`/`https` (NOT undici/global fetch) specifically so it can pass `rejectUnauthorized:false` for **self-signed homelab TLS** — verified live against a real Proxmox at `:8006`. Timeout `CHECK_TIMEOUT_MS` default 5000 (request `timeout` event). **Any HTTP response = up** (200/301/401/403/5xx are all "reachable"); only DNS/connection/timeout = down. Redirects are not followed. Status lives in an in-memory map `{ [id]: { up, code, ms, checkedAt } }` (no history); entries for deleted items are pruned each pass. `timer.unref()` so checks don't keep the process alive. `CHECK_INTERVAL_MS=0` disables monitoring.
- **Endpoint**: `GET /api/status` (auth required) returns the map; `getStatus()` from monitor.js.
- **Frontend** (`app.js`): `startStatusPolling()` (called from `init`) polls `/status` immediately then every 30s into `state.status`; `applyStatusDots()` sets each `.tile .status-dot` to `.up` (green `--success`) / `.down` (red `--danger`) / grey ring = unknown, with tooltip (`Up · N ms · HTTP code` or `Down · unreachable`). Also called at the end of `renderContent()` so re-renders keep colours from cached state.

### Phase 2 — possible follow-ups (not built)
- Per-item "monitor on/off" flag (today every item with an http(s) URL is checked, incl. external links).
- Per-item "expect status" / treat-5xx-as-down.
- Status history / uptime %, backed by a `status` table instead of the in-memory map.
- SSE/WebSocket push instead of the client poll (client cadence now follows `check_interval`).

## Possible future work (not requested)

- Drag-reorder polish / touch support. Per-user "home page" default. Import/export of the layout (JSON) for backup. Search across all pages (currently active page only). Tile open-in-iframe / preview. Tags/favorites. Optional public (no-login) read-only page.
