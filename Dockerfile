FROM node:20-alpine
WORKDIR /app

# npm install DULUAN, sebelum daftar paket apk di bawah — node-pty di
# dalamnya butuh kompilasi native yang lambat (unduh header Node.js dari
# unofficial-builds.nodejs.org, sering pelan di koneksi rumahan) dan
# TIDAK BOLEH ke-invalidate cache-nya cuma gara-gara nambah/ganti satu
# paket apk biasa (imagemagick, dst) di bawah — dulu satu baris di situ
# ke-reorder dan bikin node-pty kompilasi ulang dari nol tiap deploy kecil.
COPY package.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm config set fetch-timeout 300000 fetch-retries 5 fetch-retry-maxtimeout 120000 \
    && ( npm install --omit=dev --no-audit --no-fund \
      || (sleep 5  && npm install --omit=dev --no-audit --no-fund) \
      || (sleep 20 && npm install --omit=dev --no-audit --no-fund) ) \
    && apk del .build-deps

# docker-cli + compose      -> deploy stack
# git                       -> clone/pull/checkout dari web
# util-linux (nsenter)      -> terminal host & perintah daya
# imagemagick(-heic/-jpeg)  -> thumbnail Files, termasuk HEIC (foto iPhone) —
#                              paket biner jadi, tidak perlu kompilasi apa pun.
#                              imagemagick-jpeg WAJIB ada terpisah — paket
#                              dasar imagemagick Alpine TIDAK linked ke
#                              libjpeg sama sekali (cuma PNG/GIF), tanpa ini
#                              semua thumbnail "jpg" yang dihasilkan
#                              sebenarnya bukan JPEG asli.
RUN apk add --no-cache docker-cli docker-cli-compose git util-linux openssh-client ca-certificates \
    postgresql17-client mariadb-client imagemagick imagemagick-heic imagemagick-jpeg

COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node","src/server.js"]
