# Home Server Panel

A single web panel for a self-hosted server. It replaces Portainer,
phpMyAdmin, an uptime monitor, a file manager, a code editor, a status page,
and a deploy pipeline — with one interface, one account system, and one
design.

Built to run comfortably on modest hardware — an old laptop or a small VPS
with a couple of CPU cores and a few gigabytes of RAM is enough. Runtime
footprint is roughly 20–30 MB of RAM at idle, with 6 npm dependencies
(`pg`, `mysql2`, `ws`, `node-pty`, `nodemailer`, `web-push`); everything
else — WebSocket framing where not covered by `ws`, TOTP, password hashing,
the cron parser, the Docker client, CSV parsing, OAuth, and the charts — is
implemented directly against Node's standard library.

Designed to be reusable as a template, not tied to one person's setup:
Telegram, email, and Google Drive credentials are all entered from the web
UI (encrypted vault) rather than baked into `.env`, so anyone can clone this
repo, deploy it on their own box, and configure it entirely through the
browser.

---

## Why it exists

Running a stack of separate admin tools means separate logins, separate
visual styles, and memory spent on each one running its own server. This
panel does the same work in one process, and treats a home/self-hosted
server as a small platform rather than a pile of unrelated containers.

## Features

**Monitoring**
- Live CPU, memory, disk, temperature, network, and uptime read from host
  `/proc` and `/sys`
- Metric history with charts drawn on canvas, persisted across restarts
- Uptime checks — HTTP, TCP (any internal or external port), and **command
  checks** that `docker exec` into a container and treat a non-zero exit
  code as down, for catching an app that's "running" but actually wedged —
  with 24-hour and 7-day availability, response times, incident counts, and
  outage history
- **Resource-spike detection**: each container's CPU/RAM is compared against
  its own rolling baseline (not a fixed threshold, which is wrong for a
  database that's *supposed* to run hot); a sudden jump raises a notification
- **Network topology graph** for the Networks page — which containers sit on
  which Docker network, drawn as a small per-network diagram
- **Public status page** (`/status`, no login) — opt in per check; shows only
  name and up/down + uptime %, never the underlying URL or host
- Global search (`Ctrl/Cmd+K`) across stacks, containers, and database
  instances, filtered by what the signed-in user is actually allowed to see
- Notification centre with severity-tiered events; `urgent` ones go to
  Telegram, email, and push, `info` ones stay in the web UI only. Both the
  audit log and the notification history are pruned automatically (90 and
  30 days respectively) so they don't grow forever
- **Web Push** notifications straight to a phone or desktop for urgent
  events, even with the panel tab closed — no third-party push service,
  just VAPID keys generated and stored in the vault

**Deploy & apps**
- Deploy from a pasted Docker Compose file or a Git repository, with live
  build-log streaming over Server-Sent Events, branch switching, rollback to
  any commit, and webhook auto-deploy
- **Auto-deploy**: point it at a repo and it detects Next.js, Vite, CRA,
  static HTML, or generic Node, then generates the Dockerfile and compose
  file itself — no Dockerfile to write by hand
- **Auto-rollback**: if a deploy exits 0 but the container is crash-looping
  five seconds later (a bad env var or migration, say — not a build error),
  it rolls back to the previous commit automatically instead of leaving the
  app down
- **Canary deploy**: the new image is built and test-run in an isolated
  container first (no port published, doesn't touch live traffic at all); if
  it crashes, the deploy is aborted before the running app is ever touched.
  Proactive, unlike auto-rollback's after-the-fact recovery
- **Preview environments**: deploy any branch of a git-sourced stack as a
  fully separate stack (own containers, own port) to review it without
  touching what's live, auto-deleted after 7 days of inactivity
- **Deploy time windows**: restrict webhook auto-deploy to certain hours per
  stack — a push outside the window just pulls the code and queues the
  deploy for the next window, instead of rebuilding at 3 a.m. unattended
- A **setup wizard** walks through Telegram, email, and Google Drive setup
  right after the first account is created — nothing is required, everything
  can be configured later from Settings or Vault & Backups
- **Vulnerability scanning** (Trivy) for local images, on demand, with
  results cached for 12 hours — CVE ID, package, installed vs. fixed version
- Auto-deployed apps get a memory and CPU ceiling by default (the process
  gets OOM-killed and restarts on its own instead of taking the whole host
  down), sit behind a small nginx load balancer, and **autoscale**: a second
  replica comes up automatically when RAM gets close to the ceiling and
  traffic keeps flowing through the restart, then scales back down once
  things are quiet again
- Container management with live CPU/memory, and a **custom chart builder**
  per container (pick metric — memory, CPU, network in/out — and a time
  range from 30 minutes to 30 days)
- Combined log search across every running container at once, not just one
  at a time; each container's logs are also pruned automatically to the last
  3 days, independent of Docker's own size-based rotation
- **API tokens** so external scripts and CI can call the panel's API without
  a browser session — same permissions as the user who created the token
- **Multiple Docker hosts**: connect additional servers over SSH (not an
  unauthenticated exposed Docker API) from the Servers page, and see their
  container list and resource usage without leaving the panel

**Data**
- Code editor built on Monaco (the editor core from VS Code) with a file
  tree, tabs, autosave, full-text search, and an integrated terminal
- File manager that behaves like a general-purpose file host: previews
  images, PDFs, video, and audio inline; opens code/text files straight into
  the editor
- Database provisioning: create PostgreSQL, MariaDB, MongoDB, or Redis
  instances from the web, with generated credentials, connection strings,
  and a per-instance memory ceiling
- Table designer, row editor, SQL editor, query log, CSV/JSON/SQL export and
  import
- Per-database **Overview**: size, RAM vs. its limit, active connections, and
  real request traffic pulled from the engine's own statistics (not just
  queries run through the panel), plus a fleet-wide overview across every
  instance combined — both with the same custom chart builder as containers
- **Clone**: spin up a second instance seeded with a full copy of another
  one's schema and data, for staging changes before touching production
- **Automated monthly restore test**: every local database is actually
  cloned to a throwaway instance, every table's row count is compared
  against the source, and the throwaway instance is deleted — because a
  backup file that has never been restored is a guess, not a backup
- **Disaster-recovery snapshot** of the panel's own state (users, vault
  secrets, uptime checks, API tokens — not application data, which the
  regular backup already covers) so a dead disk doesn't mean starting over
  from a blank install; saved where the existing HDD/Google Drive backup
  already picks it up automatically

**Operations**
- Domains with automatic HTTPS through Caddy, or through a Cloudflare Tunnel
  when the host has no public IP or open ports — including tunnelling raw
  TCP (e.g. SSH) to a specific hostname
- Scheduler with per-run history
- Encrypted secrets vault (AES-256-GCM) that can inject into stack `.env`
  files, and doubles as storage for the panel's own OAuth credentials (see
  below)
- Local backups with one-click restore, plus a **Google Drive off-site
  backup**: connect one or more Google accounts through OAuth (right from
  the web UI — no CLI setup, no shared/rate-limited credentials), and the
  nightly backup automatically syncs to whichever connected account has the
  most headroom. A backup history view tracks size and data-written trends
  over time, and three failed runs in a row raises an urgent alert instead
  of getting lost among routine notifications
- **Disk analyzer**: a breakdown of what's actually using disk space across
  both the host filesystem and Docker's own storage (images, volumes, build
  cache), so "what's eating my disk" has an answer instead of a guess
- **Resource quota dashboard**: total RAM/CPU *allocated* across every
  container's limits vs. what the host actually has — a different question
  from current live usage, and the one that matters before adding one more
  container
- Image update checker: compares a running image's digest against what's
  currently published for the same tag, so a rebuilt upstream image (a
  security patch, say) doesn't go unnoticed just because the tag didn't
  change. Manual pull, never automatic.
- Automatic and manual Docker build-cache cleanup — this tends to be the
  single biggest hidden disk cost on a host that rebuilds images often
- Web terminal to the host or into any container
- systemd services, OS updates, firewall, and Linux user management

**AI assistant**
- An assistant scoped strictly to this server; it reads real state through
  tools and proposes fixes that a human must approve before they run

**Security**
- scrypt password hashing, TOTP two-factor authentication
- Rate limiting with automatic IP blocking
- Three roles: Super Admin (full), Admin (per-page grants), Viewer
  (read-only, enforced server-side — `SELECT` allowed, everything else
  refused)
- Audit log of every state-changing action
- When the panel sits behind a tunnel or reverse proxy, the visitor's real
  IP is only trusted when it arrives through a connection that's provably
  the tunnel's own — not just because a header claims it — so "signed in
  from a new device" and login-throttling can't be spoofed by anything that
  can merely reach the panel's LAN-facing port

## Requirements

- Docker and the Compose plugin
- A Linux host (systemd, UFW, and temperature readings need a real Linux
  kernel — they're unavailable running under Docker Desktop)

## Running it

```bash
git clone <this-repo> panel
cd panel
./scripts/fetch-monaco.sh      # pulls the editor component (12 MB, not vendored)
docker compose up -d --build
```

Then open `http://<server-ip>:8090`. The first screen creates the Super
Admin account.

A `docker-compose.yml` for the full stack (panel plus Caddy) lives in the
deployment bundle alongside `install-panel.sh`.

## Deploying to a server

The `deploy/` folder holds the full bundle: setup scripts, the compose file,
and `SETUP-PROMPT.md` — a briefing written for an AI agent doing the
install, covering the constraints and which decisions were deliberate.

```bash
git clone <this-repo> ~/panel
cd ~/panel && sudo bash deploy/scripts/PASANG-SEMUA.sh
```

### Optional configuration

Everything below has a sensible default and can be left unset. Most of it
can also be configured later from the web UI once the panel is running —
nothing here is required just to get started.

| Variable | Purpose |
|---|---|
| `TRUST_PROXY` | Set to `1` only if the panel sits behind a reverse proxy you control directly (not the Cloudflare Tunnel path below, which has its own mechanism). Otherwise leave unset — trusting the wrong header defeats login rate-limiting. |
| `TG_TOKEN`, `TG_CHAT` | Telegram bot token + chat ID for urgent notifications. Can also be set from the setup wizard or Settings in the web UI, which takes priority over these. |
| `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET` | OAuth client for the Google Drive backup feature. Can be set here as a default, or entered later from Vault & Backups in the web UI — the web UI value takes priority. Create the client at [console.cloud.google.com](https://console.cloud.google.com), enable the Drive API, and set the redirect URI to `https://<your-domain>/api/gdrive/oauth/callback`. |
| `TUNNEL_DOMAIN` | Base domain used for auto-registered subdomains and the Google Drive OAuth redirect URI, when deploying behind a Cloudflare Tunnel. |

Email (SMTP) notifications have no environment variable — they're configured
entirely from Settings or the setup wizard, since a mail server needs a host,
port, and credentials that don't have a sensible default to fall back on.

## Layout

```
src/
  server.js        HTTP routing, permission gate, SSE streams, WebSocket upgrade
  auth.js          users, roles, sessions, TOTP, rate limiting, audit log
  docker.js        Docker Engine client over the unix socket
  system.js        host metrics from /proc and /sys
  stacks.js        compose and git deployments, preview envs, canary deploy
  autodeploy.js     project detection, Dockerfile/compose generation, load balancer
  autoscale.js      RAM-based replica scaling for auto-deployed apps
  dbaas.js         database provisioning, query log, clone, export helpers
  dbapi.js         REST API generator in front of a provisioned database
  historyStore.js  shared two-tier (detail + hourly) metric history store
  gdrive.js        Google Drive OAuth, multi-account storage, off-site sync
  mailer.js        SMTP email notifications
  webpush.js       Web Push subscriptions and VAPID keys
  apiTokens.js     API tokens for external scripts/CI
  vulnScan.js      Trivy vulnerability scanning for local images
  logRetention.js  time-based pruning of container logs
  drSnapshot.js    disaster-recovery snapshot of the panel's own state
  hosts.js         multi-server: other Docker hosts over SSH
  registryCheck.js image update checks against a registry's manifest digest
  admin.js         systemd, apt, firewall, cron, vault, backups
  events.js        event catalogue and Telegram/email/push routing
  proxy.js         Caddyfile generation and certificate checks
  tunnel.js        Cloudflare Tunnel config generation
  ai.js            assistant with tool calling
public/
  app.js       shell, navigation, charts, shared helpers
  pages*.js    one file per feature area
  app.css      design tokens and components
deploy/
  SETUP-PROMPT.md   briefing for an agent performing the install
  install-panel.sh  builds and starts the stack
  scripts/          server hardening, Docker, alerts, backups
```

## Notes and limits

- The panel runs privileged and holds the Docker socket. That is required
  for container management, the host terminal, and power control — but it
  means anyone who reaches the panel controls the machine. Do not expose its
  port to the internet without 2FA enabled, and prefer a tunnel over a
  direct port-forward where possible.
- Docker publishes ports directly through iptables and bypasses UFW. Bind
  application ports to `127.0.0.1` unless they are meant to be public.
- systemd, apt, UFW, and temperature readings require a real Linux host and
  are unavailable when testing under Docker Desktop.
- The editor covers reading, writing, searching, and a terminal. It has no
  extension marketplace, debugger, or cross-file IntelliSense; use
  code-server if those matter more than memory.
- The image update checker only supports Docker Hub. Images from other
  registries are skipped rather than reported as errors.
- Autoscale adds replicas of the *same* app on the *same* host — it protects
  against one runaway process taking the whole machine down, but it cannot
  create RAM that isn't there. Traffic that genuinely exceeds one machine's
  capacity needs more machines, not more replicas of one.
- Multi-server is a read/inspect layer, not full remote management: it lists
  containers and shows resource stats for other Docker hosts over SSH.
  Deploying stacks, editing files, or opening a terminal on a remote host
  isn't wired up yet — those still target this panel's own host.
- Canary deploy and preview environments assume one main service per stack
  (the pattern this panel's own auto-deploy uses). A `docker-compose.yml`
  with a fixed host port and no free port to fall back to can still fail to
  come up side-by-side with the live version; the deploy log says so plainly
  when it happens rather than failing silently.

## Licence

Personal project. No warranty.
