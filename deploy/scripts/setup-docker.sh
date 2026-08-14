#!/usr/bin/env bash
#
# setup-docker.sh — Docker + Portainer + penyimpanan data pribadi (Samba)
#
# Jalankan SETELAH setup-server.sh:
#   sudo bash setup-docker.sh
#
# Aman dijalankan berulang kali (idempotent).
#

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Butuh root. Jalankan: sudo bash $0" >&2
    exit 1
fi

REAL_USER=${SUDO_USER:-$(logname 2>/dev/null || echo "")}
if [[ -z "$REAL_USER" || "$REAL_USER" == "root" ]]; then
    echo "Jalankan pakai 'sudo bash $0' dari user biasa, bukan login root." >&2
    exit 1
fi

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$1"; }

DATA_DIR=/srv/data
STACK_DIR=/srv/stacks

# ---------------------------------------------------------------------------
say "1/6  Pasang Docker CE (repo resmi Docker)"
# ---------------------------------------------------------------------------
# CATATAN PENTING soal Linux Mint:
# Repo Docker tidak punya baris untuk codename Mint (mis. "zena"). Yang harus
# dipakai adalah codename Ubuntu di bawahnya (Mint 22.x -> "noble").
# Pakai `lsb_release -cs` di Mint akan menghasilkan repo yang tidak ada
# dan apt akan error 404. Ini penyebab paling umum gagal install Docker di Mint.
. /etc/os-release
CODENAME=${UBUNTU_CODENAME:-noble}
echo "    codename Ubuntu terdeteksi: $CODENAME"

if ! command -v docker &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable
EOF
    apt-get update -qq
    apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    echo "    Docker CE terpasang"
else
    echo "    Docker sudah ada, dilewati"
fi

systemctl enable --now docker
usermod -aG docker "$REAL_USER"
echo "    user '$REAL_USER' dimasukkan ke grup docker"
warn "Perlu LOGOUT-LOGIN (atau reboot) sebelum bisa 'docker' tanpa sudo."

# Batasi ukuran log container — kalau tidak, log bisa memakan SSD lu
# sampai penuh tanpa terasa. Ini sering kejadian di server yang lama nyala.
mkdir -p /etc/docker
if [[ ! -f /etc/docker/daemon.json ]]; then
    cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
    systemctl restart docker
    echo "    rotasi log Docker dibatasi (maks 30 MB per container)"
fi

# ---------------------------------------------------------------------------
say "2/6  Struktur folder"
# ---------------------------------------------------------------------------
mkdir -p "$DATA_DIR" "$STACK_DIR"
chown -R "$REAL_USER":"$REAL_USER" "$DATA_DIR" "$STACK_DIR"
chmod 750 "$DATA_DIR"
echo "    $DATA_DIR   -> data pribadi lu"
echo "    $STACK_DIR -> file docker-compose.yml per project"

# ---------------------------------------------------------------------------
say "3/6  Portainer — panel web buat kelola container"
# ---------------------------------------------------------------------------
if ! docker ps -a --format '{{.Names}}' | grep -qx portainer; then
    docker volume create portainer_data >/dev/null
    docker run -d \
        --name portainer \
        --restart=always \
        -p 9443:9443 \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v portainer_data:/data \
        portainer/portainer-ce:latest >/dev/null
    echo "    Portainer jalan di port 9443 (HTTPS)"
else
    echo "    Portainer sudah ada, dilewati"
fi

# ---------------------------------------------------------------------------
say "4/6  Samba — akses data pribadi dari Finder macOS"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq samba samba-common-bin

if ! grep -q "^\[data\]" /etc/samba/smb.conf 2>/dev/null; then
    cp /etc/samba/smb.conf "/etc/samba/smb.conf.bak-$(date +%Y%m%d-%H%M%S)"
    cat >> /etc/samba/smb.conf <<EOF

[data]
   comment = Data pribadi
   path = $DATA_DIR
   browseable = yes
   read only = no
   valid users = $REAL_USER
   create mask = 0660
   directory mask = 0770
   # vfs fruit = kompatibilitas macOS (metadata, Time Machine, ikon)
   vfs objects = catia fruit streams_xattr
   fruit:metadata = stream
   fruit:posix_rename = yes
EOF
    echo "    share [data] ditambahkan (backup smb.conf dibuat)"
else
    echo "    share [data] sudah ada, dilewati"
fi

systemctl enable --now smbd nmbd >/dev/null 2>&1 || true
systemctl restart smbd
echo "    Samba jalan"
warn "Password Samba TERPISAH dari password login. Set sekarang dengan:"
warn "    sudo smbpasswd -a $REAL_USER"

# ---------------------------------------------------------------------------
say "5/6  Firewall"
# ---------------------------------------------------------------------------
ufw allow 9443/tcp >/dev/null   # Portainer
ufw allow Samba    >/dev/null 2>&1 || ufw allow 445/tcp >/dev/null
echo "    port 9443 (Portainer) + 445 (Samba) dibuka"

# ---------------------------------------------------------------------------
say "6/6  Contoh stack"
# ---------------------------------------------------------------------------
if [[ ! -f "$STACK_DIR/contoh-backend/docker-compose.yml" ]]; then
    mkdir -p "$STACK_DIR/contoh-backend"
    cat > "$STACK_DIR/contoh-backend/docker-compose.yml" <<'EOF'
# Contoh stack backend: Postgres + Redis
#
# Jalankan:  cd /srv/stacks/contoh-backend && docker compose up -d
# Matikan:   docker compose down
#
# Perhatikan format port "127.0.0.1:5432:5432" — itu artinya database
# HANYA bisa diakses dari dalam server itu sendiri, tidak dari jaringan.
# Ini disengaja. Baca peringatan soal Docker + UFW di bawah.

services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ganti-password-ini
      POSTGRES_DB: appdb
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"

  cache:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "127.0.0.1:6379:6379"

volumes:
  pgdata:
EOF
    chown -R "$REAL_USER":"$REAL_USER" "$STACK_DIR/contoh-backend"
    echo "    contoh di $STACK_DIR/contoh-backend/docker-compose.yml"
fi

# ---------------------------------------------------------------------------
say "SELESAI"
# ---------------------------------------------------------------------------
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "  Portainer : https://${IP:-<ip>}:9443"
echo "              (browser bilang 'not private' -> normal, sertifikat"
echo "               self-signed. Klik Advanced > Proceed.)"
echo "              Bikin akun admin dalam 5 MENIT pertama, kalau lewat"
echo "              Portainer mengunci diri dan containernya harus direstart."
echo
echo "  Samba     : dari Finder tekan Cmd+K, lalu ketik"
echo "              smb://${IP:-<ip>}/data"
echo
echo "  Data      : $DATA_DIR"
echo "  Stacks    : $STACK_DIR"
echo
warn "PENTING — Docker MENEMBUS firewall UFW."
echo "  Kalau lu tulis ports: \"5432:5432\", port itu terbuka ke seluruh"
echo "  jaringan MESKIPUN UFW memblokirnya. Docker menulis aturan iptables"
echo "  sendiri di bawah UFW. Ini bukan bug, tapi banyak orang tidak sadar"
echo "  dan tanpa sengaja mengekspos database tanpa password ke internet."
echo
echo "  Kebiasaan yang aman: selalu ikat ke localhost."
echo "      ports: [\"127.0.0.1:5432:5432\"]   <- aman"
echo "      ports: [\"5432:5432\"]             <- terbuka ke jaringan"
echo
echo "  Yang boleh terbuka hanya reverse proxy (port 80/443)."
echo
warn "BACKUP — $DATA_DIR ada di SATU SSD. RAID/server bukan backup."
echo "  SSD mati = data hilang. Minimal salin berkala ke disk lain:"
echo "      rsync -av --delete $DATA_DIR/ /media/$REAL_USER/<disk-backup>/data/"
echo
