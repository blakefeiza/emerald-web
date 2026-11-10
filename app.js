import mGBA from './mgba.js';
import { applyPatch, detectFormat, unzip, romInfo, crc32, hex8 } from './patcher.js';

const $ = id => document.getElementById(id);
const CFG = window.GBA_CONFIG || {};
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // 32 characters, no lookalikes
const SAVE_SIZES = [512, 8192, 32768, 65536, 131072];     // EEPROM, SRAM and flash sizes
let M = null, cur = null, running = false, lastSave = null, muted = false, ffOn = false, wake = null;

try { muted = localStorage.getItem('muted') === '1'; } catch (e) {}
try { indexedDB.deleteDatabase('emerald-web'); } catch (e) {}   // earlier prototype's cache

// ================= storage: your games live in this browser only =================
const dbp = new Promise((res, rej) => { const r = indexedDB.open('gba-patch-play', 1); r.onupgradeneeded = () => r.result.createObjectStore('games', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = async (mode, fn) => { const db = await dbp; return new Promise((res, rej) => { const t = db.transaction('games', mode), q = fn(t.objectStore('games')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
const gamesAll = () => tx('readonly', s => s.getAll()), gamePut = g => tx('readwrite', s => s.put(g)), gameDel = id => tx('readwrite', s => s.delete(id));
let games = [];

const fmtMB = n => (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function msg(el, text, kind) { el.hidden = !text; el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }

// ================= library UI =================
async function refreshLibrary() {
  try { games = (await gamesAll()).sort((a, b) => b.added - a.added); } catch (e) { games = []; }
  $('library').hidden = !games.length;
  $('games').innerHTML = games.map(g => '<div class="game"><div class="gi"><b>' + esc(g.name) + '</b><small>' + (g.kind === 'patched' ? 'Patched' : 'ROM') + ' &middot; ' + esc(g.code || '----') + ' &middot; ' + fmtMB(g.size) + '</small></div><button class="btn" data-play="' + g.id + '">Play</button><button class="x" data-del="' + g.id + '">Remove</button></div>').join('');
  $('patchBase').innerHTML = games.length ? games.map(g => '<option value="' + g.id + '">' + esc(g.name) + '</option>').join('') : '<option value="">Add a ROM first (step 1)</option>';
  updatePatchBtn();
}
$('games').addEventListener('click', async e => {
  const p = e.target.closest('[data-play]'), d = e.target.closest('[data-del]');
  if (p) play(p.dataset.play);
  if (d) { const g = games.find(x => x.id === d.dataset.del); if (g && confirm('Remove "' + g.name + '" from this browser? Your saves for it are kept.')) { await gameDel(g.id); refreshLibrary(); } }
});

// ================= adding ROMs and patches =================
let patchData = null;
const looksLikeRom = (u8, name) => u8.length >= 0x100000 / 4 && u8.length <= 64 * 1048576 && (/\.gba$/i.test(name) || romInfo(u8).headerOk);
async function classify(file, want) {            // -> { type: 'rom'|'patch', data, name }
  let u8 = new Uint8Array(await file.arrayBuffer()), name = file.name;
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const ents = await unzip(u8);
    const rom = ents.find(e => /\.gba$/i.test(e.name)), pat = ents.find(e => detectFormat(e.data) || /\.(ips|bps|ups|xdelta)$/i.test(e.name));
    const pick = want === 'patch' ? (pat || rom) : want === 'rom' ? (rom || pat) : (rom || pat);
    if (!pick) throw new Error('That zip has no .gba ROM or patch file inside.');
    u8 = pick.data; name = pick.name.split('/').pop();
  }
  if (detectFormat(u8) || /\.(ips|bps|ups|xdelta)$/i.test(name)) return { type: 'patch', data: u8, name };
  if (looksLikeRom(u8, name)) return { type: 'rom', data: u8, name };
  throw new Error('That file is not a GBA ROM or an IPS / BPS / UPS patch.');
}
async function addGame(u8, name, kind) {
  const info = romInfo(u8), id = hex8(info.crc);
  await gamePut({ id, name, kind, code: info.code, title: info.title, size: u8.length, crc: info.crc, added: Date.now(), blob: new Blob([u8]) });
  await refreshLibrary();
  return info;
}
async function addRom(c) {
  const name = c.name.replace(/\.gba$/i, '').replace(/[_]+/g, ' ');
  const info = await addGame(c.data, name, 'rom');
  const bits = ['Added "' + name + '" (' + (info.title || 'no title') + ', ' + (info.code || '----') + ', ' + fmtMB(c.data.length) + ').'];
  bits.push(info.known ? 'Matches the ' + info.known + ' dump, a good base for hacks.' : 'Checksum ' + hex8(info.crc).toUpperCase() + '.');
  if (!info.headerOk) bits.push('Its header check failed, so it may be modified or not a normal GBA ROM.');
  msg($('romMsg'), bits.join(' '), info.headerOk ? 'ok' : '');
}
function setPatch(c) {
  patchData = c;
  $('patchFileLabel').textContent = c.name + ' (' + (detectFormat(c.data) || 'patch').toUpperCase() + ')';
  if (!$('patchName').value) $('patchName').value = c.name.replace(/\.(ips|bps|ups|xdelta)$/i, '').replace(/[_]+/g, ' ');
  updatePatchBtn();
}
function updatePatchBtn() { $('applyBtn').disabled = !(patchData && $('patchBase').value); }
$('patchBase').onchange = updatePatchBtn;

async function handleFiles(files, want) {
  for (const f of files) {
    try {
      const c = await classify(f, want);
      if (c.type === 'rom') { await addRom(c); document.getElementById('step1').scrollIntoView({ block: 'nearest' }); }
      else { setPatch(c); msg($('patchMsg'), ''); document.getElementById('step2').scrollIntoView({ block: 'nearest' }); }
    } catch (e) { msg(want === 'patch' ? $('patchMsg') : $('romMsg'), e.message, 'err'); }
  }
}
$('romFile').onchange = e => { handleFiles(e.target.files, 'rom'); e.target.value = ''; };
$('patchFile').onchange = e => { handleFiles(e.target.files, 'patch'); e.target.value = ''; };
['dragenter', 'dragover'].forEach(t => addEventListener(t, e => { if (!$('home').hidden) { e.preventDefault(); document.body.classList.add('dragging'); } }));
['dragleave', 'drop'].forEach(t => addEventListener(t, e => { e.preventDefault(); document.body.classList.remove('dragging'); }));
addEventListener('drop', e => { if (!$('home').hidden && e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files, 'any'); });

$('applyBtn').onclick = async () => {
  const base = games.find(g => g.id === $('patchBase').value);
  if (!base || !patchData) return;
  $('applyBtn').disabled = true; msg($('patchMsg'), 'Patching...');
  try {
    await new Promise(r => setTimeout(r, 30));
    const baseU8 = new Uint8Array(await base.blob.arrayBuffer());
    const res = applyPatch(baseU8, patchData.data);
    const name = ($('patchName').value || patchData.name).trim().slice(0, 60);
    const info = await addGame(res.rom, name, 'patched');
    msg($('patchMsg'), 'Done. "' + name + '" is in Your games (' + fmtMB(res.rom.length) + ', ' + (info.code || '----') + '). ' +
      (res.verified ? 'The patch checksums matched, so the base ROM was the right version.' : 'IPS patches carry no checksum, so this page cannot tell whether the base was the right version. If the game glitches or will not start, try a different base ROM.'), 'ok');
    patchData = null; $('patchFileLabel').textContent = 'Choose a patch file'; $('patchName').value = '';
  } catch (e) { msg($('patchMsg'), e.message, 'err'); }
  updatePatchBtn();
};

// ================= views =================
function show(view) {
  $('home').hidden = view !== 'home'; $('play').hidden = view !== 'play';
  document.body.classList.toggle('playing', view === 'play');
  scrollTo(0, 0);
}
const setStatus = t => { $('status').textContent = t; };
function overlay(html, opts = {}) {
  const o = $('overlay'), b = $('overlayBody'); o.hidden = !html; if (!html) return;
  b.innerHTML = '<p>' + html + '</p>' + (opts.bar ? '<div class="bar2"><i></i></div>' : '') + (opts.back ? '<button class="btn" id="ovBack">Back to games</button>' : '');
  if (opts.back) $('ovBack').onclick = back;
}
const bar = f => { const i = $('overlayBody').querySelector('.bar2 i'); if (i) i.style.width = Math.round(f * 100) + '%'; };

// ================= emulator =================
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out while ' + what + '.')), ms))]);
async function init() {
  M = await mGBA({ canvas: $('screen') });
  await M.FSInit();
  M.addCoreCallbacks({ saveDataUpdatedCallback: onSaveData });
  window.__gba = { M, get cur() { return cur; }, get lastSave() { return lastSave; }, restore };
}
let saveTimer = null;
function onSaveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { lastSave = M.getSave(); } catch (e) {}
    if (lastSave && !isBlank(lastSave)) { $('saveBtn').disabled = false; setStatus('Saved'); setTimeout(() => running && setStatus('Playing'), 2500); }
    try { M.FSSync(); } catch (e) {}
  }, 1200);
}
const isBlank = u8 => { for (let i = 0; i < u8.length; i++) if (u8[i] !== 0xff && u8[i] !== 0) return false; return true; };
const romPath = () => M.filePaths().gamePath + '/' + cur.id + '.gba', savPath = () => M.filePaths().savePath + '/' + cur.id + '.sav';

function startCore() {
  const ok = M.loadGame(romPath(), savPath());
  if (!ok) throw new Error('The emulator could not start this ROM. It may be damaged or not a GBA game.');
  running = true; overlay('');
  try { M.setVolume(muted ? 0 : 1); M.setFastForwardMultiplier(ffOn ? 3 : 1); } catch (e) {}
  try { lastSave = M.getSave(); } catch (e) { lastSave = null; }
  $('saveBtn').disabled = !(lastSave && !isBlank(lastSave));
  setStatus('Playing'); keepAwake();
}
async function play(id) {
  const g = games.find(x => x.id === id); if (!g) return;
  cur = { id: g.id, crc: g.crc, name: g.name };
  show('play'); $('gameName').textContent = g.name; $('saveBtn').disabled = true; setStatus('Loading...');
  try {
    if (!self.crossOriginIsolated) throw new Error('ISO');
    if (running) { try { M.quitGame(); } catch (e) {} running = false; }
    if (!M) { overlay('Starting the emulator...', { bar: true }); bar(0.2); await withTimeout(init(), 30000, 'starting the emulator'); }
    overlay('Loading the game...', { bar: true }); bar(0.5);
    const u8 = new Uint8Array(await g.blob.arrayBuffer());
    for (const f of M.listRoms()) if (f !== g.id + '.gba') { try { M.FS.unlink(M.filePaths().gamePath + '/' + f); } catch (e) {} }
    await withTimeout(new Promise(r => M.uploadRom(new File([u8], g.id + '.gba'), r)), 30000, 'loading the game');
    bar(0.9); startCore();
  } catch (e) {
    running = false;
    const iso = e.message === 'ISO';
    setStatus(iso ? 'Browser setup needed' : 'Something went wrong');
    overlay(iso ? 'Your browser has not enabled the emulator yet. Reload this page once. If it still stalls, open it in a normal (not private) Chrome, Edge, Firefox or Safari window with service workers allowed.' : esc('Could not start: ' + e.message), { back: true });
  }
}
function back() {
  if (running) { try { M.quitGame(); } catch (e) {} try { M.FSSync(); } catch (e) {} }
  running = false; release(); show('home'); overlay('');
}
$('back').onclick = back;

async function keepAwake() { try { if (navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) {} }
const release = () => { try { wake && wake.release(); } catch (e) {} wake = null; };
document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.hidden) { try { M.pauseGame(); } catch (e) {} releaseKeys(); }
  else if (!$('saves').open) { try { M.resumeGame(); } catch (e) {} keepAwake(); }
});
$('ff').onclick = () => { ffOn = !ffOn; $('ff').setAttribute('aria-pressed', ffOn); if (running) M.setFastForwardMultiplier(ffOn ? 3 : 1); };
function paintMute() { $('mute').setAttribute('aria-pressed', muted); $('mute').innerHTML = muted ? '&#128263;' : '&#128266;'; }
$('mute').onclick = () => { muted = !muted; try { localStorage.setItem('muted', muted ? '1' : '0'); } catch (e) {} paintMute(); if (running) M.setVolume(muted ? 0 : 1); };
paintMute();

// ================= controls: keyboard, touch pad, d-pad =================
const held = new Set();
const press = b => { if (!running || held.has(b)) return; held.add(b); M.buttonPress(b); if (navigator.vibrate && document.body.classList.contains('touch')) navigator.vibrate(6); };
const lift = b => { if (!held.has(b)) return; held.delete(b); if (running) M.buttonUnpress(b); };
const releaseKeys = () => { [...held].forEach(lift); document.querySelectorAll('.pb.down,#dpad span.on').forEach(el => el.classList.remove('down', 'on')); };
const KEYMAP = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', z: 'A', Z: 'A', x: 'B', X: 'B', a: 'L', A: 'L', s: 'R', S: 'R', Enter: 'Start', Backspace: 'Select' };
addEventListener('keydown', e => {
  if (!running || $('saves').open || e.target.tagName === 'INPUT') return;
  if (e.key === ' ') { e.preventDefault(); M.setFastForwardMultiplier(4); return; }
  const b = KEYMAP[e.key]; if (b) { e.preventDefault(); press(b); }
});
addEventListener('keyup', e => {
  if (!running || e.target.tagName === 'INPUT') return;
  if (e.key === ' ') { M.setFastForwardMultiplier(ffOn ? 3 : 1); return; }
  const b = KEYMAP[e.key]; if (b) lift(b);
});
addEventListener('blur', releaseKeys);

document.querySelectorAll('.pb').forEach(btn => {
  const b = btn.dataset.b;
  btn.addEventListener('pointerdown', e => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (x) {} btn.classList.add('down'); press(b); });
  const up = () => { btn.classList.remove('down'); lift(b); };
  btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up); btn.addEventListener('lostpointercapture', up);
  btn.addEventListener('contextmenu', e => e.preventDefault());
});
// one touch can slide around the d-pad and change direction without lifting
const dpad = $('dpad'), DIRS = { Up: dpad.querySelector('.u'), Down: dpad.querySelector('.d'), Left: dpad.querySelector('.lf'), Right: dpad.querySelector('.rt') };
function dpadAt(e) {
  const r = dpad.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), t = r.width * 0.16;
  const want = { Left: dx < -t, Right: dx > t, Up: dy < -t, Down: dy > t };
  for (const k in want) { if (want[k]) { press(k); DIRS[k].classList.add('on'); } else { lift(k); DIRS[k].classList.remove('on'); } }
}
dpad.addEventListener('pointerdown', e => { e.preventDefault(); try { dpad.setPointerCapture(e.pointerId); } catch (x) {} dpadAt(e); });
dpad.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') dpadAt(e); });
const dpadUp = () => { for (const k in DIRS) { lift(k); DIRS[k].classList.remove('on'); } };
dpad.addEventListener('pointerup', dpadUp); dpad.addEventListener('pointercancel', dpadUp); dpad.addEventListener('lostpointercapture', dpadUp);
dpad.addEventListener('contextmenu', e => e.preventDefault());
if (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1) document.body.classList.add('touch');

// ================= save codes =================
const ALLOW_RETRIES = 5;
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
const deflate = b => pipe(b, new CompressionStream('deflate-raw')), inflate = b => pipe(b, new DecompressionStream('deflate-raw'));
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), v => ALPHA[v % 32]).join('');
const pretty = c => c.slice(0, 5) + '-' + c.slice(5);
const rpc = (fn, body) => fetch(CFG.supabaseUrl + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => { if (!r.ok) throw new Error(fn + ' ' + r.status); return r.json(); });
const sheetMsg = (t, k) => msg($('sheetMsg'), t, k);
const payload = async sv => hex8(cur.crc) + ':' + b64(await deflate(sv));       // game fingerprint + compressed save
async function unpayload(s) {                                                    // accepts 'crc:data' or legacy plain data
  s = s.trim(); const i = s.indexOf(':'); const crc = i === 8 ? s.slice(0, 8) : '';
  return { crc, bytes: await inflate(unb64(i === 8 ? s.slice(9) : s)) };
}
const currentSave = () => { try { return M.getSave() || lastSave; } catch (e) { return lastSave; } };

$('saveBtn').onclick = () => { sheetMsg(''); $('codeOut').textContent = ''; try { M.pauseGame(); } catch (e) {} $('saves').showModal(); };
$('saves').addEventListener('close', () => { if (running) { try { M.resumeGame(); } catch (e) {} } });
$('getCode').onclick = async () => {
  const sv = currentSave();
  if (!sv || isBlank(sv)) return sheetMsg('Nothing saved yet. Save inside the game first.', 'err');
  $('getCode').disabled = true; sheetMsg('Creating code...');
  try {
    const data = await payload(sv); let code = '', ok = false;
    for (let i = 0; i < ALLOW_RETRIES && !ok; i++) { code = newCode(); ok = await rpc('put_save', { p_code: code, p_data: data }); }
    if (!ok) throw new Error('no code');
    $('codeOut').textContent = pretty(code);
    let copied = false; try { await navigator.clipboard.writeText(code); copied = true; } catch (e) {}
    sheetMsg(copied ? 'Code copied. Keep it somewhere safe.' : 'Write this code down.', 'ok');
  } catch (e) { sheetMsg('Could not reach the save server. Use "Copy full save text" or "Download .sav" instead.', 'err'); }
  $('getCode').disabled = false;
};
$('loadCode').onclick = async () => {
  const code = $('codeIn').value.toUpperCase().replace(/[^A-Z2-9]/g, '');
  if (code.length !== 10) return sheetMsg('Codes have 10 letters and numbers.', 'err');
  sheetMsg('Looking up...');
  try {
    const data = await rpc('get_save', { p_code: code });
    if (!data) return sheetMsg('No save found for that code.', 'err');
    await restoreFrom(await unpayload(data));
  } catch (e) { sheetMsg(/404/.test(e.message) ? 'Save codes are not switched on for this site yet.' : 'Could not load: ' + e.message, 'err'); }
};
$('codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('loadCode').click(); } });

async function restoreFrom({ crc, bytes }) {
  if (crc && crc !== hex8(cur.crc) && !confirm('This save was made on a different game or version. Load it anyway? It may not work.')) return sheetMsg('Cancelled.');
  if (!confirm('Replace the progress in "' + cur.name + '" with this save?')) return sheetMsg('Cancelled.');
  await restore(bytes); $('saves').close(); setStatus('Save loaded');
}
async function restore(bytes) {
  if (!SAVE_SIZES.includes(bytes.length)) throw new Error('That does not look like a GBA save (' + bytes.length + ' bytes).');
  try { M.quitGame(); } catch (e) {}
  M.FS.writeFile(savPath(), bytes); await M.FSSync();
  startCore();
}

// ================= file / text backups =================
$('dl').onclick = () => { const sv = currentSave(); if (!sv || isBlank(sv)) return sheetMsg('Nothing saved yet.', 'err'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([sv])); a.download = cur.name.replace(/[^\w.-]+/g, '_') + '.sav'; a.click(); };
$('savFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) try { await restoreFrom({ crc: '', bytes: new Uint8Array(await f.arrayBuffer()) }); } catch (er) { sheetMsg(er.message, 'err'); } };
$('copyFull').onclick = async () => {
  const sv = currentSave(); if (!sv || isBlank(sv)) return sheetMsg('Nothing saved yet.', 'err');
  const t = 'GBS1:' + await payload(sv);
  try { await navigator.clipboard.writeText(t); sheetMsg('Full save text copied (' + t.length + ' characters).', 'ok'); } catch (e) { prompt('Copy this', t); }
};
$('pasteFull').onclick = async () => {
  let t = ''; try { t = await navigator.clipboard.readText(); } catch (e) {}
  if (!/^(GBS1|EMS1):/.test(t)) t = prompt('Paste full save text') || '';
  if (!/^(GBS1|EMS1):/.test(t)) return sheetMsg('That is not save text.', 'err');
  try { await restoreFrom(await unpayload(t.slice(5))); } catch (e) { sheetMsg(e.message, 'err'); }
};

// ================= boot =================
refreshLibrary();
if (!self.crossOriginIsolated) console.info('Waiting for cross-origin isolation (the service worker reloads the page once).');
