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
      ${metric('Total Certificates', metrics.totalCertificates, '/certificates')}
      ${metric('Expiring Certificates', metrics.expiringCertificates, '/certificates')}
      ${metric('Total Users', metrics.totalUsers, '/users')}
      ${metric('Active Tokens', metrics.activeSubscriptionTokens, '/subscriptions')}
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
      ${table(['Key', 'Name', 'Host', 'Listen', 'SNI', 'Config', 'Docker', ''], nodes.map((node) => [
        node.id,
        node.name,
        node.host,
        node.listen || `0.0.0.0:${node.port}`,
        node.sni,
        `<a href="/n/${encodeURIComponent(node.id)}">/n/${escapeHtml(node.id)}</a>`,
        `<code class="docker-command" data-docker-command data-config-path="/n/${encodeURIComponent(node.id)}"></code>`,
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
        <label class="check"><input type="checkbox" name="enabled" checked> Enabled</label>
        <button type="submit">Save User</button>
      </form>
    </section>
    <section class="table-wrap">
      ${table(['Name', 'Token', 'Enabled', 'Expire At', 'Clash', 'v2rayN', ''], users.map((user) => [
        user.name,
        `<code>${escapeHtml(user.token)}</code>`,
        user.enabled ? 'yes' : 'no',
        user.expireAt || 'never',
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
