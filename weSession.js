const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const SEL = require('./selectors');

const DEBUG = String(process.env.DEBUG_WE || '').trim() === '1';
const userPool = new Map(); // chatId -> { context, page, diagnostics }
let sharedBrowser = null;

const {
  initUsageDb,
  saveSnapshot,
  getTodayUsage,
  getAvgDailyUsage,
  saveSession,
  getSession,
  deleteSessionRecord,
} = require('./usageDb');
const logger = require('./logger');

function debugLog(...args) { if (DEBUG) console.log('[WE-DEBUG]', ...args); }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function statePath(chatId) { return path.join(__dirname, 'sessions', `state-${chatId}.json`); }
function debugShotPath(chatId, name) {
  ensureDir(path.join(__dirname, 'sessions'));
  const ts = Date.now();
  return path.join(__dirname, 'sessions', `debug-${chatId}-${name}-${ts}.png`);
}

function numFromText(t) {
  const m = String(t ?? '').replace(',', '.').match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}

function parseRenewalLine(line) {
  const s = String(line ?? '');
  const d = s.match(/Renewal\s*Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
  const rd = s.match(/(\d+)\s*Remaining\s*Days/i);
  return { renewalDate: d ? d[1] : null, remainingDays: rd ? Number(rd[1]) : null };
}

function pickRenewPriceFromEGPs({ egpValues, balanceEGP, routerMonthlyEGP }) {
  const clean = Array.from(new Set((egpValues || []).filter((v) => typeof v === 'number' && v > 0)));
  let candidates = clean;
  if (typeof balanceEGP === 'number') candidates = candidates.filter((v) => v !== balanceEGP);
  if (typeof routerMonthlyEGP === 'number' && routerMonthlyEGP > 0) candidates = candidates.filter((v) => v !== routerMonthlyEGP);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return Math.max(...candidates);
  return null;
}

function isClosedContextError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('Target closed') || msg.includes('has been closed') || msg.includes('Execution context was destroyed');
}

function isMissingBrowserError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('Executable doesn\'t exist at') || msg.includes('download new browsers');
}

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  try {
    sharedBrowser = await chromium.launch({ headless: true });
  } catch (err) {
    if (isMissingBrowserError(err)) throw new Error('BROWSER_NOT_INSTALLED');
    throw err;
  }
  sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
  return sharedBrowser;
}

function getUserEntry(chatId) {
  if (!userPool.has(String(chatId))) userPool.set(String(chatId), { context: null, page: null, diagnostics: {} });
  return userPool.get(String(chatId));
}

async function closeUser(chatId) {
  const entry = getUserEntry(chatId);
  if (entry.page) await entry.page.close().catch(() => { });
  if (entry.context) await entry.context.close().catch(() => { });
  entry.page = null;
  entry.context = null;
}

async function ensureContext(chatId, forceNew = false) {
  const sp = statePath(chatId);
  const entry = getUserEntry(chatId);
  if (forceNew) await closeUser(chatId);
  if (entry.context) return entry.context;

  // 🔥 1. Check DB first (The Radical Solution)
  const dbSession = await getSession(chatId);
  if (dbSession) {
    debugLog(`Restoring session for ${chatId} from Database...`);
    ensureDir(path.dirname(sp));
    fs.writeFileSync(sp, JSON.stringify(dbSession));
  } else if (!fs.existsSync(sp)) {
    throw new Error('NO_SESSION');
  }

  const browser = await getBrowser();
  entry.context = await browser.newContext({ storageState: sp });
  return entry.context;
}

async function ensurePage(chatId, forceNew = false) {
  const entry = getUserEntry(chatId);
  const context = await ensureContext(chatId, forceNew);
  if (forceNew && entry.page) {
    await entry.page.close().catch(() => { });
    entry.page = null;
  }
  if (entry.page && !entry.page.isClosed()) return entry.page;
  entry.page = await context.newPage();
  entry.page.setDefaultTimeout(90000);
  entry.page.setDefaultNavigationTimeout(90000);
  return entry.page;
}

async function waitOverviewHealth(page) {
  const checks = [
    page.locator('text=/Welcome,|Usage Overview|Home Internet/i').first(),
    page.locator(SEL.remainingSpan, { hasText: SEL.remainingHasText }).first(),
  ];
  for (const c of checks) {
    const ok = await c.isVisible().catch(() => false);
    if (ok) return true;
  }
  await page.waitForTimeout(800);
  for (const c of checks) {
    const ok = await c.isVisible().catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function gotoOverview(chatId, { retryOnce = true } = {}) {
  const entry = getUserEntry(chatId);
  let page = await ensurePage(chatId);
  try {
    await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' });
    await waitOverviewHealth(page).catch(() => { });
  } catch (err) {
    if (isClosedContextError(err)) {
      page = await ensurePage(chatId, true);
      await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' });
      await waitOverviewHealth(page).catch(() => { });
    } else {
      throw err;
    }
  }

  const currentUrl = page.url();
  entry.diagnostics.currentUrl = currentUrl;
  if (currentUrl.includes('/signin') || currentUrl.includes('#/home/signin')) {
    await page.waitForTimeout(1500).catch(() => { });
    await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' }).catch(() => { });
    const url2 = page.url();
    entry.diagnostics.currentUrl = url2;
    if (!(url2.includes('/signin') || url2.includes('#/home/signin'))) return page;

    if (retryOnce) {
      await ensureContext(chatId, true);
      return gotoOverview(chatId, { retryOnce: false });
    }
    if (DEBUG) await page.screenshot({ path: debugShotPath(chatId, 'SESSION_EXPIRED') }).catch(() => { });
    throw new Error('SESSION_EXPIRED');
  }

  return page;
}

async function loginAndSave(chatId, serviceNumber, password) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  // High timeouts for slow WE site
  const LONG_TIMEOUT = 120000;
  page.setDefaultTimeout(LONG_TIMEOUT);
  page.setDefaultNavigationTimeout(LONG_TIMEOUT);

  try {
    debugLog(`Starting login for ${chatId}`);
    await page.goto(SEL.signinUrl, { waitUntil: 'networkidle', timeout: LONG_TIMEOUT });

    // Wait for the form to be ready
    await page.waitForSelector(SEL.inputService, { state: 'visible' });

    // Type Service Number
    await page.click(SEL.inputService);
    await page.keyboard.type(String(serviceNumber), { delay: 50 });

    // Select Service Type (Internet)
    debugLog('Selecting service type...');
    const selectorTrigger = page.locator(SEL.selectServiceTypeTrigger).first();
    await selectorTrigger.waitFor({ state: 'visible' });
    await selectorTrigger.click({ force: true });

    // Wait for dropdown and pick 'Internet'
    await page.waitForTimeout(1000);
    const internetOption = page.locator(SEL.selectServiceTypeInternet).filter({ hasText: /Internet/i }).first();
    await internetOption.waitFor({ state: 'visible' });
    await internetOption.click();

    // Type Password
    await page.waitForSelector(SEL.inputPassword, { state: 'visible' });
    await page.click(SEL.inputPassword);
    await page.keyboard.type(String(password), { delay: 50 });

    // Click Login
    const loginBtn = page.locator(SEL.loginButton);
    await loginBtn.waitFor({ state: 'visible' });

    debugLog('Clicking login button...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => { }),
      loginBtn.click({ force: true })
    ]);

    // Check if successful (URL change or specific element)
    await page.waitForTimeout(5000);
    const url = page.url();
    debugLog(`Final URL after login: ${url}`);

    if (url.includes('/signin') || url.includes('login')) {
      // Check for error messages on page
      const errorMsg = await page.locator('.ant-message-notice, .error-message').innerText().catch(() => '');
      if (errorMsg) throw new Error(`WE_SITE_ERROR: ${errorMsg}`);
      // Fallback error
      throw new Error('LOGIN_FAILED_URL_STILL_SIGNIN');
    }

    const sp = statePath(chatId);
    await context.storageState({ path: sp });

    // 🔥 2. Save to DB AFTER saving to file
    const stateData = JSON.parse(fs.readFileSync(sp, 'utf8'));
    await saveSession(chatId, stateData);
    debugLog(`Session for ${chatId} persisted to Database.`);

    await closeUser(chatId);
    return true;
  } catch (err) {
    const shotPath = debugShotPath(chatId, 'LOGIN_FAIL');
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => null);
    logger.error(`Login failed for ${chatId}. Screenshot saved to: ${shotPath}`, err);
    throw err;
  } finally {
    await context.close().catch(() => { });
  }
}

async function openMoreDetailsResilient(page, chatId) {
  const more = page.locator(SEL.moreDetailsSpan, { hasText: SEL.moreDetailsHasText }).first();
  for (let i = 0; i < 6; i += 1) {
    const visible = await more.isVisible().catch(() => false);
    if (visible) {
      await more.scrollIntoViewIfNeeded().catch(() => { });
      await more.click({ force: true }).catch(() => { });
      await page.waitForTimeout(1600);
      const marker = await page.locator('text=/Renewal|Unsubscribe|Router|Renew/i').first().isVisible().catch(() => false);
      if (marker) return { ok: true };
    }
    await page.mouse.wheel(0, 900).catch(() => { });
    await page.waitForTimeout(2000);
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/Renewal\s*Date:/i.test(bodyText)) return { ok: true, fallback: true };

  if (DEBUG) await page.screenshot({ path: debugShotPath(chatId, 'MORE_FAIL') }).catch(() => { });
  return { ok: false, reason: 'MORE_NOT_VISIBLE' };
}

async function extractBasics(page) {
  const plan = await (async () => {
    const titles = page.locator('span[title]');
    const count = await titles.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 60); i += 1) {
      const t = await titles.nth(i).getAttribute('title').catch(() => null);
      if (t && (/GB/i.test(t) || /speed/i.test(t))) return t.trim();
    }
    return '';
  })();

  const remainingBox = page.locator(SEL.remainingSpan, { hasText: SEL.remainingHasText }).first().locator('xpath=..');
  const usedBox = page.locator(SEL.usedSpan, { hasText: SEL.usedHasText }).first().locator('xpath=..');
  const balBlock = page.locator(SEL.balanceText).locator('xpath=..');

  return {
    plan,
    remainingGB: numFromText(await remainingBox.innerText().catch(() => '')),
    usedGB: numFromText(await usedBox.innerText().catch(() => '')),
    balanceEGP: numFromText(await balBlock.innerText().catch(() => '')),
  };
}

async function parseDetailsFromBody(page, bodyText, balanceEGP) {
  const parsed = parseRenewalLine(bodyText.match(/Renewal\s*Date:.*$/im)?.[0] || '');
  const renewBtn = page.locator('button', { hasText: /Renew/i }).first();
  const renewVisible = await renewBtn.isVisible().catch(() => false);
  const renewBtnEnabled = renewVisible ? ((await renewBtn.getAttribute('disabled').catch(() => 'disabled')) === null) : null;
  const idx = bodyText.toLowerCase().indexOf('premium router');
  let routerMonthlyEGP = null;
  let routerRenewalDate = null;
  if (idx >= 0) {
    const seg = bodyText.slice(idx, idx + 900);
    routerMonthlyEGP = numFromText(seg.match(/Price:\s*([\d.,]+)\s*EGP/i)?.[1] || '');
    routerRenewalDate = seg.match(/Renewal Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i)?.[1] || null;
  }
  const egps = Array.from(bodyText.matchAll(/(\d+(?:[.,]\d+)?)\s*EGP/gi)).map((m) => numFromText(m[1]));
  const renewPriceEGP = pickRenewPriceFromEGPs({ egpValues: egps, balanceEGP, routerMonthlyEGP });

  return {
    renewalDate: parsed.renewalDate,
    remainingDays: parsed.remainingDays,
    renewPriceEGP,
    renewBtnEnabled,
    routerName: routerMonthlyEGP ? 'PREMIUM Router' : null,
    routerMonthlyEGP,
    routerRenewalDate,
  };
}

async function fetchWithSession(chatId) {
  const entry = getUserEntry(chatId);
  let page;
  try {
    page = await gotoOverview(chatId);
    const basics = await extractBasics(page);

    // FIX: If basics extraction totally failed (all nulls), page might be broken or session invalid
    if (basics.remainingGB === null && basics.usedGB === null) {
      // Try one reload
      debugLog('Basics null, reloading page once...');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);
      const basicsRetry = await extractBasics(page);
      if (basicsRetry.remainingGB !== null) {
        Object.assign(basics, basicsRetry);
      } else {
        // Still null?
        throw new Error('SESSION_EXPIRED'); // Force re-login
      }
    }

    let details = {
      renewalDate: null,
      remainingDays: null,
      renewPriceEGP: null,
      renewBtnEnabled: null,
      routerName: null,
      routerMonthlyEGP: null,
      routerRenewalDate: null,
      _detailsUnavailable: null,
    };

    const md = await openMoreDetailsResilient(page, chatId);
    entry.diagnostics.moreDetailsVisible = md.ok;
    if (md.ok) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      details = { ...details, ...(await parseDetailsFromBody(page, bodyText, basics.balanceEGP)) };
    } else {
      details._detailsUnavailable = md.reason || 'DETAILS_TEMP_UNAVAILABLE';
    }

    const totalRenewEGP = ((details.renewPriceEGP ?? 0) + (details.routerMonthlyEGP ?? 0)) || null;
    const canAfford = totalRenewEGP != null && basics.balanceEGP != null ? basics.balanceEGP >= totalRenewEGP : null;

    const out = {
      ...basics,
      ...details,
      totalRenewEGP,
      canAfford,
      capturedAt: new Date().toISOString(),
      _pickedMethod: details._detailsUnavailable ? 'BASIC_ONLY' : 'BODY_PARSE',
    };

    entry.diagnostics.lastError = null;
    entry.diagnostics.lastFetchAt = out.capturedAt;
    entry.diagnostics.methodPicked = out._pickedMethod;
    return out;
  } catch (err) {
    entry.diagnostics.lastError = String(err?.message || err || '');
    if (isClosedContextError(err)) throw new Error('BROWSER_CLOSED_DURING_FETCH');
    throw err;
  }
}

async function renewWithSession(chatId) {
  try {
    const page = await gotoOverview(chatId);
    const md = await openMoreDetailsResilient(page, chatId);
    if (!md.ok) throw new Error(md.reason || 'MORE_DETAILS_NOT_FOUND');

    const renewBtn = page.locator('button', { hasText: /Renew/i }).first();
    await renewBtn.waitFor({ state: 'visible', timeout: 20000 });
    const dis = await renewBtn.getAttribute('disabled');
    if (dis !== null) throw new Error('RENEW_DISABLED');

    await renewBtn.click({ force: true });
    await page.waitForTimeout(5000);
    return true;
  } catch (err) {
    if (isClosedContextError(err)) throw new Error('BROWSER_CLOSED_DURING_RENEW');
    throw err;
  }
}

function getSessionDiagnostics(chatId) {
  const entry = getUserEntry(chatId);
  return {
    hasSessionFile: fs.existsSync(statePath(chatId)),
    lastFetchAt: entry.diagnostics.lastFetchAt || null,
    lastError: entry.diagnostics.lastError || null,
    currentUrl: entry.diagnostics.currentUrl || null,
    methodPicked: entry.diagnostics.methodPicked || null,
    moreDetailsVisible: entry.diagnostics.moreDetailsVisible ?? null,
  };
}

async function deleteSession(chatId) {
  const sp = statePath(chatId);
  await closeUser(chatId).catch(() => { });
  if (fs.existsSync(sp)) fs.unlinkSync(sp);

  // 🔥 3. Delete from DB
  await deleteSessionRecord(chatId).catch(() => { });
  debugLog(`Session for ${chatId} deleted from DB.`);
  return true;
}

module.exports = {
  loginAndSave,
  fetchWithSession,
  renewWithSession,
  deleteSession,
  getSessionDiagnostics,
};
