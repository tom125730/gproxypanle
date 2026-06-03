const nodeForm = document.querySelector('[data-node-form]');
const trafficLive = document.querySelector('[data-traffic-live]');
const trafficConnections = document.querySelector('[data-traffic-connections]');

if (trafficLive) {
  startTrafficRefresh(trafficLive, trafficConnections);
}

initTrafficTrends(document);

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
  item.dataset.command = `docker rm -f gproxy || true && docker pull gproxylabs/gproxy && docker run --network=host --name=gproxy --restart=always -d gproxylabs/gproxy -w -c ${configUrl}`;
});

document.querySelectorAll('[data-renew-command]').forEach((item) => {
  const domain = item.dataset.domain;
  const certId = item.dataset.certId;
  const token = item.dataset.certToken;
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  const keyPath = `/etc/letsencrypt/live/${domain}/privkey.pem`;
  const uploadUrl = `${window.location.origin}/api/cert/${certId}?token=${encodeURIComponent(token || '')}`;
  item.dataset.command = `certbot renew --deploy-hook "curl -fsS --data-urlencode 'cert@${certPath}' --data-urlencode 'key@${keyPath}' '${uploadUrl}'"`;
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
  item.dataset.command = `curl -fsSL '${window.location.origin}/static/gproxy-agent.sh' | bash -s -- '${params.toString()}'`;
});

document.querySelectorAll('[data-command]').forEach((item) => {
  item.addEventListener('click', async () => {
    await copyText(item.dataset.command || '');
    const original = item.textContent;
    item.textContent = 'Copied';
    item.classList.add('copied');
    window.setTimeout(() => {
      item.textContent = original;
      item.classList.remove('copied');
    }, 1300);
  });
});

function startTrafficRefresh(container, connectionsLabel) {
  let refreshing = false;
  let stopped = document.hidden;

  const refresh = async () => {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const response = await fetch('/api/metrics/traffic', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) return;

      const payload = await response.json();
      if (typeof payload.html === 'string') {
        const selectedNodeId = container.querySelector('[data-traffic-node-select]')?.value || '';
        container.innerHTML = payload.html;
        initTrafficTrends(container, selectedNodeId);
      }
      if (connectionsLabel && Number.isFinite(Number(payload.totalConnections))) {
        connectionsLabel.textContent = `${payload.totalConnections} requests`;
      }
    } catch {
      // Keep the last good values visible when a refresh fails.
    } finally {
      refreshing = false;
    }
  };

  const timer = window.setInterval(refresh, 5000);

  document.addEventListener('visibilitychange', () => {
    stopped = document.hidden;
    if (!stopped) refresh();
  });

  window.addEventListener('beforeunload', () => window.clearInterval(timer));
  refresh();
}

function initTrafficTrends(root, preferredNodeId = '') {
  root.querySelectorAll('[data-traffic-trend]').forEach((chart) => {
    if (chart.dataset.ready === 'true') return;
    chart.dataset.ready = 'true';
    const dataNode = chart.querySelector('[data-traffic-trend-data]');
    const select = chart.querySelector('[data-traffic-node-select]');
    const tokenList = root.querySelector('[data-traffic-token-list]');
    let datasets = [];

    try {
      datasets = JSON.parse(dataNode?.textContent || '[]');
    } catch {
      datasets = [];
    }
    if (!datasets.length) return;
    const savedNodeId = preferredNodeId || window.localStorage.getItem('gproxyTrafficNodeId') || '';
    if (select && savedNodeId && datasets.some((item) => item.id === savedNodeId)) {
      select.value = savedNodeId;
    }

    const render = () => {
      const dataset = datasets.find((item) => item.id === select?.value) || datasets[0];
      renderTrafficChart(chart, dataset);
      if (tokenList) tokenList.innerHTML = renderTrafficTokenList(dataset.secrets || []);
    };

    select?.addEventListener('change', () => {
      window.localStorage.setItem('gproxyTrafficNodeId', select.value || '');
      render();
    });
    render();
  });
}

function renderTrafficChart(chart, dataset) {
  const points = dataset.points || [];
  const svg = chart.querySelector('[data-traffic-svg]');
  const tooltip = chart.querySelector('[data-traffic-tooltip]');
  if (!svg || !points.length) return;

  const pad = { left: 54, right: 54, top: 28, bottom: 46 };
  const width = 960;
  const height = 260;
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxBytes = Math.max(1, ...points.map((point) => point.rxBytes + point.txBytes));
  const maxRequests = Math.max(1, ...points.map((point) => point.requestCount));
  const xAt = (index) => pad.left + (points.length === 1 ? chartWidth : (index / (points.length - 1)) * chartWidth);
  const bytesY = (value) => pad.top + chartHeight - (value / maxBytes) * chartHeight;
  const requestY = (value) => pad.top + chartHeight - (value / maxRequests) * chartHeight;

  setPath(svg, '.traffic-total-area', areaPath(points.map((point, index) => [xAt(index), bytesY(point.rxBytes + point.txBytes)]), pad.top + chartHeight));
  setPath(svg, '.traffic-rx-area', areaPath(points.map((point, index) => [xAt(index), bytesY(point.rxBytes)]), pad.top + chartHeight));
  setPath(svg, '.traffic-total-line', linePath(points.map((point, index) => [xAt(index), bytesY(point.rxBytes + point.txBytes)])));
  setPath(svg, '.traffic-rx-line', linePath(points.map((point, index) => [xAt(index), bytesY(point.rxBytes)])));
  setPath(svg, '.traffic-tx-line', linePath(points.map((point, index) => [xAt(index), bytesY(point.txBytes)])));
  setPath(svg, '.traffic-request-line', linePath(points.map((point, index) => [xAt(index), requestY(point.requestCount)])));
  renderTrafficAxes(svg, points, maxBytes, pad, chartWidth, chartHeight, height);

  const pointsGroup = svg.querySelector('[data-traffic-points]');
  if (pointsGroup) {
    pointsGroup.innerHTML = points.map((point, index) => {
      const x = xAt(index);
      const y = bytesY(point.rxBytes + point.txBytes);
      return `<circle class="traffic-point" cx="${formatNumber(x)}" cy="${formatNumber(y)}" r="2.5"></circle>`;
    }).join('');
  }

  svg.onmousemove = (event) => {
    const rect = svg.getBoundingClientRect();
    const ratioX = (event.clientX - rect.left) / Math.max(1, rect.width);
    const viewX = ratioX * width;
    const index = nearestPointIndex(points, viewX, xAt);
    const point = points[index];
    const x = xAt(index);
    const y = bytesY(point.rxBytes + point.txBytes);
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(Math.max((x / width) * rect.width, 12), rect.width - 210)}px`;
    tooltip.style.top = `${Math.max((y / height) * rect.height - 120, 8)}px`;
    tooltip.innerHTML = `
      <strong>${escapeHtml(dataset.name)}</strong>
      <span>${escapeHtml(formatTimestamp(point.timestamp))}</span>
      <span>RX ${escapeHtml(formatBytes(point.rxBytes))}</span>
      <span>TX ${escapeHtml(formatBytes(point.txBytes))}</span>
      <span>Total ${escapeHtml(formatBytes(point.rxBytes + point.txBytes))}</span>
      <span>${escapeHtml(point.requestCount)} requests</span>
    `;
  };
  svg.onmouseleave = () => {
    tooltip.hidden = true;
  };
}

function renderTrafficAxes(svg, points, maxBytes, pad, chartWidth, chartHeight, height) {
  const yAxis = svg.querySelector('[data-traffic-y-axis]');
  const xAxis = svg.querySelector('[data-traffic-x-axis]');
  if (yAxis) {
    yAxis.innerHTML = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const y = pad.top + chartHeight - ratio * chartHeight;
      return `<text class="chart-axis" x="${pad.left - 8}" y="${formatNumber(y + 4)}" text-anchor="end">${escapeHtml(formatBytes(maxBytes * ratio))}</text>`;
    }).join('');
  }
  if (xAxis) {
    const labels = trafficXAxis(points, pad.left, chartWidth);
    xAxis.innerHTML = labels.map((item) => `<text class="chart-axis x-axis" x="${formatNumber(item.x)}" y="${height - 16}" text-anchor="middle">${escapeHtml(item.label)}</text>`).join('');
  }
}

function trafficXAxis(points, left, width) {
  const count = Math.min(7, points.length);
  if (!count) return [];
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

function renderTrafficTokenList(secrets) {
  if (!secrets.length) return '';
  return `<div class="traffic-token-grid">
    ${secrets.map((item, index) => `<div class="traffic-token">
      <span>${escapeHtml(tokenLabel(index))}</span>
      <strong>${escapeHtml(formatBytes(item.rxBytes + item.txBytes))}</strong>
      <small>RX ${escapeHtml(formatBytes(item.rxBytes))} / TX ${escapeHtml(formatBytes(item.txBytes))} / ${escapeHtml(item.requestCount)} requests</small>
    </div>`).join('')}
  </div>`;
}

function tokenLabel(index) {
  return `Token ${index + 1}`;
}

function setPath(svg, selector, d) {
  const element = svg.querySelector(selector);
  if (element) element.setAttribute('d', d);
}

function nearestPointIndex(points, x, xAt) {
  let best = 0;
  let bestDistance = Infinity;
  points.forEach((_, index) => {
    const distance = Math.abs(xAt(index) - x);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
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

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * 100) / 100);
}

function buildNodeYaml(form) {
  const data = new FormData(form);
  const port = data.get('port') || '443';
  const listen = data.get('listen') || `0.0.0.0:${port}`;
  const secrets = splitList(data.get('password') || '3c999130');
  const wspaths = splitList(data.get('wspaths') || '/gproxy');
  const certId = data.get('certId') || '';
  const nodeId = data.get('id') || '';
  const configToken = data.get('configToken') || '';
  const certBasePath = nodeId && configToken ? `/n/${nodeId}/${configToken}` : '';
  const certUrl = certId && certBasePath ? `${window.location.origin}${certBasePath}/cert` : '';
  const keyUrl = certId && certBasePath ? `${window.location.origin}${certBasePath}/key` : '';
  const cloudToken = data.get('cloudToken') || nodeId || '';

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
    'cloud:',
    `  nodeKey: ${yamlString(cloudToken)}`,
    `  url: ${yamlString(window.location.origin)}`,
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

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let number = Number(value);
  if (!Number.isFinite(number) || number < 0) number = 0;
  let index = 0;
  while (number >= 1024 && index < units.length - 1) {
    number /= 1024;
    index += 1;
  }
  return `${number >= 10 || index === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[index]}`;
}

function formatTimestamp(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return 'n/a';
  return date.toISOString().replace('T', ' ').slice(0, 19);
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
