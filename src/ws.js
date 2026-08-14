// WebSocket minimal (RFC 6455) — cukup untuk terminal web.
// Ditulis sendiri supaya tidak menambah dependency; hanya butuh
// frame teks/biner tanpa ekstensi kompresi.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';

export function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const hash = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${hash}\r\n\r\n`
  );
  socket.setNoDelay(true);
  return new WS(socket, head);
}

class WS {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.onMessage = null;
    this.onClose = null;
    this.closed = false;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    socket.on('close', () => this._end());
    socket.on('error', () => this._end());
    this._ping = setInterval(() => this._frame(0x9, Buffer.alloc(0)), 25000);
  }

  _end() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._ping);
    this.onClose?.();
  }

  _parse() {
    while (this.buf.length >= 2) {
      const b = this.buf;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < off + 2) return; len = b.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (b.length < off + 8) return; len = Number(b.readBigUInt64BE(off)); off += 8; }
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.slice(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let payload = b.slice(off, off + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = b.slice(off + len);

      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._frame(0xa, payload); continue; }   // ping -> pong
      if (op === 0xa) continue;                                   // pong
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (!fin) { this._frag = Buffer.concat([this._frag || Buffer.alloc(0), payload]); continue; }
        const full = this._frag ? Buffer.concat([this._frag, payload]) : payload;
        this._frag = null;
        this.onMessage?.(full);
      }
    }
  }

  _frame(op, data) {
    if (this.closed || this.socket.destroyed) return;
    const len = data.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    try { this.socket.write(Buffer.concat([head, data])); } catch {}
  }

  send(str) { this._frame(0x1, Buffer.from(str)); }
  sendBin(buf) { this._frame(0x2, buf); }
  close() {
    if (this.closed) return;
    this._frame(0x8, Buffer.alloc(0));
    try { this.socket.end(); } catch {}
    this._end();
  }
}
