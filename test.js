// test.js — verify email sending works before running the full bot
require('dotenv').config();
const { sendEmail } = require('./sendEmail');

async function testEmailSending() {
    const to = process.env.EMAIL_USER; // send to yourself as a sanity check

    console.log(`Testing email send to: ${to}`);
    console.log('Connecting to smtp.gmail.com...\n');

    await sendEmail(
        to,
        '[TEST] Mail bot is working',
        `
        <h2>✅ Test passed</h2>
        <p>Your mail automation bot is configured correctly and able to send emails.</p>
        <p>Sent at: ${new Date().toISOString()}</p>
        `
    );
}

testEmailSending().catch(err => {
    console.error('Test failed:', err.message);
    process.exit(1);
});
