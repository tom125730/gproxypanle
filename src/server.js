import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, isUserActive } from './store.js';
import { clashSubscription, nodeConfigYaml, v2raynSubscription } from './subscriptions.js';
import {
  certificatesPage,
  dashboardPage,
  loginPage,
  nodesPage,
  settingsPage,
  subscriptionsPage,
  usersPage,
} from './ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'Aa.114514',
  sessionSecret: process.env.SESSION_SECRET || process.env.ADMIN_PASS || 'Aa.114514',
  dataFile: process.env.DATA_FILE || path.resolve(__dirname, '..', 'data', 'db.json'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
};

const store = new JsonStore(config.dataFile);
await store.load();
if (config.publicBaseUrl && !store.settings().publicBaseUrl) {
  await store.updateSettings({ publicBaseUrl: config.publicBaseUrl });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    send(res, 500, 'Internal Server Error\n', 'text/plain; charset=utf-8');
  }
});

server.listen(config.port, config.host, () => {
  console.log(`gproxy control plane listening on http://${config.host}:${config.port}`);
});

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (url.pathname.startsWith('/static/')) {
    return staticFile(req, res, url.pathname);
  }

  if (segments[0] === 'n' && segments[1]) {
    const node = store.getNode(segments[1]);
    if (!node || !node.enabled) return notFound(res);
    const publicBaseUrl = store.settings().publicBaseUrl || `${url.protocol}//${url.host}`;
    const configYaml = nodeConfigYaml(node, publicBaseUrl);
    return send(res, 200, configYaml, 'text/yaml; charset=utf-8');
  }

  if (segments[0] === 'c' && segments[1] && segments[2]) {
    const cert = store.getCert(segments[1]);
    if (!cert) return notFound(res);
    if (segments[2] === 'cert') return send(res, 200, cert.cert || '', 'application/x-pem-file; charset=utf-8');
    if (segments[2] === 'key') return send(res, 200, cert.key || '', 'application/x-pem-file; charset=utf-8');
  }

  if (segments[0] === 'sub' && segments[1] && segments[2]) {
    const user = store.getUser(segments[2]);
    if (!isUserActive(user)) return sendJson(res, 403, { error: 'subscription disabled or expired' });
    const nodes = store.listNodes().filter((node) => node.enabled);
    if (segments[1] === 'clash') return send(res, 200, clashSubscription(nodes), 'text/yaml; charset=utf-8');
    if (segments[1] === 'v2rayn') return send(res, 200, v2raynSubscription(nodes), 'text/plain; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/login') {
    return sendHtml(res, loginPage(url.searchParams.get('error') || ''));
  }
  if (req.method === 'POST' && url.pathname === '/login') {
    const input = await readBody(req);
    if (input.username === config.adminUser && input.password === config.adminPass) {
      setSession(res);
      return redirect(res, '/');
    }
    return redirect(res, '/login?error=Invalid%20username%20or%20password');
  }
  if (req.method === 'POST' && url.pathname === '/logout') {
    clearSession(res);
    return redirect(res, '/login');
  }

  if (!requireAuth(req, res, url)) return;

  if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, dashboardPage(store.metrics()));
  if (req.method === 'GET' && url.pathname === '/nodes') return sendHtml(res, nodesPage(store.listNodes(), store.listCerts()));
  if (req.method === 'GET' && segments[0] === 'nodes' && segments[1] && segments[2] === 'edit') {
    const node = store.getNode(segments[1]);
    return node ? sendHtml(res, nodesPage(store.listNodes(), store.listCerts(), node)) : notFound(res);
  }
  if (req.method === 'GET' && url.pathname === '/certificates') {
    return sendHtml(res, certificatesPage(store.listCerts(), null, adminAuthPair()));
  }
  if (req.method === 'GET' && segments[0] === 'certificates' && segments[1] && segments[2] === 'edit') {
    const cert = store.getCert(segments[1]);
    return cert ? sendHtml(res, certificatesPage(store.listCerts(), cert, adminAuthPair())) : notFound(res);
  }
  if (req.method === 'GET' && url.pathname === '/subscriptions') return sendHtml(res, subscriptionsPage(store.listUsers()));
  if (req.method === 'GET' && url.pathname === '/users') return sendHtml(res, usersPage(store.listUsers()));
  if (req.method === 'GET' && url.pathname === '/settings') return sendHtml(res, settingsPage(store.settings()));

  if (segments[0] === 'api') return apiRoute(req, res, segments.slice(1));

  return notFound(res);
}

async function apiRoute(req, res, segments) {
  const method = await effectiveMethod(req);

  if (method === 'GET' && segments[0] === 'nodes') return sendJson(res, 200, store.listNodes());
  if (method === 'GET' && segments[0] === 'node' && segments[1]) {
    const node = store.getNode(segments[1]);
    return node ? sendJson(res, 200, node) : notFound(res);
  }
  if (method === 'POST' && segments[0] === 'node') {
    const input = await readBody(req);
    const id = segments[1] || input.id;
    if (!id) return sendJson(res, 400, { error: 'node id is required' });
    const node = await store.setNode(id, input);
    return wantsJson(req) ? sendJson(res, 200, node) : redirect(res, '/nodes');
  }
  if (method === 'DELETE' && segments[0] === 'node' && segments[1]) {
    await store.deleteNode(segments[1]);
    return wantsJson(req) ? sendJson(res, 200, { ok: true }) : redirect(res, '/nodes');
  }

  if (method === 'GET' && segments[0] === 'certs') return sendJson(res, 200, store.listCerts());
  if (method === 'POST' && segments[0] === 'cert') {
    const input = await readBody(req);
    const id = segments[1] || input.id;
    if (!id) return sendJson(res, 400, { error: 'cert id is required' });
    const cert = await store.setCert(id, input);
    return wantsJson(req) ? sendJson(res, 200, cert) : redirect(res, '/certificates');
  }
  if (method === 'DELETE' && segments[0] === 'cert' && segments[1]) {
    await store.deleteCert(segments[1]);
    return wantsJson(req) ? sendJson(res, 200, { ok: true }) : redirect(res, '/certificates');
  }

  if (method === 'GET' && segments[0] === 'users') return sendJson(res, 200, store.listUsers());
  if (method === 'POST' && segments[0] === 'user') {
    const user = await store.setUser(await readBody(req));
    return wantsJson(req) ? sendJson(res, 200, user) : redirect(res, '/users');
  }
  if (method === 'DELETE' && segments[0] === 'user' && segments[1]) {
    await store.deleteUser(segments[1]);
    return wantsJson(req) ? sendJson(res, 200, { ok: true }) : redirect(res, '/users');
  }

  if (method === 'POST' && segments[0] === 'settings') {
    await store.updateSettings(await readBody(req));
    return redirect(res, '/settings');
  }

  return notFound(res);
}

function requireAuth(req, res, url) {
  if (hasValidSession(req) || hasBasicAuth(req)) return true;
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'authentication required' });
    return false;
  }
  redirect(res, '/login');
  return false;
}

function hasBasicAuth(req) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return user === config.adminUser && pass === config.adminPass;
}

function hasValidSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const session = cookies.gproxy_session;
  if (!session) return false;
  const [user, signature] = session.split('.');
  if (user !== config.adminUser || !signature) return false;
  return safeEqual(signature, signSession(user));
}

function setSession(res) {
  const value = `${config.adminUser}.${signSession(config.adminUser)}`;
  res.setHeader('Set-Cookie', `gproxy_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', 'gproxy_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function signSession(user) {
  return crypto.createHmac('sha256', config.sessionSecret).update(user).digest('base64url');
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, value.join('=')];
  }).filter(([key]) => key));
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminAuthPair() {
  return `${config.adminUser}:${config.adminPass}`;
}

async function effectiveMethod(req) {
  if (req.method !== 'POST') return req.method;
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/x-www-form-urlencoded')) return req.method;

  const input = await readBody(req);
  req.cachedBody = input;
  return input._method || req.method;
}

async function readBody(req) {
  if (req.cachedBody) return req.cachedBody;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('application/json')) {
    req.cachedBody = raw ? JSON.parse(raw) : {};
    return req.cachedBody;
  }

  const params = new URLSearchParams(raw);
  req.cachedBody = Object.fromEntries(params.entries());
  return req.cachedBody;
}

async function staticFile(req, res, pathname) {
  if (req.method !== 'GET') return notFound(res);
  const name = path.basename(pathname);
  const file = path.join(__dirname, '..', 'public', name);

  try {
    const body = await fs.readFile(file);
    const type = name.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : name.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';
    send(res, 200, body, type);
  } catch {
    notFound(res);
  }
}

function wantsJson(req) {
  const accept = req.headers.accept || '';
  return accept.includes('application/json') || (req.headers['content-type'] || '').includes('application/json');
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), 'application/json; charset=utf-8');
}

function sendHtml(res, body) {
  send(res, 200, body, 'text/html; charset=utf-8');
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  send(res, 404, 'Not Found\n', 'text/plain; charset=utf-8');
}
