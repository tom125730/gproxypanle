import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const emptyDb = {
  nodes: {},
  certs: {},
  users: {},
  settings: {
    publicBaseUrl: '',
  },
};

const defaultNodeSecret = '3c999130';
const agentStaleMs = 180000;

export class JsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.db = structuredClone(emptyDb);
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const { db, changed } = mergeDb(JSON.parse(raw));
      this.db = db;
      if (changed) await this.save();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.db = structuredClone(emptyDb);
      await this.save();
    }

    this.loaded = true;
  }

  async save() {
    const payload = JSON.stringify(this.db, null, 2);
    this.writeQueue = this.writeQueue.then(() => fs.writeFile(this.filePath, payload));
    await this.writeQueue;
  }

  metrics() {
    const now = Date.now();
    const nodes = Object.values(this.db.nodes).map(withNodeAgentStatus);
    const certs = Object.values(this.db.certs);
    const users = Object.values(this.db.users);
    const statusCounts = {
      up: 0,
      down: 0,
      stale: 0,
      waiting: 0,
      disabled: 0,
    };

    let totalRxBytes = 0;
    let totalTxBytes = 0;
    let totalConnections = 0;
    let latencySum = 0;
    let latencyCount = 0;

    const nodeTraffic = nodes.map((node) => {
      const agent = node.agent || {};
      const rxBytes = toNonNegativeNumber(agent.rxBytes);
      const txBytes = toNonNegativeNumber(agent.txBytes);
      const totalBytes = rxBytes + txBytes;

      statusCounts[agent.state] = (statusCounts[agent.state] || 0) + 1;
      totalRxBytes += rxBytes;
      totalTxBytes += txBytes;
      totalConnections += toNonNegativeNumber(agent.connections);

      if (Number.isFinite(agent.latencyMs)) {
        latencySum += agent.latencyMs;
        latencyCount += 1;
      }

      return {
        id: node.id,
        name: node.name || node.id,
        state: agent.state,
        rxBytes,
        txBytes,
        totalBytes,
        latencyMs: agent.latencyMs ?? null,
      };
    }).sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 8);

    return {
      totalNodes: nodes.length,
      onlineNodes: statusCounts.up,
      reportingNodes: nodes.filter((node) => node.agent.reportedAt).length,
      statusCounts,
      totalRxBytes,
      totalTxBytes,
      totalTrafficBytes: totalRxBytes + totalTxBytes,
      totalConnections,
      averageLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : null,
      nodeTraffic,
      totalCertificates: certs.length,
      expiringCertificates: certs.filter((cert) => {
        if (!cert.notAfter) return false;
        const days = Math.ceil((new Date(cert.notAfter).getTime() - now) / 86400000);
        return days >= 0 && days <= 30;
      }).length,
      totalUsers: users.length,
      activeSubscriptionTokens: users.filter((user) => isUserActive(user)).length,
    };
  }

  listNodes() {
    return Object.values(this.db.nodes).map(withNodeAgentStatus).sort(byId);
  }

  getNode(id) {
    const node = this.db.nodes[id];
    return node ? withNodeAgentStatus(node) : null;
  }

  async setNode(id, input) {
    const now = new Date().toISOString();
    const previous = this.db.nodes[id] || {};
    const node = {
      id,
      name: input.name || previous.name || id,
      host: input.host || previous.host || '',
      port: Number(input.port || previous.port || 443),
      listen: input.listen || previous.listen || `0.0.0.0:${Number(input.port || previous.port || 443)}`,
      sni: input.sni || previous.sni || input.host || '',
      password: input.password || previous.password || defaultNodeSecret,
      certId: input.certId || previous.certId || '',
      agentToken: input.agentToken || previous.agentToken || newAgentToken(),
      agent: previous.agent || null,
      socks5: toBool(input.socks5, previous.socks5 ?? false),
      relay: toBool(input.relay, previous.relay ?? false),
      wspaths: input.wspaths || previous.wspaths || '/gproxy',
      enabled: toBool(input.enabled, previous.enabled ?? true),
      yaml: input.yaml || previous.yaml || '',
      updatedAt: now,
      createdAt: previous.createdAt || now,
    };

    this.db.nodes[id] = node;
    await this.save();
    return node;
  }

  async recordNodeAgentReport(id, input, remoteAddress = '') {
    const node = this.db.nodes[id];
    if (!node) return null;

    const now = new Date().toISOString();
    const previous = node.agent || {};
    const rxCounter = toNonNegativeNumber(input.rxBytes ?? input.rxCounter);
    const txCounter = toNonNegativeNumber(input.txBytes ?? input.txCounter);
    const rxDelta = counterDelta(previous.rxCounter, rxCounter);
    const txDelta = counterDelta(previous.txCounter, txCounter);

    node.agent = {
      status: input.status === 'up' ? 'up' : 'down',
      latencyMs: toNullableNumber(input.latencyMs),
      error: trimString(input.error, 240),
      rxBytes: toNonNegativeNumber(previous.rxBytes) + rxDelta,
      txBytes: toNonNegativeNumber(previous.txBytes) + txDelta,
      lastRxBytes: rxDelta,
      lastTxBytes: txDelta,
      rxCounter,
      txCounter,
      connections: toNonNegativeNumber(input.connections),
      uptimeSeconds: toNonNegativeNumber(input.uptimeSeconds),
      version: trimString(input.version, 40),
      remoteAddress: trimString(remoteAddress, 80),
      reportedAt: now,
    };

    await this.save();
    return withNodeAgentStatus(node).agent;
  }

  async deleteNode(id) {
    delete this.db.nodes[id];
    await this.save();
  }

  listCerts() {
    return Object.values(this.db.certs).map(withCertDays).sort(byId);
  }

  getCert(id) {
    const cert = this.db.certs[id];
    return cert ? withCertDays(cert) : null;
  }

  async setCert(id, input) {
    const now = new Date().toISOString();
    const previous = this.db.certs[id] || {};
    const parsed = parseCertificate(input.cert || previous.cert || '');
    const cert = withCertDays({
      id,
      domain: input.domain || previous.domain || '',
      issuer: input.issuer || parsed.issuer || previous.issuer || '',
      notBefore: input.notBefore || parsed.notBefore || previous.notBefore || '',
      notAfter: input.notAfter || parsed.notAfter || previous.notAfter || '',
      cert: input.cert || previous.cert || '',
      key: input.key || previous.key || '',
      updatedAt: now,
      createdAt: previous.createdAt || now,
    });

    this.db.certs[id] = cert;
    await this.save();
    return cert;
  }

  async deleteCert(id) {
    delete this.db.certs[id];
    await this.save();
  }

  listUsers() {
    return Object.values(this.db.users).sort(byName);
  }

  getUser(token) {
    return this.db.users[token] || null;
  }

  async setUser(input) {
    const now = new Date().toISOString();
    const token = input.token || crypto.randomUUID();
    const previous = this.db.users[token] || {};
    const user = {
      token,
      name: input.name || previous.name || 'default',
      enabled: toBool(input.enabled, previous.enabled ?? true),
      expireAt: input.expireAt || previous.expireAt || '',
      trafficLimit: Number(input.trafficLimit || previous.trafficLimit || 0),
      updatedAt: now,
      createdAt: previous.createdAt || now,
    };

    this.db.users[token] = user;
    await this.save();
    return user;
  }

  async deleteUser(token) {
    delete this.db.users[token];
    await this.save();
  }

  settings() {
    return this.db.settings;
  }

  async updateSettings(input) {
    this.db.settings = {
      ...this.db.settings,
      publicBaseUrl: input.publicBaseUrl ?? this.db.settings.publicBaseUrl,
    };
    await this.save();
    return this.db.settings;
  }
}

export function isUserActive(user) {
  if (!user || !user.enabled) return false;
  if (!user.expireAt) return true;
  return new Date(user.expireAt).getTime() > Date.now();
}

function mergeDb(value = {}) {
  const nodes = {};
  let changed = false;

  for (const [key, node] of Object.entries(value.nodes || {})) {
    const id = node.id || key;
    const normalized = {
      ...node,
      id,
      agentToken: node.agentToken || newAgentToken(),
    };
    if (!node.agentToken || node.id !== id) changed = true;
    nodes[id] = normalized;
  }

  return {
    db: {
      ...structuredClone(emptyDb),
      ...value,
      nodes,
      certs: value.certs || {},
      users: value.users || {},
      settings: {
        ...emptyDb.settings,
        ...(value.settings || {}),
      },
    },
    changed,
  };
}

function withNodeAgentStatus(node) {
  const agent = node.agent || {};
  const reportedAtMs = agent.reportedAt ? new Date(agent.reportedAt).getTime() : 0;
  const ageMs = reportedAtMs ? Date.now() - reportedAtMs : null;
  const stale = !reportedAtMs || ageMs > agentStaleMs;
  let state = 'waiting';

  if (node.enabled === false) {
    state = 'disabled';
  } else if (!reportedAtMs) {
    state = 'waiting';
  } else if (stale) {
    state = 'stale';
  } else if (agent.status === 'up') {
    state = 'up';
  } else {
    state = 'down';
  }

  return {
    ...node,
    agent: {
      ...agent,
      state,
      stale,
      ageSeconds: ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000)),
    },
  };
}

function newAgentToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function counterDelta(previous, current) {
  if (!Number.isFinite(previous)) return current;
  if (current >= previous) return current - previous;
  return current;
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function trimString(value, maxLength) {
  return String(value || '').slice(0, maxLength);
}

function byId(a, b) {
  return a.id.localeCompare(b.id);
}

function byName(a, b) {
  return (a.name || '').localeCompare(b.name || '');
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === 'on' || value === '1';
}

function withCertDays(cert) {
  if (!cert.notAfter) return { ...cert, daysRemaining: null };
  const daysRemaining = Math.ceil((new Date(cert.notAfter).getTime() - Date.now()) / 86400000);
  return { ...cert, daysRemaining };
}

function parseCertificate(pem) {
  if (!pem) return {};
  try {
    const cert = new crypto.X509Certificate(pem);
    return {
      issuer: cert.issuer,
      notBefore: new Date(cert.validFrom).toISOString(),
      notAfter: new Date(cert.validTo).toISOString(),
    };
  } catch {
    return {};
  }
}
