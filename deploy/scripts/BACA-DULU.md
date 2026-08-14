# Linux Mint 22.3 XFCE — Home Server di Laptop i3 Gen 1

Flashdisk ini pakai **Ventoy**, jadi ISO-nya tidak "di-burn" — cuma dicopy sebagai
file biasa. Kalau nanti mau nambah OS lain, tinggal drag ISO-nya ke sini, tidak
perlu format ulang apa pun.

**Isi flashdisk:**

| File | Fungsi |
|---|---|
| `linuxmint-22.3-xfce-64bit.iso` | Installer Linux Mint (checksum ✅ terverifikasi) |
| `PASANG-SEMUA.sh` | **Jalankan ini** — semua setup sekaligus |
| `setup-server.sh` | sleep off, SSH, UFW, auto-update, sensor suhu |
| `setup-docker.sh` | Docker + Portainer + Samba |
| `setup-alerts.sh` | Alert Telegram (keamanan, performa, listrik) |
| `setup-backup.sh` | Backup otomatis ke drive USB |
| `sha256sum.txt` | Checksum resmi |
| `BACA-DULU.md` | File ini |

**Cara tercepat:** setelah Mint terinstall dan tersambung internet, cukup

```bash
sudo bash /media/$USER/Ventoy/PASANG-SEMUA.sh
```

Itu menjalankan keempat script berurutan. Kalau mau satu-satu, ikuti
Langkah 3–6 di bawah.

⚠️ Semua script butuh **internet** (untuk `apt install`). Pakai kabel LAN
kalau bisa — lebih stabil daripada WiFi b/g/n di laptop ini.

Kenapa 22.3 dan bukan versi lain: ini stable terbaru (Jan 2026), berbasis
Ubuntu 24.04 LTS, **disupport sampai April 2029**, dan masih pakai X11 —
penting, karena Wayland bermasalah di GPU Intel gen 1 (Ironlake).

---

## Langkah 1 — Boot dari flashdisk

1. Cabut flashdisk dari MacBook (**Eject dulu**, jangan cabut langsung).
2. Colok ke laptop i3, lalu nyalakan.
3. **Asus K42F** — tekan berulang kali saat logo Asus muncul:
   - `Esc` → boot device menu (**coba ini dulu**)
   - `F8` → alternatif kalau `Esc` tidak jalan
   - `F2` → masuk BIOS setup (kalau dua di atas gagal, masuk sini lalu
     atur urutan boot manual di tab **Boot**, taruh USB paling atas)
4. Pilih flashdisk-nya. Ventoy akan muncul dengan daftar ISO.
5. Pilih `linuxmint-22.3-xfce-64bit.iso` → pilih **Boot in normal mode**.

K42F itu tahun 2010 (chipset HM55), jadi hampir pasti **Legacy BIOS**, dan
tidak punya Secure Boot — satu hal yang biasanya bikin ribet, jadi tidak ada
di sini. Ventoy handle Legacy maupun UEFI otomatis, jadi tidak perlu
diapa-apakan.

Kalau flashdisk tidak muncul: masuk `F2`, cek **USB Boot = Enabled**
di tab Boot atau Advanced.

---

## Langkah 2 — Install Mint

Setelah masuk desktop live, klik **Install Linux Mint** di desktop.

Setelan yang disarankan:

- **Bahasa/Keyboard**: English (lebih gampang cari solusi kalau ada error)
- **Multimedia codecs**: ✅ **centang** (butuh internet, tapi hemat repot nanti)
- **Installation type**: `Erase disk and install Linux Mint`
  → ⚠️ **Ini menghapus SELURUH isi disk laptop itu.** Pastikan tidak ada
  data penting di sana. Ini tidak menyentuh MacBook lu sama sekali.
- **Encrypt / LVM**: ❌ **jangan dicentang**. Enkripsi berarti tiap kali boot
  harus ketik password di keyboard fisik — mustahil kalau server-nya headless.
- **Nama komputer**: kasih nama yang gampang, misal `server` atau `mintserver`
- **Login**: pilih **Log in automatically**
  → ini penting untuk server, biar setelah mati lampu laptop bisa boot sampai
  siap sendiri tanpa nunggu lu ketik password.

Selesai install → **Restart**, dan **cabut flashdisk** saat diminta.

---

## Langkah 3 — Jadikan server

Setelah boot ke Mint yang sudah terinstall, colok lagi flashdisk ini, buka
Terminal (`Ctrl+Alt+T`), lalu:

```bash
sudo bash /media/$USER/Ventoy/setup-server.sh
```

Kalau path-nya tidak ketemu, cek dulu dengan `ls /media/$USER/`.

Script itu akan otomatis:

1. Matikan sleep/suspend — **2 lapis** (systemd + XFCE), plus mask target
   systemd biar suspend jadi mustahil. Ini yang bikin tutup layar tidak
   mematikan server.
2. Matikan screen blanking.
3. Install `openssh-server` + aktifkan → bisa diremote dari MacBook.
4. Aktifkan firewall UFW (port SSH dibuka dulu sebelum firewall dinyalakan,
   biar sesi tidak terputus).
5. Aktifkan update keamanan otomatis.
6. Pasang `lm-sensors` buat pantau suhu, `htop` buat pantau resource.
7. Tampilkan IP + MAC address lu di akhir.

Di akhir, script menampilkan 3 hal yang **harus lu lakukan manual** —
IP statis, setelan BIOS, dan perawatan fisik. Baca bagian itu.

---

## Langkah 4 — Docker + penyimpanan data pribadi

Masih di Terminal laptop server:

```bash
sudo bash /media/$USER/Ventoy/setup-docker.sh
```

Yang dipasang:

- **Docker CE** dari repo resmi Docker (bukan `docker.io` bawaan Ubuntu yang
  versinya ketinggalan) + plugin `docker compose`
- **Portainer** — panel web untuk kelola container: bikin, hapus, restart,
  lihat log, semua klik-klik dari browser MacBook lu di port `9443`
- **Samba** — folder `/srv/data` bisa dibuka langsung dari Finder macOS
- Rotasi log Docker dibatasi (kalau tidak, log container bisa menghabiskan
  SSD lu tanpa terasa — sering kejadian di server yang lama nyala)
- Contoh `docker-compose.yml` (Postgres + Redis) di `/srv/stacks/`

Setelah script selesai, **wajib** dua hal:

```bash
sudo smbpasswd -a $USER     # password Samba terpisah dari password login
sudo reboot                 # biar 'docker' bisa dipakai tanpa sudo
```

Lalu buka `https://<ip-server>:9443` dan **bikin akun admin dalam 5 menit
pertama** — kalau lewat, Portainer mengunci diri sendiri dan containernya
harus direstart dulu.

Akses data dari Finder: `Cmd+K` → `smb://<ip-server>/data`

### ⚠️ Docker menembus firewall UFW — baca ini

Ini jebakan paling berbahaya buat pemula, dan tidak ada peringatannya
di mana-mana:

Kalau di `docker-compose.yml` lu tulis `ports: ["5432:5432"]`, port itu
**terbuka ke seluruh jaringan meskipun UFW memblokirnya.** Docker menulis
aturan iptables sendiri di bawah UFW. Banyak orang tanpa sadar mengekspos
database tanpa password karena ini.

Kebiasaan yang aman — selalu ikat ke localhost:

```yaml
ports: ["127.0.0.1:5432:5432"]   # aman, hanya dari dalam server
ports: ["5432:5432"]             # TERBUKA ke jaringan
```

Yang boleh benar-benar terbuka hanya reverse proxy (port 80/443).
Container backend lu diakses lewat proxy itu, bukan langsung.

### Server bukan backup

`/srv/data` ada di **satu SSD**. SSD mati = data pribadi lu hilang.
Ini ditangani di Langkah 6.

---

## Langkah 5 — Alert keamanan ke Telegram

**Siapkan dulu (5 menit, di HP lu):**

1. Buka Telegram → chat **@BotFather** → kirim `/newbot` → ikuti instruksi.
   BotFather balas **token**, bentuknya `8123456789:AAF-xxxxxxxx...`
2. **Chat bot lu yang baru itu, kirim pesan apa saja** (misal "hai").
   ⚠️ Langkah ini **wajib** — Telegram tidak mengizinkan bot mengirim pesan
   lebih dulu sebelum lu menyapanya. Kalau dilewat, alert tidak akan terkirim.

Lalu di server:

```bash
sudo bash /media/$USER/Ventoy/setup-alerts.sh
```

Script akan minta token, mendeteksi chat ID otomatis, dan langsung
kirim pesan tes.

### Apa saja yang dikabari

**Real-time:**
- 🔓 Setiap login SSH berhasil — siapa, dari IP mana. Ini alert terpenting:
  kalau ada orang berhasil masuk, lu tahu dalam hitungan detik.
- 🚫 Setiap IP yang diblokir fail2ban (brute force)
- 🔌 Listrik mati / hidup — server jalan pakai baterai
- 🛑 Shutdown otomatis kalau baterai tinggal 15%
- 🔄 Server selesai boot — kalau lu tidak menyuruh reboot, ini tanda ada
  yang tidak beres (mati lampu, kernel panic, overheat)

**Tiap 5 menit** — disk penuh, RAM habis, load tinggi (lemot), suhu CPU,
container mati/restart loop.

**Tiap hari 08:00** — ringkasan: uptime, disk, RAM, suhu, jumlah login SSH
gagal 24 jam terakhir, IP terblokir, update tersedia, container yang jalan.

### Kenapa lu tidak akan dispam

Alert pakai **file state**, jadi cuma dikirim saat kondisi **berubah**
(normal → bermasalah), bukan tiap 5 menit. Waktu pulih, lu dapat notif ✅
sekali. Ini penting: alert yang membanjiri itu ujungnya diabaikan, dan
alert yang diabaikan sama saja dengan tidak ada alert.

Kalau masih terasa ramai, naikkan ambangnya di `/etc/server-alerts.conf`.

### fail2ban

5 kali gagal login dalam 10 menit → IP diblokir 1 jam + notif Telegram.
IP jaringan lokal (`192.168.x.x`, `10.x.x.x`) **dikecualikan**, jadi lu
tidak bisa mengunci diri sendiri waktu salah ketik password.

### Perintah berguna

```bash
sudo notify "Tes" "pesan"           # kirim manual
sudo /usr/local/bin/server-health   # jalankan cek sekarang
sudo /usr/local/bin/server-daily    # kirim laporan sekarang
sudo fail2ban-client status sshd    # lihat IP yang diblokir
systemctl list-timers | grep server # cek jadwal
sudo nano /etc/server-alerts.conf   # ubah ambang batas
```

⚠️ `/etc/server-alerts.conf` berisi **token bot lu** (mode 600, hanya root).
Jangan dibagikan atau di-commit ke git.

---

## Langkah 6 — Backup otomatis ke drive USB

### Siapkan drive dulu — WAJIB ext4

Drive backup **harus** diformat ext4 dan diberi label `BACKUP`. Bukan
sekadar preferensi:

- **exFAT/FAT tidak bisa menyimpan kepemilikan file & permission Linux.**
  Backup lu akan kehilangan semua permission, dan restore jadi berantakan.
- **exFAT tidak support hardlink.** Tanpa hardlink, tiap snapshot harian
  memakan ruang penuh, bukan hanya bagian yang berubah.

```bash
lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINT   # cari drive-nya, misal sdb
sudo umount /dev/sdb1 2>/dev/null
sudo mkfs.ext4 -L BACKUP /dev/sdb1           # ⚠️ MENGHAPUS SEMUA ISI DRIVE
```

⚠️ **Cek dua kali nama device-nya dengan `lsblk`.** Salah device = data
lain yang hilang. Script tidak akan memformat apa pun untuk lu — langkah
ini sengaja manual supaya lu yang memutuskan disk mana.

Lalu:

```bash
sudo bash /media/$USER/Ventoy/setup-backup.sh
```

### Cara kerjanya

- **7 snapshot harian** pakai `rsync --link-dest`. File yang tidak berubah
  di-**hardlink** ke snapshot sebelumnya, jadi tidak memakan ruang dua kali.
  Tiap snapshot terlihat seperti salinan lengkap, tapi hanya perubahannya
  yang memakan ruang — 7 snapshot dari data 20 GB bisa cuma butuh ~22 GB.
- **Jadwal 02:00 tiap hari**, dengan `Persistent=true`: kalau server mati
  saat jadwalnya, backup jalan begitu server nyala lagi. Tidak ada hari
  yang terlewat.
- **Jalan juga tiap drive dicolok** (aturan udev). Jadi kalau lu simpan
  drive-nya di tempat lain dan colok sesekali, backup langsung mulai.
- **Hasilnya dilaporkan ke Telegram** — berhasil maupun gagal, lengkap
  dengan ukuran, sisa ruang, dan durasi.
- **`nofail` di /etc/fstab**: kalau drive dicabut, server **tetap boot
  normal**. Tanpa ini, drive yang tidak ada bisa bikin boot menggantung.
- Prioritas CPU & disk diturunkan (`Nice=15`, `IOSchedulingClass=idle`),
  jadi backup tidak bikin server lemot.

### Perintah

```bash
sudo server-backup             # backup sekarang
sudo server-restore            # lihat snapshot & cara restore
ls /mnt/backup/snapshots/      # daftar snapshot
```

### ⚠️ Volume Docker TIDAK ikut ter-backup

Data di dalam volume Docker (misal database Postgres) tidak ada di
`/srv/data`, jadi tidak tersalin. Dan **menyalin file database yang sedang
jalan bisa menghasilkan backup yang korup** — harus di-dump dulu:

```bash
docker exec <container-db> pg_dumpall -U postgres \
  > /srv/data/db-$(date +%F).sql
```

Taruh perintah itu di timer sendiri yang jalan sebelum 02:00, supaya
hasil dump-nya ikut ter-backup.

### ⚠️ Flashdisk bukan medium backup yang andal

Flash drive punya siklus tulis terbatas dan **mati mendadak tanpa
peringatan** — tidak ada SMART seperti SSD/HDD. Untuk backup yang ditulis
tiap hari, umurnya bisa cuma 1–2 tahun.

Flashdisk tetap jauh lebih baik daripada tidak ada backup. Tapi untuk data
yang benar-benar penting, pakai **HDD eksternal** (~Rp 400rb/1TB, bisa
dimonitor kesehatannya), dan idealnya satu salinan lagi di luar rumah
atau cloud.

---

## Langkah 7 — Konek dari MacBook

```bash
ssh <username>@<ip-server>
```

IP-nya ditampilkan di akhir script. Sejak titik ini laptopnya bisa lu
tutup dan taruh di pojokan — semua dikelola dari MacBook.

Verifikasi sleep benar-benar mati:

```bash
systemctl status sleep.target     # harus muncul 'masked'
```

Lalu tutup layar laptopnya ~1 menit, dan coba `ssh` lagi dari MacBook.
Kalau masih nyambung, berhasil.

---

## Catatan khusus Asus K42F

**Spek terpasang:** Core i3-370M (2 core / 4 thread), RAM 8 GB, SSD,
Intel HD Graphics (Ironlake), LAN 10/100, WiFi b/g/n, chipset HM55.

**Baterai — BARU, jadi BIARKAN terpasang.** Baterai sehat = UPS gratis.
Mati lampu, server tetap jalan. Konsekuensinya: baterai yang ditahan di
100% terus akan aus dalam 1–2 tahun. K42F terlalu tua untuk punya fitur
batas pengisian, jadi ini tidak bisa dicegah dari software. Anggap sebagai
harga dari UPS gratis.

**Panas — ini risiko utama lu.** Heatsink K42F umur 15 tahun hampir pasti
mampet debu dan thermal paste-nya sudah kering. Nyala 24/7 dalam kondisi
itu = throttling terus-menerus. **Bersihkan kipas + ganti thermal paste
sebelum dipakai 24/7.** Pantau dengan `sensors`; kalau idle sudah di atas
60 °C, itu tanda perlu dibersihkan.

**Posisi:** jangan ditumpuk atau masuk lemari tertutup. Ventilasi K42F ada
di bawah dan samping kiri — taruh terbuka, sedikit diangkat.

**RAM 8 GB sudah maksimum** yang didukung HM55 di K42F. Tidak ada jalur
upgrade lagi — tapi 8 GB memang sudah lega untuk server.

### Batasan yang perlu disadari: LAN cuma 10/100

Transfer file maksimal **~12 MB/s**. SSD lu mampu 500 MB/s, tapi jaringannya
yang membatasi. Untuk web server, Docker, ngoding, belajar Linux — tidak
masalah. Tapi kalau dipakai sebagai NAS/file server, ini terasa.

Solusi murah: **USB-to-Gigabit-Ethernet adapter** (~Rp 80–150rb). USB 2.0
di K42F membatasi di ~30–40 MB/s, tapi itu masih 3x lebih cepat dari onboard.
Cari chipset **ASIX AX88179** atau **Realtek RTL8153** — dua-duanya didukung
kernel Linux tanpa install driver.

Untuk WiFi: pakai kabel LAN kalau bisa. WiFi b/g/n di laptop ini lebih
lambat dan kurang stabil untuk mesin yang nyala 24/7.

### Grafis: kenapa X11, bukan Wayland

Intel HD Graphics generasi Ironlake di K42F bermasalah di Wayland. Mint 22.3
XFCE masih pakai **X11**, jadi aman. Ini salah satu alasan tidak menunggu
Mint 23 — versi itu akan mendorong Wayland.
