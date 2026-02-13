const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

(async () => {
  const OUT_DIR = path.join(__dirname, 'dump');
  ensureDir(OUT_DIR);

  // ⚠️ حط بياناتك هنا مؤقتًا (أو خليها من env لو تحب)
  const SERVICE = '0228884093';
  const PASSWORD = 'Ahmed@19033';

  const stamp = ts();

  const browser = await chromium.launch({
    headless: false, // خليها false عشان تشوف اللي بيحصل
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    console.log('Opening signin...');
    await page.goto('https://my.te.eg/echannel/#/home/signin', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('input[placeholder*="Service"]', { state: 'visible' });

    console.log('Typing service...');
    await page.fill('input[placeholder*="Service"]', SERVICE);

    console.log('Selecting Internet...');
    await page.locator('.ant-select-selector').first().click({ force: true });
    await page.waitForSelector('.ant-select-dropdown', { timeout: 10000 }).catch(() => {});
    await page.locator('.ant-select-item-option-content', { hasText: /Internet/i }).first().click({ force: true });

    console.log('Typing password...');
    await page.fill('#login_password_input_01', PASSWORD);

    await page.waitForTimeout(1000);

    console.log('Clicking login...');
    await page.locator('#login-withecare').click({ force: true });

    // انتظر overview
    await Promise.race([
      page.waitForURL(/accountoverview/i, { timeout: 60000 }).catch(() => null),
      page.waitForTimeout(8000),
    ]);

    console.log('Now at:', page.url());

    // روح للـ overview صراحة
    await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2500);

    // Dump قبل الضغط على More Details
    const html1 = await page.content();
    const bodyText1 = await page.locator('body').innerText().catch(() => '');
    const shot1 = path.join(OUT_DIR, `overview_before_${stamp}.png`);
    await page.screenshot({ path: shot1, fullPage: true });

    fs.writeFileSync(path.join(OUT_DIR, `overview_before_${stamp}.html`), html1, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, `overview_before_${stamp}.txt`), bodyText1, 'utf8');

    console.log('Saved BEFORE dumps to:', OUT_DIR);

    // حاول تلاقي زر/لينك More Details بأكثر من طريقة
    console.log('Trying to open More Details...');
    const moreByText = page.getByText(/More Details/i).first();
    const moreVisible = await moreByText.isVisible().catch(() => false);

    if (moreVisible) {
      await moreByText.scrollIntoViewIfNeeded().catch(() => {});
      await moreByText.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      // fallback: أي span يحتوي More Details
      const moreSpan = page.locator('span', { hasText: /More Details/i }).first();
      if (await moreSpan.isVisible().catch(() => false)) {
        await moreSpan.scrollIntoViewIfNeeded().catch(() => {});
        await moreSpan.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        console.log('⚠️ More Details not found by text. Skipping click.');
      }
    }

    // Dump بعد الضغط على More Details
    const html2 = await page.content();
    const bodyText2 = await page.locator('body').innerText().catch(() => '');
    const shot2 = path.join(OUT_DIR, `overview_after_${stamp}.png`);
    await page.screenshot({ path: shot2, fullPage: true });

    fs.writeFileSync(path.join(OUT_DIR, `overview_after_${stamp}.html`), html2, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, `overview_after_${stamp}.txt`), bodyText2, 'utf8');

    console.log('Saved AFTER dumps to:', OUT_DIR);

    // اطبع سطر يدل لو ظهر Renewal
    console.log('After click - contains Renewal Date?', /Renewal\s*Date/i.test(bodyText2));

    console.log('Done. Close browser manually when finished.');
    await new Promise(() => {});
  } catch (e) {
    console.error('ERROR:', e?.message || e);
  }
})();
