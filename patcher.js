// In-browser ROM patching: IPS, UPS and BPS, plus a small zip reader and GBA header info. No dependencies.
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TABLE[i] = c >>> 0; }

export function crc32(u8, start = 0, end = u8.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');
const le32 = (u, o) => (u[o] | u[o + 1] << 8 | u[o + 2] << 16 | u[o + 3] << 24) >>> 0;
const WRONG_BASE = 'This patch was made for a different base ROM. Check that you picked the exact game version the hack asks for.';

export function detectFormat(p) {
  if (p.length < 5) return null;
  const s = String.fromCharCode(p[0], p[1], p[2], p[3], p[4]);
  if (s === 'PATCH') return 'ips';
  if (s.startsWith('BPS1')) return 'bps';
  if (s.startsWith('UPS1')) return 'ups';
  if (p[0] === 0xD6 && p[1] === 0xC3 && p[2] === 0xC4) return 'xdelta';
  return null;
}

function readVar(p, st) {
  let data = 0, shift = 1;
  for (;;) {
    if (st.i >= p.length) throw new Error('The patch file is cut off or damaged.');
    const x = p[st.i++];
    data += (x & 0x7f) * shift;
    if (x & 0x80) break;
    shift *= 128; data += shift;
  }
  return data;
}

function ips(rom, p) {
  let pos = 5, size = rom.length; const recs = [];
  for (;;) {
    if (pos + 3 > p.length) throw new Error('The patch file is cut off or damaged.');
    if (p[pos] === 0x45 && p[pos + 1] === 0x4F && p[pos + 2] === 0x46) { pos += 3; break; }
    if (pos + 5 > p.length) throw new Error('The patch file is cut off or damaged.');
    const off = p[pos] << 16 | p[pos + 1] << 8 | p[pos + 2], len = p[pos + 3] << 8 | p[pos + 4]; pos += 5;
    if (len === 0) {
      if (pos + 3 > p.length) throw new Error('The patch file is cut off or damaged.');
      const n = p[pos] << 8 | p[pos + 1], v = p[pos + 2]; pos += 3;
      recs.push([off, n, v, null]); size = Math.max(size, off + n);
    } else {
      if (pos + len > p.length) throw new Error('The patch file is cut off or damaged.');
      recs.push([off, len, 0, p.subarray(pos, pos + len)]); pos += len; size = Math.max(size, off + len);
    }
  }
  const trunc = pos + 3 <= p.length ? (p[pos] << 16 | p[pos + 1] << 8 | p[pos + 2]) : null;
  const out = new Uint8Array(size); out.set(rom);
  for (const [o, n, v, d] of recs) { if (d) out.set(d, o); else out.fill(v, o, o + n); }
  return trunc !== null && trunc > 0 && trunc < out.length ? out.slice(0, trunc) : out;
}

function ups(rom, p) {
  if (p.length < 18) throw new Error('The patch file is cut off or damaged.');
  const st = { i: 4 }; let inSize = readVar(p, st), outSize = readVar(p, st);
  const end = p.length - 12, inCrc = le32(p, end), outCrc = le32(p, end + 4), pCrc = le32(p, end + 8);
  if (crc32(p, 0, p.length - 4) !== pCrc) throw new Error('The patch file is damaged (its checksum does not match).');
  const rc = crc32(rom);
  if (rc === inCrc) { /* forward */ } else if (rc === outCrc) { [inSize, outSize] = [outSize, inSize]; } else throw new Error(WRONG_BASE);
  const out = new Uint8Array(outSize); out.set(rom.subarray(0, Math.min(rom.length, outSize)));
  let pos = 0;
  while (st.i < end) {
    pos += readVar(p, st);
    for (;;) { if (st.i >= end + 0) break; const b = p[st.i++]; if (pos < outSize) out[pos] ^= b; pos++; if (b === 0) break; }
  }
  return out;
}

function bps(rom, p) {
  if (p.length < 19) throw new Error('The patch file is cut off or damaged.');
  const st = { i: 4 }, srcSize = readVar(p, st), tgtSize = readVar(p, st), meta = readVar(p, st); st.i += meta;
  const end = p.length - 12, srcCrc = le32(p, end), tgtCrc = le32(p, end + 4), pCrc = le32(p, end + 8);
  if (crc32(p, 0, p.length - 4) !== pCrc) throw new Error('The patch file is damaged (its checksum does not match).');
  if (rom.length !== srcSize || crc32(rom) !== srcCrc) throw new Error(WRONG_BASE);
  const out = new Uint8Array(tgtSize); let o = 0, sRel = 0, tRel = 0;
  while (st.i < end) {
    const d = readVar(p, st), cmd = d % 4, len = Math.floor(d / 4) + 1;
    if (o + len > tgtSize) throw new Error('The patch file is damaged.');
    if (cmd === 0) { for (let k = 0; k < len; k++) out[o + k] = rom[o + k]; o += len; }
    else if (cmd === 1) { if (st.i + len > end) throw new Error('The patch file is damaged.'); out.set(p.subarray(st.i, st.i + len), o); st.i += len; o += len; }
    else if (cmd === 2) { const x = readVar(p, st); sRel += (x & 1 ? -1 : 1) * Math.floor(x / 2); for (let k = 0; k < len; k++) out[o++] = rom[sRel++]; }
    else { const x = readVar(p, st); tRel += (x & 1 ? -1 : 1) * Math.floor(x / 2); for (let k = 0; k < len; k++) out[o++] = out[tRel++]; }
  }
  if (crc32(out) !== tgtCrc) throw new Error('The patched ROM failed its own checksum. The base ROM may be the wrong version.');
  return out;
}

// returns { rom, format, verified } where verified means the patch format carried checksums that all matched
export function applyPatch(rom, patch) {
  const f = detectFormat(patch);
  if (f === 'xdelta') throw new Error('This is an xdelta patch, which this page cannot apply yet. Look for an IPS, BPS or UPS version of the patch.');
  if (!f) throw new Error('That does not look like an IPS, BPS or UPS patch.');
  const out = f === 'ips' ? ips(rom, patch) : f === 'ups' ? ups(rom, patch) : bps(rom, patch);
  return { rom: out, format: f, verified: f !== 'ips' };
}

// ---- zip (stored + deflate) ----
export async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('That zip file could not be read.');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const ds = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true), raw = u8.subarray(ds, ds + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    out.push({ name, data });
  }
  return out;
}

// ---- GBA header ----
const KNOWN_CRC = { '1f1c08fb': 'Pokemon Emerald (USA, Europe), unmodified' };   // checked against a real dump
export function romInfo(u8) {
  const txt = (a, b) => { let s = ''; for (let i = a; i < b; i++) { if (u8[i] === 0) break; s += String.fromCharCode(u8[i]); } return s.trim(); };
  let sum = 0; for (let i = 0xA0; i <= 0xBC; i++) sum += u8[i];
  const code = txt(0xAC, 0xB0), headerOk = u8.length > 0xC0 && ((-(sum + 0x19)) & 0xFF) === u8[0xBD];
  const crc = crc32(u8);
  return { title: txt(0xA0, 0xAC), code, headerOk, known: KNOWN_CRC[hex8(crc)] || '', size: u8.length, crc };
}
