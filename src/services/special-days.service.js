// Special-days registry. Feeds the content planner with dates worth posting
// about. Three layers of input:
//   1. Universal public holidays from `date-holidays` (respects country).
//   2. Industry-specific awareness days from data/industry-days.json.
//   3. Business-specific dates added by the user (future: a DB table; for
//      now just a caller-supplied array).

const Holidays = require('date-holidays');
const INDUSTRY = require('./data/industry-days.json');

// Map a free-form industry string to one of our sector buckets. Falls back
// to 'default' so we always return something sensible.
function resolveSector(industry) {
  if (!industry) return 'default';
  const key = String(industry).toLowerCase().trim();
  if (INDUSTRY.industry_aliases[key]) return INDUSTRY.industry_aliases[key];
  // Partial match: if industry contains any alias keyword, use that
  for (const alias of Object.keys(INDUSTRY.industry_aliases)) {
    if (key.includes(alias)) return INDUSTRY.industry_aliases[alias];
  }
  return 'default';
}

function toIso(year, month, day) {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

function normalizeHoliday(h) {
  return {
    date:   h.date.slice(0, 10),
    name:   h.name,
    type:   h.type,          // public | bank | school | optional | observance
    source: 'country',
    tier:   h.type === 'public' ? 1 : (h.type === 'bank' ? 2 : 3),
  };
}

function industryDaysFor(year, month, sector) {
  const days = [];
  const tag = (list, source) => list.forEach((d) => {
    const [mm, dd] = d.date.split('-').map(Number);
    if (mm === month) {
      days.push({
        date:   toIso(year, mm, dd),
        name:   d.name,
        type:   d.duration === 'month' ? 'observance_month' : 'observance',
        source,
        tier:   d.tier || 3,
        movable: !!d.movable,
      });
    }
  });
  tag(INDUSTRY.universal || [], 'universal');
  tag((INDUSTRY.sectors && INDUSTRY.sectors[sector]) || [], `sector:${sector}`);
  // Always include sensible defaults too, de-duped by (date+name)
  tag((INDUSTRY.sectors && INDUSTRY.sectors.default) || [], 'default');
  return days;
}

/**
 * Get every date worth considering in a given month.
 * @param {object} opts
 * @param {number} opts.year
 * @param {number} opts.month               — 1..12
 * @param {string} [opts.country='GB']
 * @param {string} [opts.industry]          — business.industry string
 * @param {Array<{date, name, tier?}>} [opts.custom] — caller-supplied business dates
 *
 * @returns list sorted by date, with duplicates merged by date+name.
 */
function getSpecialDaysForMonth({ year, month, country = 'GB', industry, custom = [] }) {
  const holidays = (() => {
    try {
      const h = new Holidays(country);
      return (h.getHolidays(year) || [])
        .map(normalizeHoliday)
        .filter((x) => Number(x.date.slice(5, 7)) === month);
    } catch (err) {
      console.warn('[special-days] date-holidays failed for', country, err.message);
      return [];
    }
  })();

  const sector = resolveSector(industry);
  const industryDays = industryDaysFor(year, month, sector);

  const customDays = (custom || [])
    .filter((d) => d && d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .filter((d) => Number(d.date.slice(5, 7)) === month)
    .map((d) => ({
      date:   d.date,
      name:   d.name || 'Custom date',
      type:   'custom',
      source: 'business',
      tier:   d.tier || 1,
    }));

  // Dedupe by (date|name) — a New Year's Day might show up in both country
  // and default industry lists; keep one entry, merge sources.
  const map = new Map();
  const all = [...holidays, ...industryDays, ...customDays];
  for (const d of all) {
    const key = `${d.date}|${d.name.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...d, sources: [d.source] });
    } else {
      existing.tier = Math.min(existing.tier, d.tier);
      if (!existing.sources.includes(d.source)) existing.sources.push(d.source);
    }
  }
  const out = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { sector, country, month, year, days: out };
}

module.exports = { getSpecialDaysForMonth, resolveSector };
