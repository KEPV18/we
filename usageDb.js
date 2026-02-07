const fs = require('fs');
const path = require('path');
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

function cairoDay(isoOrDate = new Date()) {
  const d = new Date(isoOrDate);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
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

    db.run(`
      CREATE TABLE IF NOT EXISTS renew_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        status TEXT NOT NULL,
        amountEGP REAL,
        details TEXT,
        createdAt TEXT NOT NULL
      )
    `);

    safeAlter(`ALTER TABLE snapshots ADD COLUMN routerMonthlyEGP REAL`);
    safeAlter(`ALTER TABLE snapshots ADD COLUMN routerRenewalDate TEXT`);
    safeAlter(`ALTER TABLE snapshots ADD COLUMN totalRenewEGP REAL`);
  });
}

function insertSnapshot(chatId, s) {
  return new Promise((resolve, reject) => {
    const day = cairoDay(s.capturedAt);
    db.run(
      `INSERT INTO snapshots(
        chatId, day, capturedAt,
        usedGB, remainingGB, plan, balanceEGP,
        renewalDate, remainingDays, renewPriceEGP,
        routerMonthlyEGP, routerRenewalDate, totalRenewEGP
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(chatId), day, s.capturedAt,
        s.usedGB ?? null, s.remainingGB ?? null, s.plan ?? null, s.balanceEGP ?? null,
        s.renewalDate ?? null, s.remainingDays ?? null, s.renewPriceEGP ?? null,
        s.routerMonthlyEGP ?? null, s.routerRenewalDate ?? null, s.totalRenewEGP ?? null,
      ],
      (e) => (e ? reject(e) : resolve(day))
    );
  });
}

async function getLatestSnapshot(chatId) {
  return dbGet(`SELECT * FROM snapshots WHERE chatId=? ORDER BY capturedAt DESC LIMIT 1`, [String(chatId)]);
}

async function saveSnapshot(chatId, snapshot, opts = {}) {
  if (!snapshot || !snapshot.capturedAt) throw new Error('INVALID_SNAPSHOT');
  const minIntervalMinutes = Number(opts.minIntervalMinutes ?? 0);
  if (minIntervalMinutes > 0 && !opts.force) {
    const last = await getLatestSnapshot(chatId);
    if (last?.capturedAt) {
      const diffMs = new Date(snapshot.capturedAt).getTime() - new Date(last.capturedAt).getTime();
      if (diffMs >= 0 && diffMs < minIntervalMinutes * 60 * 1000) return last.day;
    }
  }
  return insertSnapshot(chatId, snapshot);
}

function getFirstOfDay(chatId, day) {
  return dbGet(`SELECT * FROM snapshots WHERE chatId=? AND day=? ORDER BY capturedAt ASC LIMIT 1`, [String(chatId), day]);
}

function getLastOfDay(chatId, day) {
  return dbGet(`SELECT * FROM snapshots WHERE chatId=? AND day=? ORDER BY capturedAt DESC LIMIT 1`, [String(chatId), day]);
}

async function getTodayUsage(chatId, now = new Date()) {
  const day = cairoDay(now);
  const rows = await dbAll(
    `SELECT MIN(usedGB) AS minUsed, MAX(usedGB) AS maxUsed FROM snapshots WHERE chatId=? AND day=? AND usedGB IS NOT NULL`,
    [String(chatId), day]
  );
  const r = rows[0];
  if (!r || r.minUsed == null || r.maxUsed == null) return 0;
  const delta = Number(r.maxUsed) - Number(r.minUsed);
  if (delta >= 0) return delta;
  return Number(r.maxUsed) || 0;
}

async function getAvgDailyUsage(chatId, days = 14) {
  const rows = await dbAll(
    `SELECT day, MIN(usedGB) AS minUsed, MAX(usedGB) AS maxUsed
     FROM snapshots
     WHERE chatId = ? AND usedGB IS NOT NULL
     GROUP BY day
     ORDER BY day DESC
     LIMIT ?`,
    [String(chatId), Number(days)]
  );
  if (!rows.length) return null;
  const deltas = rows.map((r) => {
    const d = Number(r.maxUsed) - Number(r.minUsed);
    return d >= 0 ? d : Number(r.maxUsed) || 0;
  }).filter((v) => Number.isFinite(v));
  if (!deltas.length) return null;
  return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

async function getRangeUsage(chatId, days = 7) {
  const rows = await dbAll(
    `SELECT day, MIN(usedGB) AS minUsed, MAX(usedGB) AS maxUsed
     FROM snapshots
     WHERE chatId = ? AND usedGB IS NOT NULL
     GROUP BY day
     ORDER BY day DESC
     LIMIT ?`,
    [String(chatId), Number(days)]
  );
  return rows.map((r) => {
    const d = Number(r.maxUsed) - Number(r.minUsed);
    return { day: r.day, usage: d >= 0 ? d : Number(r.maxUsed) || 0 };
  }).reverse();
}

async function getMonthUsage(chatId, now = new Date()) {
  const monthPrefix = cairoDay(now).slice(0, 7);
  const rows = await dbAll(
    `SELECT day, MIN(usedGB) AS minUsed, MAX(usedGB) AS maxUsed
     FROM snapshots
     WHERE chatId = ? AND day LIKE ? AND usedGB IS NOT NULL
     GROUP BY day`,
    [String(chatId), `${monthPrefix}%`]
  );
  return rows.reduce((sum, r) => {
    const d = Number(r.maxUsed) - Number(r.minUsed);
    return sum + (d >= 0 ? d : Number(r.maxUsed) || 0);
  }, 0);
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
    `INSERT INTO reminder_settings(chatId, enabled, dailyMultiplier, monthlyRatio, createdAt, updatedAt)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(chatId) DO UPDATE SET
      enabled=excluded.enabled,
      dailyMultiplier=excluded.dailyMultiplier,
      monthlyRatio=excluded.monthlyRatio,
      updatedAt=excluded.updatedAt`,
    [String(chatId), merged.enabled ? 1 : 0, Number(merged.dailyMultiplier), Number(merged.monthlyRatio), nowIso, nowIso]
  );
  return getReminderSettings(chatId);
}

async function getReminderSettings(chatId) {
  const row = await dbGet(`SELECT * FROM reminder_settings WHERE chatId=?`, [String(chatId)]);
  if (!row) return { chatId: String(chatId), enabled: 1, dailyMultiplier: 1.6, monthlyRatio: 1.2 };
  return row;
}

async function getTrackedChatIds() {
  const rows = await dbAll(`SELECT chatId FROM snapshots UNION SELECT chatId FROM reminder_settings`);
  return rows.map((r) => String(r.chatId));
}

async function wasAlertSent(chatId, alertKey, day = cairoDay()) {
  const row = await dbGet(`SELECT id FROM alert_events WHERE chatId=? AND alertKey=? AND day=? LIMIT 1`, [String(chatId), String(alertKey), String(day)]);
  return !!row;
}

async function markAlertSent(chatId, alertKey, day = cairoDay()) {
  await dbRun(`INSERT OR IGNORE INTO alert_events(chatId, alertKey, day, createdAt) VALUES(?,?,?,?)`, [String(chatId), String(alertKey), String(day), new Date().toISOString()]);
  return true;
}

async function logRenewAction(chatId, status, amountEGP = null, details = '') {
  await dbRun(`INSERT INTO renew_logs(chatId, status, amountEGP, details, createdAt) VALUES(?,?,?,?,?)`, [String(chatId), String(status), amountEGP == null ? null : Number(amountEGP), String(details || ''), new Date().toISOString()]);
}

async function wipeUserData(chatId) {
  await dbRun(`DELETE FROM snapshots WHERE chatId=?`, [String(chatId)]);
  await dbRun(`DELETE FROM reminder_settings WHERE chatId=?`, [String(chatId)]);
  await dbRun(`DELETE FROM alert_events WHERE chatId=?`, [String(chatId)]);
  await dbRun(`DELETE FROM renew_logs WHERE chatId=?`, [String(chatId)]);
  const sp = path.join(__dirname, 'sessions', `state-${chatId}.json`);
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
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
  getRangeUsage,
  getMonthUsage,
  getLatestSnapshot,
  getReminderSettings,
  upsertReminderSettings,
  getTrackedChatIds,
  wasAlertSent,
  markAlertSent,
  logRenewAction,
  wipeUserData,
  cairoDay,
};
