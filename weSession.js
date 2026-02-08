const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const SEL = require('./selectors');

const DEBUG = String(process.env.DEBUG_WE || '').trim() === '1';

function debugLog(...args) { if (DEBUG) console.log('[WE-DEBUG]', ...args); }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function isClosedContextError(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('page.goto: Target closed') ||
    msg.includes('Target closed') ||
    msg.includes('has been closed')
  );
}

function isMissingBrowserError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('Executable doesn\'t exist at') || msg.includes('Please run the following command to download new browsers');
}

function statePath(chatId) {
  return path.join(__dirname, 'sessions', `state-${chatId}.json`);
}
function debugShotPath(chatId, name) {
  ensureDir(path.join(__dirname, 'sessions'));
  return path.join(__dirname, 'sessions', `debug-${chatId}-${name}.png`);
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
  const clean = Array.from(new Set((egpValues || [])
    .filter(v => typeof v === 'number' && v > 0)));

  let candidates = clean;
  if (typeof balanceEGP === 'number') candidates = candidates.filter(v => v !== balanceEGP);
  if (typeof routerMonthlyEGP === 'number' && routerMonthlyEGP > 0) candidates = candidates.filter(v => v !== routerMonthlyEGP);

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return Math.max(...candidates);

  if (typeof balanceEGP === 'number') {
    const less = clean.filter(v => v < balanceEGP);
    if (less.length) return Math.max(...less);
  }
  return null;
}

async function loginAndSave(chatId, serviceNumber, password) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (isMissingBrowserError(err)) throw new Error('BROWSER_NOT_INSTALLED');
    throw err;
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  await page.goto(SEL.signinUrl, { waitUntil: 'domcontentloaded' });

  await page.click(SEL.inputService);
  await page.keyboard.type(String(serviceNumber), { delay: 50 });

  await page.locator(SEL.selectServiceTypeTrigger).first().click();
  await page.locator(SEL.selectServiceTypeInternet, { hasText: 'Internet' }).click();

  await page.click(SEL.inputPassword);
  await page.keyboard.type(String(password), { delay: 50 });

  await page.waitForTimeout(900);

  const loginBtn = page.locator(SEL.loginButton);
  await loginBtn.waitFor({ state: 'visible' });

  const disabledAttr = await loginBtn.getAttribute('disabled');
  if (disabledAttr !== null) {
    await page.evaluate(() => {
      const btn = document.getElementById('login-withecare');
      if (btn) btn.removeAttribute('disabled');
    });
  }

  await loginBtn.click({ force: true });
  await page.waitForTimeout(7000);

  await context.storageState({ path: statePath(chatId) });
  await browser.close();
  return true;
}

async function openAccountOverviewWithSession(chatId, headless = true) {
  const sp = statePath(chatId);
  if (!fs.existsSync(sp)) throw new Error('NO_SESSION');

  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (err) {
    if (isMissingBrowserError(err)) throw new Error('BROWSER_NOT_INSTALLED');
    throw err;
  }
  const context = await browser.newContext({ storageState: sp });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' });

  const currentUrl = page.url();
  if (currentUrl.includes('/home/signin') || currentUrl.includes('#/home/signin')) {
    await browser.close();
    throw new Error('SESSION_EXPIRED');
  }

  return { browser, context, page };
}

async function waitForOverviewReady(page, chatId) {
  // علامات تحميل الصفحة (React hydration)
  const markers = [
    page.locator(SEL.markerUsageOverviewText).first(),
    page.locator(SEL.markerHomeInternetText).first(),
    page.locator(SEL.remainingSpan, { hasText: SEL.remainingHasText }).first(),
  ];

  for (let i = 0; i < 3; i++) {
    for (const m of markers) {
      const ok = await m.isVisible().catch(() => false);
      if (ok) return true;
    }
    await page.waitForTimeout(1200);
  }

  // جرّب scroll عشان أحياناً الـ DOM بيتبني مع النزول
  for (let k = 0; k < 6; k++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(600);
    for (const m of markers) {
      const ok = await m.isVisible().catch(() => false);
      if (ok) return true;
    }
  }

  if (DEBUG) await page.screenshot({ path: debugShotPath(chatId, 'NOT_READY') }).catch(() => {});
  return false;
}

async function openMoreDetails(page, chatId) {
  const more = page.locator(SEL.moreDetailsSpan, { hasText: SEL.moreDetailsHasText }).first();
  const visible = await more.isVisible().catch(() => false);
  if (!visible) return { ok: false, reason: 'MORE_NOT_VISIBLE' };

  await more.scrollIntoViewIfNeeded().catch(() => {});
  await more.click({ force: true });

  await page.waitForTimeout(2500);

  const marker = page.locator('text=/Renewal|Unsubscribe|Router|Renew/i').first();
  await marker.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});

  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(350);
  }

  if (DEBUG) await page.screenshot({ path: debugShotPath(chatId, 'MD-after-open') }).catch(() => {});
  return { ok: true };
}

// ===== PLAN (ROBUST) =====
async function extractPlanRobust(page) {
  // محاولة 1: span[title] مع retry
  for (let attempt = 0; attempt < 10; attempt++) {
    const titles = page.locator('span[title]');
    const count = await titles.count().catch(() => 0);

    for (let i = 0; i < Math.min(count, 80); i++) {
      const title = await titles.nth(i).getAttribute('title').catch(() => null);
      if (!title) continue;

      // filter قوي للباقة
      if (/GB/i.test(title) || /speed/i.test(title) || /Super/i.test(title)) {
        return title.trim();
      }
    }

    // scroll + wait ثم retry
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(700);
  }

  // محاولة 2: من النص الكامل (fallback regex)
  try {
    const txt = await page.locator('body').innerText().catch(() => '');
    const m = txt.match(/(Super\s*speed[^\n]*\(\s*\d+\s*GB\s*\))/i);
    if (m) return m[1].trim();

    // fallback أوسع
    const m2 = txt.match(/([A-Za-z ]+speed[^\n]*\(\s*\d+\s*GB\s*\))/i);
    if (m2) return m2[1].trim();
  } catch {}

  return '';
}

// ===== METHODS =====

async function extractMethodA(page, chatId, balanceEGP) {
  const out = {
    method: 'A', ok: false, reason: null,
    renewalDate: null, remainingDays: null,
    renewBtnVisible: null, renewBtnEnabled: null,
    renewPriceEGP: null,
    routerName: null, routerMonthlyEGP: null, routerRenewalDate: null,
  };

  try {
    const md = await openMoreDetails(page, chatId);
    if (!md.ok) { out.reason = md.reason; return out; }

    const bodyText = await page.locator('body').innerText().catch(() => '');

    const mLine = bodyText.match(/Renewal\s*Date:.*$/im);
    if (!mLine) { out.reason = 'RENEWAL_NOT_FOUND'; return out; }
    const parsed = parseRenewalLine(mLine[0]);
    out.renewalDate = parsed.renewalDate;
    out.remainingDays = parsed.remainingDays;

    const renewBtn = page.locator('button', { hasText: 'Renew' }).first();
    out.renewBtnVisible = await renewBtn.isVisible().catch(() => false);
    if (out.renewBtnVisible) {
      const dis = await renewBtn.getAttribute('disabled');
      out.renewBtnEnabled = dis === null;
    }

    const idx = bodyText.toLowerCase().indexOf('premium router');
    if (idx >= 0) {
      const seg = bodyText.slice(idx, idx + 800);
      out.routerName = 'PREMIUM Router';
      const mPrice = seg.match(/Price:\s*([\d.,]+)\s*EGP/i);
      const mDate = seg.match(/Renewal Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
      out.routerMonthlyEGP = mPrice ? numFromText(mPrice[1]) : null;
      out.routerRenewalDate = mDate ? mDate[1] : null;
    }

    const egps = Array.from(bodyText.matchAll(/(\d+(?:[.,]\d+)?)\s*EGP/gi)).map(m => numFromText(m[1]));
    out.renewPriceEGP = pickRenewPriceFromEGPs({ egpValues: egps, balanceEGP, routerMonthlyEGP: out.routerMonthlyEGP });

    out.ok = true;
    return out;
  } catch (e) {
    out.reason = 'EXCEPTION:' + String(e?.message || e);
    return out;
  }
}

async function extractMethodB(page, chatId, balanceEGP) {
  const out = {
    method: 'B', ok: false, reason: null,
    renewalDate: null, remainingDays: null,
    renewBtnVisible: null, renewBtnEnabled: null,
    renewPriceEGP: null,
    routerName: null, routerMonthlyEGP: null, routerRenewalDate: null,
  };

  try {
    const md = await openMoreDetails(page, chatId);
    if (!md.ok) { out.reason = md.reason; return out; }

    const renewalNode = page.locator(':text-matches("Renewal\\\\s*Date", "i")').first();
    if (!(await renewalNode.isVisible().catch(() => false))) {
      out.reason = 'RENEWAL_NOT_FOUND';
      return out;
    }
    const renewalLine = await renewalNode.innerText().catch(() => '');
    const parsed = parseRenewalLine(renewalLine);
    out.renewalDate = parsed.renewalDate;
    out.remainingDays = parsed.remainingDays;

    const renewBtn = page.locator('button', { hasText: /Renew/i }).first();
    out.renewBtnVisible = await renewBtn.isVisible().catch(() => false);
    if (out.renewBtnVisible) {
      const dis = await renewBtn.getAttribute('disabled');
      out.renewBtnEnabled = dis === null;
    }

    const routerBlock = page.locator(':text-matches("PREMIUM\\\\s*Router", "i")').first();
    if (await routerBlock.isVisible().catch(() => false)) {
      const blockTxt = await routerBlock.locator('xpath=ancestor::div[1]').innerText().catch(() => '');
      out.routerName = 'PREMIUM Router';
      const mPrice = blockTxt.match(/Price:\s*([\d.,]+)\s*EGP/i);
      const mDate = blockTxt.match(/Renewal Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
      out.routerMonthlyEGP = mPrice ? numFromText(mPrice[1]) : null;
      out.routerRenewalDate = mDate ? mDate[1] : null;
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const egpsAll = Array.from(bodyText.matchAll(/(\d+(?:[.,]\d+)?)\s*EGP/gi)).map(m => numFromText(m[1]));
    out.renewPriceEGP = pickRenewPriceFromEGPs({ egpValues: egpsAll, balanceEGP, routerMonthlyEGP: out.routerMonthlyEGP });

    out.ok = true;
    return out;
  } catch (e) {
    out.reason = 'EXCEPTION:' + String(e?.message || e);
    return out;
  }
}

async function extractMethodC(page, chatId, balanceEGP) {
  const out = {
    method: 'C', ok: false, reason: null,
    renewalDate: null, remainingDays: null,
    renewBtnVisible: null, renewBtnEnabled: null,
    renewPriceEGP: null,
    routerName: null, routerMonthlyEGP: null, routerRenewalDate: null,
  };

  try {
    const md = await openMoreDetails(page, chatId);
    if (!md.ok) { out.reason = md.reason; return out; }

    const renewBtn = page.locator('button', { hasText: /Renew/i }).first();
    out.renewBtnVisible = await renewBtn.isVisible().catch(() => false);
    if (out.renewBtnVisible) {
      const dis = await renewBtn.getAttribute('disabled');
      out.renewBtnEnabled = dis === null;
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');

    const mRenewLine = bodyText.match(/Renewal\s*Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4}).*?(\d+)\s*Remaining\s*Days/i);
    if (mRenewLine) {
      out.renewalDate = mRenewLine[1];
      out.remainingDays = Number(mRenewLine[2]);
    } else {
      const mLine = bodyText.match(/Renewal\s*Date:.*$/im);
      if (mLine) {
        const parsed = parseRenewalLine(mLine[0]);
        out.renewalDate = parsed.renewalDate;
        out.remainingDays = parsed.remainingDays;
      }
    }

    const idx = bodyText.toLowerCase().indexOf('premium router');
    if (idx >= 0) {
      const seg = bodyText.slice(idx, idx + 900);
      out.routerName = 'PREMIUM Router';
      const mPrice = seg.match(/Price:\s*([\d.,]+)\s*EGP/i);
      const mDate = seg.match(/Renewal Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
      out.routerMonthlyEGP = mPrice ? numFromText(mPrice[1]) : null;
      out.routerRenewalDate = mDate ? mDate[1] : null;
    }

    const allEgps = Array.from(bodyText.matchAll(/(\d+(?:[.,]\d+)?)\s*EGP/gi)).map(m => numFromText(m[1]));
    out.renewPriceEGP = pickRenewPriceFromEGPs({ egpValues: allEgps, balanceEGP, routerMonthlyEGP: out.routerMonthlyEGP });

    debugLog('C allEgps:', allEgps);

    out.ok = true;
    return out;
  } catch (e) {
    out.reason = 'EXCEPTION:' + String(e?.message || e);
    return out;
  }
}

function scoreResult(r) {
  let s = 0;
  if (r.renewalDate) s += 2;
  if (typeof r.remainingDays === 'number') s += 2;
  if (typeof r.renewBtnVisible === 'boolean') s += 1;
  if (typeof r.renewBtnEnabled === 'boolean') s += 1;
  if (typeof r.renewPriceEGP === 'number' && r.renewPriceEGP > 0) s += 3;
  if (r.routerName) s += 1;
  if (typeof r.routerMonthlyEGP === 'number' && r.routerMonthlyEGP > 0) s += 2;
  if (r.routerRenewalDate) s += 1;
  return s;
}

function pickBest(results) {
  const withScore = results.map(r => ({ ...r, _score: scoreResult(r) }));

  // ترتيب: الأعلى سكور أولًا، وعند التعادل: A ثم B ثم C
  const priority = { A: 3, B: 2, C: 1 };

  withScore.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return (priority[b.method] || 0) - (priority[a.method] || 0);
  });

  return { best: withScore[0], all: withScore };
}


async function fetchWithSession(chatId) {
  let browser;
  let page;

  try {
    ({ browser, page } = await openAccountOverviewWithSession(chatId, true));

    if (DEBUG) {
      await page.screenshot({ path: debugShotPath(chatId, '00-accountoverview') }).catch(() => {});
      debugLog('URL:', page.url());
    }

    // ✅ أهم إضافة: استنى الصفحة تبقى جاهزة قبل plan
    await waitForOverviewReady(page, chatId);

    const plan = await extractPlanRobust(page);

    const remainingBox = page.locator(SEL.remainingSpan, { hasText: SEL.remainingHasText }).first().locator('xpath=..');
    const usedBox = page.locator(SEL.usedSpan, { hasText: SEL.usedHasText }).first().locator('xpath=..');
    const balBlock = page.locator(SEL.balanceText).locator('xpath=..');

    const remainingGB = numFromText(await remainingBox.innerText().catch(() => ''));
    const usedGB = numFromText(await usedBox.innerText().catch(() => ''));
    const balanceEGP = numFromText(await balBlock.innerText().catch(() => ''));

    async function runMethod(methodFn) {
      try {
        await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        if (isClosedContextError(err)) {
          throw new Error('BROWSER_CLOSED_DURING_FETCH');
        }
        throw err;
      }
      await page.waitForTimeout(3500);
      return methodFn(page, chatId, balanceEGP);
    }

    const rA = await runMethod(extractMethodA);
    const rB = await runMethod(extractMethodB);
    const rC = await runMethod(extractMethodC);

    const picked = pickBest([rA, rB, rC]);
    debugLog('Methods scored:', picked.all.map(x => ({ method: x.method, score: x._score, reason: x.reason })));

    const chosen = picked.best;

    const totalRenewEGP = ((chosen.renewPriceEGP ?? 0) + (chosen.routerMonthlyEGP ?? 0)) || null;
    const canAfford = totalRenewEGP != null && balanceEGP != null ? balanceEGP >= totalRenewEGP : null;

    return {
      plan,
      remainingGB,
      usedGB,
      balanceEGP,

      renewalDate: chosen.renewalDate,
      remainingDays: chosen.remainingDays,
      renewPriceEGP: chosen.renewPriceEGP,
      renewBtnEnabled: chosen.renewBtnEnabled,

      routerName: chosen.routerName,
      routerMonthlyEGP: chosen.routerMonthlyEGP,
      routerRenewalDate: chosen.routerRenewalDate,

      totalRenewEGP,
      canAfford,

      capturedAt: new Date().toISOString(),
      _pickedMethod: chosen.method,
      _methods: picked.all.map(x => ({
        method: x.method,
        score: x._score,
        reason: x.reason,
        renewalDate: x.renewalDate,
        remainingDays: x.remainingDays,
        renewPriceEGP: x.renewPriceEGP,
        routerMonthlyEGP: x.routerMonthlyEGP,
        routerRenewalDate: x.routerRenewalDate,
        renewBtnEnabled: x.renewBtnEnabled,
      })),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function renewWithSession(chatId) {
  let browser;
  try {
    const opened = await openAccountOverviewWithSession(chatId, true);
    browser = opened.browser;
    const page = opened.page;

    const md = await openMoreDetails(page, chatId);
    if (!md.ok) {
      throw new Error(md.reason || 'MORE_DETAILS_NOT_FOUND');
    }

    const renewBtn = page.locator('button', { hasText: /Renew/i }).first();
    await renewBtn.waitFor({ state: 'visible', timeout: 20000 });

    const dis = await renewBtn.getAttribute('disabled');
    if (dis !== null) {
      throw new Error('RENEW_DISABLED');
    }

    await renewBtn.click({ force: true });
    await page.waitForTimeout(5000);
    return true;
  } catch (err) {
    if (isClosedContextError(err)) {
      throw new Error('BROWSER_CLOSED_DURING_RENEW');
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function deleteSession(chatId) {
  const sp = statePath(chatId);
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
  return true;
}

module.exports = { loginAndSave, fetchWithSession, renewWithSession, deleteSession };
