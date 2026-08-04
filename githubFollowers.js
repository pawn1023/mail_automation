const https = require('https');
require('dotenv').config();

// No token → 60 core req/hour. Pace at ~1 req / 65s so we rarely hit 403.
// With token → 5000/h; 1 req/s is enough for secondary limits.
const HAS_TOKEN = Boolean(process.env.GITHUB_TOKEN);
const MIN_REQUEST_INTERVAL_MS = HAS_TOKEN ? 1000 : 65 * 1000;

let nextRequestAt = 0;

function throttle() {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    nextRequestAt = Date.now() + waitMs + MIN_REQUEST_INTERVAL_MS;
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
    await throttle();

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
 * Cheap email lookup. Pass an already-fetched profile to skip a duplicate /users call.
 * Order: profile.email → up to 3 recent repos (1 API call each).
 */
async function getEmailForUser(username, profile = null) {
    if (profile?.email) return profile.email;

    if (!profile) {
        try {
            profile = await getUserProfile(username);
            if (profile.email) return profile.email;
        } catch {
            // fall through to repos
        }
    }

    const repos = await getPublicRepos(username, 3);
    for (const repo of repos) {
        const email = await getAuthorEmailFromRepo(username, repo);
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
    searchUsers,
    discoverUsersByQueries,
    GitHubRateLimitError,
    HAS_TOKEN,
    MIN_REQUEST_INTERVAL_MS,
};
