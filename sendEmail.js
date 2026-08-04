// sendEmail.js — send via a specific Gmail account (app password)
const nodemailer = require('nodemailer');

const transporterCache = new Map();

function getTransporter(account) {
    const key = account.email;
    if (transporterCache.has(key)) return transporterCache.get(key);

    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: account.email,
            pass: account.pass // already space-stripped by accounts.js
        },
        tls: {
            rejectUnauthorized: false
        },
        family: 4, // force IPv4 — prevents ENETUNREACH on VPS with no IPv6
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
    });

    transporterCache.set(key, transporter);
    return transporter;
}

async function sendEmail(to, subject, html, account) {
    if (!account?.email || !account?.pass) {
        throw new Error('sendEmail: account { email, pass } is required');
    }

    try {
        const transporter = getTransporter(account);
        const info = await transporter.sendMail({
            from: account.email,
            to,
            subject,
            html
        });
        console.log(`✅ Email sent via ${account.email}:`, info.messageId);
        return info;
    } catch (error) {
        console.error(`❌ Error sending via ${account.email}:`, error.message);
        if (error.code === 'ESOCKET') {
            console.log('\n💡 Tip: This is usually a network / firewall / proxy issue.');
        }
        throw error;
    }
}

module.exports = { sendEmail, getTransporter };
