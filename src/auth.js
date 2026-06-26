import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import db from './db.js';

const SESSION_DAYS = 30;
export const COOKIE_NAME = 'sd_session';

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(hash, plain) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function getUserByToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(token);
    return null;
  }
  return db.prepare(
    'SELECT id, username, role, theme, sidebar_collapsed, avatar FROM users WHERE id=?'
  ).get(s.user_id) || null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id=?').run(token);
}
