const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./usage.db');

function safeAlter(sql) {
  return new Promise((resolve) => {
    db.run(sql, () => resolve()); // لو فشل عادي (العمود موجود)
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

module.exports = { initUsageDb, insertSnapshot, getFirstOfDay, getLastOfDay };
