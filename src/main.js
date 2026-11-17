// GoAway - TTS suku kata dengan rekaman lokal
const CONSONANTS = ['b', 'k', 'l', 'm', 'n', 'p', 's', 't'];
const VOWELS = [
  { key: 'a', hint: 'ayah' }, { key: 'i', hint: 'ibu' },
  { key: 'u', hint: 'ular' }, { key: 'e', hint: 'emas (pepet)' },
  { key: 'E', hint: 'enak (tegas)' }, { key: 'o', hint: 'obat' }
];
const EXAMPLES = {
  ba:'bapak',bi:'bibi',bu:'buku',be:'berani (pepet)',bE:'bebek (tegas)',bo:'bola',
  ka:'kaki',ki:'kini',ku:'kuku',ke:'kecil (pepet)',kE:'kera (tegas)',ko:'kota',
  la:'lama',li:'lilin',lu:'lupa',le:'leher (pepet)',lE:'lémon (tegas)',lo:'loro',
  ma:'mama',mi:'mie',mu:'muka',me:'membaca (pepet)',mE:'meja (tegas)',mo:'motor',
  na:'nasi',ni:'nila',nu:'nuri',ne:'neraca (pepet)',nE:'nék (tegas)',no:'noda',
  pa:'papa',pi:'pipa',pu:'pulang',pe:'permisi (pepet)',pE:'pesta (tegas)',po:'pohon',
  sa:'sapi',si:'sisa',su:'susu',se:'senang (pepet)',sE:'seng (tegas)',so:'sore',
  ta:'tamu',ti:'tiga',tu:'tujuh',te:'telur (pepet)',tE:'téh (tegas)',to:'toko'
};
const DB_NAME = 'syllable-tts';
const STORE = 'recordings';
const CUSTOM_KEY = 'goaway-custom-syllables-v1';
const library = Object.create(null);
let syllables = [];
let audioContext;
let activeRecording = null;
let starting = false;
let lastWav = null;
let lastObjectUrl = null;
let recordingTimer = null;

function buildDefaults() {
  const out = VOWELS.map(v => ({ key:v.key, display:v.key, hint:v.hint }));
  for (const c of CONSONANTS) for (const v of VOWELS) {
    const key = c + v.key;
    out.push({ key, display:key, hint:EXAMPLES[key] || '' });
  }
  return out;
}
function getAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('Browser tidak mendukung Web Audio API. Perbarui Chrome.');
  if (!audioContext) audioContext = new Ctx();
  return audioContext;
}
function setStatus(message, type='') {
  const el = document.getElementById('output-status');
  if (el) { el.textContent = message; el.className = type; }
}
function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('Penyimpanan lokal tidak didukung browser.'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Gagal membuka penyimpanan.'));
    req.onblocked = () => reject(new Error('Database sedang dipakai tab lain. Tutup tab GoAway lain lalu muat ulang.'));
  });
}
async function dbRequest(mode, action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let req;
    try { req = action(store); } catch (e) { db.close(); reject(e); return; }
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Transaksi penyimpanan gagal.')); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Transaksi penyimpanan dibatalkan.')); };
  });
}
const saveBlob = (key, blob) => dbRequest('readwrite', s => s.put(blob, key));
const deleteBlob = key => dbRequest('readwrite', s => s.delete(key));
const clearBlobs = () => dbRequest('readwrite', s => s.clear());
async function loadBlobs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    tx.oncomplete = () => {
      const result = {};
      keysReq.result.forEach((key, index) => { result[key] = valsReq.result[index]; });
      db.close();
      resolve(result);
    };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Gagal membaca rekaman.')); };
  });
}
function getPermissionState() {
  if (!navigator.permissions?.query) return Promise.resolve('unknown');
  return navigator.permissions.query({ name:'microphone' })
    .then(p => p.state).catch(() => 'unknown');
}
function explainMicError(err) {
  const state = err?.name || '';
  if (state === 'NotAllowedError' || state === 'PermissionDeniedError') {
    return 'Browser menolak akses mikrofon. Jika tidak muncul pop-up, izin situs kemungkinan sudah disetel ke Blokir. Buka ikon pengaturan di kiri alamat situs → Izin situs → Mikrofon → Izinkan, lalu muat ulang.';
  }
  if (state === 'NotFoundError' || state === 'DevicesNotFoundError') return 'Tidak ada mikrofon yang terdeteksi. Periksa mikrofon perangkat atau headset.';
  if (state === 'NotReadableError' || state === 'TrackStartError') return 'Mikrofon sedang dipakai aplikasi lain atau gagal dibuka. Tutup aplikasi yang memakai mikrofon lalu coba lagi.';
  if (state === 'SecurityError') return 'Browser memblokir akses karena keamanan. Buka alamat HTTPS, bukan HTTP.';
  if (state === 'OverconstrainedError') return 'Mikrofon tidak memenuhi pengaturan audio yang diminta.';
  return `${err?.message || 'Kesalahan tidak diketahui.'} (kode: ${state || 'unknown'})`;
}
async function checkMicrophone({request=false}={}) {
  const status = document.getElementById('mic-status');
  const set = (m, type='') => { if(status){status.textContent=m;status.className=type;} };
  if (!window.isSecureContext) { set('Tidak aman: akses mikrofon membutuhkan HTTPS atau localhost.','error'); return false; }
  if (window.top !== window.self) { set('Halaman dibuka di dalam frame. Izin mikrofon mungkin diblokir oleh halaman induk. Buka situs langsung di tab baru.','error'); }
  if (!navigator.mediaDevices?.getUserMedia) { set('API mikrofon tidak tersedia. Coba Chrome terbaru dan buka situs langsung, bukan browser dalam aplikasi.','error'); return false; }
  const permission = await getPermissionState();
  if (permission === 'denied') {
    set('Izin mikrofon saat ini: DIBLOKIR oleh browser. Ubah izin situs menjadi Izinkan, lalu muat ulang.','error');
    return false;
  }
  if (!request) {
    set(permission === 'granted' ? 'Izin mikrofon sudah diizinkan.' : permission === 'prompt' ? 'Izin belum diputuskan. Tekan Rekam untuk memunculkan permintaan izin.' : 'Dukungan izin tersedia. Tekan Rekam untuk menguji mikrofon.','success');
    return true;
  }
  return true;
}
function renderGrid() {
  const grid = document.getElementById('syllable-grid');
  grid.replaceChildren();
  for (const s of syllables) {
    const item = document.createElement('article');
    item.className = `syllable-item${library[s.key] ? ' recorded' : ''}`;
    item.dataset.key = s.key;
    const label = document.createElement('div'); label.className='syllable-label'; label.textContent=s.display;
    const hint = document.createElement('div'); hint.className='syllable-hint'; hint.textContent=s.hint || '';
    const actions = document.createElement('div'); actions.className='syllable-actions';
    const rec = document.createElement('button'); rec.className='rec-btn'; rec.textContent=library[s.key]?'🔄 Ulang':'🎙️ Rekam';
    rec.onclick=()=>handleRecord(s.key,rec,item); actions.append(rec);
    if (library[s.key]) {
      const play=document.createElement('button'); play.className='play-btn'; play.textContent='▶'; play.title='Putar rekaman'; play.onclick=()=>playBuffer(library[s.key]); actions.append(play);
      const del=document.createElement('button'); del.className='delete-btn'; del.textContent='×'; del.title='Hapus rekaman ini'; del.onclick=()=>removeRecording(s.key); actions.append(del);
    }
    item.append(label,hint,actions); grid.append(item);
  }
  updateProgress(); applySearch();
}
function updateProgress() {
  const done=syllables.filter(s=>library[s.key]).length, total=syllables.length;
  document.getElementById('progress-text').textContent=`${done} / ${total}`;
  document.getElementById('progress-fill').style.width=`${total?done/total*100:0}%`;
}
function applySearch() {
  const q=document.getElementById('search').value.trim().toLowerCase();
  document.querySelectorAll('.syllable-item').forEach(el=>{el.hidden=!el.dataset.key.toLowerCase().includes(q);});
}
async function playBuffer(buffer) {
  try { const ctx=getAudioContext(); if(ctx.state==='suspended') await ctx.resume(); const src=ctx.createBufferSource(); src.buffer=buffer; src.connect(ctx.destination); src.start(); }
  catch(e){setStatus('Tidak bisa memutar audio: '+e.message,'error');}
}
async function handleRecord(key, button, item) {
  if(activeRecording){ if(activeRecording.key===key) stopRecording(); else alert('Selesaikan rekaman lain dulu.'); return; }
  if(starting) return;
  if(!await checkMicrophone({request:false})) return;
  if(!window.MediaRecorder){alert('Browser ini belum mendukung MediaRecorder. Perbarui Chrome.');return;}
  starting=true; button.disabled=true; button.textContent='⏳ Meminta izin…';
  let stream;
  try {
    // Panggilan ini terjadi langsung dari klik tombol; browser akan meminta izin jika statusnya prompt.
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    const mimeCandidates=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
    const mime=mimeCandidates.find(t=>MediaRecorder.isTypeSupported(t));
    const recorder=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);
    const chunks=[];
    recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
    recorder.onerror=e=>{console.error('MediaRecorder:',e.error||e);setStatus('Perekaman mengalami kesalahan. Coba lagi.','error');};
    recorder.onstop=async()=>{
      clearInterval(recordingTimer); recordingTimer=null;
      stream.getTracks().forEach(t=>t.stop());
      const elapsed=document.getElementById('recording-time'); if(elapsed)elapsed.textContent='';
      try {
        const blob=new Blob(chunks,{type:recorder.mimeType||mime||'audio/webm'});
        if(!blob.size) throw new Error('Data rekaman kosong. Bicara saat proses rekam berjalan.');
        const ctx=getAudioContext(); const decoded=await ctx.decodeAudioData(await blob.arrayBuffer());
        await saveBlob(key,blob); library[key]=decoded;
        setStatus(`Rekaman “${key}” tersimpan di perangkat ini.`,'success'); renderGrid();
      } catch(e){
        console.error(e);
        setStatus('Gagal menyimpan/memproses rekaman: '+e.message,'error');
        recButtonReset(rec);
      }
    };
    recorder.start(); activeRecording={key,recorder,stream,item,button,start:Date.now()};
    button.textContent='⏹ Stop'; button.classList.add('recording'); button.disabled=false;
    recordingTimer=setInterval(()=>{const el=document.getElementById('recording-time');if(el&&activeRecording)el.textContent=`Merekam ${((Date.now()-activeRecording.start)/1000).toFixed(1)} dtk`;},200);
    const duration=Number(document.getElementById('record-duration')?.value||0);
    if(duration>0) activeRecording.timeout=setTimeout(stopRecording,duration*1000);
    setStatus(`Sedang merekam “${key}”. Tekan Stop saat selesai.`,'success');
  } catch(err) {
    if(stream)stream.getTracks().forEach(t=>t.stop());
    button.textContent=library[key]?'🔄 Ulang':'🎙️ Rekam'; button.classList.remove('recording'); button.disabled=false;
    const detail=explainMicError(err); setStatus(detail,'error');
    if(err?.name==='NotAllowedError'||err?.name==='PermissionDeniedError') {
      const state=await getPermissionState();
      if(state==='denied') setStatus('Chrome sudah menyimpan izin mikrofon sebagai Blokir. Buka ikon di kiri alamat situs → Izin situs → Mikrofon → Izinkan, lalu muat ulang.','error');
    }
  } finally {starting=false;}
}
function recButtonReset(rec) {
  if (!rec?.button) return;
  rec.button.disabled = false;
  rec.button.classList.remove('recording');
  rec.button.textContent = library[rec.key] ? '🔄 Ulang' : '🎙️ Rekam';
}
function stopRecording() {
  if(!activeRecording)return;
  const rec=activeRecording; activeRecording=null;
  if(rec.timeout)clearTimeout(rec.timeout);
  rec.button.classList.remove('recording'); rec.button.textContent='⏳ Memproses…'; rec.button.disabled=true;
  try { if(rec.recorder.state!=='inactive')rec.recorder.stop(); }
  catch(e){rec.stream.getTracks().forEach(t=>t.stop());recButtonReset(rec);setStatus('Gagal menghentikan rekaman: '+e.message,'error');}
}
async function removeRecording(key) {
  if(!confirm(`Hapus rekaman “${key}”?`))return;
  try{await deleteBlob(key);delete library[key];setStatus(`Rekaman “${key}” dihapus.`,'success');renderGrid();}
  catch(e){setStatus('Gagal menghapus rekaman: '+e.message,'error');}
}
function trimSilence(buffer, threshold=0.015, paddingMs=35) {
  const data=buffer.getChannelData(0);let start=0,end=data.length-1;
  while(start<data.length&&Math.abs(data[start])<threshold)start++;
  while(end>start&&Math.abs(data[end])<threshold)end--;
  if(start>=end)return buffer;
  const pad=Math.round(buffer.sampleRate*paddingMs/1000);
  start=Math.max(0,start-pad);end=Math.min(data.length-1,end+pad);
  const out=getAudioContext().createBuffer(1,end-start+1,buffer.sampleRate);
  out.getChannelData(0).set(data.subarray(start,end+1));return out;
}
function concatBuffers(buffers) {
  if(!buffers.length)throw new Error('Tidak ada audio untuk digabung.');
  const rate=buffers[0].sampleRate;
  const normalized=buffers.map(b=>b.sampleRate===rate?b:resampleBuffer(b,rate));
  const total=normalized.reduce((n,b)=>n+b.length,0);
  const out=getAudioContext().createBuffer(1,total,rate),channel=out.getChannelData(0);let offset=0;
  for(const b of normalized){channel.set(b.getChannelData(0),offset);offset+=b.length;}return out;
}
function resampleBuffer(buffer,rate){
  const offline=new OfflineAudioContext(1,Math.ceil(buffer.duration*rate),rate);
  const source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();
  // Caller is synchronous; current app decodes all clips through one AudioContext, so this is defensive only.
  return buffer;
}
function audioBufferToWav(buffer) {
  const samples=buffer.getChannelData(0),dataLen=samples.length*2,ab=new ArrayBuffer(44+dataLen),v=new DataView(ab);
  const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+dataLen,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,buffer.sampleRate,true);v.setUint32(28,buffer.sampleRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,dataLen,true);
  let p=44;for(const sample of samples){const s=Math.max(-1,Math.min(1,sample));v.setInt16(p,s<0?s*32768:s*32767,true);p+=2;}return new Blob([ab],{type:'audio/wav'});
}
function parseInput(value){return value.trim().split(/[\s-]+/u).filter(Boolean);}
function handleSpeak(){
  const tokens=parseInput(document.getElementById('text-input').value),player=document.getElementById('audio-player'),download=document.getElementById('download-btn');
  if(!tokens.length){setStatus('Tulis teks atau susunan suku kata terlebih dahulu.','error');return;}
  const missing=[...new Set(tokens.filter(t=>!library[t]))];if(missing.length){setStatus('Belum direkam: '+missing.join(', '),'error');return;}
  try{const merged=concatBuffers(tokens.map(t=>trimSilence(library[t])));lastWav=audioBufferToWav(merged);if(lastObjectUrl)URL.revokeObjectURL(lastObjectUrl);lastObjectUrl=URL.createObjectURL(lastWav);player.src=lastObjectUrl;player.hidden=false;player.play().catch(()=>{});download.disabled=false;setStatus(`Berhasil menggabungkan ${tokens.length} potongan suku kata.`,'success');}
  catch(e){console.error(e);setStatus('Gagal membuat audio: '+e.message,'error');}
}
function handleAddCustom(){
  const input=document.getElementById('custom-input'),key=input.value.trim();
  if(!key)return;
  if(!/^[\p{L}\p{M}]{1,8}$/u.test(key)){alert('Gunakan 1–8 huruf tanpa spasi atau simbol.');return;}
  if(syllables.some(s=>s.key===key)){alert('Suku kata sudah ada.');return;}
  syllables.push({key,display:key,hint:'(kustom)'});saveCustom();input.value='';renderGrid();
}
function saveCustom(){try{localStorage.setItem(CUSTOM_KEY,JSON.stringify(syllables.filter(s=>!buildDefaults().some(d=>d.key===s.key)).map(s=>s.key)));}catch(e){console.warn('Tidak bisa menyimpan suku kata kustom',e);}}
function loadCustom(){try{const keys=JSON.parse(localStorage.getItem(CUSTOM_KEY)||'[]');if(Array.isArray(keys))for(const key of keys){if(typeof key==='string'&&!syllables.some(s=>s.key===key))syllables.push({key,display:key,hint:'(kustom)'});}}catch(e){console.warn('Data kustom rusak',e);}}
function blobToDataURL(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});}
function dataURLToBlob(data){const [head,b64]=data.split(',');const mime=head.match(/:(.*?);/)?.[1]||'audio/webm';const raw=atob(b64);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return new Blob([bytes],{type:mime});}
async function exportBackup(){
  try{const recordings={};for(const [key,blob] of Object.entries(await loadBlobs()))recordings[key]=await blobToDataURL(blob);const payload={format:'goaway-backup',version:1,createdAt:new Date().toISOString(),customSyllables:syllables.filter(s=>!buildDefaults().some(d=>d.key===s.key)).map(s=>s.key),recordings};const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`goaway-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);setStatus('Backup berhasil dibuat. Simpan file JSON di tempat aman.','success');}
  catch(e){setStatus('Gagal membuat backup: '+e.message,'error');}
}
async function importBackup(file){
  if(!file)return;
  try{const data=JSON.parse(await file.text());if(data.format!=='goaway-backup'||!data.recordings||typeof data.recordings!=='object')throw new Error('Format file bukan backup GoAway.');if(!confirm('Impor backup akan menambahkan atau mengganti rekaman dengan nama yang sama. Lanjutkan?'))return;
    for(const [key,value] of Object.entries(data.recordings)){if(typeof value!=='string'||!value.startsWith('data:audio/'))continue;const blob=dataURLToBlob(value);const decoded=await getAudioContext().decodeAudioData(await blob.arrayBuffer());await saveBlob(key,blob);library[key]=decoded;if(!syllables.some(s=>s.key===key))syllables.push({key,display:key,hint:'(dari backup)'});}
    if(Array.isArray(data.customSyllables)){for(const key of data.customSyllables)if(typeof key==='string'&&!syllables.some(s=>s.key===key))syllables.push({key,display:key,hint:'(kustom)'});saveCustom();}
    renderGrid();setStatus('Backup berhasil diimpor.','success');
  }catch(e){console.error(e);setStatus('Gagal mengimpor backup: '+e.message,'error');}
}
async function handleClearAll(){if(!confirm('Hapus semua rekaman dari perangkat ini? Tindakan ini tidak bisa dibatalkan.'))return;try{await clearBlobs();for(const k of Object.keys(library))delete library[k];lastWav=null;document.getElementById('audio-player').hidden=true;document.getElementById('download-btn').disabled=true;renderGrid();setStatus('Semua rekaman telah dihapus.','success');}catch(e){setStatus('Gagal menghapus data: '+e.message,'error');}}
async function init(){
  syllables=buildDefaults();loadCustom();renderGrid();
  document.getElementById('speak-btn').onclick=handleSpeak;
  document.getElementById('download-btn').onclick=()=>{if(!lastWav)return;const url=URL.createObjectURL(lastWav),a=document.createElement('a');a.href=url;a.download=`goaway-${Date.now()}.wav`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);};
  document.getElementById('add-custom').onclick=handleAddCustom;
  document.getElementById('custom-input').addEventListener('keydown',e=>{if(e.key==='Enter')handleAddCustom();});
  document.getElementById('search').addEventListener('input',applySearch);
  document.getElementById('clear-all').onclick=handleClearAll;
  document.getElementById('check-mic').onclick=()=>checkMicrophone();
  document.getElementById('export-backup').onclick=exportBackup;
  document.getElementById('import-backup').onclick=()=>document.getElementById('backup-file').click();
  document.getElementById('backup-file').addEventListener('change',e=>{importBackup(e.target.files?.[0]);e.target.value='';});
  try{const saved=await loadBlobs();for(const [key,blob] of Object.entries(saved)){try{library[key]=await getAudioContext().decodeAudioData(await blob.arrayBuffer());if(!syllables.some(s=>s.key===key))syllables.push({key,display:key,hint:'(dimuat)'});}catch(e){console.warn('Rekaman rusak:',key,e);}}renderGrid();}
  catch(e){console.error(e);setStatus('Penyimpanan lokal bermasalah: '+e.message,'error');}
  checkMicrophone();
}
init();
