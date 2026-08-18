# Proxmox setup brief — Asus K42F home server (self-use first, rent-out later)

You are running in the Proxmox host shell. Read this whole file before running
anything, then work through it in order. Explain each step before running it,
especially anything that resizes storage or restarts networking.

---

## 1. Context

**Hardware.** Asus K42F, Intel Core i3-370M (2 cores / 4 threads, 2.4 GHz),
8 GB DDR3 (maximum for this board), 960 GB SSD, 10/100 Ethernet.

**Hypervisor.** Proxmox VE is already installed on bare metal (not inside
Mint, not inside a VM).

**Owner's plan.** Right now, the owner is the only user. They want to use the
**entire machine** themselves for now. Later, if a friend wants to rent
space, the owner will shrink their own container's RAM and create a new LXC
for the renter — not the other way around. Design everything so that
shrinking later is a config edit, not a rebuild.

**Owner.** Speaks Indonesian informally. Explain destructive steps before
running them. Keep responses short.

---

## 2. Decisions already made — do not relitigate

- **LXC, not VMs**, for every workload. LXC shares the host kernel, so
  overhead per container is near zero — a VM would burn 300–500 MB on its own
  kernel that this machine cannot spare.
- **Debian 12** as the container OS. Lighter than Ubuntu, and it's what the
  Proxmox and community-scripts templates assume, which avoids friction if
  the owner uses community-scripts (community-scripts.org) later for
  auxiliary services.
- **Unprivileged containers**, with `nesting=1` (so Docker can run inside).
  Even though there's only one container today, use unprivileged from the
  start — converting a privileged container to unprivileged later means
  rebuilding it, converting an *empty RAM allocation* later does not.
- **One container for everything the owner runs today**, sized to nearly the
  whole machine. Do not pre-carve empty "future renter" containers — that
  wastes nothing today but adds complexity for no benefit; renter containers
  get created at the moment someone actually signs up.

---

## 3. RAM plan

Today (single container, owner uses everything):

```
Proxmox host        ~1.0 GB  (fixed cost, not reclaimable)
LXC 100 "main"       ~6.5 GB  (everything the owner runs)
                     ─────────
                      7.5 GB used, ~0.5 GB headroom
```

When the first renter signs up, shrink LXC 100 and add a container — no
reinstall, just editing `memory:` on 100 and creating 110:

```
Proxmox host        ~1.0 GB
LXC 100 "main"       ~2.5 GB   (owner — shrunk)
LXC 101 "proxy"      ~0.4 GB   (created at the same time, see step 6)
LXC 110 "renter-1"   ~1.5 GB   (new)
                     ─────────
                      5.4 GB used, ~2.6 GB headroom for a 2nd renter
```

Do not create LXC 101 (proxy) yet if the owner has no domain/tunnel set up.
It can be added later without touching LXC 100.

---

## 4. Order of work

### 4.1 Confirm the basics

```bash
pveversion
free -h
lsblk
curl -s ifconfig.me; echo
```

Compare the `ifconfig.me` output against the WAN IP shown in the router's
admin page (ask the owner to check). If they match, the owner has a public
IP and port-forwarding works; if not, they are behind CGNAT and will need
Cloudflare Tunnel later for anything they expose. Report this to the owner —
don't act on it yet, it only matters once they expose something.

### 4.2 Storage check

```bash
pvesm status
```

Confirm `local-lvm` (or whatever the default storage is) has enough free
space for a 400–500 GB rootfs on container 100. This machine has 960 GB, so
it should be plentiful — just confirm, don't resize anything yet.

### 4.3 Download the Debian 12 LXC template

```bash
pveam update
pveam available | grep debian-12
pveam download local debian-12-standard_12.*_amd64.tar.zst
```

### 4.4 Create LXC 100 ("main") — sized to nearly the whole machine

```bash
pct create 100 local:vztmpl/debian-12-standard_12.*_amd64.tar.zst \
  --hostname main \
  --cores 3 \
  --memory 6656 \
  --swap 1024 \
  --rootfs local-lvm:400 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1
```

Notes for the values chosen:

- `--cores 3` — leaves 1 thread free for the Proxmox host itself; a fully
  starved host becomes unreachable even from its own console.
- `--memory 6656` (6.5 GB) — leaves ~1 GB for the host, per the RAM plan in
  section 3. Do not raise this to consume literally all 8 GB; the host needs
  headroom or it will start swapping under any load at all.
  --swap 1024` gives Debian inside the container a safety net if something
  spikes.
- `--rootfs local-lvm:400` — generous but leaves >500 GB free on the 960 GB
  SSD for later containers and backups. Resizing an LXC rootfs up later is
  easy (`pct resize`); resizing down is not — so don't overallocate further
  than this.
- `--unprivileged 1 --features nesting=1` — required so Docker works inside
  without weakening host isolation.
- `--onboot 1` — the container must come back after a power cut with no one
  present to start it manually.

Start it and confirm:

```bash
pct start 100
pct enter 100
```

Inside the container, confirm it's alive and has network:

```bash
apt update && apt -y upgrade
apt -y install curl ca-certificates gnupg
ping -c3 deb.debian.org
```

### 4.5 Install Docker inside LXC 100

Standard Docker CE install (Debian, not Ubuntu, so no codename translation
needed here — that trap was Mint-specific, not relevant on Debian):

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

Cap container log size (without this, logs quietly fill the disk over
months) — add to `/etc/docker/daemon.json`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

```bash
systemctl restart docker
docker run hello-world
```

### 4.6 Deploy the owner's panel inside LXC 100

The panel repo is private on GitHub: `Ahnafprojects/homeserver-panel`. Inside
LXC 100:

```bash
apt -y install git
git clone https://github.com/Ahnafprojects/homeserver-panel ~/panel
cd ~/panel
./scripts/fetch-monaco.sh
sudo bash deploy/scripts/PASANG-SEMUA.sh
```

That deploy bundle already assumes a real Linux host with systemd, apt, and
Docker — all true here — but was written against a Mint desktop install, so
two things differ and should be skipped or adjusted:

- **Skip anything about disabling Xfce's power manager or lid handling.**
  There is no desktop here. Only the systemd-logind layer applies, and inside
  an LXC container, power/lid events belong to the Proxmox *host*, not this
  container — don't try to configure suspend behavior inside LXC 100 at all.
- **Skip the UFW steps if `setup-server.sh` tries to enable a firewall
  inside the container.** Filtering belongs on the Proxmox host or the LXC's
  `net0` firewall config, not duplicated inside an unprivileged container
  that may not have the right capabilities for iptables. If it fails, that's
  expected — move on.

Everything else (Docker install already done above, panel build, Super Admin
account creation on first load) proceeds as usual. The panel answers at
`http://<container-ip>:8090`.

### 4.7 Host-level housekeeping (Proxmox itself, not inside any container)

```bash
# Lid handling belongs to the HOST since Proxmox owns the physical hardware
sed -i 's/^HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf 2>/dev/null \
  || echo -e "\n[Login]\nHandleLidSwitch=ignore" >> /etc/systemd/logind.conf
systemctl restart systemd-logind
```

Set up a backup job (host-level `vzdump`, not something inside the
container):

```
Datacenter → Backup → Add
  Storage: local (or an attached USB drive once one exists)
  Schedule: sun 03:00
  Mode: snapshot
  Retention: keep-last 3
  Selection: VM ID 100
```

Verify the lid setting by asking the owner to close the laptop lid for a
minute and confirm the panel is still reachable.

---

## 5. Things intentionally NOT done yet — do not add speculatively

- **No second container.** No renter exists yet. Do not pre-create "renter"
  containers, users, or Proxmox pools — that's step 6, done only when a
  friend actually signs up.
- **No Cloudflare Tunnel, no reverse proxy container (LXC 101).** Only
  needed once something needs to be reachable from outside the LAN. Setting
  it up now with nothing to expose is wasted complexity.
- **No CPU/network rate limits on LXC 100.** Limits exist to protect
  *other* tenants sharing the box. There are none yet — the owner is using
  their own machine. Add `cpuunits`/`net0 rate=` only when LXC 110 (or later)
  is created.
- **No LVM/disk encryption.** Same reasoning as the original Mint plan: a
  headless server cannot have a passphrase typed at every boot.

---

## 6. When a friend actually wants to rent — do this later, not now

This section is for a future run, once someone has actually agreed to pay or
the owner has decided to give a friend space. Do not run this yet.

1. Shrink LXC 100:
   ```bash
   pct set 100 --memory 2560 --cores 2
   ```
2. Create the renter's container, cloned from a template made from LXC 100's
   Docker setup (or freshly created the same way as 4.4, with
   `--memory 1536 --cores 1`), plus:
   ```bash
   pct set 110 --net0 name=eth0,bridge=vmbr0,ip=dhcp,rate=12
   pct set 110 --cpuunits 100
   ```
3. Create a Proxmox pool for the renter, add container 110 to it, create a
   PVE-realm user for them, and grant `PVEVMUser` scoped to that pool only —
   so they can start/stop/console their own container and see nothing else.
4. Only now consider LXC 101 (reverse proxy / Cloudflare Tunnel) if the
   renter's service needs to be reachable from outside the LAN.

---

## 7. Known-good verification

After 4.1–4.7:

```bash
pct status 100                                    # running
pct exec 100 -- docker compose -C /root/panel ps  # panel + caddy up
curl -s -o /dev/null -w '%{http_code}\n' http://<container-ip>:8090   # 200
free -h                                           # host has ~1 GB free, not 0
systemctl status systemd-logind                   # active
```

## 8. How to work with this owner

They move fast, dislike long explanations, and are currently deciding
whether to rent this machine out at all — treat that as still undecided.
Report what actually happened after each step, not what should have
happened. If a step fails, show the real error.
