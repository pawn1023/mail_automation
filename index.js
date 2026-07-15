// index.js  —  single sequential loop: find github id → extract mail → check new/old → send
require('./logger'); // tee all console output to log.log
const fs   = require('fs');
const path = require('path');
const { getFollowers, getEmailForUser, GitHubRateLimitError } = require('./githubFollowers');
const { sendEmail } = require('./sendEmail');

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_DEPTH        = 2;
const SEND_DELAY_MIN_MS = 5 * 60 * 1000;
const SEND_DELAY_MAX_MS = 8 * 60 * 1000;
const LIMIT_SLEEP_MIN_MS = 11.5 * 60 * 60 * 1000; // ~12h, jittered
const LIMIT_SLEEP_MAX_MS = 12.5 * 60 * 60 * 1000;

const SENT_FILE    = path.join(__dirname, 'sent.json');
const VISITED_FILE = path.join(__dirname, 'visited.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadSet(file) {
    if (!fs.existsSync(file)) return new Set();
    return new Set(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function saveSet(file, set) {
    fs.writeFileSync(file, JSON.stringify([...set], null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isRealEmail(email) {
    if (!email) return false;
    if (email.endsWith('@users.noreply.github.com')) return false;
    return true;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomSendDelay() {
    return SEND_DELAY_MIN_MS + Math.floor(Math.random() * (SEND_DELAY_MAX_MS - SEND_DELAY_MIN_MS));
}

function randomLimitSleep() {
    return LIMIT_SLEEP_MIN_MS + Math.floor(Math.random() * (LIMIT_SLEEP_MAX_MS - LIMIT_SLEEP_MIN_MS));
}

// Gmail SMTP signals the daily sending quota via a 550/452 response mentioning the quota
function isDailyLimitError(err) {
    const text = `${err.responseCode ?? ''} ${err.response ?? ''} ${err.message ?? ''}`.toLowerCase();
    return /daily user sending (quota|limit)|sending quota exceeded|too many messages/i.test(text);
}

// Runs a GitHub API call, and if it hits rate-limit/abuse-detection, sleeps for
// as long as GitHub says to (Retry-After / X-RateLimit-Reset) and retries.
async function withGithubRateLimitRetry(fn) {
    while (true) {
        try {
            return await fn();
        } catch (err) {
            if (!(err instanceof GitHubRateLimitError)) throw err;

            const waitMs = err.retryAfterMs + 5000; // small buffer past the reset
            console.log(`[crawler] ⛔ ${err.message} — sleeping ${Math.round(waitMs / 1000)}s before retrying...`);
            await delay(waitMs);
            console.log('[crawler] ▶  resuming after rate limit sleep');
        }
    }
}

// Sends, but if Gmail reports the daily quota is hit, sleeps ~12h and retries the same email
async function sendWithLimitRetry(email, subject, html) {
    while (true) {
        try {
            return await sendEmail(email, subject, html);
        } catch (err) {
            if (!isDailyLimitError(err)) throw err;

            const waitMs = randomLimitSleep();
            console.log(`[sender]  ⛔ daily sending limit hit — sleeping ${(waitMs / 3600000).toFixed(1)}h before retrying ${email}...`);
            await delay(waitMs);
            console.log(`[sender]  ▶  resuming — retrying ${email}`);
        }
    }
}

// ── Main loop: crawl one user → get email → check new → send → delay → repeat ─
async function run(seedUsername, subject, html) {
    const sentEmails   = loadSet(SENT_FILE);
    const visitedUsers = loadSet(VISITED_FILE);

    console.log(`Seed user     : ${seedUsername}`);
    console.log(`Max depth     : ${MAX_DEPTH}`);
    console.log(`Emails sent   : ${sentEmails.size} on record`);
    console.log(`Users visited : ${visitedUsers.size} on record\n`);

    let sent   = 0;
    let failed = 0;
    const queue = [{ username: seedUsername, depth: 0 }];

    while (queue.length > 0) {
        const { username, depth } = queue.shift();

        if (visitedUsers.has(username)) continue;

        console.log(`[crawler] depth ${depth} — ${username}`);

        // 1+2. Find github id (already have it) → extract mail from commit
        let email = null;
        try {
            email = await withGithubRateLimitRetry(() => getEmailForUser(username));
        } catch (err) {
            console.error(`[crawler] → error getting email for ${username}: ${err.message}`);
        }

        // 3. Check its new or old
        if (isRealEmail(email) && !sentEmails.has(email)) {
            // 4. Send mail
            console.log(`[sender]  → sending to ${email}...`);
            try {
                await sendWithLimitRetry(email, subject, html);
                sentEmails.add(email);
                saveSet(SENT_FILE, sentEmails);
                sent++;
                console.log(`[sender]  ✅ sent (total: ${sent})`);

                const waitMs = randomSendDelay();
                console.log(`[sender]  ⏳ waiting ${Math.round(waitMs / 1000)}s before next mail...`);
                await delay(waitMs);
            } catch (err) {
                console.error(`[sender]  ❌ failed: ${err.message}`);
                failed++;
            }
        } else if (email) {
            console.log(`[crawler] → skipped ${email} (already sent)`);
        }

        // Expand followers
        if (depth < MAX_DEPTH) {
            try {
                const followers = await withGithubRateLimitRetry(() => getFollowers(username));
                for (const follower of followers) {
                    if (!visitedUsers.has(follower)) {
                        queue.push({ username: follower, depth: depth + 1 });
                    }
                }
            } catch (err) {
                console.error(`[crawler] → error fetching followers of ${username}: ${err.message}`);
            }
        }

        // Only mark as visited once this user is fully processed — mirrors sent.json's
        // "persist on success" so a crash mid-run doesn't permanently skip a half-done user.
        visitedUsers.add(username);
        saveSet(VISITED_FILE, visitedUsers);
    }

    console.log(`\n[done] sent: ${sent}, failed: ${failed}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
const seedUsername = process.argv[2];
if (!seedUsername) {
    console.error('Usage: node index.js <seed-github-username>');
    process.exit(1);
}

const SUBJECT = "Looking for Good Partner like you";
const HTML = `
Test github automation mail
`

run(seedUsername, SUBJECT, HTML).catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
