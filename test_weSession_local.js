require('dotenv').config();

const { initUsageDb, saveCredentials } = require('./usageDb');
const { loginAndSave, fetchWithSession, deleteSession, getSessionDiagnostics, loginAndFetchOnce } = require('./weSession');

(async () => {
  const CHAT_ID = process.env.TEST_CHAT_ID || 'local-test';

  const SERVICE = process.env.WE_SERVICE;
  const PASSWORD = process.env.WE_PASSWORD;

  try {
    console.log('== weSession LOCAL TEST ==');
    console.log('CHAT_ID:', CHAT_ID);

    if (!SERVICE || !PASSWORD) {
      console.log('❌ لازم تحط WE_SERVICE و WE_PASSWORD في .env');
      console.log('مثال:');
      console.log('WE_SERVICE=0228884093');
      console.log('WE_PASSWORD=your_password');
      process.exit(1);
    }

    initUsageDb();

    console.log('Deleting old session (if any)...');
    await deleteSession(CHAT_ID).catch(() => {});

    await saveCredentials(CHAT_ID, SERVICE, PASSWORD);

    const useCombined = process.env.USE_COMBINED === '1';
    if (useCombined) {
      console.log('Logging in + Fetching in ONE browser...');
      const data = await loginAndFetchOnce(CHAT_ID, SERVICE, PASSWORD);
      console.log('✅ One-shot Fetch OK');
      var resultData = data;
    } else {
      console.log('Logging in...');
      await loginAndSave(CHAT_ID, SERVICE, PASSWORD);
      console.log('✅ Login OK');

      console.log('Fetching...');
      const data = await fetchWithSession(CHAT_ID);
      var resultData = data;
    }
    console.log('✅ Fetch OK');

    const diag = getSessionDiagnostics(CHAT_ID);

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(resultData, null, 2));

    console.log('\n=== DIAGNOSTICS ===');
    console.log(JSON.stringify(diag, null, 2));

    const missing = [];
    if (resultData.remainingGB == null) missing.push('remainingGB');
    if (resultData.usedGB == null) missing.push('usedGB');
    if (resultData.balanceEGP == null) missing.push('balanceEGP');
    if (resultData.renewPriceEGP == null) missing.push('renewPriceEGP');
    if (!resultData.renewalDate) missing.push('renewalDate');
    if (resultData.remainingDays == null) missing.push('remainingDays');

    console.log('\n=== CHECKS ===');
    if (missing.length === 0) {
      console.log('✅ كل القيم الأساسية + التجديد اتجابت تمام');
    } else {
      console.log('⚠️ في قيم ناقصة:', missing.join(', '));
      console.log('ملحوظة: الراوتر/التفاصيل ممكن تختلف حسب الحساب.');
    }

    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:');
    console.error(err?.message || err);

    try {
      const diag = getSessionDiagnostics(process.env.TEST_CHAT_ID || 'local-test');
      console.log('\n=== DIAGNOSTICS (after fail) ===');
      console.log(JSON.stringify(diag, null, 2));
    } catch {}

    process.exit(1);
  }
})();
