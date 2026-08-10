// sendEmail.js — send via any configured account (Gmail app password, mail.ee, or custom SMTP)
const nodemailer = require('nodemailer');

const transporterCache = new Map();

/** Known SMTP settings by email domain — extend as you add providers. */
const PROVIDER_SMTP = {
    'gmail.com':     { host: 'smtp.gmail.com', port: 465, secure: true },
    'mail.ee':       { host: 'smtp.mail.ee',   port: 465, secure: true },
    'outlook.com':   { host: 'smtp.office365.com', port: 587, secure: false },
    'hotmail.com':   { host: 'smtp.office365.com', port: 587, secure: false },
    'yahoo.com':     { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
};

/**
 * Resolve SMTP host/port/secure for an account.
 * Priority: explicit fields on the account (accounts.json) > known provider by domain.
 */
function resolveSmtp(account) {
    if (account.host) {
        return {
            host: account.host,
            port: account.port ?? 465,
            secure: account.secure ?? true,
        };
    }
    const domain = account.email.split('@')[1]?.toLowerCase();
    const known = PROVIDER_SMTP[domain];
    if (known) return known;

    throw new Error(
        `sendEmail: no SMTP config for domain "${domain}". ` +
        `Add "host"/"port"/"secure" fields to this account in accounts.json, ` +
        `or add "${domain}" to PROVIDER_SMTP in sendEmail.js.`
    );
}

function getTransporter(account) {
    const key = account.email;
    if (transporterCache.has(key)) return transporterCache.get(key);

    const smtp = resolveSmtp(account);
    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
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
