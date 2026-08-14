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
        apiName: top.name, // original GitHub name for API calls
        language: top.language || null,
        description: top.description || null,
        url: top.html_url || null,
    };
}

/**
 * Up to 2 non-noisy languages across the user's best non-fork/non-archived repos,
 * ordered by stars (same candidate set as pickSuitableRepo). Fallback when the
 * /languages endpoint was not fetched. Prefer languagesFromBreakdown when available.
 */
const NOISY_LANGUAGE = new Set(['jupyter notebook', 'html', 'css', 'shell', 'makefile', 'dockerfile']);

/**
 * From GET /repos/{owner}/{repo}/languages (byte map or sorted {name,bytes,pct}[]),
 * return up to `max` non-noisy language names by byte count — same signal as the sidebar.
 */
function languagesFromBreakdown(breakdown, max = 2) {
    let entries = [];
    if (Array.isArray(breakdown)) {
        entries = breakdown
            .map((x) => (typeof x === 'string' ? { name: x, bytes: 0 } : x))
            .filter((x) => x && x.name);
    } else if (breakdown && typeof breakdown === 'object') {
        entries = Object.entries(breakdown)
            .filter(([, bytes]) => typeof bytes === 'number' && bytes > 0)
            .map(([name, bytes]) => ({ name, bytes }));
        entries.sort((a, b) => b.bytes - a.bytes);
    }

    const langs = [];
    for (const e of entries) {
        const lang = String(e.name).trim();
        if (!lang || NOISY_LANGUAGE.has(lang.toLowerCase())) continue;
        if (!langs.includes(lang)) langs.push(lang);
        if (langs.length >= max) break;
    }
    return langs;
}

function repoLanguages(repos) {
    if (!Array.isArray(repos) || repos.length === 0) return [];

    const candidates = repos
        .filter(r => r && r.name && !r.fork && !r.archived)
        .map(r => ({ ...r, cleanName: cleanRepoName(r.name) }))
        .filter(r => r.cleanName);

    candidates.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));

    const langs = [];
    for (const r of candidates) {
        const lang = r.language && r.language.trim();
        if (!lang || NOISY_LANGUAGE.has(lang.toLowerCase())) continue;
        if (!langs.includes(lang)) langs.push(lang);
        if (langs.length >= 2) break;
    }
    return langs;
}

module.exports = { pickSuitableRepo, cleanRepoName, repoLanguages, languagesFromBreakdown };
