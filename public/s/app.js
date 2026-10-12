const $ = (id) => document.getElementById(id);
const show = (id) => { for (const x of ['loading', 'fatal', 'formBox', 'doneBox']) $(x).classList.toggle('hidden', x !== id); };
const fmt = (ms) => new Date(ms).toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function devId() {
  try {
    let d = localStorage.getItem('dev');
    if (!d) { d = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('dev', d); }
    return d;
  } catch { return null; }
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || '連線錯誤，請再試一次');
  return d;
}
function fatal(msg) { $('fatalMsg').textContent = msg; show('fatal'); }
function done(name, at) {
  $('doneName').textContent = name; $('doneTime').textContent = fmt(at); show('doneBox');
}

let ticket, exp, timer;
function startTimer() {
  clearInterval(timer);
  const tick = () => {
    const s = Math.max(0, Math.round((exp - Date.now()) / 1000));
    $('left').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s <= 0) { clearInterval(timer); fatal('填寫時間已到 Time is up'); }
  };
  tick(); timer = setInterval(tick, 1000);
}

(async () => {
  const q = new URLSearchParams(location.search);
  const sid = q.get('sid'), t = q.get('t');
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('ticket') || 'null'); } catch {}
  try {
    const doneRec = JSON.parse(localStorage.getItem('done:' + (sid || saved?.sid)) || 'null');
    if (doneRec) return done(doneRec.name, doneRec.at);
  } catch {}
  try {
    if (sid && t) {
      const d = await post('/api/claim', { sid, t });
      saved = { sid, ...d };
      try { sessionStorage.setItem('ticket', JSON.stringify(saved)); } catch {}
      history.replaceState(null, '', '/s/'); // 移除網址中的 QR 代碼，避免轉傳
    }
    if (!saved || saved.exp < Date.now()) return fatal(sid ? 'QR Code 已過期 QR code expired' : '請掃描投影幕上的 QR Code');
    ticket = saved.ticket; exp = saved.exp;
    $('course').textContent = saved.course;
    $('label').textContent = saved.label || '';
    show('formBox'); startTimer();
    $('f').elements.namedItem('student_no').focus();
  } catch (e) { fatal(e.message); }

  $('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = (n) => ev.target.elements.namedItem(n).value;
    $('err').classList.add('hidden');
    $('submit').disabled = true;
    try {
      const d = await post('/api/checkin', {
        ticket, student_no: v('student_no'), name: v('name'), dept: v('dept'), dev: devId(),
      });
      clearInterval(timer);
      try { localStorage.setItem('done:' + saved.sid, JSON.stringify({ name: d.name, at: d.at })); sessionStorage.removeItem('ticket'); } catch {}
      done(d.name, d.at);
    } catch (e) {
      $('err').textContent = e.message; $('err').classList.remove('hidden');
    } finally { $('submit').disabled = false; }
  });
})();
