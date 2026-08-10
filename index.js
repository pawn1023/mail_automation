// index.js — daily budget crawl: resume queue → top up seeds lightly → send until cap
// Usage: node index.js usa | node index.js europe
// Designed for NO GitHub token (60 core req/hour). Run once per day; state persists.
require('./logger');
const fs   = require('fs');
const path = require('path');
const {
    getFollowers,
    getEmailForUser,
    getUserProfile,
    getOwnerRepos,
    discoverUsersByQueries,
    GitHubRateLimitError,
    HAS_TOKEN,
    MIN_REQUEST_INTERVAL_MS,
} = require('./githubFollowers');
const { getRegion, matchesRegion, listRegionKeys } = require('./regions');
const { loadAccounts } = require('./accounts');
const { MailPool } = require('./mailPool');
const { pickSuitableRepo } = require('./repoPicker');
const { buildEmail } = require('./emailContent');

// ── Config (daily / no-token friendly) ────────────────────────────────────────
const MAX_DEPTH = 2;                 // shallow DFS — enough for daily 60 sends
const SEARCH_PAGES_PER_QUERY = 1;    // 1 page (~100 users) per top-up
const QUERIES_PER_TOPUP = 1;         // rotate 1 location query per top-up
const QUEUE_REFILL_BELOW = 40;       // only search when queue is thin
const MAX_FOLLOWERS_QUEUE = 20;      // don't dump 100 followers onto the stack
const PER_ACCOUNT_SEND_LIMIT = 30;   // 30 × accounts.length mails / run
const LIMIT_SLEEP_MIN_MS = 11.5 * 60 * 60 * 1000;
const LIMIT_SLEEP_MAX_MS = 12.5 * 60 * 60 * 1000;

const SENT_FILE = path.join(__dirname, 'sent.json');

function visitedFileFor(regionKey) {
    return path.join(__dirname, `visited-${regionKey}.json`);
}
function queueFileFor(regionKey) {
    return path.join(__dirname, `queue-${regionKey}.json`);
}
function searchStateFileFor(regionKey) {
    return path.join(__dirname, `search-state-${regionKey}.json`);
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadSet(file) {
    if (!fs.existsSync(file)) return new Set();
    return new Set(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function saveSet(file, set) {
    fs.writeFileSync(file, JSON.stringify([...set], null, 2));
}

function loadQueue(file) {
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
}

function saveQueue(file, stack) {
    // Cap persisted queue size so the file stays manageable
    const trimmed = stack.slice(-500);
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2));
}

function loadSearchState(file, queryCount) {
    const day = Math.floor(Date.now() / 86400000); // UTC day number
    if (!fs.existsSync(file)) {
        return { day, queryIndex: day % Math.max(queryCount, 1) };
    }
    try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            day: s.day ?? day,
            queryIndex: typeof s.queryIndex === 'number' ? s.queryIndex : 0,
        };
    } catch {
        return { day, queryIndex: 0 };
    }
}

function saveSearchState(file, state) {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
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

function randomLimitSleep() {
    return LIMIT_SLEEP_MIN_MS + Math.floor(Math.random() * (LIMIT_SLEEP_MAX_MS - LIMIT_SLEEP_MIN_MS));
}

async function withGithubRateLimitRetry(fn) {
    while (true) {
        try {
            return await fn();
        } catch (err) {
            if (!(err instanceof GitHubRateLimitError)) throw err;

            const waitMs = Math.max(err.retryAfterMs + 5000, 60 * 1000);
            const mins = (waitMs / 60000).toFixed(1);
            console.log(`[crawler] ⛔ ${err.message} — sleeping ${mins} min before retrying...`);
            await delay(waitMs);
            console.log('[crawler] ▶  resuming after rate limit sleep');
        }
    }
}

/**
 * Top up the DFS stack only when thin.
 * Rotates through region.searchQueries one query at a time (daily-friendly).
 */
async function maybeTopUpSeeds(region, stack, visitedUsers, searchStatePath) {
    const pending = stack.filter(i => !visitedUsers.has(i.username)).length;
    if (pending >= QUEUE_REFILL_BELOW) {
        console.log(`[search] queue has ${pending} pending — skip search top-up`);
        return;
    }

    const queries = region.searchQueries;
    const state = loadSearchState(searchStatePath, queries.length);
    const today = Math.floor(Date.now() / 86400000);

    // Advance rotation once per calendar day
    if (state.day !== today) {
        state.queryIndex = (state.queryIndex + 1) % queries.length;
        state.day = today;
        console.log(`[search] new day → rotate to query index ${state.queryIndex}`);
    }

    const batch = [];
    for (let i = 0; i < QUERIES_PER_TOPUP; i++) {
        const idx = (state.queryIndex + i) % queries.length;
        batch.push(queries[idx]);
    }
    // Next top-up in the same day advances further if queue drains again
    state.queryIndex = (state.queryIndex + QUERIES_PER_TOPUP) % queries.length;
    saveSearchState(searchStatePath, state);

    console.log(`[search] topping up with: ${batch.join(' | ')} (1 page each)`);

    const seeds = await withGithubRateLimitRetry(() =>
        discoverUsersByQueries(batch, {
            maxPagesPerQuery: SEARCH_PAGES_PER_QUERY,
            exclude: visitedUsers,
            onPage: ({ query, page, count, totalCount }) => {
                console.log(`[search] ${query} page ${page}: +${count} (total≈${totalCount})`);
            },
        })
    );

    const existing = new Set(stack.map(i => i.username));
    let added = 0;
    for (let i = seeds.length - 1; i >= 0; i--) {
        const u = seeds[i];
        if (visitedUsers.has(u) || existing.has(u)) continue;
        stack.push({ username: u, depth: 0 });
        existing.add(u);
        added++;
    }
    console.log(`[search] ✅ added ${added} new seed(s); queue size ${stack.length}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run(region, mailPool) {
    const visitedPath     = visitedFileFor(region.key);
    const queuePath       = queueFileFor(region.key);
    const searchStatePath = searchStateFileFor(region.key);
    const sentEmails      = loadSet(SENT_FILE);
    const visitedUsers    = loadSet(visitedPath);
    const stack           = loadQueue(queuePath);

    console.log(`Mode          : daily budget (no GitHub token required)`);
    console.log(`API pacing    : ${MIN_REQUEST_INTERVAL_MS / 1000}s between GitHub calls` +
        (HAS_TOKEN ? ' (token detected)' : ' (unauthenticated 60/h)'));
    console.log(`Region        : ${region.label}`);
    console.log(`Traversal     : DFS depth≤${MAX_DEPTH}`);
    console.log(`Mail accounts : ${mailPool.accounts.length}`);
    console.log(`Per-account   : ${mailPool.perAccountLimit}/run (target ${mailPool.targetTotal()})`);
    console.log(`Queue loaded  : ${stack.length}`);
    console.log(`Already sent  : ${sentEmails.size}`);
    console.log(`Already visited: ${visitedUsers.size}\n`);

    await maybeTopUpSeeds(region, stack, visitedUsers, searchStatePath);
    saveQueue(queuePath, stack);

    if (stack.length === 0) {
        console.error('[search] queue empty and no new seeds — try again tomorrow (query rotates daily)');
        return;
    }

    let sent = 0;
    let failed = 0;
    let skippedLocation = 0;
    let runComplete = false;

    const remainingSendsNeeded = () => mailPool.targetTotal() - mailPool.totalSentThisRun();

    while (stack.length > 0) {
        if (mailPool.isRunComplete()) {
            runComplete = true;
            break;
        }

        // If queue got thin mid-run and we still need sends, top up once more
        const pending = stack.filter(i => !visitedUsers.has(i.username)).length;
        if (pending < 10 && remainingSendsNeeded() > 0) {
            await maybeTopUpSeeds(region, stack, visitedUsers, searchStatePath);
            saveQueue(queuePath, stack);
        }

        const { username, depth } = stack.pop();
        if (visitedUsers.has(username)) continue;

        console.log(`[crawler] DFS depth ${depth} — ${username} (queue: ${stack.length})`);

        let profile = null;
        try {
            profile = await withGithubRateLimitRetry(() => getUserProfile(username));
        } catch (err) {
            console.error(`[crawler] → error fetching profile for ${username}: ${err.message}`);
        }

        const profileLocation = profile?.location || null;
        const inRegion = matchesRegion(profileLocation, region);
        if (!inRegion) {
            skippedLocation++;
            console.log(`[crawler] → skip (location: ${profileLocation ?? 'n/a'} ≠ ${region.label})`);
            visitedUsers.add(username);
            saveSet(visitedPath, visitedUsers);
            saveQueue(queuePath, stack);
            continue;
        }

        console.log(`[crawler] → location OK: ${profileLocation}`);

        let repos = [];
        try {
            repos = await withGithubRateLimitRetry(() => getOwnerRepos(username, 6));
        } catch (err) {
            console.error(`[crawler] → error fetching repos for ${username}: ${err.message}`);
        }

        let email = null;
        try {
            // Reuse profile + repos — saves API calls
            email = await withGithubRateLimitRetry(() => getEmailForUser(username, profile, repos));
        } catch (err) {
            console.error(`[crawler] → error getting email for ${username}: ${err.message}`);
        }

        if (isRealEmail(email) && !sentEmails.has(email)) {
            const repo = pickSuitableRepo(repos);
            const { subject, html } = buildEmail(username, profile, repo);
            console.log(`[sender]  → sending to ${email}${repo ? ` (repo: "${repo.name}")` : ''}...`);
            try {
                await mailPool.sendWithFailover(email, subject, html);
                sentEmails.add(email);
                saveSet(SENT_FILE, sentEmails);
                sent++;
                console.log(`[sender]  ✅ sent (total this run: ${sent})`);

                if (mailPool.isRunComplete()) {
                    runComplete = true;
                    visitedUsers.add(username);
                    saveSet(visitedPath, visitedUsers);
                    saveQueue(queuePath, stack);
                    break;
                }
            } catch (err) {
                if (err.code === 'RUN_COMPLETE') {
                    runComplete = true;
                    console.log(`[sender]  ${err.message}`);
                    visitedUsers.add(username);
                    saveSet(visitedPath, visitedUsers);
                    saveQueue(queuePath, stack);
                    break;
                }
                console.error(`[sender]  ❌ failed: ${err.message}`);
                failed++;
            }
        } else if (email) {
            console.log(`[crawler] → skipped ${email} (already sent or noreply)`);
        } else {
            console.log(`[crawler] → no public email for ${username}`);
        }

        // Expand followers only if we still need more sends and queue isn't already fat
        const needMore = remainingSendsNeeded() > 0 && !mailPool.isRunComplete();
        if (needMore && depth < MAX_DEPTH && stack.length < QUEUE_REFILL_BELOW * 2) {
            try {
                const followers = await withGithubRateLimitRetry(() =>
                    getFollowers(username, MAX_FOLLOWERS_QUEUE)
                );
                const existing = new Set(stack.map(i => i.username));
                let queued = 0;
                for (let i = Math.min(followers.length, MAX_FOLLOWERS_QUEUE) - 1; i >= 0; i--) {
                    const follower = followers[i];
                    if (visitedUsers.has(follower) || existing.has(follower)) continue;
                    stack.push({ username: follower, depth: depth + 1 });
                    queued++;
                }
                console.log(`[crawler] → queued ${queued} follower(s) for DFS`);
            } catch (err) {
                console.error(`[crawler] → error fetching followers of ${username}: ${err.message}`);
            }
        }

        visitedUsers.add(username);
        saveSet(visitedPath, visitedUsers);
        saveQueue(queuePath, stack);
    }

    saveQueue(queuePath, stack);

    console.log(`\n[done] sent: ${sent}, failed: ${failed}, skipped(location): ${skippedLocation}`);
    console.log(`[done] queue saved: ${stack.length} user(s) for next run`);
    if (runComplete) {
        console.log(`[done] daily cap reached (${mailPool.perAccountLimit} each) — stop until tomorrow`);
        for (const a of mailPool.accounts) {
            console.log(`  • ${a.email}: ${mailPool.sentCount(a.email)}/${mailPool.perAccountLimit}`);
        }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────
const regionArg = (process.argv[2] || '').toLowerCase();
const region = getRegion(regionArg);

if (!region) {
    console.error(`Usage: node index.js <${listRegionKeys().join('|')}>`);
    console.error('  node index.js usa      — USA developers only');
    console.error('  node index.js europe   — Europe developers only');
    process.exit(1);
}

let accounts;
try {
    accounts = loadAccounts(region.key);
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

const mailPool = new MailPool(accounts, {
    delay,
    randomLimitSleep,
    perAccountLimit: PER_ACCOUNT_SEND_LIMIT,
});

run(region, mailPool).catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
