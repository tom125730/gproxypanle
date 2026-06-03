import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const emptyDb = {
  nodes: {},
  certs: {},
  users: {},
  cloudTrafficReports: [],
  settings: {
    publicBaseUrl: '',
  },
  security: {
    adminPasswordHash: '',
    twoFactorEnabled: false,
    twoFactorSecret: '',
    pendingTwoFactorSecret: '',
    sessionVersion: 1,
  },
};

const defaultNodeSecret = '3c999130';
const agentStaleMs = 180000;
const cloudStaleMs = 25 * 60 * 1000;
const latencyHistoryMs = 24 * 60 * 60 * 1000;
const maxLatencySamples = 1440;
const maxCloudTrafficReports = 50;
const maxCloudTrafficEntries = 200;
const maxCloudSeenKeys = 5000;
const cloudBucketHistoryMs = 24 * 60 * 60 * 1000;

export class JsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.db = structuredClone(emptyDb);
    this.loaded = false;
    this.writeQueue = Promise.resolve();
    this.pendingSave = null;
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
    if (this.pendingSave) {
      const pending = this.pendingSave;
      clearTimeout(pending.timer);
      this.pendingSave = null;
      const write = this.writeNow();
      write.then(pending.resolve, pending.reject);
      return write;
    }
    return this.writeNow();
  }

  saveSoon(delayMs = 750) {
    if (this.pendingSave) return this.pendingSave.promise;

    const pending = {};
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    pending.timer = setTimeout(() => {
      this.pendingSave = null;
      this.writeNow().then(pending.resolve, pending.reject);
    }, delayMs);
    this.pendingSave = pending;
    return pending.promise;
  }

  async writeNow() {
    this.writeQueue = this.writeQueue.then(() => {
      const payload = JSON.stringify(this.db);
      return fs.writeFile(this.filePath, payload);
    });
    await this.writeQueue;
  }

  metrics() {
    const now = Date.now();
    const nodes = Object.values(this.db.nodes).map(withNodeStatus);
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
    const nodeLatency = [];

    const nodeTraffic = nodes.map((node) => {
      const status = node.status || {};
      const traffic = node.traffic || {};
      const rxBytes = toNonNegativeNumber(traffic.rxBytes);
      const txBytes = toNonNegativeNumber(traffic.txBytes);
      const rxBps = toNonNegativeNumber(traffic.rxBps);
      const txBps = toNonNegativeNumber(traffic.txBps);
      const totalBytes = rxBytes + txBytes;

      statusCounts[status.state] = (statusCounts[status.state] || 0) + 1;
      totalRxBytes += rxBytes;
      totalTxBytes += txBytes;
      totalConnections += toNonNegativeNumber(traffic.connections);
      nodeLatency.push(nodeLatencySummary(node));

      return {
        id: node.id,
        name: node.name || node.id,
        state: status.state,
        rxBytes,
        txBytes,
        rxBps,
        txBps,
        totalBytes,
        latencyMs: node.agent?.latencyMs ?? null,
        probes: node.agent?.probes || {},
      };
    }).sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 8);
    const cloudTrafficTrend = trafficTrend(nodes);

    return {
      totalNodes: nodes.length,
      onlineNodes: statusCounts.up,
      reportingNodes: nodes.filter((node) => node.status.reportedAt).length,
      statusCounts,
      totalRxBytes,
      totalTxBytes,
      totalTrafficBytes: totalRxBytes + totalTxBytes,
      totalConnections,
      nodeLatency: nodeLatency.sort((a, b) => a.name.localeCompare(b.name)),
      nodeTraffic,
      cloudTrafficTrend,
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
    return Object.values(this.db.nodes).map(withNodeStatus).sort(byId);
  }

  getNode(id) {
    const node = this.db.nodes[id];
    return node ? withNodeStatus(node) : null;
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
      configToken: input.configToken || previous.configToken || newAccessToken(),
      agentToken: input.agentToken || previous.agentToken || newAgentToken(),
      cloudToken: input.cloudToken || previous.cloudToken || newAccessToken(),
      agent: previous.agent || null,
      cloud: previous.cloud || null,
      agentCommand: previous.agentCommand || null,
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

    node.agent = {
      status: input.status === 'up' ? 'up' : 'down',
      latencyMs: toNullableNumber(input.latencyMs),
      error: trimString(input.error, 240),
      uptimeSeconds: toNonNegativeNumber(input.uptimeSeconds),
      probes: normalizeProbes(input.probes),
      version: trimString(input.version, 40),
      remoteAddress: trimString(remoteAddress, 80),
      reportedAt: now,
    };
    node.latencyHistory = appendLatencySample(node.latencyHistory, node.agent, now);

    this.saveSoon().catch((error) => {
      console.error('failed to save node agent report', error);
    });
    return withNodeStatus(node);
  }

  listCloudTrafficReports() {
    return Array.isArray(this.db.cloudTrafficReports) ? this.db.cloudTrafficReports : [];
  }

  async recordCloudTrafficReport(input) {
    const entries = normalizeCloudTrafficEntries(input.entries);
    const report = {
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      method: trimString(input.method || 'POST', 12),
      path: trimString(input.path || '/api/v1/traffic', 160),
      nodeKey: trimString(input.nodeKey, 160),
      remoteAddress: trimString(input.remoteAddress, 120),
      headers: normalizeHeaders(input.headers),
      entries,
      totalRxBytes: entries.reduce((sum, entry) => sum + entry.rxBytes, 0),
      totalTxBytes: entries.reduce((sum, entry) => sum + entry.txBytes, 0),
      totalRequestCount: entries.reduce((sum, entry) => sum + entry.requestCount, 0),
      acceptedEntryCount: 0,
      duplicateEntryCount: 0,
      nodeId: '',
    };

    const node = findNodeByCloudKey(this.db.nodes, report.nodeKey);
    if (!node) return report;

    const result = applyCloudTrafficToNode(node, report);
    report.nodeId = node.id;
    report.acceptedEntryCount = result.acceptedEntryCount;
    report.duplicateEntryCount = result.duplicateEntryCount;

    const previous = Array.isArray(this.db.cloudTrafficReports) ? this.db.cloudTrafficReports : [];
    this.db.cloudTrafficReports = [report, ...previous].slice(0, maxCloudTrafficReports);
    this.saveSoon().catch((error) => {
      console.error('failed to save cloud traffic report', error);
    });
    return report;
  }

  async clearCloudTrafficReports() {
    this.db.cloudTrafficReports = [];
    await this.save();
  }

  async pruneUnknownCloudTrafficReports() {
    const reports = Array.isArray(this.db.cloudTrafficReports) ? this.db.cloudTrafficReports : [];
    this.db.cloudTrafficReports = reports.filter((report) => report.nodeId);
    await this.save();
  }

  async setNodeAgentCommand(id, command) {
    const node = this.db.nodes[id];
    if (!node) return null;
    node.agentCommand = command;
    await this.save();
    return withNodeStatus(node);
  }

  async clearNodeAgentCommand(id) {
    const node = this.db.nodes[id];
    if (!node) return null;
    node.agentCommand = null;
    await this.save();
    return withNodeStatus(node);
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
      uploadToken: input.uploadToken || previous.uploadToken || newAccessToken(),
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

  security() {
    return this.db.security;
  }

  async updateSettings(input) {
    this.db.settings = {
      ...this.db.settings,
      publicBaseUrl: input.publicBaseUrl ?? this.db.settings.publicBaseUrl,
    };
    await this.save();
    return this.db.settings;
  }

  async updateSecurity(input) {
    this.db.security = normalizeSecurity({
      ...this.db.security,
      ...input,
    });
    await this.save();
    return this.db.security;
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
      configToken: node.configToken || newAccessToken(),
      agentToken: node.agentToken || newAgentToken(),
      cloudToken: node.cloudToken || newAccessToken(),
      cloud: normalizeCloudState(node.cloud),
    };
    if (!node.configToken || !node.agentToken || !node.cloudToken || node.id !== id) changed = true;
    nodes[id] = normalized;
  }

  const certs = {};
  for (const [key, cert] of Object.entries(value.certs || {})) {
    const id = cert.id || key;
    const normalized = {
      ...cert,
      id,
      uploadToken: cert.uploadToken || newAccessToken(),
    };
    if (!cert.uploadToken || cert.id !== id) changed = true;
    certs[id] = normalized;
  }

  return {
    db: {
      ...structuredClone(emptyDb),
      ...value,
      nodes,
      certs,
      users: value.users || {},
      cloudTrafficReports: normalizeCloudTrafficReports(value.cloudTrafficReports),
      settings: {
        ...emptyDb.settings,
        ...(value.settings || {}),
      },
      security: normalizeSecurity(value.security),
    },
    changed,
  };
}

function normalizeSecurity(value = {}) {
  return {
    ...emptyDb.security,
    ...value,
    twoFactorEnabled: toBool(value.twoFactorEnabled, emptyDb.security.twoFactorEnabled),
    sessionVersion: Math.max(1, Number(value.sessionVersion || emptyDb.security.sessionVersion)),
  };
}

function normalizeCloudTrafficReports(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxCloudTrafficReports).map((report) => {
    const entries = normalizeCloudTrafficEntries(report.entries);
    return {
      id: trimString(report.id, 80) || crypto.randomUUID(),
      receivedAt: trimString(report.receivedAt, 40),
      method: trimString(report.method, 12),
      path: trimString(report.path, 160),
      nodeKey: trimString(report.nodeKey, 160),
      remoteAddress: trimString(report.remoteAddress, 120),
      headers: normalizeHeaders(report.headers),
      entries,
      totalRxBytes: toNonNegativeNumber(report.totalRxBytes ?? entries.reduce((sum, entry) => sum + entry.rxBytes, 0)),
      totalTxBytes: toNonNegativeNumber(report.totalTxBytes ?? entries.reduce((sum, entry) => sum + entry.txBytes, 0)),
      totalRequestCount: toNonNegativeNumber(report.totalRequestCount ?? entries.reduce((sum, entry) => sum + entry.requestCount, 0)),
      acceptedEntryCount: toNonNegativeNumber(report.acceptedEntryCount),
      duplicateEntryCount: toNonNegativeNumber(report.duplicateEntryCount),
      nodeId: trimString(report.nodeId, 160),
    };
  });
}

function normalizeCloudState(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...value,
    rxBytes: toNonNegativeNumber(value.rxBytes),
    txBytes: toNonNegativeNumber(value.txBytes),
    lastRxBytes: toNonNegativeNumber(value.lastRxBytes),
    lastTxBytes: toNonNegativeNumber(value.lastTxBytes),
    rxBps: toNonNegativeNumber(value.rxBps),
    txBps: toNonNegativeNumber(value.txBps),
    requestCount: toNonNegativeNumber(value.requestCount),
    lastRequestCount: toNonNegativeNumber(value.lastRequestCount),
    buckets: appendCloudBuckets(value.buckets, [], value.reportedAt || new Date().toISOString()),
    seen: normalizeSeenCloudTrafficKeys(value.seen),
  };
}

function findNodeByCloudKey(nodes, nodeKey) {
  const key = String(nodeKey || '');
  if (!key) return null;
  return Object.values(nodes).find((node) => node.cloudToken === key || node.id === key) || null;
}

function applyCloudTrafficToNode(node, report) {
  const now = report.receivedAt;
  const previous = node.cloud || {};
  const seen = normalizeSeenCloudTrafficKeys(previous.seen);
  let acceptedEntryCount = 0;
  let duplicateEntryCount = 0;
  let rxDelta = 0;
  let txDelta = 0;
  let requestDelta = 0;

  for (const entry of report.entries) {
    const key = `${entry.secret}:${entry.timestamp}`;
    if (seen.includes(key)) {
      duplicateEntryCount += 1;
      continue;
    }
    seen.push(key);
    acceptedEntryCount += 1;
    rxDelta += entry.rxBytes;
    txDelta += entry.txBytes;
    requestDelta += entry.requestCount;
  }

  const trimmedSeen = seen.slice(-maxCloudSeenKeys);
  const intervalSeconds = reportIntervalSeconds(previous.reportedAt, now);
  const rxBps = intervalSeconds > 0 ? Math.floor(rxDelta / intervalSeconds) : 0;
  const txBps = intervalSeconds > 0 ? Math.floor(txDelta / intervalSeconds) : 0;

  node.cloud = {
    status: 'up',
    reportedAt: now,
    nodeKey: report.nodeKey,
    remoteAddress: report.remoteAddress,
    rxBytes: toNonNegativeNumber(previous.rxBytes) + rxDelta,
    txBytes: toNonNegativeNumber(previous.txBytes) + txDelta,
    lastRxBytes: rxDelta,
    lastTxBytes: txDelta,
    rxBps,
    txBps,
    requestCount: toNonNegativeNumber(previous.requestCount) + requestDelta,
    lastRequestCount: requestDelta,
    reportIntervalSeconds: intervalSeconds,
    lastEntryCount: acceptedEntryCount,
    duplicateEntryCount: toNonNegativeNumber(previous.duplicateEntryCount) + duplicateEntryCount,
    secrets: uniqueStrings([
      ...(Array.isArray(previous.secrets) ? previous.secrets : []),
      ...report.entries.map((entry) => entry.secret),
    ]).slice(-200),
    buckets: appendCloudBuckets(previous.buckets, report.entries, now),
    seen: trimmedSeen,
  };

  return { acceptedEntryCount, duplicateEntryCount };
}

function normalizeSeenCloudTrafficKeys(value) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((item) => trimString(item, 320)).filter(Boolean)).slice(-maxCloudSeenKeys);
}

function appendCloudBuckets(previousBuckets, entries, receivedAt) {
  const cutoff = Date.now() - cloudBucketHistoryMs;
  const buckets = new Map();

  for (const bucket of Array.isArray(previousBuckets) ? previousBuckets : []) {
    const timestamp = toNonNegativeNumber(bucket.timestamp);
    if (!timestamp || timestamp < cutoff) continue;
    const secret = trimString(bucket.secret, 160);
    buckets.set(`${secret}:${timestamp}`, {
      secret,
      timestamp,
      rxBytes: toNonNegativeNumber(bucket.rxBytes),
      txBytes: toNonNegativeNumber(bucket.txBytes),
      requestCount: toNonNegativeNumber(bucket.requestCount),
      receivedAt: trimString(bucket.receivedAt, 40),
    });
  }

  for (const entry of entries) {
    const timestamp = toNonNegativeNumber(entry.timestamp);
    if (!timestamp) continue;
    const key = `${entry.secret}:${timestamp}`;
    if (buckets.has(key)) continue;
    buckets.set(key, {
      secret: entry.secret,
      timestamp,
      rxBytes: entry.rxBytes,
      txBytes: entry.txBytes,
      requestCount: entry.requestCount,
      receivedAt,
    });
  }

  return [...buckets.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-1440);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '')).filter(Boolean))];
}

function normalizeCloudTrafficEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxCloudTrafficEntries).map((entry) => ({
    secret: trimString(entry?.secret, 160),
    timestamp: toNonNegativeNumber(entry?.timestamp),
    rxBytes: toNonNegativeNumber(entry?.rxBytes),
    txBytes: toNonNegativeNumber(entry?.txBytes),
    requestCount: toNonNegativeNumber(entry?.requestCount),
  }));
}

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object') return {};
  const headers = {};
  for (const [key, headerValue] of Object.entries(value).slice(0, 40)) {
    headers[trimString(key, 80)] = trimString(headerValue, 240);
  }
  return headers;
}

function withNodeStatus(node) {
  const agent = node.agent || {};
  const cloud = node.cloud || {};
  const agentView = sourceStatus(agent, agentStaleMs);
  const cloudView = sourceStatus(cloud, cloudStaleMs);
  const primary = cloudView;
  let state = 'waiting';

  if (node.enabled === false) {
    state = 'disabled';
  } else if (!primary.reportedAt) {
    state = 'waiting';
  } else if (primary.stale) {
    state = 'stale';
  } else if (primary.status === 'up') {
    state = 'up';
  } else {
    state = 'down';
  }

  return {
    ...node,
    status: {
      state,
      source: cloudView.reportedAt ? 'cloud' : '',
      reportedAt: primary.reportedAt,
      stale: primary.stale,
      ageSeconds: primary.ageSeconds,
    },
    traffic: {
      source: cloudView.reportedAt ? 'cloud' : '',
      rxBytes: toNonNegativeNumber(cloud.rxBytes),
      txBytes: toNonNegativeNumber(cloud.txBytes),
      lastRxBytes: toNonNegativeNumber(cloud.lastRxBytes),
      lastTxBytes: toNonNegativeNumber(cloud.lastTxBytes),
      rxBps: toNonNegativeNumber(cloud.rxBps),
      txBps: toNonNegativeNumber(cloud.txBps),
      connections: toNonNegativeNumber(cloud.requestCount),
      requestCount: toNonNegativeNumber(cloud.requestCount),
      lastRequestCount: toNonNegativeNumber(cloud.lastRequestCount),
      reportedAt: primary.reportedAt,
    },
    agent: {
      ...agent,
      state: agentView.state,
      stale: agentView.stale,
      ageSeconds: agentView.ageSeconds,
    },
    cloud: {
      ...cloud,
      state: cloudView.state,
      stale: cloudView.stale,
      ageSeconds: cloudView.ageSeconds,
    },
  };
}

function sourceStatus(source, staleMs) {
  const reportedAtMs = source.reportedAt ? new Date(source.reportedAt).getTime() : 0;
  const ageMs = reportedAtMs ? Date.now() - reportedAtMs : null;
  const stale = !reportedAtMs || ageMs > staleMs;
  let state = 'waiting';

  if (!reportedAtMs) {
    state = 'waiting';
  } else if (stale) {
    state = 'stale';
  } else if (source.status === 'down') {
    state = 'down';
  } else {
    state = 'up';
  }

  return {
    state,
    status: source.status || '',
    reportedAt: source.reportedAt || '',
    stale,
    ageSeconds: ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000)),
  };
}

function newAgentToken() {
  return newAccessToken();
}

function newAccessToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function counterDelta(previous, current) {
  if (!Number.isFinite(previous)) return current;
  if (current >= previous) return current - previous;
  return current;
}

function reportIntervalSeconds(previousReportedAt, currentReportedAt) {
  if (!previousReportedAt) return 0;
  const previousMs = new Date(previousReportedAt).getTime();
  const currentMs = new Date(currentReportedAt).getTime();
  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs) || currentMs <= previousMs) return 0;
  return Math.max(1, Math.round((currentMs - previousMs) / 1000));
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

function appendLatencySample(history, agent, reportedAt) {
  const cutoff = Date.now() - latencyHistoryMs;
  const samples = Array.isArray(history)
    ? history.filter((sample) => new Date(sample.at).getTime() >= cutoff)
    : [];

  samples.push({
    at: reportedAt,
    local: agent.latencyMs ?? null,
    cm: agent.probes?.cm?.latencyMs ?? null,
    cu: agent.probes?.cu?.latencyMs ?? null,
    ct: agent.probes?.ct?.latencyMs ?? null,
  });

  return samples.slice(-maxLatencySamples);
}

function nodeLatencySummary(node) {
  const agent = node.agent || {};
  const status = node.status || {};
  const history = Array.isArray(node.latencyHistory) ? node.latencyHistory : [];

  return {
    id: node.id,
    name: node.name || node.id,
    state: status.state || agent.state,
    reportedAt: status.reportedAt || agent.reportedAt || '',
    local: agent.latencyMs ?? null,
    cm: agent.probes?.cm?.latencyMs ?? null,
    cu: agent.probes?.cu?.latencyMs ?? null,
    ct: agent.probes?.ct?.latencyMs ?? null,
    history: history.map((sample) => ({
      at: sample.at,
      local: sample.local ?? null,
      cm: sample.cm ?? null,
      cu: sample.cu ?? null,
      ct: sample.ct ?? null,
    })),
  };
}

function trafficTrend(nodes) {
  const byTimestamp = new Map();
  const bySecret = new Map();
  const nodeItems = [];

  for (const node of nodes) {
    const buckets = Array.isArray(node.cloud?.buckets) ? node.cloud.buckets : [];
    const nodeByTimestamp = new Map();
    const nodeBySecret = new Map();
    for (const bucket of buckets) {
      const timestamp = toNonNegativeNumber(bucket.timestamp);
      if (!timestamp) continue;
      const point = byTimestamp.get(timestamp) || {
        timestamp,
        rxBytes: 0,
        txBytes: 0,
        requestCount: 0,
      };
      point.rxBytes += toNonNegativeNumber(bucket.rxBytes);
      point.txBytes += toNonNegativeNumber(bucket.txBytes);
      point.requestCount += toNonNegativeNumber(bucket.requestCount);
      byTimestamp.set(timestamp, point);

      const secret = bucket.secret || 'unknown';
      const secretItem = bySecret.get(secret) || {
        secret,
        rxBytes: 0,
        txBytes: 0,
        requestCount: 0,
      };
      secretItem.rxBytes += toNonNegativeNumber(bucket.rxBytes);
      secretItem.txBytes += toNonNegativeNumber(bucket.txBytes);
      secretItem.requestCount += toNonNegativeNumber(bucket.requestCount);
      bySecret.set(secret, secretItem);

      const nodePoint = nodeByTimestamp.get(timestamp) || {
        timestamp,
        rxBytes: 0,
        txBytes: 0,
        requestCount: 0,
      };
      nodePoint.rxBytes += toNonNegativeNumber(bucket.rxBytes);
      nodePoint.txBytes += toNonNegativeNumber(bucket.txBytes);
      nodePoint.requestCount += toNonNegativeNumber(bucket.requestCount);
      nodeByTimestamp.set(timestamp, nodePoint);

      const nodeSecretItem = nodeBySecret.get(secret) || {
        secret,
        rxBytes: 0,
        txBytes: 0,
        requestCount: 0,
      };
      nodeSecretItem.rxBytes += toNonNegativeNumber(bucket.rxBytes);
      nodeSecretItem.txBytes += toNonNegativeNumber(bucket.txBytes);
      nodeSecretItem.requestCount += toNonNegativeNumber(bucket.requestCount);
      nodeBySecret.set(secret, nodeSecretItem);
    }
    nodeItems.push({
      id: node.id,
      name: node.name || node.id,
      points: [...nodeByTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-96),
      secrets: [...nodeBySecret.values()]
        .sort((a, b) => (b.rxBytes + b.txBytes) - (a.rxBytes + a.txBytes))
        .slice(0, 8),
    });
  }

  const points = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-96);
  const secrets = [...bySecret.values()]
    .sort((a, b) => (b.rxBytes + b.txBytes) - (a.rxBytes + a.txBytes))
    .slice(0, 8);

  return { points, secrets, nodes: nodeItems };
}

function normalizeProbes(value) {
  const probes = {};
  if (!value || typeof value !== 'object') return probes;

  for (const key of ['cm', 'cu', 'ct']) {
    const probe = value[key];
    if (!probe || typeof probe !== 'object') continue;
    probes[key] = {
      host: trimString(probe.host, 120),
      port: Number(probe.port || 80),
      status: probe.status === 'up' ? 'up' : 'down',
      latencyMs: toNullableNumber(probe.latencyMs),
      error: trimString(probe.error, 160),
    };
  }

  return probes;
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
