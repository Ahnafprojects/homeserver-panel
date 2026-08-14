#!/usr/bin/env bash
#
# install-panel.sh — pasang Home Server Panel di Linux Mint
#
#   sudo bash install-panel.sh
#
# Dijalankan SETELAH setup-server.sh dan setup-docker.sh.
# Aman dijalankan berulang kali.
#

set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "Butuh root: sudo bash $0" >&2; exit 1; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REAL_USER=${SUDO_USER:-$(logname 2>/dev/null || echo root)}
IP=$(hostname -I 2>/dev/null | awk '{print $1}')

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
say "1/6  Periksa prasyarat"
# ---------------------------------------------------------------------------
command -v docker >/dev/null || { echo "Docker belum ada. Jalankan setup-docker.sh dulu." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Plugin docker compose tidak ada." >&2; exit 1; }
systemctl is-active --quiet docker || systemctl start docker
echo "    Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) siap"

# ---------------------------------------------------------------------------
say "2/6  Siapkan folder"
# ---------------------------------------------------------------------------
for d in /srv/data /srv/panel-state /srv/stacks /srv/backup /srv/caddy; do
    mkdir -p "$d"
done
chown -R "$REAL_USER":"$REAL_USER" /srv/data /srv/stacks
chmod 700 /srv/panel-state          # berisi kredensial & kunci brankas
# Caddyfile kosong supaya Caddy mau start sebelum ada domain.
[[ -f /srv/caddy/Caddyfile ]] || cat > /srv/caddy/Caddyfile <<'CADDY'
# Dihasilkan otomatis oleh panel. Jangan diubah manual.
{
	# email admin diisi lewat halaman Domains
}
CADDY
echo "    /srv/{data,panel-state,stacks,backup,caddy}"

# ---------------------------------------------------------------------------
say "3/6  Salin berkas panel"
# ---------------------------------------------------------------------------
APP=/opt/homeserver-panel
REPO="$(cd "$HERE/.." && pwd)"
# Monaco (inti Code Editor) sengaja tidak ikut di repo (12 MB, kode pihak
# ketiga) — tanpa ini, Code Editor stuck di "Loading editor..." selamanya
# dan tidak ada error yang kelihatan di mana pun.
if [[ ! -d "$REPO/public/vendor/monaco" ]]; then
    echo "    mengunduh Monaco editor (~13 MB, sekali saja)..."
    bash "$REPO/scripts/fetch-monaco.sh" || warn "Gagal unduh Monaco — Code Editor tidak akan berfungsi. Coba manual: bash $REPO/scripts/fetch-monaco.sh"
fi
mkdir -p "$APP/panel"
cp "$REPO/Dockerfile" "$REPO/package.json" "$APP/panel/"
cp -r "$REPO/src" "$REPO/public" "$APP/panel/"
cp "$HERE/docker-compose.yml" "$APP/docker-compose.yml"
echo "    terpasang di $APP"

# ---------------------------------------------------------------------------
say "4/6  Jaringan bersama"
# ---------------------------------------------------------------------------
docker network inspect apps >/dev/null 2>&1 || docker network create apps >/dev/null
echo "    jaringan 'apps' siap"

# ---------------------------------------------------------------------------
say "5/6  Bangun & jalankan"
# ---------------------------------------------------------------------------
warn "Build pertama di CPU i3 memakan 8-15 menit. Ini normal."
cd "$APP"
if docker compose up -d --build 2>&1 | tail -20; then
    echo "    stack berjalan"
else
    echo "Gagal. Periksa pesan di atas." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
say "6/6  Firewall & pemeriksaan"
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null; then
    ufw allow 8090/tcp >/dev/null 2>&1 || true
    ufw allow 80/tcp   >/dev/null 2>&1 || true
    ufw allow 443/tcp  >/dev/null 2>&1 || true
    echo "    port 8090, 80, 443 dibuka"
fi

echo "    menunggu panel siap..."
for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8090/ || echo 000)
    [[ "$code" == "200" ]] && break
    sleep 2
done

cat <<EOF

============================================================
  PANEL SIAP
============================================================

  Buka dari MacBook atau HP di jaringan yang sama:

      http://${IP:-<ip-server>}:8090

  Layar pertama akan meminta kamu membuat akun Super Admin.
  Gunakan kata sandi yang kuat — akun ini memegang seluruh server.

  LANGKAH SETELAH MASUK

    1. Settings -> Two-factor authentication -> Enable 2FA
    2. Vault -> tambahkan rahasia GROQ_API_KEY  (untuk Assistant)
    3. Settings -> Alert thresholds -> sesuaikan bila perlu
    4. Uptime -> Add check -> pantau layanan pentingmu
    5. Scheduler -> buat tugas backup harian

  PERINTAH BERGUNA

    cd $APP
    docker compose logs -f panel     # lihat log panel
    docker compose restart panel     # restart panel
    docker compose up -d --build     # pasang versi baru
    docker compose down              # matikan panel

  CATATAN KEAMANAN

    Panel berjalan privileged dan memegang soket Docker. Itu memang
    diperlukan untuk mengelola container, terminal host, dan daya —
    tapi artinya siapa pun yang masuk ke panel menguasai server ini.
    Jangan pernah membuka port 8090 ke internet tanpa 2FA menyala.

EOF
