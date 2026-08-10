// repoPicker.js — pick a "suitable" repo from a user's public repos to reference in the email.
// Ported from Email send workflow/backend/app/services/{github,content}.py.

// Skip repo names that make the message sound fake or forced.
const BAD_REPO = /(github\.io|code[-_]?along|sprint|homework|assignment|eslint-config|dotfiles|\.github|profile|readme|test|demo|example|tutorial|boilerplate)/i;

function cleanRepoName(name) {
    if (!name || !String(name).trim()) return null;
    const raw = String(name).trim();
    if (raw.length > 28 || BAD_REPO.test(raw)) return null;
    if (/[a-z][A-Z].*[A-Z]/.test(raw)) return null; // skip noisy mixed-case spam names
    if (!/^[A-Za-z][A-Za-z0-9._-]{1,27}$/.test(raw)) return null;
    return raw;
}

/**
 * @param {Array<{name, fork, archived, language, stargazers_count, description, html_url}>} repos
 * @returns {{ name: string, language: string|null, description: string|null, url: string|null } | null}
 */
function pickSuitableRepo(repos) {
    if (!Array.isArray(repos) || repos.length === 0) return null;

    const candidates = repos
        .filter(r => r && r.name && !r.fork && !r.archived)
        .map(r => ({ ...r, cleanName: cleanRepoName(r.name) }))
        .filter(r => r.cleanName);

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
    const top = candidates[0];

    return {
        name: top.cleanName,
        language: top.language || null,
        description: top.description || null,
        url: top.html_url || null,
    };
}

module.exports = { pickSuitableRepo, cleanRepoName };
