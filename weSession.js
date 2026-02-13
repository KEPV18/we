// weSession.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const SEL = require('./selectors');
const logger = require('./logger');

const { saveSession, getSession, deleteSessionRecord, getCredentials } = require('./usageDb');

const DEBUG = String(process.env.DEBUG_WE || '').trim() === '1';

const MAX_LOGIN_RETRIES = 3;
const LONG_TIMEOUT = 120000;
const MAX_AUTO_RELOGIN = 2;

// Render/Linux safe args
const isLinux = process.platform === 'linux';
const BROWSER_LAUNCH_ARGS = isLinux
  ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  : [];

let sharedBrowser = null;

// Prevent overlap per chatId
const sessionLocks = new Map();
const diagnostics = new Map();

function debugLog(...args) { if (DEBUG) console.log('[WE-DEBUG]', ...args); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function sessionsDir() { const d = path.join(__dirname, 'sessions'); ensureDir(d); return d; }
function statePath(chatId) { return path.join(sessionsDir(), `state-${chatId}.json`); }
function debugShotPath(chatId, name) { return path.join(sessionsDir(), `debug-${chatId}-${name}-${Date.now()}.png`); }

async function safeShot(page, chatId, name) {
  try {
    if (!DEBUG || !page) return;
    const p = debugShotPath(chatId, name);
    await page.screenshot({ path: p, fullPage: true }).catch(() => null);
    debugLog('Saved screenshot:', p);
  } catch {}
}

function numFromText(t) {
  const m = String(t ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/,/g, '.')
    .match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}

function isClosedContextError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('Target closed')
    || msg.includes('has been closed')
    || msg.includes('Execution context was destroyed');
}

function isMissingBrowserError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes("Executable doesn't exist at") || msg.includes('download new browsers');
}

function isSessionError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('SESSION_EXPIRED')
    || msg.includes('BROWSER_CLOSED')
    || msg.includes('Target closed')
    || msg.includes('Navigation failed')
    || msg.includes('NO_SESSION')
    || msg.includes('AUTO_RELOGIN_FAILED')
    || msg.includes('net::ERR')
    || msg.includes('BROWSER_CLOSED_DURING_FETCH')
    || msg.includes('BROWSER_CLOSED_DURING_RENEW');
}

async function withLock(chatId, fn) {
  const id = String(chatId);
  const prev = sessionLocks.get(id) || Promise.resolve();
  let release;
  const gate = new Promise((r) => (release = r));
  sessionLocks.set(id, prev.then(() => gate));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    setTimeout(() => {
      if (sessionLocks.get(id) === gate) sessionLocks.delete(id);
    }, 0);
  }
}

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;

  const headless = process.env.WE_HEADLESS === '0' ? false : true;

  try {
    sharedBrowser = await chromium.launch({
      headless,
      args: BROWSER_LAUNCH_ARGS,
    });
  } catch (err) {
    if (isMissingBrowserError(err)) throw new Error('BROWSER_NOT_INSTALLED');
    throw err;
  }

  sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
  return sharedBrowser;
}

async function ensureStorageStateFile(chatId) {
  const sp = statePath(chatId);

  const dbSession = await getSession(chatId);
  if (dbSession) {
    debugLog(`Restoring session for ${chatId} from Database...`);
    fs.writeFileSync(sp, JSON.stringify(dbSession));
    return sp;
  }

  if (!fs.existsSync(sp)) throw new Error('NO_SESSION');
  return sp;
}

// ========== PARSERS ==========

// accountoverview contains: plan + balance + remaining/used
function parseAccountOverviewText(bodyText) {
  const text = String(bodyText ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
    .trim();

  let plan = '';
  {
    // "Your Current Plan" ثم اسم الباقة
    const m = text.match(/Your Current Plan\s*([^\n]{3,80})/i);
    if (m) plan = m[1].trim();
  }
  if (!plan) {
    // fallback
    const m = text.match(/Super speed[^\n]{0,80}/i);
    if (m) plan = m[0].trim();
  }

  let balanceEGP = null;
  {
    const m = text.match(/Current Balance\s*([\d.,]+)\s*EGP/i);
    if (m) balanceEGP = numFromText(m[1]);
  }

  let remainingGB = null;
  let usedGB = null;
  {
    // Home Internet 361.56 Remaining 38.44 Used
    const m = text.match(/Home Internet\s*([\d.,]+)\s*Remaining\s*([\d.,]+)\s*Used/i);
    if (m) {
      remainingGB = numFromText(m[1]);
      usedGB = numFromText(m[2]);
    }
  }

  return { plan, balanceEGP, remainingGB, usedGB };
}

// overview contains: renewal + router etc
function parseOverviewDetailsText(bodyText) {
  const text = String(bodyText ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
    .trim();

  let renewPriceEGP = null;
  {
    const m = text.match(/Renewal Cost:\s*([\d.,]+)\s*EGP/i);
    if (m) renewPriceEGP = numFromText(m[1]);
  }

  let renewalDate = null;
  let remainingDays = null;
  {
    const m = text.match(/Renewal Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})\s*,?\s*(\d+)\s*Remaining Days/i);
    if (m) {
      renewalDate = m[1];
      remainingDays = Number(m[2]);
    }
  }

  let routerName = null;
  let routerMonthlyEGP = null;
  let routerRenewalDate = null;
  {
    const idx = text.toLowerCase().indexOf('premium router');
    if (idx >= 0) {
      const seg = text.slice(idx, idx + 1600);
      routerName = 'PREMIUM Router';
      const mPrice = seg.match(/Price:\s*([\d.,]+)\s*EGP/i);
      if (mPrice) routerMonthlyEGP = numFromText(mPrice[1]);
      const mDate = seg.match(/Renewal Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
      if (mDate) routerRenewalDate = mDate[1];
    }
  }

  return { renewPriceEGP, renewalDate, remainingDays, routerName, routerMonthlyEGP, routerRenewalDate };
}

// ========== NAV HELPERS ==========

async function waitAccountOverviewReady(page) {
  const checks = [
    page.locator('text=/Usage Overview/i').first(),
    page.locator('text=/Current Balance/i').first(),
    page.locator('text=/Home Internet/i').first(),
    page.locator('text=/Remaining/i').first(),
  ];
  for (let i = 0; i < 18; i += 1) {
    for (const c of checks) {
      if (await c.isVisible().catch(() => false)) return true;
    }
    await page.waitForTimeout(400).catch(() => {});
  }
  return false;
}

async function gotoAccountOverview(page) {
  await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' });
  await waitAccountOverviewReady(page).catch(() => {});
}

async function gotoOverviewPageMaybe(page) {
  // بعد More Details عادة يروح #/overview
  if (!/\/#\/overview/i.test(page.url())) {
    await page.goto('https://my.te.eg/echannel/#/overview', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForTimeout(1200).catch(() => {});
}

// ========== LOGIN HELPERS ==========

// Keyboard-only selection to avoid viewport click issues
async function selectInternetServiceType(page) {
  debugLog('Selecting service type (keyboard)...');

  const trigger = page.locator(SEL.selectServiceTypeTrigger).first();
  await trigger.waitFor({ state: 'visible', timeout: LONG_TIMEOUT });
  await trigger.click({ force: true });

  const dropdown = page.locator('.ant-select-dropdown:visible');
  await dropdown.waitFor({ state: 'visible', timeout: 15000 });

  await page.keyboard.type('internet', { delay: 35 }).catch(() => {});
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(250);

  // ensure close (fallback arrow nav)
  const stillOpen = await dropdown.isVisible().catch(() => false);
  if (stillOpen) {
    for (let i = 0; i < 20; i += 1) {
      const active = dropdown.locator('.ant-select-item-option-active .ant-select-item-option-content').first();
      const txt = await active.innerText().catch(() => '');
      if (/internet/i.test(txt)) {
        await page.keyboard.press('Enter').catch(() => {});
        break;
      }
      await page.keyboard.press('ArrowDown').catch(() => {});
      await page.waitForTimeout(120);
    }
  }

  await dropdown.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
}

async function loginFlow(page, serviceNumber, password) {
  await page.goto(SEL.signinUrl, { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT });
  await page.waitForSelector(SEL.inputService, { state: 'visible', timeout: LONG_TIMEOUT });

  await page.click(SEL.inputService);
  await page.fill(SEL.inputService, String(serviceNumber));

  await selectInternetServiceType(page);

  await page.waitForSelector(SEL.inputPassword, { state: 'visible', timeout: LONG_TIMEOUT });
  await page.click(SEL.inputPassword);
  await page.fill(SEL.inputPassword, String(password));

  const loginBtn = page.locator(SEL.loginButton);
  await loginBtn.waitFor({ state: 'visible', timeout: LONG_TIMEOUT });

  debugLog('Clicking login button...');
  await loginBtn.click({ force: true });

  await Promise.race([
    page.waitForURL(/accountoverview/i, { timeout: LONG_TIMEOUT }).catch(() => null),
    page.locator('text=/Welcome|Usage Overview|Home Internet/i').first()
      .waitFor({ state: 'visible', timeout: LONG_TIMEOUT }).catch(() => null),
  ]);

  await gotoAccountOverview(page);
}

// ========== PUBLIC API ==========

async function loginAndSave(chatId, serviceNumber, password, retryCount = 0) {
  return withLock(chatId, async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    page.setDefaultTimeout(LONG_TIMEOUT);
    page.setDefaultNavigationTimeout(LONG_TIMEOUT);

    try {
      debugLog(`Starting login for ${chatId} (Attempt ${retryCount + 1}/${MAX_LOGIN_RETRIES})`);
      await loginFlow(page, serviceNumber, password);

      const sp = statePath(chatId);
      await context.storageState({ path: sp });

      const stateData = JSON.parse(fs.readFileSync(sp, 'utf8'));
      await saveSession(chatId, stateData);
      debugLog(`Session for ${chatId} persisted to Database.`);

      diagnostics.set(String(chatId), {
        lastError: null,
        currentUrl: page.url(),
        lastFetchAt: null,
        methodPicked: 'LOGIN_OK',
        moreDetailsVisible: null,
      });

      return true;
    } catch (err) {
      await safeShot(page, chatId, 'LOGIN_FAIL');
      logger.error(`Login failed for ${chatId}`, err);

      if (retryCount < MAX_LOGIN_RETRIES - 1) {
        await context.close().catch(() => {});
        await sleep(1500);
        return loginAndSave(chatId, serviceNumber, password, retryCount + 1);
      }
      throw err;
    } finally {
      await context.close().catch(() => {});
    }
  });
}

async function autoRelogin(chatId) {
  debugLog(`Attempting auto-relogin for ${chatId}...`);
  const creds = await getCredentials(chatId);
  if (!creds) throw new Error('NO_CREDENTIALS_SAVED');

  await loginAndSave(chatId, creds.serviceNumber, creds.password);
  debugLog(`Auto-relogin successful for ${chatId}`);
  return true;
}

async function fetchWithSession(chatId, autoReloginAttempt = 0) {
  return withLock(chatId, async () => {
    const id = String(chatId);
    const diag = diagnostics.get(id) || {};

    const browser = await getBrowser();
    const context = await browser.newContext({
      storageState: await ensureStorageStateFile(chatId),
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);

    try {
      // 1) accountoverview -> basics
      await gotoAccountOverview(page);

      let basicsText = await page.locator('body').innerText().catch(() => '');
      let basics = parseAccountOverviewText(basicsText);

      if (basics.remainingGB == null || basics.usedGB == null || basics.balanceEGP == null) {
        debugLog('Basics incomplete, reloading accountoverview once...');
        await safeShot(page, chatId, 'BASICS_INCOMPLETE_BEFORE_RELOAD');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await waitAccountOverviewReady(page).catch(() => {});
        await page.waitForTimeout(1200).catch(() => {});
        basicsText = await page.locator('body').innerText().catch(() => '');
        basics = parseAccountOverviewText(basicsText);
      }

      // 2) click More Details -> overview -> details
      let details = {
        renewPriceEGP: null,
        renewalDate: null,
        remainingDays: null,
        routerName: null,
        routerMonthlyEGP: null,
        routerRenewalDate: null,
      };

      let usedMoreDetails = false;
      const more = page.getByText(/More Details/i).first();
      const moreVisible = await more.isVisible().catch(() => false);

      if (moreVisible) {
        usedMoreDetails = true;
        await more.scrollIntoViewIfNeeded().catch(() => {});
        await more.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1200).catch(() => {});
        await gotoOverviewPageMaybe(page);

        const detailsText = await page.locator('body').innerText().catch(() => '');
        details = { ...details, ...parseOverviewDetailsText(detailsText) };
      }

      // renew button enabled? (on overview page usually)
      const renewBtn = page.locator('button', { hasText: /Renew/i }).first();
      const renewVisible = await renewBtn.isVisible().catch(() => false);
      const renewBtnEnabled = renewVisible
        ? ((await renewBtn.getAttribute('disabled').catch(() => 'disabled')) === null)
        : null;

      const totalGB = (basics.usedGB != null && basics.remainingGB != null)
        ? basics.usedGB + basics.remainingGB
        : null;

      const totalRenewEGP = ((details.renewPriceEGP ?? 0) + (details.routerMonthlyEGP ?? 0)) || null;
      const canAfford = (totalRenewEGP != null && basics.balanceEGP != null)
        ? basics.balanceEGP >= totalRenewEGP
        : null;

      const out = {
        plan: basics.plan || '',
        remainingGB: basics.remainingGB,
        usedGB: basics.usedGB,
        balanceEGP: basics.balanceEGP,

        renewalDate: details.renewalDate,
        remainingDays: details.remainingDays,
        renewPriceEGP: details.renewPriceEGP,
        renewBtnEnabled,

        routerName: details.routerName,
        routerMonthlyEGP: details.routerMonthlyEGP,
        routerRenewalDate: details.routerRenewalDate,

        totalGB,
        totalRenewEGP,
        canAfford,
        capturedAt: new Date().toISOString(),
        _pickedMethod: usedMoreDetails ? 'ACCOUNTOVERVIEW + OVERVIEW' : 'ACCOUNTOVERVIEW_ONLY',
      };

      diagnostics.set(id, {
        ...diag,
        lastError: null,
        currentUrl: page.url(),
        lastFetchAt: out.capturedAt,
        methodPicked: out._pickedMethod,
        moreDetailsVisible: usedMoreDetails,
      });

      return out;
    } catch (err) {
      const msg = String(err?.message || err || '');
      diagnostics.set(id, {
        ...diag,
        lastError: msg,
        currentUrl: page.url?.() || diag.currentUrl || null,
      });

      if (isSessionError(err) && autoReloginAttempt < MAX_AUTO_RELOGIN) {
        debugLog(`Session error detected. Auto-relogin attempt ${autoReloginAttempt + 1}/${MAX_AUTO_RELOGIN}`);
        try {
          await context.close().catch(() => {});
          await autoRelogin(chatId);
          return fetchWithSession(chatId, autoReloginAttempt + 1);
        } catch (reloginErr) {
          throw new Error(`AUTO_RELOGIN_FAILED: ${reloginErr.message}`);
        }
      }

      if (isClosedContextError(err)) throw new Error('BROWSER_CLOSED_DURING_FETCH');
      throw err;
    } finally {
      await context.close().catch(() => {});
    }
  });
}

async function renewWithSession(chatId) {
  return withLock(chatId, async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({
      storageState: await ensureStorageStateFile(chatId),
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);

    try {
      // renew غالبًا في overview
      await page.goto('https://my.te.eg/echannel/#/overview', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1200).catch(() => {});

      const renewBtn = page.locator('button', { hasText: /Renew/i }).first();
      await renewBtn.waitFor({ state: 'visible', timeout: 20000 });
      const dis = await renewBtn.getAttribute('disabled');
      if (dis !== null) throw new Error('RENEW_DISABLED');

      await renewBtn.click({ force: true });
      await page.waitForTimeout(4000);
      return true;
    } catch (err) {
      if (isClosedContextError(err)) throw new Error('BROWSER_CLOSED_DURING_RENEW');
      throw err;
    } finally {
      await context.close().catch(() => {});
    }
  });
}

function getSessionDiagnostics(chatId) {
  const id = String(chatId);
  const d = diagnostics.get(id) || {};
  return {
    hasSessionFile: fs.existsSync(statePath(chatId)),
    lastFetchAt: d.lastFetchAt || null,
    lastError: d.lastError || null,
    currentUrl: d.currentUrl || null,
    methodPicked: d.methodPicked || null,
    moreDetailsVisible: d.moreDetailsVisible ?? null,
  };
}

async function deleteSession(chatId) {
  return withLock(chatId, async () => {
    const sp = statePath(chatId);
    if (fs.existsSync(sp)) fs.unlinkSync(sp);
    await deleteSessionRecord(chatId).catch(() => {});
    debugLog(`Session for ${chatId} deleted from DB.`);
    diagnostics.delete(String(chatId));
    return true;
  });
}

module.exports = {
  loginAndSave,
  fetchWithSession,
  renewWithSession,
  deleteSession,
  getSessionDiagnostics,
  autoRelogin,
  isSessionError,
};
