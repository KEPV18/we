const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./usage.db');

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

    // ترقيات لو DB قديمة
    safeAlter(`ALTER TABLE snapshots ADD COLUMN routerMonthlyEGP REAL`);
    safeAlter(`ALTER TABLE snapshots ADD COLUMN routerRenewalDate TEXT`);
    safeAlter(`ALTER TABLE snapshots ADD COLUMN totalRenewEGP REAL`);
  });
}

function insertSnapshot(chatId, s) {
  return new Promise((resolve, reject) => {
    const day = s.capturedAt.slice(0, 10);

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
  const day = now.toISOString().slice(0, 10);
  const [first, last] = await Promise.all([
    getFirstOfDay(chatId, day),
    getLastOfDay(chatId, day),
  ]);

  if (!first || !last) return 0;
  if (first.usedGB == null || last.usedGB == null) return 0;

  const delta = Number(last.usedGB) - Number(first.usedGB);
  return delta > 0 ? delta : 0;
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

module.exports = {
  initUsageDb,
  insertSnapshot,
  saveSnapshot,
  getFirstOfDay,
  getLastOfDay,
  getTodayUsage,
  getAvgDailyUsage,
};
