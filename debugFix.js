require('dotenv').config();
const { chromium } = require('playwright');
const SEL = require('./selectors');
const logger = require('./logger');

async function numFromText(t) {
  const m = String(t ?? '').replace(',', '.').match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testBot() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);

  const serviceNumber = '0228884093';
  const password = 'Ahmed@19033';

  try {
    console.log('1. Opening login page...');
    await page.goto(SEL.signinUrl, { waitUntil: 'networkidle', timeout: 120000 });

    console.log('2. Entering service number:', serviceNumber);
    await page.waitForSelector(SEL.inputService, { state: 'visible' });
    await page.click(SEL.inputService);
    await page.keyboard.type(serviceNumber, { delay: 50 });

    console.log('3. Selecting Internet as service type...');
    const selectorTrigger = page.locator(SEL.selectServiceTypeTrigger).first();
    await selectorTrigger.waitFor({ state: 'visible' });
    await selectorTrigger.click({ force: true });
    await sleep(1000);
    const internetOption = page.locator(SEL.selectServiceTypeInternet).filter({ hasText: /Internet/i }).first();
    await internetOption.waitFor({ state: 'visible' });
    await internetOption.click();

    console.log('4. Entering password...');
    await page.waitForSelector(SEL.inputPassword, { state: 'visible' });
    await page.click(SEL.inputPassword);
    await page.keyboard.type(password, { delay: 50 });

    console.log('5. Clicking login button...');
    const loginBtn = page.locator(SEL.loginButton);
    await loginBtn.waitFor({ state: 'visible' });

    console.log('Checking if button is disabled...');
    let disabledAttr = await loginBtn.getAttribute('disabled');
    if (disabledAttr !== null) {
      console.log('Button is disabled, trying to enable it...');
      await page.keyboard.press('Tab');
      await sleep(300);
      disabledAttr = await loginBtn.getAttribute('disabled');
      if (disabledAttr !== null) {
        await page.evaluate(() => {
          const btn = document.getElementById('login-withecare');
          if (btn) btn.removeAttribute('disabled');
        });
      }
    }

    console.log('Clicking login...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      loginBtn.click({ force: true })
    ]);

    console.log('Waiting for dashboard...');
    await sleep(8000);

    console.log('6. Navigating to overview page...');
    await page.goto(SEL.overviewUrl, { waitUntil: 'domcontentloaded' });
    await sleep(5000);

    console.log('7. Extracting data...');

    // Extract Plan
    const titles = page.locator('span[title]');
    const count = await titles.count().catch(() => 0);
    let plan = '';
    for (let i = 0; i < Math.min(count, 60); i++) {
      const t = await titles.nth(i).getAttribute('title').catch(() => null);
      if (t && t.length > 3 && t.length < 50 && !t.includes('Details') && !t.includes('More')) {
        plan = t.trim();
        break;
      }
    }

    // Extract Remaining
    let remainingGB = null;
    try {
      const remainingBox = page.locator(SEL.remainingSpan, { hasText: SEL.remainingHasText }).first().locator('xpath=..');
      remainingGB = numFromText(await remainingBox.innerText().catch(() => ''));
    } catch (e) { console.log('Error extracting remaining:', e.message); }

    // Extract Used
    let usedGB = null;
    try {
      const usedBox = page.locator(SEL.usedSpan, { hasText: SEL.usedHasText }).first().locator('xpath=..');
      usedGB = numFromText(await usedBox.innerText().catch(() => ''));
    } catch (e) { console.log('Error extracting used:', e.message); }

    // Extract Balance
    let balanceEGP = null;
    try {
      const balBlock = page.locator(SEL.balanceText).locator('xpath=..');
      balanceEGP = numFromText(await balBlock.innerText().catch(() => ''));
    } catch (e) { console.log('Error extracting balance:', e.message); }

    const data = { plan, remainingGB, usedGB, balanceEGP };

    console.log('\n=== EXTRACTED DATA ===');
    console.log('Plan:', plan || 'غير متاح');
    console.log('Remaining:', remainingGB !== null ? remainingGB + ' GB' : 'غير متاح');
    console.log('Used:', usedGB !== null ? usedGB + ' GB' : 'غير متاح');
    console.log('Balance:', balanceEGP !== null ? balanceEGP + ' EGP' : 'غير متاح');

    // Format output
    const now = new Date();
    const arabicDateTime = now.toLocaleString('ar-EG', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const output = [
      `📶 WE Home Internet`,
      `الباقة: ${plan || 'غير متاح'}`,
      `المتبقي: ${remainingGB !== null ? remainingGB.toFixed(2) : 'غير متاح'} GB`,
      `المستخدم (الدورة): ${usedGB !== null ? usedGB.toFixed(2) : 'غير متاح'} GB`,
      `استهلاك النهاردة: 0.00 GB`,
      `التجديد: غير متاح (متبقي ؟ يوم)`,
      `حصتك اليومية لحد التجديد: غير متاح GB/يوم`,
      `متوسط استهلاكك اليومي: غير متاح GB/يوم`,
      `💳 تفاصيل التجديد`,
      `سعر الباقة: غير متاح EGP`,
      `قسط الراوتر: غير متاح EGP`,
      `الإجمالي المتوقع: غير متاح EGP`,
      `الرصيد الحالي: ${balanceEGP !== null ? balanceEGP.toFixed(2) : 'غير متاح'} EGP`,
      `هل الرصيد يكفي؟ ❌ لا`,
      `آخر تحديث: ${arabicDateTime}`
    ].join(' - ');

    console.log('\n=== FORMATTED OUTPUT ===');
    console.log(output);

    await sleep(10000);
    await browser.close();
    console.log('\nTest completed successfully!');

  } catch (err) {
    console.error('\n=== ERROR ===');
    console.error(err);
    const shotPath = `debug-screenshot-${Date.now()}.png`;
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    console.log(`Screenshot saved to: ${shotPath}`);
    await browser.close();
    process.exit(1);
  }
}

testBot();