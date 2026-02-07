const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const SEL = require('./selectors');

const DEBUG = String(process.env.DEBUG_WE || '').trim() === '1';
const userPool = new Map(); // chatId -> { context, page, diagnostics }
let sharedBrowser = null;

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
  if (entry.page) await entry.page.close().catch(() => {});
  if (entry.context) await entry.context.close().catch(() => {});
  entry.page = null;
  entry.context = null;
}

async function ensureContext(chatId, forceNew = false) {
  const sp = statePath(chatId);
  if (!fs.existsSync(sp)) throw new Error('NO_SESSION');
  const entry = getUserEntry(chatId);
  if (forceNew) await closeUser(chatId);
  if (entry.context) return entry.context;
  const browser = await getBrowser();
  entry.context = await browser.newContext({ storageState: sp });
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

  const currentUrl = page.url();
  entry.diagnostics.currentUrl = currentUrl;
  if (currentUrl.includes('/signin') || currentUrl.includes('#/home/signin')) {
    if (retryOnce) {
      await ensureContext(chatId, true);
      return gotoOverview(chatId, { retryOnce: false });
    }
    throw new Error('SESSION_EXPIRED');
  }

  return page;
}

async function loginAndSave(chatId, serviceNumber, password) {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  try {
    await page.goto(SEL.signinUrl, { waitUntil: 'domcontentloaded' });
    await page.click(SEL.inputService);
    await page.keyboard.type(String(serviceNumber), { delay: 30 });
    await page.locator(SEL.selectServiceTypeTrigger).first().click();
    await page.locator(SEL.selectServiceTypeInternet, { hasText: 'Internet' }).click();
    await page.click(SEL.inputPassword);
    await page.keyboard.type(String(password), { delay: 30 });
    const loginBtn = page.locator(SEL.loginButton);
    await loginBtn.waitFor({ state: 'visible' });
    await loginBtn.click({ force: true });
    await page.waitForTimeout(4000);
    await context.storageState({ path: statePath(chatId) });
    await closeUser(chatId);
    return true;
  } finally {
    await context.close().catch(() => {});
  }
}

async function openMoreDetailsResilient(page, chatId) {
  const more = page.locator(SEL.moreDetailsSpan, { hasText: SEL.moreDetailsHasText }).first();
  for (let i = 0; i < 6; i += 1) {
    const visible = await more.isVisible().catch(() => false);
    if (visible) {
      await more.scrollIntoViewIfNeeded().catch(() => {});
      await more.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1600);
      const marker = await page.locator('text=/Renewal|Unsubscribe|Router|Renew/i').first().isVisible().catch(() => false);
      if (marker) return { ok: true };
    }
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(2000);
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/Renewal\s*Date:/i.test(bodyText)) return { ok: true, fallback: true };

  if (DEBUG) await page.screenshot({ path: debugShotPath(chatId, 'MORE_FAIL') }).catch(() => {});
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

function parseDetailsFromBody(bodyText, balanceEGP) {
  const parsed = parseRenewalLine(bodyText.match(/Renewal\s*Date:.*$/im)?.[0] || '');
  const renewBtnEnabled = /\bRenew\b/i.test(bodyText) ? null : null;
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
      details = { ...details, ...parseDetailsFromBody(bodyText, basics.balanceEGP) };
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
  await closeUser(chatId).catch(() => {});
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
  return true;
}

module.exports = {
  loginAndSave,
  fetchWithSession,
  renewWithSession,
  deleteSession,
  getSessionDiagnostics,
};
