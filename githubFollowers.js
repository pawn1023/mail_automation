const https = require('https');
require('dotenv').config();

// Core endpoints (users/repos/commits): unauth 60 req/h, auth 5000 req/h.
// Search endpoint has its own, much stricter limit: unauth 10 req/min, auth 30 req/min.
// Stay a bit under each ceiling so normal jitter doesn't trip secondary abuse detection.
const HAS_TOKEN = Boolean(process.env.GITHUB_TOKEN);
const MIN_REQUEST_INTERVAL_MS = HAS_TOKEN ? 750 : 65 * 1000;       // auth: ~4800/h < 5000/h cap
const SEARCH_MIN_REQUEST_INTERVAL_MS = HAS_TOKEN ? 2100 : 6500;    // auth: ~28/min < 30/min cap

let nextRequestAt = 0;
let nextSearchRequestAt = 0;

// If GitHub reports we're running low on quota, push the next request out to the reset time
// instead of waiting to get hit with a 403.
let coolDownUntil = 0;

function throttleCore() {
    const base = Math.max(Date.now(), nextRequestAt, coolDownUntil);
    const waitMs = Math.max(0, base - Date.now());
    nextRequestAt = base + MIN_REQUEST_INTERVAL_MS;
    return new Promise(resolve => setTimeout(resolve, waitMs));
}

function throttleSearch() {
    const base = Math.max(Date.now(), nextSearchRequestAt, coolDownUntil);
    const waitMs = Math.max(0, base - Date.now());
    nextSearchRequestAt = base + SEARCH_MIN_REQUEST_INTERVAL_MS;
    return new Promise(resolve => setTimeout(resolve, waitMs));
}

class GitHubRateLimitError extends Error {
    constructor(message, retryAfterMs) {
        super(message);
        this.name = 'GitHubRateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}

async function githubRequest(path) {
    const isSearch = path.startsWith('/search/');
    await (isSearch ? throttleSearch() : throttleCore());

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path,
            headers: {
                'User-Agent': 'mail-automation',
                'Accept': 'application/vnd.github.v3+json',
                ...(HAS_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
            },
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                // Running low on quota (e.g. shared with other tools using the same token)?
                // Cool down until reset instead of racing the limit down to a 403.
                const remaining = Number(res.headers['x-ratelimit-remaining']);
                const resetAt = Number(res.headers['x-ratelimit-reset']);
                if (Number.isFinite(remaining) && remaining <= 3 && Number.isFinite(resetAt)) {
                    coolDownUntil = Math.max(coolDownUntil, resetAt * 1000);
                }

                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    reject(new Error(`Failed to parse response: ${data}`));
                    return;
                }

                if (res.statusCode === 403 || res.statusCode === 429) {
                    const message = parsed.message || data;
                    if (/rate limit|abuse detection/i.test(message)) {
                        const retryAfterSec = Number(res.headers['retry-after']);
                        const resetAt = Number(res.headers['x-ratelimit-reset']);
                        const retryAfterMs = retryAfterSec
                            ? retryAfterSec * 1000
                            : resetAt
                                ? Math.max(0, resetAt * 1000 - Date.now())
                                : 60 * 60 * 1000; // default 1h when unauthenticated
                        reject(new GitHubRateLimitError(`GitHub API ${res.statusCode}: ${message}`, retryAfterMs));
                        return;
                    }
                }

                if (res.statusCode >= 400) {
                    reject(new Error(`GitHub API ${res.statusCode}: ${parsed.message || data}`));
                } else {
                    resolve(parsed);
                }
            });
        }).on('error', reject);
    });
}

async function getFollowers(username, perPage = 30) {
    console.log(`Fetching followers of "${username}"...`);
    const followers = await githubRequest(`/users/${username}/followers?per_page=${perPage}`);
    const logins = followers.map(f => f.login);
    return [...new Set(logins)];
}

async function getPublicRepos(username, perPage = 3) {
    const repos = await githubRequest(`/users/${username}/repos?per_page=${perPage}&sort=pushed`);
    return repos.map(r => r.name);
}

/** Full repo objects (name, fork, language, stars, description, url) — used to pick a repo to mention in the email. */
async function getOwnerRepos(username, perPage = 6) {
    const repos = await githubRequest(`/users/${username}/repos?per_page=${perPage}&sort=pushed&type=owner`);
    if (!Array.isArray(repos)) return [];
    return repos.map(r => ({
        name: r.name,
        fork: Boolean(r.fork),
        archived: Boolean(r.archived),
        language: r.language || null,
        stargazers_count: r.stargazers_count || 0,
        description: r.description || null,
        html_url: r.html_url || null,
    }));
}

/** Prefer list payload email — avoids a second commit-detail request. */
async function getAuthorEmailFromRepo(owner, repo) {
    const commits = await githubRequest(`/repos/${owner}/${repo}/commits?author=${owner}&per_page=1`);
    if (!Array.isArray(commits) || commits.length === 0) return null;
    return commits[0].commit?.author?.email ?? null;
}

async function getUserProfile(username) {
    return githubRequest(`/users/${username}`);
}

/**
 * Cheap email lookup. Pass an already-fetched profile (and/or repos, from getOwnerRepos)
 * to skip duplicate API calls. Order: profile.email → up to 3 non-fork repos (1 API call each).
 */
async function getEmailForUser(username, profile = null, repos = null) {
    if (profile?.email) return profile.email;

    if (!profile) {
        try {
            profile = await getUserProfile(username);
            if (profile.email) return profile.email;
        } catch {
            // fall through to repos
        }
    }

    if (!repos) {
        repos = await getOwnerRepos(username, 3);
    }
    const candidates = repos.filter(r => r && r.name && !r.fork).slice(0, 3);
    for (const repo of candidates) {
        const email = await getAuthorEmailFromRepo(username, repo.name);
        if (email) return email;
    }
    return null;
}

async function searchUsers(query, page = 1, perPage = 100) {
    const q = encodeURIComponent(query);
    const data = await githubRequest(`/search/users?q=${q}&per_page=${perPage}&page=${page}`);
    const items = Array.isArray(data.items) ? data.items : [];
    return {
        logins: items.map((u) => u.login).filter(Boolean),
        totalCount: data.total_count ?? 0,
    };
}

/**
 * Run several location queries and collect unique logins.
 */
async function discoverUsersByQueries(queries, options = {}) {
    const maxPagesPerQuery = options.maxPagesPerQuery ?? 1;
    const seen = new Set(options.exclude || []);
    const logins = [];

    for (const query of queries) {
        for (let page = 1; page <= maxPagesPerQuery; page++) {
            const { logins: pageLogins, totalCount } = await searchUsers(query, page);
            if (options.onPage) options.onPage({ query, page, count: pageLogins.length, totalCount });

            for (const login of pageLogins) {
                if (!seen.has(login)) {
                    seen.add(login);
                    logins.push(login);
                }
            }

            if (pageLogins.length === 0 || page * 100 >= Math.min(totalCount, 1000)) break;
        }
    }

    return logins;
}

module.exports = {
    getEmailForUser,
    getFollowers,
    getUserProfile,
    getPublicRepos,
    getOwnerRepos,
    searchUsers,
    discoverUsersByQueries,
    GitHubRateLimitError,
    HAS_TOKEN,
    MIN_REQUEST_INTERVAL_MS,
};
