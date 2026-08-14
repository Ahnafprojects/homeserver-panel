# Home Server Panel

A single web panel for a self-hosted home server. It replaces Portainer,
phpMyAdmin, an uptime monitor, a file manager, a code editor, and a system
dashboard — with one interface, one account system, and one design.

Built for modest hardware: an **Asus K42F** laptop (Core i3-370M, 2 cores /
4 threads, 8 GB RAM, SSD, 10/100 LAN) running Linux Mint 22.3 and Docker.

**Runtime footprint: about 20 MB of RAM. Two npm dependencies.**

---

## Why it exists

Running six separate tools meant six logins, six visual styles, and roughly
250 MB of RAM on a machine that does not have much to spare. This panel does
the same work in one process.

WebSocket framing, TOTP, password hashing, the cron parser, the Docker client,
CSV parsing, and the charts are all implemented directly against Node's
standard library rather than pulled in as packages.

## Features

**Monitoring**
- Live CPU, memory, disk, temperature, network, and uptime read from host
  `/proc` and `/sys`
- Metric history with charts drawn on canvas, persisted across restarts
- Uptime checks (HTTP and TCP) with 24-hour and 7-day availability, response
  times, incident counts, and outage history
- Notification centre with 51 event types across 10 categories

**Applications**
- Deploy from a pasted Docker Compose file or a Git repository
- Live build-log streaming over Server-Sent Events
- Branch switching, rollback to any commit, webhook auto-deploy
- Container management with per-container CPU and memory

**Data**
- Code editor built on Monaco (the editor core from VS Code) with a file tree,
  tabs, autosave, full-text search, and an integrated terminal
- Database provisioning: create PostgreSQL, MariaDB, MongoDB, or Redis
  instances from the web, with generated credentials and connection strings
- Table designer, row editor, SQL editor, query log, CSV/JSON/SQL export
  and import
- File manager with preview and inline editing

**Operations**
- Domains with automatic HTTPS through Caddy, plus certificate expiry tracking
- Scheduler with per-run history
- Encrypted secrets vault (AES-256-GCM) that can inject into stack `.env` files
- Backups and one-click restore
- Web terminal to the host or into any container
- systemd services, OS updates, firewall, and Linux user management

**AI assistant**
- Groq-backed assistant scoped strictly to this server; it reads real state
  through tools and proposes fixes that a human must approve before they run

**Security**
- scrypt password hashing, TOTP two-factor authentication
- Rate limiting with automatic IP blocking
- Three roles: Super Admin (full), Admin (per-page grants), Viewer (read-only,
  enforced server-side — `SELECT` allowed, everything else refused)
- Audit log of every state-changing action

## Requirements

- Docker and the Compose plugin
- Linux host (systemd, UFW, and temperature features need a real Linux kernel)

## Running it

```bash
git clone <this-repo> panel
cd panel
./scripts/fetch-monaco.sh      # pulls the editor component (12 MB, not vendored)
docker compose up -d --build
```

Then open `http://<server-ip>:8090`. The first screen creates the Super Admin
account.

A `docker-compose.yml` for the full stack (panel plus Caddy) lives in the
deployment bundle alongside `install-panel.sh`.

## Layout

```
src/
  server.js    HTTP routing, permission gate, SSE streams, WebSocket upgrade
  auth.js      users, roles, sessions, TOTP, rate limiting, audit log
  docker.js    Docker Engine client over the unix socket
  system.js    host metrics from /proc and /sys
  stacks.js    compose and git deployments
  dbaas.js     database provisioning, query log, export helpers
  admin.js     systemd, apt, firewall, cron, vault, backups
  events.js    event catalogue and Telegram routing
  proxy.js     Caddyfile generation and certificate checks
  ai.js        Groq assistant with tool calling
  ws.js        minimal RFC 6455 WebSocket server
public/
  app.js       shell, navigation, charts, shared helpers
  pages*.js    one file per feature area
  app.css      design tokens and components
```

## Notes and limits

- The panel runs privileged and holds the Docker socket. That is required for
  container management, the host terminal, and power control — but it means
  anyone who reaches the panel controls the machine. Do not expose port 8090
  to the internet without 2FA enabled.
- Docker publishes ports directly through iptables and bypasses UFW. Bind
  application ports to `127.0.0.1` unless they are meant to be public.
- systemd, apt, UFW, and temperature readings require a real Linux host and
  are unavailable when testing under Docker Desktop.
- The editor covers reading, writing, searching, and a terminal. It has no
  extension marketplace, debugger, or cross-file IntelliSense; use code-server
  if those matter more than memory.

## Licence

Personal project. No warranty.
