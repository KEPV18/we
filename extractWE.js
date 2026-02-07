const { chromium } = require('playwright');

function numFromText(t) {
    const m = String(t).replace(',', '.').match(/([\d.]+)/);
    return m ? Number(m[1]) : null;
}

(async () => {
    try {
        const browser = await chromium.launch({ headless: false });
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);

        // افتح صفحة اللوجين
        await page.goto('https://my.te.eg/echannel/#/home/signin', { waitUntil: 'networkidle' });

        // ===== LOGIN (نفس اللي نجح معاك) =====
        await page.click('input[placeholder*="Service"]');
        await page.keyboard.type('0228884093', { delay: 80 });

        await page.locator('.ant-select-selector').first().click();
        await page.locator('.ant-select-item-option-content', { hasText: 'Internet' }).click();

        await page.click('#login_password_input_01');
        await page.keyboard.type('Ahmed@19033', { delay: 80 });

        await page.waitForTimeout(1500);

        const loginBtn = page.locator('#login-withecare');
        await loginBtn.waitFor({ state: 'visible' });

        const disabledAttr = await loginBtn.getAttribute('disabled');
        if (disabledAttr !== null) {
            await page.keyboard.press('Tab');
            await page.waitForTimeout(300);
            const disabled2 = await loginBtn.getAttribute('disabled');
            if (disabled2 !== null) {
                await page.evaluate(() => {
                    const btn = document.getElementById('login-withecare');
                    if (btn) btn.removeAttribute('disabled');
                });
            }
        }

        await loginBtn.click({ force: true });

        // استنى الداشبورد
        await page.waitForTimeout(8000);

        // ===== استخراج البيانات =====

        // PLAN: span title="Super speed 1-(400GB)"
        let plan = null;
        try {
            plan = await page.locator('span[title="Super speed 1-(400GB)"]').first().getAttribute('title');
        } catch { }

        // لو الاسم اتغير (مش ثابت)، ناخد أول span[title] واضح ضمن منطقة "Your Current Plan"
        if (!plan) {
            try {
                const nearPlan = page.locator('text=Your Current Plan').locator('xpath=..');
                plan = await nearPlan.locator('span[title]').first().getAttribute('title');
            } catch { }
        }

        // Remaining: الرقم اللي قبل كلمة Remaining (أول بلوك)
        let remainingGB = null;
        try {
            const remainingBox = page.locator('span', { hasText: 'Remaining' }).first().locator('xpath=..');
            remainingGB = numFromText(await remainingBox.innerText());
        } catch { }

        // Used: الرقم اللي قبل كلمة Used (أول بلوك)
        let usedGB = null;
        try {
            const usedBox = page.locator('span', { hasText: 'Used' }).first().locator('xpath=..');
            usedGB = numFromText(await usedBox.innerText());
        } catch { }

        // Balance: Current Balance
        let balanceEGP = null;
        try {
            const balBlock = page.locator('text=Current Balance').locator('xpath=..');
            balanceEGP = numFromText(await balBlock.innerText());
        } catch { }

        console.log("PLAN:", plan);
        console.log("REMAINING_GB:", remainingGB);
        console.log("USED_GB:", usedGB);
        console.log("BALANCE_EGP:", balanceEGP);

        await browser.close();
    } catch (err) {
        console.error("ERROR OCCURRED:");
        console.error(err);
    }
})();
