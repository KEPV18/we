<<<<<<< HEAD
const { chromium } = require('playwright');

(async () => {
    try {
        const browser = await chromium.launch({ headless: false });
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);

        console.log("Opening page...");
        await page.goto('https://my.te.eg/echannel/#/home/signin', {
            waitUntil: 'networkidle'
        });

        console.log("Typing service number...");
        await page.click('input[placeholder*="Service"]');
        await page.keyboard.type('0228884093', { delay: 80 });

        console.log("Opening service type dropdown...");
        await page.locator('.ant-select-selector').click();

        console.log("Selecting Internet...");
        await page.locator('.ant-select-item-option-content', { hasText: 'Internet' }).click();

        console.log("Typing password...");
        await page.click('#login_password_input_01');
        await page.keyboard.type('Ahmed@19033', { delay: 80 });

        // استنى Angular يفعل الزر
        await page.waitForTimeout(1500);

        const loginBtn = page.locator('#login-withecare');
        await loginBtn.waitFor({ state: 'visible' });

        const disabledAttr = await loginBtn.getAttribute('disabled');
        console.log("Login disabled attribute:", disabledAttr);

        if (disabledAttr !== null) {
            console.log("Still disabled — trying to trigger validation...");

            // أحيانًا لازم blur/focus عشان validation تشتغل
            await page.keyboard.press('Tab');
            await page.waitForTimeout(500);

            const disabled2 = await loginBtn.getAttribute('disabled');
            console.log("Login disabled after TAB:", disabled2);

            // كحل أخير: نشيل disabled وندوس (اختبار فقط)
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

        console.log("Waiting result...");
        await page.waitForTimeout(12000);
        console.log("Current URL:", page.url());

        // سيب المتصفح مفتوح عشان تشوف النتيجة
        await new Promise(() => { });
    } catch (err) {
        console.error("ERROR OCCURRED:");
        console.error(err);
    }
})();
=======
const { chromium } = require('playwright');

(async () => {
    try {
        const browser = await chromium.launch({ headless: false });
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);

        console.log("Opening page...");
        await page.goto('https://my.te.eg/echannel/#/home/signin', {
            waitUntil: 'networkidle'
        });

        console.log("Typing service number...");
        await page.click('input[placeholder*="Service"]');
        await page.keyboard.type('0228884093', { delay: 80 });

        console.log("Opening service type dropdown...");
        await page.locator('.ant-select-selector').click();

        console.log("Selecting Internet...");
        await page.locator('.ant-select-item-option-content', { hasText: 'Internet' }).click();

        console.log("Typing password...");
        await page.click('#login_password_input_01');
        await page.keyboard.type('Ahmed@19033', { delay: 80 });

        // استنى Angular يفعل الزر
        await page.waitForTimeout(1500);

        const loginBtn = page.locator('#login-withecare');
        await loginBtn.waitFor({ state: 'visible' });

        const disabledAttr = await loginBtn.getAttribute('disabled');
        console.log("Login disabled attribute:", disabledAttr);

        if (disabledAttr !== null) {
            console.log("Still disabled — trying to trigger validation...");

            // أحيانًا لازم blur/focus عشان validation تشتغل
            await page.keyboard.press('Tab');
            await page.waitForTimeout(500);

            const disabled2 = await loginBtn.getAttribute('disabled');
            console.log("Login disabled after TAB:", disabled2);

            // كحل أخير: نشيل disabled وندوس (اختبار فقط)
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

        console.log("Waiting result...");
        await page.waitForTimeout(12000);
        console.log("Current URL:", page.url());

        // سيب المتصفح مفتوح عشان تشوف النتيجة
        await new Promise(() => { });
    } catch (err) {
        console.error("ERROR OCCURRED:");
        console.error(err);
    }
})();
>>>>>>> cce901cdef7b8d024c96d4da87ba9360bfcdcdba
