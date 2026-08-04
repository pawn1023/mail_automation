// accounts.js — load Gmail accounts (email + 16-char app password), optionally by region
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

/** App passwords are 16 chars; Gmail often shows them with spaces — strip those. */
function normalizePass(pass) {
    return String(pass || '').replace(/\s+/g, '');
}

function validateAccount(raw, index) {
    const email  = (raw.email || raw.user || raw.mail || '').trim();
    const pass   = normalizePass(raw.pass || raw.password || raw.key || raw.appPassword);
    const region = (raw.region || '').trim().toLowerCase() || null;

    if (!email || !pass) {
        throw new Error(`Account #${index + 1}: missing email or pass`);
    }
    if (pass.length !== 16) {
        console.warn(`[accounts] ⚠  ${email}: app password length is ${pass.length} (expected 16) — check for typos`);
    }
    return { email, pass, region };
}

function loadFromEnv() {
    const email = (process.env.EMAIL_USER || process.env.MAIL_USER || '').trim();
    const pass  = normalizePass(process.env.EMAIL_PASS || process.env.MAIL_PASS);
    if (!email || !pass) return [];
    return [{ email, pass, region: null }];
}

function loadAllAccounts() {
    if (fs.existsSync(ACCOUNTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('accounts.json must be a non-empty array of { email, pass, region? }');
        }
        return data.map(validateAccount);
    }

    const fromEnv = loadFromEnv();
    if (fromEnv.length === 0) {
        throw new Error(
            'No mail accounts found. Create accounts.json like:\n' +
            '  [ { "email": "you@gmail.com", "pass": "xxxx xxxx xxxx xxxx", "region": "usa" } ]\n' +
            'or set EMAIL_USER / EMAIL_PASS in .env'
        );
    }
    return fromEnv;
}

/**
 * Load accounts. If regionKey is set (usa|europe), only return accounts for that region.
 * Fallback: if no region fields match, use first half for usa / second half for europe.
 */
function loadAccounts(regionKey) {
    const all = loadAllAccounts();
    const key = (regionKey || '').toLowerCase();

    if (!key) {
        console.log(`[accounts] loaded ${all.length} account(s)`);
        return all;
    }

    let matched = all.filter(a => a.region === key);

    // Fallback by position: first 2 → usa, last 2 → europe (or first/second half)
    if (matched.length === 0) {
        const mid = Math.ceil(all.length / 2);
        matched = key === 'usa' ? all.slice(0, mid) : all.slice(mid);
        console.log(`[accounts] no region tags matched "${key}" — using positional split (${matched.length} account(s))`);
    } else {
        console.log(`[accounts] loaded ${matched.length} account(s) for region "${key}"`);
    }

    if (matched.length === 0) {
        throw new Error(`No mail accounts configured for region "${key}"`);
    }

    matched.forEach(a => console.log(`  • ${a.email}`));
    return matched;
}

module.exports = { loadAccounts, loadAllAccounts, normalizePass, ACCOUNTS_FILE };
