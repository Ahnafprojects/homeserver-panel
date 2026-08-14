# Server setup brief — Asus K42F home server

You are running on the machine being configured. Read this whole file before
running anything, then work through it in order.

---

## 1. Context you need

**Hardware.** Asus K42F laptop, 2010. Intel Core i3-370M — 2 cores / 4 threads,
2.4 GHz. 8 GB DDR3, which is the maximum this board accepts. A 960 GB SSD.
Ethernet is **10/100 only**, so file transfer tops out near 12 MB/s. WiFi is
b/g/n. Graphics are Intel Ironlake (first-generation HD), which is why the OS
choice matters — see below.

**Operating system.** Linux Mint 22.3 Xfce, freshly installed, based on
Ubuntu 24.04 LTS with support until April 2029. It was chosen over Mint 23
deliberately: 22.3 still uses X11, and Wayland is unreliable on Ironlake
graphics.

**Goal.** This laptop becomes a home server that runs 24/7, managed entirely
through a web panel from the owner's MacBook and phone. It will host backend
applications in Docker, databases, and personal files.

**Owner.** Speaks Indonesian. Prefers Indonesian in conversation, but the
panel's interface is English. Explain what you are about to do before doing
it, especially anything destructive.

---

## 2. Constraints that shape every decision

**The CPU is slow and cannot be changed.** A Node.js Docker build takes 4–8
minutes here; .NET takes 10–18. That is expected, not a fault. Never "fix"
slowness by disabling safety features.

**RAM is capped at 8 GB.** The panel itself uses about 20 MB. Keep it that way:
do not add heavyweight tooling when a lighter path exists.

**This is a laptop, so the lid is a hazard.** Closing it must not suspend the
machine. This is handled by `setup-server.sh` and must be verified afterwards.

**Thermals are the real risk.** A 15-year-old heatsink is usually clogged.
If the owner has not cleaned the fan and replaced the thermal paste yet, say so
plainly once, then continue — it is their call, not a blocker.

---

## 3. Order of work

Run these in sequence. Each depends on the one before it.

### 3.1 Confirm the basics

```bash
lsb_release -d                    # expect Linux Mint 22.3
free -h                           # expect ~7.7 Gi total
lsblk -d -o NAME,SIZE,ROTA        # ROTA=0 means SSD
ip -o -4 addr show | grep -v ' lo '
ping -c3 deb.debian.org           # internet is required for everything below
```

Report the IP address to the owner — they need it to reach the panel.

### 3.2 Make it behave like a server

Run `setup-server.sh` from the transfer drive.

It disables sleep in **two layers** — a systemd logind drop-in plus the Xfce
power manager — and then masks the sleep targets outright. Both layers are
needed: Xfce's own power daemon overrides systemd once a desktop session
starts, which is the usual reason "I disabled sleep but it still slept".

It also installs and enables SSH, turns on UFW (opening the SSH port *before*
enabling the firewall, so a remote session is not cut), enables unattended
security upgrades, and installs `lm-sensors` and `htop`.

Verify afterwards:

```bash
systemctl status sleep.target     # must say: masked
sudo ufw status                   # must be active with OpenSSH allowed
sensors                           # note the idle temperature
```

Then ask the owner to close the lid for a minute and confirm they can still
reach the machine over SSH. Do not skip this check; it is the whole point.

### 3.3 Install Docker

Run `setup-docker.sh`.

**The Mint-specific trap:** Docker's apt repository has no line for Mint's
codename. The Ubuntu codename underneath must be used instead — read
`UBUNTU_CODENAME` from `/etc/os-release`, which is `noble` for Mint 22.x.
Any tutorial using `lsb_release -cs` fails here with a 404. The script already
handles this; do not "fix" it back.

The script also caps container log size. Without that, logs quietly fill the
SSD over months.

**A reboot is required** afterwards so the owner's user picks up the `docker`
group. Tell them, then reboot.

### 3.4 Install the panel

Run `install-panel.sh`.

It creates `/srv/{data,panel-state,stacks,backup,caddy}`, copies the panel to
`/opt/homeserver-panel`, creates the shared `apps` Docker network, and brings
up the stack with `docker compose up -d --build`.

**The first build takes 8–15 minutes on this CPU.** Warn the owner before
starting so they do not think it has hung. Do not interrupt it.

When it finishes, the panel is at `http://<ip>:8090`. The first screen creates
the Super Admin account. Let the owner type their own password — do not invent
one for them, and do not put it in a file.

### 3.5 First-run configuration

Walk the owner through these, in this order:

1. **Enable 2FA** — Settings → Two-factor authentication. Do this before
   anything else. The panel holds the Docker socket and runs privileged;
   whoever reaches it controls the machine.
2. **Telegram alerts** — run `setup-alerts.sh`. They must message their new
   bot once before it can message them; Telegram blocks bots from speaking
   first. This trips up almost everyone.
3. **Groq key for the AI assistant** — Vault → Add secret → `GROQ_API_KEY`.
   The previous key was exposed in a chat transcript and must be replaced at
   console.groq.com.
4. **Static IP** — do this in the router as a DHCP reservation against the
   MAC address, not by configuring a static address on the server. A static
   address set here can collide with the router's pool.
5. **Backups** — `setup-backup.sh`, then a scheduled job in the panel.

---

## 4. Things that are already decided — do not undo them

**No disk encryption.** A headless server cannot have someone type a passphrase
at every boot.

**Automatic login is on.** Same reason: the machine must come back on its own
after a power cut.

**`TRUST_PROXY=0`.** Only set it to 1 if the panel genuinely sits behind a
reverse proxy the owner controls. Otherwise anyone can forge `X-Forwarded-For`
and defeat login throttling entirely.

**Database ports are never published to the LAN.** They bind to `127.0.0.1`
and are reached through an SSH tunnel. This differs from hosted services on
purpose.

**Docker bypasses UFW.** A container publishing `5432:5432` is reachable from
the whole network even with a firewall rule denying it, because Docker writes
its own iptables rules underneath. Always bind to `127.0.0.1` unless the port
is genuinely meant to be public. Only the reverse proxy should be open.

---

## 5. The panel, in brief

One Node.js application, about 20 MB of RAM, two npm dependencies. It replaces
Portainer, phpMyAdmin, an uptime monitor, a file manager, a code editor, and a
system dashboard.

WebSocket framing, TOTP, scrypt hashing, the cron parser, the Docker client,
CSV parsing, and the charts are all written against Node's standard library
rather than pulled in as packages. Keep it that way.

Pages: Overview, Notifications, Uptime, AI Assistant, Stacks & Deploy,
Containers, Logs, Code Editor, Files, Databases, Domains & SSL, Scheduler,
Vault & Backups, Terminal, Resources, System, Settings.

**Roles.** Super Admin has everything. Admin gets only the ticked pages and may
change things there. Viewer gets only the ticked pages and may not change
anything — enforced server-side, not merely hidden in the interface.

Source: `github.com/Ahnafprojects/homeserver-panel` (private).

---

## 6. Known-good verification

After everything is up:

```bash
cd /opt/homeserver-panel && docker compose ps      # panel and caddy running
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090   # expect 200
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
sensors                                            # idle should be under 60 °C
systemctl status sleep.target                      # masked
free -h                                            # swap should exist
```

Features that need a real Linux host and were never testable during
development — systemd service control, apt updates, UFW management,
temperature readings, the host terminal, and power control — **are being
exercised for the first time on this machine.** Test each one through the
panel and report anything that misbehaves rather than assuming it works.

---

## 7. How to work with this owner

They move fast and dislike long explanations, but they do read warnings that
have a concrete consequence attached. Lead with what you are about to do, do
it, then say what actually happened.

If something fails, show the real error rather than paraphrasing it. If a fix
is uncertain, say which part you are unsure about.

Two things they have been told repeatedly and may still skip — mention each at
most once more, then let it go:

- Clean the fan and replace the thermal paste before running 24/7.
- Rotate the Groq API key that was exposed.
