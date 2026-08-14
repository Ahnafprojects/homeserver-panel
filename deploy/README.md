# Deployment bundle

Everything needed to turn a fresh Linux Mint install into the home server.

## If you are an AI agent running on the server

Read **`SETUP-PROMPT.md`** first. It carries the context, the constraints, the
order of work, and the decisions that were made deliberately and should not be
undone.

## If you are a human

```bash
git clone https://github.com/Ahnafprojects/homeserver-panel ~/panel
cd ~/panel
./scripts/fetch-monaco.sh          # editor component, 12 MB, not vendored
sudo bash deploy/scripts/PASANG-SEMUA.sh
```

That runs the whole sequence. To go step by step instead:

| Order | Script | What it does | Time |
|---|---|---|---|
| 1 | `scripts/setup-server.sh` | Disable sleep, SSH, UFW, auto-updates, sensors | 10 min |
| 2 | `scripts/setup-docker.sh` | Docker CE from the official repo | 5 min |
| — | *reboot* | So the user picks up the `docker` group | — |
| 3 | `install-panel.sh` | Build and start the panel | 8–15 min |
| 4 | `scripts/setup-alerts.sh` | Telegram notifications | 5 min |
| 5 | `scripts/setup-backup.sh` | Scheduled backups to a USB drive | 5 min |

The panel then answers on `http://<server-ip>:8090`. The first screen creates
the Super Admin account.

## Files

| File | Purpose |
|---|---|
| `SETUP-PROMPT.md` | Briefing for an AI agent doing the setup |
| `install-panel.sh` | Builds and starts the panel stack |
| `docker-compose.yml` | Panel plus Caddy |
| `scripts/PASANG-SEMUA.sh` | Runs every stage in order |
| `scripts/setup-server.sh` | Turns a desktop install into a server |
| `scripts/setup-docker.sh` | Docker, with the Mint codename fix |
| `scripts/setup-alerts.sh` | Telegram alerting |
| `scripts/setup-backup.sh` | Snapshot backups to an ext4 USB drive |
| `scripts/BACA-DULU.md` | Indonesian quick-start for the owner |

Every script is idempotent and backs up any system file it edits.

## Two things that bite people here

**Docker's apt repository has no line for Mint's codename.** Use the Ubuntu
codename underneath — `UBUNTU_CODENAME` from `/etc/os-release`, which is
`noble` on Mint 22.x. Anything using `lsb_release -cs` fails with a 404.

**Disabling sleep takes two layers.** A systemd logind drop-in alone is not
enough, because Xfce's power manager overrides it once a desktop session
starts. `setup-server.sh` handles both and then masks the sleep targets.
Verify with `systemctl status sleep.target` — it must say `masked`.

## Before exposing anything

The panel runs privileged and holds the Docker socket, which it needs for
container management, the host terminal, and power control. That also means
whoever reaches the panel controls the machine.

Enable 2FA before the panel is reachable from anywhere but the local network,
and leave `TRUST_PROXY=0` unless a reverse proxy you control sits in front of
it — otherwise `X-Forwarded-For` can be forged and login throttling stops
working.
