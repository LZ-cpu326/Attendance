// 課堂點名系統 — Cloudflare Worker + D1
import SCHEMA from './schema.js';

const ROT_MS = 20000;            // QR 輪替間隔
const TICKET_MS = 3 * 60 * 1000; // 掃描後填寫單有效時間
const ADMIN_TTL = 12 * 3600 * 1000; // 登入最長有效時間；cookie 本身關閉瀏覽器即失效
const LOCK_MAX = 10;               // 15 分鐘內最多嘗試登入次數（成功即歸零）
const LOCK_MS = 15 * 60 * 1000;
// 課程資料保存期限（到期由每日排程刪除）：建立後 KEEP_MONTHS 個月，但至少保留到最後一次點名後 AFTER_MONTHS 個月
const KEEP_MONTHS = 12, AFTER_MONTHS = 2;
const LOG_KEEP_MS = 365 * 86400000; // 登入紀錄保存一年

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const rand = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)));
const eq = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const signKey = (env) => env.SECRET || env.ADMIN_PASSWORD || 'unset';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);

function cookies(req) {
  const out = {};
  for (const p of (req.headers.get('cookie') || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
const norm = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const cookieFlags = (url) => (url.protocol === 'https:' ? '; Secure' : '');

// 兩組密碼：
//   後台密碼（≥10 字元）：全部功能。改過就存在 D1 settings 'admin_pw'（PBKDF2），沒改過用 ADMIN_PASSWORD secret
//   點名密碼（6–9 字元，settings 'roll_pw'）：只能開關點名、投影 QR、看人數，碰不到任何學生資料
// 依輸入長度決定比對哪一組，每次登入最多只算一次 PBKDF2
const PW_ITER = 100000;
const ADMIN_MIN = 10, ROLL_MIN = 6;
const ROLL_TTL = 4 * 3600 * 1000;
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PW_ITER }, k, 256));
}
async function hashPw(pw) {
  const salt = rand();
  return `pbkdf2$${salt}$${await pbkdf2(pw, salt)}`;
}
// admin_strong 記錄「哪一版後台密碼是 ≥10 字元設定的」；用 ADMIN_PASSWORD 退回時就不算
async function pwSettings(env) {
  const r = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('admin_pw', 'roll_pw', 'admin_strong')").all();
  const o = Object.fromEntries(r.results.map((x) => [x.key, x.value]));
  return { admin: o.admin_pw || null, roll: o.roll_pw || null, strong: !!(o.admin_pw && o.admin_strong === pwVer(o.admin_pw)) };
}
// 密碼版本併入登入 cookie 簽章：改密碼後該身分在其他裝置的登入自動失效
const pwVer = (stored) => (stored ? stored.split('$')[1] : 'env');
async function checkHash(pw, stored) {
  const [, salt, hash] = stored.split('$');
  return eq(await pbkdf2(String(pw || ''), salt), hash);
}
async function checkAdmin(env, pw, stored) {
  pw = String(pw || '');
  if (stored) return checkHash(pw, stored);
  if (!env.ADMIN_PASSWORD) throw new Error('伺服器尚未設定 ADMIN_PASSWORD');
  return eq(await hmac(signKey(env), 'pw:' + pw), await hmac(signKey(env), 'pw:' + env.ADMIN_PASSWORD));
}
async function whoIs(env, pw, ps) {
  pw = String(pw || '');
  const short = pw.length < ADMIN_MIN;
  if (!ps.admin) { // 用 ADMIN_PASSWORD secret（比對很便宜），兩組都可以試
    if (await checkAdmin(env, pw, null)) return 'admin';
    return ps.roll && short && (await checkHash(pw, ps.roll)) ? 'roll' : null;
  }
  if (!short) return (await checkHash(pw, ps.admin)) ? 'admin' : null;
  if (ps.roll) return (await checkHash(pw, ps.roll)) ? 'roll' : null;
  return (await checkHash(pw, ps.admin)) ? 'admin' : null; // 還沒設定點名密碼前，沿用舊的短後台密碼
}
async function admCookie(env, url, role, ps) {
  const exp = Date.now() + (role === 'admin' ? ADMIN_TTL : ROLL_TTL);
  const ver = pwVer(role === 'admin' ? ps.admin : ps.roll);
  return `adm=${exp}.${role}.${await hmac(signKey(env), `adm:${exp}:${role}:${ver}`)}; Path=/; HttpOnly; SameSite=Lax${cookieFlags(url)}`;
}
async function authRole(req, env, ps) {
  const [exp, role, sig] = String(cookies(req).adm || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now() || !['admin', 'roll'].includes(role)) return null;
  if (role === 'roll' && !ps.roll) return null;
  const ver = pwVer(role === 'admin' ? ps.admin : ps.roll);
  return eq(sig, await hmac(signKey(env), `adm:${exp}:${role}:${ver}`)) ? role : null;
}

// 登入失敗鎖定：以 IP 計算；曾成功登入的裝置帶 adt cookie，改用裝置計算，
// 同網段（例如校園網路）有人亂試密碼也鎖不到老師的裝置
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';
async function trustedDev(req, env) {
  const [id, sig] = String(cookies(req).adt || '').split('.');
  if (!id || !sig || !eq(sig, (await hmac(signKey(env), 'adt:' + id)).slice(0, 32))) return null;
  return id;
}
async function devCookie(env, url) {
  const id = rand(12);
  return `adt=${id}.${(await hmac(signKey(env), 'adt:' + id)).slice(0, 32)}; Path=/api/login; Max-Age=15552000; HttpOnly; SameSite=Strict${cookieFlags(url)}`;
}

// 公開 API 的頻率限制（Workers Rate Limiting binding；沒設定 binding 時不限制）
async function limited(rl, req) {
  if (!rl) return false;
  try { return !(await rl.limit({ key: clientIp(req) })).success; } catch { return false; }
}

const qrToken = async (sess, win) => (await hmac(sess.secret, 'qr:' + win)).slice(0, 16);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url, url.pathname, req.method);
    } catch (e) {
      console.error(e);
      return fail('伺服器錯誤，請稍後再試', 500);
    }
  },
  // 每日排程（wrangler.toml [triggers]）：刪除過期課程與舊登入紀錄
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purge(env.DB));
  },
};

// 建立資料表、替舊資料庫補欄位（每個 Worker 實例只做一次；欄位已存在會報錯，忽略即可）
let migrated = false;
async function migrate(DB) {
  if (migrated) return;
  await DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => DB.prepare(s)));
  try { await DB.prepare('ALTER TABLE courses ADD COLUMN deduct_per REAL NOT NULL DEFAULT 0').run(); } catch {}
  migrated = true;
}

// ---------- 資料保存期限 ----------
const LAST_AT = 'COALESCE((SELECT MAX(opened_at) FROM sessions WHERE course_id = c.id), 0)'; // 最後一次點名，0 = 沒點過
function addMonths(ms, n) {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.getTime();
}
const expiresAt = (c) => Math.max(addMonths(c.created_at, KEEP_MONTHS), c.last_at ? addMonths(c.last_at, AFTER_MONTHS) : 0);
const withExpiry = (c) => ({ ...c, expires_at: expiresAt(c), keep_months: KEEP_MONTHS, after_months: AFTER_MONTHS });
const deleteCourse = (DB, id) => DB.batch([
  DB.prepare('DELETE FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE course_id = ?)').bind(id),
  DB.prepare('DELETE FROM sessions WHERE course_id = ?').bind(id),
  DB.prepare('DELETE FROM students WHERE course_id = ?').bind(id),
  DB.prepare('DELETE FROM courses WHERE id = ?').bind(id),
]);
async function purge(DB) {
  await migrate(DB);
  const now = Date.now();
  const r = await DB.prepare(`SELECT c.id, c.name, c.created_at, ${LAST_AT} AS last_at FROM courses c`).all();
  for (const c of r.results) {
    if (expiresAt(c) > now) continue;
    await deleteCourse(DB, c.id);
    await audit(DB, null, 'auto_purge', null, `${c.name}（建立後 ${KEEP_MONTHS} 個月／最後一次點名後 ${AFTER_MONTHS} 個月）`);
  }
  await DB.batch([
    DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(now - LOG_KEEP_MS),
    DB.prepare('DELETE FROM login_fail WHERE first_at < ?').bind(now - LOCK_MS),
  ]);
}

// ---------- 登入／操作紀錄 ----------
async function audit(DB, req, action, role, detail = '') {
  try {
    await DB.prepare('INSERT INTO audit_log (at, action, role, ip, ua, detail) VALUES (?,?,?,?,?,?)').bind(
      Date.now(), action, role,
      req ? clientIp(req) : null,
      req ? String(req.headers.get('user-agent') || '').slice(0, 300) : null,
      String(detail).slice(0, 200)
    ).run();
  } catch (e) { console.error(e); }
}

async function route(req, env, url, path, method) {
  const DB = env.DB;
  await migrate(DB);
  let m;

  if ((path === '/api/claim' || path === '/api/checkin') && (await limited(env.RL_PUBLIC, req)))
    return fail('請求太頻繁，請稍候再試', 429);
  if (path === '/api/lookup' && (await limited(env.RL_LOOKUP, req)))
    return fail('查詢太頻繁，請一分鐘後再試', 429);

  // ---------- 學生端（公開）----------
  if (path === '/api/claim' && method === 'POST') {
    const { sid, t } = await req.json();
    const sess = await DB.prepare(
      'SELECT s.*, c.name AS course_name FROM sessions s JOIN courses c ON c.id = s.course_id WHERE s.id = ?'
    ).bind(Number(sid)).first();
    if (!sess) return fail('找不到這次點名');
    if (sess.status !== 'open') return fail('這次點名已結束');
    const win = Math.floor(Date.now() / ROT_MS);
    let ok = false;
    for (const w of [win, win - 1]) if (t && eq(String(t), await qrToken(sess, w))) ok = true;
    if (!ok) return fail('QR Code 已過期，請重新掃描投影幕上的 QR Code');
    const exp = Date.now() + TICKET_MS;
    const ticket = `${sess.id}.${exp}.${(await hmac(signKey(env), `tk:${sess.id}.${exp}`)).slice(0, 24)}`;
    const headers = {};
    if (!cookies(req).did)
      headers['set-cookie'] = `did=${rand(16)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${cookieFlags(url)}`;
    return json({ ticket, exp, course: sess.course_name, label: sess.label }, 200, headers);
  }

  if (path === '/api/checkin' && method === 'POST') {
    const b = await req.json();
    const [sid, exp, sig] = String(b.ticket || '').split('.');
    if (!sid || !exp || !sig || Number(exp) < Date.now() ||
        !eq(sig, (await hmac(signKey(env), `tk:${sid}.${exp}`)).slice(0, 24)))
      return fail('填寫逾時，請重新掃描 QR Code');
    const sess = await DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(Number(sid)).first();
    if (!sess || sess.status !== 'open') return fail('這次點名已結束');
    const no = norm(b.student_no), nm = norm(b.name);
    const match = (rows) => rows.find((r) => norm(r.student_no) === no && norm(r.name) === nm);
    // 先只讀學號相符的列；對不到（例如名單學號含全形字）才退回整份名單比對
    let s = match((await DB.prepare('SELECT * FROM students WHERE course_id = ? AND UPPER(TRIM(student_no)) = ?')
      .bind(sess.course_id, no).all()).results);
    if (!s) s = match((await DB.prepare('SELECT * FROM students WHERE course_id = ?').bind(sess.course_id).all()).results);
    if (!s) return fail('學號與姓名不符，請確認後重新輸入');
    const did = cookies(req).did || null;
    const alt = b.dev ? String(b.dev).slice(0, 64) : null;
    const mine = await DB.prepare('SELECT * FROM attendance WHERE session_id = ? AND student_id = ?').bind(sess.id, s.id).first();
    if (mine) return json({ ok: true, already: true, name: s.name, at: mine.checked_at });
    const ids = [did, alt].filter(Boolean);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const used = await DB.prepare(
        `SELECT student_id FROM attendance WHERE session_id = ? AND (device_id IN (${ph}) OR device_alt IN (${ph}))`
      ).bind(sess.id, ...ids, ...ids).first();
      if (used) return fail('這支手機已經為其他學號簽到過了；如有特殊情況請洽老師');
    }
    const now = Date.now();
    await DB.prepare(
      'INSERT INTO attendance (session_id, student_id, status, checked_at, source, device_id, device_alt, typed_dept) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(sess.id, s.id, 'present', now, 'qr', did || alt, alt, String(b.dept || '').slice(0, 60)).run();
    return json({ ok: true, name: s.name, at: now });
  }

  // 學生查詢自己的出席紀錄（需學號＋姓名相符）
  if (path === '/api/lookup' && method === 'POST') {
    const b = await req.json();
    const no = norm(b.student_no), nm = norm(b.name);
    if (!no || !nm) return fail('請輸入學號與姓名');
    const cand = await DB.prepare('SELECT * FROM students WHERE UPPER(TRIM(student_no)) = ?').bind(no).all();
    const mine = cand.results.filter((s) => norm(s.name) === nm);
    if (!mine.length) {
      await new Promise((r) => setTimeout(r, 600));
      return fail('查無資料，請確認學號與姓名');
    }
    const out = [];
    for (const s of mine) {
      const [c, se, at] = await DB.batch([
        DB.prepare('SELECT id, name, max_score, zero_at, planned_total, deduct_per FROM courses WHERE id = ?').bind(s.course_id),
        DB.prepare('SELECT id, label, status, opened_at FROM sessions WHERE course_id = ? ORDER BY opened_at, id').bind(s.course_id),
        DB.prepare('SELECT session_id, status, checked_at, source FROM attendance WHERE student_id = ?').bind(s.id),
      ]);
      out.push({ course: c.results[0], student: { student_no: s.student_no, name: s.name }, sessions: se.results, attendance: at.results });
    }
    return json({ ok: true, courses: out });
  }

  // ---------- 登入 ----------
  if (path === '/api/login' && method === 'POST') {
    const { password } = await req.json();
    const dev = await trustedDev(req, env);
    const key = dev ? 'dev:' + dev : 'ip:' + clientIp(req);
    const now = Date.now();
    // 先計數再驗密碼（單一 SQL 原子遞增），同時送大量請求也無法超過上限
    const cnt = await DB.prepare(
      `INSERT INTO login_fail (k, n, first_at) VALUES (?, 1, ?) ON CONFLICT (k) DO UPDATE SET
         n = CASE WHEN ? - first_at < ? THEN n + 1 ELSE 1 END,
         first_at = CASE WHEN ? - first_at < ? THEN first_at ELSE ? END
       RETURNING n, first_at`
    ).bind(key, now, now, LOCK_MS, now, LOCK_MS, now).first();
    if (cnt.n > LOCK_MAX) {
      if (cnt.n === LOCK_MAX + 1) await audit(DB, req, 'locked', null);
      const mins = Math.ceil((cnt.first_at + LOCK_MS - now) / 60000);
      return fail(`登入失敗太多次，請 ${mins} 分鐘後再試`, 429);
    }
    const ps = await pwSettings(env);
    const role = await whoIs(env, password, ps);
    if (!role) {
      await audit(DB, req, 'login_fail', null);
      await new Promise((r) => setTimeout(r, 800));
      const left = LOCK_MAX - cnt.n;
      return fail(left <= 0 ? '密碼錯誤，已鎖定 15 分鐘' : left <= 3 ? `密碼錯誤（再錯 ${left} 次將鎖定 15 分鐘）` : '密碼錯誤', 401);
    }
    await DB.batch([
      DB.prepare('DELETE FROM login_fail WHERE k = ?').bind(key),
      DB.prepare('DELETE FROM login_fail WHERE first_at < ?').bind(now - LOCK_MS),
    ]);
    await audit(DB, req, 'login', role);
    const res = json({ ok: true, role }, 200, { 'set-cookie': await admCookie(env, url, role, ps) });
    if (!dev) res.headers.append('set-cookie', await devCookie(env, url));
    return res;
  }
  if (path === '/api/logout' && method === 'POST')
    return json({ ok: true }, 200, { 'set-cookie': `adm=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${cookieFlags(url)}` });

  // ---------- 以下需老師登入 ----------
  const ps = await pwSettings(env);
  const role = await authRole(req, env, ps);
  if (!role) return fail('請先登入', 401);

  if (path === '/api/me') return json({ ok: true, role, ...(role === 'admin' ? { strong: ps.strong, roll_set: !!ps.roll } : {}) });

  if (role === 'roll') return rollRoute(req, env, path, method);

  // ---------- 以下只有後台密碼可用 ----------
  const setting = (key, v) => DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, v);

  if (path === '/api/password' && method === 'POST') {
    const { current, next } = await req.json();
    if (!(await checkAdmin(env, current, ps.admin))) {
      await new Promise((r) => setTimeout(r, 800));
      return fail('目前的後台密碼不正確');
    }
    const pw = String(next || '');
    if (pw.length < ADMIN_MIN) return fail(`後台密碼至少 ${ADMIN_MIN} 個字元`);
    const stored = await hashPw(pw);
    await DB.batch([setting('admin_pw', stored), setting('admin_strong', pwVer(stored))]);
    await audit(DB, req, 'admin_pw', role);
    return json({ ok: true }, 200, { 'set-cookie': await admCookie(env, url, 'admin', { ...ps, admin: stored }) });
  }

  if (path === '/api/roll-password' && method === 'POST') {
    const pw = String((await req.json()).next || '');
    if (!ps.strong) return fail('請先把後台密碼改成 10 字元以上，再設定點名密碼');
    if (pw.length < ROLL_MIN || pw.length >= ADMIN_MIN) return fail(`點名密碼要 ${ROLL_MIN}–${ADMIN_MIN - 1} 個字元`);
    await setting('roll_pw', await hashPw(pw)).run();
    await audit(DB, req, 'roll_pw', role);
    return json({ ok: true });
  }

  // 解除登入鎖定（例如學校 IP 被人故意試錯鎖住時，用手機登入後台按）
  if (path === '/api/unlock' && method === 'POST') {
    await DB.prepare('DELETE FROM login_fail').run();
    await audit(DB, req, 'unlock', role);
    return json({ ok: true });
  }

  // 登入／操作紀錄
  if (path === '/api/audit' && method === 'GET') {
    const r = await DB.prepare('SELECT at, action, role, ip, ua, detail FROM audit_log ORDER BY id DESC LIMIT 200').all();
    return json(r.results);
  }
  // 匯出在瀏覽器端產生，由前端回報一筆紀錄
  if (path === '/api/audit' && method === 'POST') {
    const b = await req.json();
    if (b.action !== 'export') return fail('不支援的紀錄');
    await audit(DB, req, 'export', role, b.detail);
    return json({ ok: true });
  }

  if (path === '/api/courses' && method === 'GET') {
    const r = await DB.prepare(`SELECT c.*, ${LAST_AT} AS last_at,
      (SELECT COUNT(*) FROM students WHERE course_id = c.id) AS n_students,
      (SELECT COUNT(*) FROM sessions WHERE course_id = c.id) AS n_sessions
      FROM courses c ORDER BY c.id DESC`).all();
    return json(r.results.map(withExpiry));
  }
  if (path === '/api/courses' && method === 'POST') {
    const b = await req.json();
    const name = String(b.name || '').trim();
    if (!name) return fail('請輸入課程名稱');
    const r = await DB.prepare('INSERT INTO courses (name, created_at) VALUES (?, ?)').bind(name, Date.now()).run();
    return json({ id: r.meta.last_row_id });
  }

  if ((m = path.match(/^\/api\/courses\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      const b = await req.json();
      await DB.prepare('UPDATE courses SET name = ?, max_score = ?, zero_at = ?, planned_total = ?, deduct_per = ? WHERE id = ?')
        .bind(
          String(b.name || '').trim() || '未命名課程',
          Number(b.max_score) || 10,
          Math.max(0, Math.floor(Number(b.zero_at) || 0)), // 0 = 不歸零
          Math.max(0, Math.floor(Number(b.planned_total) || 0)),
          Math.max(0, Number(b.deduct_per) || 0), // 0 = 滿分 ÷ 總次數
          id
        ).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const c = await DB.prepare('SELECT name FROM courses WHERE id = ?').bind(id).first();
      await deleteCourse(DB, id);
      if (c) await audit(DB, req, 'course_delete', role, c.name);
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/courses\/(\d+)\/overview$/))) {
    const id = Number(m[1]);
    const row = await DB.prepare(`SELECT c.*, ${LAST_AT} AS last_at FROM courses c WHERE c.id = ?`).bind(id).first();
    if (!row) return fail('找不到課程', 404);
    const course = withExpiry(row);
    const [st, se, at] = await DB.batch([
      DB.prepare('SELECT id, student_no, name, dept, class, email FROM students WHERE course_id = ? ORDER BY student_no').bind(id),
      DB.prepare('SELECT id, label, status, opened_at, closed_at FROM sessions WHERE course_id = ? ORDER BY opened_at, id').bind(id),
      DB.prepare(
        'SELECT a.session_id, a.student_id, a.status, a.checked_at, a.source, a.typed_dept FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.course_id = ?'
      ).bind(id),
    ]);
    return json({ course, students: st.results, sessions: se.results, attendance: at.results });
  }

  if ((m = path.match(/^\/api\/courses\/(\d+)\/students$/)) && method === 'POST') {
    const id = Number(m[1]);
    const { students } = await req.json();
    const rows = (students || [])
      .map((s) => ({
        no: String(s.student_no ?? '').trim(),
        name: String(s.name ?? '').trim(),
        dept: String(s.dept ?? '').trim(),
        cls: String(s.class ?? '').trim(),
        email: String(s.email ?? '').trim(),
      }))
      .filter((s) => s.no && s.name);
    const q =
      'INSERT INTO students (course_id, student_no, name, dept, class, email) VALUES (?,?,?,?,?,?) ON CONFLICT (course_id, student_no) DO UPDATE SET name = excluded.name, dept = excluded.dept, class = excluded.class, email = excluded.email';
    for (let i = 0; i < rows.length; i += 50)
      await DB.batch(rows.slice(i, i + 50).map((s) => DB.prepare(q).bind(id, s.no, s.name, s.dept, s.cls, s.email)));
    const c = await DB.prepare('SELECT name FROM courses WHERE id = ?').bind(id).first();
    await audit(DB, req, 'roster_import', role, `${c ? c.name : ''}：${rows.length} 人`);
    return json({ ok: true, count: rows.length });
  }
  if ((m = path.match(/^\/api\/students\/(\d+)$/)) && method === 'DELETE') {
    const id = Number(m[1]);
    await DB.batch([
      DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(id),
      DB.prepare('DELETE FROM students WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/courses\/(\d+)\/sessions$/)) && method === 'POST') {
    const id = Number(m[1]);
    const b = await req.json();
    const r = await DB.prepare('INSERT INTO sessions (course_id, label, secret, status, opened_at) VALUES (?,?,?,?,?)')
      .bind(id, String(b.label || '').trim().slice(0, 60), rand(16), 'open', Date.now()).run();
    return json({ id: r.meta.last_row_id });
  }

  // 匯入過往點名紀錄：[{label, opened_at, entries:[{student_no, status}]}]
  if ((m = path.match(/^\/api\/courses\/(\d+)\/import-sessions$/)) && method === 'POST') {
    const id = Number(m[1]);
    const { sessions } = await req.json();
    const stu = await DB.prepare('SELECT id, student_no FROM students WHERE course_id = ?').bind(id).all();
    const byNo = new Map(stu.results.map((s) => [norm(s.student_no), s.id]));
    let n = 0;
    for (const s of sessions || []) {
      const at = Number(s.opened_at) || Date.now();
      const r = await DB.prepare('INSERT INTO sessions (course_id, label, secret, status, opened_at, closed_at) VALUES (?,?,?,?,?,?)')
        .bind(id, String(s.label || '').trim().slice(0, 60), rand(16), 'closed', at, at).run();
      const sid = r.meta.last_row_id;
      const stmts = [];
      for (const e of s.entries || []) {
        const stId = byNo.get(norm(e.student_no));
        if (!stId || !['present', 'absent', 'excused'].includes(e.status)) continue;
        stmts.push(DB.prepare("INSERT OR REPLACE INTO attendance (session_id, student_id, status, checked_at, source) VALUES (?,?,?,?, 'import')")
          .bind(sid, stId, e.status, at));
      }
      for (let i = 0; i < stmts.length; i += 50) await DB.batch(stmts.slice(i, i + 50));
      n++;
    }
    return json({ ok: true, sessions: n });
  }

  if ((m = path.match(/^\/api\/sessions\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const sess = await DB.prepare('SELECT id, course_id, label, status, opened_at, closed_at FROM sessions WHERE id = ?').bind(id).first();
      if (!sess) return fail('找不到', 404);
      const at = await DB.prepare('SELECT student_id, status, checked_at, source, typed_dept FROM attendance WHERE session_id = ?').bind(id).all();
      return json({ session: sess, attendance: at.results });
    }
    if (method === 'PATCH') {
      const b = await req.json();
      if (b.action === 'close')
        await DB.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(Date.now(), id).run();
      else if (b.action === 'reopen')
        await DB.prepare("UPDATE sessions SET status = 'open', closed_at = NULL WHERE id = ?").bind(id).run();
      if (typeof b.label === 'string')
        await DB.prepare('UPDATE sessions SET label = ? WHERE id = ?').bind(b.label.trim().slice(0, 60), id).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await DB.batch([
        DB.prepare('DELETE FROM attendance WHERE session_id = ?').bind(id),
        DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/sessions\/(\d+)\/qr$/))) {
    const id = Number(m[1]);
    const sess = await DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
    if (!sess) return fail('找不到', 404);
    const now = Date.now(), win = Math.floor(now / ROT_MS);
    return json({ token: await qrToken(sess, win), expires_in: (win + 1) * ROT_MS - now, status: sess.status });
  }

  if ((m = path.match(/^\/api\/sessions\/(\d+)\/mark$/)) && method === 'PUT') {
    const id = Number(m[1]);
    const { student_id, status } = await req.json();
    if (!status || status === 'clear')
      await DB.prepare('DELETE FROM attendance WHERE session_id = ? AND student_id = ?').bind(id, Number(student_id)).run();
    else {
      if (!['present', 'absent', 'excused'].includes(status)) return fail('狀態不正確');
      await DB.prepare(
        `INSERT INTO attendance (session_id, student_id, status, checked_at, source) VALUES (?,?,?,?, 'manual')
         ON CONFLICT (session_id, student_id) DO UPDATE SET status = excluded.status, source = 'manual'`
      ).bind(id, Number(student_id), status, Date.now()).run();
    }
    return json({ ok: true });
  }

  return fail('找不到這個 API', 404);
}

// ---------- 點名密碼可用的 API：只回傳課程名稱、點名狀態與人數，不含任何學生資料 ----------
async function rollRoute(req, env, path, method) {
  const DB = env.DB;
  let m;
  const deny = () => fail('點名密碼沒有這個權限，請用後台密碼登入', 403);

  if (path === '/api/courses' && method === 'GET') {
    const [c, open, labels] = await DB.batch([
      DB.prepare('SELECT c.id, c.name, (SELECT COUNT(*) FROM students WHERE course_id = c.id) AS n_students FROM courses c ORDER BY c.id DESC'),
      DB.prepare("SELECT id, course_id, label, opened_at FROM sessions WHERE status = 'open' ORDER BY opened_at"),
      DB.prepare("SELECT label FROM sessions WHERE label != '' GROUP BY label ORDER BY MAX(id) DESC LIMIT 10"),
    ]);
    return json({ courses: c.results, open: open.results, labels: labels.results.map((x) => x.label) });
  }

  if ((m = path.match(/^\/api\/courses\/(\d+)\/sessions$/)) && method === 'POST') {
    const id = Number(m[1]);
    const c = await DB.prepare('SELECT COUNT(*) AS n FROM students WHERE course_id = ?').bind(id).first();
    if (!c.n) return fail('這門課還沒有學生名單，請先用後台匯入');
    const b = await req.json();
    const r = await DB.prepare('INSERT INTO sessions (course_id, label, secret, status, opened_at) VALUES (?,?,?,?,?)')
      .bind(id, String(b.label || '').trim().slice(0, 60), rand(16), 'open', Date.now()).run();
    return json({ id: r.meta.last_row_id });
  }

  if ((m = path.match(/^\/api\/sessions\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const sess = await DB.prepare(
        `SELECT s.id, s.label, s.status, s.opened_at, c.name AS course_name,
           (SELECT COUNT(*) FROM attendance WHERE session_id = s.id AND status = 'present') AS present,
           (SELECT COUNT(*) FROM students WHERE course_id = s.course_id) AS total
         FROM sessions s JOIN courses c ON c.id = s.course_id WHERE s.id = ?`
      ).bind(id).first();
      if (!sess) return fail('找不到', 404);
      return json(sess);
    }
    if (method === 'PATCH') {
      const b = await req.json();
      if (b.action === 'close')
        await DB.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(Date.now(), id).run();
      else if (b.action === 'reopen')
        await DB.prepare("UPDATE sessions SET status = 'open', closed_at = NULL WHERE id = ?").bind(id).run();
      else return deny();
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/sessions\/(\d+)\/qr$/)) && method === 'GET') {
    const sess = await DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(Number(m[1])).first();
    if (!sess) return fail('找不到', 404);
    const now = Date.now(), win = Math.floor(now / ROT_MS);
    return json({ token: await qrToken(sess, win), expires_in: (win + 1) * ROT_MS - now, status: sess.status });
  }

  return deny();
}
