// weSession.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const logger = require('./logger');
const SEL = require('./selectors');
const { getCredentials } = require('./usageDb');

const SESS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR, { recursive: true });

const DEBUG = process.env.DEBUG_WE === '1';
const DEBUG_DUMP = process.env.DEBUG_DUMP === '1';

function dlog(...args) {
  if (DEBUG) console.log('[WE-DEBUG]', ...args);
}

function sessPath(chatId) {
  return path.join(SESS_DIR, `state-${chatId}.json`);
}

function readState(chatId) {
  try {
    const p = sessPath(chatId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(chatId, state) {
  try {
    fs.writeFileSync(sessPath(chatId), JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}

function deleteState(chatId) {
  try {
    const p = sessPath(chatId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function isProbablySignedOut(url) {
  return String(url || '').includes('/home/signin');
}

function normalizeNumber(s) {
  if (!s) return null;
  // remove commas, NBSP etc
  const x = String(s).replace(/[,\u00A0]/g, '').trim();
  const m = x.match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function extractLabeledNumber(txt, labelRe) {
  if (!txt) return null;
  const x = String(txt);
  const idx = x.search(labelRe);
  if (idx >= 0) {
    const right = x.slice(idx);
    const m = right.match(/(\d+(\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  return normalizeNumber(x);
}

function extractPlan(body) {
  // Try regex first as fallback
  const m = body.match(/Your Current Plan\s*([\s\S]{0,80})/i);
  if (m) {
    const chunk = m[1].trim().split('\n').map(s => s.trim()).filter(Boolean);
    if (chunk[0]) return chunk[0];
  }
  return null;
}

async function extractPlanSelector(page) {
  try {
    // Strategy 1: Look for "Your Current Plan" header and get the next element
    const header = page.locator('text=/Your Current Plan|نظامك الحالي/i').first();
    if (await header.isVisible().catch(() => false)) {
      // Often the plan name is in the parent or next sibling
      const parentTxt = await header.locator('xpath=..').innerText().catch(() => '');
      const lines = parentTxt.split('\n').map(l => l.trim()).filter(Boolean);
      const headerIdx = lines.findIndex(l => /Your Current Plan|نظامك الحالي/i.test(l));
      if (headerIdx !== -1 && lines[headerIdx + 1]) {
        return lines[headerIdx + 1];
      }
    }

    // Strategy 2: Look for spans with title (existing strategy)
    const titles = page.locator('span[title]');
    const count = await titles.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 10); i++) {
      const t = await titles.nth(i).getAttribute('title').catch(() => null);
      if (t && t.length > 3 && t.length < 100 && !/Details|More|مزيد|تفاصيل/i.test(t)) {
        return t.trim();
      }
    }
  } catch (err) {
    dlog('extractPlanSelector error:', err.message);
  }
  return null;
}

async function extractUsageSelectors(page) {
  try {
    // Look for the "Home Internet" block specifically
    const homeInternetHeader = page.locator('text=/Home Internet|إنترنت منزلي/i').first();
    let root = page;
    if (await homeInternetHeader.isVisible().catch(() => false)) {
      root = homeInternetHeader.locator('xpath=./ancestor::div[contains(@class, "ant-card") or contains(@class, "usage")] | ./following-sibling::div').first();
      if (!(await root.isVisible().catch(() => false))) root = page;
    }

    const remBox = root.locator('span', { hasText: /Remaining|المتبقي/i }).first().locator('xpath=..');
    const usedBox = root.locator('span', { hasText: /Used|المستخدم/i }).first().locator('xpath=..');
    
    const remTxt = await remBox.innerText().catch(() => '');
    const usedTxt = await usedBox.innerText().catch(() => '');

    const res = {
      remainingGB: extractLabeledNumber(remTxt, /(Remaining|المتبقي)/i),
      usedGB: extractLabeledNumber(usedTxt, /(Used|المستخدم)/i),
    };

    // If still null, try without the parent locator
    if (res.remainingGB === null) {
      const directRem = await root.locator('span', { hasText: /Remaining|المتبقي/i }).first().innerText().catch(() => '');
      res.remainingGB = extractLabeledNumber(directRem, /(Remaining|المتبقي)/i);
    }
    if (res.usedGB === null) {
      const directUsed = await root.locator('span', { hasText: /Used|المستخدم/i }).first().innerText().catch(() => '');
      res.usedGB = extractLabeledNumber(directUsed, /(Used|المستخدم)/i);
    }

    return res;
  } catch (err) {
    dlog('extractUsageSelectors error:', err.message);
  }
  return { remainingGB: null, usedGB: null };
}

async function extractBalanceSelector(page) {
  try {
    const balBlock = page.locator('text=/Current Balance|الرصيد الحالي/i').first().locator('xpath=..');
    const txt = await balBlock.innerText().catch(() => '');
    return normalizeNumber(txt);
  } catch (err) {
    dlog('extractBalanceSelector error:', err.message);
  }
  return null;
}

function extractUsage(body) {
  // ضيّق البحث حوالين "Home Internet" لو موجود
  let scope = body;
  const idx = body.indexOf('Home Internet');
  if (idx !== -1) scope = body.slice(idx, idx + 800);

  // دعم عربي وإنجليزي
  const remRe = /(\d+(\.\d+)?)\s*(Remaining|المتبقي)/i;
  const usedRe = /(\d+(\.\d+)?)\s*(Used|المستخدم)/i;

  let rem = scope.match(remRe);
  let used = scope.match(usedRe);

  // fallback: في بعض الصفحات الرقم ييجي بعد الكلمة
  if (!rem) {
    const rem2 = scope.match(/(Remaining|المتبقي)\s*[:\-]?\s*(\d+(\.\d+)?)/i);
    if (rem2) rem = [rem2[0], rem2[2]];
  }
  if (!used) {
    const used2 = scope.match(/(Used|المستخدم)\s*[:\-]?\s*(\d+(\.\d+)?)/i);
    if (used2) used = [used2[0], used2[2]];
  }

  return {
    remainingGB: rem ? Number(rem[1]) : null,
    usedGB: used ? Number(used[1]) : null,
  };
}

function extractBalance(body) {
  // Current Balance \n 50 \n EGP
  const m = body.match(/Current Balance\s*([\s\S]{0,80})/i);
  if (!m) return null;
  const chunk = m[1].split('\n').map(s => s.trim()).filter(Boolean).slice(0, 5).join(' ');
  // غالبًا رقم قبل EGP
  const n = chunk.match(/(\d+(\.\d+)?)/);
  return n ? Number(n[1]) : null;
}

function extractTotalFromPlan(plan) {
  // (400GB)
  const m = String(plan || '').match(/\((\d+)\s*GB\)/i);
  return m ? Number(m[1]) : null;
}

function extractRenewalInfo(body) {
  // نحاول نلقط:
  // Renewal Date ... 11-03-2026
  // أو "Renewal Date" قد تكون بتنسيق مختلف
  const date =
    (body.match(/Renewal\s*Date\s*[:\-]?\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i) || [])[1] ||
    (body.match(/تاريخ\s*التجديد\s*[:\-]?\s*([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i) || [])[1] ||
    null;

  // سعر الباقة: غالبًا رقم كبير قريب من كلمة Renew أو EGP
  // (مش مثالي بس عملي)
  let price = null;
  const priceM =
    body.match(/(Plan Price|Renew|Package Price|سعر الباقة)[\s\S]{0,60}?(\d+(\.\d+)?)/i) ||
    body.match(/\b(\d+(\.\d+)?)\s*EGP\b/i);
  if (priceM) price = normalizeNumber(priceM[2] || priceM[1]);

  // زر Renew enabled؟
  const hasRenewBtn = /Renew/i.test(body);

  // Router
  const routerName = /PREMIUM\s*Router/i.test(body) ? 'PREMIUM Router' : (/(Router)/i.test(body) ? 'Router' : null);

  // Router monthly
  let routerMonthly = null;
  const rm = body.match(/(Router|PREMIUM\s*Router)[\s\S]{0,60}?(\d+(\.\d+)?)/i);
  if (rm) routerMonthly = normalizeNumber(rm[2]);

  // Router renewal date
  const routerDate =
    (body.match(/Router[\s\S]{0,120}?([0-9]{2}[-/][0-9]{2}[-/][0-9]{4})/i) || [])[1] ||
    null;

  return {
    renewalDate: date,
    renewPriceEGP: price,
    renewBtnEnabled: hasRenewBtn ? true : null,
    routerName,
    routerMonthlyEGP: routerMonthly,
    routerRenewalDate: routerDate,
  };
}

async function dumpOnce(page, chatId, tag) {
  if (!DEBUG_DUMP) return;
  try {
    const ts = Date.now();
    const base = path.join(SESS_DIR, `dump-${chatId}-${tag}-${ts}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    fs.writeFileSync(`${base}.html`, html, 'utf8');
    const txt = await page.locator('body').innerText().catch(() => '');
    fs.writeFileSync(`${base}.txt`, txt, 'utf8');
    dlog(`Saved dump: ${base}.(png|html|txt)`);
  } catch {}
}

async function launchBrowser() {
  const headlessEnv = (process.env.HEADLESS ?? process.env.WE_HEADLESS) || '1';
  const headless = headlessEnv === '0' ? false : true;
  const slowMo = process.env.PW_SLOWMO ? Number(process.env.PW_SLOWMO) : (headless ? 0 : 200);
  return chromium.launch({
    headless,
    slowMo,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
}

async function newContext(browser, storageState) {
  return browser.newContext(storageState ? { storageState } : {});
}

async function gotoAccountOverview(page) {
  await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // استنى SPA تحمّل (على Render بتتأخر)
  await page.waitForTimeout(1200);
  await page.waitForSelector(SEL.markerUsageOverviewText, { timeout: 60000 }).catch(() => {});
  await page.waitForSelector(SEL.balanceText, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(800);

  return page.url();
}

async function gotoUsagePage(page) {
  await page.goto(SEL.usageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(1200);
  await page.waitForSelector(SEL.markerHomeInternetText, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(500);
  return page.url();
}

async function selectInternetServiceTypeKeyboard(page) {
  await page.locator(SEL.selectServiceTypeTrigger).click({ timeout: 30000 });
  await page.waitForSelector(SEL.selectDropdownVisible, { timeout: 10000 }).catch(() => {});
  const items = page.locator(`${SEL.selectDropdownVisible} ${SEL.selectServiceTypeOption}`);
  const count = await items.count().catch(() => 0);
  let idx = -1;
  const re = /(Home\s*Internet|Internet|إنترنت|الإنترنت|Fixed\s*Broadband|ADSL)/i;
  for (let i = 0; i < count; i++) {
    const t = await items.nth(i).innerText().catch(() => '');
    if (re.test(t)) { idx = i; break; }
  }
  if (idx === -1 && count >= 2) idx = 1;
  if (idx === -1 && count >= 1) idx = 0;
  if (idx === -1) return false;
  const target = items.nth(idx);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ force: true, timeout: 15000 });
  await page.waitForTimeout(300);
  const chosen = await page.locator(SEL.selectServiceTypeTrigger).innerText().catch(() => '');
  if (!re.test(chosen)) {
    if (count >= 2) {
      await page.locator(SEL.selectServiceTypeTrigger).click({ timeout: 30000 }).catch(() => {});
      const alt = items.nth(1);
      await alt.click({ force: true, timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
  }
  return true;
}

async function loginFlow(page, serviceNumber, password, chatId) {
  try {
    await page.goto(SEL.signinUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(800);

    await page.click(SEL.inputService, { timeout: 60000 });
    await page.fill(SEL.inputService, String(serviceNumber));
    await page.waitForTimeout(300);

    dlog('Selecting service type (keyboard)...');
    await selectInternetServiceTypeKeyboard(page);

    await page.click(SEL.inputPassword, { timeout: 60000 });
    await page.fill(SEL.inputPassword, String(password));
    await page.waitForTimeout(600);

    dlog('Clicking login button...');
    // Force enable the login button if it's disabled
    await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.removeAttribute('disabled');
        btn.classList.remove('ant-btn-loading');
      }
    }, SEL.loginButton);
    await page.waitForTimeout(200);

    await page.click(SEL.loginButton, { timeout: 60000, force: true });
    // Fallback: press Enter in password field if click didn't work
    await page.waitForTimeout(500);
    const currentUrl = page.url();
    if (currentUrl.includes('signin')) {
      await page.focus(SEL.inputPassword).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
    }

    // استنى التحويل للـ accountoverview أو رسالة خطأ
    try {
      await Promise.race([
        page.waitForURL(/accountoverview/i, { timeout: 90000 }),
        page.waitForSelector('text=/Incorrect|invalid|wrong|failed|فشل|خطأ/i', { timeout: 90000 }).then(async (el) => {
          const txt = await el.innerText();
          throw new Error(`LOGIN_ERROR: ${txt}`);
        }),
      ]);
    } catch (err) {
      if (err.message.includes('LOGIN_ERROR')) throw err;
      // If it's a timeout but we see an error on page, throw it
      const body = await page.locator('body').innerText().catch(() => '');
      if (/Incorrect|invalid|wrong|failed|فشل|خطأ/i.test(body)) {
        const match = body.match(/(Incorrect service number or password|The password you entered is incorrect|بيانات الدخول غير صحيحة)/i);
        throw new Error(`LOGIN_ERROR: ${match ? match[0] : 'Invalid credentials'}`);
      }
      throw err;
    }

    await page.waitForTimeout(1000);

    await dumpOnce(page, chatId, 'AFTER_LOGIN');
  } catch (err) {
    dlog(`Login flow failed: ${err.message}`);
    await dumpOnce(page, chatId, 'LOGIN_FAILED');
    throw err;
  }
}

async function openMoreDetails(page) {
  // جرّب نصوص متعددة عربي/إنجليزي
  const texts = SEL.moreDetailsTexts || ['More Details', 'Details', 'مزيد من التفاصيل', 'تفاصيل'];

  for (const t of texts) {
    const selectors = [
      `span:has-text("${t}")`,
      `a:has-text("${t}")`,
      `button:has-text("${t}")`,
      `div:has-text("${t}")`
    ];

    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          dlog(`Found more details button with selector: ${sel}`);
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ force: true, timeout: 8000 });
          await page.waitForTimeout(2000);
          return true;
        }
      } catch (err) {
        // ignore and try next
      }
    }
  }

  // Fallback: evaluate click if not found via playwright locators
  dlog('More details button not found via locators, trying evaluation fallback...');
  const clicked = await page.evaluate((texts) => {
    const elements = Array.from(document.querySelectorAll('span, a, button, div'));
    for (const t of texts) {
      const el = elements.find(e => (e.textContent || '').trim().toLowerCase() === t.toLowerCase());
      if (el) {
        el.scrollIntoView();
        el.click();
        return true;
      }
    }
    return false;
  }, texts).catch(() => false);

  if (clicked) {
    await page.waitForTimeout(2000);
    return true;
  }

  return false;
}

function calcRemainingDays(renewalDateStr) {
  if (!renewalDateStr) return null;
  // dd-mm-yyyy
  const m = renewalDateStr.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
  const target = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
  const now = new Date();
  const utcNow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const diffMs = target - utcNow;
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

function buildResult({ plan, remainingGB, usedGB, balanceEGP, renewalInfo }) {
  const totalGB = extractTotalFromPlan(plan);
  const renewalDate = renewalInfo.renewalDate || null;
  const remainingDays = calcRemainingDays(renewalDate);

  const renewPriceEGP = renewalInfo.renewPriceEGP ?? null;
  const routerMonthlyEGP = renewalInfo.routerMonthlyEGP ?? null;

  const totalRenewEGP =
    (renewPriceEGP != null && routerMonthlyEGP != null)
      ? (renewPriceEGP + routerMonthlyEGP)
      : (renewPriceEGP ?? null);

  const canAfford =
    (balanceEGP != null && totalRenewEGP != null) ? (balanceEGP >= totalRenewEGP) : null;

  // تقدير المستخدم من الإجمالي - المتبقي لو المستخدم غير متاح
  let usedResolved = usedGB;
  if ((usedResolved == null || Number.isNaN(usedResolved)) && totalGB != null && remainingGB != null) {
    const diff = totalGB - remainingGB;
    usedResolved = diff >= 0 ? diff : null;
  }
  let remainingResolved = remainingGB;
  const sumOk = (totalGB != null && remainingResolved != null && usedResolved != null) ?
    Math.abs((remainingResolved + usedResolved) - totalGB) <= 1 : false;
  if (sumOk && usedResolved > remainingResolved) {
    const tmp = usedResolved;
    usedResolved = remainingResolved;
    remainingResolved = tmp;
  }

  return {
    plan: plan || null,
    remainingGB: remainingResolved,
    usedGB: usedResolved,
    balanceEGP,
    renewalDate,
    remainingDays,
    renewPriceEGP,
    renewBtnEnabled: renewalInfo.renewBtnEnabled ?? null,
    routerName: renewalInfo.routerName ?? null,
    routerMonthlyEGP,
    routerRenewalDate: renewalInfo.routerRenewalDate ?? null,
    totalGB,
    totalRenewEGP,
    canAfford,
    capturedAt: new Date().toISOString(),
  };
}

function isSessionError(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('BROWSER_CLOSED') ||
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('Execution context was destroyed') ||
    msg.includes('net::ERR') ||
    msg.includes('Timeout') ||
    msg.includes('Sign in') ||
    msg.includes('signin') ||
    msg.includes('AUTO_RELOGIN_FAILED')
  );
}

// ================== Public API (used by bot.js) ==================

async function loginAndSave(chatId, serviceNumber, password) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let browser;
    try {
      dlog(`Starting login for ${chatId} (Attempt ${attempt}/${maxAttempts})`);
      browser = await launchBrowser();
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      page.setDefaultTimeout(60000);

      await loginFlow(page, serviceNumber, password, chatId);

      // save storageState
      const state = await ctx.storageState();
      writeState(chatId, state);
      dlog(`Session for ${chatId} persisted locally (storageState).`);

      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
      return true;
    } catch (err) {
      try { await browser?.close?.(); } catch {}
      const msg = String(err && err.message || '');
      // لا تعيد المحاولة مع بيانات غير صحيحة
      if (/LOGIN_ERROR:/i.test(msg)) {
        logger.error(`Login failed for ${chatId}`, err);
        throw err;
      }
      // أعِد المحاولة فقط للأخطاء العابرة
      if (attempt < maxAttempts) {
        dlog(`Transient login error, will retry: ${msg}`);
        await new Promise(res => setTimeout(res, 1500));
        continue;
      }
      logger.error(`Login failed for ${chatId}`, err);
      throw err;
    }
  }
}

async function fetchWithSession(chatId) {
  let browser;
  const diagnostics = {
    lastFetchAt: null,
    lastError: null,
    currentUrl: null,
    methodPicked: null,
    moreDetailsVisible: null,
    hasState: false,
  };

  try {
    const state = readState(chatId);
    diagnostics.hasState = !!state;

    browser = await launchBrowser();
    const ctx = await newContext(browser, state);
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);

    // 1) accountoverview
    const url1 = await gotoAccountOverview(page);
    diagnostics.currentUrl = url1;

    // لو اتعمل redirect للـ signin يبقى session بايظة -> relogin
    if (isProbablySignedOut(url1)) {
      const creds = await getCredentials(chatId);
      if (!creds) throw new Error('NO_CREDENTIALS');
      await loginFlow(page, creds.serviceNumber, creds.password, chatId);
    }

    await dumpOnce(page, chatId, 'ACCOUNTOVERVIEW');

    let body1 = await page.locator('body').innerText().catch(() => '');
    let plan = await extractPlanSelector(page);
    if (!plan) plan = extractPlan(body1);

    let bal = await extractBalanceSelector(page);
    if (bal == null) bal = extractBalance(body1);

    // 2) overview usage page (sometimes remaining/used are more stable here)
    await gotoUsagePage(page);
    await dumpOnce(page, chatId, 'OVERVIEW');

    let body2 = await page.locator('body').innerText().catch(() => '');
    let usage = await extractUsageSelectors(page);
    if (usage.remainingGB == null) usage = extractUsage(body2);

    // Check if basics are still missing
    const basicsIncomplete = !plan || usage.remainingGB == null || bal == null;
    if (basicsIncomplete) {
      dlog('Basics incomplete (Plan/Usage/Balance), trying one more wait/refresh...');
      await page.waitForTimeout(3000);
      body2 = await page.locator('body').innerText().catch(() => '');
      if (!plan) plan = await extractPlanSelector(page) || extractPlan(body2);
      if (usage.remainingGB == null) usage = await extractUsageSelectors(page) || extractUsage(body2);
      if (bal == null) bal = await extractBalanceSelector(page) || extractBalance(body2);
    }

    // 3) More details (to get renewal/price/router)
    await dumpOnce(page, chatId, 'BEFORE_MORE');
    const opened = await openMoreDetails(page);
    diagnostics.moreDetailsVisible = opened;
    await dumpOnce(page, chatId, 'AFTER_MORE');

    const body3 = await page.locator('body').innerText().catch(() => '');
    const renewalInfo = extractRenewalInfo(body3);

    // update state back
    const newState = await ctx.storageState().catch(() => null);
    if (newState) writeState(chatId, newState);

    const data = buildResult({
      plan,
      remainingGB: usage.remainingGB,
      usedGB: usage.usedGB,
      balanceEGP: bal,
      renewalInfo,
    });

    data._pickedMethod = opened ? 'ACCOUNTOVERVIEW + OVERVIEW' : 'ACCOUNTOVERVIEW + OVERVIEW(no-more)';

    diagnostics.methodPicked = data._pickedMethod;
    diagnostics.lastFetchAt = data.capturedAt;

    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    return data;
  } catch (err) {
    diagnostics.lastError = String(err?.message || err || '');
    logger.error(`fetchWithSession failed for ${chatId}`, err);
    throw err;
  } finally {
    try { await browser?.close?.(); } catch {}
  }
}

async function renewWithSession() {
  throw new Error('NOT_IMPLEMENTED');
}

async function deleteSession(chatId) {
  // ما تمسحش credentials هنا (ده في bot.js)
  deleteState(chatId);
  dlog(`Session for ${chatId} deleted locally (storageState).`);
}

function getSessionDiagnostics(chatId) {
  return {
    hasState: !!readState(chatId),
    statePath: sessPath(chatId),
  };
}

module.exports = {
  loginAndSave,
  fetchWithSession,
  renewWithSession,
  deleteSession,
  isSessionError,
  getSessionDiagnostics,
};
