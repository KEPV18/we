const { loginAndSave, fetchWithSession } = require('./weSession');
const { initUsageDb } = require('./usageDb');
const logger = require('./logger');

async function test() {
  const testChatId = 'TEST_USER_123';
  const serviceNumber = '0228884093';
  const password = 'Ahmed@19033';

  console.log('🚀 Starting Comprehensive Test...');
  
  try {
    initUsageDb();
    
    // 1. Force fresh login
    console.log('\n--- Step 1: Login ---');
    await loginAndSave(testChatId, serviceNumber, password);
    console.log('✅ Login Successful');

    // 2. Fetch data (this will try to get more details)
    console.log('\n--- Step 2: Fetch Data & Details ---');
    const data = await fetchWithSession(testChatId);
    console.log('✅ Data Fetched:');
    
    // 3. Display in the new format to see how it looks
    console.log('\n--- Step 3: Formatted Report ---');
    
    const to2 = (n) => (n || 0).toFixed(2);
    const now = new Date();
    const arabicDateTime = now.toLocaleString('ar-EG');
    const remainingDays = data.remainingDays || 0;
    const dailyQuota = (remainingDays > 0) ? (data.remainingGB / remainingDays) : 0;
    const avgUsage = 0.29; // Mocking avg for display

    const report = `📶 WE Home Internet
 - الباقة: ${data.plan || 'غير متاح'}
 - المتبقي: ${to2(data.remainingGB)} GB
 - المستخدم (الدورة): ${to2(data.usedGB)} GB
 - استهلاك النهاردة: ${to2(0)} GB
 - التجديد: ${data.renewalDate || 'غير متاح'} (متبقي ${remainingDays} يوم)
 - حصتك اليومية لحد التجديد: ${to2(dailyQuota)} GB/يوم
 - متوسط استهلاكك اليومي: ${to2(avgUsage)} GB/يوم

 💳 تفاصيل التجديد
 - سعر الباقة: ${to2(data.renewPriceEGP)} EGP
 - قسط الراوتر: ${to2(data.routerMonthlyEGP)} EGP ${data.routerRenewalDate ? `(تجديده: ${data.routerRenewalDate})` : ''}
 - الإجمالي المتوقع: ${to2((data.renewPriceEGP || 0) + (data.routerMonthlyEGP || 0))} EGP
 - الرصيد الحالي: ${to2(data.balanceEGP)} EGP
 - هل الرصيد يكفي؟ ${data.balanceEGP >= ((data.renewPriceEGP || 0) + (data.routerMonthlyEGP || 0)) ? '✅ نعم' : '❌ لا'}
 - آخر تحديث: ${arabicDateTime}`;

    console.log(report);

    if (data._detailsUnavailable) {
        console.log('\n⚠️ Note: Some details were unavailable:', data._detailsUnavailable);
    }

  } catch (err) {
    console.error('❌ Test Failed:', err);
  } finally {
    process.exit(0);
  }
}

test();
