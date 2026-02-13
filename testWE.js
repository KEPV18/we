const { chromium } = require('playwright');

async function safeShot(page, name) {
  try {
    await page.screenshot({ path: `${name}-${Date.now()}.png`, fullPage: true });
    console.log("Saved screenshot:", `${name}.png`);
  } catch {}
}

(async () => {
  try {
    const browser = await chromium.launch({
      headless: false, // خليها false محلي عشان تشوف
      // args: ['--start-maximized'], // اختياري
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    console.log("Opening signin page...");
    await page.goto('https://my.te.eg/echannel/#/home/signin', {
      waitUntil: 'domcontentloaded' // ✅ بدل networkidle
    });

    // استنى input service يظهر
    await page.waitForSelector('input[placeholder*="Service"]', { state: 'visible' });

    console.log("Typing service number...");
    await page.click('input[placeholder*="Service"]');
    await page.fill('input[placeholder*="Service"]', '0228884093');

    console.log("Opening service type dropdown...");
    await page.locator('.ant-select-selector').first().click({ force: true });

    console.log("Selecting Internet...");
    // استنى dropdown يتفتح
    await page.waitForSelector('.ant-select-dropdown', { timeout: 10000 }).catch(() => {});
    await page.locator('.ant-select-item-option-content', { hasText: /Internet/i }).first().click({ force: true });

    console.log("Typing password...");
    await page.click('#login_password_input_01');
    await page.fill('#login_password_input_01', 'Ahmed@19033');

    // استنى validation
    await page.waitForTimeout(1200);

    const loginBtn = page.locator('#login-withecare');
    await loginBtn.waitFor({ state: 'visible' });

    const disabledAttr = await loginBtn.getAttribute('disabled');
    console.log("Login disabled attribute:", disabledAttr);

    if (disabledAttr !== null) {
      console.log("Still disabled — trying blur/validation...");
      await page.keyboard.press('Tab');
      await page.waitForTimeout(500);

      const disabled2 = await loginBtn.getAttribute('disabled');
      console.log("Login disabled after TAB:", disabled2);

      if (disabled2 !== null) {
        console.log("Forcing enable via JS (test only)...");
        await page.evaluate(() => {
          const btn = document.getElementById('login-withecare');
          if (btn) btn.removeAttribute('disabled');
        });
      }
    }

    console.log("Clicking Login...");
    await loginBtn.click({ force: true });

    // ✅ استنى يوصل للـ accountoverview (أو على الأقل يتغير الـ URL)
    console.log("Waiting for overview...");
    await Promise.race([
      page.waitForURL(/accountoverview/i, { timeout: 60000 }).catch(() => null),
      page.waitForTimeout(8000),
    ]);

    console.log("Current URL:", page.url());

    // روح للـ overview صراحة
    await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2500);

    // اطبع تشخيص سريع
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText().catch(() => '');
    console.log("TITLE:", title);
    console.log("BODY_HEAD:", body.slice(0, 500));

    if (/0\s+services\s+selected/i.test(body) || /services\s+selected\s*:\s*0/i.test(body)) {
      console.log('⚠️ DETECTED: 0 services selected (ده غالبًا سبب BASICS_NULL على Render)');
      await safeShot(page, 'ZERO_SERVICES_SELECTED');
    }

    // جرّب تلاقي Remaining/Used
    const remainingVisible = await page.locator('text=/Remaining/i').first().isVisible().catch(() => false);
    const usedVisible = await page.locator('text=/Used/i').first().isVisible().catch(() => false);
    console.log("Remaining visible?", remainingVisible);
    console.log("Used visible?", usedVisible);

    if (!remainingVisible && !usedVisible) {
      console.log("⚠️ Remaining/Used مش ظاهرين - خد Screenshot");
      await safeShot(page, 'BASICS_NOT_VISIBLE');
    } else {
      await safeShot(page, 'OVERVIEW_OK');
    }

    console.log("ترك المتصفح مفتوح... اقفل يدويًا لما تخلص");
    await new Promise(() => {});
  } catch (err) {
    console.error("ERROR OCCURRED:");
    console.error(err);
  }
})();
