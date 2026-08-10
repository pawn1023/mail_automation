// mailPool.js — rotate across Gmail accounts; per-run cap + daily quota / bad auth failover
const { sendEmail } = require('./sendEmail');

function isDailyLimitError(err) {
    const text = `${err.responseCode ?? ''} ${err.response ?? ''} ${err.message ?? ''}`.toLowerCase();
    return /daily user sending (quota|limit)|sending quota exceeded|too many messages/i.test(text);
}

function isAuthError(err) {
    const code = err.responseCode;
    const text = `${err.response ?? ''} ${err.message ?? ''}`.toLowerCase();
    return code === 535 || code === 534 || /invalid login|username and password not accepted|authentication failed|badcredentials/i.test(text);
}

/** Network/handshake hiccup — not the recipient's or account's fault, safe to retry elsewhere. */
function isTransientNetworkError(err) {
    const netCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ESOCKET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
    if (netCodes.has(err.code)) return true;
    return /connection timeout|greeting never received|socket close|timed out/i.test(err.message ?? '');
}

class MailPool {
    /**
     * @param {Array<{ email: string, pass: string }>} accounts
     * @param {{ delay: (ms: number) => Promise<void>, randomLimitSleep: () => number, perAccountLimit?: number }} helpers
     */
    constructor(accounts, helpers) {
        if (!accounts?.length) throw new Error('MailPool: need at least one account');
        this.accounts = accounts;
        this.delay = helpers.delay;
        this.randomLimitSleep = helpers.randomLimitSleep;
        this.perAccountLimit = helpers.perAccountLimit ?? 30;
        this.index = 0;
        /** @type {Map<string, number>} sends this run per account */
        this.sentCounts = new Map(accounts.map(a => [a.email, 0]));
        /** @type {Set<string>} hit per-run cap */
        this.capped = new Set();
        /** @type {Set<string>} emails that hit daily quota this cycle */
        this.exhausted = new Set();
        /** @type {Set<string>} emails with bad credentials — skip permanently this run */
        this.dead = new Set();
    }

    current() {
        return this.accounts[this.index];
    }

    sentCount(email) {
        return this.sentCounts.get(email) || 0;
    }

    totalSentThisRun() {
        let n = 0;
        for (const v of this.sentCounts.values()) n += v;
        return n;
    }

    targetTotal() {
        return this.accounts.length * this.perAccountLimit;
    }

    /** True when every account is capped, dead, or otherwise unusable for this run. */
    isRunComplete() {
        return this.accounts.every(
            a => this.capped.has(a.email) || this.dead.has(a.email)
        );
    }

    isAvailable(acc) {
        return (
            !this.exhausted.has(acc.email) &&
            !this.dead.has(acc.email) &&
            !this.capped.has(acc.email)
        );
    }

    /** Next account that can still send; null if none left right now. */
    pickAvailable() {
        const n = this.accounts.length;
        for (let i = 0; i < n; i++) {
            const idx = (this.index + i) % n;
            const acc = this.accounts[idx];
            if (this.isAvailable(acc)) {
                this.index = idx;
                return acc;
            }
        }
        return null;
    }

    usableCount() {
        return this.accounts.filter(a => this.isAvailable(a)).length;
    }

    recordSend(account) {
        const next = this.sentCount(account.email) + 1;
        this.sentCounts.set(account.email, next);
        console.log(
            `[sender]  📊 ${account.email}: ${next}/${this.perAccountLimit} this run ` +
            `(pool ${this.totalSentThisRun()}/${this.targetTotal()})`
        );
        if (next >= this.perAccountLimit) {
            this.capped.add(account.email);
            console.log(`[sender]  ✅ ${account.email} reached ${this.perAccountLimit} mails — done for this run`);
        }
    }

    /**
     * Send using an available account.
     * Stops the run (throws RunCompleteError conceptually via return null path) when all accounts
     * hit their per-run cap — caller should check isRunComplete().
     * On daily limit → mark exhausted, try next; if all daily-limited but not capped → sleep ~12h.
     */
    async sendWithFailover(to, subject, html) {
        const maxTransientRetries = this.accounts.length;
        let transientRetries = 0;

        while (true) {
            if (this.isRunComplete()) {
                const err = new Error(
                    `Run complete: each account reached ${this.perAccountLimit} sends ` +
                    `(${this.totalSentThisRun()}/${this.targetTotal()})`
                );
                err.code = 'RUN_COMPLETE';
                throw err;
            }

            const account = this.pickAvailable();

            if (!account) {
                // All capped or dead already handled above; remaining case = daily exhausted
                const allDeadOrCapped = this.accounts.every(
                    a => this.dead.has(a.email) || this.capped.has(a.email)
                );
                if (allDeadOrCapped) {
                    const err = new Error('No usable mail accounts left for this run');
                    err.code = 'RUN_COMPLETE';
                    throw err;
                }

                const waitMs = this.randomLimitSleep();
                console.log(
                    `[sender]  ⛔ all remaining account(s) hit daily limit — ` +
                    `sleeping ${(waitMs / 3600000).toFixed(1)}h before retrying ${to}...`
                );
                await this.delay(waitMs);
                this.exhausted.clear();
                this.index = 0;
                console.log(`[sender]  ▶  quota reset — resuming`);
                continue;
            }

            try {
                console.log(
                    `[sender]  → using ${account.email} ` +
                    `(${this.sentCount(account.email)}/${this.perAccountLimit}, ${this.usableCount()} usable)`
                );
                const info = await sendEmail(to, subject, html, account);
                this.recordSend(account);
                // Round-robin to next account after a successful send
                this.index = (this.index + 1) % this.accounts.length;
                return info;
            } catch (err) {
                if (isAuthError(err)) {
                    this.dead.add(account.email);
                    console.log(`[sender]  ⛔ auth failed for ${account.email} — skipping this account`);
                    this.index = (this.index + 1) % this.accounts.length;
                    continue;
                }

                if (isDailyLimitError(err)) {
                    this.exhausted.add(account.email);
                    console.log(
                        `[sender]  ⛔ daily limit on ${account.email} — ` +
                        `switching account (${this.usableCount()} left)`
                    );
                    this.index = (this.index + 1) % this.accounts.length;
                    continue;
                }

                if (isTransientNetworkError(err) && transientRetries < maxTransientRetries) {
                    transientRetries++;
                    console.log(
                        `[sender]  ⚠  network error on ${account.email} (${err.message}) — ` +
                        `retrying ${to} on next account (${transientRetries}/${maxTransientRetries})`
                    );
                    this.index = (this.index + 1) % this.accounts.length;
                    continue;
                }

                throw err;
            }
        }
    }
}

module.exports = { MailPool, isDailyLimitError, isAuthError };
