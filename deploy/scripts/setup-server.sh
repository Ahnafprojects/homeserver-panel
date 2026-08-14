#!/usr/bin/env bash
#
# setup-server.sh — ubah Linux Mint 22.3 XFCE jadi home server 24/7
#
# Cara pakai (di laptop server, SETELAH Mint terinstall):
#   sudo bash setup-server.sh
#
# Aman dijalankan berulang kali (idempotent). Semua file yang diubah
# dibackup dulu ke *.bak-<tanggal>.
#

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Script ini butuh root. Jalankan: sudo bash $0" >&2
    exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
REAL_USER=${SUDO_USER:-$(logname 2>/dev/null || echo root)}

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
say "1/7  Matikan sleep & suspend (lapis systemd)"
# ---------------------------------------------------------------------------
# Pakai drop-in dir, bukan edit logind.conf langsung — lebih bersih dan
# gak bentrok waktu paket systemd diupdate.
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/99-server.conf <<'EOF'
# Laptop dipakai sebagai server: tutup layar tidak boleh mematikan mesin.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchDocked=ignore
HandleLidSwitchExternalPower=ignore
HandleSuspendKey=ignore
IdleAction=ignore
EOF
echo "    /etc/systemd/logind.conf.d/99-server.conf dibuat"

# Kunci total di level target systemd — bikin suspend mustahil,
# bahkan kalau ada aplikasi yang memintanya.
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target \
    >/dev/null 2>&1 || true
echo "    sleep/suspend/hibernate target di-mask"

systemctl restart systemd-logind
echo "    systemd-logind direstart"

# ---------------------------------------------------------------------------
say "2/7  Matikan power management XFCE (lapis desktop)"
# ---------------------------------------------------------------------------
# XFCE punya daemon power sendiri yang bisa menimpa setelan systemd
# saat user login ke desktop. Ini dimatikan lewat xfconf milik user.
if id "$REAL_USER" &>/dev/null && [[ "$REAL_USER" != "root" ]]; then
    run_as_user() { sudo -u "$REAL_USER" DISPLAY=:0 "$@" 2>/dev/null || true; }
    for prop in inactivity-on-ac inactivity-on-battery; do
        run_as_user xfconf-query -c xfce4-power-manager \
            -p "/xfce4-power-manager/$prop" -n -t int -s 0
    done
    for prop in lid-action-on-ac lid-action-on-battery; do
        run_as_user xfconf-query -c xfce4-power-manager \
            -p "/xfce4-power-manager/$prop" -n -t int -s 0
    done
    run_as_user xfconf-query -c xfce4-power-manager \
        -p /xfce4-power-manager/dpms-enabled -n -t bool -s false
    run_as_user xfconf-query -c xfce4-session \
        -p /startup/ssh-agent/enabled -n -t bool -s true
    echo "    setelan xfce4-power-manager untuk user '$REAL_USER' dinolkan"
    warn "Kalau nanti masih sleep, cek manual: Menu > Settings > Power Manager"
else
    warn "Tidak ketemu user desktop — lewati langkah XFCE."
    warn "Jalankan ulang script ini sebagai user biasa pakai sudo, bukan login root."
fi

# Cegah layar blank (hemat backlight, bukan soal daya CPU)
if [[ -d /etc/X11/xorg.conf.d ]] || mkdir -p /etc/X11/xorg.conf.d; then
    cat > /etc/X11/xorg.conf.d/10-noblank.conf <<'EOF'
Section "ServerFlags"
    Option "BlankTime"   "0"
    Option "StandbyTime" "0"
    Option "SuspendTime" "0"
    Option "OffTime"     "0"
EndSection
EOF
    echo "    screen blanking dimatikan"
fi

# ---------------------------------------------------------------------------
say "3/7  Update sistem & pasang paket server"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    openssh-server \
    unattended-upgrades \
    ufw \
    htop \
    lm-sensors \
    curl \
    git \
    net-tools \
    ca-certificates
echo "    paket inti terpasang"

# ---------------------------------------------------------------------------
say "4/7  Aktifkan SSH"
# ---------------------------------------------------------------------------
systemctl enable --now ssh
# Pengerasan ringan: matikan login root langsung via SSH.
SSHD=/etc/ssh/sshd_config
if ! grep -qE '^\s*PermitRootLogin\s+no' "$SSHD"; then
    cp "$SSHD" "$SSHD.bak-$STAMP"
    if grep -qE '^\s*#?\s*PermitRootLogin' "$SSHD"; then
        sed -i 's/^\s*#\?\s*PermitRootLogin.*/PermitRootLogin no/' "$SSHD"
    else
        echo 'PermitRootLogin no' >> "$SSHD"
    fi
    echo "    PermitRootLogin dimatikan (backup: $SSHD.bak-$STAMP)"
fi
systemctl restart ssh
echo "    SSH aktif dan jalan saat boot"

# ---------------------------------------------------------------------------
say "5/7  Firewall (UFW)"
# ---------------------------------------------------------------------------
# PENTING: allow SSH dilakukan SEBELUM enable, biar sesi remote tidak terputus.
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
echo "    UFW aktif, port SSH (22) diizinkan"
warn "Nanti kalau pasang service lain, buka portnya manual. Contoh:"
warn "  sudo ufw allow 80/tcp     # web server"
warn "  sudo ufw allow 9090/tcp   # Cockpit"

# ---------------------------------------------------------------------------
say "6/7  Update keamanan otomatis"
# ---------------------------------------------------------------------------
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
echo "    unattended-upgrades aktif"

# ---------------------------------------------------------------------------
say "7/7  Sensor suhu"
# ---------------------------------------------------------------------------
# Laptop 2010 rawan panas kalau nyala 24/7 — ini biar suhunya bisa dipantau.
yes | sensors-detect --auto >/dev/null 2>&1 || true
echo "    lm-sensors dikonfigurasi. Cek suhu dengan: sensors"

# ---------------------------------------------------------------------------
say "SELESAI — ringkasan"
# ---------------------------------------------------------------------------
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
MAC=$(ip -o link show 2>/dev/null | awk '$2!="lo:" {print $(NF-2); exit}')

echo
echo "  Hostname   : $(hostname)"
echo "  IP sekarang: ${IP:-tidak terdeteksi}"
echo "  MAC address: ${MAC:-tidak terdeteksi}"
echo "  User        : $REAL_USER"
echo
echo "  Dari MacBook, konek dengan:"
echo "      ssh $REAL_USER@${IP:-<ip-server>}"
echo
echo "  Verifikasi sleep sudah mati:"
echo "      systemctl status sleep.target      # harus 'masked'"
echo "      Lalu tutup layar ~1 menit, dan coba ssh lagi dari MacBook."
echo
warn "BELUM OTOMATIS — perlu lu lakukan manual:"
echo "  1. IP STATIS. Cara paling gampang & aman: buka admin router lu,"
echo "     cari 'DHCP Reservation' / 'Static Lease', ikat MAC ${MAC:-<mac>}"
echo "     ke satu IP tetap. Lebih baik daripada set statis di sini,"
echo "     karena tidak berisiko bikin bentrok IP."
echo
echo "  2. BIOS: aktifkan 'Restore on AC Power Loss' -> Power On,"
echo "     biar laptop nyala sendiri setelah mati lampu."
echo "     Sekalian aktifkan Wake-on-LAN kalau mau."
echo
echo "  3. FISIK: bersihkan kipas + ganti thermal paste. Cek baterai —"
echo "     kalau kembung (casing/trackpad menonjol), CABUT baterainya."
echo
echo "  Opsional, panel web buat pantau dari browser MacBook:"
echo "      sudo apt install cockpit && sudo ufw allow 9090/tcp"
echo "      lalu buka https://${IP:-<ip-server>}:9090"
echo
