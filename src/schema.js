// 資料表結構：Worker 第一次處理請求時自動建立（CREATE TABLE IF NOT EXISTS），不需手動執行 SQL
export default `
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  max_score REAL NOT NULL DEFAULT 10,
  zero_at INTEGER NOT NULL DEFAULT 3,       -- 0 = 不歸零
  planned_total INTEGER NOT NULL DEFAULT 0, -- 0 = 以實際點名次數計算
  deduct_per REAL NOT NULL DEFAULT 0,       -- 每缺席一次扣分；0 = 滿分 ÷ 總次數
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  student_no TEXT NOT NULL,
  name TEXT NOT NULL,
  dept TEXT NOT NULL DEFAULT '',
  class TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  UNIQUE (course_id, student_no)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'qr',
  device_id TEXT,
  device_alt TEXT,
  typed_dept TEXT,
  UNIQUE (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_att_dev ON attendance (session_id, device_id);
CREATE INDEX IF NOT EXISTS idx_att_alt ON attendance (session_id, device_alt);
CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions (course_id);
CREATE INDEX IF NOT EXISTS idx_students_course ON students (course_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_fail (
  k TEXT PRIMARY KEY,          -- 'ip:<IP>' 或 'dev:<已信任裝置>'
  n INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (   -- 登入／操作紀錄，保存一年
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  role TEXT,
  ip TEXT,
  ua TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
`;
