// 課堂點名系統 — 老師後台
const $app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = '日一二三四五六';
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
const fmtTime = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtFull = (ms) => { const d = new Date(ms); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} (${WD[d.getDay()]}) ${fmtTime(ms)}`; };
const round2 = (x) => Math.round(x * 100) / 100;
const fmtYMD = (ms) => { const d = new Date(ms); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
const daysLeft = (ms) => Math.ceil((ms - Date.now()) / 86400000);
// 投影畫面的個資遮蔽：姓名第 2 個字（四個字以上是第 3 個字）換成 ○、學號末 3 碼換成 xxx（預設開啟，不記住）
const maskName = (n) => { const i = n.length >= 4 ? 2 : 1; return n.length >= 2 ? n.slice(0, i) + '○' + n.slice(i + 1) : n; };
const maskNo = (no) => (no.length > 3 ? no.slice(0, -3) + 'xxx' : no);

const STATUS = {
  present: { zh: '出席', en: 'Present', sym: '✓' },
  absent: { zh: '缺席', en: 'Absent', sym: '✗' },
  excused: { zh: '請假', en: 'Excused', sym: '假' },
  pending: { zh: '未簽到', en: 'Not yet', sym: '·' },
};
const LABEL_PRESETS = ['週二 正課', '週四 實習課', '週四 正課'];

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

class AuthError extends Error {}
async function api(path, method = 'GET', body) {
  const r = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') throw new AuthError('請先登入');
  if (!r.ok) throw new Error(d.error || '連線錯誤 (HTTP ' + r.status + ')');
  return d;
}

function loadScript(src) {
  return new Promise((ok, no) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('無法載入 ' + src));
    document.head.appendChild(s);
  });
}

function modal(html) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.remove('hidden');
  return $('#modalBox');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });

function crumb(items) {
  $('#crumb').innerHTML = items.map((it) => (it.href ? `<a href="${it.href}">${h(it.text)}</a>` : `<span>${h(it.text)}</span>`)).join('<span>›</span>');
}

// ---------- 出席計算 ----------
function compute(data) {
  const { course, students, sessions, attendance } = data;
  const map = new Map(attendance.map((a) => [a.session_id + ':' + a.student_id, a]));
  const total = course.planned_total > 0 ? course.planned_total : sessions.length;
  const statusOf = (se, st) => {
    const r = map.get(se.id + ':' + st.id);
    return r ? r.status : se.status === 'open' ? 'pending' : 'absent';
  };
  const rows = students.map((st) => {
    const cells = sessions.map((se) => statusOf(se, st));
    const cnt = (k) => cells.filter((c) => c === k).length;
    const absent = cnt('absent');
    return { st, cells, absent, present: cnt('present'), excused: cnt('excused'), score: calcScore(course, absent, total) };
  });
  return { rows, total, map, statusOf };
}
// 計分規則：zero_at = 0 不歸零；deduct_per = 0 每次扣「滿分 ÷ 總次數」，否則每次固定扣 deduct_per 分
const zeroed = (c, absent) => c.zero_at > 0 && absent >= c.zero_at;
const perAbsence = (c, total) => (c.deduct_per > 0 ? c.deduct_per : total ? c.max_score / total : 0);
function calcScore(c, absent, total) {
  if (zeroed(c, absent)) return 0;
  return Math.max(0, c.max_score - absent * perAbsence(c, total));
}
function ruleText(c, total) {
  const per = c.deduct_per > 0 ? `每缺席 1 次扣 ${round2(c.deduct_per)} 分`
    : total ? `每缺席 1 次扣 ${round2(c.max_score / total)} 分（${c.max_score} ÷ 總次數 ${total}）` : '每缺席 1 次扣「滿分 ÷ 總次數」';
  return `出席分數：滿分 ${c.max_score}，${per}，${c.zero_at > 0 ? `缺席達 ${c.zero_at} 次為 0 分` : '最低 0 分'}；請假不扣分。`;
}
const sessName = (se) => `${fmtDate(se.opened_at)} (${WD[new Date(se.opened_at).getDay()]}) ${fmtTime(se.opened_at)}${se.label ? ' ' + se.label : ''}`;

// ---------- 路由 ----------
let cleanups = [];
const onLeave = (fn) => cleanups.push(fn);
let ME = null; // { role: 'admin' | 'roll', strong, roll_set }
async function router() {
  cleanups.forEach((f) => f()); cleanups = [];
  closeModal();
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  document.body.classList.toggle('wide', parts[0] === 'board' || parts[0] === 'live');
  try {
    if (!ME) ME = await api('/api/me');
    if (ME.role === 'roll') {
      if (parts[0] === 'live') await viewRollLive(Number(parts[1]));
      else if (!parts.length) await viewRollHome();
      else location.hash = '#/';
      $('#logout').hidden = false; $('#chpw').hidden = true; $('#logs').hidden = true;
      return;
    }
    if (!parts.length) await viewCourses();
    else if (parts[0] === 'c') await viewCourse(Number(parts[1]), parts[2] || 'sessions');
    else if (parts[0] === 'live') await viewLive(Number(parts[1]));
    else if (parts[0] === 'board') await viewBoard(Number(parts[1]));
    else location.hash = '#/';
    $('#logout').hidden = false; $('#chpw').hidden = false; $('#logs').hidden = false;
  } catch (e) {
    if (e instanceof AuthError) { ME = null; return viewLogin(); }
    console.error(e);
    $app.innerHTML = `<div class="card">發生錯誤：${h(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', router);
$('#logout').onclick = async () => { await api('/api/logout', 'POST'); ME = null; location.hash = '#/'; viewLogin(); };

// ---------- 密碼設定（只有後台密碼能開） ----------
$('#chpw').onclick = () => {
  const box = modal(`<h2>密碼設定 <span class="en">Passwords</span></h2>
    <form id="pf" class="pw-sec">
      <h3>後台密碼 <span class="en">Admin password (≥ 10)</span></h3>
      <div class="muted">可看名單、紀錄、匯出。只在自己的手機或電腦輸入，不要在學校電腦輸入。</div>
      <label class="field"><span>目前的後台密碼 <span class="en">Current</span></span><input type="password" name="cur" required autocomplete="current-password"></label>
      <label class="field"><span>新的後台密碼 <span class="en">New</span></span><input type="password" name="nw" required minlength="10" autocomplete="new-password"></label>
      <label class="field"><span>再輸入一次 <span class="en">Confirm</span></span><input type="password" name="nw2" required minlength="10" autocomplete="new-password"></label>
      <div class="muted hidden err" id="perr"></div>
      <div class="row"><span class="spacer"></span><button class="btn primary">更新後台密碼</button></div>
    </form>
    <form id="rf" class="pw-sec">
      <h3>點名密碼 <span class="en">Check-in password (6–9)</span></h3>
      <div class="muted">在學校電腦投影用。只能開始／結束點名、顯示 QR Code 和人數，看不到任何學生資料。
        ${ME.strong ? (ME.roll_set ? '目前已設定，重設會讓學校電腦上的登入失效。' : '尚未設定。') : '請先把後台密碼改成 10 字元以上。'}</div>
      <label class="field"><span>新的點名密碼 <span class="en">New</span></span><input type="password" name="nw" required minlength="6" maxlength="9" autocomplete="new-password" ${ME.strong ? '' : 'disabled'}></label>
      <div class="muted hidden err" id="rerr"></div>
      <div class="row"><span class="spacer"></span><button class="btn primary" ${ME.strong ? '' : 'disabled'}>設定點名密碼</button></div>
    </form>
    <div class="pw-sec">
      <h3>解除登入鎖定 <span class="en">Unlock</span></h3>
      <div class="row"><span class="muted">同一個網路 15 分鐘內登入錯 10 次會被鎖定。學校電腦被鎖住時，用手機登入後台按這裡。</span>
        <span class="spacer"></span><button class="btn" id="unl">解除鎖定</button></div>
    </div>
    <div class="row"><span class="spacer"></span><button type="button" class="btn" id="cx">關閉</button></div>`);
  $('#cx', box).onclick = closeModal;
  const shower = (id) => (m) => { const err = $(id, box); err.textContent = m; err.classList.remove('hidden'); };
  $('#pf', box).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, show = shower('#perr');
    if (f.nw.value !== f.nw2.value) return show('兩次輸入的新密碼不一致');
    try {
      await api('/api/password', 'POST', { current: f.cur.value, next: f.nw.value });
      ME = await api('/api/me'); closeModal(); toast('後台密碼已更新'); router();
    } catch (x) { show(x.message); }
  };
  $('#rf', box).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/roll-password', 'POST', { next: e.target.nw.value });
      ME = await api('/api/me'); closeModal(); toast('點名密碼已設定'); router();
    } catch (x) { shower('#rerr')(x.message); }
  };
  $('#unl', box).onclick = async () => { await api('/api/unlock', 'POST'); toast('已解除所有登入鎖定'); };
  $('input', box).focus();
};

function viewLogin() {
  crumb([]); $('#logout').hidden = true; $('#chpw').hidden = true; $('#logs').hidden = true;
  $app.innerHTML = `
    <form class="login card" id="lf">
      <h1>老師登入 <span class="en">Instructor login</span></h1>
      <label class="field"><span>點名密碼或後台密碼 <span class="en">Password</span></span><input type="password" name="pw" required autofocus></label>
      <div class="muted hidden" id="lerr" style="color:var(--absent)"></div>
      <button class="btn primary big">登入 Log in</button>
    </form>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/login', 'POST', { password: e.target.pw.value }); ME = null; router(); }
    catch (err) { $('#lerr').textContent = err.message; $('#lerr').classList.remove('hidden'); }
  };
}

// ---------- 點名模式（點名密碼登入）：只有 QR 與人數，不載入任何學生資料 ----------
async function viewRollHome() {
  const { courses, open, labels } = await api('/api/courses');
  crumb([]);
  const presets = [...new Set([...LABEL_PRESETS, ...labels])];
  $app.innerHTML = `
    <h1>開始點名 <span class="en">Start check-in</span></h1>
    ${open.map((s) => `<div class="card row" style="margin-top:1rem;border-color:var(--present)">
        <span class="pill st-present">點名進行中</span> ${h(courses.find((c) => c.id === s.course_id)?.name || '')} · ${h(sessName(s))}<span class="spacer"></span>
        <a class="btn primary" href="#/live/${s.id}">回到點名畫面</a></div>`).join('')}
    <datalist id="labels">${presets.map((l) => `<option value="${h(l)}">`).join('')}</datalist>
    <div class="courses">
      ${courses.map((c) => `
        <form class="card course-card roll-card" data-id="${c.id}">
          <h3>${h(c.name)}</h3>
          <div class="muted">學生 ${c.n_students} 人</div>
          <input name="label" list="labels" placeholder="名稱（例：週二 正課）">
          <button class="btn primary big" ${c.n_students ? '' : 'disabled'}>▶ 開始點名</button>
        </form>`).join('') || '<div class="card muted">還沒有課程，請用後台密碼建立。</div>'}
    </div>
    <p class="muted">點名密碼只能開始／結束點名。看名單、手動補簽請用手機登入後台。</p>`;
  $app.querySelectorAll('.roll-card').forEach((f) => f.onsubmit = async (e) => {
    e.preventDefault();
    const { id } = await api(`/api/courses/${f.dataset.id}/sessions`, 'POST', { label: f.label.value });
    location.hash = `#/live/${id}`;
  });
}

async function viewRollLive(sid) {
  let s = await api(`/api/sessions/${sid}`);
  crumb([{ text: '點名', href: '#/' }, { text: `${s.course_name} ${sessName(s)}` }]);
  $app.innerHTML = `<div id="live" class="live solo"></div>`;
  const root = $('#live');
  let qrTimer, pollTimer, tickTimer, qrExp = 0, lastQR = null;

  const draw = () => {
    const open = s.status === 'open';
    root.innerHTML = `
      <div class="qr-panel card">
        ${open ? `<div class="qr-box" id="qr"></div>
          <div class="bar"><i id="qbar"></i></div>
          <div class="qr-meta">請用手機掃描 QR Code 簽到 <span class="en">Scan to check in</span><br>QR 每 20 秒更新 · 掃描後有 3 分鐘可填寫</div>`
          : `<div style="padding:2rem 0"><div class="pill st-excused" style="font-size:1.1rem">點名已結束 <span class="en">Closed</span></div></div>`}
        <div class="count" style="margin-top:1rem">${s.present}<small> / ${s.total} 已簽到</small></div>
        <div class="muted">${h(s.course_name)} · ${h(sessName(s))}</div>
        <div class="row" style="justify-content:center;align-items:stretch;margin-top:1rem">
          ${open ? '<button class="btn danger big" id="close">■ 結束點名</button>' : '<button class="btn" id="reopen">重新開放簽到</button>'}
        </div>
      </div>`;
    if ($('#close', root)) $('#close', root).onclick = async () => {
      if (!confirm('結束點名？結束後沒有簽到的學生會算缺席。')) return;
      await api(`/api/sessions/${sid}`, 'PATCH', { action: 'close' }); stopQR(); await refresh(true);
    };
    if ($('#reopen', root)) $('#reopen', root).onclick = async () => {
      await api(`/api/sessions/${sid}`, 'PATCH', { action: 'reopen' }); await refresh(true); startQR();
    };
    if (open && lastQR) renderQR(lastQR);
  };
  const renderQR = (token) => {
    lastQR = token;
    const box = $('#qr', root); if (!box) return;
    const q = qrcode(0, 'M'); q.addData(`${location.origin}/s/?sid=${sid}&t=${token}`); q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  };
  const loadQR = async () => {
    clearTimeout(qrTimer);
    try {
      const r = await api(`/api/sessions/${sid}/qr`);
      qrExp = Date.now() + r.expires_in;
      renderQR(r.token);
      qrTimer = setTimeout(loadQR, r.expires_in + 150);
    } catch { qrTimer = setTimeout(loadQR, 2000); }
  };
  const startQR = () => {
    loadQR();
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { const b = $('#qbar', root); if (b) b.style.width = Math.max(0, (qrExp - Date.now()) / 200) + '%'; }, 250);
  };
  const stopQR = () => { clearTimeout(qrTimer); clearInterval(tickTimer); lastQR = null; };
  const refresh = async (force) => {
    const d = await api(`/api/sessions/${sid}`);
    const changed = force || d.present !== s.present || d.status !== s.status;
    s = d;
    if (changed) draw();
  };

  draw();
  if (s.status === 'open') startQR();
  pollTimer = setInterval(() => refresh().catch(() => {}), 3000);
  onLeave(() => { stopQR(); clearInterval(pollTimer); });
}


// ---------- 課程列表 ----------
// ---------- 登入紀錄（只有後台密碼能開） ----------
const AUDIT = {
  login: '登入', login_fail: '密碼錯誤', locked: '登入鎖定', admin_pw: '變更後台密碼', roll_pw: '設定點名密碼',
  unlock: '解除鎖定', export: '匯出', roster_import: '匯入名單', course_delete: '刪除課程', auto_purge: '到期自動刪除',
};
function uaShort(ua) {
  if (!ua) return '系統排程';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '其他';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|python|node|Go-http/i.test(ua) ? '程式' : '其他';
  return `${os} · ${br}`;
}
$('#logs').onclick = async () => {
  const rows = await api('/api/audit');
  const box = modal(`<h2>登入紀錄 <span class="en">Activity log</span></h2>
    <p class="muted" style="margin-top:0">最近 200 筆，保存一年。看到不認得的時間、地點或裝置，請立刻到「密碼設定」更換後台密碼（其他裝置會一併被登出）。</p>
    <div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="t">
      <thead><tr><th>時間</th><th>動作</th><th>身分</th><th>IP</th><th>裝置</th><th>說明</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td style="white-space:nowrap">${fmtFull(r.at)}</td>
        <td style="white-space:nowrap${/fail|locked|delete|purge/.test(r.action) ? ';color:var(--absent);font-weight:600' : ''}">${h(AUDIT[r.action] || r.action)}</td>
        <td style="white-space:nowrap">${r.role === 'admin' ? '後台' : r.role === 'roll' ? '點名' : '—'}</td>
        <td>${h(r.ip || '—')}</td>
        <td style="white-space:nowrap" title="${h(r.ua || '')}">${h(uaShort(r.ua))}</td>
        <td>${h(r.detail)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">尚無紀錄</td></tr>'}</tbody>
    </table></div>
    <div class="row" style="margin-top:1rem"><span class="spacer"></span><button type="button" class="btn" id="cx">關閉</button></div>`);
  $('#cx', box).onclick = closeModal;
};
const logExport = (course, kind) => api('/api/audit', 'POST', { action: 'export', detail: `${course.name}：${kind}` }).catch(() => {});

async function viewCourses() {
  const list = await api('/api/courses');
  crumb([]);
  $app.innerHTML = `
    <div class="row"><h1>我的課程 <span class="en">Courses</span></h1><span class="spacer"></span>
      <form class="row" id="nf"><input name="name" placeholder="新課程名稱，例：114-1 統計學" style="width:280px" required>
      <button class="btn primary">＋ 新增課程</button></form></div>
    ${ME.strong && ME.roll_set ? '' : `<div class="card row setup-warn">
      <span><b>請完成密碼設定：</b>${ME.strong ? '設定學校電腦用的點名密碼（6–9 字元）。' : '先把後台密碼改成 10 字元以上，再設定學校電腦用的點名密碼。'}</span>
      <span class="spacer"></span><button class="btn primary" id="gopw">密碼設定</button></div>`}
    <p class="muted">為保護學生個資，每門課在<b>建立後 ${list[0]?.keep_months ?? 12} 個月</b>，名單與點名紀錄會自動刪除，無法復原；若最後一次點名離到期不到 ${list[0]?.after_months ?? 2} 個月，會延到該次點名後 ${list[0]?.after_months ?? 2} 個月才刪除。需要保留請先匯出。</p>
    <div class="courses">
      ${list.map((c) => `
        <a class="card course-card" href="#/c/${c.id}">
          <h3>${h(c.name)}</h3>
          <div class="muted">學生 ${c.n_students} 人 · 已點名 ${c.n_sessions} 次</div>
          <div class="muted" style="font-size:.85em;${daysLeft(c.expires_at) <= 30 ? 'color:var(--absent);font-weight:600' : ''}">資料保存至 ${fmtYMD(c.expires_at)}</div>
        </a>`).join('') || '<div class="card muted">還沒有課程，請在右上角新增。</div>'}
    </div>`;
  if ($('#gopw')) $('#gopw').onclick = () => $('#chpw').click();
  $('#nf').onsubmit = async (e) => {
    e.preventDefault();
    const { id } = await api('/api/courses', 'POST', { name: e.target.elements.namedItem('name').value });
    location.hash = `#/c/${id}/roster`;
  };
}

// ---------- 課程頁 ----------
async function viewCourse(id, tab) {
  const data = await api(`/api/courses/${id}/overview`);
  const { course, students, sessions } = data;
  const calc = compute(data);
  crumb([{ text: '課程', href: '#/' }, { text: course.name }]);
  const labels = [...new Set([...LABEL_PRESETS, ...sessions.map((s) => s.label).filter(Boolean)])];
  const openSess = sessions.filter((s) => s.status === 'open');
  $app.innerHTML = `
    <div class="row">
      <h1>${h(course.name)}</h1><span class="spacer"></span>
      <a class="btn" href="#/board/${id}">總覽 <span class="en">Overview</span></a>
      <button class="btn" id="exp">匯出 <span class="en">Export</span> ▾</button>
    </div>
    ${daysLeft(course.expires_at) <= 30 ? `<div class="card row" style="margin-top:1rem;border-color:var(--absent)">
        <span><b style="color:var(--absent)">這門課的名單與點名紀錄將於 ${fmtYMD(course.expires_at)} 自動刪除</b>（建立後 ${course.keep_months} 個月，且最後一次點名後至少 ${course.after_months} 個月）。需要保留請先匯出 Excel。</span></div>` : ''}
    ${openSess.map((s) => `<div class="card row" style="margin-top:1rem;border-color:var(--present)">
        <span class="pill st-present">點名進行中</span> ${h(sessName(s))}<span class="spacer"></span>
        <a class="btn primary" href="#/live/${s.id}">回到點名畫面</a></div>`).join('')}
    <form class="card row" id="sf" style="margin-top:1rem">
      <b>開始新的點名 <span class="en">New check-in</span></b>
      <input name="label" list="labels" placeholder="名稱（例：週二 正課）" style="width:220px">
      <datalist id="labels">${labels.map((l) => `<option value="${h(l)}">`).join('')}</datalist>
      <button class="btn primary big" ${students.length ? '' : 'disabled'}>▶ 開始點名</button>
      ${students.length ? '' : '<span class="muted">請先匯入學生名單</span>'}
    </form>
    <nav class="tabs">
      <a href="#/c/${id}/sessions" class="${tab === 'sessions' ? 'on' : ''}">點名紀錄 <span class="en">Sessions</span> (${sessions.length})</a>
      <a href="#/c/${id}/roster" class="${tab === 'roster' ? 'on' : ''}">學生名單 <span class="en">Roster</span> (${students.length})</a>
      <a href="#/c/${id}/settings" class="${tab === 'settings' ? 'on' : ''}">設定 <span class="en">Settings</span></a>
    </nav>
    <section id="tab"></section>`;
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const { id: sid } = await api(`/api/courses/${id}/sessions`, 'POST', { label: e.target.label.value });
    location.hash = `#/live/${sid}`;
  };
  $('#exp').onclick = (e) => {
    e.stopPropagation();
    if (document.querySelector('.menu')) return document.querySelector('.menu').remove();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = `
      <button data-x="xlsx"><b>Excel 完整紀錄 (.xlsx)</b><br><span class="muted" style="font-size:.85em">每次點名明細＋簽到時間＋成績公式</span></button>
      <button data-x="csv"><b>eCourse2 成績匯入 (.csv)</b><br><span class="muted" style="font-size:.85em">只含學號與出席分數</span></button>`;
    document.body.appendChild(m);
    const r = e.currentTarget.getBoundingClientRect();
    m.style.top = r.bottom + window.scrollY + 4 + 'px';
    m.style.left = Math.max(8, r.right + window.scrollX - 280) + 'px';
    m.style.width = '280px';
    m.onclick = (ev) => {
      const x = ev.target.closest('button')?.dataset.x; if (!x) return;
      m.remove();
      x === 'csv' ? exportCSV(data) : exportExcel(data);
    };
    setTimeout(() => document.addEventListener('mousedown', function off(ev) {
      if (!m.isConnected) return document.removeEventListener('mousedown', off);
      if (!m.contains(ev.target) && !ev.target.closest('#exp')) { m.remove(); document.removeEventListener('mousedown', off); }
    }), 0);
  };
  onLeave(() => document.querySelector('.menu')?.remove());
  const el = $('#tab');
  if (tab === 'roster') return tabRoster(el, data, calc);
  if (tab === 'settings') return tabSettings(el, data, calc);
  return tabSessions(el, data, calc);
}

function tabSessions(el, data, calc) {
  const { students, sessions } = data;
  const n = students.length;
  el.innerHTML = sessions.length ? `
    <div class="table-wrap"><table class="t">
      <thead><tr><th class="num">#</th><th>日期時間<span class="en">Date / Time</span></th><th>名稱<span class="en">Label</span></th>
        <th class="num">出席<span class="en">Present</span></th><th class="num">缺席<span class="en">Absent</span></th>
        <th class="num">請假<span class="en">Excused</span></th><th>狀態<span class="en">Status</span></th><th></th></tr></thead>
      <tbody>${sessions.map((se, i) => {
        const cells = calc.rows.map((r) => r.cells[i]);
        const c = (k) => cells.filter((x) => x === k).length;
        return `<tr>
          <td class="num">${i + 1}</td><td>${fmtFull(se.opened_at)}</td><td>${h(se.label)}</td>
          <td class="num">${c('present')} / ${n}</td><td class="num">${se.status === 'open' ? '—' : c('absent')}</td><td class="num">${c('excused')}</td>
          <td>${se.status === 'open' ? '<span class="pill st-present">進行中</span>' : '<span class="pill st-excused">已結束</span>'}</td>
          <td class="row" style="justify-content:flex-end"><a class="btn sm" href="#/live/${se.id}">${se.status === 'open' ? '開啟 QR' : '檢視／修改'}</a>
            <button class="btn sm danger" data-del="${se.id}">刪除</button></td></tr>`;
      }).reverse().join('')}</tbody></table></div>
    <p class="muted">已結束的點名中，沒有簽到的學生一律算缺席；可點「檢視／修改」手動改成出席或請假。</p>`
    : '<div class="card muted">尚未點名。按上方「開始點名」建立第一次點名；也可以到「設定」匯入過去的紀錄。</div>';
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const se = sessions.find((s) => s.id === Number(b.dataset.del));
    if (!confirm(`確定刪除「${sessName(se)}」這次點名及其所有簽到紀錄？此動作無法復原。`)) return;
    await api(`/api/sessions/${se.id}`, 'DELETE'); toast('已刪除'); router();
  });
}

function tabRoster(el, data, calc) {
  const { course, students } = data;
  el.innerHTML = `
    <div class="card row" style="margin-bottom:1rem">
      <div><b>匯入學生名單</b> <span class="en">Import roster (.xlsx / .xls / .csv)</span><br>
      <span class="muted">需要有「學號」與「姓名」欄；「科系／系級」「班級」「Email」有的話會一併帶入。重複匯入時以學號更新，不會重複建立。</span></div>
      <span class="spacer"></span>
      <label class="btn primary">選擇檔案…<input type="file" id="rf" accept=".xlsx,.xls,.csv" hidden></label>
    </div>
    ${students.length ? `<div class="table-wrap"><table class="t">
      <thead><tr><th class="num">#</th><th>學號<span class="en">Student ID</span></th><th>姓名<span class="en">Name</span></th>
      <th>科系<span class="en">Department</span></th><th>班級<span class="en">Class</span></th><th>Email</th>
      <th class="num">缺席<span class="en">Absences</span></th><th></th></tr></thead>
      <tbody>${calc.rows.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${h(r.st.student_no)}</td><td><b>${h(r.st.name)}</b></td>
        <td>${h(r.st.dept)}</td><td>${h(r.st.class)}</td><td class="muted">${h(r.st.email)}</td>
        <td class="num" style="${zeroed(course, r.absent) ? 'color:var(--absent);font-weight:700' : ''}">${r.absent}</td>
        <td><button class="btn sm danger" data-del="${r.st.id}">移除</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $('#rf').onchange = (e) => e.target.files[0] && importRoster(course.id, e.target.files[0]);
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const st = students.find((s) => s.id === Number(b.dataset.del));
    if (!confirm(`確定將 ${st.student_no} ${st.name} 從名單移除？他的所有點名紀錄也會一併刪除。`)) return;
    await api(`/api/students/${st.id}`, 'DELETE'); toast('已移除'); router();
  });
}

// 讀取 Excel，回傳 { sheetName: rows[][] }
async function readWorkbook(file) {
  await loadScript('/vendor/xlsx.full.min.js');
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const out = {};
  for (const n of wb.SheetNames) out[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
  return out;
}
const COLS = {
  no: /學號|student\s*(id|no)|^id$/i,
  name: /姓名|^name$|student\s*name/i,
  dept: /科系|系所|系級|系別|department|dept/i,
  class: /班級|年級|^class$/i,
  email: /mail|信箱/i,
};
function detectHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = (rows[r] || []).map((c) => (c instanceof Date ? '' : String(c ?? '').trim()));
    const idx = {};
    for (const [k, re] of Object.entries(COLS)) { const i = cells.findIndex((c) => c && re.test(c)); if (i >= 0) idx[k] = i; }
    if (idx.no != null && idx.name != null) return { row: r, idx };
  }
  return null;
}
const cellStr = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

async function importRoster(courseId, file) {
  let book;
  try { book = await readWorkbook(file); } catch (e) { return toast('讀檔失敗：' + e.message); }
  const names = Object.keys(book);
  const firstGood = names.find((n) => detectHeader(book[n])) || names[0];
  const box = modal(`<h2>匯入學生名單 <span class="en">${h(file.name)}</span></h2>
    <div class="row"><label>工作表 Sheet：<select id="sh">${names.map((n) => `<option ${n === firstGood ? 'selected' : ''}>${h(n)}</option>`).join('')}</select></label></div>
    <div id="pv" style="margin:1rem 0"></div>
    <div class="row"><span class="spacer"></span><button class="btn" id="cx">取消</button><button class="btn primary" id="ok">匯入</button></div>`);
  let parsed = [];
  const render = () => {
    const rows = book[$('#sh', box).value];
    const hd = detectHeader(rows);
    if (!hd) { parsed = []; $('#pv', box).innerHTML = '<div class="pill st-absent">這張工作表找不到「學號」和「姓名」欄位</div>'; return; }
    const g = (row, k) => (hd.idx[k] != null ? cellStr(row[hd.idx[k]]) : '');
    parsed = rows.slice(hd.row + 1).map((row) => ({
      student_no: g(row, 'no'), name: g(row, 'name'), dept: g(row, 'dept'), class: g(row, 'class'), email: g(row, 'email'),
    })).filter((s) => s.student_no && s.name && /\d/.test(s.student_no));
    $('#pv', box).innerHTML = `<p>共讀到 <b>${parsed.length}</b> 位學生。前 8 筆預覽：</p>
      <div class="table-wrap"><table class="t"><thead><tr><th>學號</th><th>姓名</th><th>科系</th><th>班級</th><th>Email</th></tr></thead>
      <tbody>${parsed.slice(0, 8).map((s) => `<tr><td>${h(s.student_no)}</td><td>${h(s.name)}</td><td>${h(s.dept)}</td><td>${h(s.class)}</td><td>${h(s.email)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  $('#sh', box).onchange = render; render();
  $('#cx', box).onclick = closeModal;
  $('#ok', box).onclick = async () => {
    if (!parsed.length) return toast('沒有可匯入的資料');
    $('#ok', box).disabled = true;
    const r = await api(`/api/courses/${courseId}/students`, 'POST', { students: parsed });
    closeModal(); toast(`已匯入 ${r.count} 位學生`); router();
  };
}

function tabSettings(el, data, calc) {
  const { course, sessions } = data;
  el.innerHTML = `
    <form class="card" id="cf" style="display:grid;gap:1rem">
      <h2>成績設定 <span class="en">Grading</span></h2>
      <div class="form-grid">
        <label class="field"><span>課程名稱 <span class="en">Course name</span></span><input name="name" value="${h(course.name)}"></label>
        <label class="field"><span>出席成績滿分 <span class="en">Max score</span></span><input type="number" step="any" min="0" name="max_score" value="${course.max_score}"></label>
      </div>
      <div class="form-grid">
        <label class="field"><span>扣分方式 <span class="en">Deduction</span></span>
          <select name="mode"><option value="avg">平均分攤：滿分 ÷ 點名總次數</option><option value="fixed">每缺席一次固定扣分</option></select></label>
        <label class="field" id="fAvg"><span>點名總次數 <span class="en">Total sessions</span></span><input type="number" min="0" name="planned_total" value="${course.planned_total}">
          <small>填 0＝自動使用實際點名次數（目前 ${sessions.length} 次）</small></label>
        <label class="field" id="fFixed"><span>每缺席一次扣幾分 <span class="en">Points per absence</span></span><input type="number" step="any" min="0" name="deduct_per" value="${course.deduct_per > 0 ? course.deduct_per : ''}">
          <small>扣到 0 分為止</small></label>
        <label class="field"><span><input type="checkbox" name="zon" style="width:auto;margin:0 .35em 0 0;vertical-align:-.1em">缺席達一定次數歸零 <span class="en">Zero-out rule</span></span>
          <input type="number" min="1" name="zero_at" value="${course.zero_at > 0 ? course.zero_at : 3}">
          <small>不勾選＝關閉此規則</small></label>
      </div>
      <div class="muted" id="rule"></div>
      <div><button class="btn primary">儲存設定</button></div>
    </form>

    <div class="card" style="margin-top:1rem">
      <h2>匯入過往點名紀錄 <span class="en">Import past records</span></h2>
      <p class="muted" style="margin-top:0">適用於系統上線前已經用 Excel 記錄的點名。每個日期欄位會變成一次（已結束的）點名。請先匯入學生名單。</p>
      <label class="btn">選擇檔案…<input type="file" id="hf" accept=".xlsx,.xls,.csv" hidden></label>
    </div>

    <div class="card" style="margin-top:1rem;border-color:var(--absent-bg)">
      <h2 style="color:var(--absent)">刪除課程</h2>
      <p class="muted" style="margin-top:0">刪除後，這門課的名單與所有點名紀錄都會消失，無法復原。建議先匯出 Excel。</p>
      <button class="btn danger" id="dc">刪除這門課程</button>
    </div>`;
  const f = $('#cf');
  f.mode.value = course.deduct_per > 0 ? 'fixed' : 'avg';
  f.zon.checked = course.zero_at > 0;
  const draft = () => {
    const fixed = f.mode.value === 'fixed';
    return {
      max_score: Number(f.max_score.value) || 0,
      planned_total: fixed ? course.planned_total : Number(f.planned_total.value) || 0,
      deduct_per: fixed ? Number(f.deduct_per.value) || 0 : 0,
      zero_at: f.zon.checked ? Math.max(1, Math.floor(Number(f.zero_at.value) || 1)) : 0,
    };
  };
  const rule = () => {
    const fixed = f.mode.value === 'fixed';
    $('#fAvg').classList.toggle('hidden', fixed);
    $('#fFixed').classList.toggle('hidden', !fixed);
    f.zero_at.disabled = !f.zon.checked;
    f.zero_at.style.opacity = f.zon.checked ? '' : '.4';
    const d = draft();
    if (fixed && !d.deduct_per) return ($('#rule').innerHTML = '<span style="color:var(--absent)">請填每缺席一次扣幾分。</span>');
    const tot = d.planned_total > 0 ? d.planned_total : sessions.length;
    const ex = [1, 2, 3, 5].map((a) => `缺 ${a} 次 → <b>${round2(calcScore(d, a, tot))}</b>`).join('　');
    $('#rule').innerHTML = `${h(ruleText(d, tot))}<br>試算：${ex}`;
  };
  f.oninput = rule; f.onchange = rule; rule();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = draft();
    if (f.mode.value === 'fixed' && !d.deduct_per) return toast('請填每缺席一次扣幾分');
    await api(`/api/courses/${course.id}`, 'PATCH', { name: f.elements.namedItem('name').value, ...d });
    toast('已儲存'); router();
  };
  $('#hf').onchange = (e) => e.target.files[0] && importHistory(data, e.target.files[0]);
  $('#dc').onclick = async () => {
    if (prompt(`請輸入課程名稱「${course.name}」確認刪除`) !== course.name) return;
    await api(`/api/courses/${course.id}`, 'DELETE'); location.hash = '#/';
  };
}

async function importHistory(data, file) {
  const { course, students } = data;
  if (!students.length) return toast('請先匯入學生名單');
  let book;
  try { book = await readWorkbook(file); } catch (e) { return toast('讀檔失敗：' + e.message); }
  const names = Object.keys(book);
  const guess = names.find((n) => /點名|出席|attend/i.test(n)) || names.find((n) => detectHeader(book[n])) || names[0];
  const box = modal(`<h2>匯入過往點名紀錄 <span class="en">${h(file.name)}</span></h2>
    <div class="row">
      <label>工作表 Sheet：<select id="sh">${names.map((n) => `<option ${n === guess ? 'selected' : ''}>${h(n)}</option>`).join('')}</select></label>
      <label>有標記（非空白）的格子代表：<select id="mk"><option value="absent">缺席（只標記沒來的人）</option><option value="present">出席（只標記有來的人）</option></select></label>
    </div>
    <div id="pv" style="margin:1rem 0"></div>
    <div class="row"><span class="spacer"></span><button class="btn" id="cx">取消</button><button class="btn primary" id="ok">匯入勾選的欄位</button></div>`);
  let cols = [], body = [], hd;
  const year = new Date().getFullYear();
  const render = () => {
    const rows = book[$('#sh', box).value];
    hd = detectHeader(rows);
    if (!hd) { cols = []; $('#pv', box).innerHTML = '<div class="pill st-absent">找不到「學號」和「姓名」欄位</div>'; return; }
    const known = new Set(Object.values(hd.idx));
    const head = rows[hd.row];
    body = rows.slice(hd.row + 1).filter((r) => r[hd.idx.no] != null);
    cols = [];
    head.forEach((v, i) => {
      if (known.has(i) || v == null || v === '') return;
      let d = null;
      if (v instanceof Date) d = v;
      else { const mm = String(v).match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})/); if (mm) d = new Date(year, mm[1] - 1, mm[2]); }
      if (!d) return;
      const marked = body.filter((r) => r[i] != null && String(r[i]).trim() !== '').length;
      cols.push({ i, raw: v instanceof Date ? fmtDate(v) : String(v), date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, marked, on: marked > 0 });
    });
    $('#pv', box).innerHTML = cols.length ? `
      <div class="table-wrap"><table class="t"><thead><tr><th>匯入</th><th>原欄位</th><th>日期</th><th>時間</th><th>名稱</th><th class="num">有標記的人數</th></tr></thead>
      <tbody>${cols.map((c, k) => `<tr>
        <td><input type="checkbox" data-k="${k}" data-f="on" ${c.on ? 'checked' : ''}></td><td>${h(c.raw)}</td>
        <td><input type="date" data-k="${k}" data-f="date" value="${c.date}"></td>
        <td><input type="time" data-k="${k}" data-f="time" value="12:00"></td>
        <td><input data-k="${k}" data-f="label" value="${h(/\*/.test(c.raw) ? '週四 實習課' : '')}" style="width:130px"></td>
        <td class="num">${c.marked}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted">完全沒有標記的欄位預設不勾選（可能是還沒登記）；如果那次其實全員到齊，請手動勾選。</p>`
      : '<div class="pill st-absent">找不到日期欄位（欄名需是日期，例如 9/22）</div>';
  };
  $('#sh', box).onchange = render; render();
  $('#cx', box).onclick = closeModal;
  $('#ok', box).onclick = async () => {
    const val = (k, f) => { const x = box.querySelector(`[data-k="${k}"][data-f="${f}"]`); return x.type === 'checkbox' ? x.checked : x.value; };
    const mark = $('#mk', box).value, other = mark === 'absent' ? 'present' : 'absent';
    const inRoster = new Set(students.map((s) => String(s.student_no)));
    const sessions = cols.map((c, k) => ({ c, k })).filter(({ k }) => val(k, 'on')).map(({ c, k }) => {
      const markedNos = new Set(body.filter((r) => r[c.i] != null && String(r[c.i]).trim() !== '').map((r) => cellStr(r[hd.idx.no])));
      return {
        label: val(k, 'label'),
        opened_at: new Date(`${val(k, 'date')}T${val(k, 'time') || '12:00'}`).getTime(),
        entries: [...inRoster].map((no) => ({ student_no: no, status: markedNos.has(no) ? mark : other })),
      };
    });
    if (!sessions.length) return toast('沒有勾選任何欄位');
    $('#ok', box).disabled = true;
    const r = await api(`/api/courses/${course.id}/import-sessions`, 'POST', { sessions });
    closeModal(); toast(`已匯入 ${r.sessions} 次點名`); location.hash = `#/c/${course.id}/sessions`;
  };
}

// ---------- 點名現場（QR） ----------
async function viewLive(sid) {
  const first = await api(`/api/sessions/${sid}`);
  const data = await api(`/api/courses/${first.session.course_id}/overview`);
  const { course, students } = data;
  let sess = first.session, att = first.attendance;
  let filter = 'all', hideList = false, mask = true;
  const nm = (s) => (mask ? maskName(s.name) : s.name), no = (s) => (mask ? maskNo(s.student_no) : s.student_no);
  crumb([{ text: '課程', href: '#/' }, { text: course.name, href: `#/c/${course.id}/sessions` }, { text: sessName(sess) }]);

  $app.innerHTML = `<div id="live"></div>`;
  const root = $('#live');
  let qrTimer, pollTimer, tickTimer, qrExp = 0;

  const draw = () => {
    const map = new Map(att.map((a) => [a.student_id, a]));
    const st = (s) => (map.get(s.id)?.status) || (sess.status === 'open' ? 'pending' : 'absent');
    const n = (k) => students.filter((s) => st(s) === k).length;
    const shown = students.filter((s) => filter === 'all' || (filter === 'in' ? st(s) === 'present' : st(s) !== 'present'));
    const open = sess.status === 'open';
    root.className = 'live' + (hideList ? ' solo' : '');
    root.innerHTML = `
      <div class="qr-panel card">
        ${open ? `<div class="qr-box" id="qr"></div>
          <div class="bar"><i id="qbar"></i></div>
          <div class="qr-meta">請用手機掃描 QR Code 簽到 <span class="en">Scan to check in</span><br>QR 每 20 秒更新 · 掃描後有 3 分鐘可填寫</div>`
          : `<div style="padding:2rem 0"><div class="pill st-excused" style="font-size:1.1rem">點名已結束 <span class="en">Closed</span></div></div>`}
        <div class="count" style="margin-top:1rem">${n('present')}<small> / ${students.length} 已簽到</small></div>
        <div class="muted">${h(sessName(sess))}</div>
        <div class="row" style="justify-content:center;align-items:stretch;margin-top:1rem">
          ${open ? '<button class="btn danger big" id="close">■ 結束點名</button>' : '<button class="btn" id="reopen">重新開放簽到</button>'}
          <button class="btn" id="hide">${hideList ? '顯示名單' : '隱藏名單'}</button>
          <button class="btn" id="mask">${mask ? '顯示完整姓名學號' : '遮蔽姓名學號'}</button>
        </div>
      </div>
      <div class="${hideList ? 'hidden' : ''}">
        <div class="row" style="margin-bottom:.75rem">
          <div class="seg">
            <button data-f="all" class="${filter === 'all' ? 'on' : ''}">全部 ${students.length}</button>
            <button data-f="in" class="${filter === 'in' ? 'on' : ''}">已到 ${n('present')}</button>
            <button data-f="out" class="${filter === 'out' ? 'on' : ''}">${open ? '未到' : '缺席／請假'} ${students.length - n('present')}</button>
          </div>
          <span class="spacer"></span>
          <span class="legend">
            <span><i class="st-present">✓</i>出席</span><span><i class="st-absent">✗</i>缺席</span>
            <span><i class="st-excused">假</i>請假</span>${open ? '<span><i class="st-pending">·</i>未簽到</span>' : ''}
          </span>
        </div>
        <div class="chips">${shown.map((s) => {
          const a = map.get(s.id);
          return `<div class="chip st-${st(s)}" data-id="${s.id}" title="點擊可手動修改">
            <b>${h(nm(s))}</b>${h(no(s))}
            <div class="src">${a ? (a.source === 'qr' ? fmtTime(a.checked_at) : a.source === 'import' ? '匯入' : '手動') : '&nbsp;'}</div></div>`;
        }).join('')}</div>
        <p class="muted">點擊學生可手動改成出席／缺席／請假（例如手機沒電、事先請假）。</p>
      </div>`;
    root.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { filter = b.dataset.f; draw(); });
    $('#hide', root).onclick = () => { hideList = !hideList; draw(); };
    $('#mask', root).onclick = () => { mask = !mask; draw(); };
    if ($('#close', root)) $('#close', root).onclick = async () => {
      if (!confirm('結束點名？結束後沒有簽到的學生會算缺席。')) return;
      await api(`/api/sessions/${sid}`, 'PATCH', { action: 'close' }); await refresh(); stopQR();
    };
    if ($('#reopen', root)) $('#reopen', root).onclick = async () => {
      await api(`/api/sessions/${sid}`, 'PATCH', { action: 'reopen' }); await refresh(); startQR();
    };
    root.querySelectorAll('.chip').forEach((c) => c.onclick = (e) => chipMenu(e, students.find((s) => s.id === Number(c.dataset.id))));
    if (open && lastQR) renderQR(lastQR);
  };

  const chipMenu = (e, s) => {
    document.querySelector('.menu')?.remove();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = `<div class="ttl">${h(no(s))} ${h(nm(s))}</div>
      <button data-s="present">✓ 出席 Present</button><button data-s="absent">✗ 缺席 Absent</button>
      <button data-s="excused">假 請假 Excused</button><button data-s="clear">清除紀錄</button>`;
    document.body.appendChild(m);
    m.style.left = Math.min(e.pageX, window.innerWidth - 170) + 'px'; m.style.top = e.pageY + 'px';
    m.onclick = async (ev) => {
      const v = ev.target.closest('button')?.dataset.s; if (!v) return;
      m.remove();
      await api(`/api/sessions/${sid}/mark`, 'PUT', { student_id: s.id, status: v });
      await refresh();
    };
    setTimeout(() => document.addEventListener('mousedown', function off(ev) {
      if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off); }
    }), 0);
  };

  let lastQR = null;
  const renderQR = (token) => {
    lastQR = token;
    const box = $('#qr', root); if (!box) return;
    const url = `${location.origin}/s/?sid=${sid}&t=${token}`;
    const q = qrcode(0, 'M'); q.addData(url); q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  };
  const loadQR = async () => {
    clearTimeout(qrTimer);
    try {
      const r = await api(`/api/sessions/${sid}/qr`);
      qrExp = Date.now() + r.expires_in;
      renderQR(r.token);
      qrTimer = setTimeout(loadQR, r.expires_in + 150);
    } catch { qrTimer = setTimeout(loadQR, 2000); }
  };
  const startQR = () => {
    loadQR();
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { const b = $('#qbar', root); if (b) b.style.width = Math.max(0, (qrExp - Date.now()) / 200) + '%'; }, 250);
  };
  const stopQR = () => { clearTimeout(qrTimer); clearInterval(tickTimer); lastQR = null; };
  const refresh = async () => {
    const d = await api(`/api/sessions/${sid}`);
    const changed = JSON.stringify(d) !== JSON.stringify({ session: sess, attendance: att });
    sess = d.session; att = d.attendance;
    if (changed && !document.querySelector('.menu')) draw();
  };

  draw();
  if (sess.status === 'open') startQR();
  pollTimer = setInterval(() => refresh().catch(() => {}), 3000);
  onLeave(() => { stopQR(); clearInterval(pollTimer); document.querySelector('.menu')?.remove(); });
}

// ---------- 總覽（投影給學生看） ----------
async function viewBoard(cid) {
  const data = await api(`/api/courses/${cid}/overview`);
  const { course, sessions } = data;
  const calc = compute(data);
  crumb([{ text: '課程', href: '#/' }, { text: course.name, href: `#/c/${cid}/sessions` }, { text: '總覽' }]);
  const pref = (() => { try { return JSON.parse(localStorage.getItem('boardPref') || '{}'); } catch { return {}; } })();
  // 遮蔽姓名學號每次都預設開啟、不記住（學校電腦重開機會清掉設定，避免投影時露出個資）
  let q = '', sort = pref.sort || 'no', mask = true, fs = pref.fs || 15;
  const save = () => { try { localStorage.setItem('boardPref', JSON.stringify({ sort, fs })); } catch {} };

  const closed = sessions.filter((s) => s.status !== 'open').length;
  const cellsAll = calc.rows.flatMap((r) => r.cells.filter((c) => c !== 'pending'));
  const rate = cellsAll.length ? Math.round((cellsAll.filter((c) => c !== 'absent').length / cellsAll.length) * 100) : 100;

  $app.innerHTML = `
    <div class="board-head">
      <div><h1>${h(course.name)} <span class="en">Attendance Overview</span></h1>
        <div class="stats" style="margin-top:.5rem">
          <div class="stat"><b>${sessions.length}</b><span>點名次數 Sessions</span></div>
          <div class="stat"><b>${calc.rows.length}</b><span>學生人數 Students</span></div>
          <div class="stat"><b>${rate}%</b><span>整體出席率 Attendance rate</span></div>
          ${course.zero_at > 0 ? `<div class="stat"><b>${calc.rows.filter((r) => zeroed(course, r.absent)).length}</b><span>缺席 ≥ ${course.zero_at} 次</span></div>` : ''}
        </div></div>
      <span class="spacer"></span>
      <div style="display:grid;gap:.5rem;justify-items:end">
        <div class="legend">
          <span><i class="st-present">✓</i>出席 Present</span><span><i class="st-absent">✗</i>缺席 Absent</span>
          <span><i class="st-excused">假</i>請假 Excused</span>${sessions.some((s) => s.status === 'open') ? '<span><i class="st-pending">·</i>進行中</span>' : ''}
        </div>
        <div class="row">
          <input id="q" placeholder="搜尋學號或姓名 Search" style="width:200px">
          <select id="sort"><option value="no">依學號</option><option value="abs">依缺席次數</option></select>
          <label class="row" style="gap:.3rem"><input type="checkbox" id="mask"> 遮蔽姓名學號</label>
          <button class="btn sm" id="fsm">A−</button><button class="btn sm" id="fsp">A＋</button>
        </div>
      </div>
    </div>
    <div class="board-wrap"><table class="board" id="bt"></table></div>
    <div class="card row" style="margin-top:1rem;gap:1.25rem">
      <div id="meqr" style="width:110px;height:110px;flex:none"></div>
      <div><b style="font-size:1.1rem">查詢個人出席紀錄 <span class="en">Check your own record</span></b><br>
        <span style="font-size:1.1rem">${h(location.host)}/me</span><br>
        <span class="muted">紀錄有誤請於<b>當天下課後立即</b>找助教說明，逾時不受理。</span></div>
    </div>
    <p class="muted">${ruleText(course, calc.total)}</p>`;

  const drawTable = () => {
    let rows = calc.rows.filter((r) => !q || r.st.student_no.includes(q) || r.st.name.includes(q));
    rows = [...rows].sort(sort === 'abs' ? (a, b) => b.absent - a.absent || a.st.student_no.localeCompare(b.st.student_no) : (a, b) => a.st.student_no.localeCompare(b.st.student_no));
    $('#bt').style.setProperty('--bfs', fs + 'px');
    $('#bt').innerHTML = `
      <thead><tr>
        <th class="sticky c-no">#</th><th class="sticky c-id">學號<br><span class="en" style="margin:0">Student ID</span></th>
        <th class="sticky c-name">姓名<br><span class="en" style="margin:0">Name</span></th>
        ${sessions.map((se, i) => `<th class="ses" title="${h(sessName(se))}">${i + 1}<br><span class="d">${fmtDate(se.opened_at)}</span><br>${WD[new Date(se.opened_at).getDay()]}</th>`).join('')}
        <th class="num">缺席<br><span class="en" style="margin:0">Absent</span></th>
        <th class="num">請假<br><span class="en" style="margin:0">Excused</span></th>
        <th class="num">出席分數<br><span class="en" style="margin:0">Score</span></th>
      </tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${zeroed(course, r.absent) ? 'fail' : ''}">
        <td class="sticky c-no">${i + 1}</td><td class="sticky c-id">${h(mask ? maskNo(r.st.student_no) : r.st.student_no)}</td><td class="sticky c-name">${h(mask ? maskName(r.st.name) : r.st.name)}</td>
        ${r.cells.map((c) => `<td class="cell"><i class="st-${c}">${STATUS[c].sym}</i></td>`).join('')}
        <td class="sum" style="${r.absent ? 'color:var(--absent)' : ''}">${r.absent}</td>
        <td class="sum" style="color:var(--excused)">${r.excused || ''}</td>
        <td class="sum">${round2(r.score)}</td></tr>`).join('')}</tbody>`;
  };
  $('#q').oninput = (e) => { q = e.target.value.trim(); drawTable(); };
  $('#sort').value = sort; $('#sort').onchange = (e) => { sort = e.target.value; save(); drawTable(); };
  $('#mask').checked = mask; $('#mask').onchange = (e) => { mask = e.target.checked; save(); drawTable(); };
  $('#fsm').onclick = () => { fs = Math.max(10, fs - 1); save(); drawTable(); };
  $('#fsp').onclick = () => { fs = Math.min(26, fs + 1); save(); drawTable(); };
  drawTable();
  const mq = qrcode(0, 'M'); mq.addData(`${location.origin}/me/`); mq.make();
  $('#meqr').innerHTML = mq.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
}

// ---------- 匯出 eCourse2（Moodle）成績匯入用 CSV ----------
function exportCSV(data) {
  const { course } = data;
  const calc = compute(data);
  const q = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['學號', '姓名', 'Email', '出席成績'].join(',')];
  for (const r of calc.rows) lines.push([r.st.student_no, r.st.name, r.st.email, round2(r.score).toFixed(2)].map(q).join(','));
  const d = new Date();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  a.download = `${course.name}_出席成績_eCourse2_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`已下載 CSV（${calc.rows.length} 位學生，點名總次數以 ${calc.total} 次計）`);
  logExport(course, 'eCourse2 CSV');
}

// ---------- 匯出 Excel ----------
async function exportExcel(data) {
  toast('產生 Excel 中…');
  await loadScript('/vendor/exceljs.min.js');
  const { course, sessions } = data;
  const calc = compute(data);
  const wb = new ExcelJS.Workbook();
  wb.creator = '課堂點名系統';
  const argb = { present: 'FF15803D', presentBg: 'FFDCFCE7', absent: 'FFC62828', absentBg: 'FFFDE2E2', excused: 'FF5B6B82', excusedBg: 'FFE6EBF2' };
  const thin = { style: 'thin', color: { argb: 'FFD0D5DD' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F4F9' } };
  const colL = (n) => { let s = ''; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

  const HEAD = 4, FIRST = HEAD + 1, S0 = 4; // 前四欄：學號 姓名 科系 班級
  const nS = sessions.length, n = calc.rows.length;
  const LAST = FIRST + n - 1;
  const sCol0 = colL(S0), sColN = colL(S0 + Math.max(nS, 1) - 1);
  const cPresent = colL(S0 + nS), cAbsent = colL(S0 + nS + 1), cExcused = colL(S0 + nS + 2), cScore = colL(S0 + nS + 3);

  const ws = wb.addWorksheet('出席總表 Attendance', { views: [{ state: 'frozen', xSplit: 2, ySplit: HEAD }] });
  const tt = wb.addWorksheet('簽到時間 Check-in times', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const set = wb.addWorksheet('設定 Settings');

  // 設定表
  set.columns = [{ width: 34 }, { width: 14 }, { width: 70 }];
  set.addRow(['項目 Item', '數值 Value', '說明 Note']);
  set.addRow(['出席成績滿分 Max score', course.max_score, '出席成績占總成績的分數']);
  set.addRow(['缺席幾次歸零 Zero after N absences', course.zero_at, '缺席次數 ≥ 此數，出席分數為 0；填 0＝不歸零']);
  set.addRow(['點名總次數 Total sessions', course.planned_total > 0 ? course.planned_total
    : { formula: `COUNTA('出席總表 Attendance'!${sCol0}${HEAD}:${sColN}${HEAD})`, result: nS },
    course.planned_total > 0 ? '固定次數（可自行修改）' : '自動計算＝出席總表中的點名欄數']);
  set.addRow(['每缺席一次扣分 Deduction per absence', course.deduct_per > 0 ? course.deduct_per
    : { formula: 'IFERROR(B2/B4,0)', result: perAbsence(course, calc.total) },
    course.deduct_per > 0 ? '固定扣分（可自行修改）' : '＝滿分 ÷ 點名總次數']);
  set.addRow([]);
  set.addRow(['計分公式', '', '出席分數 = IF(歸零次數 > 0 且 缺席次數 ≥ 歸零次數, 0, MAX(0, 滿分 − 缺席次數 × 每缺席一次扣分))；請假不算缺席。']);
  set.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = headFill; });
  [2, 3, 4].forEach((r) => { set.getCell(`B${r}`).font = { bold: true, color: { argb: 'FF2F5BD3' } }; });
  set.getCell('B5').numFmt = '0.00';

  // 出席總表
  ws.getCell('A1').value = `${course.name} 出席紀錄 Attendance Record`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = `匯出時間 Exported: ${fmtFull(Date.now())}　｜　出席＝Present　缺席＝Absent　請假＝Excused（不扣分）　｜　計分規則見「設定 Settings」工作表`;
  ws.getCell('A2').font = { color: { argb: 'FF667085' } };
  const head = ['學號\nStudent ID', '姓名\nName', '科系\nDepartment', '班級\nClass',
    ...sessions.map((se) => `${fmtFull(se.opened_at).slice(5)}${se.label ? '\n' + se.label : ''}`),
    '出席次數\nPresent', '缺席次數\nAbsences', '請假次數\nExcused', '出席分數\nScore'];
  const hr = ws.getRow(HEAD);
  hr.values = head; hr.height = 48;
  hr.eachCell((c) => { c.font = { bold: true }; c.fill = headFill; c.border = border; c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; });
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 12 : i === 1 ? 10 : i === 2 ? 16 : i === 3 ? 7 : i < S0 + nS ? 12 : 11; });

  const rng = (r) => `${sCol0}${r}:${sColN}${r}`;
  calc.rows.forEach((r, k) => {
    const R = FIRST + k;
    const row = ws.getRow(R);
    row.values = [r.st.student_no, r.st.name, r.st.dept, r.st.class,
      ...r.cells.map((c) => (c === 'pending' ? '' : STATUS[c].zh)),
      { formula: `COUNTIF(${rng(R)},"出席")`, result: r.present },
      { formula: `COUNTIF(${rng(R)},"缺席")`, result: r.absent },
      { formula: `COUNTIF(${rng(R)},"請假")`, result: r.excused },
      { formula: `ROUND(IF(AND('設定 Settings'!$B$3>0,${cAbsent}${R}>='設定 Settings'!$B$3),0,MAX(0,'設定 Settings'!$B$2-${cAbsent}${R}*'設定 Settings'!$B$5)),2)`, result: round2(r.score) }];
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.border = border;
      if (col > S0 && col <= S0 + nS) c.alignment = { horizontal: 'center' };
    });
    ws.getCell(`${cScore}${R}`).numFmt = '0.00';
    ws.getCell(`${cScore}${R}`).font = { bold: true };
  });

  if (n && nS) {
    const cf = (text, fg, bg) => ({ type: 'containsText', operator: 'containsText', text, priority: 1,
      style: { font: { color: { argb: fg }, bold: true }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: bg } } } });
    ws.addConditionalFormatting({ ref: `${sCol0}${FIRST}:${sColN}${LAST}`, rules: [
      cf('出席', argb.present, argb.presentBg), cf('缺席', argb.absent, argb.absentBg), cf('請假', argb.excused, argb.excusedBg)] });
  }
  if (n) {
    ws.addConditionalFormatting({ ref: `${cAbsent}${FIRST}:${cAbsent}${LAST}`, rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 2,
      style: { font: { color: { argb: argb.absent }, bold: true } } }] });
    ws.addConditionalFormatting({ ref: `A${FIRST}:B${LAST}`, rules: [{ type: 'expression', formulae: [`AND('設定 Settings'!$B$3>0,$${cAbsent}${FIRST}>='設定 Settings'!$B$3)`], priority: 3,
      style: { font: { color: { argb: argb.absent }, bold: true }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb.absentBg } } } }] });
  }
  ws.autoFilter = { from: { row: HEAD, column: 1 }, to: { row: HEAD, column: head.length } };

  // 簽到時間明細
  tt.getRow(1).values = ['學號\nStudent ID', '姓名\nName', ...sessions.map((se) => `${fmtFull(se.opened_at).slice(5)}${se.label ? '\n' + se.label : ''}`)];
  tt.getRow(1).height = 48;
  tt.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = headFill; c.border = border; c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; });
  tt.columns.forEach((c, i) => { c.width = i === 0 ? 12 : i === 1 ? 10 : 14; });
  calc.rows.forEach((r) => {
    const row = tt.addRow([r.st.student_no, r.st.name, ...sessions.map((se, i) => {
      const a = calc.map.get(se.id + ':' + r.st.id);
      if (!a) return r.cells[i] === 'pending' ? '' : '缺席';
      if (a.status !== 'present') return STATUS[a.status].zh + (a.source === 'manual' ? '（手動）' : '');
      if (a.source === 'qr') { const d = new Date(a.checked_at); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${fmtTime(a.checked_at)}:${pad(d.getSeconds())}`; }
      return a.source === 'import' ? '出席（匯入）' : '出席（手動）';
    })]);
    row.eachCell({ includeEmpty: true }, (c, col) => { c.border = border; if (col > 2) c.alignment = { horizontal: 'center' }; });
  });

  wb.worksheets.forEach((w) => w.eachRow((row) => row.eachCell({ includeEmpty: false }, (c) => { c.font = { name: 'Microsoft JhengHei', ...(c.font || {}) }; })));
  const buf = await wb.xlsx.writeBuffer();
  const d = new Date();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = `${course.name}_出席紀錄_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已下載 Excel');
  logExport(course, 'Excel');
}

router();
