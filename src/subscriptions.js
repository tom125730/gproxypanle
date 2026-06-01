export function nodeConfigYaml(node, publicBaseUrl = '') {
  if (node.yaml && node.yaml.trim()) return node.yaml.trimEnd() + '\n';
  const certUrl = node.certId ? absoluteUrl(publicBaseUrl, `/c/${node.certId}/cert`) : '';
  const keyUrl = node.certId ? absoluteUrl(publicBaseUrl, `/c/${node.certId}/key`) : '';
  const secrets = splitList(node.password);
  const wspaths = splitList(node.wspaths);

  return [
    'log:',
    '  level: INFO',
    '  path:',
    'pool:',
    '  gcInterval: 5m',
    '  maxAge: 24h',
    '  minSize: 16',
    '  maxSize: 32',
    '  idleTimeout: 1h',
    'inbound:',
    `  listen: ${yamlString(node.listen || `0.0.0.0:${Number(node.port || 443)}`)}`,
    `  socks5: ${node.socks5 === true}`,
    `  relay: ${node.relay === true}`,
    '  secrets:',
    ...(secrets.length ? secrets.map((secret) => `    - ${yamlString(secret)}`) : ['    - ""']),
    '  tproxyListen:',
    '  wspaths:',
    ...(wspaths.length ? wspaths.map((item) => `    - ${yamlString(item)}`) : ['    - "/gproxy"']),
    `  cert: ${certUrl ? yamlString(certUrl) : ''}`,
    `  key: ${keyUrl ? yamlString(keyUrl) : ''}`,
    'outbounds:',
    '  - name: direct',
    '    endpoint: direct://',
    'router:',
    '  geosite:',
    '  geoip:',
    '  routes:',
    '    - MATCH,direct',
    '',
  ].join('\n');
}

export function clashSubscription(nodes) {
  const proxies = nodes.filter((node) => node.enabled).flatMap(clashProxies);
  const proxyNames = proxies.map((node) => node.name);

  return [
    'mixed-port: 7890',
    'allow-lan: true',
    'mode: rule',
    'log-level: info',
    'proxies:',
    ...proxies.flatMap((proxy) => indentYamlObject(proxy)),
    'proxy-groups:',
    '  - name: Proxy',
    '    type: select',
    '    proxies:',
    ...proxyNames.map((name) => `      - ${yamlString(name)}`),
    'rules:',
    '  - MATCH,Proxy',
    '',
  ].join('\n');
}

export function v2raynSubscription(nodes) {
  const uris = nodes
    .filter((node) => node.enabled)
    .flatMap((node) => [trojanUri(node), hysteria2Uri(node)]);

  return Buffer.from(uris.join('\n')).toString('base64');
}

function clashProxies(node) {
  return [
    clashProxy(node, 'trojan'),
    clashProxy(node, 'hysteria2'),
    clashProxy(node, 'anytls'),
  ];
}

function clashProxy(node, protocol) {
  const base = {
    name: `${node.name || node.id} ${protocolName(protocol)}`,
    type: protocol,
    server: node.host,
    port: Number(node.port || 443),
    sni: node.sni || node.host,
  };

  if (protocol === 'hysteria2') {
    return {
      ...base,
      password: node.password,
      skipCertVerify: false,
    };
  }

  if (protocol === 'anytls') {
    return {
      ...base,
      password: node.password,
      clientFingerprint: 'chrome',
    };
  }

  return {
    ...base,
    password: node.password,
    udp: true,
  };
}

function trojanUri(node) {
  const params = new URLSearchParams();
  params.set('security', 'tls');
  if (node.sni) params.set('sni', node.sni);
  return `trojan://${encodeURIComponent(node.password || '')}@${node.host}:${Number(node.port || 443)}?${params.toString()}#${encodeURIComponent(`${node.name || node.id} Trojan`)}`;
}

function hysteria2Uri(node) {
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  return `hysteria2://${encodeURIComponent(node.password || '')}@${node.host}:${Number(node.port || 443)}?${params.toString()}#${encodeURIComponent(`${node.name || node.id} Hysteria2`)}`;
}

function indentYamlObject(value) {
  const lines = ['  -'];
  for (const [key, raw] of Object.entries(value)) {
    lines.push(`    ${kebab(key)}: ${yamlValue(raw)}`);
  }
  return lines;
}

function yamlValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return yamlScalar(value || '');
}

function yamlString(value) {
  return yamlScalar(value);
}

function yamlScalar(value) {
  const text = String(value);
  if (!text) return '';
  if (/^[\w./:@-]+$/.test(text)) return text;
  return JSON.stringify(String(value));
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function protocolName(protocol) {
  if (protocol === 'hysteria2') return 'Hysteria2';
  if (protocol === 'anytls') return 'AnyTLS';
  return 'Trojan';
}

function splitList(value) {
  return String(value || '').split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function absoluteUrl(base, pathname) {
  if (!base) return pathname;
  return `${base.replace(/\/+$/, '')}${pathname}`;
}
