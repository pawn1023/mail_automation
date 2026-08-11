// emailContent.js — writes the outreach email.
// Ported from Email send workflow/backend/app/services/content.py: fixed greeting/closing,
// 4 templated paragraphs picked per-send from seeded variants (login + repo/bio/language
// aware), a subject line picked from a matching set of variants, and an 800-char trim guard.
// No LLM involved — this mirrors the workflow app's approach exactly, just re-hosted in JS.

const crypto = require('crypto');
const { cleanRepoName, repoLanguages } = require('./repoPicker');

const CLOSING = 'Looking forward to hearing from you.\n\nBest Regards,';

/** mulberry32 — small deterministic PRNG seeded from a hash, good enough for variant picking. */
function makeRng(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** New random seed per send (mirrors content.py's secrets.token_hex(4) salt — not meant to be stable across resends). */
function rngFor(login) {
    const salt = crypto.randomBytes(4).toString('hex');
    const digest = crypto.createHash('sha256').update(`${String(login).toLowerCase()}|${salt}`).digest('hex');
    return makeRng(parseInt(digest.slice(0, 8), 16));
}

function pick(rng, options) {
    return options[Math.floor(rng() * options.length)];
}

function profileUrl(login, url) {
    return (url && url.trim()) || `https://github.com/${login}`;
}

function clip(text, n) {
    const flat = text.split(/\s+/).join(' ');
    if (flat.length <= n) return flat;
    return flat.slice(0, n - 1).trimEnd() + '...';
}

function displayUrl(url) {
    if (!url || !url.trim()) return null;
    let u = url.trim();
    for (const sep of ['?', '#']) {
        if (u.includes(sep)) u = u.split(sep)[0];
    }
    u = u.replace(/\/+$/, '');
    return u || null;
}

function langPhrase(langs) {
    if (!langs.length) return null;
    if (langs.length === 1) return langs[0];
    return `${langs[0]} and ${langs[1]}`;
}

function para1(rng, { profile, login, repo, langs }) {
    const langTxt = langPhrase(langs);

    if (repo && langTxt) {
        const showVerb = langTxt.includes(' and ') ? 'show' : 'shows';
        const beVerb = langTxt.includes(' and ') ? 'are' : 'is';
        return pick(rng, [
            `I looked at your GitHub profile (${profile}) and spent a little time with your public repository "${repo}", which appears to use ${langTxt}.`,
            `I was reading through public GitHub profiles and stopped at ${profile}. "${repo}" was one of the public repositories I opened, and ${langTxt} ${showVerb} up there.`,
            `Your GitHub at ${profile} led me to "${repo}". From what is public, ${langTxt} ${beVerb} part of that work.`,
        ]);
    }
    if (repo) {
        return pick(rng, [
            `I looked at your GitHub profile (${profile}) and opened your public repository "${repo}".`,
            `I came across ${profile} and took a look at "${repo}" among your public repositories.`,
        ]);
    }
    if (langTxt) {
        return pick(rng, [
            `I looked at your GitHub profile (${profile}). A good part of your public repositories use ${langTxt}.`,
            `I spent some time on your public GitHub at ${profile}. Much of what you publish there is in ${langTxt}.`,
            `While reviewing @${login} on GitHub (${profile}), I noticed your public work leans toward ${langTxt}.`,
        ]);
    }
    return pick(rng, [
        `I looked at your public GitHub profile at ${profile} (@${login}) and the repositories listed there.`,
        `I came across your GitHub profile (${profile}) and reviewed a few of the public repositories.`,
    ]);
}

function para2(rng, { portfolioUrl, bio }) {
    const site = displayUrl(portfolioUrl);
    if (site) {
        return pick(rng, [
            `I also opened the site linked from your profile (${site}).`,
            `Your profile links to ${site}, so I took a look there as well.`,
            `Besides GitHub, I checked the link on your profile: ${site}.`,
        ]);
    }
    if (bio && bio.trim() && bio.trim().length >= 12) {
        const snippet = clip(bio.trim(), 90);
        if (snippet.length >= 20) {
            return pick(rng, [
                `Your profile bio says: "${snippet}".`,
                `On your profile you note: "${snippet}".`,
            ]);
        }
    }
    return pick(rng, [
        'From the public repositories on your profile, the work looks thoughtfully put together.',
        'I went through a few of the public repositories listed on your profile.',
        'The public repositories on your profile gave a clear sense of the work you share.',
    ]);
}

function para3Question(rng, { repo, langs }) {
    const lang = langs[0] || null;

    if (repo && lang) {
        return pick(rng, [
            `What led you to use ${lang} for "${repo}"?`,
            `On "${repo}", what part of the ${lang} work do you spend the most time on?`,
            `How do you usually approach new features in "${repo}"?`,
        ]);
    }
    if (repo) {
        return pick(rng, [
            `What are you focusing on next with "${repo}"?`,
            `How did "${repo}" get started?`,
            `What has been the hardest part of maintaining "${repo}"?`,
        ]);
    }
    if (lang) {
        return pick(rng, [
            `In your public ${lang} work, what problem do you enjoy solving most?`,
            `What do you usually reach for first when starting a new ${lang} project?`,
            `Across your ${lang} repositories, what do you try to keep as simple as possible?`,
        ]);
    }
    return pick(rng, [
        'Of the repositories you keep public, which one are you most active on right now?',
        'What kind of work are you hoping to do more of over the next year?',
        'Which part of your public work are you most interested in developing further?',
    ]);
}

function para4Collab(rng) {
    return pick(rng, [
        'I would like to collaborate with you in the future and work together if that is something you are open to. A short reply is enough.',
        'I am interested in collaborating with you in the future and working together over time. Even a brief reply would be appreciated.',
        'I am writing to ask whether you would consider collaborating with me and working together in the future. A short reply either way is fine.',
        'If you are open to it, I would welcome collaborating with you in the future and building a working relationship over time. A brief reply works well.',
        'I would welcome the chance to collaborate with you on future work together. No long reply needed - a short note is welcome.',
    ]);
}

function cleanPara(text) {
    return text.split(/\s+/).join(' ').trim();
}

function assemble(p1, p2, p3, p4, limit = 800) {
    const greeting = 'Hi. How are you?';
    const paras = [p1, p2, p3, p4].map(cleanPara);

    const build = (parts) => `${greeting}\n\n${parts.join('\n\n')}\n\n${CLOSING}`;

    let body = build(paras);
    let guard = 0;
    while (body.length > limit && guard < 30) {
        let longestI = 0;
        for (let i = 1; i < paras.length; i++) {
            if (paras[i].length > paras[longestI].length) longestI = i;
        }
        if (paras[longestI].length <= 48) break;
        const cut = Math.max(40, paras[longestI].length - 24);
        paras[longestI] = paras[longestI].slice(0, cut).replace(/[ ,.;:]+$/, '') + '.';
        body = build(paras);
        guard++;
    }

    return body.replace(/\n{3,}/g, '\n\n').trimEnd();
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {string} username - GitHub login
 * @param {object|null} profile - GitHub /users/:username response
 * @param {{name, language, description, url}|null} topRepo - from repoPicker.pickSuitableRepo
 * @param {Array<object>|null} repos - full repo list, for language signal (repoPicker.repoLanguages)
 * @returns {{ subject: string, html: string }}
 */
function buildEmail(username, profile, topRepo, repos) {
    const rng = rngFor(username);
    const profileUrlStr = profileUrl(username, profile?.html_url);
    const repo = topRepo ? cleanRepoName(topRepo.name) : null;
    const langs = repoLanguages(repos || []);
    const bio = profile?.bio || null;
    const portfolio = profile?.blog || null;

    const p1 = para1(rng, { profile: profileUrlStr, login: username, repo, langs });
    const p2 = para2(rng, { portfolioUrl: portfolio, bio });
    const p3 = para3Question(rng, { repo, langs });
    const p4 = para4Collab(rng);

    const bodyText = assemble(p1, p2, p3, p4, 800);

    let subject;
    if (repo) {
        subject = pick(rng, [`Quick note - "${repo}"`, `About "${repo}"`, `@${username} / "${repo}"`]);
    } else if (langs.length) {
        subject = pick(rng, [`Your ${langs[0]} work`, `Note for @${username}`, `@${username} - quick note`]);
    } else {
        subject = pick(rng, [`Note for @${username}`, `@${username} - quick note`, 'Your GitHub profile']);
    }

    const safe = escapeHtml(bodyText).replace(/\n/g, '<br>');
    const html = `<p>${safe}</p>`;

    return { subject, html };
}

module.exports = { buildEmail };
