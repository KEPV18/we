const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, 'usage.db');
console.log('DB Path:', dbPath);

if (!fs.existsSync(dbPath)) {
    console.error('❌ usage.db not found!');
    process.exit(1);
}

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('❌ Error opening DB:', err.message);
        process.exit(1);
    }
    console.log('✅ Connected to usage.db');
});

function runQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function check() {
    try {
        console.log('\n--- 1. Checking User Credentials ---');
        const creds = await runQuery('SELECT chatId, serviceNumber, length(password) as pwdLen, updatedAt FROM user_credentials');
        if (creds.length === 0) {
            console.log('❌ No credentials found in DB.');
        } else {
            console.table(creds);
            console.log('✅ Credentials exist.');
        }

        console.log('\n--- 2. Checking Snapshots (Last 5) ---');
        const snapshots = await runQuery('SELECT * FROM snapshots ORDER BY timestamp DESC LIMIT 5');
        if (snapshots.length === 0) {
            console.log('❌ No snapshots found.');
        } else {
            console.table(snapshots.map(s => ({
                chatId: s.chatId,
                timestamp: s.timestamp,
                usedGB: s.usedGB,
                remainingGB: s.remainingGB,
                plan: s.plan
            })));
            console.log('✅ Snapshots exist.');
        }

        console.log('\n--- 3. Checking User States ---');
        const states = await runQuery('SELECT * FROM user_states');
        console.table(states);

    } catch (err) {
        console.error('❌ Query Error:', err);
    } finally {
        db.close();
    }
}

check();
