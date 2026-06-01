const nodeForm = document.querySelector('[data-node-form]');

if (nodeForm) {
  const yamlOutput = nodeForm.querySelector('[data-yaml-output]');
  let generatedYaml = buildNodeYaml(nodeForm);
  let manualEdit = Boolean(yamlOutput.value.trim() && yamlOutput.value !== generatedYaml);

  if (!yamlOutput.value.trim()) {
    yamlOutput.value = generatedYaml;
  }

  const refresh = () => {
    generatedYaml = buildNodeYaml(nodeForm);
    if (!manualEdit || !yamlOutput.value.trim()) {
      yamlOutput.value = generatedYaml;
      manualEdit = false;
    }
  };

  nodeForm.addEventListener('input', (event) => {
    if (event.target === yamlOutput) {
      manualEdit = yamlOutput.value !== generatedYaml;
      return;
    }
    refresh();
  });

  nodeForm.addEventListener('change', refresh);
  refresh();
}

document.querySelectorAll('[data-docker-command]').forEach((item) => {
  const configUrl = `${window.location.origin}${item.dataset.configPath}`;
  item.textContent = `docker rm -f gproxy || true && docker run --network=host --name=gproxy --restart=always -d gproxylabs/gproxy -w -c ${configUrl}`;
});

document.querySelectorAll('[data-renew-command]').forEach((item) => {
  const domain = item.dataset.domain;
  const certId = item.dataset.certId;
  const auth = item.dataset.auth;
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  const keyPath = `/etc/letsencrypt/live/${domain}/privkey.pem`;
  item.textContent = `certbot renew --deploy-hook "curl -fsS -u '${auth}' --data-urlencode 'cert@${certPath}' --data-urlencode 'key@${keyPath}' ${window.location.origin}/api/cert/${certId}"`;
});

document.querySelectorAll('[data-agent-command]').forEach((item) => {
  const params = new URLSearchParams({
    panel: window.location.origin,
    node: item.dataset.nodeId,
    token: item.dataset.agentToken,
    listen: item.dataset.listen,
    host: item.dataset.targetHost,
    port: item.dataset.targetPort,
  });
  item.textContent = `curl -fsSL '${window.location.origin}/static/gproxy-agent.sh' | bash -s -- '${params.toString()}'`;
});

function buildNodeYaml(form) {
  const data = new FormData(form);
  const port = data.get('port') || '443';
  const listen = data.get('listen') || `0.0.0.0:${port}`;
  const secrets = splitList(data.get('password') || '3c999130');
  const wspaths = splitList(data.get('wspaths') || '/gproxy');
  const certId = data.get('certId') || '';
  const certUrl = certId ? `${window.location.origin}/c/${certId}/cert` : '';
  const keyUrl = certId ? `${window.location.origin}/c/${certId}/key` : '';

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
    `  listen: ${yamlString(listen)}`,
    `  socks5: ${isChecked(form, 'socks5')}`,
    `  relay: ${isChecked(form, 'relay')}`,
    '  secrets:',
    ...secrets.map((secret) => `    - ${yamlString(secret)}`),
    '  tproxyListen:',
    '  wspaths:',
    ...wspaths.map((item) => `    - ${yamlString(item)}`),
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

function splitList(value) {
  const items = String(value).split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : [''];
}

function yamlString(value) {
  const text = String(value);
  if (!text) return '';
  if (/^[\w./:@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function isChecked(form, name) {
  const checkbox = form.querySelector(`input[type="checkbox"][name="${name}"]`);
  return Boolean(checkbox && checkbox.checked);
}
