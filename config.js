// config.js — runtime settings (env, regions.js, CLI)
require('dotenv').config();

const DEFAULT_DAILY_SEND_LIMIT = 30;

function parseDailyLimit(value, label) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number.parseInt(String(value).trim(), 10);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${label} must be a non-negative integer (got "${value}")`);
    }
    return n;
}

/**
 * Resolve daily send cap for a region.
 * Priority: CLI override → DAILY_SEND_LIMIT_<REGION> env → regions.js dailySendLimit → DAILY_SEND_LIMIT env → 30
 *
 * @param {string} regionKey - e.g. "usa" | "europe"
 * @param {string|undefined} cliOverride - optional 3rd CLI arg
 */
function getDailySendLimit(regionKey, cliOverride) {
    const fromCli = parseDailyLimit(cliOverride, 'daily send limit (CLI arg)');
    if (fromCli !== null) return fromCli;

    if (regionKey) {
        const envKey = `DAILY_SEND_LIMIT_${String(regionKey).toUpperCase()}`;
        const fromRegionalEnv = parseDailyLimit(process.env[envKey], envKey);
        if (fromRegionalEnv !== null) return fromRegionalEnv;

        const { getRegion } = require('./regions');
        const region = getRegion(regionKey);
        if (region?.dailySendLimit !== undefined) {
            const fromRegion = parseDailyLimit(region.dailySendLimit, `${regionKey}.dailySendLimit`);
            if (fromRegion !== null) return fromRegion;
        }
    }

    const fromEnv = parseDailyLimit(process.env.DAILY_SEND_LIMIT, 'DAILY_SEND_LIMIT');
    if (fromEnv !== null) return fromEnv;

    return DEFAULT_DAILY_SEND_LIMIT;
}

module.exports = { getDailySendLimit, DEFAULT_DAILY_SEND_LIMIT };
