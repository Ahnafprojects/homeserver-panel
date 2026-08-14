FROM node:20-alpine
WORKDIR /app

# docker-cli + compose  -> deploy stack
# git                   -> clone/pull/checkout dari web
# util-linux (nsenter)  -> terminal host & perintah daya
RUN apk add --no-cache docker-cli docker-cli-compose git util-linux openssh-client ca-certificates \
    postgresql17-client mariadb-client

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node","src/server.js"]
