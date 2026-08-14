#!/usr/bin/env bash
#
# setup-backup.sh — backup otomatis data ke drive USB
#
#   sudo bash setup-backup.sh
#
# ============================================================================
# SIAPKAN DRIVE BACKUP DULU
#
# Drive backup WAJIB diformat ext4 dan diberi label BACKUP. Alasannya:
#   - exFAT/FAT tidak bisa menyimpan kepemilikan file & permission Linux
#     -> backup lu kehilangan semua permission, dan restore jadi berantakan
#   - exFAT tidak support hardlink
#     -> snapshot harian tidak bisa hemat ruang; tiap snapshot makan
#        ruang penuh, bukan hanya yang berubah
#
# Format drive (⚠️ MENGHAPUS SEMUA ISI DRIVE ITU):
#
#   lsblk -o NAME,SIZE,LABEL,MOUNTPOINT     # cari drive-nya, misal sdb
#   sudo umount /dev/sdb1 2>/dev/null
#   sudo mkfs.ext4 -L BACKUP /dev/sdb1
#
# PASTIKAN nama device-nya benar. Salah device = data lain hilang.
# Cek dua kali dengan `lsblk` sebelum menjalankan mkfs.
# ============================================================================

set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "Butuh root: sudo bash $0" >&2; exit 1; }

REAL_USER=${SUDO_USER:-$(logname 2>/dev/null || echo root)}
LABEL=BACKUP
MOUNT=/mnt/backup

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
say "1/5  Cari drive berlabel '$LABEL'"
# ---------------------------------------------------------------------------
DEV=$(blkid -L "$LABEL" 2>/dev/null || true)
if [[ -z "$DEV" ]]; then
    warn "Drive berlabel '$LABEL' tidak ditemukan."
    echo
    echo "  Drive yang terdeteksi sekarang:"
    lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINT | sed 's/^/    /'
    echo
    echo "  Colok drive backup lu, lalu format sebagai ext4 berlabel BACKUP."
    echo "  Baca instruksi lengkap di bagian atas file ini:"
    echo "      head -30 $0"
    echo
    echo "  Setup TIDAK dilanjutkan — tidak ada yang diubah."
    exit 1
fi

FSTYPE=$(blkid -o value -s TYPE "$DEV" 2>/dev/null || echo "?")
echo "    ditemukan: $DEV (filesystem: $FSTYPE)"

if [[ "$FSTYPE" != "ext4" ]]; then
    warn "Filesystem-nya '$FSTYPE', bukan ext4."
    warn "Backup akan JALAN, tapi permission file TIDAK tersimpan dan"
    warn "snapshot harian akan makan ruang penuh (tidak hemat)."
    echo
    read -rp "  Lanjut saja? [y/N] " ans
    [[ "${ans,,}" == "y" ]] || { echo "Dibatalkan."; exit 1; }
    NO_HARDLINK=1
else
    NO_HARDLINK=0
fi

# ---------------------------------------------------------------------------
say "2/5  Mount otomatis di $MOUNT"
# ---------------------------------------------------------------------------
mkdir -p "$MOUNT"
UUID=$(blkid -o value -s UUID "$DEV")

# nofail + x-systemd.device-timeout: kalau drive dicabut, server TETAP
# bisa boot normal. Tanpa ini, drive tidak ada = boot menggantung.
FSTAB_LINE="UUID=$UUID $MOUNT ${FSTYPE} defaults,nofail,x-systemd.device-timeout=10 0 2"
if ! grep -q "UUID=$UUID" /etc/fstab; then
    cp /etc/fstab "/etc/fstab.bak-$(date +%Y%m%d-%H%M%S)"
    echo "$FSTAB_LINE" >> /etc/fstab
    echo "    ditambahkan ke /etc/fstab (nofail — server tetap boot kalau drive dicabut)"
else
    echo "    sudah ada di /etc/fstab"
fi

systemctl daemon-reload
mount "$MOUNT" 2>/dev/null || mount -a 2>/dev/null || true
if mountpoint -q "$MOUNT"; then
    AVAIL=$(df -Ph "$MOUNT" | awk 'NR==2{print $4}')
    echo "    ter-mount. Ruang tersedia: $AVAIL"
else
    warn "Gagal mount. Cek manual: sudo mount $MOUNT"
fi

# ---------------------------------------------------------------------------
say "3/5  Script backup"
# ---------------------------------------------------------------------------
cat > /usr/local/bin/server-backup <<'SCRIPT_EOF'
#!/usr/bin/env bash
#
# server-backup — snapshot data ke drive USB.
#
# Pakai rsync --link-dest: file yang TIDAK berubah di-hardlink ke snapshot
# sebelumnya, jadi tidak menghabiskan ruang dua kali. Hasilnya tiap snapshot
# terlihat seperti salinan lengkap, tapi hanya perubahannya yang memakan
# ruang. 7 snapshot dari data 20 GB bisa cuma butuh ~22 GB.
#
set -uo pipefail

MOUNT=/mnt/backup
KEEP=7
NOTIFY=/usr/local/bin/notify
LOCK=/var/run/server-backup.lock

# Yang di-backup. Tambah/kurangi sesuai kebutuhan.
SOURCES=(
    /srv/data
    /srv/stacks
    /etc/server-alerts.conf
    /etc/samba/smb.conf
    /etc/fstab
)

notify_if_able() { [[ -x "$NOTIFY" ]] && "$NOTIFY" "$1" "$2" || true; }

# Cegah dua backup jalan bersamaan (mis. timer + colok drive).
exec 9>"$LOCK" || exit 0
flock -n 9 || { echo "Backup lain sedang jalan, keluar."; exit 0; }

if ! mountpoint -q "$MOUNT"; then
    mount "$MOUNT" 2>/dev/null || true
fi
if ! mountpoint -q "$MOUNT"; then
    notify_if_able "❌ Backup gagal" \
"Drive backup tidak ter-mount di ${MOUNT}.
Kemungkinan drive-nya dicabut.

Cek: <code>lsblk</code> lalu <code>sudo mount ${MOUNT}</code>"
    exit 1
fi

# Peringatkan kalau drive hampir penuh SEBELUM backup dimulai.
USEDPCT=$(df -P "$MOUNT" | awk 'NR==2{gsub("%","",$5); print $5}')
if [[ -n "${USEDPCT:-}" ]] && (( USEDPCT >= 90 )); then
    notify_if_able "⚠️ Drive backup hampir penuh" \
"Terpakai <b>${USEDPCT}%</b>.
Snapshot tertua akan dihapus, tapi sebaiknya pakai drive lebih besar."
fi

DEST="$MOUNT/snapshots"
mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d_%H%M)
NEW="$DEST/$STAMP"
LATEST="$DEST/latest"

LINKARG=()
[[ -d "$LATEST" ]] && LINKARG=(--link-dest="$(readlink -f "$LATEST")")

START=$(date +%s)
LOGF=$(mktemp)

# -a  : pertahankan permission, owner, timestamp, symlink
# -x  : jangan lintas filesystem (jangan ikut masuk drive lain)
# --delete : snapshot mencerminkan kondisi sekarang, bukan menumpuk
if rsync -ax --delete --stats \
        "${LINKARG[@]}" \
        --exclude='*.tmp' --exclude='lost+found' \
        "${SOURCES[@]}" "$NEW/" >"$LOGF" 2>&1; then
    rm -rf "$LATEST"
    ln -s "$NEW" "$LATEST"

    # Buang snapshot tertua, sisakan $KEEP terbaru.
    mapfile -t OLD < <(find "$DEST" -maxdepth 1 -type d -name '20*' \
                        | sort | head -n -"$KEEP")
    for d in "${OLD[@]:-}"; do
        [[ -n "$d" && -d "$d" ]] && rm -rf "$d"
    done

    DUR=$(( $(date +%s) - START ))
    XFER=$(awk '/Total transferred file size/{print $5" "$6}' "$LOGF" | head -1)
    SIZE=$(du -sh "$NEW" 2>/dev/null | cut -f1)
    NSNAP=$(find "$DEST" -maxdepth 1 -type d -name '20*' | wc -l | tr -d ' ')
    FREE=$(df -Ph "$MOUNT" | awk 'NR==2{print $4}')

    notify_if_able "💾 Backup selesai" \
"Snapshot: <code>${STAMP}</code>
Data baru ditulis: ${XFER:-?}
Ukuran snapshot: ${SIZE:-?}
Jumlah snapshot: ${NSNAP} (disimpan ${KEEP} terakhir)
Sisa ruang drive: ${FREE}
Durasi: ${DUR}s"
    rm -f "$LOGF"
    exit 0
else
    ERR=$(tail -5 "$LOGF" | head -c 500)
    notify_if_able "❌ Backup GAGAL" \
"Snapshot <code>${STAMP}</code> tidak selesai.

<code>${ERR}</code>

Cek manual: <code>sudo /usr/local/bin/server-backup</code>"
    rm -rf "$NEW"
    rm -f "$LOGF"
    exit 1
fi
SCRIPT_EOF
chmod 755 /usr/local/bin/server-backup
echo "    /usr/local/bin/server-backup dibuat"

# Script restore — dibuat sekarang, biar tidak panik nanti.
cat > /usr/local/bin/server-restore <<'SCRIPT_EOF'
#!/usr/bin/env bash
# server-restore — kembalikan data dari snapshot backup.
set -uo pipefail
MOUNT=/mnt/backup
DEST="$MOUNT/snapshots"

echo "Snapshot yang tersedia:"
find "$DEST" -maxdepth 1 -type d -name '20*' 2>/dev/null | sort | nl | sed 's/^/  /'
echo
echo "Cara restore (contoh, untuk /srv/data):"
echo "  sudo rsync -av $DEST/latest/data/ /srv/data/"
echo
echo "Restore satu file/folder saja:"
echo "  sudo rsync -av $DEST/<tanggal>/data/folder-yang-mau/ /srv/data/folder-yang-mau/"
echo
echo "Lihat isi snapshot dulu sebelum restore:"
echo "  ls -la $DEST/latest/"
echo
echo "CATATAN: perintah restore TIDAK dijalankan otomatis oleh script ini,"
echo "supaya lu tidak menimpa data yang masih bagus karena salah ketik."
SCRIPT_EOF
chmod 755 /usr/local/bin/server-restore
echo "    /usr/local/bin/server-restore dibuat (panduan restore)"

# ---------------------------------------------------------------------------
say "4/5  Jadwal otomatis"
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/server-backup.service <<'SCRIPT_EOF'
[Unit]
Description=Backup data server ke drive USB
After=local-fs.target network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/server-backup
# Backup jangan bikin server lemot: turunkan prioritas CPU & disk.
Nice=15
IOSchedulingClass=idle
SCRIPT_EOF

cat > /etc/systemd/system/server-backup.timer <<'SCRIPT_EOF'
[Unit]
Description=Backup otomatis tiap hari jam 2 pagi

[Timer]
OnCalendar=*-*-* 02:00:00
# Persistent: kalau server mati saat jadwalnya, backup dijalankan
# begitu server nyala lagi — jadi tidak ada hari yang terlewat.
Persistent=true
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
SCRIPT_EOF

systemctl daemon-reload
systemctl enable --now server-backup.timer >/dev/null
echo "    backup otomatis tiap hari 02:00 (dan langsung jalan kalau terlewat)"

# Bonus: backup juga langsung saat drive dicolok.
cat > /etc/udev/rules.d/99-backup-drive.rules <<EOF
# Begitu drive berlabel $LABEL dicolok, jalankan backup.
ACTION=="add", SUBSYSTEM=="block", ENV{ID_FS_LABEL}=="$LABEL", \
  TAG+="systemd", ENV{SYSTEMD_WANTS}="server-backup.service"
EOF
udevadm control --reload-rules 2>/dev/null || true
echo "    backup juga jalan otomatis tiap drive dicolok"

# ---------------------------------------------------------------------------
say "5/5  Backup pertama sekarang"
# ---------------------------------------------------------------------------
echo "    menjalankan..."
if /usr/local/bin/server-backup; then
    echo "    backup pertama BERHASIL"
else
    warn "Backup pertama gagal — cek pesannya di atas."
fi

# ---------------------------------------------------------------------------
say "SELESAI"
# ---------------------------------------------------------------------------
cat <<EOF

  Drive     : $DEV -> $MOUNT
  Jadwal    : tiap hari 02:00, plus setiap drive dicolok
  Simpan    : 7 snapshot terakhir (yang tertua dihapus otomatis)
  Notifikasi: hasil backup dikirim ke Telegram

  Yang di-backup:
    /srv/data                  data pribadi lu
    /srv/stacks                file docker-compose
    /etc/server-alerts.conf    konfigurasi alert
    /etc/samba/smb.conf        konfigurasi share
    /etc/fstab

  Perintah:
    sudo server-backup                 # backup sekarang
    sudo server-restore                # lihat snapshot & cara restore
    ls /mnt/backup/snapshots/          # daftar snapshot
    systemctl list-timers | grep backup

  Kalau mau menambah folder yang di-backup, edit array SOURCES di:
    sudo nano /usr/local/bin/server-backup

EOF
warn "Volume Docker TIDAK ikut ter-backup."
echo "  Data di dalam volume Docker (mis. database Postgres) tidak ada di"
echo "  /srv/data. Untuk database, dump dulu baru di-backup — menyalin file"
echo "  database yang sedang jalan bisa menghasilkan backup yang korup:"
echo
echo "    docker exec <container-db> pg_dumpall -U postgres \\"
echo "      > /srv/data/db-\$(date +%F).sql"
echo
echo "  Taruh perintah itu di cron/timer sendiri sebelum jam 02:00."
echo
warn "Flashdisk BUKAN medium backup yang andal."
echo "  Flash drive mati mendadak tanpa peringatan (tidak ada SMART)."
echo "  Untuk data yang benar-benar penting, pakai HDD eksternal, dan"
echo "  idealnya satu salinan lagi di luar rumah / cloud."
