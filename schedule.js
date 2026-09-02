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

module.exports = {
    zonedParts,
    formatZonedTime,
    todayKeyInZone,
    msUntilSendTime,
    waitUntilSendTime,
};
