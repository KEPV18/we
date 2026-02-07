const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./usage.db');

function safeAlter(sql) {
  return new Promise((resolve) => {
    db.run(sql, () => resolve());
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (e, row) => (e ? reject(e) : resolve(row || null)));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows || [])));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (e) => (e ? reject(e) : resolve(true)));
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

    db.run(`
      CREATE TABLE IF NOT EXISTS reminder_settings (
        chatId TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        dailyMultiplier REAL NOT NULL DEFAULT 1.6,
        monthlyRatio REAL NOT NULL DEFAULT 1.2,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        alertKey TEXT NOT NULL,
        day TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(chatId, alertKey, day)
      )
    `);

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
        String(chatId), day, s.capturedAt,
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
  return dbGet(
    `SELECT * FROM snapshots WHERE chatId=? AND day=? ORDER BY capturedAt ASC LIMIT 1`,
    [String(chatId), day]
  );
}

function getLastOfDay(chatId, day) {
  return dbGet(
    `SELECT * FROM snapshots WHERE chatId=? AND day=? ORDER BY capturedAt DESC LIMIT 1`,
    [String(chatId), day]
  );
}

async function getTodayUsage(chatId, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const [first, last] = await Promise.all([getFirstOfDay(chatId, day), getLastOfDay(chatId, day)]);
  if (!first || !last) return 0;
  if (first.usedGB == null || last.usedGB == null) return 0;
  return Math.max(0, Number(last.usedGB) - Number(first.usedGB));
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
  return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

async function getMonthUsage(chatId, now = new Date()) {
  const monthPrefix = now.toISOString().slice(0, 7); // YYYY-MM
  const rows = await dbAll(
    `
      SELECT day, MIN(usedGB) AS minUsed, MAX(usedGB) AS maxUsed
      FROM snapshots
      WHERE chatId = ? AND day LIKE ? AND usedGB IS NOT NULL
      GROUP BY day
      ORDER BY day ASC
    `,
    [String(chatId), `${monthPrefix}%`]
  );

  if (!rows.length) return 0;
  return rows
    .map((r) => Math.max(0, Number(r.maxUsed) - Number(r.minUsed)))
    .filter((v) => Number.isFinite(v))
    .reduce((a, b) => a + b, 0);
}

async function getLatestSnapshot(chatId) {
  return dbGet(
    `SELECT * FROM snapshots WHERE chatId=? ORDER BY capturedAt DESC LIMIT 1`,
    [String(chatId)]
  );
}

async function upsertReminderSettings(chatId, patch = {}) {
  const current = await getReminderSettings(chatId);
  const merged = {
    enabled: patch.enabled ?? current.enabled,
    dailyMultiplier: patch.dailyMultiplier ?? current.dailyMultiplier,
    monthlyRatio: patch.monthlyRatio ?? current.monthlyRatio,
  };
  const nowIso = new Date().toISOString();

  await dbRun(
    `
      INSERT INTO reminder_settings(chatId, enabled, dailyMultiplier, monthlyRatio, createdAt, updatedAt)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(chatId) DO UPDATE SET
        enabled=excluded.enabled,
        dailyMultiplier=excluded.dailyMultiplier,
        monthlyRatio=excluded.monthlyRatio,
        updatedAt=excluded.updatedAt
    `,
    [String(chatId), merged.enabled ? 1 : 0, Number(merged.dailyMultiplier), Number(merged.monthlyRatio), nowIso, nowIso]
  );

  return getReminderSettings(chatId);
}

async function getReminderSettings(chatId) {
  const row = await dbGet(`SELECT * FROM reminder_settings WHERE chatId=?`, [String(chatId)]);
  if (!row) {
    return {
      chatId: String(chatId),
      enabled: 1,
      dailyMultiplier: 1.6,
      monthlyRatio: 1.2,
    };
  }
  return row;
}

async function getTrackedChatIds() {
  const rows = await dbAll(
    `
      SELECT chatId FROM snapshots
      UNION
      SELECT chatId FROM reminder_settings
    `
  );
  return rows.map((r) => String(r.chatId));
}

async function wasAlertSent(chatId, alertKey, day = new Date().toISOString().slice(0, 10)) {
  const row = await dbGet(
    `SELECT id FROM alert_events WHERE chatId=? AND alertKey=? AND day=? LIMIT 1`,
    [String(chatId), String(alertKey), String(day)]
  );
  return !!row;
}

async function markAlertSent(chatId, alertKey, day = new Date().toISOString().slice(0, 10)) {
  await dbRun(
    `INSERT OR IGNORE INTO alert_events(chatId, alertKey, day, createdAt) VALUES(?,?,?,?)`,
    [String(chatId), String(alertKey), String(day), new Date().toISOString()]
  );
  return true;
}

module.exports = {
  initUsageDb,
  insertSnapshot,
  saveSnapshot,
  getFirstOfDay,
  getLastOfDay,
  getTodayUsage,
  getAvgDailyUsage,
  getMonthUsage,
  getLatestSnapshot,
  getReminderSettings,
  upsertReminderSettings,
  getTrackedChatIds,
  wasAlertSent,
  markAlertSent,
};
