const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./usage.db');

function getCairoDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function safeAlter(sql) {
  return new Promise((resolve) => {
    db.run(sql, () => resolve()); // لو فشل عادي (العمود موجود)
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows || [])));
  });
}

function initUsageDb() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        day TEXT NOT NULL,
        capturedAt TEXT NOT NULL,

        usedGB REAL,
        remainingGB REAL,
        plan TEXT,
        balanceEGP REAL,

        renewalDate TEXT,
        remainingDays INTEGER,
        renewPriceEGP REAL,

        routerMonthlyEGP REAL,
        routerRenewalDate TEXT,
        totalRenewEGP REAL
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_chat_day ON snapshots(chatId, day)`);

    // 🔥 New Sessions Table for Persistent Logins
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        chatId TEXT PRIMARY KEY,
        sessionData TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS credentials (
        chatId TEXT PRIMARY KEY,
        serviceNumber TEXT NOT NULL,
        password TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    // ترقيات لو DB قديمة
    safeAlter(`ALTER TABLE snapshots ADD COLUMN routerMonthlyEGP REAL`);
    safeAlter(`ALTER TABLE snapshots ADD COLUMN routerRenewalDate TEXT`);
    safeAlter(`ALTER TABLE snapshots ADD COLUMN totalRenewEGP REAL`);
  });
}

function insertSnapshot(chatId, s) {
  return new Promise((resolve, reject) => {
    const day = getCairoDay(new Date(s.capturedAt));

    db.run(
      `INSERT INTO snapshots(
        chatId, day, capturedAt,
        usedGB, remainingGB, plan, balanceEGP,
        renewalDate, remainingDays, renewPriceEGP,
        routerMonthlyEGP, routerRenewalDate, totalRenewEGP
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(chatId),
        day,
        s.capturedAt,

        s.usedGB ?? null,
        s.remainingGB ?? null,
        s.plan ?? null,
        s.balanceEGP ?? null,

        s.renewalDate ?? null,
        s.remainingDays ?? null,
        s.renewPriceEGP ?? null,

        s.routerMonthlyEGP ?? null,
        s.routerRenewalDate ?? null,
        s.totalRenewEGP ?? null,
      ],
      (e) => (e ? reject(e) : resolve(day))
    );
  });
}

async function saveSnapshot(chatId, snapshot) {
  if (!snapshot || !snapshot.capturedAt) throw new Error('INVALID_SNAPSHOT');
  return insertSnapshot(chatId, snapshot);
}

function getFirstOfDay(chatId, day) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM snapshots WHERE chatId=? AND day=? ORDER BY capturedAt ASC LIMIT 1`,
      [String(chatId), day],
      (e, row) => (e ? reject(e) : resolve(row || null))
    );
  });
}

function getLastOfDay(chatId, day) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM snapshots WHERE chatId=? AND day=? ORDER BY capturedAt DESC LIMIT 1`,
      [String(chatId), day],
      (e, row) => (e ? reject(e) : resolve(row || null))
    );
  });
}

async function getTodayUsage(chatId, now = new Date()) {
  const day = getCairoDay(now);
  const [first, last] = await Promise.all([
    getFirstOfDay(chatId, day),
    getLastOfDay(chatId, day),
  ]);

  if (!first || !last) return 0;
  if (first.usedGB == null || last.usedGB == null) return 0;

  const delta = Number(last.usedGB) - Number(first.usedGB);
  return delta > 0 ? delta : 0;
}

async function getLatestBeforeDay(chatId, day) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM snapshots WHERE chatId=? AND day < ? ORDER BY capturedAt DESC LIMIT 1`,
      [String(chatId), day],
      (e, row) => (e ? reject(e) : resolve(row || null))
    );
  });
}

async function getTodayUsageRobust(chatId, now = new Date()) {
  const day = getCairoDay(now);
  const [firstToday, lastToday] = await Promise.all([
    getFirstOfDay(chatId, day),
    getLastOfDay(chatId, day),
  ]);

  if (!lastToday || lastToday.usedGB == null) return 0;

  // Standard daily delta if we have more than one point today.
  if (firstToday && firstToday.usedGB != null) {
    const d = Number(lastToday.usedGB) - Number(firstToday.usedGB);
    if (Number.isFinite(d) && d > 0) return d;
  }

  // Fallback: compare current day last point with latest point from previous days.
  const prev = await getLatestBeforeDay(chatId, day);
  if (!prev || prev.usedGB == null) return 0;
  const delta = Number(lastToday.usedGB) - Number(prev.usedGB);
  return Number.isFinite(delta) && delta > 0 ? delta : 0;
}

async function getAvgDailyUsage(chatId, days = 14) {
  const rows = await dbAll(
    `
      SELECT day, MIN(usedGB) AS minUsed, MAX(usedGB) AS maxUsed
      FROM snapshots
      WHERE chatId = ? AND usedGB IS NOT NULL
      GROUP BY day
      ORDER BY day DESC
      LIMIT ?
    `,
    [String(chatId), Number(days)]
  );

  if (!rows.length) return null;

  const deltas = rows
    .map((r) => Math.max(0, Number(r.maxUsed) - Number(r.minUsed)))
    .filter((v) => Number.isFinite(v));

  if (!deltas.length) return null;

  const sum = deltas.reduce((a, b) => a + b, 0);
  return sum / deltas.length;
}

// 🔥 Session Management Functions
function saveSession(chatId, sessionData) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO sessions(chatId, sessionData, updatedAt) VALUES(?, ?, ?)
       ON CONFLICT(chatId) DO UPDATE SET sessionData=excluded.sessionData, updatedAt=excluded.updatedAt`,
      [String(chatId), JSON.stringify(sessionData), now],
      (e) => (e ? reject(e) : resolve(true))
    );
  });
}

function getSession(chatId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT sessionData FROM sessions WHERE chatId=?`,
      [String(chatId)],
      (e, row) => (e ? reject(e) : resolve(row ? JSON.parse(row.sessionData) : null))
    );
  });
}

function deleteSessionRecord(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM sessions WHERE chatId=?`, [String(chatId)], (e) => (e ? reject(e) : resolve(true)));
  });
}

function saveCredentials(chatId, serviceNumber, password) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO credentials(chatId, serviceNumber, password, updatedAt) VALUES(?, ?, ?, ?)
       ON CONFLICT(chatId) DO UPDATE SET serviceNumber=excluded.serviceNumber, password=excluded.password, updatedAt=excluded.updatedAt`,
      [String(chatId), String(serviceNumber), String(password), now],
      (e) => (e ? reject(e) : resolve(true))
    );
  });
}

function getCredentials(chatId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT serviceNumber, password FROM credentials WHERE chatId=?`,
      [String(chatId)],
      (e, row) => (e ? reject(e) : resolve(row || null))
    );
  });
}

function deleteCredentials(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM credentials WHERE chatId=?`, [String(chatId)], (e) => (e ? reject(e) : resolve(true)));
  });
}

module.exports = {
  initUsageDb,
  insertSnapshot,
  saveSnapshot,
  getFirstOfDay,
  getLastOfDay,
  getTodayUsage,
  getTodayUsageRobust,
  getAvgDailyUsage,
  saveSession,
  getSession,
  deleteSessionRecord,
  saveCredentials,
  getCredentials,
  deleteCredentials,
};
