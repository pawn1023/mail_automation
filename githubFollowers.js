const https = require('https');
require('dotenv').config();

// GitHub's unauthenticated rate limit is 60 req/h and triggers abuse-detection
// almost immediately if requests fire back-to-back. A GITHUB_TOKEN (set in .env)
// raises that to 5000 req/h; the throttle below keeps us under the ~1 req/s
// secondary rate limit either way.
const MIN_REQUEST_INTERVAL_MS = 1000;
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
                ...(process.env.GITHUB_TOKEN ? { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } : {})
            }
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
                                : 60 * 1000;
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

async function getFollowers(username) {
    console.log(`Fetching followers of "${username}"...`);
    const followers = await githubRequest(`/users/${username}/followers?per_page=100`);
    const logins = followers.map(f => f.login);
    return [...new Set(logins)]; // remove duplicates
}

async function getPublicRepos(username) {
    const repos = await githubRequest(`/users/${username}/repos?per_page=10&sort=pushed`);
    return repos.map(r => r.name);
}

async function getAuthorEmailFromRepo(owner, repo) {
    // Step 1: get a commit SHA authored by the repo owner
    const commits = await githubRequest(`/repos/${owner}/${repo}/commits?author=${owner}&per_page=1`);
    if (!Array.isArray(commits) || commits.length === 0) return null;

    const sha = commits[0].sha;
    if (!sha) return null;

    // Step 2: fetch full commit detail by SHA → commit.author.email is the real email
    // https://api.github.com/repos/{owner}/{repo}/commits/{commit_sha}
    const detail = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
    return detail.commit?.author?.email ?? null;
}

async function getProfileEmail(username) {
    const profile = await githubRequest(`/users/${username}`);
    return profile.email ?? null;
}

async function getEmailForUser(username) {
    // 1. Try commit author email from repos
    const repos = await getPublicRepos(username);
    for (const repo of repos) {
        const email = await getAuthorEmailFromRepo(username, repo);
        if (email) return email;
    }

    // 2. Fall back to public profile email
    return await getProfileEmail(username);
}

async function getFollowerEmails(username) {
    const followers = await getFollowers(username);
    console.log(`Found ${followers.length} follower(s)\n`);

    const results = [];

    for (const follower of followers) {
        try {
            const email = await getEmailForUser(follower);
            results.push({ username: follower, email });
            console.log(`  ${follower}: ${email ?? '(no email found)'}`);
        } catch (err) {
            console.error(`  ${follower}: error — ${err.message}`);
            results.push({ username: follower, email: null });
        }
    }

    return results;
}

module.exports = { getFollowerEmails, getEmailForUser, getFollowers, GitHubRateLimitError };

// Run directly: node githubFollowers.js <github-username>
if (require.main === module) {
    const targetUser = process.argv[2];
    if (!targetUser) {
        console.error('Usage: node githubFollowers.js <github-username>');
        process.exit(1);
    }

    getFollowerEmails(targetUser).then(results => {
        const withEmail = results.filter(r => r.email);
        console.log(`\n=== Summary ===`);
        console.log(`Total followers: ${results.length}`);
        console.log(`Emails found:    ${withEmail.length}`);
        console.log('\n--- Emails ---');
        withEmail.forEach(r => console.log(`${r.username}: ${r.email}`));
    }).catch(err => {
        console.error('Fatal:', err.message);
        process.exit(1);
    });
}
