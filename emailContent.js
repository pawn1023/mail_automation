// emailContent.js — builds the outreach email.
// Body copy is unchanged from the original static mail in index.js; only the
// greeting and an optional "I looked at your repo X" line are personalized.

const SUBJECT = "I'm looking for a long-term partner";

// Everything from "I'm looking for a long-term partner." onward — verbatim, unchanged.
const BODY_TAIL = `<p>I'm looking for a long-term partner.</p>

<p>After eight years working as a software engineer, I realized something about myself: I love building things, but I don't enjoy selling myself.</p>

<p>Give me a difficult technical problem, a messy codebase, or a system that needs to be designed from scratch, and I can spend hours happily working on it. But put me in an HR interview, ask me to explain my value in a few minutes, or ask me to convince someone why an idea is worth pursuing, and suddenly I'm not playing my strongest game.</p>

<p>I've met many people who are the opposite. They might not want to spend their nights thinking about system architecture or debugging a difficult production issue, but they are naturally good at talking with people, understanding what others need, explaining ideas clearly, and building trust. And I think that's valuable.</p>

<p>The problem is that the industry often expects one person to be everything at once: an excellent engineer, a great communicator, a salesperson, a leader, and a relationship builder. Those people exist, but they are rare.</p>

<p>I've started thinking that maybe the better approach is not trying to become someone I'm not. Maybe the better approach is finding someone whose strengths complete mine.</p>

<p>I'm looking for someone who enjoys the parts I struggle with: talking to clients, creating opportunities, building relationships, and communicating ideas. In return, I bring eight years of experience designing software, building systems, and turning ideas into working products.</p>

<p>I don't think great companies are built by people who are good at everything. I think they're built by people who know what they are good at and find others who complement them.</p>

<p>If you feel like you have the opposite problem - you're great with people and opportunities but need someone who can build - I would love to talk.</p>
`;

const BAD_NAME = /(github|developer|engineer|dev|admin|test|user|null|undefined|http|www)/i;
const SKIP_FIRST_NAMES = new Set([
    'we', 'the', 'online', 'mr', 'mrs', 'ms', 'dr', 'sir', 'madam', 'team', 'official',
]);

/** Pull a natural first name for the greeting; skip handles / junk. */
function firstName(profile) {
    const raw = profile?.name;
    if (!raw || !raw.trim()) return null;
    const token = raw.trim().split(/\s+/)[0].replace(/[^A-Za-z\-']/g, '');
    if (token.length < 2 || token.length > 18) return null;
    if (/\d/.test(token)) return null;
    if (!/^[A-Za-z][A-Za-z\-']*$/.test(token)) return null;
    if (BAD_NAME.test(token)) return null;
    if (SKIP_FIRST_NAMES.has(token.toLowerCase())) return null;
    return token[0].toUpperCase() + token.slice(1);
}

function buildGreeting(profile) {
    const name = firstName(profile);
    return name ? `<p>Hi ${name},</p>` : `<p>Hi,</p>`;
}

function buildRepoLine(username, profile, repo) {
    if (!repo) return '';
    const profileUrl = profile?.html_url || `https://github.com/${username}`;
    const langPart = repo.language ? `, which uses ${repo.language}` : '';
    return `\n\n<p>I came across your GitHub profile (${profileUrl}) and took a look at your "${repo.name}" repository${langPart}.</p>`;
}

/**
 * @param {string} username
 * @param {object|null} profile - GitHub /users/:username response
 * @param {{name, language, description, url}|null} repo - from repoPicker.pickSuitableRepo
 * @returns {{ subject: string, html: string }}
 */
function buildEmail(username, profile, repo) {
    const greeting = buildGreeting(profile);
    const repoLine = buildRepoLine(username, profile, repo);
    const html = `${greeting}${repoLine}\n\n${BODY_TAIL}`;
    return { subject: SUBJECT, html };
}

module.exports = { buildEmail, SUBJECT };
