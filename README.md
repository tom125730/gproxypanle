# gproxy Control Plane

Lightweight VPS control plane for gproxy nodes.

It does not proxy traffic. It only manages nodes, users, certificates, remote
configuration, and subscription generation.

## Run

```bash
node src/server.js
```

Environment variables:

```bash
HOST=0.0.0.0
PORT=3000
ADMIN_USER=admin
ADMIN_PASS=change-me
SESSION_SECRET=change-me
DATA_FILE=./data/db.json
PUBLIC_BASE_URL=https://sub.example.com
```

Admin login:

- user: `admin`
- password: the value of `ADMIN_PASS`

Login uses a normal web form at `/login`.

## Security

On first start, the admin password is initialized from `ADMIN_PASS` and stored as
a PBKDF2-SHA256 hash in `data/db.json`. After that, the password can be changed
from `Settings -> Password` without editing the environment file.

Two-factor authentication can be enabled from `Settings -> Two-Factor
Authentication`. It uses standard TOTP codes supported by Google Authenticator,
Microsoft Authenticator, 1Password, and similar apps.

When 2FA is enabled, browser sessions must sign in with username, password, and
the 6-digit TOTP code. HTTP Basic Auth is limited to certificate upload routes
so existing certificate renewal hooks can continue to run.

## VPS Deployment

The examples below assume an Ubuntu/Debian VPS, a DNS record already pointing to
the server, and the panel repository hosted at:

```bash
https://github.com/tom125730/gproxypanle.git
```

### 1. Install runtime packages

```bash
apt update
apt install -y git curl nginx certbot python3-certbot-nginx
```

Install Node.js 20 or newer if the system package is older:

```bash
node -v
```

### 2. Pull the project

```bash
cd /opt
git clone https://github.com/tom125730/gproxypanle.git
cd /opt/gproxypanle
```

### 3. Configure environment variables

Create `/opt/gproxypanle/.env`:

```bash
HOST=127.0.0.1
PORT=3000
ADMIN_USER=admin
ADMIN_PASS=replace-with-a-strong-password
SESSION_SECRET=replace-with-a-long-random-secret
DATA_FILE=/opt/gproxypanle/data/db.json
PUBLIC_BASE_URL=https://your-domain.example
```

Use `127.0.0.1` when Nginx is used as the public reverse proxy. This keeps the
Node.js service private to the VPS.

### 4. Test the service

```bash
set -a
source /opt/gproxypanle/.env
set +a
node /opt/gproxypanle/src/server.js
```

Stop the test process after confirming it starts successfully.

### 5. Run with systemd

Create `/etc/systemd/system/gproxypanel.service`:

```ini
[Unit]
Description=gproxy control panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gproxypanle
EnvironmentFile=/opt/gproxypanle/.env
ExecStart=/usr/bin/node /opt/gproxypanle/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Start the service:

```bash
systemctl daemon-reload
systemctl enable --now gproxypanel
systemctl status gproxypanel
```

View logs:

```bash
journalctl -u gproxypanel -f
```

### 6. Configure Nginx reverse proxy

Create `/etc/nginx/sites-available/gproxypanel`:

```nginx
server {
    listen 80;
    server_name your-domain.example;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and reload Nginx:

```bash
ln -s /etc/nginx/sites-available/gproxypanel /etc/nginx/sites-enabled/gproxypanel
nginx -t
systemctl reload nginx
```

### 7. Enable HTTPS

```bash
certbot --nginx -d your-domain.example
```

Choose the redirect-to-HTTPS option when prompted.

### 8. Update after new commits

```bash
cd /opt/gproxypanle
git pull
systemctl restart gproxypanel
```

## Node Monitoring Agent

The panel does not proxy traffic, so it cannot read real node traffic by itself.
For uptime and traffic monitoring, install the lightweight agent on each gproxy
node VPS.

After creating or editing a node in `/nodes`, copy the generated Agent command
from the node table and run it on that node VPS as root. It looks like this:

```bash
curl -fsSL 'https://your-panel.example/static/gproxy-agent.sh' | bash -s -- 'panel=https://your-panel.example&node=hk01&token=...&listen=0.0.0.0:443&host=hk.example.com&port=443'
```

Node-side dependencies:

```bash
apt install -y curl python3 iproute2 iptables
```

The agent creates:

- `/etc/gproxy-agent/env`
- `/usr/local/bin/gproxy-agent`
- `gproxy-agent.service`

It reports to:

```bash
POST /api/node/:id/agent
```

The agent uses the per-node `agentToken` shown in the install command. It sends:

- node status: `up` or `down`
- local TCP check latency
- TCP latency to China Mobile: `js-cm-v4.ip.zstaticcdn.com:80`
- TCP latency to China Unicom: `js-cu-v4.ip.zstaticcdn.com:80`
- TCP latency to China Telecom: `js-ct-v4.ip.zstaticcdn.com:80`
- connection count from `ss`
- RX/TX byte counters from `iptables`
- host uptime

Traffic is currently node-level traffic. The `trafficLimit` field on users is
stored for planning and display only; it is not enforced yet because gproxy does
not expose per-subscription-user traffic data to the panel.

The Dashboard keeps a rolling 24-hour latency history per node. It stores up to
1440 samples per node and automatically drops older samples. `no data` means the
agent has not reported that probe yet; `down` means the agent reported a failed
TCP connection to that target from the node VPS.

Manage the agent on a node VPS:

```bash
systemctl status gproxy-agent
journalctl -u gproxy-agent -f
systemctl restart gproxy-agent
```

If tri-network latency shows `no data`, the node is likely still running an old
agent. Update it on the node VPS:

```bash
curl -fsSL https://your-panel.example/static/gproxy-agent.sh -o /usr/local/bin/gproxy-agent
chmod 0755 /usr/local/bin/gproxy-agent
systemctl restart gproxy-agent
```

If it shows `down`, test DNS and TCP connectivity from that node VPS:

```bash
getent hosts js-cm-v4.ip.zstaticcdn.com js-cu-v4.ip.zstaticcdn.com js-ct-v4.ip.zstaticcdn.com
timeout 3 bash -c 'cat < /dev/null > /dev/tcp/js-cm-v4.ip.zstaticcdn.com/80'
timeout 3 bash -c 'cat < /dev/null > /dev/tcp/js-cu-v4.ip.zstaticcdn.com/80'
timeout 3 bash -c 'cat < /dev/null > /dev/tcp/js-ct-v4.ip.zstaticcdn.com/80'
```

### Logs and storage growth

The panel stores the latest node metrics and a rolling 24-hour latency history in
`data/db.json`. Older latency samples are pruned automatically, so the JSON
database should not grow forever from monitoring.

Runtime logs are handled by systemd journald. To cap journal size on a VPS, edit
`/etc/systemd/journald.conf`:

```ini
SystemMaxUse=200M
RuntimeMaxUse=50M
MaxRetentionSec=14day
```

Then restart journald:

```bash
systemctl restart systemd-journald
```

You can vacuum old logs manually:

```bash
journalctl --vacuum-time=14d
journalctl --vacuum-size=200M
```

## Routes

Admin UI:

- `GET /`
- `GET /nodes`
- `GET /certificates`
- `GET /subscriptions`
- `GET /users`
- `GET /settings`

Admin API:

- `GET /api/nodes`
- `GET /api/node/:id`
- `POST /api/node/:id`
- `DELETE /api/node/:id`
- `GET /api/certs`
- `POST /api/cert/:id`
- `DELETE /api/cert/:id`
- `GET /api/users`
- `POST /api/user`
- `DELETE /api/user/:token`
- `POST /api/node/:id/agent`

Public distribution:

- `GET /n/:nodeKey`
- `GET /c/:id/cert`
- `GET /c/:id/key`

Certificate API also accepts HTTP Basic Auth, so renewal hooks can post updated
PEM files without using a browser session cookie.
- `GET /sub/clash/:token`
- `GET /sub/v2rayn/:token`

## Storage

Data is stored in `data/db.json`.

This is intentionally simple for VPS deployment. The storage code is isolated in
`src/store.js`, so it can later be replaced with SQLite, PostgreSQL, or Redis.

## Node Config

`/n/:nodeKey` returns the exact YAML saved in the node's `yaml` field. If that
field is empty, the panel generates a minimal gproxy config:

- `inbound.listen` from the node listen address
- `inbound.secrets` from the node secrets field
- optional remote cert/key URLs from the selected certificate
- one `direct://` outbound
- `MATCH,direct` router rule
