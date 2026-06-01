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
ADMIN_PASS=Aa.114514
DATA_FILE=./data/db.json
PUBLIC_BASE_URL=https://sub.example.com
```

Default admin login:

- user: `admin`
- password: `Aa.114514`

Login uses a normal web form at `/login`.

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
