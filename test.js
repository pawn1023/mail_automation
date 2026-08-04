// test.js — verify every mail account in accounts.json / .env can send
require('dotenv').config();
const { loadAccounts } = require('./accounts');
const { sendEmail } = require('./sendEmail');

async function testEmailSending() {
    const region = (process.argv[2] || '').toLowerCase(); // optional: usa | europe
    const accounts = loadAccounts(region || undefined);
    console.log(`Testing ${accounts.length} account(s) via smtp.gmail.com...\n`);

    let ok = 0;
    let fail = 0;

    for (const account of accounts) {
        const to = account.email; // send to self as sanity check
        console.log(`── ${account.email} → ${to}`);
        try {
            await sendEmail(
                to,
                '[TEST] Mail bot is working',
                `
                <h2>Test passed</h2>
                <p>Account <strong>${account.email}</strong> can send mail.</p>
                <p>Sent at: ${new Date().toISOString()}</p>
                `,
                account
            );
            ok++;
        } catch (err) {
            console.error(`   FAILED: ${err.message}`);
            fail++;
        }
        console.log('');
    }

    console.log(`=== Result: ${ok} ok, ${fail} failed ===`);
    if (fail > 0) process.exit(1);
}

testEmailSending().catch(err => {
    console.error('Test failed:', err.message);
    process.exit(1);
});
