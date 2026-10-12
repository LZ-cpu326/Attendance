// 示範版（GitHub Pages）：不連任何伺服器。
// 攔截頁面對 /api/ 的請求，在瀏覽器裡直接執行同一份 src/worker.js，
// 資料庫用 sql.js（SQLite）模擬 Cloudflare D1，存在這台瀏覽器的 localStorage。
(() => {
  const BASE = new URL('..', document.currentScript.src).pathname; // 例：/attendance/
  window.DEMO_BASE = BASE;
  const DB_KEY = 'demo:db:v2', COOKIE_KEY = 'demo:cookies';
  const ADMIN_PW = 'demoadmin2026', ROLL_PW = 'demo26';
  const RealResponse = window.Response, realFetch = window.fetch.bind(window);

  // ---------- 模擬 Response／Headers（瀏覽器原生的不允許讀寫 set-cookie）----------
  class DemoHeaders {
    constructor(init = {}) { this.m = new Map(); for (const [k, v] of Object.entries(init)) this.append(k, v); }
    get(k) { const v = this.m.get(k.toLowerCase()); return v ? v.join(', ') : null; }
    set(k, v) { this.m.set(k.toLowerCase(), [String(v)]); }
    append(k, v) { k = k.toLowerCase(); this.m.set(k, [...(this.m.get(k) || []), String(v)]); }
  }
  globalThis.__DemoResponse = class {
    constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.headers = new DemoHeaders(init.headers); }
  };

  // ---------- Cookie（存 localStorage，讓學生分頁與老師分頁共用）----------
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const cookieHeader = () => Object.entries(load(COOKIE_KEY, {})).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  function storeCookies(list) {
    const jar = load(COOKIE_KEY, {});
    for (const c of list) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('='), name = pair.slice(0, i).trim(), val = pair.slice(i + 1).trim();
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || !val) delete jar[name];
      else jar[name] = val;
    }
    save(COOKIE_KEY, jar);
  }

  // ---------- 用 sql.js 模擬 D1 ----------
  let SQL, db;
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const persist = () => { try { localStorage.setItem(DB_KEY, toB64(db.export())); } catch {} };
  const rows = (sql, params) => {
    const st = db.prepare(sql);
    try {
      st.bind(params.map((v) => (v === undefined ? null : v)));
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally { st.free(); }
  };
  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...p) { return new Stmt(this.sql, p); }
    exec() {
      const results = rows(this.sql, this.params);
      const last_row_id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      return { success: true, results, meta: { last_row_id, changes: db.getRowsModified() } };
    }
    async all() { return this.exec(); }
    async run() { return this.exec(); }
    async first(col) { const r = this.exec().results[0]; return r ? (col ? r[col] : r) : null; }
  }
  const D1 = {
    prepare: (sql) => new Stmt(sql),
    async batch(list) {
      db.run('BEGIN');
      try { const out = list.map((s) => s.exec()); db.run('COMMIT'); return out; } catch (e) { db.run('ROLLBACK'); throw e; }
    },
  };

  // ---------- 執行 Worker ----------
  let worker;
  const env = { DB: D1, ADMIN_PASSWORD: ADMIN_PW, SECRET: 'demo-secret-' + location.host };
  async function call(path, method = 'GET', body) {
    const req = {
      url: location.origin + path, method,
      headers: { get: (n) => ({ cookie: cookieHeader(), 'user-agent': navigator.userAgent, 'cf-connecting-ip': '示範 demo' })[n.toLowerCase()] ?? null },
      json: async () => JSON.parse(body || '{}'),
    };
    const res = await worker.fetch(req, env);
    storeCookies(res.headers.m.get('set-cookie') || []);
    if (method !== 'GET') persist();
    return res;
  }
  const callJson = async (path, method, body) => JSON.parse((await call(path, method, body && JSON.stringify(body))).body);

  // ---------- 假資料 ----------
  const SUR = '王李張劉陳楊黃趙吳周林許鄭謝郭', GIV = ['小明', '冠宇', '承恩', '宇晴', '怡君', '詩涵', '宜蓁', '俊傑', '雅婷', '柏翰', '宇軒', '佩珊', '家豪', '欣妤', '品妍',
    '子晴', '思妤', '彥廷', '語彤', '書豪', '芷瑜', '昱安', '庭瑋', '心怡', '冠廷', '詠晴', '柏宇', '亭妤', '奕辰', '若涵'];
  const STUDENTS = Array.from({ length: 30 }, (_, i) => ({
    student_no: 'B12345' + String(i + 1).padStart(3, '0'),
    name: SUR[i % SUR.length] + GIV[i],
    dept: '示範系一', class: '', email: '',
  }));
  window.DEMO_STUDENTS = STUDENTS;
  async function seed() {
    let r = 7; const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    await callJson('/api/login', 'POST', { password: ADMIN_PW });
    await callJson('/api/password', 'POST', { current: ADMIN_PW, next: ADMIN_PW });
    await callJson('/api/roll-password', 'POST', { next: ROLL_PW });
    const { id } = await callJson('/api/courses', 'POST', { name: '示範課程：統計學' });
    await callJson(`/api/courses/${id}/students`, 'POST', { students: STUDENTS });
    // 過去三週，每週二、四各點一次
    const sessions = [], now = new Date();
    for (let back = 21; back >= 1; back--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 11, 50);
      if (d.getDay() !== 2 && d.getDay() !== 4) continue;
      sessions.push({
        label: d.getDay() === 2 ? '週二 正課' : '週四 正課', opened_at: d.getTime(),
        entries: STUDENTS.map((s, i) => ({ student_no: s.student_no, status: i === 0 ? 'present' : rnd() < 0.1 ? 'absent' : rnd() < 0.04 ? 'excused' : 'present' })),
      });
    }
    await callJson(`/api/courses/${id}/import-sessions`, 'POST', { sessions });
    await callJson('/api/logout', 'POST');
    db.run('DELETE FROM audit_log; DELETE FROM login_fail;');
    persist();
  }

  const loadScript = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  const ready = (async () => {
    await loadScript(BASE + 'demo/sql-wasm.js');
    SQL = await window.initSqlJs({ locateFile: (f) => BASE + 'demo/' + f });
    worker = (await import(BASE + 'demo/worker.js')).default;
    const saved = localStorage.getItem(DB_KEY);
    if (saved) db = new SQL.Database(fromB64(saved));
    else { db = new SQL.Database(); save(COOKIE_KEY, {}); await seed(); }
  })();
  // 其他分頁（例如學生簽到）改了資料，這個分頁跟著更新
  window.addEventListener('storage', (e) => { if (e.key === DB_KEY && e.newValue && SQL) db = new SQL.Database(fromB64(e.newValue)); });

  let queue = Promise.resolve();
  window.fetch = (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return realFetch(input, init);
    const job = queue.then(async () => {
      await ready;
      const res = await call(u.pathname + u.search, (init.method || 'GET').toUpperCase(), init.body);
      return new RealResponse(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
    });
    queue = job.catch(() => {});
    return job;
  };

  // ---------- 示範說明列 ----------
  const reset = () => {
    if (!confirm('清除這台瀏覽器裡的示範資料，重新產生？')) return;
    for (const k of Object.keys(localStorage)) if (k.startsWith('demo:') || k === 'dev' || k.startsWith('done:') || k === 'me') localStorage.removeItem(k);
    sessionStorage.clear();
    location.href = BASE + 'admin/';
  };
  const newPhone = () => {
    const jar = load(COOKIE_KEY, {}); delete jar.did; save(COOKIE_KEY, jar);
    for (const k of Object.keys(localStorage)) if (k === 'dev' || k.startsWith('done:')) localStorage.removeItem(k);
    sessionStorage.clear();
    alert('已換成「另一支手機」。請回老師分頁再按一次「模擬學生掃碼」。');
  };
  async function scan() {
    const m = location.hash.match(/^#\/live\/(\d+)/);
    if (!m) return;
    const r = await (await window.fetch(`/api/sessions/${m[1]}/qr`)).json();
    if (!r.token) return alert(r.error || '這次點名已結束');
    window.open(`${BASE}s/?sid=${m[1]}&t=${r.token}`, '_blank');
  }

  function bar() {
    const page = location.pathname.slice(BASE.length).split('/')[0];
    const el = document.createElement('div');
    el.id = 'demo-bar';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#1e293b;color:#f8fafc;font:14px/1.5 system-ui,sans-serif;padding:8px 16px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;box-shadow:0 -2px 8px rgba(0,0,0,.2)';
    const btn = 'background:#f8fafc;color:#1e293b;border:0;border-radius:6px;padding:4px 10px;font:inherit;font-weight:600;cursor:pointer';
    const who = STUDENTS.slice(0, 3).map((s) => `${s.student_no} ${s.name}`).join('、');
    const info = page === 's' || page === 'me'
      ? `<span><b>示範版</b>　可用的示範學生：${who}（共 30 人，學號 B12345001–030）</span>`
      : `<span><b>示範版</b>　資料只存在你的瀏覽器　後台密碼 <code>${ADMIN_PW}</code>　點名密碼 <code>${ROLL_PW}</code></span>`;
    el.innerHTML = `${info}<span style="flex:1"></span>
      <button style="${btn}" id="demo-scan" hidden>📱 模擬學生掃碼</button>
      ${page === 's' ? `<button style="${btn}" id="demo-phone">換一支手機</button>` : ''}
      <button style="${btn}" id="demo-reset">重設示範資料</button>`;
    document.body.appendChild(el);
    document.body.style.paddingBottom = el.offsetHeight + 16 + 'px';
    el.querySelector('#demo-reset').onclick = reset;
    if (page === 's') el.querySelector('#demo-phone').onclick = newPhone;
    const sc = el.querySelector('#demo-scan');
    sc.onclick = scan;
    const upd = () => { sc.hidden = !/^#\/live\/\d+/.test(location.hash); };
    window.addEventListener('hashchange', upd); upd();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bar); else bar();
})();
