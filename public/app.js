'use strict';

/* ----------------------------------------------------------- state */
const state = {
  user: null,
  pages: [],
  themes: [],
  settings: {},
  activePageId: null,
  pageData: null,
  editMode: false,
  sidebarCollapsed: false,
  search: '',
  status: {}
};

const CURATED_ICONS = [
  'home','layout-dashboard','apps','server','server-2','database','stack-2','router','network','world',
  'link','external-link','cloud','cloud-cog','shield','shield-lock','shield-check','lock','key','terminal-2',
  'code','braces','cpu','device-desktop','device-laptop','device-mobile','devices','wifi','access-point','broadcast',
  'mail','inbox','calendar','clock','chart-bar','chart-line','chart-pie','activity','camera','video',
  'movie','photo','music','headphones','book','books','file','files','folder','folders',
  'settings','adjustments','tool','tools','bell','star','heart','bookmark','tag','tags',
  'box','package','building','rss','search','user','users','flame','bolt','plug',
  'power','battery','droplet','sun','moon','palette','brush','ghost','rocket','plane',
  'map-pin','phone','message','messages','printer','qrcode','coin','shopping-cart',
  'brand-docker','brand-github','brand-gitlab','brand-youtube','brand-discord','brand-slack','brand-telegram','brand-google','brand-aws'
];

const SECTION_COLORS = {
  accent: null, blue: '#3b82f6', teal: '#14b8a6', green: '#22c55e', purple: '#8b5cf6',
  amber: '#f59e0b', red: '#ef4444', pink: '#ec4899', gray: '#94a3b8'
};

const THEME_TOKEN_FIELDS = [
  ['bg', 'Page background'], ['surface', 'Surface / sidebar'], ['card', 'Card / tile'], ['cardHover', 'Card hover'],
  ['text', 'Text'], ['muted', 'Muted text'], ['border', 'Border'],
  ['accent', 'Accent'], ['accentText', 'Text on accent'],
  ['success', 'Success'], ['danger', 'Danger'], ['warning', 'Warning']
];

/* ----------------------------------------------------------- helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $app = () => document.getElementById('app');
const $modal = () => document.getElementById('modal-root');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, method = 'GET', body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json();
  if (res.status === 401) { state.user = null; renderLogin(); throw new Error('unauth'); }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

function iconHtml(val) {
  if (!val) return '<i class="ti ti-app-window"></i>';
  if (val.startsWith('img:')) return `<img src="${esc(val.slice(4))}" alt="" />`;
  return `<i class="ti ${esc(val)}"></i>`;
}

function hexToRgba(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

function chipStyle(color) {
  if (!color || color === 'accent') return 'background:var(--accent-soft);color:var(--accent)';
  const hex = SECTION_COLORS[color];
  if (!hex) return 'background:var(--accent-soft);color:var(--accent)';
  return `background:${hexToRgba(hex, 0.16)};color:${hex}`;
}

function applyTheme(tokens) {
  const map = {
    bg: '--bg', surface: '--surface', card: '--card', cardHover: '--card-hover',
    text: '--text', muted: '--muted', border: '--border',
    accent: '--accent', accentText: '--accent-text', accentSoft: '--accent-soft',
    success: '--success', danger: '--danger', warning: '--warning'
  };
  const root = document.documentElement;
  root.classList.add('theme-switching');   // freeze transitions so tints don't animate through a washed midpoint
  const r = root.style;
  for (const k in map) if (tokens[k] != null) r.setProperty(map[k], tokens[k]);
  if (tokens.accent && tokens.accentSoft == null) r.setProperty('--accent-soft', hexToRgba(tokens.accent, 0.16));
  void root.offsetWidth;                    // flush the new values with transitions off
  requestAnimationFrame(() => root.classList.remove('theme-switching'));
}

function currentThemeName() {
  return (state.user && state.user.theme) || state.settings.default_theme || (state.themes[0] && state.themes[0].name);
}

function resolveTheme() {
  const name = currentThemeName();
  const t = state.themes.find(x => x.name === name) || state.themes[0];
  if (t) applyTheme(t.tokens);
}

function initials(name) { return String(name || '?').slice(0, 2).toUpperCase(); }

/* Avatar value convention mirrors icons: 'ti-xxx', 'img:https://…', or empty → initials. */
function avatarHtml(u) {
  const v = u && u.avatar;
  if (v) {
    if (v.startsWith('img:')) return `<img src="${esc(v.slice(4))}" alt="" />`;
    return `<i class="ti ${esc(v)}"></i>`;
  }
  return esc(initials(u && u.username));
}

/* Reorder an array of {id} objects in place to match the given id order.
   Items whose id is not in `ids` keep their relative order at the end. */
function applyOrder(arr, ids) {
  if (!Array.isArray(arr)) return;
  const byId = new Map(arr.map(o => [o.id, o]));
  const ordered = ids.map(id => byId.get(id)).filter(Boolean);
  const seen = new Set(ids);
  const rest = arr.filter(o => !seen.has(o.id));
  arr.length = 0;
  arr.push(...ordered, ...rest);
}

/* After an item drag (which can move tiles across sections), rebuild each
   section's items array from the DOM so local state matches what was persisted. */
function syncItemsFromDom() {
  if (!state.pageData) return;
  const content = document.getElementById('content');
  if (!content) return;
  const all = new Map();
  for (const s of state.pageData.sections)
    for (const it of s.items) all.set(it.id, it);
  for (const s of state.pageData.sections) {
    const cont = content.querySelector('.tiles[data-section-id="' + s.id + '"]');
    if (!cont) continue;
    s.items = [...cont.querySelectorAll('.tile[data-item-id]')]
      .map(t => all.get(Number(t.dataset.itemId)))
      .filter(Boolean);
    s.items.forEach(it => { it.section_id = s.id; });
  }
}

/* ----------------------------------------------------------- init */
async function init() {
  try {
    const boot = await api('/bootstrap');
    state.user = boot.user;
    state.pages = boot.pages;
    state.themes = boot.themes;
    state.settings = boot.settings;
    state.sidebarCollapsed = readCollapsed(boot.user);
    resolveTheme();
    state.activePageId = state.pages[0] ? state.pages[0].id : null;
    renderApp();
    if (state.activePageId) await loadPage(state.activePageId);
    startStatusPolling();
  } catch (e) {
    if (e.message !== 'unauth') renderLogin();
  }
}

function readCollapsed(user) {
  const ls = localStorage.getItem('sd_collapsed');
  if (ls != null) return ls === '1';
  return !!(user && user.sidebar_collapsed);
}

function setSidebar(collapsed) {
  state.sidebarCollapsed = collapsed;
  localStorage.setItem('sd_collapsed', collapsed ? '1' : '0');
  const sb = $('.sidebar');
  if (sb) sb.classList.toggle('collapsed', collapsed);
  renderSidebar();
  api('/me/prefs', 'PUT', { sidebar_collapsed: collapsed }).catch(() => {});
}

/* ----------------------------------------------------------- login */
async function renderLogin() {
  let pub = { app_title: 'Smash Dash', theme: null };
  try { pub = await api('/public'); } catch (_) {}
  if (pub.theme) applyTheme(pub.theme.tokens);
  $modal().innerHTML = '';
  $app().innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <div class="brand"><i class="ti ti-layout-dashboard"></i><span class="name">${esc(pub.app_title)}</span></div>
        <div class="field"><label>Username</label><input type="text" id="lg-user" autocomplete="username" autofocus /></div>
        <div class="field"><label>Password</label><input type="password" id="lg-pass" autocomplete="current-password" /></div>
        <button type="submit" class="btn primary block">Sign in</button>
        <div class="login-err" id="lg-err"></div>
      </form>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#lg-user').value.trim();
    const password = $('#lg-pass').value;
    try {
      await api('/login', 'POST', { username, password });
      await init();
    } catch (err) {
      $('#lg-err').textContent = err.message === 'unauth' ? '' : err.message;
    }
  });
}

/* ----------------------------------------------------------- app shell */
function renderApp() {
  $app().innerHTML = `
    <div class="app ${state.editMode ? 'editing' : ''}">
      <aside class="sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}" id="sidebar"></aside>
      <div class="main">
        <div class="topbar" id="topbar"></div>
        <div class="content" id="content"></div>
      </div>
    </div>`;
  renderSidebar();
  renderTopbar();
  renderContent();
}

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  const admin = state.user && state.user.role === 'admin';
  const navPages = state.pages.map(p => `
    <div class="nav-item ${p.id === state.activePageId ? 'active' : ''}" data-act="select-page" data-id="${p.id}" data-page-id="${p.id}">
      <span class="drag-handle" data-act="noop"><i class="ti ti-grip-vertical"></i></span>
      <i class="ti ${esc(p.icon)}"></i>
      <span class="label">${esc(p.name)}</span>
      <span class="row-actions">
        <button data-act="edit-page" data-id="${p.id}" title="Edit"><i class="ti ti-pencil"></i></button>
      </span>
    </div>`).join('');

  sb.innerHTML = `
    <div class="sidebar-head">
      <div class="sidebar-brand"><i class="ti ti-layout-dashboard logo"></i><span class="name">${esc(state.settings.app_title || 'Smash Dash')}</span></div>
      <button class="collapse-btn" data-act="toggle-sidebar" title="Toggle menu">
        <i class="ti ${state.sidebarCollapsed ? 'ti-chevron-right' : 'ti-chevron-left'}"></i>
      </button>
    </div>
    <div class="nav" id="page-nav">
      ${navPages || ''}
      ${admin ? `<div class="nav-add" data-act="add-page"><i class="ti ti-plus"></i><span class="label">Add page</span></div>` : ''}
    </div>
    ${admin ? `
    <div class="sidebar-foot">
      <div class="nav-item" data-act="manage-users"><i class="ti ti-users"></i><span class="label">Users</span></div>
      <div class="nav-item" data-act="open-settings"><i class="ti ti-settings"></i><span class="label">Settings</span></div>
    </div>` : ''}`;

  if (state.editMode && admin) {
    makeSortable(document.getElementById('page-nav'), '.nav-item', el => Number(el.dataset.pageId),
      ids => { applyOrder(state.pages, ids); api('/pages/reorder', 'POST', { ids }).catch(() => {}); });
  }
}

function renderTopbar() {
  const tb = document.getElementById('topbar');
  if (!tb) return;
  const admin = state.user && state.user.role === 'admin';
  tb.innerHTML = `
    <div class="search">
      <i class="ti ti-search"></i>
      <input type="text" id="search-input" placeholder="Search services" value="${esc(state.search)}" />
    </div>
    <div class="topbar-actions">
      <button class="icon-btn" data-act="theme-menu" title="Theme"><i class="ti ti-palette"></i></button>
      ${admin ? `<button class="pill-btn ${state.editMode ? 'on' : ''}" data-act="toggle-edit"><i class="ti ti-pencil"></i>${state.editMode ? 'Done' : 'Edit'}</button>` : ''}
      <div class="avatar" data-act="user-menu" title="${esc(state.user.username)}">${avatarHtml(state.user)}</div>
    </div>`;
  const si = document.getElementById('search-input');
  si.addEventListener('input', () => { state.search = si.value.trim().toLowerCase(); renderContent(); });
}

/* ----------------------------------------------------------- content */
async function loadPage(id) {
  state.activePageId = id;
  try { state.pageData = await api('/pages/' + id + '/full'); }
  catch (e) { if (e.message === 'unauth') return; state.pageData = null; }
  renderSidebar();
  renderContent();
}

function renderContent() {
  const c = document.getElementById('content');
  if (!c) return;
  const admin = state.user && state.user.role === 'admin';
  const editing = state.editMode && admin;

  if (!state.activePageId || !state.pageData) {
    c.innerHTML = `<div class="empty"><i class="ti ti-layout-dashboard"></i>${state.pages.length ? 'Select a page' : 'No pages yet'}</div>`;
    return;
  }

  const { page, sections } = state.pageData;
  const q = state.search;

  const sectionsHtml = sections.map(s => {
    let items = s.items;
    if (q) items = items.filter(it =>
      it.name.toLowerCase().includes(q) ||
      (it.subtitle || '').toLowerCase().includes(q) ||
      (it.url || '').toLowerCase().includes(q));
    if (q && items.length === 0) return '';

    const tiles = items.map(it => {
      const cVar = tileColorVar(it.color);
      const cls = `tile w-${it.width || 'md'} h-${it.height || 'md'} ic-${it.icon_size || 'md'} nm-${it.name_size || 'md'} sb-${it.sub_size || 'md'}${cVar ? ' tinted' : ''}`;
      const cStyle = cVar ? ` style="--tile-c:${cVar}"` : '';
      return `
      <div class="${cls}" data-act="tile-click" data-id="${it.id}" data-item-id="${it.id}"${cStyle}>
        <span class="tile-icon">${iconHtml(it.icon)}</span>
        <div class="tile-body">
          <div class="tile-name">${esc(it.name)}</div>
          ${it.subtitle ? `<div class="tile-sub">${esc(it.subtitle)}</div>` : ''}
        </div>
        <span class="status-dot" title="Checking…"></span>
        <button class="tile-edit" data-act="edit-item" data-id="${it.id}"><i class="ti ti-pencil"></i></button>
      </div>`;
    }).join('');

    return `
      <div class="section" data-section-id="${s.id}">
        <div class="section-head">
          <span class="section-chip" style="${chipStyle(s.color)}"><i class="ti ${esc(s.icon)}"></i></span>
          <span class="section-title">${esc(s.title)}</span>
          <span class="section-count">${s.items.length}</span>
          <span class="section-actions">
            <button data-act="edit-section" data-id="${s.id}" title="Edit section"><i class="ti ti-pencil"></i></button>
            <button data-act="del-section" data-id="${s.id}" title="Delete section"><i class="ti ti-trash"></i></button>
          </span>
        </div>
        <div class="tiles" data-section-id="${s.id}">
          ${tiles}
          ${editing && !q ? `<div class="add-tile" data-act="add-item" data-id="${s.id}"><i class="ti ti-plus"></i>Add service</div>` : ''}
        </div>
      </div>`;
  }).join('');

  c.innerHTML = `
    <div class="page-head">
      <h1>${esc(page.name)}</h1>
      <div class="spacer"></div>
    </div>
    ${sectionsHtml || (q ? `<div class="empty"><i class="ti ti-search"></i>No matches for “${esc(state.search)}”</div>`
      : `<div class="empty"><i class="ti ti-folder"></i>This page is empty</div>`)}
    ${editing && !q ? `<div class="add-section-row" data-act="add-section"><i class="ti ti-plus"></i>Add section</div>` : ''}`;

  if (editing && !q) wireContentDnD();
  applyStatusDots();
}

function wireContentDnD() {
  const content = document.getElementById('content');
  // sections reorder
  makeSortable(content, '.section', el => Number(el.dataset.sectionId),
    ids => { applyOrder(state.pageData.sections, ids); api('/sections/reorder', 'POST', { ids }).catch(() => {}); }, '.section-head');
  // items reorder (per tiles container, supports cross-section move)
  let dragged = null;
  content.querySelectorAll('.tile[data-item-id]').forEach(tile => {
    tile.setAttribute('draggable', 'true');
    tile.addEventListener('dragstart', e => { dragged = tile; tile.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); });
    tile.addEventListener('dragend', () => {
      tile.classList.remove('dragging');
      if (dragged) {
        const parent = dragged.closest('.tiles');
        const ids = [...parent.querySelectorAll('.tile[data-item-id]')].map(t => Number(t.dataset.itemId));
        syncItemsFromDom();
        api('/items/reorder', 'POST', { section_id: Number(parent.dataset.sectionId), ids }).catch(() => {});
      }
      dragged = null;
    });
  });
  content.querySelectorAll('.tiles').forEach(container => {
    container.addEventListener('dragover', e => {
      if (!dragged) return;
      e.preventDefault();
      const ref = dragAfter(container, '.tile[data-item-id]', e.clientX, e.clientY);
      const addBtn = container.querySelector('.add-tile');
      if (ref == null) { addBtn ? container.insertBefore(dragged, addBtn) : container.appendChild(dragged); }
      else container.insertBefore(dragged, ref);
    });
  });
}

/* ----------------------------------------------------------- status monitoring */
let statusTimer = null;
async function pollStatus() {
  try { state.status = await api('/status'); }
  catch (e) { if (e.message === 'unauth') return; return; }
  applyStatusDots();
}
function applyStatusDots() {
  document.querySelectorAll('.tile[data-item-id]').forEach(t => {
    const dot = t.querySelector('.status-dot');
    if (!dot) return;
    const s = state.status[t.dataset.itemId];
    dot.classList.remove('up', 'down');
    if (!s) { dot.title = 'No health check'; return; }
    dot.classList.add(s.up ? 'up' : 'down');
    dot.title = s.up
      ? `Up${s.ms != null ? ` · ${s.ms} ms` : ''}${s.code ? ` · HTTP ${s.code}` : ''}`
      : 'Down · unreachable';
  });
}
function scheduleStatusPolling() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  const secs = Number(state.settings.check_interval);
  if (secs === 0) return;             // monitoring off → stop polling (server clears statuses → dots go grey)
  const ms = Number.isFinite(secs) && secs > 0 ? Math.max(5, secs) * 1000 : 30000;
  statusTimer = setInterval(pollStatus, ms);
}
function startStatusPolling() {
  pollStatus();
  scheduleStatusPolling();
}

/* generic vertical/grid sortable used for pages & sections */
function makeSortable(container, selector, getId, onReorder, handleSel) {
  let dragged = null;
  container.querySelectorAll(selector).forEach(el => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', e => {
      if (handleSel && !e.target.closest('.drag-handle') && !e.target.closest(handleSel)) { /* allow whole-row drag too */ }
      dragged = el; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      if (dragged) onReorder([...container.querySelectorAll(selector)].map(getId));
      dragged = null;
    });
  });
  container.addEventListener('dragover', e => {
    if (!dragged) return;
    e.preventDefault();
    const ref = dragAfter(container, selector, e.clientX, e.clientY);
    if (ref == null) container.appendChild(dragged);
    else container.insertBefore(dragged, ref);
  });
}

function dragAfter(container, selector, x, y) {
  const els = [...container.querySelectorAll(selector + ':not(.dragging)')];
  let best = null, bestDist = Infinity;
  for (const el of els) {
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestDist) {
      bestDist = d;
      const before = (y < cy - 4) || (Math.abs(y - cy) <= b.height / 2 && x < cx);
      best = before ? el : el.nextElementSibling;
    }
  }
  return best;
}

/* ----------------------------------------------------------- modal + icon field */
function openModal(inner, wide) {
  $modal().innerHTML = `<div class="modal-overlay"><div class="modal ${wide ? 'wide' : ''}">${inner}</div></div>`;
  const overlay = $modal().firstElementChild;
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeModal(); });
  const m = overlay.querySelector('.modal');
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  return m;
}
function closeModal() { $modal().innerHTML = ''; }

/* stacked sub-popup: opens above an existing modal without destroying it */
function openSubModal(inner, wide) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay sub';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${inner}</div>`;
  $modal().appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  const modal = wrap.querySelector('.modal');
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  return { modal, close };
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const subs = $modal().querySelectorAll('.modal-overlay.sub');
  if (subs.length) subs[subs.length - 1].remove();   // close topmost sub first
  else closeModal();
});

/* dashboard-icons — Heimdall-style real product logos, pulled from the jsDelivr CDN on demand */
const LOGO_BASE = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/';
let LOGO_INDEX = null, LOGO_PROMISE = null;
function loadLogoIndex() {
  if (LOGO_INDEX) return Promise.resolve(LOGO_INDEX);
  if (!LOGO_PROMISE) {
    LOGO_PROMISE = fetch('https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/tree.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => { LOGO_INDEX = (d.png || []).map(n => n.replace(/\.png$/, '')); return LOGO_INDEX; })
      .catch(e => { LOGO_PROMISE = null; throw e; });
  }
  return LOGO_PROMISE;
}

function iconFieldHtml(value) {
  return `
    <div class="icon-field" data-value="${esc(value || '')}">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div class="icon-preview" data-toggle-grid><span class="ip">${iconHtml(value)}</span><span style="color:var(--muted);font-size:13px">Pick</span></div>
        <button type="button" class="btn pick-logos" data-toggle-logos style="padding:8px 12px;display:inline-flex;align-items:center;gap:6px"><i class="ti ti-photo"></i>Logos</button>
        <input type="text" class="ic-name field-inline" placeholder="or type ti-name" value="${value && value.startsWith('ti-') ? esc(value) : ''}" />
      </div>
      <input type="url" class="ic-url field-inline" placeholder="or image URL (https://…)" value="${value && value.startsWith('img:') ? esc(value.slice(4)) : ''}" style="margin-top:8px" />
      <div class="icon-grid" style="display:none">
        ${CURATED_ICONS.map(n => `<button type="button" data-icon="${n}" class="${value === 'ti-' + n ? 'sel' : ''}"><i class="ti ti-${n}"></i></button>`).join('')}
      </div>
      <div class="logo-panel" style="display:none;margin-top:8px">
        <input type="text" class="logo-search field-inline" placeholder="Search product logos — plex, sonarr, proxmox…" />
        <div class="logo-status" style="font-size:12px;color:var(--muted);margin:7px 2px"></div>
        <div class="logo-grid"></div>
      </div>
    </div>`;
}

function wireIconField(scope) {
  const field = scope.querySelector('.icon-field');
  if (!field) return;
  const preview = field.querySelector('.ip');
  const grid = field.querySelector('.icon-grid');
  const nameInput = field.querySelector('.ic-name');
  const urlInput = field.querySelector('.ic-url');
  const logoPanel = field.querySelector('.logo-panel');
  const logoSearch = field.querySelector('.logo-search');
  const logoGrid = field.querySelector('.logo-grid');
  const logoStatus = field.querySelector('.logo-status');
  const set = v => { field.dataset.value = v; preview.innerHTML = iconHtml(v); };
  field.querySelector('[data-toggle-grid]').addEventListener('click', () => {
    logoPanel.style.display = 'none';
    grid.style.display = grid.style.display === 'none' ? 'grid' : 'none';
  });
  grid.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    grid.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    const v = 'ti-' + b.dataset.icon;
    nameInput.value = v; urlInput.value = ''; set(v);
  }));
  nameInput.addEventListener('input', () => {
    const v = nameInput.value.trim(); if (v) { urlInput.value = ''; set(v.startsWith('ti-') ? v : 'ti-' + v); }
  });
  urlInput.addEventListener('input', () => {
    const v = urlInput.value.trim(); if (v) { nameInput.value = ''; set('img:' + v); }
  });

  // product-logo picker (dashboard-icons via CDN)
  const renderLogos = () => {
    if (!LOGO_INDEX) return;
    const q = logoSearch.value.trim().toLowerCase();
    if (!q) { logoGrid.innerHTML = ''; logoStatus.textContent = `${LOGO_INDEX.length} logos available — type to search`; return; }
    const starts = [], has = [];
    for (const s of LOGO_INDEX) {
      const i = s.indexOf(q);
      if (i === 0) starts.push(s); else if (i > 0) has.push(s);
    }
    const results = starts.concat(has).slice(0, 60);
    logoStatus.textContent = results.length ? `${results.length}${starts.length + has.length > 60 ? '+' : ''} result${results.length === 1 ? '' : 's'}` : 'No matches';
    logoGrid.innerHTML = results.map(s =>
      `<button type="button" data-logo="${esc(s)}" title="${esc(s)}"><img src="${LOGO_BASE}${encodeURIComponent(s)}.png" loading="lazy" alt="" /></button>`).join('');
    logoGrid.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      logoGrid.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      const url = LOGO_BASE + encodeURIComponent(b.dataset.logo) + '.png';
      nameInput.value = ''; urlInput.value = url; set('img:' + url);
    }));
  };
  field.querySelector('[data-toggle-logos]').addEventListener('click', () => {
    const showing = logoPanel.style.display !== 'none';
    if (showing) { logoPanel.style.display = 'none'; return; }
    grid.style.display = 'none';
    logoPanel.style.display = 'block';
    logoSearch.focus();
    logoStatus.textContent = 'Loading logos…';
    loadLogoIndex().then(renderLogos).catch(() => { logoStatus.textContent = 'Could not reach the logo CDN (no internet?). You can still paste an image URL above.'; });
  });
  let logoT = null;
  logoSearch.addEventListener('input', () => { clearTimeout(logoT); logoT = setTimeout(renderLogos, 180); });
}
function readIconField(scope) { const f = scope.querySelector('.icon-field'); return f ? f.dataset.value : ''; }

/* ----------------------------------------------------------- page / section / item forms */
function openPageForm(page) {
  const editing = !!page;
  const m = openModal(`
    <div class="modal-head"><h3>${editing ? 'Edit page' : 'New page'}</h3><button class="close" data-close>&times;</button></div>
    <div class="field"><label>Name</label><input type="text" class="f-name" value="${esc(page ? page.name : '')}" placeholder="Infrastructure" /></div>
    <div class="field"><label>Icon</label>${iconFieldHtml(page ? page.icon : 'ti-layout-dashboard')}</div>
    <div class="btn-row ${editing ? 'between' : ''}">
      ${editing ? '<button class="btn danger" data-del>Delete</button>' : ''}
      <div style="display:flex;gap:10px;margin-left:auto">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save>${editing ? 'Save' : 'Create'}</button>
      </div>
    </div>`);
  wireIconField(m);
  m.querySelector('[data-save]').addEventListener('click', async () => {
    const name = m.querySelector('.f-name').value.trim();
    if (!name) return;
    const icon = readIconField(m) || 'ti-layout-dashboard';
    if (editing) await api('/pages/' + page.id, 'PUT', { name, icon });
    else { const p = await api('/pages', 'POST', { name, icon }); state.activePageId = p.id; }
    await refreshPages();
    closeModal();
  });
  if (editing) m.querySelector('[data-del]').addEventListener('click', async () => {
    if (!confirm('Delete this page and all its sections?')) return;
    await api('/pages/' + page.id, 'DELETE');
    if (state.activePageId === page.id) state.activePageId = null;
    await refreshPages();
    closeModal();
  });
}

function colorPickerHtml(selected) {
  return `<div class="color-row">${Object.keys(SECTION_COLORS).map(k => {
    const bg = k === 'accent' ? 'var(--accent)' : SECTION_COLORS[k];
    return `<div class="swatch ${k === (selected || 'accent') ? 'sel' : ''}" data-color="${k}" style="background:${bg}"></div>`;
  }).join('')}</div>`;
}

function openSectionForm(section) {
  const editing = !!section;
  let color = section ? section.color : 'accent';
  const m = openModal(`
    <div class="modal-head"><h3>${editing ? 'Edit section' : 'New section'}</h3><button class="close" data-close>&times;</button></div>
    <div class="field"><label>Title</label><input type="text" class="f-title" value="${esc(section ? section.title : '')}" placeholder="Hypervisors" /></div>
    <div class="field"><label>Colour</label>${colorPickerHtml(color)}</div>
    <div class="field"><label>Icon</label>${iconFieldHtml(section ? section.icon : 'ti-folder')}</div>
    <div class="btn-row">
      <div style="display:flex;gap:10px;margin-left:auto">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save>${editing ? 'Save' : 'Create'}</button>
      </div>
    </div>`);
  wireIconField(m);
  m.querySelectorAll('.swatch').forEach(s => s.addEventListener('click', () => {
    m.querySelectorAll('.swatch').forEach(x => x.classList.remove('sel'));
    s.classList.add('sel'); color = s.dataset.color;
  }));
  m.querySelector('[data-save]').addEventListener('click', async () => {
    const title = m.querySelector('.f-title').value.trim();
    if (!title) return;
    const icon = readIconField(m) || 'ti-folder';
    if (editing) await api('/sections/' + section.id, 'PUT', { title, icon, color });
    else await api('/sections', 'POST', { page_id: state.activePageId, title, icon, color });
    await loadPage(state.activePageId);
    closeModal();
  });
}

/* per-tile appearance controls */
function tileColorVar(c) {
  if (!c || c === 'default') return '';
  if (c === 'accent') return 'var(--accent)';
  if (c[0] === '#') return c;            // custom colour stored as a hex
  return SECTION_COLORS[c] || '';
}
function tileColorPickerHtml(selected) {
  const keys = ['default', ...Object.keys(SECTION_COLORS)];
  const isCustom = !!selected && selected[0] === '#';
  const swatches = keys.map(k => {
    const bg = k === 'default' ? 'var(--card)' : (k === 'accent' ? 'var(--accent)' : SECTION_COLORS[k]);
    const sel = !isCustom && (selected || 'default') === k ? ' sel' : '';
    return `<div class="swatch${sel}${k === 'default' ? ' swatch-none' : ''}" data-color="${k}" style="background:${bg}" title="${k}"></div>`;
  }).join('');
  const customVal = isCustom ? selected : '#3b82f6';
  return `<div class="color-row">${swatches}<label class="swatch swatch-custom${isCustom ? ' sel' : ''}" data-color="${isCustom ? esc(selected) : ''}" title="Custom colour"${isCustom ? ` style="background:${esc(selected)}"` : ''}><input type="color" class="color-custom" value="${esc(customVal)}" /></label></div>`;
}
function segHtml(seg, options, selected, def) {
  return `<div class="seg" data-seg="${seg}">${options.map(([v, label]) =>
    `<button type="button" data-v="${v}" class="${v === (selected || def) ? 'sel' : ''}">${esc(label)}</button>`).join('')}</div>`;
}
function wireSeg(scope) {
  scope.querySelectorAll('.seg').forEach(seg => seg.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
    })));
}
function readSeg(scope, seg, def) {
  const sel = scope.querySelector(`.seg[data-seg="${seg}"] button.sel`);
  return sel ? sel.dataset.v : def;
}

/* one-line cycling size button: click steps Small → Medium → Large → Small */
const SIZE_CYCLE = ['sm', 'md', 'lg'];
const SIZE_LABEL = { sm: 'Small', md: 'Medium', lg: 'Large', xl: 'X-large' };
// Icon/logo + font controls offer an extra X-large step; button width/height stays S/M/L (SIZE_CYCLE).
const SIZE_OPTS = [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'X-large']];
function apSummary(ap) {
  let s = `${SIZE_LABEL[ap.width]} × ${SIZE_LABEL[ap.height]}`;
  if (ap.color && ap.color !== 'default') s += ' · ' + ap.color;
  return s;
}
function cycleBtnHtml(name, value) {
  const v = SIZE_CYCLE.includes(value) ? value : 'md';
  const icon = name === 'width' ? 'ti-arrows-horizontal' : 'ti-arrows-vertical';
  return `<button type="button" class="cyc" data-cyc="${name}" data-v="${v}" title="${name === 'width' ? 'Width' : 'Height'} — click to change">
    <i class="ti ${icon}"></i><span class="cyc-label">${SIZE_LABEL[v]}</span></button>`;
}
function wireCycle(scope) {
  scope.querySelectorAll('.cyc').forEach(b => b.addEventListener('click', () => {
    const next = SIZE_CYCLE[(SIZE_CYCLE.indexOf(b.dataset.v) + 1) % SIZE_CYCLE.length];
    b.dataset.v = next;
    b.querySelector('.cyc-label').textContent = SIZE_LABEL[next];
  }));
}
function readCycle(scope, name, def) {
  const b = scope.querySelector(`.cyc[data-cyc="${name}"]`);
  return b ? b.dataset.v : def;
}

/* "Appearance" sub-popup — groups every look control so the main form stays short.
   Live-syncs into the shared `ap` object on each click; `onApply` refreshes the summary. */
function openAppearance(ap, onApply) {
  const { modal: m } = openSubModal(`
    <div class="modal-head"><h3>Appearance</h3><button class="close" data-close>&times;</button></div>
    <div class="field"><label>Button size</label>
      <div class="size-line">${cycleBtnHtml('width', ap.width)}<span class="size-x">&times;</span>${cycleBtnHtml('height', ap.height)}</div>
    </div>
    <div class="field"><label>Colour</label>${tileColorPickerHtml(ap.color)}</div>
    <div class="field"><label>Icon size</label>${segHtml('iconsize', SIZE_OPTS, ap.icon_size, 'md')}</div>
    <div class="field"><label>Name font size</label>${segHtml('namesize', SIZE_OPTS, ap.name_size, 'md')}</div>
    <div class="field"><label>Subtitle font size</label>${segHtml('subsize', SIZE_OPTS, ap.sub_size, 'md')}</div>
    <div class="btn-row"><button class="btn primary" data-close>Done</button></div>
  `);
  wireSeg(m);
  wireCycle(m);
  m.querySelectorAll('.swatch').forEach(s => s.addEventListener('click', () => {
    m.querySelectorAll('.swatch').forEach(x => x.classList.remove('sel'));
    s.classList.add('sel');
  }));
  const commit = () => {
    ap.width = readCycle(m, 'width', 'md');
    ap.height = readCycle(m, 'height', 'md');
    ap.color = (m.querySelector('.swatch.sel') && m.querySelector('.swatch.sel').dataset.color) || 'default';
    ap.icon_size = readSeg(m, 'iconsize', 'md');
    ap.name_size = readSeg(m, 'namesize', 'md');
    ap.sub_size = readSeg(m, 'subsize', 'md');
    if (onApply) onApply();
  };
  m.addEventListener('click', commit);
  const customInput = m.querySelector('.color-custom');
  if (customInput) customInput.addEventListener('input', () => {
    const sw = customInput.closest('.swatch');
    sw.dataset.color = customInput.value;
    sw.style.background = customInput.value;
    m.querySelectorAll('.swatch').forEach(x => x.classList.remove('sel'));
    sw.classList.add('sel');
    commit();
  });
}

function openItemForm(item, sectionId) {
  const editing = !!item;
  const m = openModal(`
    <div class="modal-head"><h3>${editing ? 'Edit service' : 'New service'}</h3><button class="close" data-close>&times;</button></div>
    <div class="field"><label>Name</label><input type="text" class="f-name" value="${esc(item ? item.name : '')}" placeholder="Proxmox node 1" /></div>
    <div class="field"><label>URL</label><input type="text" class="f-url" value="${esc(item ? item.url : '')}" placeholder="https://10.0.0.11:8006" /></div>
    <div class="field"><label>Subtitle</label><input type="text" class="f-sub" value="${esc(item ? item.subtitle : '')}" placeholder="10.0.0.11:8006" /></div>
    <div class="field"><label>Icon</label>${iconFieldHtml(item ? item.icon : 'ti-link')}</div>
    <div class="field"><label>Appearance</label>
      <button type="button" class="btn appearance-btn" data-appearance>
        <span><i class="ti ti-adjustments-alt"></i> Size, colour, icon &amp; text</span>
        <span class="appearance-sum"></span>
      </button>
    </div>
    <div class="field"><label class="check"><input type="checkbox" class="f-newtab" ${!item || item.open_new_tab ? 'checked' : ''} /> Open in new tab</label></div>
    <div class="field"><label>Health check URL <span style="color:var(--muted)">(optional, used by status monitoring later)</span></label><input type="text" class="f-health" value="${esc(item ? item.health_url : '')}" placeholder="https://10.0.0.11:8006" /></div>
    <div class="btn-row ${editing ? 'between' : ''}">
      ${editing ? '<button class="btn danger" data-del>Delete</button>' : ''}
      <div style="display:flex;gap:10px;margin-left:auto">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save>${editing ? 'Save' : 'Create'}</button>
      </div>
    </div>`);
  wireIconField(m);
  const ap = {
    width: (item && item.width) || 'md',
    height: (item && item.height) || 'md',
    color: (item && item.color) || 'default',
    icon_size: (item && item.icon_size) || 'md',
    name_size: (item && item.name_size) || 'md',
    sub_size: (item && item.sub_size) || 'md'
  };
  const updateSum = () => { const el = m.querySelector('.appearance-sum'); if (el) el.textContent = apSummary(ap); };
  updateSum();
  m.querySelector('[data-appearance]').addEventListener('click', () => openAppearance(ap, updateSum));
  m.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {
      name: m.querySelector('.f-name').value.trim(),
      url: m.querySelector('.f-url').value.trim(),
      subtitle: m.querySelector('.f-sub').value.trim(),
      icon: readIconField(m) || 'ti-link',
      open_new_tab: m.querySelector('.f-newtab').checked,
      health_url: m.querySelector('.f-health').value.trim(),
      width: ap.width,
      height: ap.height,
      color: ap.color,
      icon_size: ap.icon_size,
      name_size: ap.name_size,
      sub_size: ap.sub_size
    };
    if (!payload.name) return;
    if (editing) await api('/items/' + item.id, 'PUT', payload);
    else await api('/items', 'POST', { section_id: sectionId, ...payload });
    await loadPage(state.activePageId);
    closeModal();
  });
  if (editing) m.querySelector('[data-del]').addEventListener('click', async () => {
    if (!confirm('Delete this service?')) return;
    await api('/items/' + item.id, 'DELETE');
    await loadPage(state.activePageId);
    closeModal();
  });
}

async function refreshPages() {
  state.pages = await api('/pages');
  if (!state.pages.find(p => p.id === state.activePageId)) state.activePageId = state.pages[0] ? state.pages[0].id : null;
  renderSidebar();
  if (state.activePageId) await loadPage(state.activePageId); else renderContent();
}

/* ----------------------------------------------------------- themes */
function swatchPreview(t) {
  return `<div class="theme-swatches">
    <span style="background:${esc(t.tokens.bg)}"></span>
    <span style="background:${esc(t.tokens.card)}"></span>
    <span style="background:${esc(t.tokens.accent)}"></span>
  </div>`;
}

function openThemeManager() {
  const rows = state.themes.map(t => `
    <div class="list-row">
      ${swatchPreview(t)}
      <div class="grow"><div>${esc(t.name)}</div><div class="sub">${t.is_dark ? 'Dark' : 'Light'}${t.is_builtin ? ' · built-in' : ''}</div></div>
      ${currentThemeName() === t.name ? '<span class="badge">active</span>' : ''}
      <button class="btn" data-edit="${t.id}">${t.is_builtin ? 'Duplicate' : 'Edit'}</button>
      ${t.is_builtin ? '' : `<button class="btn danger" data-del="${t.id}"><i class="ti ti-trash"></i></button>`}
    </div>`).join('');
  const m = openModal(`
    <div class="modal-head"><h3>Themes</h3><button class="close" data-close>&times;</button></div>
    ${rows}
    <div class="btn-row"><button class="btn primary" data-new><i class="ti ti-plus"></i> New theme</button></div>
  `, true);
  m.querySelector('[data-new]').addEventListener('click', () => openThemeForm(null));
  m.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const t = state.themes.find(x => x.id === Number(b.dataset.edit));
    openThemeForm(t.is_builtin ? { name: t.name + ' copy', is_dark: t.is_dark, tokens: { ...t.tokens } } : t);
  }));
  m.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this theme?')) return;
    await api('/themes/' + b.dataset.del, 'DELETE');
    state.themes = await api('/themes');
    resolveTheme();
    openThemeManager();
  }));
}

function openThemeForm(theme) {
  const editing = theme && theme.id;
  const tk = theme ? theme.tokens : { bg: '#0f1115', surface: '#171a21', card: '#1e222b', cardHover: '#262b36', text: '#e6e8ee', muted: '#9aa3b2', border: '#2a2f3a', accent: '#3b82f6', accentText: '#ffffff', success: '#22c55e', danger: '#ef4444', warning: '#f59e0b' };
  const fields = THEME_TOKEN_FIELDS.map(([k, label]) => `
    <div class="field" style="margin-bottom:10px">
      <label>${label}</label>
      <input type="color" class="tk" data-k="${k}" value="${esc(tk[k] || '#000000')}" style="width:54px;height:36px;padding:2px;background:var(--card);border:1px solid var(--border);border-radius:8px" />
    </div>`).join('');
  const m = openModal(`
    <div class="modal-head"><h3>${editing ? 'Edit theme' : 'New theme'}</h3><button class="close" data-close>&times;</button></div>
    <div class="field"><label>Name</label><input type="text" class="t-name" value="${esc(theme ? theme.name : '')}" placeholder="My theme" /></div>
    <div class="field"><label class="check"><input type="checkbox" class="t-dark" ${!theme || theme.is_dark ? 'checked' : ''} /> Dark theme</label></div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0 16px">${fields}</div>
    <div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>${editing ? 'Save' : 'Create'}</button></div>
  `, true);
  m.querySelector('[data-save]').addEventListener('click', async () => {
    const name = m.querySelector('.t-name').value.trim();
    if (!name) return;
    const tokens = {};
    m.querySelectorAll('.tk').forEach(i => tokens[i.dataset.k] = i.value);
    tokens.accentSoft = hexToRgba(tokens.accent, 0.16);
    const is_dark = m.querySelector('.t-dark').checked;
    try {
      if (editing) await api('/themes/' + theme.id, 'PUT', { name, is_dark, tokens });
      else await api('/themes', 'POST', { name, is_dark, tokens });
    } catch (e) { alert(e.message); return; }
    state.themes = await api('/themes');
    resolveTheme();
    closeModal();
    openThemeManager();
  });
}

/* ----------------------------------------------------------- users + settings */
function openUserManager() {
  api('/users').then(users => {
    const rows = users.map(u => `
      <div class="list-row">
        <div class="avatar" style="cursor:default">${avatarHtml(u)}</div>
        <div class="grow"><div>${esc(u.username)}</div><div class="sub">${u.id === state.user.id ? 'you' : ''}</div></div>
        <span class="badge ${u.role === 'admin' ? '' : 'muted'}">${u.role}</span>
        <button class="btn" data-edit="${u.id}"><i class="ti ti-pencil"></i></button>
        ${u.id === state.user.id ? '' : `<button class="btn danger" data-del="${u.id}"><i class="ti ti-trash"></i></button>`}
      </div>`).join('');
    const m = openModal(`
      <div class="modal-head"><h3>Users</h3><button class="close" data-close>&times;</button></div>
      ${rows}
      <div class="btn-row"><button class="btn primary" data-new><i class="ti ti-plus"></i> Add user</button></div>
    `, true);
    m.querySelector('[data-new]').addEventListener('click', () => openUserForm(null));
    m.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () =>
      openUserForm(users.find(x => x.id === Number(b.dataset.edit)))));
    m.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this user?')) return;
      try { await api('/users/' + b.dataset.del, 'DELETE'); } catch (e) { alert(e.message); return; }
      openUserManager();
    }));
  });
}

function openUserForm(user) {
  const editing = !!user;
  const m = openModal(`
    <div class="modal-head"><h3>${editing ? 'Edit user' : 'Add user'}</h3><button class="close" data-close>&times;</button></div>
    <div class="field"><label>Username</label><input type="text" class="u-name" value="${esc(user ? user.username : '')}" /></div>
    <div class="field"><label>Password ${editing ? '<span style="color:var(--muted)">(leave blank to keep)</span>' : ''}</label><input type="password" class="u-pass" /></div>
    <div class="field"><label>Avatar <span style="color:var(--muted)">(optional — icon or image URL; blank uses initials)</span></label>${iconFieldHtml(user ? user.avatar : '')}</div>
    <div class="field"><label>Role</label><select class="u-role">
      <option value="viewer" ${user && user.role === 'viewer' ? 'selected' : ''}>Viewer — can view only</option>
      <option value="admin" ${user && user.role === 'admin' ? 'selected' : ''}>Admin — can edit everything</option>
    </select></div>
    <div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>${editing ? 'Save' : 'Create'}</button></div>
  `);
  wireIconField(m);
  m.querySelector('[data-save]').addEventListener('click', async () => {
    const username = m.querySelector('.u-name').value.trim();
    const password = m.querySelector('.u-pass').value;
    const role = m.querySelector('.u-role').value;
    const avatar = readIconField(m);
    if (!username || (!editing && !password)) return;
    try {
      if (editing) await api('/users/' + user.id, 'PUT', { username, role, avatar, ...(password ? { password } : {}) });
      else await api('/users', 'POST', { username, password, role, avatar });
    } catch (e) { alert(e.message); return; }
    openUserManager();
  });
}

/* self-service profile (any logged-in user can set their own avatar) */
function openProfile() {
  const m = openModal(`
    <div class="modal-head"><h3>Edit profile</h3><button class="close" data-close>&times;</button></div>
    <div class="field"><label>Username</label><input type="text" value="${esc(state.user.username)}" disabled style="opacity:.6" /></div>
    <div class="field"><label>Avatar <span style="color:var(--muted)">(pick an icon or paste an image URL — blank uses your initials)</span></label>${iconFieldHtml(state.user.avatar || '')}</div>
    <div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>
  `);
  wireIconField(m);
  m.querySelector('[data-save]').addEventListener('click', async () => {
    const avatar = readIconField(m);
    try { await api('/me/prefs', 'PUT', { avatar }); } catch (e) { alert(e.message); return; }
    state.user.avatar = avatar || null;
    renderTopbar();
    closeModal();
  });
}

function openSettings() {
  const m = openModal(`
    <div class="modal-head"><h3>Settings</h3><button class="close" data-close>&times;</button></div>
    <div class="field"><label>App title</label><input type="text" class="s-title" value="${esc(state.settings.app_title || '')}" /></div>
    <div class="field"><label>Default theme (new users + login screen)</label><select class="s-theme">
      ${state.themes.map(t => `<option value="${esc(t.name)}" ${state.settings.default_theme === t.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
    </select></div>
    <div class="field"><label>Status check interval <span style="color:var(--muted)">(seconds; 0 turns monitoring off, min 5)</span></label><input type="number" min="0" step="1" class="s-interval" value="${esc(state.settings.check_interval ?? 30)}" /></div>
    <div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>
  `);
  m.querySelector('[data-save]').addEventListener('click', async () => {
    const app_title = m.querySelector('.s-title').value.trim() || 'Smash Dash';
    const default_theme = m.querySelector('.s-theme').value;
    const check_interval = Math.max(0, Math.round(Number(m.querySelector('.s-interval').value) || 0));
    await api('/settings', 'PUT', { app_title, default_theme, check_interval });
    state.settings.app_title = app_title;
    state.settings.default_theme = default_theme;
    state.settings.check_interval = check_interval;
    document.title = app_title;
    renderApp();
    resolveTheme();
    scheduleStatusPolling();   // match the client poll cadence to the new interval
    pollStatus();
    closeModal();
  });
}

/* ----------------------------------------------------------- dropdowns */
let ddEl = null;
function closeDropdown() {
  if (ddEl) { ddEl.remove(); ddEl = null; document.removeEventListener('click', ddOutside, true); }
}
function ddOutside(e) {
  if (ddEl && !ddEl.contains(e.target) && !e.target.closest('[data-act="theme-menu"],[data-act="user-menu"]')) closeDropdown();
}
function openDropdown(html) {
  closeDropdown();
  ddEl = document.createElement('div');
  ddEl.className = 'dropdown';
  ddEl.innerHTML = html;
  document.body.appendChild(ddEl);
  setTimeout(() => document.addEventListener('click', ddOutside, true), 0);
}

function themeMenu() {
  const admin = state.user.role === 'admin';
  const cur = currentThemeName();
  openDropdown(
    `<div class="dd-label">Theme</div>` +
    state.themes.map(t => `<div class="dd-item" data-act="apply-theme" data-name="${esc(t.name)}">${swatchPreview(t)}<span>${esc(t.name)}</span>${cur === t.name ? '<i class="ti ti-check" style="margin-left:auto"></i>' : ''}</div>`).join('') +
    (admin ? `<div class="dd-sep"></div><div class="dd-item" data-act="manage-themes"><i class="ti ti-palette"></i> Manage themes</div>` : '')
  );
}

function userMenu() {
  const admin = state.user.role === 'admin';
  openDropdown(`
    <div class="dd-label">${esc(state.user.username)} · ${state.user.role}</div>
    <div class="dd-item" data-act="open-profile"><i class="ti ti-user-circle"></i> Edit profile</div>
    <div class="dd-sep"></div>
    ${admin ? `<div class="dd-item" data-act="manage-users"><i class="ti ti-users"></i> Users</div>
    <div class="dd-item" data-act="open-settings"><i class="ti ti-settings"></i> Settings</div><div class="dd-sep"></div>` : ''}
    <div class="dd-item" data-act="logout"><i class="ti ti-logout"></i> Sign out</div>
  `);
}

/* ----------------------------------------------------------- global click dispatch */
const handlers = {
  noop: () => {},
  'select-page': el => { if (!state.editMode) loadPage(Number(el.dataset.id)); else loadPage(Number(el.dataset.id)); },
  'toggle-sidebar': () => setSidebar(!state.sidebarCollapsed),
  'toggle-edit': () => { state.editMode = !state.editMode; renderApp(); },
  'add-page': () => openPageForm(null),
  'edit-page': el => { const p = state.pages.find(x => x.id === Number(el.dataset.id)); openPageForm(p); },
  'add-section': () => openSectionForm(null),
  'edit-section': el => { const s = state.pageData.sections.find(x => x.id === Number(el.dataset.id)); openSectionForm(s); },
  'del-section': async el => { if (confirm('Delete this section and its services?')) { await api('/sections/' + el.dataset.id, 'DELETE'); await loadPage(state.activePageId); } },
  'add-item': el => openItemForm(null, Number(el.dataset.id)),
  'edit-item': el => { const it = findItem(Number(el.dataset.id)); openItemForm(it); },
  'tile-click': el => {
    const it = findItem(Number(el.dataset.id));
    if (state.editMode) { openItemForm(it); return; }
    if (it && it.url) window.open(it.url, it.open_new_tab ? '_blank' : '_self', 'noopener');
  },
  'theme-menu': () => themeMenu(),
  'apply-theme': async el => {
    const name = el.dataset.name;
    state.user.theme = name;
    resolveTheme();
    closeDropdown();
    renderTopbar();
    api('/me/prefs', 'PUT', { theme: name }).catch(() => {});
  },
  'manage-themes': () => { closeDropdown(); openThemeManager(); },
  'user-menu': () => userMenu(),
  'manage-users': () => { closeDropdown(); openUserManager(); },
  'open-profile': () => { closeDropdown(); openProfile(); },
  'open-settings': () => { closeDropdown(); openSettings(); },
  'logout': async () => { closeDropdown(); try { await api('/logout', 'POST'); } catch (_) {} state.user = null; renderLogin(); }
};

function findItem(id) {
  if (!state.pageData) return null;
  for (const s of state.pageData.sections) { const it = s.items.find(x => x.id === id); if (it) return it; }
  return null;
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (handlers[act]) { e.preventDefault(); handlers[act](el, e); }
});

/* ----------------------------------------------------------- go */
init();
