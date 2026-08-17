#!/usr/bin/env bash
#
# setup-alerts.sh — monitoring & alert keamanan ke Telegram
#
# Jalankan SETELAH setup-server.sh (dan setup-docker.sh kalau pakai Docker):
#   sudo bash setup-alerts.sh
#
# Aman dijalankan berulang kali (idempotent).
#
# ============================================================================
# SEBELUM JALANKAN — siapkan 2 hal dari Telegram (5 menit):
#
#   1. Buka Telegram, chat @BotFather
#      Kirim: /newbot
#      Ikuti instruksi (kasih nama, misal "Server K42F").
#      BotFather akan balas TOKEN, bentuknya seperti:
#          8123456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
#
#   2. Chat bot lu yang baru dibuat itu, kirim pesan apa saja (misal "hai").
#      LANGKAH INI WAJIB — bot tidak boleh mengirim pesan lebih dulu
#      sebelum lu menyapanya. Kalau dilewat, alert tidak akan terkirim.
#
#   Chat ID akan dideteksi otomatis oleh script ini.
# ============================================================================

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Butuh root: sudo bash $0" >&2; exit 1; }

CONF=/etc/server-alerts.conf
STATE=/var/lib/server-alerts
say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$1"; }

mkdir -p "$STATE"
chmod 700 "$STATE"

# ---------------------------------------------------------------------------
say "1/8  Konfigurasi Telegram"
# ---------------------------------------------------------------------------
if [[ -f "$CONF" ]] && grep -q '^TG_TOKEN=.\+' "$CONF"; then
    echo "    $CONF sudah ada, dipakai ulang."
    # shellcheck disable=SC1090
    . "$CONF"
else
    echo
    read -rp "  Tempel TOKEN dari @BotFather: " TG_TOKEN
    TG_TOKEN=$(echo "$TG_TOKEN" | tr -d '[:space:]')
    [[ -n "$TG_TOKEN" ]] || { echo "Token kosong. Batal." >&2; exit 1; }

    echo
    echo "  Mendeteksi chat ID... (pastikan lu SUDAH chat bot itu duluan)"
    RESP=$(curl -fsS --max-time 15 \
        "https://api.telegram.org/bot${TG_TOKEN}/getUpdates" 2>/dev/null || echo "")
    TG_CHAT=$(echo "$RESP" \
        | grep -o '"chat":{"id":-\?[0-9]\+' \
        | head -1 | grep -o '\-\?[0-9]\+$' || true)

    if [[ -z "$TG_CHAT" ]]; then
        warn "Chat ID tidak terdeteksi otomatis."
        warn "Kirim dulu pesan apa saja ke bot lu di Telegram, lalu:"
        echo
        read -rp "  Isi chat ID manual (atau Enter untuk coba deteksi lagi): " TG_CHAT
        if [[ -z "$TG_CHAT" ]]; then
            RESP=$(curl -fsS --max-time 15 \
                "https://api.telegram.org/bot${TG_TOKEN}/getUpdates" 2>/dev/null || echo "")
            TG_CHAT=$(echo "$RESP" \
                | grep -o '"chat":{"id":-\?[0-9]\+' \
                | head -1 | grep -o '\-\?[0-9]\+$' || true)
        fi
        [[ -n "$TG_CHAT" ]] || {
            echo "Masih gagal. Pastikan lu sudah kirim pesan ke bot, lalu ulangi." >&2
            exit 1
        }
    fi
    echo "    chat ID: $TG_CHAT"

    cat > "$CONF" <<EOF
# Kredensial alert Telegram. JANGAN di-commit ke git / dibagikan.
TG_TOKEN=$TG_TOKEN
TG_CHAT=$TG_CHAT

# --- Ambang batas alert (ubah sesuai selera) ---
DISK_PCT=85        # alert kalau disk terpakai di atas ini (%)
RAM_PCT=90         # alert kalau RAM terpakai di atas ini (%)
LOAD_MAX=4.0       # alert kalau load average 5-menit di atas ini
TEMP_MAX=80        # alert kalau suhu CPU di atas ini (derajat C)
BATT_SHUTDOWN=15   # shutdown otomatis kalau baterai di bawah ini (%) saat mati lampu
EOF
    # Berisi token — hanya root boleh baca.
    chmod 600 "$CONF"
    chown root:root "$CONF"
    echo "    disimpan di $CONF (mode 600, hanya root)"
fi

# ---------------------------------------------------------------------------
say "2/8  Pengirim notifikasi: /usr/local/bin/notify"
# ---------------------------------------------------------------------------
cat > /usr/local/bin/notify <<'SCRIPT_EOF'
#!/usr/bin/env bash
# notify "<judul>" "<isi>" — kirim pesan ke Telegram.
# Dipakai semua script alert. Bisa juga dipanggil manual:
#     sudo notify "Tes" "Halo dari server"
set -uo pipefail
CONF=/etc/server-alerts.conf
[[ -r "$CONF" ]] || exit 0
# shellcheck disable=SC1090
. "$CONF"
[[ -n "${TG_TOKEN:-}" && -n "${TG_CHAT:-}" ]] || exit 0

TITLE=${1:-Server}
BODY=${2:-}
HOST=$(hostname)
TS=$(date '+%Y-%m-%d %H:%M:%S %Z')

TEXT="<b>${TITLE}</b>
<i>${HOST}</i> — ${TS}

${BODY}"

# --max-time supaya alert tidak menggantung boot/timer kalau internet mati.
curl -fsS --max-time 20 \
    -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" \
    -d parse_mode="HTML" \
    -d disable_web_page_preview=true \
    --data-urlencode text="${TEXT}" \
    -o /dev/null 2>/dev/null || true
SCRIPT_EOF
chmod 755 /usr/local/bin/notify
echo "    dibuat"

# ---------------------------------------------------------------------------
say "3/8  Tes kirim"
# ---------------------------------------------------------------------------
if /usr/local/bin/notify "✅ Alert aktif" "Kalau lu baca ini, notifikasi server sudah jalan."; then
    echo "    terkirim — cek Telegram lu sekarang."
else
    warn "Gagal kirim. Cek token/chat_id di $CONF"
fi

# ---------------------------------------------------------------------------
say "4/8  Alert login SSH (real-time)"
# ---------------------------------------------------------------------------
# Dipanggil PAM setiap ada sesi SSH dibuka. Ini yang bikin lu tahu
# SEGERA kalau ada orang berhasil masuk ke server lu.
cat > /usr/local/bin/ssh-login-alert <<'SCRIPT_EOF'
#!/usr/bin/env bash
set -uo pipefail
[[ "${PAM_TYPE:-}" == "open_session" ]] || exit 0
[[ "${PAM_SERVICE:-}" == "sshd" ]] || exit 0
/usr/local/bin/notify "🔓 Login SSH" \
"User: <code>${PAM_USER:-?}</code>
Dari IP: <code>${PAM_RHOST:-?}</code>

Kalau ini bukan lu, SEGERA:
1. <code>sudo passwd ${PAM_USER:-user}</code>
2. <code>sudo ufw deny from ${PAM_RHOST:-IP}</code>
3. cek: <code>last -20</code>" &
# Nitip juga ke notification center web panel (dobel sama Telegram di atas
# itu sengaja) -- token dibaca langsung dari state panel, gak perlu setup
# apa-apa lagi. Diam-diam gagal kalau panel belum jalan/token belum ada.
{
  TOKF=/srv/panel-state/host-notify-token.txt
  if [[ -r "$TOKF" ]]; then
    TOK=$(cat "$TOKF")
    curl -fsS --max-time 5 -X POST "http://127.0.0.1:8090/api/events/host" \
      -H "Authorization: Bearer ${TOK}" -H "Content-Type: application/json" \
      -d "{\"type\":\"sec.ssh_login\",\"message\":\"<b>${PAM_USER:-?}</b> login SSH dari <code>${PAM_RHOST:-?}</code>.\",\"meta\":{\"key\":\"${PAM_RHOST:-?}\"}}" \
      -o /dev/null 2>/dev/null || true
  fi
} &
exit 0
SCRIPT_EOF
chmod 755 /usr/local/bin/ssh-login-alert

PAM_LINE='session optional pam_exec.so seteuid /usr/local/bin/ssh-login-alert'
if ! grep -qF "$PAM_LINE" /etc/pam.d/sshd; then
    cp /etc/pam.d/sshd "/etc/pam.d/sshd.bak-$(date +%Y%m%d-%H%M%S)"
    echo "$PAM_LINE" >> /etc/pam.d/sshd
    echo "    hook PAM dipasang (backup /etc/pam.d/sshd dibuat)"
else
    echo "    hook PAM sudah ada"
fi

# ---------------------------------------------------------------------------
say "5/8  fail2ban — blokir brute force + lapor"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq fail2ban

# Action khusus: kirim Telegram tiap kali sebuah IP diblokir.
cat > /etc/fail2ban/action.d/telegram.conf <<'SCRIPT_EOF'
[Definition]
# CATATAN: '%' harus ditulis '%%' di sini — config fail2ban pakai '%' sebagai
# karakter interpolasi sendiri (ConfigParser-style). '%0A' polos bikin fail2ban
# gagal start total ("'%' must be followed by '%' or '('").
actionban = /usr/local/bin/notify "🚫 IP diblokir" "Jail: <name>%%0AIP: <code><ip></code>%%0APercobaan gagal: <failures>x%%0A%%0ADiblokir otomatis oleh fail2ban."
actionunban =
SCRIPT_EOF

cat > /etc/fail2ban/jail.local <<'SCRIPT_EOF'
[DEFAULT]
# 5 kali gagal dalam 10 menit -> blokir 1 jam.
maxretry = 5
findtime = 10m
bantime  = 1h
# IP lokal jangan pernah diblokir, biar lu tidak mengunci diri sendiri.
ignoreip = 127.0.0.1/8 ::1 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12
backend  = systemd

[sshd]
enabled = true
port    = ssh
action  = %(action_)s
          telegram
SCRIPT_EOF

systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
echo "    fail2ban aktif: 5x gagal = blokir 1 jam + notif Telegram"
echo "    IP jaringan lokal dikecualikan (biar lu tidak terblokir sendiri)"

# ---------------------------------------------------------------------------
say "6/8  Health check berkala"
# ---------------------------------------------------------------------------
# Kunci desain: pakai file state, jadi alert dikirim hanya saat KONDISI
# BERUBAH (normal -> bermasalah, dan sebaliknya). Tanpa ini, lu bakal
# dibanjiri pesan yang sama tiap 5 menit dan akhirnya mengabaikannya.
cat > /usr/local/bin/server-health <<'SCRIPT_EOF'
#!/usr/bin/env bash
set -uo pipefail
CONF=/etc/server-alerts.conf
STATE=/var/lib/server-alerts
[[ -r "$CONF" ]] || exit 0
# shellcheck disable=SC1090
. "$CONF"

DISK_PCT=${DISK_PCT:-85}
RAM_PCT=${RAM_PCT:-90}
LOAD_MAX=${LOAD_MAX:-4.0}
TEMP_MAX=${TEMP_MAX:-80}
BATT_SHUTDOWN=${BATT_SHUTDOWN:-15}

mkdir -p "$STATE"

# fire <kunci> <judul> <isi>   -> kirim hanya kalau sebelumnya normal
# clear <kunci> <judul> <isi>  -> kirim pemulihan kalau sebelumnya bermasalah
fire() {
    local key=$1 title=$2 body=$3
    [[ -f "$STATE/$key" ]] && return 0
    touch "$STATE/$key"
    /usr/local/bin/notify "$title" "$body"
}
clear_() {
    local key=$1 title=$2 body=$3
    [[ -f "$STATE/$key" ]] || return 0
    rm -f "$STATE/$key"
    /usr/local/bin/notify "$title" "$body"
}

# --- Disk ---------------------------------------------------------------
USED=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
FREE=$(df -Ph / | awk 'NR==2{print $4}')
if [[ -n "${USED:-}" ]] && (( USED >= DISK_PCT )); then
    fire disk "⚠️ Disk hampir penuh" \
"Terpakai: <b>${USED}%</b> (sisa ${FREE})

Cek pemakan ruang terbesar:
<code>sudo du -xh / | sort -rh | head -20</code>
Log Docker: <code>docker system prune -a</code>"
else
    clear_ disk "✅ Disk normal" "Terpakai ${USED}% (sisa ${FREE})."
fi

# --- RAM ----------------------------------------------------------------
read -r MT MA < <(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t, a}' /proc/meminfo)
if [[ -n "${MT:-}" && "${MT:-0}" -gt 0 ]]; then
    RUSED=$(( (MT - MA) * 100 / MT ))
    if (( RUSED >= RAM_PCT )); then
        fire ram "⚠️ RAM hampir habis" \
"Terpakai: <b>${RUSED}%</b> dari $((MT/1024)) MB

Proses paling boros:
<code>ps -eo pmem,comm --sort=-pmem | head -6</code>"
    else
        clear_ ram "✅ RAM normal" "Terpakai ${RUSED}%."
    fi
fi

# --- Load average (i3-370M = 2 core / 4 thread) --------------------------
LOAD5=$(awk '{print $2}' /proc/loadavg)
if awk -v l="$LOAD5" -v m="$LOAD_MAX" 'BEGIN{exit !(l>m)}'; then
    fire load "⚠️ Server lemot (load tinggi)" \
"Load 5 menit: <b>${LOAD5}</b> (ambang ${LOAD_MAX})
CPU cuma 2 core / 4 thread.

Cek: <code>htop</code> atau
<code>ps -eo pcpu,comm --sort=-pcpu | head -6</code>"
else
    clear_ load "✅ Load normal" "Load 5 menit: ${LOAD5}."
fi

# --- Suhu (kritis untuk laptop 2010) ------------------------------------
TEMP=0
for z in /sys/class/thermal/thermal_zone*/temp; do
    [[ -r "$z" ]] || continue
    v=$(cat "$z" 2>/dev/null || echo 0)
    (( v > 1000 )) && v=$((v/1000))
    (( v > TEMP )) && TEMP=$v
done
if (( TEMP > 0 )); then
    if (( TEMP >= TEMP_MAX )); then
        fire temp "🔥 Suhu CPU tinggi" \
"Suhu: <b>${TEMP}°C</b> (ambang ${TEMP_MAX}°C)

Laptop 2010 nyala 24/7 — ini biasanya tanda
heatsink mampet debu atau thermal paste kering.
Matikan dulu kalau tembus 90°C."
    else
        clear_ temp "✅ Suhu normal" "Suhu CPU: ${TEMP}°C."
    fi
fi

# --- Listrik / baterai (khusus server laptop) ---------------------------
AC=""
for a in /sys/class/power_supply/A{C,DP}*/online; do
    [[ -r "$a" ]] && { AC=$(cat "$a"); break; }
done
CAP=""
for b in /sys/class/power_supply/BAT*/capacity; do
    [[ -r "$b" ]] && { CAP=$(cat "$b"); break; }
done

if [[ "$AC" == "0" ]]; then
    fire power "🔌 LISTRIK MATI" \
"Server jalan pakai baterai.
Sisa baterai: <b>${CAP:-?}%</b>

Akan shutdown otomatis di bawah ${BATT_SHUTDOWN}%
supaya data tidak korup."
    if [[ -n "$CAP" ]] && (( CAP <= BATT_SHUTDOWN )); then
        /usr/local/bin/notify "🛑 Shutdown otomatis" \
"Baterai tinggal ${CAP}%. Server dimatikan dengan rapi
untuk mencegah kerusakan data."
        sleep 5
        /sbin/shutdown -h now "Baterai kritis"
    fi
elif [[ "$AC" == "1" ]]; then
    clear_ power "🔌 Listrik kembali" "Sudah pakai listrik PLN. Baterai ${CAP:-?}%."
fi

# --- Container Docker yang mati -----------------------------------------
if command -v docker &>/dev/null && systemctl is-active --quiet docker; then
    DEAD=$(docker ps -a --filter "status=exited" --filter "status=dead" \
            --format '{{.Names}} ({{.Status}})' 2>/dev/null | head -10)
    RESTARTING=$(docker ps --filter "status=restarting" \
            --format '{{.Names}}' 2>/dev/null | head -10)
    if [[ -n "$DEAD$RESTARTING" ]]; then
        fire docker "⚠️ Container bermasalah" \
"${DEAD:+Mati:
<code>${DEAD}</code>
}${RESTARTING:+Restart loop:
<code>${RESTARTING}</code>
}
Cek log: <code>docker logs --tail 50 &lt;nama&gt;</code>"
    else
        clear_ docker "✅ Container normal" "Semua container jalan."
    fi
fi
SCRIPT_EOF
chmod 755 /usr/local/bin/server-health

cat > /etc/systemd/system/server-health.service <<'SCRIPT_EOF'
[Unit]
Description=Health check server + alert Telegram
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/server-health
SCRIPT_EOF

cat > /etc/systemd/system/server-health.timer <<'SCRIPT_EOF'
[Unit]
Description=Jalankan health check tiap 5 menit

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
SCRIPT_EOF

systemctl daemon-reload
systemctl enable --now server-health.timer >/dev/null
echo "    health check jalan tiap 5 menit"
echo "    yang dipantau: disk, RAM, load, suhu, listrik/baterai, container"

# ---------------------------------------------------------------------------
say "7/8  Notifikasi boot & laporan harian"
# ---------------------------------------------------------------------------
# Notif saat boot: kalau server reboot tanpa lu suruh, lu langsung tahu.
cat > /etc/systemd/system/server-boot-notify.service <<'SCRIPT_EOF'
[Unit]
Description=Kabari Telegram saat server selesai boot
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c '/usr/local/bin/notify "🔄 Server menyala" "IP: <code>$(hostname -I | awk \"{print \\$1}\")</code>%0AUptime dihitung dari sekarang.%0A%0AKalau lu tidak menyuruh reboot, ini perlu dicek: mati lampu, kernel panic, atau overheat."'

[Install]
WantedBy=multi-user.target
SCRIPT_EOF

systemctl daemon-reload
systemctl enable server-boot-notify.service >/dev/null 2>&1 || true
echo "    notifikasi boot aktif"

# Laporan harian: ringkasan + jumlah percobaan login gagal.
cat > /usr/local/bin/server-daily <<'SCRIPT_EOF'
#!/usr/bin/env bash
set -uo pipefail
UP=$(uptime -p 2>/dev/null || echo "?")
DISK=$(df -Ph / | awk 'NR==2{print $3" / "$2" ("$5")"}')
RAM=$(free -h | awk '/Mem:/{print $3" / "$2}')
LOAD=$(awk '{print $1", "$2", "$3}' /proc/loadavg)
IP=$(hostname -I 2>/dev/null | awk '{print $1}')

TEMP=0
for z in /sys/class/thermal/thermal_zone*/temp; do
    [[ -r "$z" ]] || continue
    v=$(cat "$z" 2>/dev/null || echo 0); (( v > 1000 )) && v=$((v/1000))
    (( v > TEMP )) && TEMP=$v
done

FAILED=$(journalctl -u ssh --since "24 hours ago" --no-pager 2>/dev/null \
         | grep -c "Failed password" || echo 0)
BANNED=$(fail2ban-client status sshd 2>/dev/null \
         | grep -oP 'Currently banned:\s*\K[0-9]+' || echo 0)
UPD=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst' || echo 0)

CONTAINERS=""
if command -v docker &>/dev/null; then
    CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
fi

/usr/local/bin/notify "📊 Laporan harian" \
"Uptime: ${UP}
IP: <code>${IP}</code>
Disk: ${DISK}
RAM: ${RAM}
Load: ${LOAD}
Suhu: ${TEMP}°C

<b>Keamanan 24 jam terakhir</b>
Login SSH gagal: <b>${FAILED}x</b>
IP sedang diblokir: <b>${BANNED}</b>
Update tersedia: <b>${UPD}</b>
${CONTAINERS:+
Container jalan: <code>${CONTAINERS}</code>}"
SCRIPT_EOF
chmod 755 /usr/local/bin/server-daily

cat > /etc/systemd/system/server-daily.service <<'SCRIPT_EOF'
[Unit]
Description=Laporan harian server ke Telegram
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/server-daily
SCRIPT_EOF

cat > /etc/systemd/system/server-daily.timer <<'SCRIPT_EOF'
[Unit]
Description=Kirim laporan harian tiap pagi jam 8

[Timer]
OnCalendar=*-*-* 08:00:00
Persistent=true

[Install]
WantedBy=timers.target
SCRIPT_EOF

systemctl daemon-reload
systemctl enable --now server-daily.timer >/dev/null
echo "    laporan harian tiap jam 08:00"

# ---------------------------------------------------------------------------
say "8/8  Selesai"
# ---------------------------------------------------------------------------
cat <<EOF

  Yang sekarang dikirim ke Telegram lu:

  REAL-TIME
    🔓 setiap login SSH berhasil (siapa, dari IP mana)
    🚫 setiap IP yang diblokir fail2ban (brute force)
    🔌 listrik mati / hidup (server jalan pakai baterai)
    🛑 shutdown otomatis kalau baterai kritis
    🔄 server selesai boot (deteksi reboot tak terduga)

  TIAP 5 MENIT (hanya saat kondisi BERUBAH, bukan spam)
    ⚠️ disk penuh    (> ${DISK_PCT:-85}%)
    ⚠️ RAM habis     (> ${RAM_PCT:-90}%)
    ⚠️ server lemot  (load > ${LOAD_MAX:-4.0})
    🔥 suhu tinggi    (> ${TEMP_MAX:-80}°C)
    ⚠️ container mati / restart loop
    ✅ plus notifikasi pemulihan saat kembali normal

  TIAP HARI 08:00
    📊 ringkasan: uptime, disk, RAM, suhu, jumlah login gagal,
       IP terblokir, update tersedia, container yang jalan

  Perintah berguna:
    sudo notify "Tes" "pesan"              # kirim manual
    sudo /usr/local/bin/server-health      # jalankan cek sekarang
    sudo /usr/local/bin/server-daily       # kirim laporan sekarang
    sudo fail2ban-client status sshd        # lihat IP terblokir
    systemctl list-timers | grep server     # cek jadwal
    sudo nano $CONF                         # ubah ambang batas

  Kalau alert kebanyakan, naikkan ambangnya di $CONF
  lalu: sudo systemctl restart server-health.timer

EOF
warn "$CONF berisi token bot lu (mode 600). Jangan dibagikan / di-commit ke git."
