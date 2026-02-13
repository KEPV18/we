const { loginAndSave, fetchWithSession } = require('./weSession');
const { initUsageDb } = require('./usageDb');
const logger = require('./logger');

async function test() {
  const testChatId = 'TEST_USER_123';
  const serviceNumber = '0228884093';
  const password = 'Ahmed@19033';

  console.log('🚀 Starting Test with Credentials...');
  
  try {
    // 1. Init DB
    initUsageDb();
    
    // 2. Try Login
    console.log('--- Step 1: Login ---');
    const loginResult = await loginAndSave(testChatId, serviceNumber, password);
    console.log('✅ Login Successful:', loginResult);

    // 3. Try Fetching Data
    console.log('--- Step 2: Fetch Data ---');
    const data = await fetchWithSession(testChatId);
    console.log('✅ Data Fetched Successfully:');
    console.log(JSON.stringify(data, null, 2));

  } catch (err) {
    console.error('❌ Test Failed:');
    console.error(err);
  } finally {
    process.exit(0);
  }
}

test();
