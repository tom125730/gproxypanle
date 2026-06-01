export function layout(title, active, body) {
  const nav = [
    ['/', 'Dashboard'],
    ['/nodes', 'Nodes'],
    ['/certificates', 'Certificates'],
    ['/subscriptions', 'Subscriptions'],
    ['/users', 'Users'],
    ['/settings', 'Settings'],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - gproxy</title>
  <link rel="stylesheet" href="/static/app.css">
  <script src="/static/app.js" defer></script>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">gproxy</div>
    <nav>
      ${nav.map(([href, label]) => `<a class="${active === label ? 'active' : ''}" href="${href}">${label}</a>`).join('')}
    </nav>
    <form method="post" action="/logout" class="logout-form">
      <button type="submit">Logout</button>
    </form>
  </aside>
  <main class="main">
    ${body}
  </main>
</body>
</html>`;
}

export function loginPage(error = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login - gproxy</title>
  <link rel="stylesheet" href="/static/app.css">
</head>
<body class="login-body">
  <main class="login-shell">
    <form class="login-box" method="post" action="/login">
      <div class="brand login-brand">gproxy</div>
      <h1>Sign in</h1>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      ${input('username', 'Username', 'admin', true)}
      <label>Password
        <input name="password" type="password" required>
      </label>
      <button type="submit">Login</button>
    </form>
  </main>
</body>
</html>`;
}

export function dashboardPage(metrics) {
  return layout('Dashboard', 'Dashboard', `
    <header class="topbar">
      <div>
        <p class="eyebrow">Control Plane</p>
        <h1>Dashboard</h1>
      </div>
    </header>
    <section class="metrics">
      ${metric('Total Nodes', metrics.totalNodes, '/nodes')}
      ${metric('Online Nodes', `${metrics.onlineNodes}/${metrics.totalNodes}`, '/nodes')}
      ${metric('Reporting Nodes', metrics.reportingNodes, '/nodes')}
      ${metric('Total Certificates', metrics.totalCertificates, '/certificates')}
      ${metric('Expiring Certificates', metrics.expiringCertificates, '/certificates')}
      ${metric('Total Users', metrics.totalUsers, '/users')}
      ${metric('Active Tokens', metrics.activeSubscriptionTokens, '/subscriptions')}
    </section>
    <section class="dashboard-grid">
      <div class="panel">
        <div class="panel-head">
          <h2>Node Status</h2>
          <span class="muted">${escapeHtml(metrics.reportingNodes)} reporting</span>
        </div>
        ${statusChart(metrics)}
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Traffic</h2>
          <span class="muted">${escapeHtml(metrics.totalConnections)} conns</span>
        </div>
        <div class="traffic-summary">
          <div><span>RX</span><strong>${escapeHtml(formatBytes(metrics.totalRxBytes))}</strong></div>
          <div><span>TX</span><strong>${escapeHtml(formatBytes(metrics.totalTxBytes))}</strong></div>
          <div><span>Total</span><strong>${escapeHtml(formatBytes(metrics.totalTrafficBytes))}</strong></div>
          <div><span>Local</span><strong>${escapeHtml(formatLatency(metrics.averageLatencyMs))}</strong></div>
          <div><span>CM</span><strong>${escapeHtml(formatLatency(metrics.probeLatency?.cm?.averageLatencyMs))}</strong></div>
          <div><span>CU</span><strong>${escapeHtml(formatLatency(metrics.probeLatency?.cu?.averageLatencyMs))}</strong></div>
          <div><span>CT</span><strong>${escapeHtml(formatLatency(metrics.probeLatency?.ct?.averageLatencyMs))}</strong></div>
        </div>
        ${trafficChart(metrics.nodeTraffic)}
      </div>
    </section>
  `);
}

export function nodesPage(nodes, certs, editingNode = null) {
  const node = editingNode || {};
  const isEditing = Boolean(editingNode);
  const action = isEditing ? `/api/node/${encodeURIComponent(node.id)}` : '/api/node';

  return layout('Nodes', 'Nodes', `
    <header class="topbar"><h1>${isEditing ? `Edit ${escapeHtml(node.id)}` : 'Nodes'}</h1></header>
    <section class="panel">
      <form method="post" action="${action}" class="grid-form node-form" data-node-form>
        ${input('id', 'Node Key', 'hk01', true, node.id || '', isEditing ? 'readonly' : '')}
        ${input('name', 'Name', 'Hong Kong 01', false, node.name || '')}
        ${input('host', 'Host', 'hk.example.com', false, node.host || '')}
        ${input('port', 'Port', '443', false, node.port || '443')}
        ${input('listen', 'Listen', '0.0.0.0:443', false, node.listen || '')}
        ${input('sni', 'SNI', 'hk.example.com', false, node.sni || '')}
        ${input('password', 'Secrets', '3c999130', false, node.password || '3c999130')}
        ${input('wspaths', 'WS Paths', '/gproxy', false, node.wspaths || '/gproxy')}
        <label>Certificate
          <select name="certId">
            <option value="">None</option>
            ${certs.map((cert) => `<option value="${escapeAttr(cert.id)}" ${node.certId === cert.id ? 'selected' : ''}>${escapeHtml(certOptionLabel(cert))}</option>`).join('')}
          </select>
        </label>
        <label class="wide">gproxy YAML Config
          <textarea name="yaml" rows="18" data-yaml-output>${escapeHtml(node.yaml || '')}</textarea>
        </label>
        <p class="form-note wide">This YAML refreshes from the fields above. You can still edit it manually before saving.</p>
        ${checkbox('socks5', 'SOCKS5', node.socks5 === true)}
        ${checkbox('relay', 'Relay', node.relay === true)}
        ${checkbox('enabled', 'Enabled', node.enabled !== false)}
        <div class="form-actions">
          <button type="submit">${isEditing ? 'Update Node' : 'Save Node'}</button>
          ${isEditing ? '<a class="button-link" href="/nodes">Cancel</a>' : ''}
        </div>
      </form>
    </section>
    <section class="table-wrap">
      ${table(['Key', 'Name', 'Host', 'Status', 'Traffic', 'Config', 'Docker', 'Agent', ''], nodes.map((node) => [
        node.id,
        node.name,
        `${escapeHtml(node.host)}:${escapeHtml(node.port)}<br><span class="muted">${escapeHtml(node.sni || '')}</span>`,
        `${nodeStatus(node)}${nodeProbeStatus(node)}`,
        nodeTraffic(node),
        `<a href="/n/${encodeURIComponent(node.id)}">/n/${escapeHtml(node.id)}</a>`,
        `<code class="docker-command" data-docker-command data-config-path="/n/${encodeURIComponent(node.id)}"></code>`,
        `<code class="agent-command" data-agent-command data-node-id="${escapeAttr(node.id)}" data-agent-token="${escapeAttr(node.agentToken)}" data-listen="${escapeAttr(node.listen || `0.0.0.0:${node.port}`)}" data-target-host="${escapeAttr(node.host)}" data-target-port="${escapeAttr(node.port)}"></code>`,
        `<div class="row-actions"><a class="button-link small" href="/nodes/${encodeURIComponent(node.id)}/edit">Edit</a>${deleteForm(`/api/node/${encodeURIComponent(node.id)}`)}</div>`,
      ]))}
    </section>
  `);
}

export function certificatesPage(certs, editingCert = null, adminAuth = 'admin:ADMIN_PASS') {
  const cert = editingCert || {};
  const isEditing = Boolean(editingCert);
  const action = isEditing ? `/api/cert/${encodeURIComponent(cert.id)}` : '/api/cert';

  return layout('Certificates', 'Certificates', `
    <header class="topbar"><h1>${isEditing ? `Edit ${escapeHtml(cert.id)}` : 'Certificates'}</h1></header>
    <section class="panel">
      <form method="post" action="${action}" class="grid-form">
        ${input('id', 'Cert ID', 'hk01', true, cert.id || '', isEditing ? 'readonly' : '')}
        ${input('domain', 'Domain', 'hk.example.com', false, cert.domain || '')}
        ${input('issuer', 'Issuer', "Let's Encrypt", false, cert.issuer || '')}
        ${input('notBefore', 'Not Before', '2026-06-01T00:00:00Z', false, cert.notBefore || '')}
        ${input('notAfter', 'Not After', '2026-09-01T00:00:00Z', false, cert.notAfter || '')}
        <label class="wide">Certificate PEM<textarea name="cert" rows="8">${escapeHtml(cert.cert || '')}</textarea></label>
        <label class="wide">Private Key PEM<textarea name="key" rows="8">${escapeHtml(cert.key || '')}</textarea></label>
        <div class="form-actions">
          <button type="submit">${isEditing ? 'Update Certificate' : 'Save Certificate'}</button>
          ${isEditing ? '<a class="button-link" href="/certificates">Cancel</a>' : ''}
        </div>
      </form>
    </section>
    <section class="table-wrap">
      ${table(['ID', 'Domain', 'Issuer', 'Expires', 'Days', 'Download', 'Renew Command', ''], certs.map((cert) => [
        cert.id,
        cert.domain,
        cert.issuer,
        cert.notAfter,
        cert.daysRemaining ?? '',
        `<a href="/c/${encodeURIComponent(cert.id)}/cert">cert</a> <a href="/c/${encodeURIComponent(cert.id)}/key">key</a>`,
        `<code class="renew-command" data-renew-command data-cert-id="${escapeAttr(cert.id)}" data-domain="${escapeAttr(cert.domain || cert.id)}" data-auth="${escapeAttr(adminAuth)}"></code>`,
        `<div class="row-actions"><a class="button-link small" href="/certificates/${encodeURIComponent(cert.id)}/edit">Edit</a>${deleteForm(`/api/cert/${encodeURIComponent(cert.id)}`)}</div>`,
      ]))}
    </section>
  `);
}

export function usersPage(users) {
  return layout('Users', 'Users', `
    <header class="topbar"><h1>Users</h1></header>
    <section class="panel">
      <form method="post" action="/api/user" class="grid-form">
        ${input('name', 'Name', 'default', true)}
        ${input('token', 'Token', 'leave empty to generate')}
        ${input('expireAt', 'Expire At', '2027-01-01T00:00:00Z')}
        ${input('trafficLimit', 'Traffic Limit Bytes', '0')}
        <p class="form-note wide">Traffic Limit is stored for planning only. Enforcement is not active because traffic is currently reported by node, not by subscription user.</p>
        <label class="check"><input type="checkbox" name="enabled" checked> Enabled</label>
        <button type="submit">Save User</button>
      </form>
    </section>
    <section class="table-wrap">
      ${table(['Name', 'Token', 'Enabled', 'Expire At', 'Traffic Limit', 'Clash', 'v2rayN', ''], users.map((user) => [
        user.name,
        `<code>${escapeHtml(user.token)}</code>`,
        user.enabled ? 'yes' : 'no',
        user.expireAt || 'never',
        `${escapeHtml(formatBytes(user.trafficLimit || 0))}<br><span class="muted">not enforced</span>`,
        `<a href="/sub/clash/${encodeURIComponent(user.token)}">Clash</a>`,
        `<a href="/sub/v2rayn/${encodeURIComponent(user.token)}">v2rayN</a>`,
        deleteForm(`/api/user/${encodeURIComponent(user.token)}`),
      ]))}
    </section>
  `);
}

export function subscriptionsPage(users) {
  return layout('Subscriptions', 'Subscriptions', `
    <header class="topbar"><h1>Subscriptions</h1></header>
    <section class="table-wrap">
      ${table(['User', 'Token', 'Clash Meta', 'v2rayN'], users.map((user) => [
        user.name,
        `<code>${escapeHtml(user.token)}</code>`,
        `<a href="/sub/clash/${encodeURIComponent(user.token)}">/sub/clash/${escapeHtml(user.token)}</a>`,
        `<a href="/sub/v2rayn/${encodeURIComponent(user.token)}">/sub/v2rayn/${escapeHtml(user.token)}</a>`,
      ]))}
    </section>
  `);
}

export function settingsPage(settings) {
  return layout('Settings', 'Settings', `
    <header class="topbar"><h1>Settings</h1></header>
    <section class="panel">
      <form method="post" action="/api/settings" class="grid-form">
        ${input('publicBaseUrl', 'Public Base URL', 'https://sub.example.com', false, settings.publicBaseUrl || '')}
        <button type="submit">Save Settings</button>
      </form>
    </section>
  `);
}

function metric(label, value, href) {
  return `<a class="metric" href="${escapeAttr(href)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></a>`;
}

function input(name, label, placeholder, required = false, value = '', extra = '') {
  return `<label>${escapeHtml(label)}
    <input name="${escapeAttr(name)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" ${required ? 'required' : ''} ${extra}>
  </label>`;
}

function checkbox(name, label, checked) {
  return `<label class="check">
    <input type="hidden" name="${escapeAttr(name)}" value="false">
    <input type="checkbox" name="${escapeAttr(name)}" value="true" ${checked ? 'checked' : ''}> ${escapeHtml(label)}
  </label>`;
}

function certOptionLabel(cert) {
  if (!cert.domain) return cert.id;
  if (cert.domain === cert.id) return cert.domain;
  return `${cert.domain} (${cert.id})`;
}

function statusChart(metrics) {
  const entries = [
    ['up', 'UP'],
    ['down', 'DOWN'],
    ['stale', 'STALE'],
    ['waiting', 'WAITING'],
    ['disabled', 'DISABLED'],
  ];
  const total = Math.max(1, Number(metrics.totalNodes || 0));
  const counts = metrics.statusCounts || {};
  const segments = entries.map(([key, label]) => {
    const count = Number(counts[key] || 0);
    if (!count) return '';
    const width = Math.max(4, (count / total) * 100);
    return `<span class="status-segment status-segment-${escapeAttr(key)}" style="width:${escapeAttr(width)}%" title="${escapeAttr(`${label}: ${count}`)}"></span>`;
  }).join('');
  const legend = entries.map(([key, label]) => {
    const count = Number(counts[key] || 0);
    return `<div class="status-legend-item"><span class="legend-dot legend-dot-${escapeAttr(key)}"></span><span>${escapeHtml(label)}</span><strong>${escapeHtml(count)}</strong></div>`;
  }).join('');

  return `
    <div class="status-chart">${segments || '<span class="status-segment status-segment-waiting" style="width:100%"></span>'}</div>
    <div class="status-legend">${legend}</div>
  `;
}

function trafficChart(nodes) {
  if (!nodes || !nodes.length) {
    return '<div class="empty mini-empty">No node traffic yet</div>';
  }

  const max = Math.max(1, ...nodes.map((node) => Number(node.totalBytes || 0)));
  return `<div class="traffic-bars">
    ${nodes.map((node) => {
      const width = Math.max(2, (Number(node.totalBytes || 0) / max) * 100);
      return `<div class="traffic-row">
        <div class="traffic-row-head">
          <span>${escapeHtml(node.name)}</span>
          <strong>${escapeHtml(formatBytes(node.totalBytes))}</strong>
        </div>
        <div class="bar-track"><span class="bar-fill status-fill-${escapeAttr(node.state || 'waiting')}" style="width:${escapeAttr(width)}%"></span></div>
        <div class="traffic-row-sub">RX ${escapeHtml(formatBytes(node.rxBytes))} / TX ${escapeHtml(formatBytes(node.txBytes))}${node.latencyMs === null ? '' : ` / ${escapeHtml(node.latencyMs)}ms`}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function nodeStatus(node) {
  const agent = node.agent || {};
  const label = {
    up: 'UP',
    down: 'DOWN',
    stale: 'STALE',
    waiting: 'WAITING',
    disabled: 'DISABLED',
  }[agent.state] || 'WAITING';
  const latency = agent.latencyMs === null || agent.latencyMs === undefined ? '' : ` ${agent.latencyMs}ms`;
  const reported = agent.reportedAt ? `${relativeTime(agent.ageSeconds)} ago` : 'never';
  const error = agent.error ? `<br><span class="muted">${escapeHtml(agent.error)}</span>` : '';

  return `<span class="status status-${escapeAttr(agent.state || 'waiting')}">${label}</span><br><span class="muted">${escapeHtml(reported)}${escapeHtml(latency)}</span>${error}`;
}

function nodeProbeStatus(node) {
  const probes = node.agent?.probes || {};
  const items = [
    ['cm', 'CM'],
    ['cu', 'CU'],
    ['ct', 'CT'],
  ].map(([key, label]) => {
    const probe = probes[key];
    if (!probe) {
      return `<span class="probe probe-waiting">${escapeHtml(label)} no data</span>`;
    }

    const state = probe.status || 'waiting';
    const value = probe.latencyMs === null || probe.latencyMs === undefined ? state : `${probe.latencyMs}ms`;
    const title = probe.error ? ` title="${escapeAttr(probe.error)}"` : '';
    return `<span class="probe probe-${escapeAttr(state)}"${title}>${escapeHtml(label)} ${escapeHtml(value)}</span>`;
  }).join('');

  return `<div class="probe-list">${items}</div>`;
}

function nodeTraffic(node) {
  const agent = node.agent || {};
  const rx = formatBytes(agent.rxBytes || 0);
  const tx = formatBytes(agent.txBytes || 0);
  const connections = Number(agent.connections || 0);
  return `<span>RX ${escapeHtml(rx)}</span><br><span>TX ${escapeHtml(tx)}</span><br><span class="muted">${connections} conns</span>`;
}

function relativeTime(seconds) {
  if (seconds === null || seconds === undefined) return 'never';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let number = Number(value || 0);
  let index = 0;
  while (number >= 1024 && index < units.length - 1) {
    number /= 1024;
    index += 1;
  }
  return `${number >= 10 || index === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[index]}`;
}

function formatLatency(value) {
  return value === null || value === undefined ? 'n/a' : `${value}ms`;
}

function table(headers, rows) {
  return `<table>
    <thead><tr>${headers.map((head) => `<th>${escapeHtml(head)}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="empty">No data</td></tr>`}</tbody>
  </table>`;
}

function deleteForm(action) {
  return `<form method="post" action="${escapeAttr(action)}"><input type="hidden" name="_method" value="DELETE"><button class="danger" type="submit">Delete</button></form>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
