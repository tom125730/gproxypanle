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
  reportPage,
  settingsPage,
  cloudTestPage,
  subscriptionsPage,
  trafficPanelBody,
  usersPage,
} from './ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || crypto.randomBytes(24).toString('base64url'),
  sessionSecret: process.env.SESSION_SECRET || process.env.ADMIN_PASS || crypto.randomBytes(32).toString('base64url'),
  dataFile: process.env.DATA_FILE || path.resolve(__dirname, '..', 'data', 'db.json'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 1048576),
  secureCookies: process.env.COOKIE_SECURE === 'true' || (process.env.PUBLIC_BASE_URL || '').startsWith('https://'),
};

const loginAttempts = new Map();

const store = new JsonStore(config.dataFile);
await store.load();
if (config.publicBaseUrl && !store.settings().publicBaseUrl) {
  await store.updateSettings({ publicBaseUrl: config.publicBaseUrl });
}
warnInsecureDefaults();
await ensureAdminPasswordHash();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    if (error.statusCode === 413) {
      return send(res, 413, 'Payload Too Large\n', 'text/plain; charset=utf-8');
    }
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
    if (!segments[2] || !safeEqual(segments[2], node.configToken || '')) return notFound(res);
    if (segments[3] === 'cert' || segments[3] === 'key') {
      const cert = node.certId ? store.getCert(node.certId) : null;
      if (!cert) return notFound(res);
      if (segments[3] === 'cert') return send(res, 200, cert.cert || '', 'application/x-pem-file; charset=utf-8');
      return send(res, 200, cert.key || '', 'application/x-pem-file; charset=utf-8');
    }
    const publicBaseUrl = store.settings().publicBaseUrl || `${url.protocol}//${url.host}`;
    const configYaml = nodeConfigYaml(node, publicBaseUrl);
    return send(res, 200, configYaml, 'text/yaml; charset=utf-8');
  }

  if (segments[0] === 'c' && segments[1] && segments[2]) {
    const cert = store.getCert(segments[1]);
    if (!cert) return notFound(res);
    if (segments[2] === 'cert') return send(res, 200, cert.cert || '', 'application/x-pem-file; charset=utf-8');
    if (segments[2] === 'key' && !isAuthenticated(req, url)) return notFound(res);
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
    return sendHtml(res, loginPage(url.searchParams.get('error') || '', securityStatus()));
  }
  if (req.method === 'POST' && url.pathname === '/login') {
    const input = await readBody(req);
    const loginKey = loginAttemptKey(req, input.username || '');
    if (isLoginLocked(loginKey)) {
      return redirect(res, '/login?error=Too%20many%20login%20attempts%2C%20try%20again%20later');
    }
    if (await verifyAdminLogin(input)) {
      clearLoginAttempts(loginKey);
      setSession(res, securityVersion());
      return redirect(res, '/');
    }
    recordFailedLogin(loginKey);
    return redirect(res, '/login?error=Invalid%20username%20or%20password');
  }
  if (req.method === 'POST' && url.pathname === '/logout') {
    clearSession(res);
    return redirect(res, '/login');
  }

  if (segments[0] === 'api' && segments[1] === 'node' && segments[2] && segments[3] === 'agent') {
    return nodeAgentRoute(req, res, segments[2]);
  }

  if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'traffic') {
    return cloudTrafficRoute(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return sendHtml(res, dashboardPage(store.metrics(), isAuthenticated(req, url)));
  }

  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'metrics' && segments[2] === 'traffic') {
    return trafficMetricsRoute(res);
  }

  if (!requireAuth(req, res, url)) return;

  if (req.method === 'GET' && url.pathname === '/report') return sendHtml(res, reportPage(store.listNodes()));
  if (req.method === 'GET' && url.pathname === '/cloud-test') {
    return sendHtml(res, cloudTestPage(cloudTestModel(req)));
  }
  if (req.method === 'GET' && url.pathname === '/nodes') return sendHtml(res, nodesPage(store.listNodes(), store.listCerts()));
  if (req.method === 'GET' && segments[0] === 'nodes' && segments[1] && segments[2] === 'edit') {
    const node = store.getNode(segments[1]);
    return node ? sendHtml(res, nodesPage(store.listNodes(), store.listCerts(), node)) : notFound(res);
  }
  if (req.method === 'GET' && url.pathname === '/certificates') {
    return sendHtml(res, certificatesPage(store.listCerts()));
  }
  if (req.method === 'GET' && segments[0] === 'certificates' && segments[1] && segments[2] === 'edit') {
    const cert = store.getCert(segments[1]);
    return cert ? sendHtml(res, certificatesPage(store.listCerts(), cert)) : notFound(res);
  }
  if (req.method === 'GET' && url.pathname === '/subscriptions') return sendHtml(res, subscriptionsPage(store.listUsers()));
  if (req.method === 'GET' && url.pathname === '/users') return sendHtml(res, usersPage(store.listUsers()));
  if (req.method === 'GET' && url.pathname === '/settings') {
    return sendHtml(res, settingsPage(
      store.settings(),
      securityStatus(),
      url.searchParams.get('error') || '',
    ));
  }

  if (segments[0] === 'api') return apiRoute(req, res, segments.slice(1));

  return notFound(res);
}

async function apiRoute(req, res, segments) {
  const method = await effectiveMethod(req);

  if (method === 'GET' && segments[0] === 'metrics' && segments[1] === 'traffic') {
    return trafficMetricsRoute(res);
  }

  if (method === 'DELETE' && segments[0] === 'cloud-test' && segments[1] === 'reports') {
    await store.clearCloudTrafficReports();
    return wantsJson(req) ? sendJson(res, 200, { ok: true }) : redirect(res, '/cloud-test');
  }

  if (method === 'GET' && segments[0] === 'nodes') return sendJson(res, 200, store.listNodes());
  if (method === 'GET' && segments[0] === 'node' && segments[1]) {
    const node = store.getNode(segments[1]);
    return node ? sendJson(res, 200, node) : notFound(res);
  }
  if (method === 'POST' && segments[0] === 'node' && segments[1] && segments[2] === 'deploy') {
    return createNodeDeployCommand(req, res, segments[1]);
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
  if (method === 'POST' && segments[0] === 'security' && segments[1] === 'password') {
    return updatePasswordRoute(req, res);
  }
  if (method === 'POST' && segments[0] === 'security' && segments[1] === '2fa' && segments[2] === 'prepare') {
    return prepareTwoFactorRoute(req, res);
  }
  if (method === 'POST' && segments[0] === 'security' && segments[1] === '2fa' && segments[2] === 'enable') {
    return enableTwoFactorRoute(req, res);
  }
  if (method === 'POST' && segments[0] === 'security' && segments[1] === '2fa' && segments[2] === 'disable') {
    return disableTwoFactorRoute(req, res);
  }

  return notFound(res);
}

function trafficMetricsRoute(res) {
  const metrics = store.metrics();
  return sendJson(res, 200, {
    totalConnections: metrics.totalConnections,
    html: trafficPanelBody(metrics),
  });
}

async function nodeAgentRoute(req, res, nodeId) {
  if (req.method !== 'POST') return notFound(res);

  const node = store.getNode(nodeId);
  if (!node) return notFound(res);

  const token = bearerToken(req);
  if (!token || !safeEqual(token, node.agentToken || '')) {
    return sendJson(res, 401, { error: 'invalid node agent token' });
  }

  const input = await readBody(req);
  if (input.commandResult && typeof input.commandResult === 'object') {
    await recordNodeCommandResult(nodeId, node, input.commandResult);
  }

  const updatedNode = await store.recordNodeAgentReport(nodeId, input, clientAddress(req));
  return sendJson(res, 200, {
    ok: true,
    agent: updatedNode.agent,
    command: pendingAgentCommand(updatedNode),
  });
}

async function cloudTrafficRoute(req, res, url) {
  if (req.method !== 'POST') return notFound(res);

  const input = await readBody(req);
  if (!Array.isArray(input)) {
    return sendJson(res, 400, { code: 400, message: 'traffic body must be an array', data: null });
  }

  await store.recordCloudTrafficReport({
    method: req.method,
    path: url.pathname,
    nodeKey: req.headers['x-node-key'] || '',
    remoteAddress: clientAddress(req),
    headers: req.headers,
    entries: input,
  });

  return sendJson(res, 200, { code: 0, message: 'ok', data: null });
}

function cloudTestModel(req) {
  const publicBaseUrl = store.settings().publicBaseUrl || requestBaseUrl(req);
  return {
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    reports: store.listCloudTrafficReports(),
  };
}

async function createNodeDeployCommand(req, res, nodeId) {
  const node = store.getNode(nodeId);
  if (!node) return notFound(res);

  const publicBaseUrl = store.settings().publicBaseUrl || requestBaseUrl(req);
  const configPath = `/n/${encodeURIComponent(node.id)}/${encodeURIComponent(node.configToken || '')}`;
  const command = {
    id: crypto.randomUUID(),
    type: 'deploy-docker',
    status: 'pending',
    configUrl: `${publicBaseUrl.replace(/\/+$/, '')}${configPath}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await store.setNodeAgentCommand(nodeId, command);
  return wantsJson(req) ? sendJson(res, 200, { ok: true, command }) : redirect(res, '/nodes');
}

async function recordNodeCommandResult(nodeId, node, result) {
  const command = node.agentCommand;
  if (!command || result.id !== command.id) return;

  await store.setNodeAgentCommand(nodeId, {
    ...command,
    status: result.ok ? 'succeeded' : 'failed',
    exitCode: Number(result.exitCode ?? 0),
    output: String(result.output || '').slice(0, 2000),
    error: String(result.error || '').slice(0, 1000),
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function pendingAgentCommand(node) {
  const command = node.agentCommand;
  if (!command || command.status !== 'pending') return null;
  return {
    id: command.id,
    type: command.type,
    configUrl: command.configUrl,
  };
}

function requireAuth(req, res, url) {
  if (isAuthenticated(req, url)) return true;
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'authentication required' });
    return false;
  }
  redirect(res, '/login');
  return false;
}

function isAuthenticated(req, url) {
  return hasValidSession(req) || hasBasicAuth(req, url) || hasCertUploadToken(req, url);
}

async function verifyAdminLogin(input) {
  if (input.username !== config.adminUser) return false;
  if (!await verifyAdminPassword(input.password || '')) return false;

  const security = store.security();
  if (!security.twoFactorEnabled) return true;
  return verifyTotp(security.twoFactorSecret, input.totp || '');
}

function hasBasicAuth(req, url) {
  if (store.security().twoFactorEnabled && !isBasicAuthAllowed(req, url)) return false;

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return user === config.adminUser && verifyPasswordSync(pass, store.security().adminPasswordHash);
}

function isBasicAuthAllowed(req, url) {
  return req.method === 'POST' && url.pathname.startsWith('/api/cert');
}

function hasCertUploadToken(req, url) {
  if (req.method !== 'POST' || !url.pathname.startsWith('/api/cert')) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  const cert = segments[2] ? store.getCert(segments[2]) : null;
  const token = url.searchParams.get('token') || '';
  return Boolean(cert?.uploadToken && token && safeEqual(token, cert.uploadToken));
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const separator = header.indexOf(' ');
  if (separator < 0) return '';
  const scheme = header.slice(0, separator);
  if (scheme !== 'Bearer') return '';
  return header.slice(separator + 1);
}

function hasValidSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const session = cookies.gproxy_session;
  if (!session) return false;
  const [user, version, signature] = session.split('.');
  if (user !== config.adminUser || !version || !signature) return false;
  if (Number(version) !== securityVersion()) return false;
  return safeEqual(signature, signSession(user, version));
}

function setSession(res, version) {
  const value = `${config.adminUser}.${version}.${signSession(config.adminUser, version)}`;
  res.setHeader('Set-Cookie', sessionCookie(`gproxy_session=${value}; Max-Age=604800`));
}

function clearSession(res) {
  res.setHeader('Set-Cookie', sessionCookie('gproxy_session=; Max-Age=0'));
}

function sessionCookie(value) {
  return `${value}; HttpOnly; SameSite=Lax; Path=/${config.secureCookies ? '; Secure' : ''}`;
}

function signSession(user, version) {
  return crypto.createHmac('sha256', config.sessionSecret).update(`${user}.${version}`).digest('base64url');
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, value.join('=')];
  }).filter(([key]) => key));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientAddress(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || req.socket.remoteAddress || '';
}

function requestBaseUrl(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  return `${protocol}://${req.headers.host || 'localhost'}`;
}

function loginAttemptKey(req, username) {
  return `${clientAddress(req)}:${String(username).slice(0, 80)}`;
}

function isLoginLocked(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (attempt.lockedUntil && attempt.lockedUntil > Date.now()) return true;
  if (attempt.lockedUntil) loginAttempts.delete(key);
  return false;
}

function recordFailedLogin(key) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const attempt = loginAttempts.get(key);
  const count = attempt && attempt.firstAt + windowMs > now ? attempt.count + 1 : 1;
  loginAttempts.set(key, {
    count,
    firstAt: attempt && attempt.firstAt + windowMs > now ? attempt.firstAt : now,
    lockedUntil: count >= 6 ? now + windowMs : 0,
  });
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

function warnInsecureDefaults() {
  if (!process.env.ADMIN_PASS) {
    console.warn('WARNING: ADMIN_PASS is not set. A one-time random initial password was generated for this process.');
    console.warn(`WARNING: Initial admin password: ${config.adminPass}`);
    console.warn('WARNING: Set ADMIN_PASS before first persistent deployment or change the password in Settings.');
  }
  if (!process.env.SESSION_SECRET) {
    console.warn('WARNING: SESSION_SECRET is not set. Set a long random SESSION_SECRET before exposing this panel.');
  }
}

async function updatePasswordRoute(req, res) {
  const input = await readBody(req);
  if (!await verifyAdminPassword(input.currentPassword || '')) {
    return redirect(res, '/settings?error=Invalid%20current%20password');
  }
  if (!input.newPassword || String(input.newPassword).length < 8) {
    return redirect(res, '/settings?error=New%20password%20must%20be%20at%20least%208%20characters');
  }
  if (input.newPassword !== input.confirmPassword) {
    return redirect(res, '/settings?error=New%20passwords%20do%20not%20match');
  }

  await store.updateSecurity({
    adminPasswordHash: await hashPassword(input.newPassword),
    sessionVersion: securityVersion() + 1,
  });
  clearSession(res);
  return redirect(res, '/login?error=Password%20updated%2C%20please%20sign%20in');
}

async function prepareTwoFactorRoute(req, res) {
  const input = await readBody(req);
  if (!await verifyAdminPassword(input.currentPassword || '')) {
    return redirect(res, '/settings?error=Invalid%20current%20password');
  }

  await store.updateSecurity({ pendingTwoFactorSecret: newTotpSecret() });
  return redirect(res, '/settings');
}

async function enableTwoFactorRoute(req, res) {
  const input = await readBody(req);
  const security = store.security();
  if (!security.pendingTwoFactorSecret) {
    return redirect(res, '/settings?error=Start%202FA%20setup%20first');
  }
  if (!await verifyAdminPassword(input.currentPassword || '')) {
    return redirect(res, '/settings?error=Invalid%20current%20password');
  }
  if (!verifyTotp(security.pendingTwoFactorSecret, input.totp || '')) {
    return redirect(res, '/settings?error=Invalid%202FA%20code');
  }

  await store.updateSecurity({
    twoFactorEnabled: true,
    twoFactorSecret: security.pendingTwoFactorSecret,
    pendingTwoFactorSecret: '',
    sessionVersion: securityVersion() + 1,
  });
  clearSession(res);
  return redirect(res, '/login?error=2FA%20enabled%2C%20please%20sign%20in');
}

async function disableTwoFactorRoute(req, res) {
  const input = await readBody(req);
  const security = store.security();
  if (!await verifyAdminPassword(input.currentPassword || '')) {
    return redirect(res, '/settings?error=Invalid%20current%20password');
  }
  if (!verifyTotp(security.twoFactorSecret, input.totp || '')) {
    return redirect(res, '/settings?error=Invalid%202FA%20code');
  }

  await store.updateSecurity({
    twoFactorEnabled: false,
    twoFactorSecret: '',
    pendingTwoFactorSecret: '',
    sessionVersion: securityVersion() + 1,
  });
  clearSession(res);
  return redirect(res, '/login?error=2FA%20disabled%2C%20please%20sign%20in');
}

async function ensureAdminPasswordHash() {
  const security = store.security();
  if (security.adminPasswordHash) return;
  await store.updateSecurity({ adminPasswordHash: await hashPassword(config.adminPass) });
}

function securityStatus() {
  const security = store.security();
  const pendingSecret = security.pendingTwoFactorSecret || '';
  return {
    twoFactorEnabled: Boolean(security.twoFactorEnabled),
    pendingTwoFactorSecret: pendingSecret,
    pendingTwoFactorUri: pendingSecret ? totpUri(pendingSecret) : '',
  };
}

function securityVersion() {
  return Number(store.security().sessionVersion || 1);
}

async function verifyAdminPassword(password) {
  return verifyPassword(password, store.security().adminPasswordHash);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const iterations = 210000;
  const key = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${salt}$${key.toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  if (!encoded) return false;
  const parts = String(encoded).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const expected = Buffer.from(parts[3], 'base64url');
  const actual = await pbkdf2(password, parts[2], iterations);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function verifyPasswordSync(password, encoded) {
  if (!encoded) return false;
  const parts = String(encoded).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const expected = Buffer.from(parts[3], 'base64url');
  const actual = crypto.pbkdf2Sync(String(password), parts[2], iterations, 32, 'sha256');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function pbkdf2(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password), salt, iterations, 32, 'sha256', (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function verifyTotp(secret, input) {
  const code = String(input || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((offset) => safeEqual(totpCode(secret, now + offset), code));
}

function totpCode(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const value = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(value % 1000000).padStart(6, '0');
}

function totpUri(secret) {
  const label = encodeURIComponent(`gproxy:${config.adminUser}`);
  const issuer = encodeURIComponent('gproxy');
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let number = 0;
  const bytes = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    number = (number << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((number >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
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
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) {
      const error = new Error('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
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
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function notFound(res) {
  send(res, 404, 'Not Found\n', 'text/plain; charset=utf-8');
}
