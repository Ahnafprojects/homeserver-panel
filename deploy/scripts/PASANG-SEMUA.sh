#!/usr/bin/env bash
#
# PASANG-SEMUA.sh — jalankan semua setup sekaligus, berurutan.
#
# Pakai ini kalau lu tidak mau menjalankan script satu-satu.
#
#   sudo bash PASANG-SEMUA.sh
#
# SYARAT:
#   - Linux Mint sudah terinstall dan sudah di-reboot
#   - Laptop TERHUBUNG INTERNET (kabel LAN lebih baik daripada WiFi)
#     Semua script butuh internet untuk download paket.
#

set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "Butuh root: sudo bash $0" >&2; exit 1; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG=/var/log/setup-server-$(date +%Y%m%d-%H%M%S).log

banner() {
    printf '\n\033[1;36m'
    printf '=%.0s' {1..70}; printf '\n  %s\n' "$1"
    printf '=%.0s' {1..70}; printf '\033[0m\n'
}

# --- Cek internet dulu, biar tidak gagal di tengah jalan -------------------
banner "Cek koneksi internet"
if ! ping -c2 -W3 deb.debian.org &>/dev/null && \
   ! ping -c2 -W3 8.8.8.8 &>/dev/null; then
    echo "TIDAK ADA INTERNET." >&2
    echo "Sambungkan kabel LAN atau WiFi dulu, lalu jalankan ulang." >&2
    exit 1
fi
echo "Internet OK."

echo "Log lengkap disimpan di: $LOG"

run_step() {
    local script=$1 label=$2
    banner "$label"
    if [[ ! -f "$HERE/$script" ]]; then
        echo "LEWAT: $script tidak ditemukan di $HERE"
        return 0
    fi
    if bash "$HERE/$script" 2>&1 | tee -a "$LOG"; then
        echo "SELESAI: $label"
    else
        echo "GAGAL: $label — cek $LOG"
        echo "Script berikutnya tetap dijalankan."
    fi
}

# Urutannya penting:
#  1. server dulu  -> SSH & UFW harus ada sebelum yang lain
#  2. docker       -> setup-alerts memantau container, jadi docker dulu
#  3. alerts       -> butuh interaksi (token Telegram), taruh terakhir
#  4. backup       -> butuh drive dicolok, paling akhir
run_step setup-server.sh "1/5  Jadikan server (sleep off, SSH, UFW, auto-update)"
run_step setup-docker.sh "2/5  Docker + Portainer + Samba"

banner "3/5  Alert Telegram"
echo "Langkah ini INTERAKTIF — lu akan diminta token dari @BotFather."
echo
echo "Kalau belum siap, tekan Ctrl+C sekarang dan jalankan nanti dengan:"
echo "    sudo bash $HERE/setup-alerts.sh"
echo
read -rp "Lanjut sekarang? [y/N] " ans
if [[ "${ans,,}" == "y" ]]; then
    run_step setup-alerts.sh "3/5  Alert Telegram"
else
    echo "Dilewat. Jalankan sendiri nanti."
fi

banner "4/5  Auto backup"
echo "Langkah ini butuh drive backup DICOLOK dan sudah diformat ext4."
echo
echo "Kalau drive-nya belum siap, lewati saja dan jalankan nanti dengan:"
echo "    sudo bash $HERE/setup-backup.sh"
echo
read -rp "Drive backup sudah dicolok dan siap? [y/N] " ans
if [[ "${ans,,}" == "y" ]]; then
    run_step setup-backup.sh "4/5  Auto backup"
else
    echo "Dilewat. Jalankan sendiri nanti."
fi

# --- Ringkasan -------------------------------------------------------------
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
USER_NAME=${SUDO_USER:-$(logname 2>/dev/null || echo user)}

banner "5/5  Panel web"
echo "Memasang panel web (build 8-15 menit di CPU i3)."
echo
read -rp "Pasang panel sekarang? [Y/n] " ans
if [[ "${ans,,}" != "n" ]]; then
    run_step install-panel.sh "5/5  Panel web"
else
    echo "Dilewat. Jalankan sendiri nanti:  sudo bash $HERE/install-panel.sh"
fi

banner "SEMUA SELESAI"
cat <<EOF

  Server lu sekarang:

    SSH        ssh $USER_NAME@${IP:-<ip>}
    Panel web  http://${IP:-<ip>}:8090   <- MULAI DARI SINI
    File       smb://${IP:-<ip>}/data   (Finder: Cmd+K)

  WAJIB dilakukan sekarang:

    1. Set password Samba (terpisah dari password login):
         sudo smbpasswd -a $USER_NAME

    2. REBOOT, biar 'docker' bisa dipakai tanpa sudo:
         sudo reboot

  Setelah reboot, verifikasi bahwa sleep benar-benar mati:

    systemctl status sleep.target      # harus 'masked'

  Lalu tutup layar laptopnya ~1 menit dan coba SSH lagi dari MacBook.
  Kalau masih nyambung, server lu sudah beres.

  Masih manual (baca BACA-DULU.md):
    - IP statis lewat DHCP Reservation di router
    - Bersihkan kipas + ganti thermal paste (PENTING untuk 24/7)

EOF
