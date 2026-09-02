// regions.js — country filters for GitHub user discovery
// Locations are free-text on GitHub, so we search several spellings and fuzzy-match profiles.

const REGIONS = {
    usa: {
        key: 'usa',
        label: 'USA',
        timeZone: 'America/New_York',
        sendHour: 8,
        dailySendLimit: 30, // optional — override with DAILY_SEND_LIMIT_USA or CLI
        // Queries fed to GitHub Search API (type:user implied by /search/users)
        searchQueries: [
            'location:"United States"',
            'location:USA',
            'location:"United States of America"',
            'location:"New York"',
            'location:"San Francisco"',
            'location:"Los Angeles"',
            'location:"Seattle"',
            'location:"Austin"',
            'location:"Chicago"',
            'location:"Boston"',
        ],
        // Profile.location must match at least one of these (case-insensitive)
        locationPatterns: [
            /\bunited states\b/i,
            /\bunited states of america\b/i,
            /\bUSA\b/i,
            /\bU\.S\.A\.?\b/i,
            /\bU\.S\.?\b/i,
            /\bUS\b/,
            // Common US state abbreviations / names people put alone
            /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/,
            /\b(California|Texas|Florida|Washington|Oregon|Illinois|Massachusetts|Pennsylvania|Colorado|Georgia|Virginia|Michigan|Ohio|Arizona|Nevada|New York|New Jersey)\b/i,
            /\b(San Francisco|Los Angeles|Seattle|Austin|Chicago|Boston|Denver|Atlanta|Portland|Miami|Dallas|Houston|NYC|SF Bay)\b/i,
        ],
    },

    europe: {
        key: 'europe',
        label: 'Europe',
        timeZone: 'Europe/Berlin',
        sendHour: 8,
        dailySendLimit: 30, // optional — override with DAILY_SEND_LIMIT_EUROPE or CLI
        searchQueries: [
            'location:Germany',
            'location:France',
            'location:"United Kingdom"',
            'location:UK',
            'location:England',
            'location:Netherlands',
            'location:Spain',
            'location:Italy',
            'location:Poland',
            'location:Sweden',
            'location:Norway',
            'location:Denmark',
            'location:Finland',
            'location:Belgium',
            'location:Switzerland',
            'location:Austria',
            'location:Portugal',
            'location:Ireland',
            'location:Romania',
            'location:Czech',
            'location:Berlin',
            'location:London',
            'location:Paris',
            'location:Amsterdam',
        ],
        locationPatterns: [
            /\b(Germany|France|United Kingdom|Great Britain|England|Scotland|Wales|Netherlands|Holland|Spain|Italy|Poland|Sweden|Norway|Denmark|Finland|Belgium|Switzerland|Austria|Portugal|Ireland|Romania|Czech|Czechia|Hungary|Greece|Ukraine|Bulgaria|Croatia|Serbia|Slovakia|Slovenia|Lithuania|Latvia|Estonia|Iceland|Luxembourg|Malta|Cyprus)\b/i,
            /\b(Deutschland|UK|GB|NL|EU)\b/i,
            /\b(Berlin|Munich|Hamburg|Frankfurt|Paris|Lyon|London|Manchester|Amsterdam|Rotterdam|Madrid|Barcelona|Rome|Milan|Warsaw|Krakow|Stockholm|Oslo|Copenhagen|Helsinki|Brussels|Zurich|Vienna|Lisbon|Dublin|Bucharest|Prague|Budapest|Athens|Kyiv|Kiev)\b/i,
        ],
    },
};

function getRegion(name) {
    const key = String(name || '').trim().toLowerCase();
    return REGIONS[key] || null;
}

function matchesRegion(location, region) {
    if (!location || typeof location !== 'string') return false;
    const loc = location.trim();
    if (!loc) return false;
    return region.locationPatterns.some((re) => re.test(loc));
}

function listRegionKeys() {
    return Object.keys(REGIONS);
}

module.exports = { REGIONS, getRegion, matchesRegion, listRegionKeys };
