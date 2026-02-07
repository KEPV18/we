const { chromium } = require('playwright');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function numFromText(t) {
    const m = String(t ?? '').replace(',', '.').match(/([\d.]+)/);
    return m ? Number(m[1]) : null;
}

function parseRenewalLine(line) {
    const s = String(line ?? '');
    const d = s.match(/Renewal\s*Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
    const rd = s.match(/(\d+)\s*Remaining\s*Days/i);
    return {
        renewalDate: d ? d[1] : null,
        remainingDays: rd ? Number(rd[1]) : null,
    };
}

(async () => {
    const SERVICE_NUMBER = process.env.WE_SERVICE_NUMBER || '0228884093';
    const PASSWORD = process.env.WE_PASSWORD || 'Ahmed@19033';

    console.log('Launching browser (VISIBLE)...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 200,
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.setDefaultNavigationTimeout(180000);

    const result = {
        urlAfterLogin: null,

        plan: null,
        remainingGB: null,
        usedGB: null,
        balanceEGP: null,

        moreDetailsVisible: null,
        moreDetailsClicked: null,

        renewalLine: null,
        renewalDate: null,
        remainingDays: null,

        renewBtnVisible: null,
        renewBtnEnabled: null,

        renewPriceEGP: null,

        routerCardVisible: null,
        routerMonthlyEGP: null,
        routerRenewalDate: null,
    };

    // 0) Open login
    console.log('Step 0: Open login page');
    await page.goto('https://my.te.eg/echannel/#/home/signin', { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // 1) Type service number
    console.log('Step 1: Type service number');
    await page.click('input[placeholder*="Service"]');
    await page.keyboard.type(String(SERVICE_NUMBER), { delay: 60 });
    await sleep(1200);

    // 2) Select Internet
    console.log('Step 2: Select service type = Internet');
    await page.locator('.ant-select-selector').first().click();
    await sleep(700);
    await page.locator('.ant-select-item-option-content', { hasText: 'Internet' }).click();
    await sleep(1200);

    // 3) Type password
    console.log('Step 3: Type password');
    await page.click('#login_password_input_01');
    await page.keyboard.type(String(PASSWORD), { delay: 60 });
    await sleep(1200);

    // 4) Click login
    console.log('Step 4: Click Login');
    const loginBtn = page.locator('#login-withecare');
    await loginBtn.waitFor({ state: 'visible' });

    const dis = await loginBtn.getAttribute('disabled');
    console.log('Login disabled attr:', dis);
    if (dis !== null) {
        console.log('Removing disabled attribute...');
        await page.evaluate(() => {
            const btn = document.getElementById('login-withecare');
            if (btn) btn.removeAttribute('disabled');
        });
        await sleep(400);
    }

    await loginBtn.click({ force: true });
    console.log('Clicked login, waiting 8s...');
    await page.waitForTimeout(8000);

    result.urlAfterLogin = page.url();
    console.log('URL after login:', result.urlAfterLogin);

    // 5) Go accountoverview
    console.log('Step 5: Open accountoverview and wait...');
    await page.goto('https://my.te.eg/echannel/#/accountoverview', { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    console.log('Now at:', page.url());

    // ===== BASIC EXTRACTION =====
    console.log('Step 6: Extract basic values (plan/remaining/used/balance)');

    // Plan
    result.plan = await page.locator('span[title]').first().getAttribute('title').catch(() => null);

    // Remaining / Used
    // نفس اللي شغال عندك: span Remaining / Used ثم parent
    const remainingBox = page.locator('span', { hasText: 'Remaining' }).first().locator('xpath=..');
    const usedBox = page.locator('span', { hasText: 'Used' }).first().locator('xpath=..');

    result.remainingGB = numFromText(await remainingBox.innerText().catch(() => ''));
    result.usedGB = numFromText(await usedBox.innerText().catch(() => ''));

    // Balance
    const balBlock = page.locator('text=Current Balance').locator('xpath=..');
    result.balanceEGP = numFromText(await balBlock.innerText().catch(() => ''));

    console.log('Basic:', {
        plan: result.plan,
        remainingGB: result.remainingGB,
        usedGB: result.usedGB,
        balanceEGP: result.balanceEGP,
    });

    // ===== DETAILS EXTRACTION =====
    console.log('Step 7: Click More Details + extract renewal/price/router/renew button');

    const more = page.locator('span', { hasText: 'More Details' }).first();
    result.moreDetailsVisible = await more.isVisible().catch(() => false);
    console.log('More Details visible:', result.moreDetailsVisible);

    if (result.moreDetailsVisible) {
        await more.scrollIntoViewIfNeeded().catch(() => { });
        await more.click({ force: true }).then(
            () => { result.moreDetailsClicked = true; },
            async () => {
                result.moreDetailsClicked = false;
                console.log('More Details click failed -> trying eval click');
                await page.evaluate(() => {
                    const el = Array.from(document.querySelectorAll('span')).find(
                        s => (s.textContent || '').trim().toLowerCase() === 'more details'
                    );
                    if (el) el.click();
                });
                result.moreDetailsClicked = true;
            }
        );

        console.log('Clicked More Details, waiting 6s...');
        await sleep(6000);

        // Scroll down a bit (sometimes renewal is below)
        for (let i = 0; i < 5; i++) {
            await page.mouse.wheel(0, 900);
            await sleep(400);
        }

        // Renewal line (robust)
        const renewalNode = page.locator(':text-matches("Renewal\\\\s*Date", "i")').first();
        const renewalVisible = await renewalNode.isVisible().catch(() => false);

        if (renewalVisible) {
            result.renewalLine = await renewalNode.innerText().catch(() => null);
            const parsed = parseRenewalLine(result.renewalLine || '');
            result.renewalDate = parsed.renewalDate;
            result.remainingDays = parsed.remainingDays;
        }

        console.log('Renewal:', {
            renewalVisible,
            renewalLine: result.renewalLine,
            renewalDate: result.renewalDate,
            remainingDays: result.remainingDays,
        });

        // Renew button
        const renewBtn = page.locator('button', { hasText: 'Renew' }).first();
        result.renewBtnVisible = await renewBtn.isVisible().catch(() => false);
        if (result.renewBtnVisible) {
            const renewDisabled = await renewBtn.getAttribute('disabled').catch(() => 'disabled');
            result.renewBtnEnabled = renewDisabled === null;
        }
        console.log('Renew button:', {
            visible: result.renewBtnVisible,
            enabled: result.renewBtnEnabled,
        });

        // Renew price (try to pick from area near renewal line; fallback: find "570 EGP" style block)
        // 1) try around the renewal node container
        let priceText = null;
        try {
            const area1 = await renewalNode.locator('xpath=ancestor::div[2]').innerText().catch(() => null);
            priceText = area1 || priceText;
        } catch { }
        // 2) fallback: any "EGP" number (but this can pick router/balance — we try to avoid by preferring after More Details)
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const idx = bodyText.toLowerCase().indexOf('renewal date');
        const windowText = idx >= 0 ? bodyText.slice(idx, idx + 2500) : bodyText.slice(0, 2500);
        const mPrice = (priceText || windowText).match(/(\d+(?:[.,]\d+)?)\s*EGP/i);
        result.renewPriceEGP = mPrice ? numFromText(mPrice[1]) : null;

        console.log('Renew price guess:', result.renewPriceEGP);

        // Router card
        const routerCard = page.locator('div', { hasText: 'PREMIUM Router' }).first();
        result.routerCardVisible = await routerCard.isVisible().catch(() => false);
        if (result.routerCardVisible) {
            const routerTxt = await routerCard.innerText().catch(() => '');
            const mRouterPrice = routerTxt.match(/Price:\s*([\d.,]+)\s*EGP/i);
            const mRouterDate = routerTxt.match(/Renewal Date:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);

            result.routerMonthlyEGP = mRouterPrice ? numFromText(mRouterPrice[1]) : null;
            result.routerRenewalDate = mRouterDate ? mRouterDate[1] : null;
        }

        console.log('Router:', {
            visible: result.routerCardVisible,
            monthlyEGP: result.routerMonthlyEGP,
            renewalDate: result.routerRenewalDate,
        });
    } else {
        console.log('❌ More Details NOT visible.');
    }

    // ===== FINAL SUMMARY =====
    console.log('\n================ FINAL SUMMARY ================');
    console.log(JSON.stringify(result, null, 2));
    console.log('================================================\n');

    console.log('✅ DONE. Browser will stay OPEN for manual inspection.');
    console.log('Close the browser window OR press Ctrl+C here.\n');

    // Keep open
    // eslint-disable-next-line no-constant-condition
    while (true) await sleep(60_000);
})();
