const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const SEL = require('./selectors');

const DEBUG = String(process.env.DEBUG_WE || '').trim() === '1';
const userPool = new Map(); // chatId -> { context, page, diagnostics }
let sharedBrowser = null;

const {
  saveSession,
  getSession,
  deleteSessionRecord,
  getCredentials,
} = require('./usageDb');
const logger = require('./logger');

// ============ Constants ============
const MAX_LOGIN_RETRIES = 3;
const LONG_TIMEOUT = 120000;
const SHORT_TIMEOUT = 30000;

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

function isSessionError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('SESSION_EXPIRED') || 
         msg.includes('BROWSER_CLOSED') || 
         msg.includes('Target closed') || 
         msg.includes('Navigation failed') ||
         msg.includes('NO_SESSION') ||
         msg.includes('AUTO_RELOGIN_FAILED') ||
         msg.includes('net::ERR');
}

// ============ Sleep Utility ============
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ Browser Management ============
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

  // 1. Check DB first
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
    throw new Error(`SESSION_EXPIRED (Redirected to: ${url2})`);
  }

  return page;
}

// ============ Login with Auto-Retry ============
async function loginAndSave(chatId, serviceNumber, password, retryCount = 0) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  page.setDefaultTimeout(LONG_TIMEOUT);
  page.setDefaultNavigationTimeout(LONG_TIMEOUT);

  try {
    debugLog(`Starting login for ${chatId} (Attempt ${retryCount + 1}/${MAX_LOGIN_RETRIES})`);
    await page.goto(SEL.signinUrl, { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT });

    // Wait for the form to be ready
    await page.waitForSelector(SEL.inputService, { state: 'visible' });

    // Type Service Number
    await page.click(SEL.inputService);
    await page.fill(SEL.inputService, String(serviceNumber));

    // Select Service Type (Internet)
    debugLog('Selecting service type...');
    const selectorTrigger = page.locator(SEL.selectServiceTypeTrigger).first();
    await selectorTrigger.waitFor({ state: 'visible' });
    await selectorTrigger.click({ force: true });

    // Wait for dropdown and pick 'Internet'
    const internetOption = page.locator(SEL.selectServiceTypeInternet).filter({ hasText: /Internet/i }).first();
    await internetOption.waitFor({ state: 'visible' });
    await internetOption.click();

    // Type Password
    await page.waitForSelector(SEL.inputPassword, { state: 'visible' });
    await page.click(SEL.inputPassword);
    await page.fill(SEL.inputPassword, String(password));

    // Click Login
    const loginBtn = page.locator(SEL.loginButton);
    await loginBtn.waitFor({ state: 'visible' });

    debugLog('Clicking login button...');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => debugLog('Navigation timeout or already there', e)),
      loginBtn.click({ force: true })
    ]);

    // Check if successful
    await page.waitForTimeout(3000);
    const url = page.url();
    debugLog(`Final URL after login: ${url}`);

    if (url.includes('/signin') || url.includes('login')) {
      const errorMsg = await page.locator('.ant-message-notice, .error-message').innerText().catch(() => '');
      if (errorMsg) throw new Error(`WE_SITE_ERROR: ${errorMsg}`);

      const successMarker = await page.locator('text=/Welcome|Usage Overview|Home Internet/i').first().isVisible().catch(() => false);
      if (!successMarker) {
        throw new Error('LOGIN_FAILED_URL_STILL_SIGNIN');
      }
    }

    const sp = statePath(chatId);
    ensureDir(path.dirname(sp));
    await context.storageState({ path: sp });

    // Save to DB
    const stateData = JSON.parse(fs.readFileSync(sp, 'utf8'));
    await saveSession(chatId, stateData);
    debugLog(`Session for ${chatId} persisted to Database.`);

    await closeUser(chatId);
    return true;
  } catch (err) {
    const shotPath = debugShotPath(chatId, 'LOGIN_FAIL');
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => null);
    logger.error(`Login failed for ${chatId}. Screenshot saved to: ${shotPath}`, err);

    // Retry logic
    if (retryCount < MAX_LOGIN_RETRIES - 1) {
      debugLog(`Retrying login... (${retryCount + 2}/${MAX_LOGIN_RETRIES})`);
      await context.close().catch(() => { });
      await sleep(2000); // Wait before retry
      return loginAndSave(chatId, serviceNumber, password, retryCount + 1);
    }
    
    throw err;
  } finally {
    await context.close().catch(() => { });
  }
}

// ============ Auto Re-login Helper ============
async function autoRelogin(chatId) {
  debugLog(`Attempting auto-relogin for ${chatId}...`);
  const creds = await getCredentials(chatId);
  if (!creds) {
    throw new Error('NO_CREDENTIALS_SAVED');
  }
  
  await closeUser(chatId);
  await loginAndSave(chatId, creds.serviceNumber, creds.password);
  debugLog(`Auto-relogin successful for ${chatId}`);
  return true;
}

async function openMoreDetailsResilient(page, chatId) {
  const more = page.locator(SEL.moreDetailsSpan, { hasText: SEL.moreDetailsHasText }).first();

  try {
    await more.waitFor({ state: 'visible', timeout: 5000 });
  } catch (e) {
    // If not visible immediately, proceed to scroll logic
  }

  for (let i = 0; i < 4; i += 1) {
    const visible = await more.isVisible().catch(() => false);
    if (visible) {
      await more.scrollIntoViewIfNeeded().catch(() => { });
      await more.click({ force: true }).catch(() => { });

      const marker = page.locator('text=/Renewal|Unsubscribe|Router|Renew/i').first();
      try {
        await marker.waitFor({ state: 'visible', timeout: 2500 });
        return { ok: true };
      } catch (e) {
        // click might have failed, try again
      }
    } else {
      await page.mouse.wheel(0, 500).catch(() => { });
      await page.waitForTimeout(1000);
    }
  }

  // Fallback
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/Renewal\s*Date:/i.test(bodyText)) return { ok: true, fallback: true };

  const visible = await more.isVisible().catch(() => false);
  if (visible) {
    await more.evaluate(node => node.click()).catch(() => { });
    await page.waitForTimeout(1500);
    const textAfter = await page.locator('body').innerText().catch(() => '');
    if (/Renewal\s*Date:/i.test(textAfter)) return { ok: true, fallback: true };
  }

  if (DEBUG) await page.screenshot({ path: debugShotPath(chatId, 'MORE_FAIL') }).catch(() => { });
  return { ok: false, reason: 'MORE_NOT_VISIBLE' };
}

async function extractBasics(page) {
  const plan = await (async () => {
    const titles = page.locator('span[title]');
    const count = await titles.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 60); i += 1) {
      const t = await titles.nth(i).getAttribute('title').catch(() => null);
      if (t && t.length > 3 && t.length < 50 && !t.includes('Details') && !t.includes('More')) return t.trim();
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

// ============ Main Fetch with Auto-Relogin ============
async function fetchWithSession(chatId, autoReloginAttempt = 0) {
  const entry = getUserEntry(chatId);
  const MAX_AUTO_RELOGIN = 2;
  
  let page;
  try {
    page = await gotoOverview(chatId);
    const basics = await extractBasics(page);

    // If basics extraction failed, try reload
    if (basics.remainingGB === null && basics.usedGB === null) {
      debugLog('Basics null, reloading page once...');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);
      const basicsRetry = await extractBasics(page);
      if (basicsRetry.remainingGB !== null) {
        Object.assign(basics, basicsRetry);
      } else {
        throw new Error('SESSION_EXPIRED');
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

    // Calculate totalGB from used + remaining
    const totalGB = (basics.usedGB != null && basics.remainingGB != null) 
      ? basics.usedGB + basics.remainingGB 
      : null;

    const out = {
      ...basics,
      ...details,
      totalGB,
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
    
    // Auto-relogin on session errors
    if (isSessionError(err) && autoReloginAttempt < MAX_AUTO_RELOGIN) {
      debugLog(`Session error detected. Auto-relogin attempt ${autoReloginAttempt + 1}/${MAX_AUTO_RELOGIN}`);
      try {
        await autoRelogin(chatId);
        // Retry fetch after successful relogin
        return fetchWithSession(chatId, autoReloginAttempt + 1);
      } catch (reloginErr) {
        debugLog(`Auto-relogin failed: ${reloginErr.message}`);
        throw new Error(`AUTO_RELOGIN_FAILED: ${reloginErr.message}`);
      }
    }
    
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
  autoRelogin,
  isSessionError,
};
