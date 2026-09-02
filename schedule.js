// schedule.js — wait until regional send time (8:00 AM local) using Intl (no extra deps)

/** @returns {{ year, month, day, hour, minute, second }} */
function zonedParts(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const out = {};
    for (const p of fmt.formatToParts(date)) {
        if (p.type !== 'literal') out[p.type] = p.value;
    }
    return out;
}

function formatZonedTime(date, timeZone) {
    const p = zonedParts(date, timeZone);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Calendar day key (YYYY-MM-DD) in the given IANA timezone. */
function todayKeyInZone(timeZone, date = new Date()) {
    const p = zonedParts(date, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
}

/** True when local clock is in the send hour (e.g. 08:00–08:59). */
function isInSendHour(timeZone, sendHour = 8) {
    const p = zonedParts(new Date(), timeZone);
    return Number(p.hour) === sendHour;
}

/**
 * Milliseconds until the next send window (default 08:00) in timeZone.
 * If local time is already at or past that hour today, returns 0 (send now).
 */
function msUntilSendTime(timeZone, sendHour = 8, sendMinute = 0) {
    const now = Date.now();
    const cur = zonedParts(new Date(now), timeZone);
    const curH = Number(cur.hour);
    const curM = Number(cur.minute);

    if (curH > sendHour || (curH === sendHour && curM >= sendMinute)) {
        return 0;
    }

    for (let offset = 0; offset <= 24 * 60 * 60 * 1000; offset += 1000) {
        const p = zonedParts(new Date(now + offset), timeZone);
        if (Number(p.hour) === sendHour && Number(p.minute) === sendMinute) {
            return offset;
        }
    }

    return 0;
}

/**
 * Shortest wait until 08:00 among several regions.
 * @param {Array<{ timeZone: string, sendHour?: number }>} regions
 */
function msUntilNextRegionSendTime(regions) {
    if (!regions?.length) return 0;
    let min = Infinity;
    for (const region of regions) {
        const ms = msUntilSendTime(region.timeZone, region.sendHour ?? 8, 0);
        min = Math.min(min, ms);
    }
    return Number.isFinite(min) ? min : 0;
}

async function waitUntilSendTime(timeZone, sendHour, delay) {
    const waitMs = msUntilSendTime(timeZone, sendHour, 0);
    const label = `${String(sendHour).padStart(2, '0')}:00`;

    if (waitMs === 0) {
        console.log(
            `[schedule] local time is ${formatZonedTime(new Date(), timeZone)} (${timeZone}) — ` +
            `at or past ${label}, sending now`
        );
        return;
    }

    const target = new Date(Date.now() + waitMs);
    console.log(
        `[schedule] local time is ${formatZonedTime(new Date(), timeZone)} (${timeZone}) — ` +
        `waiting ${(waitMs / 60000).toFixed(1)} min until ${label} ` +
        `(~${formatZonedTime(target, timeZone)})`
    );
    await delay(waitMs);
    console.log(`[schedule] ▶  ${label} reached — starting sends`);
}

/**
 * Wait until at least one region reaches its send hour (e.g. 08:00 local).
 * @param {Array<{ key: string, label: string, timeZone: string, sendHour?: number }>} regions
 */
async function waitUntilAnyRegionSendTime(regions, delay) {
    const waitMs = msUntilNextRegionSendTime(regions);
    const sendHour = regions[0]?.sendHour ?? 8;
    const label = `${String(sendHour).padStart(2, '0')}:00`;

    const readyNow = regions.filter(r => msUntilSendTime(r.timeZone, r.sendHour ?? 8, 0) === 0);
    if (readyNow.length > 0) {
        const names = readyNow.map(r => `${r.label} (${r.timeZone})`).join(', ');
        console.log(`[schedule] send window open for: ${names} — starting now`);
        return readyNow;
    }

    const next = regions.reduce((best, r) => {
        const ms = msUntilSendTime(r.timeZone, r.sendHour ?? 8, 0);
        return ms < best.ms ? { region: r, ms } : best;
    }, { region: regions[0], ms: Infinity });

    const target = new Date(Date.now() + waitMs);
    console.log(
        `[schedule] waiting ${(waitMs / 60000).toFixed(1)} min until ${label} ` +
        `in ${next.region.label} (~${formatZonedTime(target, next.region.timeZone)})`
    );
    await delay(waitMs);
    console.log(`[schedule] ▶  ${label} reached for ${next.region.label} — starting sends`);

    return regions.filter(r => msUntilSendTime(r.timeZone, r.sendHour ?? 8, 0) === 0);
}

module.exports = {
    zonedParts,
    formatZonedTime,
    todayKeyInZone,
    msUntilSendTime,
    msUntilNextRegionSendTime,
    waitUntilSendTime,
    waitUntilAnyRegionSendTime,
};
