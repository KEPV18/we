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

function debugDumpBasePath(chatId, name) {
  ensureDir(path.join(__dirname, 'sessions'));
  const ts = Date.now();
  return path.join(__dirname, 'sessions', `dump-${chatId}-${name}-${ts}`);
}

async function debugDumpPage(page, chatId, name) {
  if (!DEBUG) return;
  const base = debugDumpBasePath(chatId, name);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => '');
  fs.writeFileSync(`${base}.html`, html);
  const text = await page.locator('body').innerText().catch(() => '');
  fs.writeFileSync(`${base}.txt`, text);
  debugLog(`Saved dump: ${base}.(png|html|txt)`);
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
  return msg.includes("Executable doesn't exist at") || msg.includes('download new browsers');
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
  if (entry.page) await entry.page.close().catch(() => {});
  if (entry.context) await entry.context.close().catch(() => {});
  entry.page = null;
  entry.context = null;
}

async function ensureContext(chatId, forceNew = false) {
  const sp = statePath(chatId);
  const entry = getUserEntry(chatId);
  if (forceNew) await closeUser(chatId);
  if (entry.context) return entry.context;

  const dbSession = await getSession(chatId);
  if (dbSession) {
    debugLog(`Restoring session for ${chatId} from Database...`);
    ensureDir(path.dirname(sp));
    fs.writeFileSync(sp, JSON.stringify(dbSession));
  } else if (!fs.existsSync(sp)) {
    throw new Error('NO_SESSION');
  }

  const browser = await getBrowser();
  entry.context = await browser.newContext({ storageState: sp, viewport: { width: 1280, height: 720 } });
  return entry.context;
}

async function ensurePage(chatId, forceNew = false) {
  const entry = getUserEntry(chatId);
  const context = await ensureContext(chatId, forceNew);
  if (forceNew && entry.page) {
    await entry.page.close().catch(() => {});
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
    page.locator(SEL.balanceText).first(),
    page.locator(SEL.markerUsageOverviewText).first(),
    page.locator(SEL.markerHomeInternetText).first(),
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

async function gotoAccountOverview(chatId) {
  const entry = getUserEntry(chatId);
  let page = await ensurePage(chatId);

  try {
    await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' });
    await waitOverviewHealth(page).catch(() => {});
  } catch (err) {
    if (isClosedContextError(err)) {
      page = await ensurePage(chatId, true);
      await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' });
      await waitOverviewHealth(page).catch(() => {});
    } else {
      throw err;
    }
  }

  entry.diagnostics.currentUrl = page.url();
  return page;
}

async function gotoOverviewRoute(page) {
  // sometimes More Details sends you to #/overview
  try {
    await page.goto('https://my.te.eg/echannel/#/overview', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
  } catch {}
}

// ======= LOGIN helpers =======

async function selectInternetServiceType(page) {
  // Try click first
  debugLog('Selecting service type...');
  const trigger = page.locator(SEL.selectServiceTypeTrigger).first();
  await trigger.waitFor({ state: 'visible' });
  await trigger.click({ force: true });

  // Best: click option inside visible dropdown
  const option = page
    .locator('.ant-select-dropdown:visible')
    .locator(SEL.selectServiceTypeInternet)
    .filter({ hasText: /Internet/i })
    .first();

  try {
    await option.waitFor({ state: 'visible', timeout: 8000 });
    await option.click({ force: true, timeout: 8000 });
    return true;
  } catch (e) {
    // fallback to keyboard
  }

  // Keyboard fallback
  debugLog('Selecting service type (keyboard)...');
  await trigger.click({ force: true }).catch(() => {});
  await page.keyboard.type('Internet', { delay: 40 }).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

async function loginFlow(page, chatId, serviceNumber, password) {
  await page.goto(SEL.signinUrl, { waitUntil: 'domcontentloaded', timeout: LONG_TIMEOUT });

  await page.waitForSelector(SEL.inputService, { state: 'visible' });

  await page.click(SEL.inputService);
  await page.fill(SEL.inputService, String(serviceNumber));

  await selectInternetServiceType(page);

  await page.waitForSelector(SEL.inputPassword, { state: 'visible' });
  // Use fill (no click-wait nav weirdness)
  await page.fill(SEL.inputPassword, String(password));

  // Let UI validate
  await page.waitForTimeout(800);

  const loginBtn = page.locator(SEL.loginButton);
  await loginBtn.waitFor({ state: 'visible' });

  debugLog('Clicking login button...');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    loginBtn.click({ force: true })
  ]);

  await page.waitForTimeout(2000);
  const url = page.url();
  debugLog(`Final URL after login: ${url}`);

  if (url.includes('/signin') || url.includes('login')) {
    throw new Error('LOGIN_FAILED_URL_STILL_SIGNIN');
  }
  return true;
}

// ============ Login with Auto-Retry ============
async function loginAndSave(chatId, serviceNumber, password, retryCount = 0) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  page.setDefaultTimeout(LONG_TIMEOUT);
  page.setDefaultNavigationTimeout(LONG_TIMEOUT);

  try {
    debugLog(`Starting login for ${chatId} (Attempt ${retryCount + 1}/${MAX_LOGIN_RETRIES})`);

    await loginFlow(page, chatId, serviceNumber, password);

    const sp = statePath(chatId);
    ensureDir(path.dirname(sp));
    await context.storageState({ path: sp });

    const stateData = JSON.parse(fs.readFileSync(sp, 'utf8'));
    await saveSession(chatId, stateData);
    debugLog(`Session for ${chatId} persisted to Database.`);

    await closeUser(chatId);
    return true;
  } catch (err) {
    const shotPath = debugShotPath(chatId, 'LOGIN_FAIL');
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => null);
    logger.error(`Login failed for ${chatId}. Screenshot saved to: ${shotPath}`, err);

    if (retryCount < MAX_LOGIN_RETRIES - 1) {
      debugLog(`Retrying login... (${retryCount + 2}/${MAX_LOGIN_RETRIES})`);
      await context.close().catch(() => {});
      await sleep(2000);
      return loginAndSave(chatId, serviceNumber, password, retryCount + 1);
    }

    throw err;
  } finally {
    await context.close().catch(() => {});
  }
}

// ============ Auto Re-login Helper ============
async function autoRelogin(chatId) {
  debugLog(`Attempting auto-relogin for ${chatId}...`);
  const creds = await getCredentials(chatId);
  if (!creds) throw new Error('NO_CREDENTIALS_SAVED');

  await closeUser(chatId);
  await loginAndSave(chatId, creds.serviceNumber, creds.password);
  debugLog(`Auto-relogin successful for ${chatId}`);
  return true;
}

// ======= Extract basics from page (accountoverview OR overview) =======
async function extractBasicsFromAccountOverview(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  const planMatch = body.match(/Your Current Plan\s*([\s\S]{0,200})/i);
  let plan = '';
  if (planMatch) {
    const lines = planMatch[0].split('\n').map(s => s.trim()).filter(Boolean);
    // pick next line after "Your Current Plan" that looks like plan
    const idx = lines.findIndex(l => /Your Current Plan/i.test(l));
    if (idx >= 0 && lines[idx + 1]) plan = lines[idx + 1];
  }

  // remaining/used appear like "361.56 Remaining" in your logs
  const rem = body.match(/([\d.,]+)\s*Remaining/i);
  const used = body.match(/([\d.,]+)\s*Used/i);

  // balance appears near "Current Balance"
  const balSeg = body.match(/Current Balance[\s\S]{0,80}/i);
  const bal = balSeg ? balSeg[0].match(/([\d.,]+)/) : null;

  return {
    plan: plan || '',
    remainingGB: rem ? numFromText(rem[1]) : null,
    usedGB: used ? numFromText(used[1]) : null,
    balanceEGP: bal ? numFromText(bal[1]) : null,
  };
}

async function clickMoreDetails(page) {
  // try multiple ways
  const more = page.locator('text=/More Details/i').first();
  const visible = await more.isVisible().catch(() => false);
  if (visible) {
    await more.scrollIntoViewIfNeeded().catch(() => {});
    await more.click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

async function waitDetailsLoaded(page) {
  // wait up to 20s for renewal/price/router keywords to appear
  for (let i = 0; i < 20; i++) {
    const t = await page.locator('body').innerText().catch(() => '');
    if (/Renewal\s*Date/i.test(t) || /\bEGP\b/i.test(t) || /PREMIUM\s*Router/i.test(t)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
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
    page = await gotoAccountOverview(chatId);

    // Get basics from accountoverview
    let basics = await extractBasicsFromAccountOverview(page);

    // if incomplete, reload accountoverview once
    if (basics.remainingGB == null || basics.usedGB == null || basics.balanceEGP == null) {
      debugLog('Basics incomplete, reloading accountoverview once...');
      await debugDumpPage(page, chatId, 'BASICS_INCOMPLETE_BEFORE_RELOAD');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1500);
      basics = await extractBasicsFromAccountOverview(page);
    }

    // try click More Details and then go overview route (common behavior)
    await debugDumpPage(page, chatId, 'BEFORE_MORE');
    const mdOk = await clickMoreDetails(page);
    entry.diagnostics.moreDetailsVisible = mdOk;

    // Some accounts redirect to #/overview after more details
    const u = page.url();
    if (u.includes('#/overview') === false) {
      // ensure overview route anyway (safer)
      await gotoOverviewRoute(page);
    }

    await debugDumpPage(page, chatId, 'AFTER_MORE');

    // Wait for details to appear
    const detailsReady = await waitDetailsLoaded(page);
    debugLog('detailsReady:', detailsReady);

    const bodyText = await page.locator('body').innerText().catch(() => '');

    // Parse details
    const details = await parseDetailsFromBody(page, bodyText, basics.balanceEGP);

    // Also try re-extract basics from current route if still missing (overview sometimes has cleaner numbers)
    if (basics.remainingGB == null || basics.usedGB == null || basics.balanceEGP == null || !basics.plan) {
      const b2 = await extractBasicsFromAccountOverview(page); // same parser works from body
      basics = {
        plan: basics.plan || b2.plan,
        remainingGB: basics.remainingGB ?? b2.remainingGB,
        usedGB: basics.usedGB ?? b2.usedGB,
        balanceEGP: basics.balanceEGP ?? b2.balanceEGP,
      };
    }

    const totalRenewEGP = ((details.renewPriceEGP ?? 0) + (details.routerMonthlyEGP ?? 0)) || null;
    const canAfford = totalRenewEGP != null && basics.balanceEGP != null ? basics.balanceEGP >= totalRenewEGP : null;

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
      _pickedMethod: 'ACCOUNTOVERVIEW + OVERVIEW',
    };

    entry.diagnostics.lastError = null;
    entry.diagnostics.lastFetchAt = out.capturedAt;
    entry.diagnostics.methodPicked = out._pickedMethod;
    entry.diagnostics.currentUrl = page.url();

    return out;
  } catch (err) {
    entry.diagnostics.lastError = String(err?.message || err || '');

    if (isSessionError(err) && autoReloginAttempt < MAX_AUTO_RELOGIN) {
      debugLog(`Session error detected. Auto-relogin attempt ${autoReloginAttempt + 1}/${MAX_AUTO_RELOGIN}`);
      try {
        await autoRelogin(chatId);
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
    const page = await gotoAccountOverview(chatId);
    await clickMoreDetails(page);
    await gotoOverviewRoute(page);

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
  await closeUser(chatId).catch(() => {});
  if (fs.existsSync(sp)) fs.unlinkSync(sp);

  await deleteSessionRecord(chatId).catch(() => {});
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
