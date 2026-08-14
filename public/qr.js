// qr.js — generator QR Code minimal, tanpa dependency luar.
// Port langsung dari algoritma QR Code Model 2 (ISO/IEC 18004), mode Byte saja
// (cukup untuk URI otpauth:// dipakai halaman 2FA). Referensi silang terhadap
// nayuki/QR-Code-generator (implementasi acuan yang sudah teruji luas) untuk
// memastikan tabel Reed-Solomon, posisi alignment pattern, dan bit format info
// benar — bagian-bagian itu paling gampang salah kalau ditulis dari ingatan.
(function (root) {
  'use strict';

  const MIN_VERSION = 1, MAX_VERSION = 40;
  const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  // index 0 = padding (tidak dipakai), lalu versi 1..40
  const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
  ];
  const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];
  // ordinal + formatBits per level (sama seperti spec: L=1, M=0, Q=3, H=2)
  const ECL = { L: { ord: 0, fmt: 1 }, M: { ord: 1, fmt: 0 }, Q: { ord: 2, fmt: 3 }, H: { ord: 3, fmt: 2 } };

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }
  function appendBits(val, len, bb) { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); }

  function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, eclOrd) {
    return Math.floor(getNumRawDataModules(ver) / 8)
      - ECC_CODEWORDS_PER_BLOCK[eclOrd][ver] * NUM_ERROR_CORRECTION_BLOCKS[eclOrd][ver];
  }

  // GF(2^8/0x11D), perkalian Russian-peasant — sama seperti referensi.
  function rsMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsComputeDivisor(degree) {
    const result = new Array(degree - 1).fill(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }
  function rsComputeRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor); });
    }
    return result;
  }

  function getAlignmentPatternPositions(ver) {
    if (ver === 1) return [];
    const size = ver * 4 + 17;
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function addEccAndInterleave(data, ver, eclOrd) {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eclOrd][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[eclOrd][ver];
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - rawCodewords % numBlocks;
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const rsDiv = rsComputeDivisor(blockEccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = data.slice(k, k + len);
      k += dat.length;
      const ecc = rsComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
      });
    }
    return result;
  }

  // Membuat objek QR dari byte array. grid[row][col] = true (gelap) / false (terang).
  function makeQr(dataBytes, opts) {
    opts = opts || {};
    const boostEcl = opts.boostEcl !== false;
    let eclName = opts.ecl || 'M';

    let version, dataUsedBits;
    outer:
    for (version = opts.minVersion || MIN_VERSION; version <= (opts.maxVersion || MAX_VERSION); version++) {
      const charCountBits = version <= 9 ? 8 : 16; // mode Byte: [8,16,16] per rentang versi
      const usedBits = 4 + charCountBits + dataBytes.length * 8;
      if (usedBits <= getNumDataCodewords(version, ECL[eclName].ord) * 8) { dataUsedBits = usedBits; break outer; }
    }
    if (dataUsedBits === undefined) throw new Error('Data terlalu panjang untuk QR code');

    if (boostEcl) {
      for (const cand of ['M', 'Q', 'H']) {
        if (dataUsedBits <= getNumDataCodewords(version, ECL[cand].ord) * 8) eclName = cand;
      }
    }
    const eclOrd = ECL[eclName].ord;

    const bb = [];
    appendBits(4, 4, bb); // mode Byte = 0100
    appendBits(dataBytes.length, version <= 9 ? 8 : 16, bb);
    for (const b of dataBytes) appendBits(b, 8, bb);
    const capBits = getNumDataCodewords(version, eclOrd) * 8;
    appendBits(0, Math.min(4, capBits - bb.length), bb);
    while (bb.length % 8 !== 0) bb.push(0);
    for (let pad = 0xec; bb.length < capBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bb);

    const dataCodewords = new Array(Math.ceil(bb.length / 8)).fill(0);
    bb.forEach((bit, i) => { dataCodewords[i >>> 3] |= bit << (7 - (i & 7)); });

    return buildMatrix(version, eclOrd, ECL[eclName].fmt, dataCodewords, opts.mask);
  }

  function buildMatrix(version, eclOrd, eclFmtBits, dataCodewords, forcedMask) {
    const size = version * 4 + 17;
    const grid = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    function set(row, col, dark) {
      if (row < 0 || col < 0 || row >= size || col >= size) return;
      grid[row][col] = !!dark;
      isFn[row][col] = true;
    }

    // Timing pattern (digambar dulu, nanti sebagian tertimpa finder/alignment — sesuai referensi)
    for (let i = 0; i < size; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }

    function drawFinder(cr, cc) {
      for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        set(cr + dr, cc + dc, dist !== 2 && dist !== 4);
      }
    }
    drawFinder(3, 3); drawFinder(3, size - 4); drawFinder(size - 4, 3);

    const align = getAlignmentPatternPositions(version);
    const n = align.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      const cr = align[j], cc = align[i];
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        set(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }

    function drawFormatBits(mask) {
      const data = (eclFmtBits << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) set(i, 8, getBit(bits, i));
      set(7, 8, getBit(bits, 6));
      set(8, 8, getBit(bits, 7));
      set(8, 7, getBit(bits, 8));
      for (let i = 9; i < 15; i++) set(8, 14 - i, getBit(bits, i));
      for (let i = 0; i < 8; i++) set(8, size - 1 - i, getBit(bits, i));
      for (let i = 8; i < 15; i++) set(size - 15 + i, 8, getBit(bits, i));
      set(size - 8, 8, true); // modul gelap permanen
    }
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const color = getBit(bits, i);
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(b, a, color); set(a, b, color);
      }
    }
    drawFormatBits(0); // placeholder, ditimpa setelah mask final dipilih

    // Data + EC codewords, interleaved
    const allCodewords = addEccAndInterleave(dataCodewords, version, eclOrd);
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? size - 1 - vert : vert;
          if (!isFn[row][col] && bitIndex < allCodewords.length * 8) {
            grid[row][col] = getBit(allCodewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
        if (isFn[row][col]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (col + row) % 2 === 0; break;
          case 1: invert = row % 2 === 0; break;
          case 2: invert = col % 3 === 0; break;
          case 3: invert = (col + row) % 3 === 0; break;
          case 4: invert = (Math.floor(col / 3) + Math.floor(row / 2)) % 2 === 0; break;
          case 5: invert = (col * row) % 2 + (col * row) % 3 === 0; break;
          case 6: invert = ((col * row) % 2 + (col * row) % 3) % 2 === 0; break;
          case 7: invert = (((col + row) % 2) + (col * row) % 3) % 2 === 0; break;
        }
        if (invert) grid[row][col] = !grid[row][col];
      }
    }

    function addHist(len, hist) { if (hist[0] === 0) len += size; hist.pop(); hist.unshift(len); }
    function countPatterns(hist) {
      const n = hist[1];
      const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
      return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
    }
    function terminate(color, len, hist) {
      if (color) { addHist(len, hist); len = 0; }
      len += size; addHist(len, hist);
      return countPatterns(hist);
    }
    function penalty() {
      let result = 0;
      for (let row = 0; row < size; row++) {
        let runColor = false, runLen = 0, hist = [0, 0, 0, 0, 0, 0, 0];
        for (let col = 0; col < size; col++) {
          if (grid[row][col] === runColor) {
            runLen++;
            if (runLen === 5) result += PENALTY_N1; else if (runLen > 5) result++;
          } else {
            addHist(runLen, hist);
            if (!runColor) result += countPatterns(hist) * PENALTY_N3;
            runColor = grid[row][col]; runLen = 1;
          }
        }
        result += terminate(runColor, runLen, hist) * PENALTY_N3;
      }
      for (let col = 0; col < size; col++) {
        let runColor = false, runLen = 0, hist = [0, 0, 0, 0, 0, 0, 0];
        for (let row = 0; row < size; row++) {
          if (grid[row][col] === runColor) {
            runLen++;
            if (runLen === 5) result += PENALTY_N1; else if (runLen > 5) result++;
          } else {
            addHist(runLen, hist);
            if (!runColor) result += countPatterns(hist) * PENALTY_N3;
            runColor = grid[row][col]; runLen = 1;
          }
        }
        result += terminate(runColor, runLen, hist) * PENALTY_N3;
      }
      for (let row = 0; row < size - 1; row++) for (let col = 0; col < size - 1; col++) {
        const c = grid[row][col];
        if (c === grid[row][col + 1] && c === grid[row + 1][col] && c === grid[row + 1][col + 1]) result += PENALTY_N2;
      }
      let dark = 0;
      for (const r of grid) for (const c of r) if (c) dark++;
      const total = size * size;
      const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      result += Math.max(0, k) * PENALTY_N4;
      return result;
    }

    let bestMask = forcedMask;
    if (bestMask === undefined || bestMask < 0) {
      let minPenalty = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m); drawFormatBits(m);
        const p = penalty();
        if (p < minPenalty) { minPenalty = p; bestMask = m; }
        applyMask(m); // undo (XOR dua kali)
      }
    }
    applyMask(bestMask);
    drawFormatBits(bestMask);

    return {
      size,
      isDark: (row, col) => grid[row][col],
    };
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    return Array.from(Buffer.from(str, 'utf8'));
  }

  const QR = {
    generate(text, opts) { return makeQr(utf8Bytes(text), opts); },
    // Menggambar ke <canvas>, quiet zone 4 modul, skala otomatis.
    draw(canvas, text, opts) {
      const qr = QR.generate(text, opts);
      const scale = (opts && opts.scale) || 6;
      const margin = 4 * scale;
      const px = qr.size * scale + margin * 2;
      canvas.width = px; canvas.height = px;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = '#000';
      for (let row = 0; row < qr.size; row++) for (let col = 0; col < qr.size; col++) {
        if (qr.isDark(row, col)) ctx.fillRect(margin + col * scale, margin + row * scale, scale, scale);
      }
      return qr;
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  else root.QR = QR;
})(typeof window !== 'undefined' ? window : globalThis);
