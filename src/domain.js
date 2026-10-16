// Who owns a host name: the Public Suffix List read the way browsers read it. Pure ES module, no
// DOM, no network; runs in browsers and in Node 24.
//
//   publicSuffix(host)        { suffix, private, known } or null for an IP address or an empty name
//   registrableDomain(host)   the name its owner registered (shop.example.co.uk -> example.co.uk),
//                             or null for an IP address, a single name (localhost) or a host that
//                             is itself a public suffix (co.uk, github.io)
//   domainInfo(host)          { host, suffix, domain, private, known } for display, or null
//   PSL_VERSION, PSL_DATE, PSL_COMMIT
//
// host is a host name as the browser's URL parser gives it: small letters, xn-- for international
// names. A trailing dot is ignored. Upper-case letters are folded; anything else that is not a
// plain host name (spaces, Unicode letters) gives null, so a caller always passes URL().hostname.
//
// The algorithm is the list's own (https://publicsuffix.org/list/): the longest matching rule
// wins, a wildcard (*.ck) stands for one label, an exception (!www.ck) beats the rule it
// excepts, and a name no rule matches has its last label as the suffix (known: false). private
// is true when the deciding rule comes from the list's PRIVATE section: a name whose owner lets
// anyone make their own addresses under it (github.io, blogspot.com, co.no).

import { PSL_COMMIT, PSL_DATE, PSL_ICANN, PSL_PRIVATE, PSL_VERSION } from './psl.js?v=c92fda01';

/**
 * What the list says about a host name.
 * @typedef {{ suffix: string, private: boolean, known: boolean }} PublicSuffix
 */
/**
 * A host name with its public suffix and registrable domain (domainInfo).
 * @typedef {{ host: string, suffix: string, domain: string | null, private: boolean, known: boolean }} DomainInfo
 */
export { PSL_COMMIT, PSL_DATE, PSL_VERSION };

const ICANN = 1;
const PRIVATE = 2;

// rule (without ! or *.) -> section, kept in three maps by kind. Built on first use.
/** @type {Map<string, number> | null} */
let exact = null;
/** @type {Map<string, number> | null} */
let wild = null;
/** @type {Map<string, number> | null} */
let except = null;

function load() {
  exact = new Map();
  wild = new Map();
  except = new Map();
  for (const [text, section] of /** @type {[string, number][]} */ ([[PSL_ICANN, ICANN], [PSL_PRIVATE, PRIVATE]])) {
    for (const rule of text.split('\n')) {
      if (!rule) continue;
      if (rule.startsWith('!')) except.set(rule.slice(1), section);
      else if (rule.startsWith('*.')) wild.set(rule.slice(2), section);
      else exact.set(rule, section);
    }
  }
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
/** @type {Map<string, PublicSuffix>} */
const cache = new Map();

/**
 * @param {unknown} host
 * @returns {string | null}
 */
function clean(host) {
  if (typeof host !== 'string') return null;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || h.startsWith('[') || IPV4.test(h) || !HOST.test(h)) return null;
  return h;
}

/**
 * @param {unknown} host
 * @returns {PublicSuffix | null}
 */
export function publicSuffix(host) {
  const h = clean(host);
  if (!h) return null;
  if (cache.has(h)) return /** @type {PublicSuffix} */ (cache.get(h));
  if (!exact) load();
  // load() has filled all three maps; the checker cannot see that through the call.
  const [exactRules, wildRules, exceptRules] = /** @type {Map<string, number>[]} */ ([exact, wild, except]);
  const labels = h.split('.');
  /** @type {PublicSuffix | null} */
  let out = null;
  for (let i = 0; i < labels.length && !out; i++) {
    const name = labels.slice(i).join('.');
    if (exceptRules.has(name)) {
      // An exception rule: its own leftmost label is not part of the suffix.
      out = { suffix: labels.slice(i + 1).join('.'), private: exceptRules.get(name) === PRIVATE, known: true };
    } else if (exactRules.has(name)) {
      out = { suffix: name, private: exactRules.get(name) === PRIVATE, known: true };
    } else if (i + 1 < labels.length && wildRules.has(labels.slice(i + 1).join('.'))) {
      out = { suffix: name, private: wildRules.get(labels.slice(i + 1).join('.')) === PRIVATE, known: true };
    }
  }
  if (!out) out = { suffix: labels[labels.length - 1], private: false, known: false };
  if (cache.size > 5000) cache.clear();
  cache.set(h, out);
  return out;
}

/**
 * @param {unknown} host
 * @returns {string | null}
 */
export function registrableDomain(host) {
  const h = clean(host);
  const ps = h && publicSuffix(h);
  if (!ps || h === ps.suffix || !h.endsWith(`.${ps.suffix}`)) return null;
  const rest = h.slice(0, -(ps.suffix.length + 1));
  return `${rest.slice(rest.lastIndexOf('.') + 1)}.${ps.suffix}`;
}

/**
 * @param {unknown} host
 * @returns {DomainInfo | null}
 */
export function domainInfo(host) {
  const h = clean(host);
  const ps = h && publicSuffix(h);
  if (!ps) return null;
  return { host: h, suffix: ps.suffix, domain: registrableDomain(h), private: ps.private, known: ps.known };
}
