// CheckLink engine: finds a link in text, says what each part of it tells others, and
// builds the clean link. Pure ES module with no DOM dependencies; it runs in browsers and
// in Node 24, and it never makes a network request.
//
//   analyse(input)            the full analysis of the first web link in the text (see below)
//   findLinks(text)           { links: [{ link, start, end, bare }], unreadable: [string] }
//   splitLink(link, bare)     positions of the authority, path, query and fragment
//   hostMatches(host, pat)    a provider host pattern ("facebook.com", "amazon.*", "*")
//   pctDecode(text)           percent-decoding that never throws
//   invisibleChunks(text)     text split into ordinary runs and single invisible or
//                             direction-changing characters: [{ text, invisible, label }]
//   clockTime(value)          a start time as written in a link (354, 1h2m3s) as 5:54 or
//                             1:02:03, or null
//   reportMail(analysis, removedIds)  the mailto: address for "Did CheckLink break your
//                             link? Email us" (see below)
//   personalReasons(analysis, removedIds)  that line's test of what is personal in the link as
//                             written and in the clean link (stage 4b)
//   heldReason(analysis, removedIds)  why Share is held back for the clean link, or null
//   RULES_DATE, RULES_VERSION
//
// The clean link is always the link's own text with the removed parts cut out. It is
// never rebuilt through URL or URLSearchParams, which would re-encode + and %20, turn
// international names into their xn-- form and break signed links. new URL() is used only
// to learn the real host, the way a browser reads it.
//
// analyse(input) returns:
// {
//   found: boolean,               a web link was found
//   kind: 'web' | 'script' | 'none',
//   input: string,                the text as given
//   link: string | null,          the first link exactly as written
//   start, end: number,           its position in input (-1 when not found)
//   bare: boolean,                written without a scheme (www.example.no)
//   prefix: '' | 'https://',      put in front of the link as written before opening it
//                                 (only right for the outer layer: use openUrl for a choice)
//   others: string[],             any further links in the text, as written
//   host, hostAsWritten,          where the clean link goes: the URL() host of the innermost
//                                 address, and that host as written (wrappers[0].host is the outer)
//   segments: Segment[],          covers link exactly: [{ text, removed, partId }]
//   segmentsFor(removedIds),      the same for any choice of removed parts
//   target: { link, host, hostAsWritten, segments, segmentsFor },  the innermost address
//   wrappers: [{ depth, id, label, family, link, host, note, partId, segments }],
//   parts: Part[],                every part that can be removed, in order
//   kept: Kept[],                 parts kept on purpose, because the page needs them
//   maps: null | { context: [{ kind: 'category' | 'place', name }], pin: null | { lat, lng, link },
//                  place: null | { featureId, cid, link } },
//                                 on a Google Maps place link whose data= carries context
//   untouched: null | { id, reason, name, text },
//   shortLink: null | { id, service, label, host, kind, note },
//   offer: null | { id, label, link },
//   hidden: [{ where, name, shownName, link, host, sameHost, kept, text, analysis }],  text is
//                                 the value as written; kept is true when the page needs that
//                                 parameter; shownName is name as the page's sentences show it
//   warnings: [{ id, tier: 'stop' | 'check' | 'info', text }],
//   defaultRemoved: string[],     ids of the parts removed by default
//   clean(removedIds): string,    the clean link for any choice; no argument = default
//   openUrl(removedIds): string,  the address Go to opens for that choice: clean() with
//                                 https:// in front only when it has no scheme of its own
//   cleanLink: string,            clean() with the default choice
//   changed: boolean,             cleanLink differs from link
//   rulesDate: string,
// }
// Part: { id, where: 'wrapper' | 'userinfo' | 'path' | 'query' | 'fragment', name, value,
//         provider, reveals, unique, affiliate, defaultRemove, ask, family, rule, breakage,
//         text, unrecognised }, plus sharer: true on a part whose value is the same on
//         every link one account shares (Instagram mdxt), recipient: true on a part whose
//         rule says it identifies the person a message was sent to, empty: true on an empty
//         pair a page's rule drops, and tier: 'check' and disguise on the address disguise.
//
// Address disguise: a user name (and password) before @ in the address the clean link
// goes to (google.com@kaspersky.com) is part u0, where 'userinfo', removed by default, so
// the clean link reads http://kaspersky.com/... with the scheme as written; a bare link
// (www.google.com@evil.example/x) gets https:// in front, so it still reads as a link. The
// at-trick warning stays. A link left untouched (a sign-in or reset value, a signature)
// keeps it. disguise says what it is: 'look-alike' (a name made to look like a site),
// 'sign-in' (a user name or password, named "Sign-in details in the address"), or
// 'backslash' (a backslash after it makes the address read as another host).
//
// Canonical pages: on a page the rules say is fully addressed by its path (an Instagram
// post, an X status, an Amazon product, a search engine's result page: RULES.canonical),
// a query or key=value fragment parameter that no verified host rule names is decided by
// the canonical rule: a keep-list entry whose condition holds keeps it; a functional_keep
// entry keeps it; a keep-list entry whose condition fails and that says otherwise, or a
// remove-list entry (verified to do nothing on that page), makes it a part removed by
// default with its own label and rule 'verified-page:<id>', even for a protected short
// name; on a rule with drop_empty, a kept name with an empty value goes too. Anything
// else becomes a part with unrecognised: true and rule 'canonical:<id>', removed by
// default, except a protected short name (v t s q hl ...), which is an "ask" part: shown,
// but kept until ticked. Every other part has unrecognised: false. Verified trackers keep
// their own labels (a global keep rule gives way to the page's remove list). A rule may
// require (requires) or exclude (unless) parameters before it applies, so a home page with
// ?q= or a self-hosted search engine on any host is recognised only by its query.
// Canonical rules never apply to a link left untouched or to any other path.
//
// Kept on purpose: a parameter a functional_keep entry or a canonical keep list keeps is
// listed in kept on every page, whether or not a rule would otherwise remove it; a name in
// capitals is looked up again in small letters, as the rules are.
// Kept: { id, where: 'query' | 'fragment', name, value, text, reason: 'functional' |
//         'recipient-token', note, rule, explain, what, neutral }. id is the parameter's own id
// (q3, f0), in the same space as the parts' ids: kept on purpose means it is not removed by
// default, but passing its id to clean() removes it anyway ("Remove anyway"), and the
// segments carry it as partId so the page can mark it. note is the rule's own text; explain
// says in plain words what this one parameter does (YouTube t=354: "Start time: opens the
// video at 5:54. It does not identify you."), what is the same without that last sentence
// (so a page listing several can say it once), and neutral is true when explain says it does
// not identify anyone, which only the curated wording below ever claims.
//
// Google Maps context: on a /maps/place/ link whose data= blob carries context from before
// the place (a category or search words in !2m..!1s<words>, an earlier place in !2s<name>),
// maps lists it, decoded for display, and an info warning 'maps-context' explains it in
// neutral words. The blob stays as written. maps.pin is the place's own !3d<lat>!4d<lng> as
// https://www.google.com/maps/@<lat>,<lng>,17z, a second link that shows the location but
// not the establishment's page. maps.place (spec decision 18) is a third link,
// https://maps.google.com/?cid=<N>, which opens the establishment's own page with no trail:
// N is the unsigned decimal (BigInt, as it passes 2^53) of the second half of the place's
// own feature ID, the !1s0x<hex>:0x<hex> that opens the place's block. It is offered only
// when that block also holds the blob's final !3d<lat>!4d<lng>, so that when the blob
// carries several places (Marcos's M7: a village, then its shopping centre) the ID is the one
// paired with the final coordinates; otherwise place is null and only the other links are
// offered. Straight quotes in names become U+2019, so a name can never close the quotation
// marks the note puts around it.
//
// reportMail(analysis, removedIds): { href, original, clean, shortened, originalReason,
// cleanReason } for the "Did CheckLink break your link? Email us" line. href is
// mailto:info@stormberry.as with a subject and a body built with encodeURIComponent;
// CheckLink sends nothing itself. The original link (as written) and the clean link (as
// shown) are left out, with a line saying why, when they hold a sign-in, reset, password,
// key or signature value, a part that identifies the recipient (by name, by its rule, or a
// per-recipient email wrapper), a password or email address before the @, an email address
// (also in base64 or encoded many times), or an address hidden inside that holds any of
// these; a link left untouched keeps both out, whatever is ticked. original and clean say
// whether each went in. Long links are shortened in the middle so the whole href stays
// under 1,800 characters.
//
// Choices: removedIds is any iterable of part ids. A wrapper part (w0, w1, ...) left in
// keeps that layer exactly as written, because the inner parts cannot be cut out of an
// encoded value without rebuilding it. A part whose rule default is "ask" has
// defaultRemove false and ask true: shown, but kept until ticked. Once anything is removed,
// empty pairs and an empty ? or # go too; with nothing removed the link comes back byte for
// byte. A kept part still carries its partId in the segments, so it can be marked.
//
// Hard check: whatever the choice, the clean link must go to the host the analysis names
// for it (the target, or the first wrapper kept). A choice that would send it anywhere else
// removes nothing instead.

import { RULES, RULES_DATE, RULES_VERSION } from './rules.js?v=4029e1a3';
import { PSL_DATE, domainInfo, publicSuffix } from './domain.js?v=f1bcd492';
import { brandMatch, brandShort, brandText, decodeHost, lettersFinding, lettersShort, lettersText, symbolFinding, symbolShort, symbolText } from './lookalike.js?v=2f8e8ce3';


// == types (JSDoc, for the type checker only; see the description above) ==

// What domainInfo gives (src/domain.js), named without an import: tests/core.test.mjs bans the
// text of a dynamic import in this file, and bump_assets.py would stamp an @import tag.
/** @typedef {NonNullable<ReturnType<typeof domainInfo>>} DomainInfo */
/** @typedef {'stop' | 'check' | 'info'} Tier */
/**
 * A note about the link. short is the one-sentence form the look-alike notes carry.
 * @typedef {{ id: string, tier: Tier, text: string, short?: string | null }} Warning
 */
/**
 * Where the authority, path, query (qIdx, the ?) and fragment (hIdx, the #) of a link are; -1 when absent.
 * @typedef {{ authStart: number, authEnd: number, pathStart: number, pathEnd: number, qIdx: number, hIdx: number }} LinkSplit
 */
/**
 * One address of a link: the link itself, or one unwrapped from it.
 * @typedef {{ link: string, bare: boolean, sp: LinkSplit, url: URL, host: string, authority: string, naive: string,
 *   writtenHost: string, matchStr: string }} Layer
 */
/**
 * One name=value pair of a query or fragment, as written and decoded; id is set once it becomes a part or is kept.
 * @typedef {{ raw: string, start: number, end: number, rawName: string, rawValue: string | null, name: string,
 *   value: string | null, id: string | null }} Token
 */
/**
 * A run of the link's text, removed or not, with the part it belongs to.
 * @typedef {{ text: string, removed: boolean, partId: string | null }} Segment
 */
/**
 * Removed part ids: any iterable of ids, one id, or nothing for the default choice.
 * @typedef {Iterable<string> | string | null | undefined} IdChoice
 */
/** @typedef {'wrapper' | 'userinfo' | 'path' | 'query' | 'fragment'} PartWhere */
/**
 * A part the clean link can leave out (see Part in the description above).
 * @typedef {{ id: string, where: PartWhere, name: string, value: string, provider: string | null, reveals: string,
 *   unique: boolean, affiliate: string | null, defaultRemove: boolean, ask: boolean, family: string | null, rule: string,
 *   breakage: string | null, text: string, unrecognised: boolean, sharer?: boolean, recipient?: boolean, empty?: boolean,
 *   tier?: Tier, disguise?: 'look-alike' | 'sign-in' | 'backslash' }} Part
 */
/**
 * A parameter kept on purpose (see Kept in the description above).
 * @typedef {{ id: string, where: 'query' | 'fragment', name: string, value: string, text: string,
 *   reason: 'functional' | 'recipient-token', note: string, rule: string | null, explain: string, what: string,
 *   neutral: boolean }} Kept
 */
/**
 * Context a Google Maps place link carries in its data= blob.
 * @typedef {{ context: { kind: 'category' | 'place', name: string }[], pin: { lat: string, lng: string, link: string } | null,
 *   place: { featureId: string, cid: string, link: string } | null }} MapsContext
 */
/** @typedef {{ id: string, reason: 'wrapped' | 'signed' | 'auth', name: string, text: string }} Untouched */
/**
 * A short link or a redirect whose destination CheckLink cannot see.
 * @typedef {{ id: string, service: string, label: string, host: string, kind: string, note: string | null }} ShortLink
 */
/** @typedef {{ id: string, label: string, link: string }} Offer */
/**
 * An address hidden inside the link; analysis is set by analyseLink.
 * @typedef {{ where: 'query' | 'fragment' | 'path', name: string | null, shownName: string | null, link: string, host: string,
 *   sameHost: boolean, kept: boolean, text: string, analysis?: LinkAnalysis | null }} Hidden
 */
/**
 * One wrapper around the address the clean link goes to.
 * @typedef {{ depth: number, id: string, label: string, family: string, link: string, host: string, site: DomainInfo | null,
 *   note: string | null | undefined, partId: string, segments: Segment[] }} Wrapper
 */
/**
 * The innermost address, where the clean link goes.
 * @typedef {{ link: string, host: string, hostAsWritten: string, segments: Segment[], segmentsFor: (ids?: IdChoice) => Segment[],
 *   domainAsWritten: string | null, domainStart: number }} Target
 */
/**
 * The analysis of one web link (analyseLink): what analyse returns when it finds one, less the fields about the text around it.
 * @typedef {{ found: true, kind: 'web', link: string, bare: boolean, prefix: '' | 'https://', host: string, hostAsWritten: string,
 *   site: DomainInfo | null, domain: string | null, domainAsWritten: string | null, domainStart: number, segments: Segment[],
 *   segmentsFor: (ids?: IdChoice) => Segment[], target: Target, wrappers: Wrapper[], parts: Part[], kept: Kept[],
 *   maps: MapsContext | null, untouched: Untouched | null, shortLink: ShortLink | null, offer: Offer | null, hidden: Hidden[],
 *   warnings: Warning[], lookAlikeLetters: { char: string, script: string }[], defaultRemoved: string[],
 *   clean: (ids?: IdChoice) => string, openUrl: (ids?: IdChoice) => string, cleanLink: string, changed: boolean,
 *   rulesDate: string }} LinkAnalysis
 */
/**
 * analyse() when it finds a web link.
 * @typedef {LinkAnalysis & { input: string, start: number, end: number, others: string[] }} FoundAnalysis
 */
/**
 * analyse() when the text holds no web link, or a script link.
 * @typedef {{ found: false, kind: 'script' | 'none', input: string, link: null, start: -1, end: -1, bare: false, prefix: '',
 *   others: string[], host: null, hostAsWritten: null, site: null, domain: null, domainAsWritten: null, domainStart: -1,
 *   segments: Segment[], segmentsFor: (ids?: IdChoice) => Segment[], target: null, wrappers: Wrapper[], parts: Part[],
 *   kept: Kept[], maps: null, untouched: null, shortLink: null, offer: null, hidden: Hidden[],
 *   lookAlikeLetters: { char: string, script: string }[], warnings: Warning[], defaultRemoved: string[],
 *   clean: (ids?: IdChoice) => string, openUrl: (ids?: IdChoice) => string, cleanLink: '', changed: false,
 *   rulesDate: string }} EmptyAnalysis
 */
/** @typedef {FoundAnalysis | EmptyAnalysis} Analysis */
/** @typedef {'signin' | 'signed' | 'wrapped' | 'recipient' | 'email' | 'phone' | 'id' | 'password'} PersonalReason */
/**
 * The "Email us" line: the mailto: address and what went into it.
 * @typedef {{ href: string, original: boolean, clean: boolean, shortened: boolean, originalReason: PersonalReason | null,
 *   cleanReason: PersonalReason | null }} ReportMail
 */
// The rule table's shapes. src/rules.js is generated JSON (tools/build-rules.mjs checks it), so
// the checker infers only plain strings for its fields; these name what the build guarantees.
/**
 * A rule's conditions: every one present must hold.
 * @typedef {{ paths?: string[], path_not?: string[], value_regex?: string, requires_any?: string[], url_contains?: string[],
 *   url_not_contains?: string[], except_hosts?: string[] }} Conditions
 */
/**
 * A parameter rule, global or for a host block.
 * @typedef {{ id: string, name: string, type: 'exact' | 'prefix' | 'regex', value: string, default: 'strip' | 'ask' | 'keep',
 *   provider: string, reveals: string, affiliate: string | null, family: string, breakage: string, perClick?: boolean,
 *   conditions: Conditions | null, recipient?: boolean, sharer?: boolean }} ParamRule
 */
/** @typedef {{ patterns: string[], family: string, params: ParamRule[] }} HostBlock */
/**
 * A functional_keep entry: where the table leaves rules or parameters alone, or keeps names.
 * @typedef {{ id: string, hosts: string[], effect: string, paths: string[] | null, params: string[] | null, note: string }} KeepEntry
 */
/**
 * A clause of a canonical rule: parameter name (or name*, $host, $value) to a regular expression, or null for absent or empty.
 * @typedef {Record<string, string | null>} Clause
 */
/**
 * A name a canonical page keeps, when its condition holds; otherwise, when given, a part with these words.
 * @typedef {{ name: string, note: string, when?: { any?: Clause[], paths?: string[] },
 *   otherwise?: { provider: string, reveals: string } }} CanonicalKeep
 */
/** @typedef {{ names: string[], provider: string, reveals: string, perClick?: boolean }} CanonicalRemove */
/**
 * A page fully addressed by its path (RULES.canonical).
 * @typedef {{ id: string, platform: string, family: string, provider: string, reveals: string, askReveals: string, host: string,
 *   paths: string[], keep: CanonicalKeep[], basis?: string, remove?: CanonicalRemove[], requires?: Clause[], unless?: Clause[],
 *   emptyReveals?: string, dropEmpty?: boolean }} CanonicalRule
 */
/**
 * How a wrapper's destination is taken out of it.
 * @typedef {{ type: 'query' | 'base64' | 'base64url', params: string[], relative_to?: string, prepend_if_no_scheme?: string,
 *   strip_prefix?: string } | { type: 'query_prefix', param_prefix: string }
 *   | { type: 'regex', regex: string, template: string, percent_decode: boolean } | { type: 'twitch_email' }} Extraction
 */
/**
 * A wrapper or redirect host (RULES.redirects).
 * @typedef {{ id: string, family: string, label: string, match: string, offline: boolean, extract: Extraction | null,
 *   action?: string, note: string | null }} RedirectRule
 */
/**
 * Tracking written into the path (RULES.pathRules).
 * @typedef {{ id: string, hosts: string[], regex: string, flags: string, name: string, provider: string, reveals: string,
 *   default: string, family: string, unique: boolean, warning: string | null }} PathRule
 */
/**
 * What the parameter rules are decided against (planTarget's runList).
 * @typedef {{ host: string, path: string, url: string, keys: Set<string>, skipHost: boolean, never: KeepEntry[],
 *   hostBlocks: HostBlock[] }} DecideContext
 */
/**
 * The parameters a canonical clause is tested against (paramEnv).
 * @typedef {{ host: string, path: string, map: Map<string, string> }} ParamEnv
 */
/**
 * What buildPieces needs to write the link for any choice (planTarget's model).
 * @typedef {{ link: string, pathStart: number, pathEnd: number, pathParts: { start: number, end: number, id: string }[],
 *   userinfo: { start: number, end: number, id: string } | null, query: { mark: number, tokens: Token[] } | null,
 *   frag: { mark: number, tokens: Token[] | null, text: string | null } | null }} PieceModel
 */
export { PSL_DATE, RULES_DATE, RULES_VERSION };

const MAX_UNWRAP = 5;
const MAX_HIDDEN_DEPTH = 1;
const SPEC = { exact: 3, regex: 2, prefix: 1 };
const TIER_ORDER = { stop: 0, check: 1, info: 2 };
const PROTECTED = new Set(RULES.protectedNames);

/** @type {Record<string, string>} */
const INVISIBLE_NAMES = {
  '\u00AD': 'soft hyphen', '\u034F': 'combining grapheme joiner', '\u061C': 'Arabic letter mark',
  '\u200B': 'zero-width space', '\u200C': 'zero-width non-joiner', '\u200D': 'zero-width joiner',
  '\u200E': 'left-to-right mark', '\u200F': 'right-to-left mark', '\u202A': 'left-to-right embedding',
  '\u202B': 'right-to-left embedding', '\u202C': 'direction formatting', '\u202D': 'left-to-right override',
  '\u202E': 'right-to-left override', '\u2060': 'word joiner', '\u2066': 'direction isolate',
  '\u2067': 'direction isolate', '\u2068': 'direction isolate', '\u2069': 'direction isolate', '\uFEFF': 'zero-width no-break space',
  '\uFFF9': 'interlinear annotation mark', '\uFFFA': 'interlinear annotation mark', '\uFFFB': 'interlinear annotation mark',
};
// Every format character (Cf) and every character Unicode says to draw as nothing
// (Default_Ignorable_Code_Point): zero-width spaces and joiners, direction marks,
// embeddings, overrides and isolates, soft hyphens, variation selectors, and the tag
// characters U+E0000 to U+E007F, which can spell hidden text.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const INVISIBLE_RUN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const FULL_WIDTH = /[\uFF01-\uFF5E\u3002\uFF0E\uFF61]/;
// javascript: and vbscript: always run code; the others only count when no space follows
// the colon, so ordinary text such as "About: ..." or "Data: ..." is not mistaken for one.
// data, file, content, about and chrome also do not count when a web address follows the
// colon straight away ("About:https://..."): none of them can hold one, so it is prose.
// blob, filesystem, jar and view-source can wrap a web address and still count.
const SCRIPT_SCHEMES = /^(?:(javascript|vbscript):|(data|file|content|about|chrome):(?!\s|https?:\/\/|www\.)|(blob|filesystem|jar|view-source):(?!\s))/i;
// Leading characters skipped before looking for a script scheme: spaces, controls and
// anything invisible ("\u200Bjavascript:" still runs once the invisible part is lost).
const LEAD = /^[\u0000- \p{Cf}\p{Default_Ignorable_Code_Point}\s]+/u;
const SCRIPT_ANYWHERE = /(?:^|[\s\p{Cf}\p{Default_Ignorable_Code_Point}])(javascript|vbscript):/iu;

// == helpers ==

/** @type {Map<string, RegExp>} */
const reCache = new Map();
/**
 * @param {string} src
 * @param {string} [flags]
 * @returns {RegExp}
 */
function re(src, flags = '') {
  const key = `${flags}/${src}`;
  let r = reCache.get(key);
  if (!r) {
    r = new RegExp(src, flags);
    reCache.set(key, r);
  }
  return r;
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const UTF8 = new TextDecoder('utf-8');
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/** @param {string} run */
const runBytes = (run) => {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  return bytes;
};

// Percent-decodes runs of %XX as UTF-8 (bad bytes become U+FFFD); invalid escapes stay.
// For display and for comparing names and values.
/**
 * @template {string | null | undefined} S
 * @param {S} s
 * @returns {S}
 */
export function pctDecode(s) {
  if (!s || !s.includes('%')) return s;
  return /** @type {S} */ (s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => UTF8.decode(runBytes(run))));
}

// The same for an address taken out of a wrapper: a run that is not valid UTF-8 (a
// Latin-1 %E6%F8%E5) stays exactly as written, so the server still gets those bytes.
/**
 * @template {string | null | undefined} S
 * @param {S} s
 * @returns {S}
 */
function pctDecodeKeep(s) {
  if (!s || !s.includes('%')) return s;
  return /** @type {S} */ (s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return UTF8_STRICT.decode(runBytes(run));
    } catch {
      return run;
    }
  }));
}

// Characters that cannot stand in an address as written: spaces of every kind, controls,
// " < > and `. Decoding a wrapped address can bring them back (%20 becomes a space), and a
// raw space would cut the link wherever it is pasted. They are written as %XX again.
const ILLEGAL = /[\u0000-\u0020\u007F"<>`\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;
const UTF8_ENCODE = new TextEncoder();
/**
 * @template {string | null} S
 * @param {S} s
 * @returns {S}
 */
function escapeIllegal(s) {
  if (typeof s !== 'string') return s;
  return /** @type {S} */ (s.replace(ILLEGAL, (ch) => Array.from(UTF8_ENCODE.encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')));
}

// Parameter names and values are compared decoded, with + read as a space.
/** @param {string} s */
const formDecode = (s) => pctDecode(s.replace(/\+/g, ' '));

/**
 * @param {unknown} s
 * @returns {string | null}
 */
function base64ToText(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  t = t.replace(/=+$/, '');
  if (t.length % 4 === 1) return null;
  while (t.length % 4) t += '=';
  try {
    const bin = atob(t);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * @param {string} s
 * @param {number} [max]
 * @returns {string}
 */
function shorten(s, max = 40) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, 24).join('')}\u2026${chars.slice(-12).join('')}`;
}

// A value that looks generated rather than written: long, with many changes between
// capitals, small letters and digits, or a UUID, long hex or long number. A short value made
// of letters only (DuckDuckGo, HackerNews) is a word, however its capitals fall.
/**
 * @param {string | null} v
 * @returns {boolean}
 */
function looksRandom(v) {
  if (!v) return false;
  const s = v.replace(/=+$/, '');
  if (s.length < 8) return false;
  if (s.length < 20 && /^\p{L}+$/u.test(s)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^\d+$/.test(s)) return s.length >= 16;
  if (/^[0-9a-f]{16,}$/i.test(s) && /\d/.test(s) && /[a-f]/i.test(s)) return true;
  /** @param {string} c */
  const cls = (c) => (/\d/.test(c) ? 'd' : /[A-Z]/.test(c) ? 'u' : /[a-z]/.test(c) ? 'l' : 'o');
  let changes = 0;
  let prev = cls(s[0]);
  for (const ch of s.slice(1)) {
    const c = cls(ch);
    if (c !== prev && c !== 'o' && prev !== 'o') changes++;
    prev = c;
  }
  return s.length >= 10 && changes >= 4;
}

// Plain words written in base64 look generated but are the same for everyone
// (QW1hem9uIEZyZXNo is "Amazon Fresh"). Takes the value as written, percent-decoded.
/**
 * @param {string} v
 * @returns {boolean}
 */
function base64Words(v) {
  const text = base64ToText(v);
  return !!text && /^\p{L}+(?:[ '.&-]{1,2}\p{L}+)*$/u.test(text.trim()) && /\p{L}{3}/u.test(text);
}

/**
 * @param {IdChoice} ids
 * @returns {Set<string> | null}
 */
function toIdSet(ids) {
  if (ids == null) return null;
  if (typeof ids === 'string') return new Set([ids]);
  return new Set(ids);
}

/**
 * @param {unknown} h
 * @returns {string}
 */
const normHost = (h) => String(h || '').toLowerCase().replace(/\.$/, '');

// An email address, in any alphabet (an international domain too), somewhere in a text; and a text that
// is one email address and nothing else.
const EMAIL_IN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;
const EMAIL_WHOLE = new RegExp(`^${EMAIL_IN.source}$`, 'u');

// The public suffix a provider pattern may stand on for this host: the host's own suffix from
// the Public Suffix List, when the list's ICANN section decides it. A suffix from the PRIVATE
// section (com.de, co.no, github.io: anyone can make an address under it) or a name the list
// does not know gives null, so amazon.com.de and google.evil.io are never read as Amazon or
// Google. (Stage 2: replaces the stopgap pattern and its suffix_deny list.)
/**
 * @param {string} host
 * @returns {string | null}
 */
function providerSuffix(host) {
  const ps = publicSuffix(normHost(host));
  return ps && ps.known && !ps.private ? ps.suffix : null;
}

// A rule pattern compiled for one host: the suffix token the build put where a provider's
// public suffix goes is replaced by this host's own suffix, or by a pattern that matches
// nothing when the host has none a provider could stand on.
/**
 * @param {string} src
 * @param {string} host
 * @param {string} [flags]
 * @returns {RegExp}
 */
function reFor(src, host, flags = '') {
  if (!src.includes(RULES.suffixToken)) return re(src, flags);
  const sfx = providerSuffix(host);
  return re(src.split(RULES.suffixToken).join(sfx ? escapeRe(sfx) : '(?!)'), flags);
}

/**
 * @param {string} host
 * @param {string} pattern
 * @returns {boolean}
 */
export function hostMatches(host, pattern) {
  const h = normHost(host);
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    // name.* : the host is name.<its own public suffix>, or an address under it.
    const sfx = providerSuffix(h);
    if (!sfx) return false;
    const base = `${pattern.slice(0, -2)}.${sfx}`;
    return h === base || h.endsWith(`.${base}`);
  }
  return h === pattern || h.endsWith(`.${pattern}`);
}

/** @param {string} h */
const isIPv4 = (h) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h);

// Where an address goes, for CheckLink's own sentences (stage 2, with the Public Suffix List):
// the host as the browser reads it, led by the registrable domain, the part of the name its
// owner registered, when the host is a longer address under it. www. in front of the domain
// adds nothing, so www.google.com stays as it is; paypal.com.secure.evil.co.uk reads
// "evil.co.uk (full name: paypal.com.secure.evil.co.uk)".
/**
 * @param {string} host
 * @returns {string}
 */
function placeName(host) {
  const h = normHost(host);
  const info = domainInfo(h);
  if (!info || !info.domain || info.domain === h || h === `www.${info.domain}`) return host;
  return `${info.domain} (full name: ${host})`;
}

// The registrable domain as the address writes it: the same last labels of the host as
// written (Troms\u00F8.no as written for xn--troms-zua.no, EXAMPLE.co.uk for example.co.uk), with where they
// start in the written host. Null when there is no domain, or when the written host does not
// split into as many labels as the real one.
const LABEL_DOT = /[.\u3002\uFF0E\uFF61]/;
/**
 * @param {string} written
 * @param {string} host
 * @param {string} domain
 * @returns {{ start: number, text: string } | null}
 */
function writtenDomain(written, host, domain) {
  if (!written || !domain || written.startsWith('[')) return null;
  const w = written.replace(/[.\u3002\uFF0E\uFF61]$/, '');
  const labels = w.split(LABEL_DOT);
  if (labels.length !== normHost(host).split('.').length) return null;
  const keep = domain.split('.').length;
  let start = 0;
  for (const l of labels.slice(0, labels.length - keep)) start += l.length + 1;
  return { start, text: w.slice(start) };
}

/**
 * @param {string} host
 * @returns {'loopback' | 'private' | 'public' | null}
 */
function ipKind(host) {
  let h = host;
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1).toLowerCase();
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (mapped) {
      const a = parseInt(mapped[1], 16);
      const b = parseInt(mapped[2], 16);
      h = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    } else {
      if (v6 === '::1') return 'loopback';
      if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return 'private';
      return 'public';
    }
  }
  if (!isIPv4(h)) return null;
  const [a, b] = h.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

/**
 * @param {unknown} s
 * @returns {URL | null}
 */
function webUrl(s) {
  if (typeof s !== 'string' || !/^https?:\/\//i.test(s) || /[\u0000-\u001F\u007F]/.test(s)) return null;
  try {
    const u = new URL(s);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return u;
  } catch { /* not an address */ }
  return null;
}

// == finding links ==

const TERMINATOR = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000<>"`]/;
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '"', '\u2019', '\u201D', '\u00BB', '\u3002', '\uFF0C', '\u3001', '\uFF01', '\uFF1F', '\u2026']);
/** @type {Record<string, string>} */
const CLOSERS = { ')': '(', ']': '[', '}': '{', '\uFF09': '\uFF08', '\u300D': '\u300C' };

/**
 * @param {string} s
 * @param {string} ch
 * @param {number} end
 * @returns {number}
 */
function countIn(s, ch, end) {
  let n = 0;
  for (let i = 0; i < end; i++) if (s[i] === ch) n++;
  return n;
}

// Trims punctuation that ends the sentence rather than the link. A closing bracket goes
// only while the link has more closing than opening ones, a ' only while the link holds an
// odd number of them (so ?q='test' keeps its closing quote), and a * only as many times as
// stars stand straight before the link (Markdown **bold**), so ?q=foo* keeps its star.
// Each count is taken once and then kept up to date, so this stays linear in the length.
/**
 * @param {string} s
 * @param {number} [starsBefore]
 * @returns {string}
 */
function trimTrailing(s, starsBefore = 0) {
  let end = s.length;
  let stars = starsBefore;
  let quotes = -1;
  /** @type {Map<string, { opens: number, closes: number }>} */
  const brackets = new Map();
  while (end > 0) {
    const last = s[end - 1];
    if (TRAILING.has(last)) {
      end--;
      continue;
    }
    if (last === "'") {
      if (quotes < 0) quotes = countIn(s, "'", end);
      if (quotes % 2 === 1) {
        end--;
        quotes--;
        continue;
      }
      break;
    }
    if (last === '*') {
      if (stars > 0) {
        end--;
        stars--;
        continue;
      }
      break;
    }
    const open = CLOSERS[last];
    if (open) {
      let c = brackets.get(last);
      if (!c) {
        c = { opens: countIn(s, open, end), closes: countIn(s, last, end) };
        brackets.set(last, c);
      }
      if (c.closes > c.opens) {
        end--;
        c.closes--;
        continue;
      }
    }
    break;
  }
  return s.slice(0, end);
}

/**
 * @param {unknown} text
 * @returns {{ links: { link: string, start: number, end: number, bare: boolean }[], unreadable: string[] }}
 */
export function findLinks(text) {
  const s = String(text ?? '');
  /** @type {{ link: string, start: number, end: number, bare: boolean }[]} */
  const links = [];
  /** @type {string[]} */
  const unreadable = [];
  const start = /(?<![A-Za-z0-9+.\-])https?:\/\/|(?<![A-Za-z0-9._@/:\\-])www\./giu;
  let m;
  while ((m = start.exec(s))) {
    let end = m.index;
    while (end < s.length && !TERMINATOR.test(s[end])) end++;
    let stars = 0;
    while (m.index - stars > 0 && s[m.index - stars - 1] === '*') stars++;
    const raw = trimTrailing(s.slice(m.index, end), stars);
    const bare = !/^https?:\/\//i.test(raw);
    const ok = raw.length > m[0].length && webUrl(bare ? `https://${raw}` : raw);
    if (ok) links.push({ link: raw, start: m.index, end: m.index + raw.length, bare });
    else if (raw.length > m[0].length) unreadable.push(raw);
    start.lastIndex = Math.max(start.lastIndex, m.index + Math.max(raw.length, 1));
  }
  return { links, unreadable };
}

// == splitting a link ==

// Positions follow the WHATWG URL parser for http and https: after the scheme it skips
// every / and \ (so https:///a@b/ and https://\a@b/ have the authority a@b), the authority
// ends at the first / \ ? or #, the query at the first #.
/**
 * @param {string} link
 * @param {boolean} [bare]
 * @returns {LinkSplit | null}
 */
export function splitLink(link, bare = false) {
  let authStart = 0;
  if (!bare) {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:[/\\]+/.exec(link);
    if (!m) return null;
    authStart = m[0].length;
  }
  let authEnd = link.length;
  for (let i = authStart; i < link.length; i++) {
    if ('/\\?#'.includes(link[i])) {
      authEnd = i;
      break;
    }
  }
  const hIdx = link.indexOf('#', authEnd);
  const beforeHash = hIdx < 0 ? link.length : hIdx;
  const q = link.indexOf('?', authEnd);
  const qIdx = q >= 0 && q < beforeHash ? q : -1;
  return { authStart, authEnd, pathStart: authEnd, pathEnd: qIdx >= 0 ? qIdx : beforeHash, qIdx, hIdx };
}

// What a person may take for the authority: everything up to the first / ? or #. It differs
// from the real authority only when a backslash ends the real one early (evil.example\@
// www.google.com reads as www.google.com and goes to evil.example).
/**
 * @param {string} link
 * @param {LinkSplit} sp
 * @returns {string}
 */
function naiveAuthority(link, sp) {
  let end = link.length;
  for (let i = sp.authStart; i < link.length; i++) {
    if ('/?#'.includes(link[i])) {
      end = i;
      break;
    }
  }
  return link.slice(sp.authStart, end);
}

/**
 * @param {string} authority
 * @returns {string}
 */
function writtenHostOf(authority) {
  let h = authority.slice(authority.lastIndexOf('@') + 1);
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1 || h.length);
  const colon = h.lastIndexOf(':');
  if (colon >= 0 && /^\d*$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return h;
}

/**
 * @param {string} link
 * @param {boolean} bare
 * @returns {Layer | null}
 */
function parseLayer(link, bare) {
  const sp = splitLink(link, bare);
  if (!sp) return null;
  const url = webUrl(bare ? `https://${link}` : link);
  if (!url) return null;
  // The written host ends where the browser ends the authority, at / \ ? or #, so the host
  // shown bold is always the one the link goes to.
  const authority = link.slice(sp.authStart, sp.authEnd);
  return {
    link,
    bare,
    sp,
    url,
    host: url.hostname,
    authority,
    naive: naiveAuthority(link, sp),
    writtenHost: writtenHostOf(authority),
    // A trailing dot (www.google.com.) names the same host, so it must not stop a match.
    matchStr: `${url.protocol}//${url.host.replace(/\.(?=:\d*$|$)/, '')}${link.slice(sp.authEnd)}`,
  };
}

/**
 * @param {Layer} layer
 * @returns {string}
 */
function rawQuery(layer) {
  const { link, sp } = layer;
  if (sp.qIdx < 0) return '';
  return link.slice(sp.qIdx + 1, sp.hIdx >= 0 ? sp.hIdx : link.length);
}

/**
 * @param {string} text
 * @param {number} base
 * @returns {Token[]}
 */
function tokenise(text, base) {
  /** @type {Token[]} */
  const out = [];
  let pos = base;
  for (const raw of text.split('&')) {
    const eq = raw.indexOf('=');
    const rawName = eq < 0 ? raw : raw.slice(0, eq);
    const rawValue = eq < 0 ? null : raw.slice(eq + 1);
    out.push({
      raw,
      start: pos,
      end: pos + raw.length,
      rawName,
      rawValue,
      name: formDecode(rawName),
      value: rawValue === null ? null : formDecode(rawValue),
      id: null,
    });
    pos += raw.length + 1;
  }
  return out;
}

// A fragment that holds a text directive is the browser's, not a list of pairs, and is
// never cleaned: #:~:text=... on its own, and also after an ordinary anchor, the way
// Chrome's "Copy link to highlight" writes it (#reviews:~:text=battery).
/**
 * @param {string | null} frag
 * @returns {frag is string}
 */
const paramFragment = (frag) => frag !== null && frag.includes('=') && !frag.includes(':~:') && !frag.startsWith('/') && !frag.startsWith('!');

// Pairs in the fragment that are never cleaned but are still looked at for sign-in
// values, which leave the link untouched: the query of a web-app route
// (#/callback?code=..., #!/x?token=...) and the part before a text directive
// (#access_token=...:~:text=...).
/**
 * @param {string | null} frag
 * @returns {string}
 */
function lookOnlyQuery(frag) {
  if (frag === null) return '';
  if (/^!?\//.test(frag)) {
    const q = frag.indexOf('?');
    return q < 0 ? '' : frag.slice(q + 1);
  }
  const d = frag.indexOf(':~:');
  return d > 0 ? frag.slice(0, d) : '';
}

// == warnings ==

class Warnings {
  constructor() {
    /** @type {Warning[]} */
    this.list = [];
    /** @type {Set<string>} */
    this.keys = new Set();
  }

  // extra: more fields for the warning; the look-alike notes carry short, one sentence for the
  // first screen and for screen readers.
  /**
   * @param {string} id
   * @param {Tier} tier
   * @param {string} text
   * @param {{ short?: string | null } | null} [extra]
   */
  add(id, tier, text, extra = null) {
    const key = `${id}|${text}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.list.push({ id, tier, text, ...(extra || {}) });
  }

  // Replaces the text of one warning, found by its id and text, keeping its place.
  /**
   * @param {string} id
   * @param {string} text
   * @param {string} next
   * @param {{ short?: string | null } | null} [extra]
   */
  replace(id, text, next, extra = null) {
    const w = this.list.find((x) => x.id === id && x.text === text);
    if (!w) return;
    this.keys.delete(`${id}|${text}`);
    this.keys.add(`${id}|${next}`);
    w.text = next;
    if (extra) Object.assign(w, extra);
  }

  /** @returns {Warning[]} */
  sorted() {
    return this.list.map((w, i) => ({ w, i })).sort((a, b) => TIER_ORDER[a.w.tier] - TIER_ORDER[b.w.tier] || a.i - b.i).map((x) => x.w);
  }
}

/**
 * @param {string} ch
 * @returns {string}
 */
const nameOfInvisible = (ch) => {
  if (INVISIBLE_NAMES[ch]) return INVISIBLE_NAMES[ch];
  const cp = /** @type {number} */ (ch.codePointAt(0));
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'tag character';
  if ((cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF)) return 'variation selector';
  return 'an invisible character';
};

/**
 * @param {string} s
 * @returns {string | null}
 */
function invisibleName(s) {
  for (const ch of s) if (INVISIBLE.test(ch)) return nameOfInvisible(ch);
  return null;
}

// Splits text into ordinary runs and single invisible or direction-changing characters,
// each labelled with its code point and name, so the page can draw them as visible marks
// instead of letting them reorder or hide what is around them.
/**
 * @param {unknown} text
 * @returns {({ text: string, invisible: true, label: string } | { text: string, invisible: false, label: null })[]}
 */
export function invisibleChunks(text) {
  const s = String(text ?? '');
  /** @type {({ text: string, invisible: true, label: string } | { text: string, invisible: false, label: null })[]} */
  const out = [];
  let last = 0;
  for (const m of s.matchAll(INVISIBLE_RUN)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), invisible: false, label: null });
    const ch = m[0];
    const code = `U+${/** @type {number} */ (ch.codePointAt(0)).toString(16).toUpperCase().padStart(4, '0')}`;
    out.push({ text: ch, invisible: true, label: `${code} ${nameOfInvisible(ch).replace(/^an /, '')}` });
    last = m.index + ch.length;
  }
  if (last < s.length) out.push({ text: s.slice(last), invisible: false, label: null });
  return out;
}

const CJK_NAME = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const JOINERS = new Set(['\u200C', '\u200D']);

// Signs that look like letters and that the address parser turns into letters: the Kelvin sign
// (to k), the Angstrom sign (to a with a ring) and the Ohm sign (to omega). Small letters alone already map them,
// so a name written with one can equal the real name (stage 4b security review S12).
const SIGN_LETTERS = /[\u2126\u212A\u212B]/;

/**
 * @param {Layer} layer
 * @returns {string[] | null}
 */
function disguiseReasons(layer) {
  const written = layer.writtenHost;
  const real = layer.host;
  const w = written.toLowerCase();
  const reasons = [];
  if (written && SIGN_LETTERS.test(written)) reasons.push('a sign written as a letter');
  if (written && w !== real && !w.startsWith('[')) {
    const shown = decodeHost(real);
    if (/%[0-9a-f]{2}/i.test(written)) reasons.push('percent-encoding');
    // A Japanese, Chinese or Korean name typed with the full stop of its own keyboard (a Japanese name ending
    // in U+3002 jp)
    // is how such a name is written, not a disguise: the browser reads that full stop as a dot.
    // Full-width Latin letters, or such a full stop between Latin names, still count (look-alike
    // review L2, stage 3).
    const cjkDots = /^[^\uFF01-\uFF5E]*$/.test(written.replace(/[\uFF0E]/g, '')) && CJK_NAME.test(shown);
    if (FULL_WIDTH.test(written) && !cjkDots) reasons.push('full-width characters');
    // A zero-width joiner or non-joiner that the browser keeps in the name is part of its
    // spelling (Persian, Hindi and other scripts need it), not a hidden character; one it drops
    // silently still counts (look-alike review L3).
    const inv = invisibleName(Array.from(written).filter((ch) => !(JOINERS.has(ch) && shown.includes(ch))).join(''));
    if (inv) reasons.push(`invisible characters (${inv})`);
    if (isIPv4(real) && /^[0-9a-fx.]+$/i.test(written)) reasons.push(`a number written as ${written}`);
    if (!reasons.length) {
      const wl = w.split(LABEL_DOT);
      const rl = real.split('.');
      const idn = wl.length === rl.length && wl.every((l, i) => l === rl[i] || (rl[i].startsWith('xn--') && /[^\x00-\x7f]/.test(l)));
      if (!idn) reasons.push('a different spelling');
    }
  }
  // A backslash ends the authority for the browser but not for a reader: the host a person
  // reads (after the last @, before the first / ? or #) is not where it goes.
  if (layer.naive.includes('\\')) reasons.push('a backslash');
  return reasons.length ? reasons : null;
}

// What the part before @ is: a look-alike name, sign-in details (an email address, a user
// name with no dot in it, or anything with a password after a user name that does not read
// as a host), or a disguise made by a backslash after it, which ends the real address before
// the host a person reads.
/**
 * @param {Layer} layer
 * @returns {'backslash' | 'sign-in' | 'look-alike'}
 */
function userinfoKind(layer) {
  if (layer.naive.includes('\\') && layer.naive !== layer.authority) return 'backslash';
  const ui = layer.authority.slice(0, Math.max(layer.authority.lastIndexOf('@'), 0));
  const colon = ui.indexOf(':');
  const user = pctDecode(colon >= 0 ? ui.slice(0, colon) : ui);
  if (EMAIL_WHOLE.test(user) || !user.includes('.')) return 'sign-in';
  return 'look-alike';
}

/**
 * @param {Layer} layer
 * @param {Warnings} warnings
 */
function hostChecks(layer, warnings) {
  const host = layer.host;
  if (layer.url.username || layer.url.password) {
    // The spec's wording (warning 1). Where the part becomes a row, planTarget says it in
    // fewer words, because the row already explains it.
    warnings.add('at-trick', 'check', `The part before @ is not where this goes. It goes to ${placeName(host)}.`);
  }
  // Spec warning 4 and stage 3 (src/lookalike.js): letters of another alphabet that pass for
  // Latin ones, and characters inside the name that look like a hyphen, full stop or slash. A
  // whole-alphabet name under an ending in the same alphabet (a Russian word
  // under the Cyrillic .rf) is ordinary there; the
  // brand check after unwrapping still names it when it passes for a listed brand.
  const letters = lettersFinding(host);
  if (letters && !letters.ordinary) warnings.add('look-alike-letters', 'check', lettersText(letters), { short: lettersShort(letters) });
  const symbol = symbolFinding(host);
  if (symbol) warnings.add('look-alike-symbol', 'check', symbolText(symbol), { short: symbolShort(symbol) });
  // Invisible or direction-changing characters before the @ can make the user part read
  // like a host (a right-to-left override turns moc.elgoog into google.com).
  const at = layer.naive.lastIndexOf('@');
  const userPart = at >= 0 ? layer.naive.slice(0, at) : '';
  const invUser = invisibleName(userPart);
  if (invUser) warnings.add('invisible', 'check', `The part before @ contains invisible characters (${invUser}). They change how the address reads without showing.`);
  const reasons = disguiseReasons(layer);
  if (reasons) {
    warnings.add('disguised', 'check', `The address as written was disguised (${reasons.join(', ')}). It really goes to ${placeName(host)}.`);
  }
  const kind = ipKind(host);
  if (kind === 'loopback') warnings.add('ip-address', 'info', `This address (${host}) points to the device it is opened on, not to a site on the internet.`);
  else if (kind === 'private') warnings.add('ip-address', 'info', `This address (${host}) is a device on your own network, such as a router or printer, not a site on the internet.`);
  else if (kind === 'public') warnings.add('ip-address', 'check', `This link uses a bare number (${host}) instead of a name. Ordinary sites use a name: check that you expected this.`);
}

/**
 * @param {Layer} layer
 * @param {Warnings} warnings
 */
function targetChecks(layer, warnings) {
  if (layer.url.protocol === 'http:' && !layer.bare && !normHost(layer.host).endsWith('.onion')) {
    warnings.add('not-encrypted', 'check', 'This link is not encrypted (http:). Others on the same network can see and change what is sent.');
  }
  if (layer.bare) {
    warnings.add('no-scheme', 'info', 'No http:// or https:// was written, so CheckLink reads it as https://.');
  }
  const rest = layer.link.slice(layer.sp.authEnd);
  const inv = invisibleName(rest);
  if (inv) warnings.add('invisible', 'check', `This link contains invisible characters (${inv}). They change the address without showing.`);
}

// == redirects ==

/**
 * @param {Layer} layer
 * @returns {RedirectRule | null}
 */
function findRedirect(layer) {
  for (const rd of /** @type {RedirectRule[]} */ (RULES.redirects)) if (reFor(rd.match, layer.host).test(layer.matchStr)) return rd;
  return null;
}

// A destination taken out of a wrapper is accepted only as a complete web address, with
// anything that cannot stand in an address written as %XX again.
/**
 * @param {unknown} val
 * @returns {string | null}
 */
function acceptTarget(val) {
  if (typeof val !== 'string') return null;
  const once = escapeIllegal(val);
  if (webUrl(once)) return once;
  if (/%[0-9a-f]{2}/i.test(val)) {
    const again = escapeIllegal(pctDecodeKeep(val));
    if (webUrl(again)) return again;
  }
  return null;
}

// Returned when a wrapper names two different destinations in the same parameter: which
// one the server follows is up to the server, so CheckLink does not choose.
const AMBIGUOUS = { ambiguous: true };

/**
 * @param {RedirectRule} rd
 * @param {Layer} layer
 * @returns {string | typeof AMBIGUOUS | null}
 */
function extractTarget(rd, layer) {
  const ex = rd.extract;
  if (!ex) return null;
  if (ex.type === 'query' || ex.type === 'base64' || ex.type === 'base64url') {
    /** @type {Map<string, string[]>} */
    const values = new Map();
    for (const t of tokenise(rawQuery(layer), 0)) {
      if (!t.raw || !t.rawValue) continue;
      if (!values.has(t.name)) values.set(t.name, []);
      /** @type {string[]} */ (values.get(t.name)).push(t.rawValue);
    }
    for (const p of ex.params) {
      const all = values.get(p);
      if (!all) continue;
      if (new Set(all.map(pctDecodeKeep)).size > 1) return AMBIGUOUS;
      const raw = all[0];
      let val = pctDecodeKeep(raw);
      if (ex.type === 'query') {
        if (ex.relative_to) {
          if (!val.startsWith('/')) continue;
          val = (ex.relative_to === 'same-origin' ? `${layer.url.protocol}//${layer.url.host}` : ex.relative_to) + val;
        } else if (ex.prepend_if_no_scheme && !/^[a-z][a-z0-9+.-]*:/i.test(val)) {
          val = ex.prepend_if_no_scheme + val;
        }
        const ok = acceptTarget(val);
        if (ok) return ok;
        continue;
      }
      if (ex.type === 'base64url' && ex.strip_prefix) {
        if (!val.startsWith(ex.strip_prefix)) continue;
        val = val.slice(ex.strip_prefix.length);
      }
      const ok = acceptTarget(base64ToText(val));
      if (ok) return ok;
    }
    return null;
  }
  if (ex.type === 'query_prefix') {
    for (const t of tokenise(rawQuery(layer), 0)) {
      if (t.name.startsWith(ex.param_prefix) && t.rawValue) {
        const ok = acceptTarget(pctDecodeKeep(t.rawValue));
        if (ok) return ok;
      }
    }
    return null;
  }
  if (ex.type === 'regex') {
    const m = reFor(ex.regex, layer.host).exec(layer.matchStr);
    if (!m) return null;
    let out = ex.template;
    for (let i = m.length - 1; i >= 1; i--) out = out.split(`$${i}`).join(ex.percent_decode ? pctDecodeKeep(m[i] || '') : m[i] || '');
    return acceptTarget(out);
  }
  if (ex.type === 'twitch_email') {
    const m = /\/r\/e\/([^/?#]+)/.exec(layer.link.slice(layer.sp.pathStart));
    if (!m) return null;
    const text = base64ToText(pctDecode(m[1]));
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      if (data && data.name === 'twitch_favorite_up' && typeof data.channel === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(data.channel)) {
        return `https://www.twitch.tv/${data.channel}`;
      }
    } catch { /* opaque */ }
    return null;
  }
  return null;
}

/**
 * @param {RedirectRule} rd
 * @param {Layer} layer
 * @returns {ShortLink}
 */
function shortLinkFromRule(rd, layer) {
  const kind = /short|share link|shortener/i.test(rd.label) ? 'shortener' : 'redirect';
  return { id: rd.id, service: rd.family, label: rd.label, host: layer.host, kind, note: rd.note || null };
}

/**
 * @param {ShortLink} sl
 * @param {Warnings} warnings
 */
function shortLinkWarning(sl, warnings) {
  const h = sl.host;
  if (sl.kind === 'dynamic-qr') {
    warnings.add('short-link', 'check', `This is a dynamic QR link through ${h}. Where it ends up is stored on ${h}'s server, its owner can change it at any time, and it only shows when opened; CheckLink never opens it.`);
  } else if (sl.kind === 'shortener') {
    warnings.add('short-link', 'check', `This is a short link through ${h}. Where it ends up is stored on ${h}'s server and only shows when opened; CheckLink never opens it.`);
  } else {
    warnings.add('short-link', 'check', `This link goes through ${sl.label}. Where it ends up is decided by ${h} and only shows when opened; CheckLink never opens it.`);
  }
}

const SAFE_LINKS_IDS = new Set(['outlook-safelinks', 'teams-safelinks']);
const LOOK_ALIKE_IDS = new Set(['look-alike-letters', 'look-alike-symbol', 'look-alike-brand']);

// A wrapper an email service puts around each link of a message, so it can tell which
// recipient clicked: the email-automation family, and any other wrapper the table names as
// an email one (Amazon /gp/r.html, Reddit, Twitch and HBO Max email links).
/**
 * @param {{ family: string, label?: string | null }} rd
 * @returns {boolean}
 */
const recipientWrapper = (rd) => rd.family === 'Email and marketing automation' || /\bemail\b/i.test(rd.label || '');

/**
 * @param {RedirectRule} rd
 * @returns {string}
 */
function wrapperReveals(rd) {
  if (rd.id === 'teams-safelinks') {
    return 'Sends your click through Microsoft first, which checks and can record it.';
  }
  if (rd.id === 'outlook-safelinks') {
    return "Sends your click through Microsoft first, which checks and can record it. The wrapper also carries the recipient's email address.";
  }
  if (rd.family === 'Email and marketing automation') {
    return `Sends your click through the sender's email service (${rd.label}) first, so it can record which recipient clicked.`;
  }
  if (rd.family === 'Affiliate networks' || rd.family === 'Nordic shops and networks') {
    return `Sends your click through an affiliate network (${rd.label}) first, so it can record the click and pay whoever shared the link.`;
  }
  return `Sends your click through ${rd.family} first, so it can record that you clicked before passing you on.`;
}

// == parameters ==

/**
 * @param {{ type: string, value: string }} rule
 * @param {string} name
 * @returns {boolean}
 */
function nameMatches(rule, name) {
  if (rule.type === 'exact') return rule.value === name;
  if (rule.type === 'prefix') return name.startsWith(rule.value);
  return re(rule.value).test(name);
}

/**
 * @param {ParamRule} rule
 * @param {DecideContext} ctx
 * @param {string | null} value
 * @returns {boolean}
 */
function conditionsOk(rule, ctx, value) {
  const c = rule.conditions;
  if (!c) return true;
  if (c.paths && !c.paths.some((p) => re(p).test(ctx.path))) return false;
  if (c.path_not && c.path_not.some((p) => re(p).test(ctx.path))) return false;
  if (c.value_regex && !re(c.value_regex).test(value || '')) return false;
  if (c.requires_any && !c.requires_any.some((k) => ctx.keys.has(k))) return false;
  if (c.url_contains && !c.url_contains.some((s) => ctx.url.includes(s))) return false;
  if (c.url_not_contains && c.url_not_contains.some((s) => ctx.url.includes(s))) return false;
  if (c.except_hosts && c.except_hosts.some((h) => hostMatches(ctx.host, h))) return false;
  return true;
}

const GLOBAL_RULES = /** @type {ParamRule[]} */ ([...RULES.global, ...RULES.extraGlobal]);
const HOST_BLOCKS = /** @type {HostBlock[]} */ ([...RULES.hosts, ...RULES.extraHosts]);

// Names are compared as written, as the rule table says. A name written entirely in
// capitals (UTM_SOURCE from a QR code, which stores letters in capitals; Microsoft's OCID,
// Bing's FORM) is tried again in small letters when nothing matches it as written.
const ALL_CAPS = /^[A-Z0-9_]*[A-Z][A-Z0-9_]*$/;
// A name in mixed case (Utm_Source, UTM_Source, Fbclid) is tried again in small letters too,
// the same way, with one more guard against catching a site's own word: what it then matches
// must be a distinctive tracker name (a vendor prefix such as utm_, a pattern, or an exact
// name of four or more characters or with an underscore in it), not a short opaque one such
// as gad or awc that a site could use, in other letters, for something else. A rule written
// in mixed case itself (Facebook's Source, LinkedIn's trkInfo) still matches only as written,
// and a protected short name (Ref, T, Hl) is never removed by a global rule whatever its case.
const MIXED_CASE = /[A-Z]/;
/** @param {string} name */
const foldable = (name) => name.length >= 2 && MIXED_CASE.test(name) && name !== name.toLowerCase();
/** @param {{ type: string, value: string }} rule */
const distinctive = (rule) => rule.type !== 'exact' || rule.value.length >= 4 || rule.value.includes('_');

/**
 * @param {string} name
 * @param {string | null} value
 * @param {DecideContext} ctx
 * @returns {{ keep?: KeepEntry, rule: ParamRule } | null}
 */
function decideAs(name, value, ctx) {
  /** @type {{ sc: number, r: ParamRule } | null} */
  let best = null;
  if (!ctx.skipHost) {
    for (const blk of ctx.hostBlocks) {
      for (const r of blk.params) {
        if (!nameMatches(r, name) || !conditionsOk(r, ctx, value)) continue;
        const sc = 20 + SPEC[r.type];
        if (!best || sc > best.sc) best = { sc, r };
      }
    }
  }
  for (const r of GLOBAL_RULES) {
    if (!nameMatches(r, name) || !conditionsOk(r, ctx, value)) continue;
    // Second guard behind the build check: a global rule never removes a protected name
    // unless a vendor companion parameter scopes it.
    if (PROTECTED.has(name) && r.default !== 'keep' && !(r.conditions && r.conditions.requires_any)) continue;
    const sc = 10 + SPEC[r.type];
    if (!best || sc > best.sc) best = { sc, r };
  }
  if (!best) return null;
  const keep = neverEntry(ctx, name);
  return keep ? { keep, rule: best.r } : { rule: best.r };
}

/**
 * @param {DecideContext} ctx
 * @param {string} name
 * @returns {KeepEntry | null}
 */
function neverEntry(ctx, name) {
  for (const e of ctx.never) {
    for (const p of e.params || []) {
      if (p === name || (p.endsWith('*') && name.startsWith(p.slice(0, -1)))) return e;
    }
  }
  return null;
}

/**
 * @param {string} name
 * @param {string | null} value
 * @param {DecideContext} ctx
 * @returns {{ keep?: KeepEntry, rule: ParamRule } | null}
 */
function decide(name, value, ctx) {
  const d = decideAs(name, value, ctx);
  if (d || !foldable(name)) return d;
  // A never_strip entry that names the parameter as written (eBay LH_*) still wins.
  if (neverEntry(ctx, name)) return null;
  const folded = decideAs(name.toLowerCase(), value, ctx);
  if (!folded || ALL_CAPS.test(name) || folded.rule.default === 'keep' || distinctive(folded.rule)) return folded;
  return null;
}

// The canonical-page rule for this host and path, or null. Hosts are matched exactly
// (the pattern is anchored); paths in full, against the path with the parts removed by
// default cut out; then the rule's requires and unless clauses against the parameters.
const CANONICAL = /** @type {CanonicalRule[]} */ (RULES.canonical || []);
/**
 * @param {string} host
 * @param {string} path
 * @param {ParamEnv} env
 * @returns {CanonicalRule | null}
 */
function canonicalRule(host, path, env) {
  for (const c of CANONICAL) {
    if (!reFor(c.host, host).test(host) || !c.paths.some((p) => re(p).test(path))) continue;
    if (c.requires && !c.requires.some((cl) => clauseHolds(cl, env))) continue;
    if (c.unless && c.unless.some((cl) => clauseHolds(cl, env))) continue;
    return c;
  }
  return null;
}

// The parameters a clause is tested against: the first value of each name, from the
// query and then the key=value fragment, decoded; a name with no = has the value ''.
/**
 * @param {string} host
 * @param {string} path
 * @param {Token[]} tokens
 * @returns {ParamEnv}
 */
function paramEnv(host, path, tokens) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const t of tokens) if (t.raw && !map.has(t.name)) map.set(t.name, t.value ?? '');
  return { host, path, map };
}

// A clause holds when every key does. A key is a parameter name, a name ending in * (every
// name starting with it), $host, or $value (the parameter being decided). A regular
// expression must match the value; null means absent or empty.
/**
 * @param {Record<string, string | null>} clause
 * @param {ParamEnv} env
 * @param {string} [self]
 * @returns {boolean}
 */
function clauseHolds(clause, env, self) {
  for (const [k, v] of Object.entries(clause)) {
    /** @type {string[]} */
    let vals;
    if (k === '$host') vals = [env.host];
    else if (k === '$value') vals = [self ?? ''];
    else if (k.endsWith('*')) {
      const pre = k.slice(0, -1);
      vals = [];
      for (const [n, x] of env.map) if (n.startsWith(pre)) vals.push(x);
    } else vals = env.map.has(k) ? [/** @type {string} */ (env.map.get(k))] : [];
    if (v === null) {
      if (vals.some((x) => x !== '')) return false;
    } else if (!vals.some((x) => re(v).test(x))) return false;
  }
  return true;
}

// Whether a keep entry's condition holds for this parameter: its paths, then any clause.
/**
 * @param {{ paths?: string[], any?: Record<string, string | null>[] } | null | undefined} when
 * @param {ParamEnv} env
 * @param {string} self
 * @returns {boolean}
 */
function whenHolds(when, env, self) {
  if (!when) return true;
  if (when.paths && !when.paths.some((p) => re(p).test(env.path))) return false;
  if (when.any && !when.any.some((cl) => clauseHolds(cl, env, self))) return false;
  return true;
}

// The names to look up: as written, and a name in capitals or in mixed case in small
// letters too, as decide() does for the rules (IMG_INDEX, LANG, FORM, Img_Index).
/** @param {string} name */
const lookupNames = (name) => (foldable(name) ? [name, name.toLowerCase()] : [name]);
/**
 * @param {string} pattern
 * @param {string} name
 */
const nameIs = (pattern, name) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name);

/**
 * @param {CanonicalRule | null} canon
 * @param {string} name
 */
function canonKeep(canon, name) {
  if (!canon) return null;
  for (const n of lookupNames(name)) {
    const e = canon.keep.find((k) => nameIs(k.name, n));
    if (e) return e;
  }
  return null;
}

/**
 * @param {CanonicalRule | null} canon
 * @param {string} name
 */
function canonRemove(canon, name) {
  if (!canon || !canon.remove) return null;
  for (const n of lookupNames(name)) {
    const e = canon.remove.find((r) => r.names.some((x) => nameIs(x, n)));
    if (e) return e;
  }
  return null;
}

/**
 * @param {DecideContext} ctx
 * @param {string} name
 * @returns {KeepEntry | null}
 */
function neverFor(ctx, name) {
  for (const n of lookupNames(name)) {
    const e = neverEntry(ctx, n);
    if (e) return e;
  }
  return null;
}

/** @param {{ id: string }} r */
const isGlobalRule = (r) => /^x?g\d/.test(r.id);

// A protected short name in any case (v, T, HL): on a canonical page it is never removed
// by default, because nothing verified says what it does there.
/** @param {string} name */
const isProtected = (name) => PROTECTED.has(name) || PROTECTED.has(name.toLowerCase());

/**
 * @param {KeepEntry} entry
 * @param {string} host
 * @param {string} path
 * @returns {boolean}
 */
function fkApplies(entry, host, path) {
  const named = entry.hosts.filter((h) => h !== '*');
  if (named.length && !named.some((h) => hostMatches(host, h))) return false;
  if (entry.paths && !entry.paths.some((p) => re(p).test(path))) return false;
  return true;
}

/**
 * @param {Layer} layer
 * @param {Token[]} qTokens
 * @param {Token[]} fTokens
 * @param {Token[]} routeTokens
 * @returns {Untouched | null}
 */
function untouchedCheck(layer, qTokens, fTokens, routeTokens) {
  const host = layer.host;
  for (const h of RULES.untouched.hosts) {
    if (hostMatches(host, h.host)) {
      return { id: 'urldefense', reason: 'wrapped', name: h.service, text: `This is a ${h.service} link. CheckLink leaves it exactly as it is; the real address is encoded inside it and is not decoded in this version.` };
    }
  }
  const names = [...qTokens, ...fTokens].filter((t) => t.raw).map((t) => t.name);
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const exact = new Set(names);
  for (const s of RULES.untouched.signed) {
    /** @param {string} n */
    const has = (n) => (s.caseInsensitive ? lower.has(n.toLowerCase()) : exact.has(n));
    if (s.all.every(has) && (!s.any || s.any.some(has))) {
      return { id: 'signed', reason: 'signed', name: s.label, text: `This link carries a signature (${s.label}). Changing any part of it would break it, so CheckLink leaves it exactly as it is. It may give access to a file or an account: share it only with people you trust.` };
    }
  }
  for (const n of [...names, ...routeTokens.filter((t) => t.raw).map((t) => t.name)]) {
    if (RULES.untouched.authParams.includes(n.toLowerCase())) {
      return { id: 'auth', reason: 'auth', name: n, text: `This link carries a sign-in or reset value (${n}). CheckLink leaves it exactly as it is, because changing it can break the sign-in. Whoever opens it may get into the account: do not share it.` };
    }
  }
  return null;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function hiddenIn(value) {
  const tries = [value];
  const once = pctDecodeKeep(value);
  if (once !== value) tries.push(once);
  for (const v of tries) {
    const e = escapeIllegal(v);
    if (webUrl(e)) return e;
    if (/^aHR0c(?:HM6Ly|DovL)/.test(v)) {
      const text = escapeIllegal(base64ToText(v));
      if (text && webUrl(text)) return text;
    }
  }
  return null;
}

/** @param {string} h */
const siteOf = (h) => normHost(h).replace(/^www\./, '');

// The words of a path segment or a parameter name: split at anything that is not a
// letter or digit and between a small letter and a capital (UnsubscribePage).
/** @param {string} s */
const wordsOf = (s) => pctDecode(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// An unsubscribe, preferences or opt-out page, judged from the path segments and the
// parameter names only, never from values (utm_campaign=optout_reminder is not one). A
// segment or name counts when its first or last word is one of the page words.
/**
 * @param {string} path
 * @param {Token[]} tokens
 * @returns {boolean}
 */
function isRecipientPage(path, tokens) {
  const words = RULES.recipientTokens.pageWords;
  /** @param {string} s */
  const hit = (s) => {
    const w = wordsOf(s);
    if (!w.length) return false;
    /**
     * @param {string | undefined} a
     * @param {string | undefined} b
     */
    const join2 = (a, b) => (a && b ? a + b : '');
    const ends = [w[0], w[w.length - 1], join2(w[0], w[1]), join2(w[w.length - 2], w[w.length - 1])];
    return ends.some((x) => words.includes(x));
  };
  return path.split(/[/;]/).some(hit) || tokens.some((t) => t.raw && hit(t.rawName));
}

// == kept on purpose: what each one does ==

// A start time as a link writes it, in seconds (354) or in hours, minutes and seconds
// (1h2m3s, 01h02m03s, 90s), as a clock reads it: 5:54, 1:02:03. Null for anything else.
/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function clockTime(value) {
  const s = String(value ?? '').trim();
  let secs = null;
  const hms = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/i.exec(s);
  if (/^\d{1,6}$/.test(s)) secs = Number(s);
  else if (hms && (hms[1] || hms[2] || hms[3])) secs = Number(hms[1] || 0) * 3600 + Number(hms[2] || 0) * 60 + Number(hms[3] || 0);
  if (secs === null || secs > 359999) return null;
  /** @param {number} n */
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(secs % 60)}` : `${m}:${two(secs % 60)}`;
}

const NOT_YOU = 'It does not identify you.';
/**
 * A start time in words, or otherwise when the value is not one.
 * @param {string} said
 * @param {string} otherwise
 * @returns {(v: string | null) => string}
 */
const at = (said, otherwise) => (v) => {
  const c = clockTime(v);
  return c ? `${said} ${c}.` : otherwise;
};

// Plain words for the parameters people meet most, keyed by the rule that keeps them (a
// functional_keep entry or a canonical rule, which share ids where they cover the same
// page) and the name. A string or a function of the decoded value is a functional choice
// that is the same for everyone who gets the link, so the row adds "It does not identify
// you."; { text } is said as it is, with no such claim. Anything not here is explained by
// its rule's own note.
/** @type {Record<string, string | ((value: string | null) => string) | { text: string }>} */
const KEPT_WORDS = {
  'youtube:v': 'Video: says which video opens.',
  'youtube:t': at('Start time: opens the video at', 'Start time: where the video starts playing.'),
  'youtube:start': at('Start time: the video starts at', 'Start time: where the video starts playing.'),
  'youtube:end': at('End time: the video stops at', 'End time: where the video stops.'),
  'youtube:list': 'Playlist: plays the video as part of a playlist.',
  'youtube:index': 'Playlist position: which video of the playlist this is.',
  'youtube:playlist': 'Playlist: the videos that play after this one.',
  'youtube:loop': 'Loop: plays the video again when it ends.',
  'youtube:lc': 'Comment: points to one comment under the video.',
  'twitch:t': at('Start time: opens the past broadcast at', 'Start time: where the past broadcast starts playing.'),
  'spotify:t': 'Start time: where the episode starts playing.',
  'apple-music-podcasts-i:i': 'Song or episode: picks the song on an album page, or the episode of a podcast.',
  'amazon-product:psc': 'Chosen option: keeps the size or colour that was chosen.',
  'amazon-product:smid': 'Seller: keeps the seller that was chosen.',
  'amazon-product:m': 'Seller: keeps the seller that was chosen.',
  'amazon-music:trackAsin': 'Track: picks the track on an album page.',
  'netflix:jbv': 'Title: says which film or series opens.',
  'google-play:id': 'App: says which app opens.',
  'google-play:c': 'Search category: without it the search page can keep reloading.',
  'ebay-item:var': 'Chosen option: keeps the variation that was chosen.',
  'ebay-item:iid': 'Item: says which item opens.',
  'instagram-post:img_index': 'Slide: picks which slide of a carousel post opens.',
  'spotify-item:highlight': 'Highlight: marks one track on the album or playlist page.',
  'telegram:start': { text: 'Bot start value: handed to the bot when you press Start. Some bots use it as an invite code, which can show who shared the link.' },
  // Interface review of batch 3, finding 12: one sentence per name instead of the whole list.
  'google-search:prmd': { text: 'Google uses it to lay out this results page; removing it was reported to break the page.' },
  'google-search:stick': { text: 'Google uses it to lay out this results page; removing it was reported to break the page.' },
  'bing-search:rdr': { text: 'Bing uses it on this results page; removing it was reported to break the page.' },
  'bing-search:rdrig': { text: 'Bing uses it on this results page; removing it was reported to break the page.' },
};

// The search words themselves, per rule: the same for everyone, but readable by anyone the
// link reaches, so the row says that instead of claiming nothing.
/** @type {Record<string, string[]>} */
const SEARCH_PARAMS = {
  'google-search': ['q'], 'bing-search': ['q'], 'yahoo-search': ['p'], 'yandex-search': ['text'],
  'duckduckgo-search': ['q'], 'brave-search': ['q'], 'startpage-search': ['query', 'q'], 'mojeek-search': ['q'],
  'ecosia-search': ['q'], 'qwant-search': ['q'], 'baidu-search': ['wd', 'word'], 'naver-search': ['query'],
  'searxng-search': ['q'], x: ['q'], 'tiktok-search': ['q'], 'amazon-search': ['k', 'keywords'],
  'ebay-search': ['_nkw'], 'google-play': ['q'], 'google-maps': ['query'],
};
const SEARCH_WORDS = 'The search itself. Everyone who gets this link can read what was searched for.';

/**
 * @param {string | null} ruleId
 * @param {string} name
 * @param {string | null} value
 * @param {string} note
 * @returns {{ explain: string, what: string, neutral: boolean }}
 */
function keptWords(ruleId, name, value, note) {
  const n = foldable(name) ? name.toLowerCase() : name;
  /** @param {string} text */
  const plain = (text) => ({ explain: text, what: text, neutral: false });
  if (ruleId && SEARCH_PARAMS[ruleId] && SEARCH_PARAMS[ruleId].includes(n)) return plain(SEARCH_WORDS);
  const w = ruleId ? KEPT_WORDS[`${ruleId}:${n}`] : undefined;
  if (typeof w === 'string' || typeof w === 'function') {
    const what = typeof w === 'string' ? w : w(value);
    return { explain: `${what} ${NOT_YOU}`, what, neutral: true };
  }
  if (w && w.text) return plain(w.text);
  return plain(note || 'The page needs it.');
}

// == Google Maps context ==

const FEATURE_ID = /^0x[0-9a-f]+:0x[0-9a-f]+$/i;
const COORD = /^-?\d{1,3}(?:\.\d+)?$/;

// A name from the data= blob, for display: + as a space, percent-decoded, invisible
// characters as visible [U+...] marks, shortened past 40 characters.
/**
 * @param {string} raw
 * @returns {string}
 */
function blobName(raw) {
  const text = invisibleChunks(formDecode(raw)).map((c) => (c.invisible ? `[${c.label.split(' ')[0]}]` : c.text)).join('').replace(/\s+/g, ' ').trim();
  // A straight quote would close the quotation marks around the name in the note.
  return text ? shorten(text.replace(/'/g, '\u2019'), 40) : '';
}

/**
 * @param {Layer} layer
 * @returns {MapsContext | null}
 */
function mapsContext(layer) {
  const host = normHost(layer.host);
  if (!hostMatches(host, 'google.*')) return null;
  const path = layer.link.slice(layer.sp.pathStart, layer.sp.pathEnd);
  if (!/^\/maps\/place\//.test(path)) return null;
  const m = /\/data=([^/]*)/.exec(path);
  if (!m) return null;
  const tokens = /** @type {RegExpExecArray[]} */ (m[1].split('!').filter(Boolean).map((t) => /^(\d+)([a-z])(.*)$/i.exec(t)).filter(Boolean))
    .map((x) => ({ key: Number(x[1]), type: x[2], value: x[3] }));
  // The place's own block: the last !3m<n> whose first entry is a feature ID (!1s0x...:0x...).
  let start = -1;
  for (let i = tokens.length - 2; i >= 0; i--) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.key === 3 && t.type === 'm' && next.key === 1 && next.type === 's' && FEATURE_ID.test(next.value)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const size = Number(tokens[start].value) || 0;
  const own = tokens.slice(start + 1, start + 1 + size);
  const lat = own.find((t) => t.key === 3 && t.type === 'd');
  const lng = own.find((t) => t.key === 4 && t.type === 'd');
  let pin = null;
  if (lat && lng && COORD.test(lat.value) && COORD.test(lng.value) && Math.abs(Number(lat.value)) <= 90 && Math.abs(Number(lng.value)) <= 180) {
    pin = { lat: lat.value, lng: lng.value, link: `https://www.google.com/maps/@${lat.value},${lng.value},17z` };
  }
  const place = placeOnly(tokens, start, size);
  // Context comes before the place's own block: words in a !2m..!1s<words> search block,
  // and the name (!2s) of a place met on the way.
  /** @type {MapsContext['context']} */
  const context = [];
  const seen = new Set();
  /**
   * @param {'category' | 'place'} kind
   * @param {string} raw
   */
  const add = (kind, raw) => {
    const name = blobName(raw);
    if (!name || seen.has(`${kind}|${name}`)) return;
    seen.add(`${kind}|${name}`);
    context.push({ kind, name });
  };
  for (let i = 0; i < start; i++) {
    const t = tokens[i];
    if (t.type !== 's' || !t.value) continue;
    const prev = tokens[i - 1];
    if (t.key === 1 && prev && prev.key === 2 && prev.type === 'm' && !FEATURE_ID.test(t.value)) add('category', t.value);
    else if (t.key === 2 && !FEATURE_ID.test(t.value)) add('place', t.value);
  }
  if (!context.length) return null;
  return { context, pin, place };
}

// Place only: the place's own feature ID as Google's cid. tokens[start] is the !3m<size>
// that opens the place's own block and tokens[start + 1] its !1s0x<hex>:0x<hex>. The ID
// counts only when the blob's final !3d and !4d sit inside that block: they are the
// coordinates the link shows, so the place they belong to is the place the link is for.
// The second half must fit Google's 64-bit ID and not be zero; anything else gives null.
/**
 * @param {{ key: number, type: string, value: string }[]} tokens
 * @param {number} start
 * @param {number} size
 * @returns {MapsContext['place']}
 */
function placeOnly(tokens, start, size) {
  /** @param {number} key */
  const lastAt = (key) => {
    for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].key === key && tokens[i].type === 'd') return i;
    return -1;
  };
  /** @param {number} i */
  const inside = (i) => i > start && i <= start + size;
  if (!inside(lastAt(3)) || !inside(lastAt(4))) return null;
  const featureId = tokens[start + 1].value;
  const hex = featureId.slice(featureId.indexOf(':') + 3).replace(/^0+/, '');
  if (!/^[0-9a-f]{1,16}$/i.test(hex)) return null;
  const cid = BigInt(`0x${hex}`).toString();
  return { featureId, cid, link: `https://maps.google.com/?cid=${cid}` };
}

/**
 * @param {MapsContext} ctx
 * @returns {string}
 */
function mapsNote(ctx) {
  /**
   * @param {'category' | 'place'} kind
   * @param {string} one
   * @param {string} many
   */
  const list = (kind, one, many) => {
    const names = ctx.context.filter((c) => c.kind === kind).slice(0, 3).map((c) => `'${c.name}'`);
    if (!names.length) return null;
    return `${names.length === 1 ? one : many} (${names.join(', ')})`;
  };
  // Neutral words (spec decision 10): the same part of the address can hold a category Maps
  // suggested or words someone typed, so it is never called "your search".
  const said = [list('category', 'a category or search words', 'categories or search words'), list('place', 'a place viewed earlier', 'places viewed earlier')].filter(Boolean);
  // The links under the clean link that leave it out: Pin only, Place only, or both.
  const others = [ctx.pin && 'Pin only', ctx.place && 'Place only'].filter(Boolean);
  const pointer = others.length ? ` ${others.join(' and ')}, under the clean link, ${others.length > 1 ? 'leave' : 'leaves'} it out.` : '';
  return `This map address also holds something Maps picked up on the way to this place: ${said.join(' and ')}. Cutting it could break the link, so CheckLink leaves it in.${pointer}`;
}

// == the target ==

// Text from the address for one of CheckLink's own sentences: decoded (%40 reads as @), with
// invisible characters as visible U+ marks, and spaces, line breaks and other characters that
// cannot stand in an address written as %XX again, so the text can never read as a sentence
// of its own (batch 3 security review finding F7). Shortened only past max characters,
// keeping the end, where a look-alike name sits.
/**
 * @param {string} raw
 * @param {number} max
 * @returns {string}
 */
function shownAs(raw, max) {
  const marked = invisibleChunks(pctDecode(raw)).map((c) => (c.invisible ? `[${c.label.split(' ')[0]}]` : escapeIllegal(c.text))).join('');
  const chars = Array.from(marked);
  return chars.length > max ? `${chars.slice(0, Math.floor(max / 2)).join('')}\u2026${chars.slice(-Math.floor(max * 0.375)).join('')}` : marked;
}

/**
 * @param {Layer} layer
 * @param {Warnings} warnings
 * @returns {{ parts: Part[], kept: Kept[], model: PieceModel, partIds: Set<string>, defaultRemoved: string[],
 *   untouched: Untouched | null, hidden: Hidden[] }}
 */
function planTarget(layer, warnings) {
  const { link, sp } = layer;
  const host = normHost(layer.host);
  /** @type {Part[]} */
  const parts = [];
  /** @type {Kept[]} */
  const kept = [];
  /** @type {PieceModel['pathParts']} */
  const pathParts = [];
  const path = link.slice(sp.pathStart, sp.pathEnd);
  const queryText = sp.qIdx >= 0 ? link.slice(sp.qIdx + 1, sp.hIdx >= 0 ? sp.hIdx : link.length) : null;
  const fragText = sp.hIdx >= 0 ? link.slice(sp.hIdx + 1) : null;
  const qTokens = queryText === null ? [] : tokenise(queryText, sp.qIdx + 1);
  const fParams = paramFragment(fragText);
  const fTokens = fParams ? tokenise(fragText, sp.hIdx + 1) : [];
  const rq = lookOnlyQuery(fragText);
  const routeTokens = rq ? tokenise(rq, 0) : [];

  const untouched = untouchedCheck(layer, qTokens, fTokens, routeTokens);
  const fk = /** @type {KeepEntry[]} */ (RULES.functionalKeep);
  const skipAll = !untouched && fk.some((e) => e.effect === 'skip_all_rules' && fkApplies(e, host, path));

  // 0. An address disguise: a user name (and password) before @. Everything before the
  // last @ of the authority, the @ included, is one part. Not on a link left untouched. A
  // host where the table leaves every parameter alone (accounts.google.com) still gets it:
  // that entry is about parameters, not the address (batch 3 review finding P9).
  /** @type {PieceModel['userinfo']} */
  let userinfo = null;
  if (!untouched && (layer.url.username || layer.url.password)) {
    const at = layer.authority.lastIndexOf('@');
    if (at > 0) {
      const text = link.slice(sp.authStart, sp.authStart + at + 1);
      const look = shownAs(text.slice(0, -1), 80);
      const kind = userinfoKind(layer);
      let name = 'Address disguise';
      let reveals = `Everything before @ is not where this goes. It is there to make the address look like ${look}. The link goes to ${placeName(layer.host)}.`;
      if (kind === 'backslash') {
        // What a person reads as the host sits after the backslash, not in the user name.
        const reads = shownAs(writtenHostOf(layer.naive), 80);
        reveals = `Everything before @ is not where this goes. The address is made to read as ${reads}, but a backslash cuts it short: the link goes to ${placeName(layer.host)}. The clean link still shows ${reads} after the backslash.`;
      } else if (kind === 'sign-in') {
        name = 'Sign-in details in the address';
        reveals = layer.url.password
          ? 'A user name and password written into the address. Anyone who gets the link can read them. Untick it only if this site needs them to let you in.'
          : 'A user name written into the address. Anyone who gets the link can read it. Untick it only if this site needs it to let you in.';
      }
      userinfo = { start: sp.authStart, end: sp.authStart + at + 1, id: 'u0' };
      parts.push({
        id: 'u0', where: 'userinfo', name, value: look, provider: null, reveals,
        unique: false, affiliate: null, defaultRemove: true, ask: false, family: null, rule: 'address-disguise', breakage: null, text,
        unrecognised: false, tier: 'check', disguise: kind,
      });
      // The row explains it, so the warning only has to say where the link goes.
      const goes = placeName(layer.host);
      warnings.replace('at-trick', `The part before @ is not where this goes. It goes to ${goes}.`, kind === 'sign-in'
        ? `Sign-in details are written into this address, before the @. Anyone who gets the link can read them. It goes to ${goes}.`
        : `This address is made to look like a different site. It goes to ${goes}: make sure that is the site you expected.`);
    }
  }

  if (!untouched && !skipAll) {
    const skipHost = fk.some((e) => e.effect === 'skip_host_rules' && fkApplies(e, host, path));
    const skipParams = fk.some((e) => e.effect === 'skip_all_params' && fkApplies(e, host, path));
    const never = fk.filter((e) => e.effect === 'never_strip' && fkApplies(e, host, path));
    const hostBlocks = HOST_BLOCKS.filter((b) => b.patterns.some((p) => hostMatches(host, p)));

    // 1. Tracking in the path. Positions already taken are marked once, so overlapping
    // matches are refused in time proportional to their own length.
    /** @type {{ start: number, end: number, pr: PathRule, text: string }[]} */
    const spans = [];
    const taken = new Uint8Array(path.length);
    for (const pr of /** @type {PathRule[]} */ (RULES.pathRules)) {
      if (!pr.hosts.some((h) => hostMatches(host, h))) continue;
      for (const m of path.matchAll(re(pr.regex, `g${pr.flags}`))) {
        if (!m[0]) continue;
        const a = m.index;
        const b = a + m[0].length;
        let free = true;
        for (let k = a; k < b; k++) {
          if (taken[k]) {
            free = false;
            break;
          }
        }
        if (!free) continue;
        taken.fill(1, a, b);
        spans.push({ start: sp.pathStart + a, end: sp.pathStart + b, pr, text: m[0] });
      }
    }
    spans.sort((a, b) => a.start - b.start);
    // The path the conditions of the query rules see: with the parts removed by default cut out.
    let strippedPath = '';
    let at = sp.pathStart;
    spans.forEach((s, i) => {
      const id = `p${i}`;
      pathParts.push({ start: s.start, end: s.end, id });
      const value = s.text.replace(/^[/;][^=]*=/, '');
      parts.push({
        id, where: 'path', name: s.pr.name, value: shorten(pctDecode(value)), provider: s.pr.provider, reveals: s.pr.reveals,
        unique: s.pr.unique || looksRandom(value), affiliate: null, defaultRemove: s.pr.default === 'strip', ask: s.pr.default === 'ask',
        family: s.pr.family, rule: s.pr.id, breakage: null, text: s.text, unrecognised: false,
      });
      if (s.pr.default === 'strip') {
        strippedPath += link.slice(at, s.start);
        at = s.end;
      }
      if (s.pr.warning) warnings.add(s.pr.id, 'info', s.pr.warning);
    });
    strippedPath += link.slice(at, sp.pathEnd);

    // 2. Query parameters, then 3. key=value pairs in the fragment.
    const rt = RULES.recipientTokens;
    const recipientPage = isRecipientPage(path, qTokens);
    // A page fully addressed by its path. Not where the table says to leave the host's
    // rules or every parameter alone.
    const env = paramEnv(host, strippedPath, [...qTokens, ...fTokens]);
    const canon = skipHost || skipParams ? null : canonicalRule(host, strippedPath, env);
    /**
     * @param {Token[]} tokens
     * @param {'query' | 'fragment'} where
     * @param {string} prefix
     */
    const runList = (tokens, where, prefix) => {
      const keys = new Set(tokens.filter((t) => t.raw).map((t) => t.name));
      const ctx = { host, path: strippedPath, url: link, keys, skipHost, never, hostBlocks };
      // Kept on purpose: the parameter gets its own id, so the page can mark it and
      // "Remove anyway" can take it out; it is never removed by default.
      /**
       * @param {Token} t
       * @param {number} i
       * @param {Kept['reason']} reason
       * @param {string} note
       * @param {string | null} ruleId
       */
      const keep = (t, i, reason, note, ruleId) => {
        t.id = `${prefix}${i}`;
        const words = reason === 'recipient-token'
          ? { explain: `Kept because this unsubscribe or preferences page needs it. ${note}`, what: `Kept because this unsubscribe or preferences page needs it. ${note}`, neutral: false }
          : keptWords(ruleId, t.name, t.value, note);
        kept.push({ id: t.id, name: t.name, where, reason, note, rule: ruleId || null, value: shorten(pctDecode(t.rawValue ?? '')), text: t.raw, ...words });
      };
      tokens.forEach((t, i) => {
        if (!t.raw) return;
        if (recipientPage && rt.params.includes(t.name)) {
          keep(t, i, 'recipient-token', rt.note, null);
          warnings.add('recipient-token', 'info', `${t.name} stays because this unsubscribe or preferences page needs it. ${rt.note}`);
          return;
        }
        const d = decide(t.name, t.value, ctx);
        // A global keep rule is generic; a page's own remove list was verified there.
        const overridden = d && !d.keep && d.rule.default === 'keep' && isGlobalRule(d.rule) && canonRemove(canon, t.name);
        if (!d || overridden) {
          // No verified rule names it. What a functional_keep entry or the canonical keep
          // list keeps is listed on every page, so the same parameter reads the same
          // wherever it appears (youtu.be and a Short alike).
          const self = t.value ?? '';
          const ck = canonKeep(canon, t.name);
          const value = () => shorten(pctDecode(t.rawValue ?? ''));
          // A guess from the value's shape only, so plain words in base64 do not count.
          const shapeUnique = () => looksRandom(t.value) && !base64Words(pctDecode(t.rawValue ?? ''));
          /**
           * @param {string} provider
           * @param {string} reveals
           * @param {boolean} unique
           * @param {{ empty?: boolean }} [extra]
           */
          const verifiedPart = (provider, reveals, unique, extra = {}) => {
            t.id = `${prefix}${i}`;
            parts.push({
              id: t.id, where, name: t.name, value: value(), provider, reveals, unique, affiliate: null, defaultRemove: true, ask: false,
              family: /** @type {CanonicalRule} */ (canon).family, rule: `verified-page:${/** @type {CanonicalRule} */ (canon).id}`, breakage: null, text: t.raw, unrecognised: false, ...extra,
            });
          };
          // ck is found only on a canonical page, so canon is set wherever ck is.
          if (ck && /** @type {CanonicalRule} */ (canon).dropEmpty && self === '') {
            verifiedPart(/** @type {CanonicalRule} */ (canon).platform, /** @type {string} */ (/** @type {CanonicalRule} */ (canon).emptyReveals), false, { empty: true });
            return;
          }
          if (ck && whenHolds(ck.when, env, self)) {
            keep(t, i, 'functional', ck.note, /** @type {CanonicalRule} */ (canon).id);
            return;
          }
          const never = neverFor(ctx, t.name);
          if (never) {
            keep(t, i, 'functional', never.note, never.id);
            return;
          }
          if (!canon) return;
          if (ck && ck.otherwise) {
            verifiedPart(ck.otherwise.provider, ck.otherwise.reveals, shapeUnique());
            return;
          }
          const rm = canonRemove(canon, t.name);
          if (rm) {
            // The entry says whether its value is unique to the click (a search ID) or the
            // same for everyone (a display setting); only when it says neither does the
            // value's shape decide.
            verifiedPart(rm.provider, rm.reveals, rm.perClick !== undefined ? !!rm.perClick : shapeUnique());
            return;
          }
          // On a canonical page it is an Unrecognised part: removed by default, or asked
          // when it is a protected short name.
          const ask = isProtected(t.name);
          t.id = `${prefix}${i}`;
          parts.push({
            id: t.id, where, name: t.name, value: value(), provider: canon.provider,
            reveals: ask ? canon.askReveals : canon.reveals,
            unique: shapeUnique(), affiliate: null, defaultRemove: !ask, ask,
            family: canon.family, rule: `canonical:${canon.id}`, breakage: null, text: t.raw, unrecognised: true,
          });
          return;
        }
        if (d.keep) {
          keep(t, i, 'functional', d.keep.note, d.keep.id);
          return;
        }
        const r = d.rule;
        if (r.default === 'keep') {
          keep(t, i, 'functional', r.reveals, r.id);
          return;
        }
        t.id = `${prefix}${i}`;
        parts.push({
          id: t.id, where, name: t.name, value: shorten(pctDecode(t.rawValue ?? '')), provider: r.provider, reveals: r.reveals,
          unique: r.perClick || (!r.sharer && looksRandom(t.value)), affiliate: r.affiliate, defaultRemove: r.default === 'strip', ask: r.default === 'ask',
          family: r.family, rule: r.id, breakage: r.breakage, text: t.raw, unrecognised: false,
          ...(r.sharer ? { sharer: true } : {}),
          ...(r.recipient ? { recipient: true } : {}),
        });
      });
    };
    if (!skipParams) runList(qTokens, 'query', 'q');
    runList(fTokens, 'fragment', 'f');
  }

  // Kept parameters count as choices too: their ids can be passed to clean() to remove them.
  const partIds = new Set([...parts.map((p) => p.id), ...kept.map((k) => k.id)]);
  const model = {
    link, pathStart: sp.pathStart, pathEnd: sp.pathEnd, pathParts, userinfo,
    query: sp.qIdx >= 0 ? { mark: sp.qIdx, tokens: qTokens } : null,
    frag: sp.hIdx >= 0 ? { mark: sp.hIdx, tokens: fParams ? fTokens : null, text: fragText } : null,
  };
  const defaultRemoved = parts.filter((p) => p.defaultRemove).map((p) => p.id);

  // Addresses hidden in what stays (warning 8).
  /** @type {Hidden[]} */
  const hidden = [];
  const seen = new Set();
  const keptIds = new Set(kept.map((k) => k.id));
  /**
   * @param {Hidden['where']} where
   * @param {string | null} name
   * @param {string} value
   * @param {boolean} [isKept]
   */
  const addHidden = (where, name, value, isKept = false) => {
    const inner = hiddenIn(value);
    if (!inner || seen.has(inner)) return;
    seen.add(inner);
    // hiddenIn returns only what webUrl accepts.
    const u = /** @type {URL} */ (webUrl(inner));
    // shownName: the name as CheckLink's own sentences show it, with spaces and line breaks
    // written as %XX, so a name cannot add words of its own (as for the disguise, F7).
    hidden.push({ where, name, shownName: name === null ? null : shownAs(name, 60), link: inner, host: u.hostname, sameHost: siteOf(u.hostname) === siteOf(host), kept: isKept, text: value });
  };
  const defaults = new Set(defaultRemoved);
  for (const t of qTokens) if (t.raw && t.rawValue && !(t.id && defaults.has(t.id))) addHidden('query', t.name, t.rawValue, !!t.id && keptIds.has(t.id));
  for (const t of fTokens) if (t.raw && t.rawValue && !(t.id && defaults.has(t.id))) addHidden('fragment', t.name, t.rawValue, !!t.id && keptIds.has(t.id));
  const inPath = /(https?(?::|%3A)(?:\/\/|%2F%2F)[^?#]*)/i.exec(path.slice(1));
  if (inPath) addHidden('path', null, inPath[1]);

  return { parts, kept, model, partIds, defaultRemoved, untouched, hidden };
}

/**
 * @param {PieceModel} model
 * @param {Set<string>} partIds
 * @param {Set<string>} removed
 * @returns {Segment[]}
 */
function buildPieces(model, partIds, removed) {
  const { link } = model;
  const any = [...removed].some((id) => partIds.has(id));
  /** @type {Segment[]} */
  const pieces = [];
  /**
   * @param {string | null} text
   * @param {boolean} isRemoved
   * @param {string | null} [partId]
   */
  const push = (text, isRemoved, partId) => {
    if (!text) return;
    const last = pieces[pieces.length - 1];
    if (last && last.removed === isRemoved && last.partId === (partId ?? null)) last.text += text;
    else pieces.push({ text, removed: isRemoved, partId: partId ?? null });
  };
  if (model.userinfo) {
    const ui = model.userinfo;
    push(link.slice(0, ui.start), false, null);
    push(link.slice(ui.start, ui.end), removed.has(ui.id), ui.id);
    push(link.slice(ui.end, model.pathStart), false, null);
  } else push(link.slice(0, model.pathStart), false, null);
  let p = model.pathStart;
  for (const part of model.pathParts) {
    push(link.slice(p, part.start), false, null);
    push(link.slice(part.start, part.end), removed.has(part.id), part.id);
    p = part.end;
  }
  push(link.slice(p, model.pathEnd), false, null);

  /**
   * @param {string} markChar
   * @param {Token[]} tokens
   */
  const emitList = (markChar, tokens) => {
    const keep = tokens.map((t) => (any ? t.raw !== '' && !(t.id && removed.has(t.id)) : true));
    const firstKept = keep.indexOf(true);
    const firstRemovedId = (tokens.find((t) => t.id && removed.has(t.id)) || {}).id ?? null;
    push(markChar, firstKept < 0, firstKept < 0 ? firstRemovedId : null);
    tokens.forEach((t, i) => {
      if (i > 0) {
        const sepKept = !any || (keep[i] && i > firstKept);
        let sepId = null;
        if (!sepKept) {
          if (t.id && removed.has(t.id)) sepId = t.id;
          else if (tokens[i - 1].id && removed.has(/** @type {string} */ (tokens[i - 1].id))) sepId = tokens[i - 1].id;
        }
        push('&', !sepKept, sepId);
      }
      push(t.raw, !keep[i], t.id);
    });
  };
  if (model.query) emitList('?', model.query.tokens);
  if (model.frag) {
    if (model.frag.tokens) emitList('#', model.frag.tokens);
    else {
      push('#', any && model.frag.text === '', null);
      push(model.frag.text, false, null);
    }
  }
  return pieces;
}

/** @param {Segment[]} pieces */
const piecesText = (pieces) => pieces.filter((x) => !x.removed).map((x) => x.text).join('');

// == analysis ==

/**
 * @param {string} link
 * @param {{ bare?: boolean, depth?: number }} [options]
 * @returns {LinkAnalysis}
 */
function analyseLink(link, { bare = false, depth = 0 } = {}) {
  const warnings = new Warnings();
  /** @type {{ layer: Layer, rd: RedirectRule }[]} */
  const layers = [];
  // Every link analysed here was accepted by findLinks or hiddenIn, so it parses.
  let cur = /** @type {Layer} */ (parseLayer(link, bare));
  /** @type {ShortLink | null} */
  let shortLink = null;
  /** @type {Offer | null} */
  let offer = null;
  for (;;) {
    hostChecks(cur, warnings);
    const rd = findRedirect(cur);
    if (!rd) break;
    if (layers.length >= MAX_UNWRAP) {
      warnings.add('deep-wrapper', 'check', `This link is wrapped more than ${MAX_UNWRAP} times. CheckLink stopped unwrapping at ${cur.host}.`);
      break;
    }
    if (!rd.offline) {
      shortLink = shortLinkFromRule(rd, cur);
      break;
    }
    const inner = extractTarget(rd, cur);
    if (inner === AMBIGUOUS) {
      shortLink = shortLinkFromRule(rd, cur);
      warnings.add('two-destinations', 'check', `This link names two different addresses in the same place, and only ${cur.host} decides which one it opens, so CheckLink does not unwrap it.`);
      break;
    }
    if (!inner) {
      shortLink = shortLinkFromRule(rd, cur);
      break;
    }
    // Past the two checks above, inner is an address: the checker cannot narrow by AMBIGUOUS.
    if (rd.action === 'offer') {
      shortLink = shortLinkFromRule(rd, cur);
      offer = { id: rd.id, label: rd.label, link: /** @type {string} */ (inner) };
      break;
    }
    if (rd.action === 'show') break; // a share intent: its url= is shown as a hidden address
    // A browser keeps the fragment across a redirect whose target has none of its own, so
    // the outer #section travels on to the address inside.
    const outerFrag = cur.sp.hIdx >= 0 ? cur.link.slice(cur.sp.hIdx) : '';
    const address = /** @type {string} */ (inner);
    const next = parseLayer(outerFrag.length > 1 && !address.includes('#') ? address + outerFrag : address, false);
    if (!next) break;
    layers.push({ layer: cur, rd });
    if (SAFE_LINKS_IDS.has(rd.id)) {
      warnings.add('safelinks', 'info', "This link was wrapped by Microsoft's Safe Links. The clean link goes straight to the real address, so opening it skips Microsoft's click-time check.");
    }
    cur = next;
  }
  const target = cur;
  targetChecks(target, warnings);
  // Stage 3: does the address the clean link goes to imitate a listed brand (src/brands.js)? Not
  // asked of a host that a verified wrapper rule names (microsoft.msafflnk.net is Microsoft's
  // affiliate service): that is a known service, whatever its name says. When the look-alike is
  // made of letters or symbols the notes above already describe, the brand is named in that note
  // rather than in a second one.
  const brand = findRedirect(target) ? null : brandMatch(target.host);
  const targetLetters = lettersFinding(target.host);
  if (brand) {
    const letters = targetLetters;
    const symbol = symbolFinding(target.host);
    if (brand.kind === 'letters' && letters) {
      if (letters.ordinary) warnings.add('look-alike-letters', 'check', lettersText(letters, brand), { short: lettersShort(letters, brand) });
      else warnings.replace('look-alike-letters', lettersText(letters), lettersText(letters, brand), { short: lettersShort(letters, brand) });
    } else if (brand.kind === 'letters' && symbol) {
      warnings.replace('look-alike-symbol', symbolText(symbol), symbolText(symbol, brand), { short: symbolShort(symbol, brand) });
    } else {
      warnings.add('look-alike-brand', 'check', brandText(brand, placeName), { short: brandShort(brand) });
    }
  }
  // The letters from another alphabet in the address the clean link goes to, when CheckLink says
  // so in a note: the page boxes them where it shows the address (interface review M1).
  const lookAlikeLetters = targetLetters && (!targetLetters.ordinary || (brand && brand.kind === 'letters')) ? targetLetters.foreign : [];
  // Who owns the address (stage 2, the Public Suffix List). An address under a name whose owner
  // lets anyone make addresses (github.io, blogspot.com, co.no) is good to know about. A brand
  // note about a name under one already says so.
  const site = domainInfo(normHost(target.host));
  if (site && site.private && site.domain && !(brand && brand.private)) {
    warnings.add('shared-domain', 'info', `Anyone can make an address under ${site.suffix}, so ${site.domain} belongs to whoever made it, not necessarily to whoever runs ${site.suffix}.`);
  }
  const shownDomain = site && site.domain ? writtenDomain(target.writtenHost, target.host, site.domain) : null;

  if (!shortLink) {
    const sl = RULES.shortLinks.find((s) => hostMatches(target.host, s.host));
    if (sl) shortLink = { id: `short:${sl.host}`, service: sl.service, label: `${sl.service} (${sl.host})`, host: target.host, kind: sl.kind, note: null };
  }
  if (shortLink) shortLinkWarning(shortLink, warnings);

  const plan = planTarget(target, warnings);
  if (plan.untouched) warnings.add('untouched', 'check', plan.untouched.text);
  // Context in a Maps place link's data= blob: explained, and left as it is.
  const maps = plan.untouched ? null : mapsContext(target);
  if (maps) warnings.add('maps-context', 'info', mapsNote(maps));

  for (const h of plan.hidden) {
    const where = h.where === 'path' ? 'in its path' : `in ${h.shownName}=`;
    // A parameter the page needs (Brave's goggles_id, Bing's mediaurl) holds its address on
    // purpose, so that is only good to know.
    h.analysis = depth < MAX_HIDDEN_DEPTH ? analyseLink(h.link, { depth: depth + 1 }) : null;
    // A look-alike in the address hidden inside is said on the first screen, not only after
    // "Check this address" (look-alike review L4). That one note names the address and where it
    // is hidden, so the plain hidden-address note is left out rather than said twice (interface
    // review of stage 3).
    const look = h.analysis && h.analysis.warnings.find((w) => LOOK_ALIKE_IDS.has(w.id));
    if (look) {
      warnings.add('hidden-look-alike', 'check', `About the address hidden inside this link (${where}): ${look.text}`,
        { short: look.short ? look.short.replace(/^This address/, 'The address hidden inside this link') : null });
    } else if (h.kept) {
      warnings.add('hidden-address', 'info', `This link holds a second address (${where}), which the page needs. It points to ${placeName(h.host)}.`);
    } else {
      warnings.add('hidden-address', h.sameHost ? 'info' : 'check', `A second address is hidden inside this link (${where}). It points to ${placeName(h.host)}.`);
    }
  }

  /** @type {Part[]} */
  const wrapperParts = layers.map(({ layer, rd }, i) => {
    const others = tokenise(rawQuery(layer), 0).some((t) => t.value && looksRandom(t.value));
    return {
      id: `w${i}`, where: 'wrapper', name: rd.label, value: shorten(layer.link), provider: rd.family, reveals: wrapperReveals(rd),
      unique: rd.id === 'outlook-safelinks' || recipientWrapper(rd) || others,
      // Affiliate credit rides on the destination's own parameters (cjevent, irclickid), so
      // the "keep affiliate credit" choice keeps those and still drops the wrapper.
      affiliate: null,
      defaultRemove: true, ask: false, family: rd.family, rule: rd.id, breakage: null, text: layer.link, unrecognised: false,
    };
  });
  const parts = [...wrapperParts, ...plan.parts];
  const defaultRemoved = [...wrapperParts.map((p) => p.id), ...plan.defaultRemoved];

  // The clean text for a choice, and the host it must go to: the first wrapper kept, or
  // the target.
  /** @param {Set<string>} set */
  const rawClean = (set) => {
    for (let i = 0; i < layers.length; i++) if (!set.has(`w${i}`)) return layers[i].layer.link;
    const text = piecesText(buildPieces(plan.model, plan.partIds, set));
    // A bare link starts with www., so its disguise holds the www. and what is left
    // (evil.example/login) no longer reads as a link anywhere it is pasted: it gets https://
    // in front (batch 3 review finding P4).
    return !layers.length && bare && plan.model.userinfo && set.has(plan.model.userinfo.id) ? `https://${text}` : text;
  };
  /** @param {Set<string>} set */
  const hostFor = (set) => {
    for (let i = 0; i < layers.length; i++) if (!set.has(`w${i}`)) return layers[i].layer.host;
    return target.host;
  };
  /** @param {string} text */
  const withScheme = (text) => (/^https?:\/\//i.test(text) ? text : `https://${text}`);
  // The hard check: a choice whose clean link would go to any other host removes nothing.
  /** @param {IdChoice} ids */
  const resolve = (ids) => {
    const set = toIdSet(ids) ?? new Set(defaultRemoved);
    const u = webUrl(withScheme(rawClean(set)));
    return u && u.hostname === hostFor(set) ? set : new Set();
  };
  /** @param {IdChoice} [ids] */
  const targetSegmentsFor = (ids) => buildPieces(plan.model, plan.partIds, resolve(ids));
  /** @param {IdChoice} [ids] */
  const clean = (ids) => rawClean(resolve(ids));
  /** @param {IdChoice} [ids] */
  const openUrl = (ids) => withScheme(clean(ids));
  /**
   * @param {IdChoice} [ids]
   * @returns {Segment[]}
   */
  const segmentsFor = (ids) => {
    if (!layers.length) return targetSegmentsFor(ids);
    return [{ text: link, removed: resolve(ids).has('w0'), partId: 'w0' }];
  };

  const wrappers = layers.map(({ layer, rd }, i) => ({
    depth: i, id: rd.id, label: rd.label, family: rd.family, link: layer.link, host: layer.host, site: domainInfo(normHost(layer.host)), note: rd.note,
    partId: `w${i}`, segments: [{ text: layer.link, removed: true, partId: `w${i}` }],
  }));

  const cleanLink = clean();
  return {
    found: true,
    kind: 'web',
    link,
    bare,
    prefix: bare ? 'https://' : '',
    host: target.host,
    hostAsWritten: target.writtenHost,
    site,
    domain: site ? site.domain : null,
    domainAsWritten: shownDomain ? shownDomain.text : null,
    domainStart: shownDomain ? shownDomain.start : -1,
    segments: segmentsFor(),
    segmentsFor,
    target: {
      link: target.link, host: target.host, hostAsWritten: target.writtenHost, segments: targetSegmentsFor(), segmentsFor: targetSegmentsFor,
      domainAsWritten: shownDomain ? shownDomain.text : null, domainStart: shownDomain ? shownDomain.start : -1,
    },
    wrappers,
    parts,
    kept: plan.kept,
    maps,
    untouched: plan.untouched,
    shortLink,
    offer,
    hidden: plan.hidden,
    warnings: warnings.sorted(),
    lookAlikeLetters,
    defaultRemoved,
    clean,
    openUrl,
    cleanLink,
    changed: cleanLink !== link,
    rulesDate: RULES_DATE,
  };
}

/**
 * @param {string} input
 * @param {'script' | 'none'} kind
 * @param {Warning[]} warnings
 * @param {string[]} others
 * @returns {EmptyAnalysis}
 */
function emptyResult(input, kind, warnings, others) {
  return {
    found: false, kind, input, link: null, start: -1, end: -1, bare: false, prefix: '', others,
    host: null, hostAsWritten: null, site: null, domain: null, domainAsWritten: null, domainStart: -1, segments: [], segmentsFor: () => [],
    target: null, wrappers: [], parts: [], kept: [], maps: null, untouched: null, shortLink: null, offer: null, hidden: [], lookAlikeLetters: [],
    warnings, defaultRemoved: [], clean: () => '', openUrl: () => '', cleanLink: '', changed: false, rulesDate: RULES_DATE,
  };
}

/**
 * @param {unknown} input
 * @returns {Analysis}
 */
export function analyse(input) {
  const text = String(input ?? '');
  const { links, unreadable } = findLinks(text);
  const lead = text.replace(/[\t\n\r]/g, '').replace(LEAD, '');
  const script = SCRIPT_SCHEMES.exec(lead) || (!links.length && SCRIPT_ANYWHERE.exec(text.replace(/[\t\n\r]/g, '')));
  if (script) {
    const scheme = (script[1] || script[2] || script[3]).toLowerCase();
    return emptyResult(text, 'script', [{
      id: 'script', tier: 'stop',
      text: `This is a ${scheme}: link. It runs code or opens something on the device instead of going to a web address, so CheckLink does not treat it as a link and never opens it.`,
    }], links.map((l) => l.link));
  }
  if (!links.length) {
    /** @type {Warning[]} */
    const warnings = unreadable.length
      ? [{ id: 'unreadable', tier: 'check', text: 'This looks like a link, but a browser cannot read it as an address. It may contain characters that do not belong in one.' }]
      : [];
    return emptyResult(text, 'none', warnings, []);
  }
  const first = links[0];
  const res = analyseLink(first.link, { bare: first.bare });
  // res carries found: true and kind: 'web' as well; these two stay first, for the same key order.
  return { found: true, kind: 'web', input: text, start: first.start, end: first.end, others: links.slice(1).map((l) => l.link), .../** @type {Omit<LinkAnalysis, 'found' | 'kind'>} */ (res) };
}

// == "Did CheckLink break your link? Email us" ==

export const REPORT_TO = 'info@stormberry.as';
export const REPORT_SUBJECT = 'CheckLink: a cleaned link broke';
const REPORT_MAX = 1800;

// Parameter names are compared in small letters with the hyphens, underscores and full stops
// between their letters left out, so authToken, auth_token and auth-token are one name (stage 4b
// security review S1). Those at either end stay: Drip's __s is not s, and HubSpot's _hsenc keeps
// its underscore.
/** @param {string} n */
const normName = (n) => n.toLowerCase().replace(/(?<=[\p{L}\p{N}])[-_.]+(?=[\p{L}\p{N}])/gu, '');
// Names whose value signs someone in, resets a password or unlocks an account: the
// leave-untouched list, LinkedIn's otpToken, and password, passcode, key and session names
// that cleaning leaves alone but a report must never carry (batch 3 security review F5). Stage
// 4b (security review S1) adds the session, key, ticket and one-time-code names of the common
// web frameworks and sign-in protocols (PHP, ASP, Java, OAuth 1, SAML, Amazon's temporary keys).
const REPORT_SECRET_NAMES = [
  'otptoken', 'pwd', 'password', 'passwd', 'passcode', 'otp', 'apikey', 'api_key', 'api-key', 'x-api-key', 'access_key', 'secret_key', 'client_secret', 'private_token', 'sessionid', 'session_id',
  'sid', 'sessid', 'phpsessid', 'aspsessionid', 'jsessionid', 'session', 'sessionkey', 'sessiontoken', 'auth', 'authkey', 'authtoken', 'accesstoken', 'apitoken', 'access_key_id',
  'secret', 'privatekey', 'ticket', 'oauth_token', 'oauth_verifier', 'samlresponse', 'samlrequest', 'x-amz-security-token', 'x-amz-credential', 'token_hash',
  'otp_code', 'verification_code', 'activation_code', 'pw', 'pass', 'pin',
];
const SIGN_IN_NAMES = new Set([...RULES.untouched.authParams, ...REPORT_SECRET_NAMES].map(normName));
// Parts of a name that mark a sign-in, key or session value wherever they sit in it
// (csrf_token, user_session, my_secret, passwort, x-client-credential).
const SIGN_IN_WORDS = ['token', 'secret', 'passw', 'session', 'apikey', 'credential'];
// A signature that proves a link was issued by its site, as signed download and sign-in links
// carry it (Laravel's signature, Azure's sig on its own, an HMAC).
const SIGNED_NAMES = new Set(['sig', 'signature', 'hmac'].map(normName));
const EMAIL_NAMES = new Set(['email', 'e-mail', 'mail', 'email_address', 'emailaddress', 'user_email', 'useremail', 'recipient'].map(normName));
// Names that identify the person a message was sent to: the recipient tokens, LinkedIn's
// midToken, and every name a global rule says identifies the recipient (F2). An email
// address keeps its own reason.
const RECIPIENT_NAMES = new Set([
  ...RULES.recipientTokens.params,
  'midtoken',
  ...GLOBAL_RULES.filter((r) => r.recipient && r.type === 'exact').map((r) => r.value),
].map(normName).filter((n) => !EMAIL_NAMES.has(n)));
// Personal details by name (stage 4b security review S1): a phone number, and an identity
// number or a date of birth, including the national numbers of Norway (fodselsnummer),
// Sweden (personnummer), Brazil (CPF) and Portugal (NIF).
const PHONE_NAMES = new Set(['phone', 'phonenumber', 'phone_number', 'telephone', 'tel', 'mobile', 'mobilenumber', 'mobilephone', 'cellphone', 'msisdn'].map(normName));
const ID_NAMES = new Set(['ssn', 'fnr', 'fodselsnummer', 'f\u00f8dselsnummer', 'personnummer', 'personnr', 'cpf', 'nif', 'dob', 'birthdate', 'dateofbirth', 'date_of_birth', 'birthday'].map(normName));
// A JSON Web Token anywhere in a link: a header and a payload, each JSON written in base64url
// (so each starts eyJ), then a signature. It signs someone in whatever the name it travels under.
const JWT_IN = /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/;
// A sign-in, reset or confirmation link that carries its token in the path instead of a named
// parameter (stage 4b security review S2): Laravel's /password/reset/<token>, Django's
// /reset/<uid>/<token>/, Slack's /magic-login/<token>. A path segment naming such a step, as a
// whole word of it (author is not auth), followed within two segments by one shaped like a token.
const PATH_STEP_WORDS = new Set(['reset', 'password', 'passwordless', 'magic', 'login', 'signin', 'logon', 'verify', 'verification', 'confirm', 'confirmation', 'activate', 'activation', 'otp', 'auth', 'onetime', 'token']);
// A token: 16 or more letters, digits, hyphens or underscores, with at least one letter and one
// digit, so an ordinary word or a number in a path is not one.
/** @param {string} seg */
const tokenShaped = (seg) => seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg);
/**
 * @param {string} path
 * @returns {boolean}
 */
function pathSignIn(path) {
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    const words = segs[i].toLowerCase().split(/[-_.]+/).filter(Boolean);
    if (!words.length || !(words.some((w) => PATH_STEP_WORDS.has(w)) || PATH_STEP_WORDS.has(words.join('')))) continue;
    if (segs.slice(i + 1, i + 3).some(tokenShaped)) return true;
  }
  return false;
}
// What a parameter name says the value is, or null.
/**
 * @param {string} name
 * @returns {PersonalReason | null}
 */
function nameReason(name) {
  const n = normName(name);
  if (!n) return null;
  if (SIGN_IN_NAMES.has(n)) return 'signin';
  if (SIGNED_NAMES.has(n)) return 'signed';
  if (RECIPIENT_NAMES.has(n)) return 'recipient';
  if (EMAIL_NAMES.has(n)) return 'email';
  if (PHONE_NAMES.has(n)) return 'phone';
  if (ID_NAMES.has(n)) return 'id';
  if (SIGN_IN_WORDS.some((w) => n.includes(w))) return 'signin';
  return null;
}
/** @type {Record<PersonalReason, string>} */
const LEFT_OUT = {
  signin: 'it carries a sign-in, key or session value',
  signed: 'it carries a signature that can give access to a file or an account',
  wrapped: 'it is a wrapped link that can identify who it was sent to',
  recipient: 'it holds a part that identifies the person it was sent to',
  email: 'it holds an email address',
  phone: 'it holds a phone number',
  id: 'it holds an identity number or a date of birth',
  password: 'it carries a password before the @',
};
// How many times a link is decoded when looking for what it holds: enough for an address
// wrapped inside several others, each encoding it again.
const REPORT_DECODE_ROUNDS = 10;

// Why a link must stay out of the message, or null. Before the host it looks for a password
// or an email address used as the user name (a look-alike name such as google.com@ is not
// personal); after it, at the path for a sign-in token written into it, at parameter names
// (nameReason), for a JSON Web Token under any name, for an email address (in any alphabet, or
// written in base64) and for a password before an @ in an address inside it, in the link as
// written and decoded again until nothing changes, so an address wrapped inside another is read too.
/**
 * @param {string | null} text
 * @returns {PersonalReason | null}
 */
function personalIn(text) {
  if (!text) return null;
  const sp = splitLink(text, !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text));
  if (sp) {
    const authority = text.slice(sp.authStart, sp.authEnd);
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
      const ui = authority.slice(0, at);
      const colon = ui.indexOf(':');
      if (colon >= 0 && colon < ui.length - 1) return 'password';
      if (EMAIL_WHOLE.test(pctDecode(colon >= 0 ? ui.slice(0, colon) : ui))) return 'email';
    }
    if (pathSignIn(text.slice(sp.authEnd).split(/[?#]/, 1)[0])) return 'signin';
  }
  let s = sp ? text.slice(sp.authEnd) : text;
  for (let i = 0; i < REPORT_DECODE_ROUNDS; i++) {
    for (const m of s.matchAll(/(?:^|[?&#;])([^=&?#;\s]{1,64})=/g)) {
      const why = nameReason(m[1]);
      if (why) return why;
    }
    if (JWT_IN.test(s)) return 'signin';
    if (/:\/\/[^/?#\s@]*:[^/?#\s@]+@/.test(s)) return 'password';
    if (EMAIL_IN.test(s)) return 'email';
    for (const m of s.matchAll(/=([A-Za-z0-9+/_-]{8,}={0,2})(?=[&#;/]|$)/g)) {
      const t = base64ToText(m[1]);
      if (t && EMAIL_IN.test(t)) return 'email';
    }
    const d = pctDecode(s);
    if (d === s) break;
    s = d;
  }
  return null;
}

/**
 * @param {LinkAnalysis} a
 * @param {number} [depth]
 * @returns {PersonalReason | null}
 */
function originalReason(a, depth = 0) {
  if (a.untouched) return a.untouched.reason === 'auth' ? 'signin' : a.untouched.reason === 'signed' ? 'signed' : 'wrapped';
  if (a.kept.some((k) => k.reason === 'recipient-token')) return 'recipient';
  if (a.wrappers.some((w) => w.id === 'outlook-safelinks')) return 'email';
  if (a.wrappers.some(recipientWrapper)) return 'recipient';
  const own = personalIn(a.link);
  if (own) return own;
  if (a.parts.some((p) => p.recipient)) return 'recipient';
  // An address hidden inside (in base64 too) that the engine found holding something
  // personal (F4).
  if (depth < MAX_HIDDEN_DEPTH + 1) {
    for (const h of a.hidden) {
      const why = h.analysis && originalReason(h.analysis, depth + 1);
      if (why) return why;
    }
  }
  return null;
}

// Why the clean link for a choice must stay out, or null. It holds everything the original
// holds when it is the original, a wrapper kept around it, or a link left untouched (F1);
// otherwise it is read on its own, with the recipient parts still in it and the hidden
// addresses whose value it still carries.
/**
 * @param {LinkAnalysis} a
 * @param {string} clean
 * @param {PersonalReason | null} oWhy
 * @returns {PersonalReason | null}
 */
function cleanReason(a, clean, oWhy) {
  if (clean === a.link || a.untouched || a.wrappers.some((w) => w.link === clean)) return oWhy;
  const own = personalIn(clean);
  if (own) return own;
  if (a.parts.some((p) => p.recipient && p.where !== 'wrapper' && clean.includes(p.text))) return 'recipient';
  for (const h of a.hidden) {
    const why = h.analysis && originalReason(h.analysis, 1);
    if (why && h.text && clean.includes(h.text)) return why;
  }
  return null;
}

// A lone surrogate would make encodeURIComponent throw.
/** @param {unknown} s */
const wellFormed = (s) => String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
/** @param {string} s */
const enc = (s) => encodeURIComponent(wellFormed(s));

// The link with its middle cut out, so that it takes at most max characters once encoded.
/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function squeeze(text, max) {
  const chars = Array.from(wellFormed(text));
  /** @param {number} n */
  const cut = (n) => {
    const head = Math.ceil(n * 0.6);
    return `${chars.slice(0, head).join('')}\u2026${chars.slice(chars.length - (n - head)).join('')}`;
  };
  let lo = 0;
  let hi = chars.length;
  if (enc(cut(0)).length > max) return '\u2026';
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc(cut(mid)).length <= max) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

/**
 * @param {Analysis | null | undefined} a
 * @param {IdChoice} removedIds
 * @returns {ReportMail | null}
 */
export function reportMail(a, removedIds) {
  if (!a || !a.found) return null;
  const clean = a.clean(removedIds);
  const oWhy = originalReason(a);
  const cWhy = cleanReason(a, clean, oWhy);
  /**
   * @param {string | null} o
   * @param {string | null} c
   * @param {boolean} oShort
   * @param {boolean} cShort
   */
  const body = (o, c, oShort, cShort) => [
    ...(o !== null ? ['Before you send: the original link may hold personal parts, such as a code that identifies you. You can edit them out of this message.', ''] : []),
    o !== null ? `Original link${oShort ? ' (shortened)' : ''}: ${o}` : `Original link: left out, because ${LEFT_OUT[/** @type {PersonalReason} */ (oWhy)]}. Add it yourself only if you are happy to share it.`,
    c !== null ? `CheckLink's clean link${cShort ? ' (shortened)' : ''}: ${c}` : `CheckLink's clean link: left out, because ${LEFT_OUT[/** @type {PersonalReason} */ (cWhy)]}.`,
    'What went wrong (optional): ',
    '',
    '',
    `Rules dated ${RULES_DATE}`,
  ].join('\r\n');
  /**
   * @param {string | null} o
   * @param {string | null} c
   * @param {boolean} oShort
   * @param {boolean} cShort
   */
  const build = (o, c, oShort, cShort) => `mailto:${REPORT_TO}?subject=${enc(REPORT_SUBJECT)}&body=${enc(body(o, c, oShort, cShort))}`;
  const o = oWhy ? null : a.link;
  const c = cWhy ? null : clean;
  let href = build(o, c, false, false);
  let oOut = o;
  let cOut = c;
  if (href.length > REPORT_MAX) {
    const budget = REPORT_MAX - build(o === null ? null : '', c === null ? null : '', true, true).length - 4;
    const eo = o === null ? 0 : enc(o).length;
    const ec = c === null ? 0 : enc(c).length;
    let co;
    let cc;
    if (ec <= budget / 2) {
      cc = ec;
      co = budget - ec;
    } else if (eo <= budget / 2) {
      co = eo;
      cc = budget - eo;
    } else {
      co = Math.floor(budget / 2);
      cc = budget - co;
    }
    if (o !== null && eo > co) oOut = squeeze(o, co);
    if (c !== null && ec > cc) cOut = squeeze(c, cc);
    href = build(oOut, cOut, oOut !== o, cOut !== c);
  }
  return { href, original: o !== null, clean: c !== null, shortened: oOut !== o || cOut !== c, originalReason: oWhy, cleanReason: cWhy };
}

// == What a link holds, for the page's other uses (stage 4b) ==

// personalReasons(analysis, removedIds): { original, clean }, the Email us line's own test
// (decisions PD-1 and SEC-10 of 11 October 2026), so Share, Copy, the screenshot block and the
// QR code agree with it. original says why the link as written holds something personal, clean
// why the clean link for that choice does; each is null or one of the LEFT_OUT keys: 'signin',
// 'signed', 'wrapped', 'recipient', 'email', 'phone', 'id' or 'password'.
/**
 * @param {Analysis | null | undefined} a
 * @param {IdChoice} removedIds
 * @returns {{ original: PersonalReason | null, clean: PersonalReason | null }}
 */
export function personalReasons(a, removedIds) {
  if (!a || !a.found) return { original: null, clean: null };
  const original = originalReason(a);
  return { original, clean: cleanReason(a, a.clean(removedIds), original) };
}

// heldReason(analysis, removedIds): why the page holds Share back for the clean link, or null:
// 'auth' for a sign-in or reset link left untouched (whoever opens it may get into the account),
// 'recipient' while a recipient token the page needs is kept. A recipient token ticked to be
// removed anyway no longer holds it back, unless a wrapper kept around the address keeps
// everything inside it as written.
/**
 * @param {Analysis | null | undefined} a
 * @param {IdChoice} removedIds
 * @returns {'auth' | 'recipient' | null}
 */
export function heldReason(a, removedIds) {
  if (!a || !a.found) return null;
  if (a.untouched && a.untouched.reason === 'auth') return 'auth';
  const removed = toIdSet(removedIds) ?? new Set(a.defaultRemoved);
  const kept = a.wrappers.findIndex((w) => !removed.has(w.partId));
  if (a.kept.some((k) => k.reason === 'recipient-token' && !(kept < 0 && removed.has(k.id)))) return 'recipient';
  return null;
}
