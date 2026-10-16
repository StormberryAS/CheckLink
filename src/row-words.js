// CheckLink: the words of a part's row that the page derives from the engine's analysis.
// Pure ES module with no DOM dependencies, shared by app.js and the browser tests, so both
// read a row the same way.
//
//   whoFor(part)     who learns what the part tells, for the line "Who learns it: {who}"
//   rowLabel(part)   the part's label without the name that line already gives
//   sameKind(a, b)   true when row b would repeat row a's label and explanation word for word

/** @typedef {import('./link-core.js').Part} Part */
// Who learns what a part tells, by the rule's family. Families that already name one company
// (Google, Meta, Amazon) are used as they are.
/** @type {Record<string, string>} */
export const WHO = {
  'Email and marketing automation': "the sender's email service",
  'Affiliate networks': 'the affiliate network',
  'Nordic shops and networks': 'the shop and its affiliate network',
  'Mobile attribution (Adjust)': 'Adjust',
  'Mobile attribution (AppsFlyer)': 'AppsFlyer',
  'Mobile attribution (Branch)': 'Branch',
  'Campaign tags (any sender)': 'the site and whoever sent the link',
  'Social networks (generic tags)': 'the site and the social network',
  'Ad networks': 'the ad network',
  'Music smart links (Linkfire)': 'Linkfire',
  'Disney+ and HBO Max': 'the streaming service',
  'Other social': 'the social network',
  'Web servers': 'the site',
  'X (Twitter)': 'X',
  Matomo: "the site's analytics (Matomo)",
  SearXNG: 'whoever runs this SearXNG server',
};

/**
 * @param {Part} p
 * @returns {string}
 */
// A null family looks up the key 'null', which WHO does not hold.
export const whoFor = (p) => WHO[/** @type {string} */ (p.family)] || p.family || 'the site';

// Interface review of batch 3, finding 6: the engine name was said three times in one row
// (label, "Who learns it" and explanation). When the label starts with the name the "Who
// learns it" line gives, that name goes, and so does a "Search" straight after it: under
// "Who learns it: Google", "Google Search session value" reads "Session value" and under
// YouTube, "YouTube share ID" reads "Share ID". A label that is only that name is dropped
// (an empty string), because the other lines already say it.
/**
 * @param {Part} p
 * @returns {string}
 */
export function rowLabel(p) {
  const label = p.provider || '';
  const who = whoFor(p);
  let rest = null;
  if (label === who) rest = '';
  else if (label.startsWith(`${who} `)) rest = label.slice(who.length + 1);
  if (rest === null) return label;
  if (rest === 'Search') rest = '';
  else if (rest.startsWith('Search ')) rest = rest.slice(7);
  return rest ? rest[0].toUpperCase() + rest.slice(1) : '';
}

// Row b says nothing row a has not just said: the same label, the same "Who learns it" and
// the same explanation (Baidu's six search-statistics values in a row). Wrappers, the address
// disguise and empty parts are never folded.
/**
 * @param {Part | null | undefined} a
 * @param {Part | null | undefined} b
 * @returns {boolean}
 */
export function sameKind(a, b) {
  if (!a || !b) return false;
  for (const p of [a, b]) if (p.where === 'wrapper' || p.where === 'userinfo' || p.empty) return false;
  return !!b.reveals && a.reveals === b.reveals && rowLabel(a) === rowLabel(b) && whoFor(a) === whoFor(b) && !a.affiliate && !b.affiliate;
}
