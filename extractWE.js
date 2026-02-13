/**
 * we_debug_render.js
 * تشغيل: node we_debug_render.js
 *
 * مطلوب في ENV:
 *  WE_SERVICE=xxxxxxxxxx
 *  WE_PASSWORD=xxxxxxxx
 * اختياري:
 *  WE_SERVICE_TYPE=Internet
 *  DEBUG_SHOTS_DIR=./debug
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

function numFromText(t) {
  const m = String(t)
    .replace(/,/g, ".")
    .match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}

function ensureDir(dir) {
  if (!dir) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function safeShot(page, shotsDir, name) {
  try {
    if (!shotsDir) return;
    ensureDir(shotsDir);
    const file = path.join(
      shotsDir,
      `${Date.now()}-${name}`.replace(/[^\w.-]+/g, "_") + ".png"
    );
    await page.screenshot({ path: file, fullPage: true });
    console.log("[DEBUG] screenshot:", file);
  } catch {}
}

async function waitEnabled(locator, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const disabled = await locator.getAttribute("disabled");
    if (disabled === null) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const SERVICE = process.env.WE_SERVICE;
  const PASSWORD = process.env.WE_PASSWORD;
  const SERVICE_TYPE = process.env.WE_SERVICE_TYPE || "Internet";
  const SHOTS_DIR = process.env.DEBUG_SHOTS_DIR || "./debug";

  if (!SERVICE || !PASSWORD) {
    console.error(
      "ENV_MISSING: لازم تضيف WE_SERVICE و WE_PASSWORD في Environment على Render."
    );
    process.exit(1);
  }

  let browser;
  const ctxInfo = { step: "init" };

  try {
    browser = await chromium.launch({
      headless: true, // Render لازم headless
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      locale: "en-US", // خليه ثابت لتقليل تغيّر النصوص
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    // ============ 1) Open login ============
    ctxInfo.step = "goto_login";
    await page.goto("https://my.te.eg/echannel/#/home/signin", {
      waitUntil: "domcontentloaded",
    });

    // استنى عناصر اللوجين تظهر بدل networkidle
    await page.waitForSelector("#login_password_input_01", { timeout: 60000 });

    // ============ 2) Fill service ============
    ctxInfo.step = "fill_service";
    // الحقل أحيانًا بيتغير placeholder، فنعمل fallback:
    const serviceInput =
      page.locator('input[placeholder*="Service"]').first().or(
        page.locator('input[placeholder*="service"]').first()
      );

    // لو مش لاقيه نجرّب أي input داخل منطقة form
    const serviceFallback = page.locator("form input").first();

    const serviceBoxCount = await serviceInput.count();
    if (serviceBoxCount > 0) {
      await serviceInput.click({ force: true });
      await serviceInput.fill("");
      await serviceInput.type(SERVICE, { delay: 40 });
    } else {
      await serviceFallback.click({ force: true });
      await serviceFallback.fill("");
      await serviceFallback.type(SERVICE, { delay: 40 });
    }

    // ============ 3) Select service type (Internet) ============
    ctxInfo.step = "select_service_type";
    // غالبًا ant-select
    const selectTrigger = page.locator(".ant-select-selector").first();
    await selectTrigger.click({ force: true });

    // استنى dropdown يظهر
    await page.waitForSelector(".ant-select-dropdown", { timeout: 30000 });

    // اختار Internet (Regex عشان يبقى مرن)
    const option = page.locator(".ant-select-item-option-content", {
      hasText: new RegExp(`^\\s*${SERVICE_TYPE}\\s*$`, "i"),
    });

    // لو ما لقاش نفس الاسم، جرّب contains
    if ((await option.count()) === 0) {
      await page
        .locator(".ant-select-item-option-content", {
          hasText: new RegExp(SERVICE_TYPE, "i"),
        })
        .first()
        .click({ force: true });
    } else {
      await option.first().click({ force: true });
    }

    // ============ 4) Fill password ============
    ctxInfo.step = "fill_password";
    const passInput = page.locator("#login_password_input_01");
    await passInput.click({ force: true });
    await passInput.fill("");
    await passInput.type(PASSWORD, { delay: 40 });

    // ============ 5) Click login ============
    ctxInfo.step = "click_login";
    const loginBtn = page.locator("#login-withecare");
    await loginBtn.waitFor({ state: "visible", timeout: 30000 });

    // استنى يبقى enabled طبيعيًا (بدون removeAttribute)
    const enabled = await waitEnabled(loginBtn, 30000);
    if (!enabled) {
      console.warn("[WARN] Login button still disabled after 30s. Trying click anyway...");
    }

    await loginBtn.click({ force: true });

    // ============ 6) Wait for dashboard ============
    ctxInfo.step = "wait_dashboard";
    // استنى URL أو عنصر واضح بدل waitForTimeout
    await page.waitForURL(/\/accountoverview/i, { timeout: 60000 });

    // استنى عناصر البيانات تظهر (Remaining / Used عادة موجودين)
    // لو الموقع يغيّر اللغة، حط fallback بالعربي لاحقًا
    const remainingLabel = page.locator("text=/Remaining/i").first();
    const usedLabel = page.locator("text=/Used/i").first();

    // انتظر واحد منهم على الأقل
    await Promise.race([
      remainingLabel.waitFor({ state: "visible", timeout: 60000 }),
      usedLabel.waitFor({ state: "visible", timeout: 60000 }),
    ]);

    // ============ 7) Extract data ============
    ctxInfo.step = "extract";

    // PLAN: حاول من بلوك Your Current Plan
    let plan = null;
    try {
      const planBlock = page
        .locator("text=/Your Current Plan/i")
        .first()
        .locator("xpath=..");
      plan = await planBlock.locator("[title]").first().getAttribute("title");
    } catch {}

    // Remaining GB
    let remainingGB = null;
    try {
      const remainingBox = page
        .locator("span", { hasText: /Remaining/i })
        .first()
        .locator("xpath=..");
      remainingGB = numFromText(await remainingBox.innerText());
    } catch {}

    // Used GB
    let usedGB = null;
    try {
      const usedBox = page
        .locator("span", { hasText: /Used/i })
        .first()
        .locator("xpath=..");
      usedGB = numFromText(await usedBox.innerText());
    } catch {}

    // Balance EGP
    let balanceEGP = null;
    try {
      const balBlock = page
        .locator("text=/Current Balance/i")
        .first()
        .locator("xpath=..");
      balanceEGP = numFromText(await balBlock.innerText());
    } catch {}

    // لو أي حاجة null، خد screenshot عشان تشوف الصفحة على Render
    if (!plan || remainingGB === null || usedGB === null) {
      await safeShot(page, SHOTS_DIR, "missing_fields");
    }

    console.log("PLAN:", plan);
    console.log("REMAINING_GB:", remainingGB);
    console.log("USED_GB:", usedGB);
    console.log("BALANCE_EGP:", balanceEGP);

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error("ERROR OCCURRED at step:", ctxInfo.step);
    console.error(err?.message || err);

    try {
      // حاول تعمل screenshot حتى لو حصل error
      if (browser) {
        const pages = browser.contexts()?.[0]?.pages?.();
        const page = pages?.[0];
        if (page) await safeShot(page, process.env.DEBUG_SHOTS_DIR || "./debug", `error_${ctxInfo.step}`);
      }
    } catch {}

    try {
      if (browser) await browser.close();
    } catch {}

    process.exit(1);
  }
})();
