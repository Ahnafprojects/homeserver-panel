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

    mkdir -p "$MOUNT/auto" "$MOUNT/manual"
    cat > "$MOUNT/README.txt" <<'EOF'
Struktur folder drive backup ini
=================================

auto/       Snapshot HARIAN otomatis (server-backup.timer, tiap jam 02:00,
            juga jalan begitu drive ini dicolok). Satu subfolder per waktu
            backup, format nama: YYYY-MM-DD_HHMM.

            auto/latest -> symlink ke snapshot yang paling baru.

            Isi tiap snapshot:
              files/       salinan /srv/data dan /srv/stacks
              databases/   dump basis data (Postgres/MariaDB/Mongo/Redis)
                           dari fitur Database di panel
              system/      fstab, smb.conf, server-alerts.conf

            File yang sama persis antar-snapshot di-hardlink (tidak
            disalin ulang), jadi tiap snapshot terlihat lengkap padahal
            cuma perubahannya yang makan ruang. JANGAN edit langsung isi
            snapshot lama — hardlink berarti perubahan itu bisa kena ke
            snapshot lain juga.

manual/     Backup sekali-jalan yang dipicu tombol "Back up now" di
            panel (per-basis data atau per-database), bukan otomatis.

Cara restore: jalankan "sudo server-restore" (bukan salin manual).
EOF
    echo "    struktur folder: auto/, manual/, README.txt"
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
DBDUMP_DIR=/srv/db-dumps
STATE_FILE=/srv/panel-state/databases.json

# Tiap snapshot dipecah jadi 3 kelompok, masing-masing di-rsync (dan
# di-hardlink lewat --link-dest) TERPISAH — biar strukturnya jelas dibaca
# (files/ vs databases/ vs system/), bukan berkas & folder ketimpuk jadi satu
# tumpukan rata. Tambah/kurangi isinya sesuai kebutuhan.
FILES_SOURCES=(
    /srv/data
    /srv/stacks
)
# /srv/db-dumps diisi otomatis di bawah, sebelum rsync — lihat dump_databases().
DB_SOURCE=/srv/db-dumps
SYSTEM_SOURCES=(
    /etc/server-alerts.conf
    /etc/samba/smb.conf
    /etc/fstab
)

notify_if_able() { [[ -x "$NOTIFY" ]] && "$NOTIFY" "$1" "$2" || true; }

# Dump semua basis data yang dibuat lewat fitur Database di panel, SEBELUM
# di-rsync. Volume Docker basis data TIDAK aman disalin mentah-mentah kalau
# containernya lagi jalan (bisa korup) — jadi tiap engine di-dump ke format
# text/archive dulu (pg_dumpall/mysqldump/mongodump/redis SAVE), baru hasil
# dump-nya yang masuk /srv/db-dumps buat di-rsync seperti sumber lain.
dump_databases() {
    mkdir -p "$DBDUMP_DIR"
    rm -f "$DBDUMP_DIR"/*.sql.gz "$DBDUMP_DIR"/*.archive.gz "$DBDUMP_DIR"/*.rdb 2>/dev/null || true
    [[ -f "$STATE_FILE" ]] || return 0

    local OK=0 FAIL=0 FAILED_NAMES=()
    while IFS=$'\t' read -r NAME ENGINE CONTAINER PASSWORD; do
        [[ -z "$NAME" ]] && continue
        # Nama & container sudah disanitasi panel sendiri (safeName di
        # dbaas.js), tapi tetap divalidasi ulang sebelum masuk shell.
        [[ "$NAME" =~ ^[A-Za-z0-9_.-]+$ && "$CONTAINER" =~ ^[A-Za-z0-9_.-]+$ ]] || continue
        [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == "true" ]] || continue

        case "$ENGINE" in
            postgres)
                docker exec "$CONTAINER" sh -c 'pg_dumpall -U "$POSTGRES_USER"' 2>/dev/null \
                    | gzip > "$DBDUMP_DIR/$NAME.sql.gz"
                ;;
            mariadb)
                docker exec "$CONTAINER" sh -c 'mysqldump -u root -p"$MARIADB_ROOT_PASSWORD" --all-databases' 2>/dev/null \
                    | gzip > "$DBDUMP_DIR/$NAME.sql.gz"
                ;;
            mongo)
                docker exec "$CONTAINER" sh -c \
                    'mongodump --archive --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' 2>/dev/null \
                    | gzip > "$DBDUMP_DIR/$NAME.archive.gz"
                ;;
            redis)
                # Redis tidak nyimpen passwordnya sendiri sebagai env var
                # (dikasih lewat --requirepass pas start), jadi diambil dari
                # state panel. SAVE dulu biar dump.rdb dijamin ter-update.
                docker exec "$CONTAINER" redis-cli -a "$PASSWORD" --no-auth-warning SAVE >/dev/null 2>&1
                docker cp "$CONTAINER:/data/dump.rdb" "$DBDUMP_DIR/$NAME.rdb" >/dev/null 2>&1
                ;;
            *) continue ;;
        esac

        if [[ -s "$DBDUMP_DIR/$NAME."* ]] 2>/dev/null; then
            OK=$((OK + 1))
        else
            FAIL=$((FAIL + 1)); FAILED_NAMES+=("$NAME")
        fi
    done < <(node -e '
        const fs = require("fs");
        try {
            const list = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            for (const i of list) {
                console.log([i.name, i.engine, i.container, i.password || ""].join("\t"));
            }
        } catch {}
    ' "$STATE_FILE" 2>/dev/null)

    echo "$OK|$FAIL|${FAILED_NAMES[*]:-}"
}

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

DB_RESULT=$(dump_databases)
DB_OK=$(cut -d'|' -f1 <<<"$DB_RESULT")
DB_FAIL=$(cut -d'|' -f2 <<<"$DB_RESULT")
DB_FAILED_NAMES=$(cut -d'|' -f3 <<<"$DB_RESULT")

# auto/ = snapshot otomatis (ini). manual/ = backup sekali-jalan yang dipicu
# tombol di panel (fitur lain, lihat BACKUP_DIR di src/admin.js) — dua-duanya
# sengaja dipisah dari root drive supaya jelas mana yang otomatis vs manual.
DEST="$MOUNT/auto"
mkdir -p "$DEST" "$MOUNT/manual"
STAMP=$(date +%Y-%m-%d_%H%M)
NEW="$DEST/$STAMP"
LATEST="$DEST/latest"

# --link-dest per kelompok (files/databases/system), bukan satu buat semua —
# supaya tetap hemat ruang (hardlink ke yang tidak berubah) sekalipun tiap
# kelompok sekarang di-rsync sebagai langkah terpisah.
LR=""
[[ -d "$LATEST" ]] && LR=$(readlink -f "$LATEST")
LINKARG_FILES=(); LINKARG_DB=(); LINKARG_SYS=()
[[ -n "$LR" && -d "$LR/files" ]]     && LINKARG_FILES=(--link-dest="$LR/files")
[[ -n "$LR" && -d "$LR/databases" ]] && LINKARG_DB=(--link-dest="$LR/databases")
[[ -n "$LR" && -d "$LR/system" ]]    && LINKARG_SYS=(--link-dest="$LR/system")

START=$(date +%s)
LOGF=$(mktemp)
mkdir -p "$NEW/files" "$NEW/databases" "$NEW/system"

# -a  : pertahankan permission, owner, timestamp, symlink
# -x  : jangan lintas filesystem (jangan ikut masuk drive lain)
# --delete : snapshot mencerminkan kondisi sekarang, bukan menumpuk
if rsync -ax --delete --stats "${LINKARG_FILES[@]}" \
        --exclude='*.tmp' --exclude='lost+found' \
        "${FILES_SOURCES[@]}" "$NEW/files/" >"$LOGF" 2>&1 \
    && rsync -ax --delete --stats "${LINKARG_DB[@]}" \
        "$DB_SOURCE/" "$NEW/databases/" >>"$LOGF" 2>&1 \
    && rsync -ax --delete --stats "${LINKARG_SYS[@]}" \
        "${SYSTEM_SOURCES[@]}" "$NEW/system/" >>"$LOGF" 2>&1; then
    rm -rf "$LATEST"
    ln -s "$NEW" "$LATEST"

    # Buang snapshot tertua, sisakan $KEEP terbaru.
    mapfile -t OLD < <(find "$DEST" -maxdepth 1 -type d -name '20*' \
                        | sort | head -n -"$KEEP")
    for d in "${OLD[@]:-}"; do
        [[ -n "$d" && -d "$d" ]] && rm -rf "$d"
    done

    DUR=$(( $(date +%s) - START ))
    XFER_B=$(awk '/Total transferred file size/{gsub(",","",$5); sum+=$5} END{print sum+0}' "$LOGF")
    XFER="${XFER_B} bytes"
    SIZE=$(du -sh "$NEW" 2>/dev/null | cut -f1)
    NSNAP=$(find "$DEST" -maxdepth 1 -type d -name '20*' | wc -l | tr -d ' ')
    FREE=$(df -Ph "$MOUNT" | awk 'NR==2{print $4}')

    DBLINE="Basis data: ${DB_OK} berhasil di-dump"
    [[ "${DB_FAIL:-0}" -gt 0 ]] && DBLINE="${DBLINE}, ${DB_FAIL} GAGAL (${DB_FAILED_NAMES})"

    notify_if_able "💾 Backup selesai" \
"Snapshot: <code>${STAMP}</code>
Data baru ditulis: ${XFER:-?}
Ukuran snapshot: ${SIZE:-?}
Jumlah snapshot: ${NSNAP} (disimpan ${KEEP} terakhir)
${DBLINE}
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
DEST="$MOUNT/auto"

echo "Snapshot yang tersedia:"
find "$DEST" -maxdepth 1 -type d -name '20*' 2>/dev/null | sort | nl | sed 's/^/  /'
echo
echo "Tiap snapshot punya 3 folder: files/ (data + stacks), databases/ (dump"
echo "basis data), system/ (fstab, smb.conf, dst)."
echo
echo "Cara restore (contoh, untuk /srv/data):"
echo "  sudo rsync -av $DEST/latest/files/data/ /srv/data/"
echo
echo "Restore satu file/folder saja:"
echo "  sudo rsync -av $DEST/<tanggal>/files/data/folder-yang-mau/ /srv/data/folder-yang-mau/"
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

  Struktur folder di drive (baca $MOUNT/README.txt buat detail lengkap):
    auto/<tanggal_jam>/files/       data pribadi (/srv/data) + stacks docker
    auto/<tanggal_jam>/databases/   dump basis data dari fitur Database panel
                                     (Postgres/MariaDB/Mongo/Redis — dump
                                     ulang tiap backup jalan, bukan salinan
                                     volume mentah)
    auto/<tanggal_jam>/system/      fstab, smb.conf, server-alerts.conf
    auto/latest                     symlink ke snapshot paling baru
    manual/                         backup sekali-jalan dari tombol di panel

  Perintah:
    sudo server-backup                 # backup sekarang
    sudo server-restore                # lihat snapshot & cara restore
    ls /mnt/backup/auto/               # daftar snapshot
    systemctl list-timers | grep backup

  Kalau mau menambah folder yang di-backup, edit FILES_SOURCES/SYSTEM_SOURCES di:
    sudo nano /usr/local/bin/server-backup

EOF
warn "Basis data di-backup lewat dump, bukan volume mentah."
echo "  Menyalin file volume Docker basis data yang lagi jalan bisa hasilnya"
echo "  korup, jadi tiap backup jalan, server-backup dump dulu tiap basis data"
echo "  yang dibuat lewat fitur Database di panel (baca /srv/panel-state/"
echo "  databases.json) ke /srv/db-dumps, baru itu yang ikut ter-rsync."
echo "  Basis data eksternal (yang di-'Sambungkan' bukan 'Buat baru' di panel)"
echo "  TIDAK ikut, karena bukan panel yang mengelola containernya."
echo
warn "Flashdisk BUKAN medium backup yang andal."
echo "  Flash drive mati mendadak tanpa peringatan (tidak ada SMART)."
echo "  Untuk data yang benar-benar penting, pakai HDD eksternal, dan"
echo "  idealnya satu salinan lagi di luar rumah / cloud."
