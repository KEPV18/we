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

    // 🔥 New Sessions Table for Persistent Logins
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        chatId TEXT PRIMARY KEY,
        sessionData TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    // 🔥 New User States Table for Wizard Persistence
    db.run(`
      CREATE TABLE IF NOT EXISTS user_states (
        chatId TEXT PRIMARY KEY,
        stateData TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    // 🔥 New User Credentials Table for Auto-Login
    db.run(`
      CREATE TABLE IF NOT EXISTS user_credentials (
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

    db.run(`
      CREATE TABLE IF NOT EXISTS user_static (
        chatId TEXT PRIMARY KEY,
        plan TEXT,
        balanceEGP REAL,
        renewalDate TEXT,
        renewPriceEGP REAL,
        routerMonthlyEGP REAL,
        routerRenewalDate TEXT,
        updatedAt TEXT NOT NULL
      )
    `);
    // 🔥 Seed Default Credentials (Workaround for Ephemeral Storage on Render Free Tier)
    const seedChatId = '5670001305';
    const seedService = '0228884093';
    const seedPass = 'Ahmed@19033';

    db.run(
      `INSERT OR IGNORE INTO user_credentials(chatId, serviceNumber, password, updatedAt) VALUES(?, ?, ?, ?)`,
      [seedChatId, seedService, seedPass, new Date().toISOString()]
    );
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

  // Previous day formatting
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);

  const [lastYesterday, lastToday] = await Promise.all([
    getLastOfDay(chatId, yesterday),
    getLastOfDay(chatId, day),
  ]);

  // If we have no data for today yet, return 0
  if (!lastToday || lastToday.usedGB == null) return { usage: 0, since: null };

  let usage = 0;
  let referenceLabel = 'start of day';

  if (lastYesterday && lastYesterday.usedGB != null) {
    // Best Case: We have data from yesterday
    const delta = Number(lastToday.usedGB) - Number(lastYesterday.usedGB);
    usage = delta > 0 ? delta : 0;
    referenceLabel = 'yesterday';
  } else {
    // Fallback: Use first of today if yesterday is missing
    const firstToday = await getFirstOfDay(chatId, day);
    if (firstToday && firstToday.usedGB != null) {
      const delta = Number(lastToday.usedGB) - Number(firstToday.usedGB);
      usage = delta > 0 ? delta : 0;
      referenceLabel = 'first check today';
    }
  }

  // Format "since" time
  const lastUpdateDate = new Date(lastToday.capturedAt);
  const since = lastUpdateDate.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });

  return { usage, since };
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

// 🔥 User State Management Functions
function saveUserState(chatId, stateData) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO user_states(chatId, stateData, updatedAt) VALUES(?, ?, ?)
       ON CONFLICT(chatId) DO UPDATE SET stateData=excluded.stateData, updatedAt=excluded.updatedAt`,
      [String(chatId), JSON.stringify(stateData), now],
      (e) => (e ? reject(e) : resolve(true))
    );
  });
}

function getUserState(chatId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT stateData FROM user_states WHERE chatId=?`,
      [String(chatId)],
      (e, row) => (e ? reject(e) : resolve(row ? JSON.parse(row.stateData) : null))
    );
  });
}

function deleteUserState(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM user_states WHERE chatId=?`, [String(chatId)], (e) => (e ? reject(e) : resolve(true)));
  });
}

// 🔥 Credential Management Functions
function saveCredentials(chatId, serviceNumber, password) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO user_credentials(chatId, serviceNumber, password, updatedAt) VALUES(?, ?, ?, ?)
       ON CONFLICT(chatId) DO UPDATE SET serviceNumber=excluded.serviceNumber, password=excluded.password, updatedAt=excluded.updatedAt`,
      [String(chatId), String(serviceNumber), String(password), now],
      (e) => (e ? reject(e) : resolve(true))
    );
  });
}

function getCredentials(chatId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT serviceNumber, password FROM user_credentials WHERE chatId=?`,
      [String(chatId)],
      (e, row) => (e ? reject(e) : resolve(row || null))
    );
  });
}

function deleteCredentials(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM user_credentials WHERE chatId=?`, [String(chatId)], (e) => (e ? reject(e) : resolve(true)));
  });
}

function saveStaticInfo(chatId, info) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO user_static(chatId, plan, balanceEGP, renewalDate, renewPriceEGP, routerMonthlyEGP, routerRenewalDate, updatedAt)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(chatId) DO UPDATE SET
         plan=excluded.plan,
         balanceEGP=excluded.balanceEGP,
         renewalDate=excluded.renewalDate,
         renewPriceEGP=excluded.renewPriceEGP,
         routerMonthlyEGP=excluded.routerMonthlyEGP,
         routerRenewalDate=excluded.routerRenewalDate,
         updatedAt=excluded.updatedAt`,
      [
        String(chatId),
        info.plan ?? null,
        info.balanceEGP ?? null,
        info.renewalDate ?? null,
        info.renewPriceEGP ?? null,
        info.routerMonthlyEGP ?? null,
        info.routerRenewalDate ?? null,
        now
      ],
      (e) => (e ? reject(e) : resolve(true))
    );
  });
}

function getStaticInfo(chatId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT plan, balanceEGP, renewalDate, renewPriceEGP, routerMonthlyEGP, routerRenewalDate, updatedAt FROM user_static WHERE chatId=?`,
      [String(chatId)],
      (e, row) => (e ? reject(e) : resolve(row || null))
    );
  });
}

function deleteStaticInfo(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM user_static WHERE chatId=?`, [String(chatId)], (e) => (e ? reject(e) : resolve(true)));
  });
}

module.exports = {
  initUsageDb,
  insertSnapshot,
  saveSnapshot,
  getFirstOfDay,
  getLastOfDay,
  getTodayUsage,
  getAvgDailyUsage,
  saveSession,
  getSession,
  deleteSessionRecord,
  saveUserState,
  getUserState,
  deleteUserState,
  saveCredentials,
  getCredentials,
  deleteCredentials,
  saveStaticInfo,
  getStaticInfo,
  deleteStaticInfo,
};
