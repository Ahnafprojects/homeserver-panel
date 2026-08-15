FROM node:20-alpine
WORKDIR /app

# docker-cli + compose  -> deploy stack
# git                   -> clone/pull/checkout dari web
# util-linux (nsenter)  -> terminal host & perintah daya
RUN apk add --no-cache docker-cli docker-cli-compose git util-linux openssh-client ca-certificates \
    postgresql17-client mariadb-client

COPY package.json ./
# node-pty butuh kompilasi native (ioctl TIOCSWINSZ buat resize PTY terminal
# host beneran) — toolchain-nya cuma dipakai sekali di sini lalu dibuang,
# tidak nambah ukuran image akhir.
# Unduhan header Node.js buat kompilasinya (ke unofficial-builds.nodejs.org,
# khusus musl/Alpine) kadang lambat di koneksi rumahan dan kena timeout
# default node-gyp (~30 detik) sebelum sempat selesai — naikkan batas waktu
# & jumlah percobaan ulang, plus retry seluruh langkah kalau tetap gagal.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm config set fetch-timeout 300000 fetch-retries 5 fetch-retry-maxtimeout 120000 \
    && ( npm install --omit=dev --no-audit --no-fund \
      || (sleep 5  && npm install --omit=dev --no-audit --no-fund) \
      || (sleep 20 && npm install --omit=dev --no-audit --no-fund) ) \
    && apk del .build-deps
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node","src/server.js"]
