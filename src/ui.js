export function layout(title, active, body, options = {}) {
  const authenticated = options.authenticated !== false;
  const nav = authenticated ? [
    ['/', 'Dashboard'],
    ['/report', 'Report'],
    ['/cloud-test', 'Cloud Test'],
    ['/nodes', 'Nodes'],
    ['/certificates', 'Certificates'],
    ['/subscriptions', 'Subscriptions'],
    ['/users', 'Users'],
    ['/settings', 'Settings'],
  ] : [
    ['/', 'Dashboard'],
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
    ${authenticated ? `<form method="post" action="/logout" class="logout-form">
      <button type="submit">Logout</button>
    </form>` : '<a class="login-link" href="/login">Login</a>'}
  </aside>
  <main class="main">
    ${body}
  </main>
</body>
</html>`;
}

export function loginPage(error = '', security = {}) {
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
      ${security.twoFactorEnabled ? `<label>2FA Code
        <input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" placeholder="123456" required>
      </label>` : ''}
      <button type="submit">Login</button>
    </form>
  </main>
</body>
</html>`;
}

export function dashboardPage(metrics, authenticated = true) {
  return layout('Dashboard', 'Dashboard', `
    <header class="topbar">
      <div>
        <p class="eyebrow">Control Plane</p>
        <h1>Dashboard</h1>
      </div>
      ${authenticated ? '' : '<a class="button-link" href="/login">Login</a>'}
    </header>
    <section class="metrics">
      ${metric('Total Nodes', metrics.totalNodes, '/nodes', authenticated)}
      ${metric('Online Nodes', `${metrics.onlineNodes}/${metrics.totalNodes}`, '/nodes', authenticated)}
      ${metric('Reporting Nodes', metrics.reportingNodes, '/nodes', authenticated)}
      ${metric('Total Certificates', metrics.totalCertificates, '/certificates', authenticated)}
      ${metric('Expiring Certificates', metrics.expiringCertificates, '/certificates', authenticated)}
      ${metric('Total Users', metrics.totalUsers, '/users', authenticated)}
      ${metric('Active Tokens', metrics.activeSubscriptionTokens, '/subscriptions', authenticated)}
    </section>
    <section class="dashboard-grid">
      <div class="panel">
        <div class="panel-head">
          <h2>Node Status</h2>
          <span class="muted">${escapeHtml(metrics.reportingNodes)} reporting via cloud/agent</span>
        </div>
        ${statusChart(metrics)}
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Traffic</h2>
          <span class="muted" data-traffic-connections>${escapeHtml(metrics.totalConnections)} requests</span>
        </div>
        <div data-traffic-live>
          ${trafficPanelBody(metrics)}
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>Latency by Node</h2>
        <span class="muted">last 24h</span>
      </div>
      ${latencyNodeChart(metrics.nodeLatency)}
    </section>
  `, { authenticated });
}

export function trafficPanelBody(metrics) {
  return `
    <div class="traffic-summary">
      <div><span>RX</span><strong>${escapeHtml(formatBytes(metrics.totalRxBytes))}</strong></div>
      <div><span>TX</span><strong>${escapeHtml(formatBytes(metrics.totalTxBytes))}</strong></div>
      <div><span>Total</span><strong>${escapeHtml(formatBytes(metrics.totalTrafficBytes))}</strong></div>
    </div>
    ${trafficTrendChart(metrics.cloudTrafficTrend)}
    <div data-traffic-token-list>${trafficTokenTable(metrics.cloudTrafficTrend)}</div>
  `;
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
        <input type="hidden" name="configToken" value="${escapeAttr(node.configToken || '')}">
        <input type="hidden" name="cloudToken" value="${escapeAttr(node.cloudToken || '')}">
        <label>Cloud NodeKey
          <input value="${escapeAttr(node.cloudToken || 'auto-generated after save')}" readonly>
        </label>
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
    <section class="table-wrap nodes-wrap">
      ${table(['Key', 'Name', 'Host', 'Config', 'Docker', 'Agent', 'Remote Deploy', ''], nodes.map((node) => [
        node.id,
        node.name,
        html(`${escapeHtml(node.host)}:${escapeHtml(node.port)}<br><span class="muted">${escapeHtml(node.sni || '')}</span>`),
        html(`<a href="/n/${encodeURIComponent(node.id)}/${encodeURIComponent(node.configToken || '')}">config</a>`),
        html(`<button class="copy-command" type="button" data-docker-command data-config-path="/n/${encodeURIComponent(node.id)}/${encodeURIComponent(node.configToken || '')}">Docker command</button>`),
        html(`${cloudVersion(node)}<button class="copy-command optional-agent" type="button" data-agent-command data-node-id="${escapeAttr(node.id)}" data-agent-token="${escapeAttr(node.agentToken)}" data-listen="${escapeAttr(node.listen || `0.0.0.0:${node.port}`)}" data-target-host="${escapeAttr(node.host)}" data-target-port="${escapeAttr(node.port)}">Install agent</button>${agentVersion(node)}`),
        html(`${deployForm(node)}${deployStatus(node.agentCommand)}`),
        html(`<div class="row-actions"><a class="button-link small" href="/nodes/${encodeURIComponent(node.id)}/edit">Edit</a>${deleteForm(`/api/node/${encodeURIComponent(node.id)}`)}</div>`),
      ]))}
    </section>
  `);
}

export function reportPage(nodes) {
  return layout('Report', 'Report', `
    <header class="topbar">
      <div>
        <p class="eyebrow">Node Monitor</p>
        <h1>Report</h1>
      </div>
    </header>
    <section class="table-wrap report-wrap">
      ${table(['Key', 'Name', 'Host', 'Status', 'Traffic'], nodes.map((node) => [
        html(`<span class="report-key">${escapeHtml(node.id)}</span>`),
        html(`<strong class="report-name">${escapeHtml(node.name)}</strong>`),
        html(`${escapeHtml(node.host)}:${escapeHtml(node.port)}<br><span class="muted">${escapeHtml(node.sni || '')}</span>`),
        html(`<div class="report-status">${nodeStatus(node)}${nodeProbeStatus(node)}</div>`),
        html(`<div class="report-traffic">${nodeTraffic(node)}</div>`),
      ]))}
    </section>
  `);
}

export function cloudTestPage(model) {
  const reports = model.reports || [];
  const latest = reports[0] || null;
  const sampleUrl = model.publicBaseUrl || 'https://your-panel.example';

  return layout('Cloud Test', 'Cloud Test', `
    <header class="topbar">
      <div>
        <p class="eyebrow">gproxy Cloud</p>
        <h1>Cloud Test</h1>
      </div>
      <form method="post" action="/api/cloud-test/reports">
        <input type="hidden" name="_method" value="DELETE">
        <button class="danger" type="submit">Clear Reports</button>
      </form>
    </header>
    <section class="panel">
      <div class="panel-head">
        <h2>Receiver</h2>
        <span class="muted">${escapeHtml(reports.length)} reports</span>
      </div>
      <div class="cloud-config">
        <div>
          <span class="muted">Endpoint</span>
          <code>POST ${escapeHtml(sampleUrl)}/api/v1/traffic</code>
        </div>
        <div>
          <span class="muted">YAML</span>
          <pre>cloud:
  nodeKey: &lt;node cloud token&gt;
  url: ${escapeHtml(sampleUrl)}</pre>
        </div>
      </div>
    </section>
    ${latest ? cloudSummary(latest) : ''}
    <section class="table-wrap cloud-test-wrap">
      ${table(['Received', 'Node', 'Node Key', 'Entries', 'RX', 'TX', 'Requests', 'Remote'], reports.map((report) => [
        html(`${escapeHtml(report.receivedAt || '')}<br><span class="muted">${escapeHtml(report.path || '')}</span>`),
        report.nodeId || '',
        html(`<code>${escapeHtml(report.nodeKey || 'missing')}</code>`),
        html(`${escapeHtml(report.acceptedEntryCount ?? report.entries?.length ?? 0)} accepted<br><span class="muted">${escapeHtml(report.duplicateEntryCount || 0)} duplicate</span>`),
        formatBytes(report.totalRxBytes || 0),
        formatBytes(report.totalTxBytes || 0),
        report.totalRequestCount || 0,
        report.remoteAddress || '',
      ]))}
    </section>
    ${reports.map(cloudReportDetails).join('')}
  `);
}

function cloudSummary(report) {
  return `<section class="metrics cloud-metrics">
    ${metric('Latest Entries', report.entries?.length || 0, '#', false)}
    ${metric('Latest RX', formatBytes(report.totalRxBytes || 0), '#', false)}
    ${metric('Latest TX', formatBytes(report.totalTxBytes || 0), '#', false)}
    ${metric('Latest Requests', report.totalRequestCount || 0, '#', false)}
  </section>`;
}

function cloudReportDetails(report) {
  const entries = report.entries || [];
  return `<section class="panel cloud-report">
    <div class="panel-head">
      <h2>${escapeHtml(report.receivedAt || 'Report')}</h2>
      <span class="muted">${escapeHtml(report.nodeKey || 'missing node key')}</span>
    </div>
    <div class="table-wrap cloud-entry-wrap">
      ${table(['Secret', 'Timestamp', 'RX', 'TX', 'Requests'], entries.map((entry) => [
        html(`<code>${escapeHtml(entry.secret || '')}</code>`),
        html(`${escapeHtml(formatTrafficTimestamp(entry.timestamp))}<br><span class="muted">${escapeHtml(entry.timestamp || '')}</span>`),
        formatBytes(entry.rxBytes || 0),
        formatBytes(entry.txBytes || 0),
        entry.requestCount || 0,
      ]))}
    </div>
    <details class="cloud-raw">
      <summary>Raw JSON</summary>
      <pre>${escapeHtml(JSON.stringify({
    headers: report.headers,
    entries,
  }, null, 2))}</pre>
    </details>
  </section>`;
}

export function certificatesPage(certs, editingCert = null) {
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
        html(`<a href="/c/${encodeURIComponent(cert.id)}/cert">cert</a> <a href="/c/${encodeURIComponent(cert.id)}/key">key</a>`),
        html(`<button class="copy-command" type="button" data-renew-command data-cert-id="${escapeAttr(cert.id)}" data-cert-token="${escapeAttr(cert.uploadToken || '')}" data-domain="${escapeAttr(cert.domain || cert.id)}">Renew hook</button>`),
        html(`<div class="row-actions"><a class="button-link small" href="/certificates/${encodeURIComponent(cert.id)}/edit">Edit</a>${deleteForm(`/api/cert/${encodeURIComponent(cert.id)}`)}</div>`),
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
        html(`<code>${escapeHtml(user.token)}</code>`),
        user.enabled ? 'yes' : 'no',
        user.expireAt || 'never',
        html(`${escapeHtml(formatBytes(user.trafficLimit || 0))}<br><span class="muted">not enforced</span>`),
        html(`<a href="/sub/clash/${encodeURIComponent(user.token)}">Clash</a>`),
        html(`<a href="/sub/v2rayn/${encodeURIComponent(user.token)}">v2rayN</a>`),
        html(deleteForm(`/api/user/${encodeURIComponent(user.token)}`)),
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
        html(`<code>${escapeHtml(user.token)}</code>`),
        html(`<a href="/sub/clash/${encodeURIComponent(user.token)}">/sub/clash/${escapeHtml(user.token)}</a>`),
        html(`<a href="/sub/v2rayn/${encodeURIComponent(user.token)}">/sub/v2rayn/${escapeHtml(user.token)}</a>`),
      ]))}
    </section>
  `);
}

export function settingsPage(settings, security = {}, error = '') {
  return layout('Settings', 'Settings', `
    <header class="topbar"><h1>Settings</h1></header>
    ${error ? `<p class="error settings-error">${escapeHtml(error)}</p>` : ''}
    <section class="panel">
      <div class="panel-head">
        <h2>General</h2>
      </div>
      <form method="post" action="/api/settings" class="grid-form">
        ${input('publicBaseUrl', 'Public Base URL', 'https://sub.example.com', false, settings.publicBaseUrl || '')}
        <button type="submit">Save Settings</button>
      </form>
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>Password</h2>
      </div>
      <form method="post" action="/api/security/password" class="grid-form">
        <label>Current Password
          <input name="currentPassword" type="password" autocomplete="current-password" required>
        </label>
        <label>New Password
          <input name="newPassword" type="password" autocomplete="new-password" minlength="8" required>
        </label>
        <label>Confirm New Password
          <input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required>
        </label>
        <button type="submit">Update Password</button>
      </form>
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>Two-Factor Authentication</h2>
        <span class="status ${security.twoFactorEnabled ? 'status-up' : 'status-waiting'}">${security.twoFactorEnabled ? 'ENABLED' : 'DISABLED'}</span>
      </div>
      ${twoFactorPanel(security)}
    </section>
  `);
}

function twoFactorPanel(security) {
  if (security.twoFactorEnabled) {
    return `<form method="post" action="/api/security/2fa/disable" class="grid-form">
      <label>Current Password
        <input name="currentPassword" type="password" autocomplete="current-password" required>
      </label>
      <label>2FA Code
        <input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" placeholder="123456" required>
      </label>
      <button class="danger" type="submit">Disable 2FA</button>
    </form>`;
  }

  if (security.pendingTwoFactorSecret) {
    return `<div class="two-factor-setup">
      <div class="secret-box">
        <span class="muted">Secret</span>
        <code>${escapeHtml(security.pendingTwoFactorSecret)}</code>
      </div>
      <div class="secret-box wide">
        <span class="muted">Authenticator URI</span>
        <code>${escapeHtml(security.pendingTwoFactorUri)}</code>
      </div>
      <form method="post" action="/api/security/2fa/enable" class="grid-form">
        <label>Current Password
          <input name="currentPassword" type="password" autocomplete="current-password" required>
        </label>
        <label>2FA Code
          <input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" placeholder="123456" required>
        </label>
        <button type="submit">Enable 2FA</button>
      </form>
    </div>`;
  }

  return `<form method="post" action="/api/security/2fa/prepare" class="grid-form">
    <label>Current Password
      <input name="currentPassword" type="password" autocomplete="current-password" required>
    </label>
    <button type="submit">Start 2FA Setup</button>
  </form>`;
}

function metric(label, value, href, linked = true) {
  const content = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
  return linked
    ? `<a class="metric" href="${escapeAttr(href)}">${content}</a>`
    : `<div class="metric">${content}</div>`;
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

  const trafficNodes = nodes.map((node) => {
    const rxBytes = safeBytes(node.rxBytes);
    const txBytes = safeBytes(node.txBytes);
    const rxBps = safeBytes(node.rxBps);
    const txBps = safeBytes(node.txBps);
    const totalBytes = finiteBytes(node.totalBytes) ?? rxBytes + txBytes;
    return { ...node, rxBytes, txBytes, rxBps, txBps, totalBytes };
  });
  const max = Math.max(0, ...trafficNodes.map((node) => node.totalBytes));
  return `<div class="traffic-bars">
    ${trafficNodes.map((node) => {
      const width = max > 0 ? Math.min(100, Math.max(0, (node.totalBytes / max) * 100)) : 0;
      const hasTraffic = node.totalBytes > 0 ? ' has-traffic' : '';
      return `<div class="traffic-row">
        <div class="traffic-row-head">
          <span>${escapeHtml(node.name)}</span>
          <strong>${escapeHtml(formatBytes(node.totalBytes))}</strong>
        </div>
        <div class="bar-track"><span class="bar-fill${hasTraffic} status-fill-${escapeAttr(node.state || 'waiting')}" style="width:${escapeAttr(formatPercent(width))}%"></span></div>
        <div class="traffic-row-sub">
          <span>Speed RX ${escapeHtml(formatRate(node.rxBps))} / TX ${escapeHtml(formatRate(node.txBps))}</span>
          <span>Total RX ${escapeHtml(formatBytes(node.rxBytes))} / TX ${escapeHtml(formatBytes(node.txBytes))}${node.latencyMs === null ? '' : ` / ${escapeHtml(node.latencyMs)}ms`}</span>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function trafficTrendChart(trend) {
  const points = trend?.points || [];
  if (!points.length) return '<div class="empty mini-empty">No cloud traffic yet</div>';

  const width = 960;
  const height = 260;
  const pad = { left: 54, right: 54, top: 28, bottom: 46 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxBytes = Math.max(1, ...points.map((point) => point.rxBytes + point.txBytes));
  const maxRequests = Math.max(1, ...points.map((point) => point.requestCount));
  const xAt = (index) => pad.left + (points.length === 1 ? chartWidth : (index / (points.length - 1)) * chartWidth);
  const bytesY = (value) => pad.top + chartHeight - (value / maxBytes) * chartHeight;
  const requestY = (value) => pad.top + chartHeight - (value / maxRequests) * chartHeight;
  const rxPath = linePath(points.map((point, index) => [xAt(index), bytesY(point.rxBytes)]));
  const txPath = linePath(points.map((point, index) => [xAt(index), bytesY(point.txBytes)]));
  const totalPath = linePath(points.map((point, index) => [xAt(index), bytesY(point.rxBytes + point.txBytes)]));
  const requestPath = linePath(points.map((point, index) => [xAt(index), requestY(point.requestCount)]));
  const rxArea = areaPath(points.map((point, index) => [xAt(index), bytesY(point.rxBytes)]), pad.top + chartHeight);
  const totalArea = areaPath(points.map((point, index) => [xAt(index), bytesY(point.rxBytes + point.txBytes)]), pad.top + chartHeight);
  const xLabels = trafficXAxis(points);
  const yLabels = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    y: pad.top + chartHeight - ratio * chartHeight,
    label: formatBytes(maxBytes * ratio),
  }));

  const datasets = trafficTrendDatasets(trend);

  return `<div class="traffic-trend" data-traffic-trend>
    <script type="application/json" data-traffic-trend-data>${escapeScriptJson(datasets)}</script>
    <div class="traffic-trend-head">
      <strong>Token Traffic Trend</strong>
      <label class="traffic-node-select">Node
        <select data-traffic-node-select>
          ${datasets.map((dataset) => `<option value="${escapeAttr(dataset.id)}">${escapeHtml(dataset.name)}</option>`).join('')}
        </select>
      </label>
      <div class="traffic-legend">
        ${legendDot('RX', 'traffic-rx')}
        ${legendDot('TX', 'traffic-tx')}
        ${legendDot('Total', 'traffic-total')}
        ${legendDot('Requests', 'traffic-requests')}
      </div>
    </div>
    <div class="traffic-tooltip" data-traffic-tooltip hidden></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cloud traffic trend" data-traffic-svg>
      <defs>
        <linearGradient id="traffic-total-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.24"></stop>
          <stop offset="100%" stop-color="#06b6d4" stop-opacity="0.03"></stop>
        </linearGradient>
        <linearGradient id="traffic-rx-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2563eb" stop-opacity="0.18"></stop>
          <stop offset="100%" stop-color="#2563eb" stop-opacity="0.02"></stop>
        </linearGradient>
      </defs>
      ${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const y = pad.top + chartHeight * ratio;
        return `<line class="chart-grid" x1="${pad.left}" y1="${formatNumber(y)}" x2="${pad.left + chartWidth}" y2="${formatNumber(y)}"></line>`;
      }).join('')}
      ${[0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((ratio) => {
        const x = pad.left + chartWidth * ratio;
        return `<line class="chart-grid vertical" x1="${formatNumber(x)}" y1="${pad.top}" x2="${formatNumber(x)}" y2="${pad.top + chartHeight}"></line>`;
      }).join('')}
      <g data-traffic-y-axis>${yLabels.map((item) => `<text class="chart-axis" x="${pad.left - 8}" y="${formatNumber(item.y + 4)}" text-anchor="end">${escapeHtml(item.label)}</text>`).join('')}</g>
      <g data-traffic-x-axis>${xLabels.map((item) => `<text class="chart-axis x-axis" x="${formatNumber(item.x)}" y="${height - 16}" text-anchor="middle">${escapeHtml(item.label)}</text>`).join('')}</g>
      <path class="traffic-area traffic-total-area" d="${escapeAttr(totalArea)}"></path>
      <path class="traffic-area traffic-rx-area" d="${escapeAttr(rxArea)}"></path>
      <path class="traffic-line traffic-total-line" d="${escapeAttr(totalPath)}"></path>
      <path class="traffic-line traffic-rx-line" d="${escapeAttr(rxPath)}"></path>
      <path class="traffic-line traffic-tx-line" d="${escapeAttr(txPath)}"></path>
      <path class="traffic-line traffic-request-line" d="${escapeAttr(requestPath)}"></path>
      <g data-traffic-points>${points.map((point, index) => {
        const x = xAt(index);
        const totalY = bytesY(point.rxBytes + point.txBytes);
        return `<circle class="traffic-point" cx="${formatNumber(x)}" cy="${formatNumber(totalY)}" r="2.5"><title>${escapeHtml(`${formatTrafficTimestamp(point.timestamp)} total ${formatBytes(point.rxBytes + point.txBytes)} requests ${point.requestCount}`)}</title></circle>`;
      }).join('')}</g>
    </svg>
  </div>`;
}

function trafficTrendDatasets(trend) {
  return [
    {
      id: 'all',
      name: 'All Nodes',
      points: trend?.points || [],
      secrets: trend?.secrets || [],
    },
    ...(trend?.nodes || []).filter((node) => node.points?.length),
  ];
}

function trafficTokenTable(trend) {
  const secrets = trend?.secrets || [];
  if (!secrets.length) return '';
  return `<div class="traffic-token-grid">
    ${secrets.map((item) => `<div class="traffic-token">
      <span>${escapeHtml(item.secret)}</span>
      <strong>${escapeHtml(formatBytes(item.rxBytes + item.txBytes))}</strong>
      <small>RX ${escapeHtml(formatBytes(item.rxBytes))} / TX ${escapeHtml(formatBytes(item.txBytes))} / ${escapeHtml(item.requestCount)} requests</small>
    </div>`).join('')}
  </div>`;
}

function latencyNodeChart(nodes) {
  if (!nodes || !nodes.length) {
    return '<div class="empty mini-empty">No latency data yet</div>';
  }

  return `<div class="latency-list">
    ${nodes.map((node) => `<div class="latency-node">
      <div class="latency-node-head">
        <span>${escapeHtml(node.name)}</span>
        <div class="latency-current">
          ${latencyPill('Local', node.local)}
          ${latencyPill('CM', node.cm)}
          ${latencyPill('CU', node.cu)}
          ${latencyPill('CT', node.ct)}
        </div>
      </div>
      <div class="heat-grid">
        ${latencyHeat(node.history, 'local', 'Local')}
        ${latencyHeat(node.history, 'cm', 'CM')}
        ${latencyHeat(node.history, 'cu', 'CU')}
        ${latencyHeat(node.history, 'ct', 'CT')}
      </div>
    </div>`).join('')}
  </div>`;
}

function latencyPill(label, value) {
  const className = latencyClass(value);
  return `<span class="latency-pill ${className}">${escapeHtml(label)} ${escapeHtml(formatLatency(value))}</span>`;
}

function latencyHeat(history, key, label) {
  const samples = normalizeHeatSamples(history, key);
  return `<div class="heat-row">
    <span>${escapeHtml(label)}</span>
    <div class="heat-cells">
      ${samples.map((value) => `<i class="${escapeAttr(latencyClass(value))}" title="${escapeAttr(`${label}: ${formatLatency(value)}`)}"></i>`).join('')}
    </div>
  </div>`;
}

function normalizeHeatSamples(history, key) {
  const values = Array.isArray(history) ? history.slice(-48).map((sample) => sample[key] ?? null) : [];
  while (values.length < 48) values.unshift(null);
  return values;
}

function latencyClass(value) {
  if (value === null || value === undefined) return 'latency-empty';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'latency-empty';
  if (number <= 80) return 'latency-good';
  if (number <= 180) return 'latency-ok';
  if (number <= 350) return 'latency-warn';
  return 'latency-bad';
}

function nodeStatus(node) {
  const status = node.status || node.agent || {};
  const label = {
    up: 'UP',
    down: 'DOWN',
    stale: 'STALE',
    waiting: 'WAITING',
    disabled: 'DISABLED',
  }[status.state] || 'WAITING';
  const source = status.source ? ` via ${status.source}` : '';
  const latency = node.agent?.latencyMs === null || node.agent?.latencyMs === undefined ? '' : ` ${node.agent.latencyMs}ms`;
  const reported = status.reportedAt ? `${relativeTime(status.ageSeconds)} ago` : 'never';
  const error = node.agent?.error ? `<br><span class="muted">${escapeHtml(node.agent.error)}</span>` : '';

  return `<span class="status status-${escapeAttr(status.state || 'waiting')}">${label}</span><br><span class="muted">${escapeHtml(reported)}${escapeHtml(source)}${escapeHtml(latency)}</span>${error}`;
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
  const traffic = node.traffic || node.agent || {};
  const rx = formatBytes(traffic.rxBytes || 0);
  const tx = formatBytes(traffic.txBytes || 0);
  const count = Number(traffic.connections || traffic.requestCount || 0);
  const label = traffic.source === 'cloud' ? 'requests' : 'conns';
  return `<span>RX ${escapeHtml(rx)}</span><br><span>TX ${escapeHtml(tx)}</span><br><span class="muted">${count} ${escapeHtml(label)}</span>`;
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

function formatTrafficTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 'n/a';
  return new Date(number).toISOString();
}

function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let number = safeBytes(value);
  let index = 0;
  while (number >= 1024 && index < units.length - 1) {
    number /= 1024;
    index += 1;
  }
  return `${number >= 10 || index === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[index]}`;
}

function formatRate(value) {
  return `${formatBytes(value)}/s`;
}

function finiteBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function safeBytes(value) {
  return finiteBytes(value) ?? 0;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * 1000) / 1000);
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * 100) / 100);
}

function formatLatency(value) {
  return value === null || value === undefined ? 'n/a' : `${value}ms`;
}

function linePath(points) {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${formatNumber(x)} ${formatNumber(y)}`).join(' ');
}

function areaPath(points, baseline) {
  if (!points.length) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L ${formatNumber(last[0])} ${formatNumber(baseline)} L ${formatNumber(first[0])} ${formatNumber(baseline)} Z`;
}

function trafficXAxis(points) {
  const count = Math.min(7, points.length);
  if (!count) return [];
  const width = 852;
  const left = 54;
  return Array.from({ length: count }, (_, index) => {
    const pointIndex = count === 1 ? 0 : Math.round((index / (count - 1)) * (points.length - 1));
    const point = points[pointIndex];
    return {
      x: left + (points.length === 1 ? 0 : (pointIndex / (points.length - 1)) * width),
      label: shortTime(point.timestamp),
    };
  });
}

function shortTime(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(5, 16).replace('T', ' ');
}

function legendDot(label, className) {
  return `<span><i class="${escapeAttr(className)}"></i>${escapeHtml(label)}</span>`;
}

function table(headers, rows) {
  return `<table>
    <thead><tr>${headers.map((head) => `<th>${escapeHtml(head)}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${tableCell(cell)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="empty">No data</td></tr>`}</tbody>
  </table>`;
}

function agentVersion(node) {
  const version = node.agent?.version;
  const state = node.agent?.state || 'waiting';
  return `<div class="agent-version"><span class="muted">agent optional</span> <span class="status status-${escapeAttr(state)}">${escapeHtml(state.toUpperCase())}</span> ${escapeHtml(version || '')}</div>`;
}

function cloudVersion(node) {
  const state = node.cloud?.state || 'waiting';
  const token = node.cloudToken || node.id;
  const reported = node.cloud?.reportedAt ? `${relativeTime(node.cloud.ageSeconds)} ago` : 'never';
  return `<div class="agent-version cloud-version"><span class="muted">cloud</span> <span class="status status-${escapeAttr(state)}">${escapeHtml(state.toUpperCase())}</span><br><code>${escapeHtml(token)}</code><br><span class="muted">${escapeHtml(reported)}</span></div>`;
}

function deleteForm(action) {
  return `<form method="post" action="${escapeAttr(action)}"><input type="hidden" name="_method" value="DELETE"><button class="danger" type="submit">Delete</button></form>`;
}

function deployForm(node) {
  return `<form method="post" action="/api/node/${encodeURIComponent(node.id)}/deploy"><button class="small" type="submit">Deploy</button></form>`;
}

function deployStatus(command) {
  if (!command) return '<span class="muted">no command</span>';
  const status = command.status || 'pending';
  const label = {
    pending: 'pending',
    succeeded: 'succeeded',
    failed: 'failed',
  }[status] || status;
  const detail = command.finishedAt || command.createdAt || '';
  const error = command.error ? `<br><span class="muted">${escapeHtml(command.error)}</span>` : '';
  const output = command.output ? `<details class="deploy-details"><summary>Output</summary><pre class="deploy-output">${escapeHtml(command.output)}</pre></details>` : '';
  return `<div class="deploy-status"><span class="status status-${status === 'succeeded' ? 'up' : status === 'failed' ? 'down' : 'waiting'}">${escapeHtml(label.toUpperCase())}</span><br><span class="muted">${escapeHtml(detail)}</span>${error}${output}</div>`;
}

function html(value) {
  return { __html: String(value) };
}

function tableCell(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, '__html')) return value.__html;
  return escapeHtml(value);
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

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
