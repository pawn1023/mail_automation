// mailPool.js — rotate across Gmail accounts; daily run cap + SMTP quota / bad auth failover
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
     * @param {{ delay?: (ms: number) => Promise<void>, runLimit?: number }} helpers
     */
    constructor(accounts, helpers) {
        if (!accounts?.length) throw new Error('MailPool: need at least one account');
        this.accounts = accounts;
        this.runLimit = helpers.runLimit ?? 30;
        this.index = 0;
        /** @type {Map<string, number>} sends this run per account */
        this.sentCounts = new Map(accounts.map(a => [a.email, 0]));
        /** @type {Set<string>} emails that hit provider daily quota this cycle */
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
        return this.runLimit;
    }

    remainingSends() {
        return Math.max(0, this.runLimit - this.totalSentThisRun());
    }

    /** True when daily run cap is hit or every account is dead / provider-exhausted. */
    isRunComplete() {
        if (this.totalSentThisRun() >= this.runLimit) return true;
        return this.accounts.every(
            a => this.dead.has(a.email) || this.exhausted.has(a.email)
        );
    }

    allAccountsProviderLimited() {
        return this.accounts.length > 0 && this.accounts.every(a => this.exhausted.has(a.email));
    }

    allAccountsDead() {
        return this.accounts.length > 0 && this.accounts.every(a => this.dead.has(a.email));
    }

    runCompleteError() {
        const err = new Error('Run complete');
        err.code = 'RUN_COMPLETE';

        if (this.totalSentThisRun() >= this.runLimit) {
            err.message =
                `Run complete: daily cap of ${this.runLimit} reached ` +
                `(${this.totalSentThisRun()}/${this.runLimit})`;
        } else if (this.allAccountsProviderLimited()) {
            err.message =
                'Run complete: all accounts hit Google daily sending limit — stop until tomorrow';
        } else if (this.allAccountsDead()) {
            err.message = 'Run complete: all accounts failed authentication';
        } else {
            err.message = 'Run complete: no usable mail accounts left for today';
        }

        return err;
    }

    isAvailable(acc) {
        return !this.exhausted.has(acc.email) && !this.dead.has(acc.email);
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
        const total = this.totalSentThisRun();
        console.log(
            `[sender]  📊 ${account.email}: ${next} this run ` +
            `(pool ${total}/${this.runLimit})`
        );
        if (total >= this.runLimit) {
            console.log(`[sender]  ✅ daily cap reached (${this.runLimit} mails) — done for today`);
        }
    }

    /**
     * Send using an available account.
     * Stops when runLimit is hit, all accounts hit Google daily limit, or all accounts fail auth.
     */
    async sendWithFailover(to, subject, html) {
        const maxTransientRetries = this.accounts.length;
        let transientRetries = 0;

        while (true) {
            if (this.isRunComplete()) {
                throw this.runCompleteError();
            }

            const account = this.pickAvailable();
            if (!account) {
                throw this.runCompleteError();
            }

            try {
                console.log(
                    `[sender]  → using ${account.email} ` +
                    `(${this.sentCount(account.email)} sent, ${this.usableCount()} usable, ` +
                    `${this.remainingSends()} left today)`
                );
                const info = await sendEmail(to, subject, html, account);
                this.recordSend(account);
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
                        `[sender]  ⛔ Google daily limit on ${account.email} — ` +
                        `switching account (${this.usableCount()} left)`
                    );
                    this.index = (this.index + 1) % this.accounts.length;
                    if (this.allAccountsProviderLimited()) {
                        console.log('[sender]  ⛔ all accounts limited by Google — stopping for today');
                        throw this.runCompleteError();
                    }
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
