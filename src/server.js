import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import './db.js';
import api from './api.js';
import { startMonitor } from './monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 2 * 1024 * 1024
});

await app.register(cookie);

// Static frontend
await app.register(fstatic, { root: PUBLIC_DIR, prefix: '/' });

// Self-hosted Tabler icon webfont (works offline)
const tablerDist = path.join(ROOT, 'node_modules', '@tabler', 'icons-webfont', 'dist');
if (fs.existsSync(tablerDist)) {
  await app.register(fstatic, { root: tablerDist, prefix: '/vendor/tabler/', decorateReply: false });
} else {
  app.log.warn('Tabler icons webfont not found in node_modules — run npm install');
}

// API
await app.register(api, { prefix: '/api' });

// SPA fallback: serve index.html for any non-API GET that 404s
app.setNotFoundHandler((req, reply) => {
  if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/vendor')) {
    return reply.type('text/html').sendFile('index.html');
  }
  reply.code(404).send({ error: 'Not found' });
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Smash Dash running on http://${HOST}:${PORT}`);
  startMonitor(); // begin periodic health checks (CHECK_INTERVAL_MS, default 30s)
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
