import db from './db.js';
import { getStatus, getIntervalMs, rescheduleMonitor } from './monitor.js';
import {
  COOKIE_NAME, hashPassword, verifyPassword,
  createSession, getUserByToken, destroySession
} from './auth.js';

const cookieOpts = (maxAge) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.COOKIE_SECURE === 'true',
  maxAge
});

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}

function themeByName(name) {
  return db.prepare('SELECT id, name, is_dark, is_builtin, tokens FROM themes WHERE name=?').get(name);
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, theme: u.theme, sidebar_collapsed: !!u.sidebar_collapsed, avatar: u.avatar || null };
}

export default async function api(fastify) {
  // Attach req.user from session cookie
  fastify.addHook('preHandler', async (req) => {
    req.user = getUserByToken(req.cookies?.[COOKIE_NAME]);
  });

  const requireAuth = (req, reply) => {
    if (!req.user) { reply.code(401).send({ error: 'Not authenticated' }); return false; }
    return true;
  };
  const requireAdmin = (req, reply) => {
    if (!req.user) { reply.code(401).send({ error: 'Not authenticated' }); return false; }
    if (req.user.role !== 'admin') { reply.code(403).send({ error: 'Admins only' }); return false; }
    return true;
  };

  // ---- Public (login screen styling) ----
  fastify.get('/public', async () => {
    const defaultThemeName = getSetting('default_theme', 'Dark');
    const t = themeByName(defaultThemeName) || db.prepare('SELECT * FROM themes LIMIT 1').get();
    return {
      app_title: getSetting('app_title', 'Smash Dash'),
      theme: t ? { name: t.name, is_dark: !!t.is_dark, tokens: JSON.parse(t.tokens) } : null
    };
  });

  // ---- Auth ----
  fastify.post('/login', async (req, reply) => {
    const { username, password } = req.body || {};
    if (!username || !password) return reply.code(400).send({ error: 'Username and password required' });
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
    if (!u || !verifyPassword(u.password_hash, password)) {
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    const { token, maxAge } = createSession(u.id);
    reply.setCookie(COOKIE_NAME, token, cookieOpts(maxAge));
    return { user: publicUser(u) };
  });

  fastify.post('/logout', async (req, reply) => {
    destroySession(req.cookies?.[COOKIE_NAME]);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  fastify.get('/me', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    return { user: publicUser(req.user) };
  });

  // ---- Bootstrap ----
  fastify.get('/bootstrap', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const pages = db.prepare('SELECT id, name, icon, position FROM pages ORDER BY position, id').all();
    const themes = db.prepare('SELECT id, name, is_dark, is_builtin, tokens FROM themes ORDER BY is_builtin DESC, name')
      .all().map(t => ({ ...t, is_dark: !!t.is_dark, is_builtin: !!t.is_builtin, tokens: JSON.parse(t.tokens) }));
    const settings = {
      app_title: getSetting('app_title', 'Smash Dash'),
      default_theme: getSetting('default_theme', 'Dark'),
      check_interval: Math.round(getIntervalMs() / 1000)
    };
    return { user: publicUser(req.user), pages, themes, settings };
  });

  // ---- Prefs (any authenticated user) ----
  fastify.put('/me/prefs', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const { theme, sidebar_collapsed, avatar } = req.body || {};
    if (theme !== undefined) {
      db.prepare('UPDATE users SET theme=? WHERE id=?').run(theme || null, req.user.id);
    }
    if (sidebar_collapsed !== undefined) {
      db.prepare('UPDATE users SET sidebar_collapsed=? WHERE id=?').run(sidebar_collapsed ? 1 : 0, req.user.id);
    }
    if (avatar !== undefined) {
      db.prepare('UPDATE users SET avatar=? WHERE id=?').run(avatar || null, req.user.id);
    }
    return { ok: true };
  });

  // ---- Status monitoring ----
  // { [itemId]: { up, code, ms, checkedAt } } — missing id = unknown / no health URL
  fastify.get('/status', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    return getStatus();
  });

  // ---- Pages ----
  fastify.get('/pages', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    return db.prepare('SELECT id, name, icon, position FROM pages ORDER BY position, id').all();
  });

  fastify.get('/pages/:id/full', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const page = db.prepare('SELECT id, name, icon, position FROM pages WHERE id=?').get(req.params.id);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    const sections = db.prepare('SELECT id, page_id, title, icon, color, position FROM sections WHERE page_id=? ORDER BY position, id').all(page.id);
    const itemStmt = db.prepare('SELECT id, section_id, name, url, subtitle, icon, open_new_tab, health_url, width, height, color, icon_size, name_size, sub_size, position FROM items WHERE section_id=? ORDER BY position, id');
    for (const s of sections) {
      s.items = itemStmt.all(s.id).map(it => ({ ...it, open_new_tab: !!it.open_new_tab }));
    }
    return { page, sections };
  });

  fastify.post('/pages', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { name, icon } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'Name required' });
    const pos = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM pages').get()).p;
    const info = db.prepare('INSERT INTO pages (name, icon, position, created_at) VALUES (?,?,?,?)')
      .run(name, icon || 'ti-layout-dashboard', pos, Date.now());
    return db.prepare('SELECT id, name, icon, position FROM pages WHERE id=?').get(info.lastInsertRowid);
  });

  fastify.put('/pages/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { name, icon } = req.body || {};
    const page = db.prepare('SELECT * FROM pages WHERE id=?').get(req.params.id);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    db.prepare('UPDATE pages SET name=?, icon=? WHERE id=?')
      .run(name ?? page.name, icon ?? page.icon, page.id);
    return db.prepare('SELECT id, name, icon, position FROM pages WHERE id=?').get(page.id);
  });

  fastify.delete('/pages/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    db.prepare('DELETE FROM pages WHERE id=?').run(req.params.id);
    return { ok: true };
  });

  fastify.post('/pages/reorder', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ids = (req.body?.ids || []).map(Number);
    const upd = db.prepare('UPDATE pages SET position=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    return { ok: true };
  });

  // ---- Sections ----
  fastify.post('/sections', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { page_id, title, icon, color } = req.body || {};
    if (!page_id || !title) return reply.code(400).send({ error: 'page_id and title required' });
    const pos = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM sections WHERE page_id=?').get(page_id)).p;
    const info = db.prepare('INSERT INTO sections (page_id, title, icon, color, position) VALUES (?,?,?,?,?)')
      .run(page_id, title, icon || 'ti-folder', color || 'accent', pos);
    return db.prepare('SELECT id, page_id, title, icon, color, position FROM sections WHERE id=?').get(info.lastInsertRowid);
  });

  fastify.put('/sections/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const s = db.prepare('SELECT * FROM sections WHERE id=?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Section not found' });
    const { title, icon, color } = req.body || {};
    db.prepare('UPDATE sections SET title=?, icon=?, color=? WHERE id=?')
      .run(title ?? s.title, icon ?? s.icon, color ?? s.color, s.id);
    return db.prepare('SELECT id, page_id, title, icon, color, position FROM sections WHERE id=?').get(s.id);
  });

  fastify.delete('/sections/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    db.prepare('DELETE FROM sections WHERE id=?').run(req.params.id);
    return { ok: true };
  });

  fastify.post('/sections/reorder', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ids = (req.body?.ids || []).map(Number);
    const upd = db.prepare('UPDATE sections SET position=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    return { ok: true };
  });

  // ---- Items ----
  fastify.post('/items', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { section_id, name, url, subtitle, icon, open_new_tab, health_url, width, height, color, icon_size, name_size, sub_size } = req.body || {};
    if (!section_id || !name) return reply.code(400).send({ error: 'section_id and name required' });
    const pos = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM items WHERE section_id=?').get(section_id)).p;
    const info = db.prepare(
      'INSERT INTO items (section_id, name, url, subtitle, icon, open_new_tab, health_url, width, height, color, icon_size, name_size, sub_size, position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(section_id, name, url || '', subtitle || '', icon || 'ti-link', open_new_tab ? 1 : 0, health_url || '', width || null, height || null, color || null, icon_size || null, name_size || null, sub_size || null, pos);
    const it = db.prepare('SELECT id, section_id, name, url, subtitle, icon, open_new_tab, health_url, width, height, color, icon_size, name_size, sub_size, position FROM items WHERE id=?').get(info.lastInsertRowid);
    return { ...it, open_new_tab: !!it.open_new_tab };
  });

  fastify.put('/items/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const it = db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id);
    if (!it) return reply.code(404).send({ error: 'Item not found' });
    const b = req.body || {};
    db.prepare('UPDATE items SET name=?, url=?, subtitle=?, icon=?, open_new_tab=?, health_url=?, width=?, height=?, color=?, icon_size=?, name_size=?, sub_size=? WHERE id=?')
      .run(
        b.name ?? it.name, b.url ?? it.url, b.subtitle ?? it.subtitle, b.icon ?? it.icon,
        (b.open_new_tab ?? it.open_new_tab) ? 1 : 0, b.health_url ?? it.health_url,
        b.width ?? it.width, b.height ?? it.height, b.color ?? it.color, b.icon_size ?? it.icon_size,
        b.name_size ?? it.name_size, b.sub_size ?? it.sub_size, it.id
      );
    const out = db.prepare('SELECT id, section_id, name, url, subtitle, icon, open_new_tab, health_url, width, height, color, icon_size, name_size, sub_size, position FROM items WHERE id=?').get(it.id);
    return { ...out, open_new_tab: !!out.open_new_tab };
  });

  fastify.delete('/items/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    db.prepare('DELETE FROM items WHERE id=?').run(req.params.id);
    return { ok: true };
  });

  fastify.post('/items/reorder', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ids = (req.body?.ids || []).map(Number);
    const sectionId = req.body?.section_id;
    const upd = sectionId
      ? db.prepare('UPDATE items SET position=?, section_id=? WHERE id=?')
      : db.prepare('UPDATE items SET position=? WHERE id=?');
    db.transaction(() => ids.forEach((id, i) => sectionId ? upd.run(i, sectionId, id) : upd.run(i, id)))();
    return { ok: true };
  });

  // ---- Themes ----
  fastify.get('/themes', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    return db.prepare('SELECT id, name, is_dark, is_builtin, tokens FROM themes ORDER BY is_builtin DESC, name')
      .all().map(t => ({ ...t, is_dark: !!t.is_dark, is_builtin: !!t.is_builtin, tokens: JSON.parse(t.tokens) }));
  });

  fastify.post('/themes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { name, is_dark, tokens } = req.body || {};
    if (!name || !tokens) return reply.code(400).send({ error: 'name and tokens required' });
    if (themeByName(name)) return reply.code(409).send({ error: 'A theme with that name already exists' });
    const info = db.prepare('INSERT INTO themes (name, is_dark, is_builtin, tokens) VALUES (?,?,0,?)')
      .run(name, is_dark ? 1 : 0, JSON.stringify(tokens));
    const t = db.prepare('SELECT id, name, is_dark, is_builtin, tokens FROM themes WHERE id=?').get(info.lastInsertRowid);
    return { ...t, is_dark: !!t.is_dark, is_builtin: !!t.is_builtin, tokens: JSON.parse(t.tokens) };
  });

  fastify.put('/themes/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const t = db.prepare('SELECT * FROM themes WHERE id=?').get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'Theme not found' });
    const { name, is_dark, tokens } = req.body || {};
    db.prepare('UPDATE themes SET name=?, is_dark=?, tokens=? WHERE id=?')
      .run(name ?? t.name, (is_dark ?? t.is_dark) ? 1 : 0, tokens ? JSON.stringify(tokens) : t.tokens, t.id);
    const out = db.prepare('SELECT id, name, is_dark, is_builtin, tokens FROM themes WHERE id=?').get(t.id);
    return { ...out, is_dark: !!out.is_dark, is_builtin: !!out.is_builtin, tokens: JSON.parse(out.tokens) };
  });

  fastify.delete('/themes/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const t = db.prepare('SELECT * FROM themes WHERE id=?').get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'Theme not found' });
    if (t.is_builtin) return reply.code(400).send({ error: 'Built-in themes cannot be deleted' });
    db.prepare('DELETE FROM themes WHERE id=?').run(t.id);
    return { ok: true };
  });

  // ---- Users (admin) ----
  fastify.get('/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return db.prepare('SELECT id, username, role, avatar, created_at FROM users ORDER BY username').all();
  });

  fastify.post('/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { username, password, role, avatar } = req.body || {};
    if (!username || !password) return reply.code(400).send({ error: 'Username and password required' });
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
      return reply.code(409).send({ error: 'Username already taken' });
    }
    const info = db.prepare('INSERT INTO users (username, password_hash, role, avatar, created_at) VALUES (?,?,?,?,?)')
      .run(username, hashPassword(password), role === 'admin' ? 'admin' : 'viewer', avatar || null, Date.now());
    return db.prepare('SELECT id, username, role, avatar, created_at FROM users WHERE id=?').get(info.lastInsertRowid);
  });

  fastify.put('/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return reply.code(404).send({ error: 'User not found' });
    const { username, password, role, avatar } = req.body || {};
    const newRole = role === undefined ? u.role : (role === 'admin' ? 'admin' : 'viewer');
    // Don't allow removing the last admin
    if (u.role === 'admin' && newRole !== 'admin') {
      const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c;
      if (admins <= 1) return reply.code(400).send({ error: 'Cannot demote the last admin' });
    }
    const newAvatar = avatar === undefined ? u.avatar : (avatar || null);
    db.prepare('UPDATE users SET username=?, role=?, avatar=? WHERE id=?').run(username ?? u.username, newRole, newAvatar, u.id);
    if (password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), u.id);
    return db.prepare('SELECT id, username, role, avatar, created_at FROM users WHERE id=?').get(u.id);
  });

  fastify.delete('/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return reply.code(404).send({ error: 'User not found' });
    if (u.role === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c;
      if (admins <= 1) return reply.code(400).send({ error: 'Cannot delete the last admin' });
    }
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    return { ok: true };
  });

  // ---- Settings ----
  fastify.get('/settings', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    return {
      app_title: getSetting('app_title', 'Smash Dash'),
      default_theme: getSetting('default_theme', 'Dark'),
      check_interval: Math.round(getIntervalMs() / 1000)
    };
  });

  fastify.put('/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { app_title, default_theme, check_interval } = req.body || {};
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    if (app_title !== undefined) set.run('app_title', String(app_title));
    if (default_theme !== undefined) set.run('default_theme', String(default_theme));
    let reschedule = false;
    if (check_interval !== undefined) {
      let secs = Math.round(Number(check_interval));
      if (!Number.isFinite(secs) || secs < 0) secs = 30;
      if (secs > 0 && secs < 5) secs = 5;        // floor so we don't hammer services
      if (secs > 86400) secs = 86400;
      set.run('check_interval', String(secs));
      reschedule = true;
    }
    if (reschedule) rescheduleMonitor();
    return { ok: true };
  });
}
