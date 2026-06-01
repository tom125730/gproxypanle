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
      this.db = mergeDb(JSON.parse(raw));
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
    const certs = Object.values(this.db.certs);
    const users = Object.values(this.db.users);

    return {
      totalNodes: Object.keys(this.db.nodes).length,
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
    return Object.values(this.db.nodes).sort(byId);
  }

  getNode(id) {
    return this.db.nodes[id] || null;
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

function mergeDb(value) {
  return {
    ...structuredClone(emptyDb),
    ...value,
    nodes: value.nodes || {},
    certs: value.certs || {},
    users: value.users || {},
    settings: {
      ...emptyDb.settings,
      ...(value.settings || {}),
    },
  };
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
