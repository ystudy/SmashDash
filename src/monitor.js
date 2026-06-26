import http from 'node:http';
import https from 'node:https';
import db from './db.js';

// Latest status per item id: { up, code, ms, checkedAt }. In-memory only (no history).
const status = {};
export function getStatus() { return status; }

// Reachability check. Any HTTP response (even 401/403/5xx) means the service is up;
// only DNS/connection/timeout failures count as down. Self-signed TLS is allowed
// (homelab services), and we never follow redirects — a 3xx is still "reachable".
function checkUrl(rawUrl, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(rawUrl); } catch { return resolve({ up: false }); }
    const lib = url.protocol === 'https:' ? https : http;
    const start = Date.now();
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = lib.request(url, {
      method: 'GET',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { 'User-Agent': 'SmashDash-HealthCheck' }
    }, (res) => {
      const ms = Date.now() - start;
      res.resume(); // drain so the socket can close
      finish({ up: true, code: res.statusCode, ms });
    });
    req.on('timeout', () => { req.destroy(); finish({ up: false, ms: Date.now() - start }); });
    req.on('error', () => finish({ up: false, ms: Date.now() - start }));
    req.end();
  });
}

async function runChecks(timeoutMs) {
  const items = db.prepare('SELECT id, url, health_url FROM items').all();
  const seen = new Set();
  await Promise.all(items.map(async (it) => {
    const target = (it.health_url && it.health_url.trim()) || it.url;
    if (!target || !/^https?:\/\//i.test(target)) { delete status[it.id]; return; } // no checkable URL → unknown
    seen.add(it.id);
    const r = await checkUrl(target, timeoutMs);
    status[it.id] = { up: r.up, code: r.code ?? null, ms: r.ms ?? null, checkedAt: Date.now() };
  }));
  // drop entries for items that no longer exist
  for (const id of Object.keys(status)) if (!seen.has(Number(id))) delete status[id];
}

function getTimeoutMs() {
  const t = Number(process.env.CHECK_TIMEOUT_MS);
  return Number.isFinite(t) && t > 0 ? t : 5000;
}

// Interval precedence: the `check_interval` setting (seconds, set in the UI) > CHECK_INTERVAL_MS env > 30s.
export function getIntervalMs() {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get('check_interval');
  if (row && row.value != null && row.value !== '') {
    const secs = Number(row.value);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  }
  const env = Number(process.env.CHECK_INTERVAL_MS);
  return Number.isFinite(env) && env >= 0 ? env : 30000;
}

let timer = null;
function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  const interval = getIntervalMs();
  if (!(interval > 0)) { for (const k of Object.keys(status)) delete status[k]; return; } // 0 = disabled → clear dots
  timer = setInterval(() => runChecks(getTimeoutMs()).catch(() => {}), interval);
  if (timer.unref) timer.unref(); // don't keep the process alive just for checks
}

export function startMonitor() {
  if (getIntervalMs() > 0) runChecks(getTimeoutMs()).catch(() => {});
  schedule();
}

// Re-check now and re-arm the timer — called when the interval setting changes.
export function rescheduleMonitor() {
  if (getIntervalMs() > 0) runChecks(getTimeoutMs()).catch(() => {});
  schedule();
}
