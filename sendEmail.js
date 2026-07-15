// sendEmail.js
const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false
    },
    family: 4, // force IPv4 — prevents ENETUNREACH on VPS with no IPv6
    // Optional: force direct connection
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
});

async function sendEmail(to, subject, html) {
    try {
        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to,
            subject,
            html
        });
        console.log('✅ Email sent successfully:', info.messageId);
        return info;
    } catch (error) {
        console.error('❌ Error sending email:', error.message);
        if (error.code === 'ESOCKET') {
            console.log('\n💡 Tip: This is usually a network / firewall / proxy issue.');
        }
        throw error; // re-throw so the caller can count this as a failure
    }
}

module.exports = { sendEmail };