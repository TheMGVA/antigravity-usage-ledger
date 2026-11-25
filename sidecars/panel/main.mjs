/**
 * @fileoverview Antigravity Sidecar entry (`SidecarApp`) + optional standalone HTTP mode
 * for `usage-ledger` ("多来源用量监控").
 *
 * Keeps the main SidecarApp process alive permanently, injects cache-busting asset URLs,
 * and hot-reloads `./ledger-engine.mjs` whenever its mtime changes.
 */

import { createServer } from 'node:http';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(dirname(HERE));
const ENGINE_PATH = join(HERE, 'ledger-engine.mjs');
const UPDATER_PATH = join(HERE, 'updater.mjs');
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

let cachedEngineMtime = -1;
let cachedEngineMod = null;
let cachedUpdaterMtime = -1;
let cachedUpdaterMod = null;

function computeUiVersion() {
  let max = 0;
  for (const p of [join(PLUGIN_ROOT, 'plugin.json'), join(HERE, 'index.html'), join(HERE, 'styles.css'), join(HERE, 'app.js')]) {
    try {
      const m = Math.floor(statSync(p).mtimeMs || 0);
      if (m > max) max = m;
    } catch {}
  }
  return String(max || Date.now());
}

async function getEngine() {
  let mtime = 0;
  try {
    mtime = Math.floor(statSync(ENGINE_PATH).mtimeMs || 0);
  } catch {}
  if (!cachedEngineMod || mtime !== cachedEngineMtime) {
    const url = `${pathToFileURL(ENGINE_PATH).href}?v=${mtime || Date.now()}`;
    cachedEngineMod = await import(url);
    cachedEngineMtime = mtime;
  }
  return cachedEngineMod;
}

async function getUpdater() {
  let mtime = 0;
  try {
    mtime = Math.floor(statSync(UPDATER_PATH).mtimeMs || 0);
  } catch {}
  if (!cachedUpdaterMod || mtime !== cachedUpdaterMtime) {
    const url = `${pathToFileURL(UPDATER_PATH).href}?v=${mtime || Date.now()}`;
    cachedUpdaterMod = await import(url);
    cachedUpdaterMod.registerHotRestartHandler?.(() => {
      cachedEngineMtime = -1;
      cachedUpdaterMtime = -1;
    });
    cachedUpdaterMtime = mtime;
  }
  return cachedUpdaterMod;
}

async function readAsset(name) {
  return readFile(join(HERE, name), 'utf8');
}

async function renderIndexHtml() {
  const raw = await readAsset('index.html');
  const v = computeUiVersion();
  return raw
    .replace('href="/styles.css"', `href="/styles.css?v=${v}"`)
    .replace('src="/app.js"', `src="/app.js?v=${v}"`);
}

async function handleGetLedger(data = {}) {
  const engine = await getEngine();
  const range = String(data?.range || 'all');
  const force = data?.force === true || data?.force === '1' || data?.force === 'true';
  let customStartMs = Number(data?.startMs || 0);
  let customEndMs = Number(data?.endMs || 0);
  if (!(customStartMs > 0) && data?.startIso) customStartMs = engine.parseIsoMs(String(data.startIso));
  if (!(customEndMs > 0) && data?.endIso) customEndMs = engine.parseIsoMs(String(data.endIso));
  const snap = await engine.buildLedgerSnapshot({
    range,
    customStartMs: Number.isFinite(customStartMs) && customStartMs > 0 ? customStartMs : 0,
    customEndMs: Number.isFinite(customEndMs) && customEndMs > 0 ? customEndMs : 0,
    forceHostRefresh: force,
  });
  return { ...snap, uiVersion: computeUiVersion() };
}

async function handleUpdateConfig(data = {}) {
  const engine = await getEngine();
  return await engine.mutateLedgerConfig(data);
}

async function handlePluginUpdate(data = {}) {
  const updater = await getUpdater();
  return await updater.handleUpdaterAction(data);
}

async function readLogoSvg() {
  return readFile(join(HERE, '..', '..', 'assets', 'logo.svg'), 'utf8');
}

async function startSidecarMode() {
  const { Response, SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', async () => new Response(await renderIndexHtml(), {
    contentType: 'text/html; charset=utf-8',
    headers: NO_STORE,
  }));
  app.page('/logo.svg', async () => new Response(await readLogoSvg(), {
    contentType: 'image/svg+xml; charset=utf-8',
    headers: NO_STORE,
  }));
  app.page('/styles.css', async () => new Response(await readAsset('styles.css'), {
    contentType: 'text/css; charset=utf-8',
    headers: NO_STORE,
  }));
  app.page('/app.js', async () => new Response(await readAsset('app.js'), {
    contentType: 'application/javascript; charset=utf-8',
    headers: NO_STORE,
  }));

  app.api('/api/ledger', (data) => handleGetLedger(data), 'GET');
  app.api('/api/ledger', (data) => handleGetLedger(data), 'POST');
  app.api('/api/config', (data) => handleUpdateConfig(data), 'POST');
  app.api('/api/update', (data) => handlePluginUpdate(data), 'GET');
  app.api('/api/update', (data) => handlePluginUpdate(data), 'POST');

  await app.run();
}

async function startStandaloneFallback(port = 51888) {
  const preloadStub = `window.sidecar = {
    fetch: (url, opts) => window.fetch(url, opts),
    ui: { toggleConversation() {} }
  };`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE });
        res.end(await renderIndexHtml());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/logo.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', ...NO_STORE });
        res.end(await readLogoSvg());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/styles.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', ...NO_STORE });
        res.end(await readAsset('styles.css'));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...NO_STORE });
        res.end(await readAsset('app.js'));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...NO_STORE });
        res.end(preloadStub);
        return;
      }
      if (url.pathname === '/api/ledger') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const params = Object.fromEntries(url.searchParams.entries());
        if (body) Object.assign(params, JSON.parse(body));
        const out = await handleGetLedger(params);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE });
        res.end(JSON.stringify(out));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const out = await handleUpdateConfig(body ? JSON.parse(body) : {});
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE });
        res.end(JSON.stringify(out));
        return;
      }
      if (url.pathname === '/api/update') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const params = Object.fromEntries(url.searchParams.entries());
        if (body) Object.assign(params, JSON.parse(body));
        const out = await handlePluginUpdate(params);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE });
        res.end(JSON.stringify(out));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[usage-ledger] Standalone Web UI running at http://127.0.0.1:${port}`);
  });
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT && process.env.ANTIGRAVITY_LS_ADDRESS) {
  startSidecarMode().catch((err) => {
    console.error('[usage-ledger] Failed to start SidecarApp:', err);
    process.exit(1);
  });
} else {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) || 51888 : 51888;
  startStandaloneFallback(port);
}
