import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Default to a data dir next to the app (not the launch cwd) so the DB location
// is stable no matter where the process is started from. Override with DATA_DIR.
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'smashdash.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      theme TEXT,
      sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'ti-layout-dashboard',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'ti-folder',
      color TEXT NOT NULL DEFAULT 'accent',
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      subtitle TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'ti-link',
      open_new_tab INTEGER NOT NULL DEFAULT 1,
      health_url TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS themes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_dark INTEGER NOT NULL DEFAULT 1,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      tokens TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sections_page ON sections(page_id);
    CREATE INDEX IF NOT EXISTS idx_items_section ON items(section_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  // Columns added after v1 (SQLite lacks ADD COLUMN IF NOT EXISTS, so guard manually).
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');

  // Per-tile appearance (width / height / colour / icon size). Null = default look.
  // `size` was an earlier single width control — promote it to `width`, add `height`.
  let itemCols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  if (itemCols.includes('size') && !itemCols.includes('width')) {
    db.exec('ALTER TABLE items RENAME COLUMN size TO width');
    itemCols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  }
  for (const col of ['width', 'height', 'color', 'icon_size', 'name_size', 'sub_size'])
    if (!itemCols.includes(col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} TEXT`);
}

const BUILTIN_THEMES = [
  {
    name: 'Dark', is_dark: 1, tokens: {
      bg: '#0f1115', surface: '#171a21', card: '#1e222b', cardHover: '#262b36',
      text: '#e6e8ee', muted: '#9aa3b2', border: '#2a2f3a',
      accent: '#3b82f6', accentText: '#ffffff', accentSoft: 'rgba(59,130,246,0.16)',
      success: '#22c55e', danger: '#ef4444', warning: '#f59e0b'
    }
  },
  {
    name: 'Light', is_dark: 0, tokens: {
      bg: '#f3f4f6', surface: '#ffffff', card: '#ffffff', cardHover: '#eef0f3',
      text: '#1f2430', muted: '#6b7280', border: '#e5e7eb',
      accent: '#2563eb', accentText: '#ffffff', accentSoft: '#e8f0fe',
      success: '#16a34a', danger: '#dc2626', warning: '#d97706'
    }
  },
  {
    name: 'Midnight', is_dark: 1, tokens: {
      bg: '#0a0e1a', surface: '#0f1626', card: '#152138', cardHover: '#1c2a47',
      text: '#e7ecf5', muted: '#8b97ad', border: '#1f2c47',
      accent: '#6366f1', accentText: '#ffffff', accentSoft: 'rgba(99,102,241,0.18)',
      success: '#34d399', danger: '#f87171', warning: '#fbbf24'
    }
  },
  {
    name: 'Slate', is_dark: 1, tokens: {
      bg: '#1a1d23', surface: '#23272f', card: '#2b303a', cardHover: '#343a46',
      text: '#e3e6ea', muted: '#98a0ad', border: '#333944',
      accent: '#14b8a6', accentText: '#04221f', accentSoft: 'rgba(20,184,166,0.16)',
      success: '#22c55e', danger: '#ef4444', warning: '#f59e0b'
    }
  },
  {
    name: 'Nord', is_dark: 1, tokens: {
      bg: '#2e3440', surface: '#343b49', card: '#3b4252', cardHover: '#434c5e',
      text: '#eceff4', muted: '#aebacf', border: '#434c5e',
      accent: '#88c0d0', accentText: '#13232b', accentSoft: 'rgba(136,192,208,0.18)',
      success: '#a3be8c', danger: '#bf616a', warning: '#ebcb8b'
    }
  }
];

function seed() {
  const now = Date.now();

  // Admin user
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin';
    db.prepare(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)'
    ).run(username, bcrypt.hashSync(password, 10), 'admin', now);
    console.log(`[seed] created admin user "${username}"`);
  }

  // Themes
  const themeCount = db.prepare('SELECT COUNT(*) AS c FROM themes').get().c;
  if (themeCount === 0) {
    const ins = db.prepare(
      'INSERT INTO themes (name, is_dark, is_builtin, tokens) VALUES (?,?,1,?)'
    );
    for (const t of BUILTIN_THEMES) ins.run(t.name, t.is_dark, JSON.stringify(t.tokens));
  }

  // Settings
  const setIfMissing = (key, value) => {
    const row = db.prepare('SELECT 1 FROM settings WHERE key=?').get(key);
    if (!row) db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').run(key, value);
  };
  setIfMissing('app_title', 'Smash Dash');
  setIfMissing('default_theme', 'Dark');

  // Sample layout so first run is not empty
  const pageCount = db.prepare('SELECT COUNT(*) AS c FROM pages').get().c;
  if (pageCount === 0) seedSampleLayout(now);
}

function seedSampleLayout(now) {
  const insPage = db.prepare('INSERT INTO pages (name, icon, position, created_at) VALUES (?,?,?,?)');
  const insSection = db.prepare('INSERT INTO sections (page_id, title, icon, color, position) VALUES (?,?,?,?,?)');
  const insItem = db.prepare('INSERT INTO items (section_id, name, url, subtitle, icon, open_new_tab, position) VALUES (?,?,?,?,?,?,?)');

  const tx = db.transaction(() => {
    const home = insPage.run('Home', 'ti-home', 0, now).lastInsertRowid;
    const infra = insPage.run('Infrastructure', 'ti-server-2', 1, now).lastInsertRowid;
    insPage.run('Media', 'ti-movie', 2, now);
    insPage.run('Development', 'ti-code', 3, now);

    const quick = insSection.run(home, 'Quick links', 'ti-star', 'amber', 0).lastInsertRowid;
    insItem.run(quick, 'Google', 'https://google.com', 'google.com', 'ti-brand-google', 1, 0);
    insItem.run(quick, 'GitHub', 'https://github.com', 'github.com', 'ti-brand-github', 1, 1);

    const hyper = insSection.run(infra, 'Hypervisors', 'ti-server-2', 'accent', 0).lastInsertRowid;
    insItem.run(hyper, 'Proxmox node 1', 'http://10.0.0.11:8006', '10.0.0.11:8006', 'ti-server', 1, 0);
    insItem.run(hyper, 'Proxmox node 2', 'http://10.0.0.12:8006', '10.0.0.12:8006', 'ti-server', 1, 1);
    insItem.run(hyper, 'ESXi host', 'http://10.0.0.20', '10.0.0.20', 'ti-cloud-cog', 1, 2);

    const net = insSection.run(infra, 'Networking', 'ti-router', 'teal', 1).lastInsertRowid;
    insItem.run(net, 'pfSense', 'https://firewall.lan', 'firewall.lan', 'ti-shield-lock', 1, 0);
    insItem.run(net, 'UniFi controller', 'https://unifi.lan:8443', 'unifi.lan:8443', 'ti-access-point', 1, 1);
    insItem.run(net, 'Pi-hole', 'http://pihole.lan/admin', 'pihole.lan/admin', 'ti-shield-check', 1, 2);
  });
  tx();
  console.log('[seed] created sample layout');
}

migrate();
seed();

export default db;
