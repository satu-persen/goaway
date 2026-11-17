// ============ KONFIGURASI ============
const CONSONANTS = ['b', 'k', 'l', 'm', 'n', 'p', 's', 't'];
const VOWEL_DEFS = [
  { key: 'a', hint: 'ayah' },
  { key: 'i', hint: 'ibu' },
  { key: 'u', hint: 'ular' },
  { key: 'e', hint: 'emas (pepet)' },
  { key: 'E', hint: 'enak (tegas)' },
  { key: 'o', hint: 'obat' },
];

const EXAMPLE_WORDS = {
  ba: 'bapak', bi: 'bibi', bu: 'buku', be: 'berani (pepet)', bE: 'bebek (tegas)', bo: 'bola',
  ka: 'kaki', ki: 'kini', ku: 'kuku', ke: 'kecil (pepet)', kE: 'kera (tegas)', ko: 'kota',
  la: 'lama', li: 'lilin', lu: 'lupa', le: 'leher (pepet)', lE: 'lémon (tegas)', lo: 'loro',
  ma: 'mama', mi: 'mie', mu: 'muka', me: 'membaca (pepet)', mE: 'meja (tegas)', mo: 'motor',
  na: 'nasi', ni: 'nila', nu: 'nuri', ne: 'neraca (pepet)', nE: 'nék (tegas)', no: 'noda',
  pa: 'papa', pi: 'pipa', pu: 'pulang', pe: 'permisi (pepet)', pE: 'pesta (tegas)', po: 'pohon',
  sa: 'sapi', si: 'sisa', su: 'susu', se: 'senang (pepet)', sE: 'seng (tegas)', so: 'sore',
  ta: 'tamu', ti: 'tiga', tu: 'tujuh', te: 'telur (pepet)', tE: 'téh (tegas)', to: 'toko',
};

function buildSyllableList() {
  const list = [];
  for (const v of VOWEL_DEFS) {
    list.push({ key: v.key, display: v.key, hint: v.hint });
  }
  for (const c of CONSONANTS) {
    for (const v of VOWEL_DEFS) {
      const key = c + v.key;
      list.push({ key, display: key, hint: EXAMPLE_WORDS[key] || '' });
    }
  }
  return list;
}

const SYLLABLES = buildSyllableList();

// ============ STATE ============
const library = {}; // key -> AudioBuffer
let activeRecording = null;
let starting = false;
let audioContext = null;
let lastWav = null;

// ============ AUDIO CONTEXT ============
function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

// ============ INDEXEDDB ============
const DB_NAME = 'syllable-tts';
const STORE = 'recordings';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveBlob(key, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadAllBlobs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const reqKeys = store.getAllKeys();
    const reqVals = store.getAll();
    let keys = null, vals = null;
    const check = () => {
      if (keys && vals) {
        const map = {};
        keys.forEach((k, i) => (map[k] = vals[i]));
        resolve(map);
      }
    };
    reqKeys.onsuccess = () => { keys = reqKeys.result; check(); };
    reqVals.onsuccess = () => { vals = reqVals.result; check(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllBlobs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============ AUDIO PROCESSING ============
function trimSilence(buffer, threshold = 0.02, padding = 200) {
  const data = buffer.getChannelData(0);
  let start = 0, end = data.length - 1;
  while (start < data.length && Math.abs(data[start]) < threshold) start++;
  while (end > start && Math.abs(data[end]) < threshold) end--;
  if (start >= end) return buffer;
  start = Math.max(0, start - padding);
  end = Math.min(data.length - 1, end + padding);
  const ctx = getAudioContext();
  const out = ctx.createBuffer(1, end - start + 1, buffer.sampleRate);
  out.getChannelData(0).set(buffer.getChannelData(0).subarray(start, end + 1));
  return out;
}

function concatBuffers(buffers) {
  const ctx = getAudioContext();
  const total = buffers.reduce((s, b) => s + b.length, 0);
  const out = ctx.createBuffer(1, total, buffers[0].sampleRate);
  const ch = out.getChannelData(0);
  let offset = 0;
  for (const b of buffers) {
    ch.set(b.getChannelData(0), offset);
    offset += b.length;
  }
  return out;
}

function audioBufferToWav(buffer) {
  const numCh = 1;
  const sr = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ============ UI: GRID ============
function renderGrid() {
  const grid = document.getElementById('syllable-grid');
  grid.innerHTML = '';
  for (const s of SYLLABLES) {
    const item = document.createElement('div');
    item.className = 'syllable-item' + (library[s.key] ? ' recorded' : '');
    item.dataset.key = s.key;
    grid.appendChild(item);
    fillItem(item, s);
  }
  updateProgress();
}

function fillItem(item, s) {
  item.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'syllable-label';
  label.textContent = s.display;

  const hint = document.createElement('div');
  hint.className = 'syllable-hint';
  hint.textContent = s.hint;

  const actions = document.createElement('div');
  actions.className = 'syllable-actions';

  const recBtn = document.createElement('button');
  recBtn.className = 'rec-btn';
  recBtn.textContent = library[s.key] ? '🔄 Ulang' : '🎙️ Rekam';
  recBtn.onclick = () => handleRecord(s.key, recBtn, item);
  actions.appendChild(recBtn);

  if (library[s.key]) {
    const playBtn = document.createElement('button');
    playBtn.className = 'play-btn';
    playBtn.textContent = '▶';
    playBtn.onclick = () => playBuffer(library[s.key]);
    actions.appendChild(playBtn);
  }

  item.appendChild(label);
  item.appendChild(hint);
  item.appendChild(actions);
}

function updateProgress() {
  const total = SYLLABLES.length;
  const done = SYLLABLES.filter((s) => library[s.key]).length;
  document.getElementById('progress-text').textContent = `${done} / ${total}`;
  document.getElementById('progress-fill').style.width = `${(done / total) * 100}%`;
}

function playBuffer(buffer) {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
}

// ============ REKAM ============
async function handleRecord(key, button, item) {
  if (activeRecording) {
    if (activeRecording.key === key) stopRecording();
    else alert('Selesaikan rekaman lain dulu.');
    return;
  }
  if (starting) return;
  starting = true;
  button.disabled = true;
  button.textContent = '⏳ Izin...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : 'audio/mp4';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const timer = setTimeout(() => stopRecording(), 2000);
    recorder.start();
    activeRecording = { key, recorder, stream, chunks, timer, item, mime };
    button.textContent = '⏹️ Stop';
    button.classList.add('recording');
    button.disabled = false;
  } catch (err) {
    button.textContent = '🎙️ Rekam';
    button.disabled = false;
    alert('Gagal akses mikrofon: ' + err.message);
  } finally {
    starting = false;
  }
}

function stopRecording() {
  if (!activeRecording) return;
  const rec = activeRecording;
  activeRecording = null;
  clearTimeout(rec.timer);

  rec.recorder.onstop = async () => {
    rec.stream.getTracks().forEach((t) => t.stop());
    try {
      const blob = new Blob(rec.chunks, { type: rec.mime });
      const arrayBuf = await blob.arrayBuffer();
      const buf = await getAudioContext().decodeAudioData(arrayBuf);
      library[rec.key] = buf;
      await saveBlob(rec.key, blob);
      const s = SYLLABLES.find((x) => x.key === rec.key);
      rec.item.classList.add('recorded');
      if (s) fillItem(rec.item, s);
      updateProgress();
    } catch (err) {
      console.error(err);
      alert('Gagal memproses rekaman: ' + err.message);
    }
  };
  rec.recorder.stop();
}

// ============ SINTESIS ============
function parseInput(text) {
  return text.trim().split(/[\s-]+/).filter(Boolean);
}

function setStatus(msg, type = '') {
  const el = document.getElementById('output-status');
  el.textContent = msg;
  el.className = type;
}

function handleSpeak() {
  const tokens = parseInput(document.getElementById('text-input').value);
  const player = document.getElementById('audio-player');
  const downloadBtn = document.getElementById('download-btn');

  if (!tokens.length) return setStatus('Tulis teks dulu.', 'error');

  const missing = [...new Set(tokens.filter((t) => !library[t]))];
  if (missing.length) {
    return setStatus(`Suku kata belum direkam: ${missing.join(', ')}`, 'error');
  }

  try {
    const buffers = tokens.map((t) => trimSilence(library[t]));
    const merged = concatBuffers(buffers);
    lastWav = audioBufferToWav(merged);
    const url = URL.createObjectURL(lastWav);
    player.src = url;
    player.hidden = false;
    player.play();
    downloadBtn.disabled = false;
    setStatus(`✓ Berhasil! ${tokens.length} suku kata digabung.`, 'success');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message, 'error');
  }
}

function handleDownload() {
  if (!lastWav) return;
  const url = URL.createObjectURL(lastWav);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tts-${Date.now()}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============ KUSTOM ============
function handleAddCustom() {
  const input = document.getElementById('custom-input');
  const val = input.value.trim();
  if (!val) return;
  if (SYLLABLES.some((s) => s.key === val)) {
    alert('Suku kata sudah ada.');
    return;
  }
  SYLLABLES.push({ key: val, display: val, hint: '(kustom)' });
  input.value = '';
  renderGrid();
}

// ============ INIT ============
async function init() {
  renderGrid();

  try {
    const saved = await loadAllBlobs();
    const ctx = getAudioContext();
    for (const [key, blob] of Object.entries(saved)) {
      try {
        const arrayBuf = await blob.arrayBuffer();
        library[key] = await ctx.decodeAudioData(arrayBuf);
        if (!SYLLABLES.some((s) => s.key === key)) {
          SYLLABLES.push({ key, display: key, hint: '(dimuat)' });
        }
      } catch (err) {
        console.warn('Gagal decode', key, err);
      }
    }
    renderGrid();
  } catch (err) {
    console.warn('Gagal memuat IndexedDB:', err);
  }

  document.getElementById('speak-btn').onclick = handleSpeak;
  document.getElementById('download-btn').onclick = handleDownload;
  document.getElementById('add-custom').onclick = handleAddCustom;
  document.getElementById('custom-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddCustom();
  });
  document.getElementById('search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.syllable-item').forEach((it) => {
      it.style.display = it.dataset.key.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  document.getElementById('clear-all').onclick = async () => {
    if (!confirm('Hapus semua rekaman? Tidak bisa dibatalkan.')) return;
    await clearAllBlobs();
    for (const k of Object.keys(library)) delete library[k];
    renderGrid();
    document.getElementById('audio-player').hidden = true;
    document.getElementById('download-btn').disabled = true;
    setStatus('');
  };
}

init();
