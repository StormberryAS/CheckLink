#!/usr/bin/env node
// Builds src/rules.js from rules/provider-rules.json and rules/extra-rules.json.
//
//   node tools/build-rules.mjs            write src/rules.js
//   node tools/build-rules.mjs --check    exit 1 if src/rules.js is missing or stale
//   --rules <file> --extra <file> --out <file>   other paths (used by the tests)
//
// Run by a person, never by the app. The app never fetches rules: they ship inside
// src/rules.js. The output depends only on the two input files, so running this twice
// gives identical bytes. extra-rules.json's corrections are applied to the verified table
// first (each must find exactly one entry still holding the values it expects), then its
// additions are added. It refuses (exit 1) a rule file that:
//   * has a global rule that could remove a protected short name (v t s q id p ...) on
//     every site; a global rule on such a name is accepted only when its default is keep
//     or a requires_any condition ties it to the vendor's own companion parameter;
//   * has a never_strip entry with no paths that keeps a name a host rule for the same
//     hosts strips: the host rule could then never apply (review finding F4);
//   * has a regular expression that JavaScript cannot compile;
//   * has an unknown match type, default, condition or redirect extract type;
//   * has a correction whose target is missing, ambiguous or no longer as expected;
//   * has a canonical-page rule (extra-rules.json canonical) whose host entry is not one
//     exact name (name.* under a public suffix, {cc}.name for any two-letter
//     subdomain, an IPv4 address, or * on a rule whose requires clauses name a parameter
//     only that software uses), whose path is not anchored at both ends or matches the
//     home page without a requires clause, whose keep or remove list is malformed, whose
//     keep list names a parameter that a rule for the same hosts removes, whose remove
//     list names a parameter a functional_keep entry for the same hosts keeps, whose
//     remove entry has a perClick that is not true or false, or whose condition clauses
//     are malformed.
// A parameter rule whose own words say it identifies the recipient of a message gets
// recipient: true, which the report e-mail uses to leave such links out (batch 3 security
// review F2); a remove entry's perClick (true, false, or from its words) sets its badge.
// On canonical pages a protected short name that the rule's keep list does not name is
// shown unticked ("ask"), never removed by default, unless the rule's remove list names
// it (verified for that page); the build says so in a notice, and names each protected
// name a keep or remove list names.
// Node 24 built-ins only.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Where a rule names a provider under any public suffix (amazon.*, google\.[a-z.]+ in a
// redirect pattern), the compiled pattern holds this token in the suffix's place. The engine
// (src/link-core.js) replaces it, for each host, with that host's own public suffix from the
// Public Suffix List (src/domain.js), and only when the list's ICANN section decides it; a
// suffix from the PRIVATE section (com.de, co.no, github.io: anyone can make an address under
// it) or a name the list does not know makes the pattern match nothing. So amazon.co.uk and
// google.com.br match, and google.com.de, amazon.co.no, google.evil.io and google.com.evil.io
// do not. Stage 2 replaced the stopgap pattern and its 28-name suffix_deny list with this.
// The token is upper case, and host names reach the patterns in small letters, so an
// unreplaced token can never match a real address.
export const SUFFIX_TOKEN = '__SUFFIX__';
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A pattern with the token replaced by one real suffix, for the build's own probes.
const withSuffix = (src, suffix = 'com') => src.split(SUFFIX_TOKEN).join(escapeRe(suffix));

const MATCH_TYPES = new Set(['exact', 'prefix', 'regex']);
const DEFAULTS = new Set(['strip', 'ask', 'keep']);
const CONDITIONS = new Set(['paths', 'path_not', 'value_regex', 'requires_any', 'url_contains', 'url_not_contains', 'except_hosts']);
const EXTRACT_TYPES = new Set(['query', 'base64', 'base64url', 'query_prefix', 'regex', 'twitch_email']);
const FK_EFFECTS = new Set(['never_strip', 'skip_all_rules', 'skip_host_rules', 'skip_all_params']);

// Words in a rule's own explanation that say it identifies the person a message was sent to
// (a subscriber ID, the recipient's email address): the report e-mail leaves out any link
// that holds one (batch 3 security review finding F2).
const RECIPIENT = /\b(?:per[- ]recipient|recipient(?:'s)? (?:identifier|subscriber|encrypted|email|tracking|values)|(?:the|email) recipient who|recipient clicked|identify the (?:email )?recipient|with recipient tracking|subscriber|who clicked|which person clicked|(?:clicker|recipient)'s email address|identif(?:y|ies) (?:you|who)\b|user id for you|addressed to|tying the click to the email)/i;
// Words in a rule's own explanation that say its value differs per click, person or session.
const PER_CLICK = /\b(unique|click ids?|click identifier|per[- ]click|session|recipient|subscriber|visitor id|user id|device id|advertising id|install id|identif(?:y|ies) (?:you|the (?:email )?recipient|who)|email address|matched to you|who clicked|one-time)\b/i;

function parseArgs(argv) {
  const opts = {
    rules: path.join(ROOT, 'rules', 'provider-rules.json'),
    extra: path.join(ROOT, 'rules', 'extra-rules.json'),
    out: path.join(ROOT, 'src', 'rules.js'),
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--rules' || a === '--extra' || a === '--out') opts[a.slice(2)] = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function nameMatches(match, name) {
  if (match.type === 'exact') return match.value === name;
  if (match.type === 'prefix') return name.startsWith(match.value);
  return new RegExp(match.value).test(name);
}

// Replace "\.[a-z.]+" (a public suffix written loosely) with the suffix token above.
function tightenSuffix(re, suffix) {
  return re.split('\\.[a-z.]+').join(`\\.${suffix}`);
}

// Host patterns that can name the same host: equal, one a subdomain pattern of the other,
// or "*".
function patternsOverlap(a, b) {
  return a === b || a === '*' || b === '*' || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Applies extra-rules.json corrections to a copy of the verified table. Each correction
// names its target list, a where clause that must match exactly one entry (and, for a host
// block, a param clause that must match exactly one of its params), the values it expects
// to replace and the values it sets.
function applyCorrections(provider, corrections, errors) {
  const out = structuredClone(provider);
  for (const c of corrections) {
    const label = `correction ${c.finding || '?'} on ${c.target} ${JSON.stringify(c.where)}`;
    const list = out[c.target];
    if (!Array.isArray(list)) {
      errors.push(`${label}: no list "${c.target}"`);
      continue;
    }
    const hits = list.filter((e) => Object.entries(c.where || {}).every(([k, v]) => same(e[k], v)));
    if (hits.length !== 1) {
      errors.push(`${label}: matches ${hits.length} entries, expected exactly one`);
      continue;
    }
    let entry = hits[0];
    // A host block's own parameter: param picks exactly one of its params.
    if (c.param) {
      const ps = (entry.params || []).filter((e) => Object.entries(c.param).every(([k, v]) => same(e[k], v)));
      if (ps.length !== 1) {
        errors.push(`${label}: param ${JSON.stringify(c.param)} matches ${ps.length} entries, expected exactly one`);
        continue;
      }
      entry = ps[0];
    }
    for (const [k, v] of Object.entries(c.expect || {})) {
      if (!same(entry[k], v)) errors.push(`${label}: ${k} is ${JSON.stringify(entry[k])}, expected ${JSON.stringify(v)}; check the correction against the new table`);
    }
    Object.assign(entry, structuredClone(c.set));
  }
  return out;
}

function compileCheck(src, where, errors) {
  try {
    new RegExp(src);
  } catch (e) {
    errors.push(`${where}: JavaScript cannot compile /${src}/ (${e.message})`);
  }
}

function checkConditions(cond, where, errors) {
  if (cond == null) return null;
  const out = {};
  for (const key of Object.keys(cond)) {
    if (!CONDITIONS.has(key)) errors.push(`${where}: unknown condition "${key}"`);
    const v = cond[key];
    if (key === 'value_regex') compileCheck(v, `${where} value_regex`, errors);
    if (key === 'paths' || key === 'path_not') for (const p of v) compileCheck(p, `${where} ${key}`, errors);
    out[key] = v;
  }
  return out;
}

// == canonical pages ==
//
// A canonical-page rule says: on these exact hosts and these paths the page is fully
// addressed by its path, so any parameter no verified rule names, that the keep list does
// not name and that no functional_keep entry keeps, is shown as Unrecognised and removed
// by default; a protected short name (v t s q hl ...) is shown too, but unticked, because
// those names often choose what a page shows (review finding C5). Because such a rule
// removes names nobody has checked, it is held to a stricter shape than the parameter
// rules: every host is one exact name, every path is anchored at both ends, and the
// result is tested against hosts and paths it must refuse.
const CANON_KEYS = new Set(['id', 'platform', 'family', 'hosts', 'paths', 'keep', 'remove', 'requires', 'unless', 'drop_empty', 'basis']);
const CANON_KEEP_KEYS = new Set(['name', 'names', 'note', 'when', 'otherwise']);
const CANON_REMOVE_KEYS = new Set(['name', 'names', 'provider', 'reveals', 'perClick']);
const CANON_WHEN_KEYS = new Set(['paths', 'any']);
const CANON_OTHERWISE_KEYS = new Set(['provider', 'reveals']);
// One exact host name, or name.* for that name under any public suffix. No leading
// wildcard, no bare "*", at least two labels, small letters only. {cc}.name stands for any
// two-letter subdomain of name (no.linkedin.com); an IPv4 address is one exact host too.
const CANON_HOST = /^(?:\{cc\}\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|\*)$/;
const CANON_IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// Parameter names other sites use too: a rule for any host (*) must not fire on these alone.
const GENERIC_NAMES = new Set(['q', 'query', 'search', 'text', 'categories', 'category', 'language', 'lang', 'locale', 'safesearch', 'format', 'theme', 'method', 'p', 'page', 'start', 'offset', 's', 'tokens', 'preferences']);
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
// A parameter name, or a name ending in * for every name that starts with it.
const PARAM_NAME = /^[^\s*]+\*?$/;
const namesOf = (e) => (Array.isArray(e.names) ? e.names : e.name !== undefined ? [e.name] : []);
const matchesKeepName = (pattern, name) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name);

// Condition clauses: an object whose keys are parameter names (a name ending in * stands
// for every name starting with it), $host (the host) or, inside a keep entry's when,
// $value (the parameter's own value). A value is a regular expression the decoded value
// must match, or null for absent or empty. Every key must hold; a list of clauses holds
// when any one does.
function checkClauses(list, where, errors, { value = false } = {}) {
  if (list === undefined) return null;
  if (!Array.isArray(list) || !list.length) {
    errors.push(`${where}: must be a non-empty list of clauses`);
    return null;
  }
  return list.map((clause, i) => {
    const at = `${where}[${i}]`;
    if (!clause || typeof clause !== 'object' || Array.isArray(clause) || !Object.keys(clause).length) {
      errors.push(`${at}: a clause is an object with at least one key`);
      return {};
    }
    for (const [k, v] of Object.entries(clause)) {
      const special = k === '$host' || (value && k === '$value');
      if (!special && (k.startsWith('$') || !PARAM_NAME.test(k))) errors.push(`${at}: "${k}" is not a parameter name, $host${value ? ' or $value' : ''}`);
      if (v === null) {
        if (k === '$host') errors.push(`${at}: $host needs a regular expression`);
      } else if (typeof v === 'string') {
        compileCheck(v, `${at} ${k}`, errors);
      } else {
        errors.push(`${at}: ${k} must be a regular expression or null`);
      }
    }
    return { ...clause };
  });
}

function compileCanonical(section, suffix, ruleBlocks, globalRules, functionalKeep, protectedNames, errors, notices) {
  if (section == null) return [];
  if (!nonEmpty(section.reveals) || !nonEmpty(section.reveals_ask) || !Array.isArray(section.rules)) {
    errors.push('canonical: reveals, reveals_ask and rules are required');
    return [];
  }
  if (section.rules.some((c) => c && c.drop_empty) && !nonEmpty(section.reveals_empty)) errors.push('canonical: reveals_empty is required when a rule sets drop_empty');
  notices.push(`canonical rules: a protected name (${protectedNames.join(' ')}) that a rule's keep list does not name is shown unticked on its pages, never removed by default, unless the rule's remove list names it`);
  const out = [];
  const seenIds = new Set();
  section.rules.forEach((c, n) => {
    const where = `canonical[${n}] ${c && c.id}`;
    if (!c || typeof c !== 'object') {
      errors.push(`${where}: not an object`);
      return;
    }
    for (const k of Object.keys(c)) if (!CANON_KEYS.has(k)) errors.push(`${where}: unknown key "${k}"`);
    if (!/^[a-z0-9-]+$/.test(c.id || '')) errors.push(`${where}: id must be small letters, digits and hyphens`);
    if (seenIds.has(c.id)) errors.push(`${where}: duplicate id`);
    seenIds.add(c.id);
    for (const k of ['platform', 'family', 'basis']) if (!nonEmpty(c[k])) errors.push(`${where}: ${k} is required`);
    if (c.drop_empty !== undefined && typeof c.drop_empty !== 'boolean') errors.push(`${where}: drop_empty must be true or false`);

    const requires = checkClauses(c.requires, `${where} requires`, errors);
    const unless = checkClauses(c.unless, `${where} unless`, errors);

    const hosts = Array.isArray(c.hosts) ? c.hosts : [];
    if (!hosts.length) errors.push(`${where}: hosts must list at least one host`);
    const hostRes = [];
    const anyHost = hosts.includes('*');
    for (const h of hosts) {
      if (h === '*') {
        // Any host: only where every requires clause names the host or a parameter that
        // only this software uses, so an ordinary site's ?q= never turns it on.
        // (Two generic names together, such as categories with language, count too.)
        const QUERY = new Set(['q', 'query', 'text', 'search']);
        const distinctive = (cl) => {
          const keys = Object.keys(cl);
          return keys.some((k) => k === '$host' || (!GENERIC_NAMES.has(k) && !protectedNames.includes(k))) || keys.filter((k) => !QUERY.has(k)).length >= 2;
        };
        const ok = requires && requires.every(distinctive);
        if (!ok) errors.push(`${where}: host "*" needs requires clauses that each name $host or a parameter only this software uses`);
        else notices.push(`canonical rule "${c.id}" applies on any host, only where its requires clauses hold`);
        hostRes.push('.+');
        continue;
      }
      if (typeof h === 'string' && CANON_IPV4.test(h)) {
        hostRes.push(escapeRe(h));
        continue;
      }
      if (typeof h !== 'string' || !CANON_HOST.test(h) || h.includes('*.')) {
        errors.push(`${where}: host "${h}" must be one exact name such as www.instagram.com, or name.* such as amazon.*, or {cc}.name such as {cc}.linkedin.com`);
        continue;
      }
      const cc = h.startsWith('{cc}.');
      const bare = cc ? h.slice(5) : h;
      const body = bare.endsWith('.*') ? `${escapeRe(bare.slice(0, -2))}\\.${suffix}` : escapeRe(bare);
      hostRes.push(cc ? `[a-z]{2}\\.${body}` : body);
    }
    const host = `^(?:${hostRes.join('|')})$`;
    compileCheck(host, `${where} hosts`, errors);
    // Anchored means a listed name never matches a name in front of it or behind it.
    if (!anyHost) {
      try {
        const rx = new RegExp(withSuffix(host));
        for (const h of hosts.filter((x) => typeof x === 'string' && CANON_HOST.test(x))) {
          const named = h.startsWith('{cc}.') ? `no.${h.slice(5)}` : h;
          const wild = named.endsWith('.*');
          const base = wild ? `${named.slice(0, -2)}.com` : named;
          // (amazon.comx is a well-formed amazon.* name, so that probe is for exact names only.)
          for (const probe of [`evil.${base}`, `${base}.evil.io`, `x${base}`, ...(wild ? [] : [`${base}x`])]) {
            if (rx.test(probe)) errors.push(`${where}: the host pattern also matches ${probe}; host patterns must be anchored`);
          }
        }
      } catch { /* reported by compileCheck */ }
    }

    const paths = Array.isArray(c.paths) ? c.paths : [];
    if (!paths.length) errors.push(`${where}: paths must list at least one path`);
    for (const p of paths) {
      if (typeof p !== 'string' || !p.startsWith('^/') || !p.endsWith('$') || p.endsWith('\\$')) {
        errors.push(`${where}: path ${JSON.stringify(p)} must be anchored at both ends (start with ^/ and end with $)`);
        continue;
      }
      compileCheck(p, `${where} paths`, errors);
      try {
        const rx = new RegExp(p);
        // The home page is a result page only for a few sites, and only with the query.
        if ((rx.test('/') || rx.test('')) && !requires) errors.push(`${where}: path ${JSON.stringify(p)} matches the home page; that needs requires clauses (for example the query)`);
      } catch { /* reported by compileCheck */ }
    }

    // (On a rule for any host, a site's own host rules win on that site, as they should;
    // only the global rules can contradict its keep list everywhere.)
    const blocks = anyHost ? [] : ruleBlocks.filter((b) => b.patterns.some((p) => hosts.some((h) => patternsOverlap(p, h))));
    const keep = Array.isArray(c.keep) ? c.keep : null;
    if (!keep) errors.push(`${where}: keep must be a list (empty for none)`);
    const keepNames = new Set();
    const keepOut = [];
    for (const k of keep || []) {
      const names = k && typeof k === 'object' ? namesOf(k) : [];
      if (!k || typeof k !== 'object' || !names.length || !names.every((x) => typeof x === 'string' && PARAM_NAME.test(x)) || !nonEmpty(k.note)) {
        errors.push(`${where}: each keep entry needs a name and a note`);
        continue;
      }
      for (const key of Object.keys(k)) if (!CANON_KEEP_KEYS.has(key)) errors.push(`${where}: keep entry ${names[0]} has an unknown key "${key}"`);
      let when = null;
      if (k.when !== undefined) {
        if (!k.when || typeof k.when !== 'object' || !Object.keys(k.when).length) errors.push(`${where}: keep entry ${names[0]}: when needs paths or any`);
        else {
          for (const key of Object.keys(k.when)) if (!CANON_WHEN_KEYS.has(key)) errors.push(`${where}: keep entry ${names[0]}: unknown when key "${key}"`);
          when = {};
          if (k.when.paths !== undefined) {
            if (!Array.isArray(k.when.paths) || !k.when.paths.length) errors.push(`${where}: keep entry ${names[0]}: when.paths must be a non-empty list`);
            else for (const p of k.when.paths) compileCheck(p, `${where} keep ${names[0]} when.paths`, errors);
            when.paths = (k.when.paths || []).slice();
          }
          if (k.when.any !== undefined) when.any = checkClauses(k.when.any, `${where} keep ${names[0]} when.any`, errors, { value: true });
        }
      }
      let otherwise = null;
      if (k.otherwise !== undefined) {
        if (!when) errors.push(`${where}: keep entry ${names[0]}: otherwise needs a when`);
        if (!k.otherwise || typeof k.otherwise !== 'object' || !nonEmpty(k.otherwise.provider) || !nonEmpty(k.otherwise.reveals)) errors.push(`${where}: keep entry ${names[0]}: otherwise needs a provider and reveals`);
        else {
          for (const key of Object.keys(k.otherwise)) if (!CANON_OTHERWISE_KEYS.has(key)) errors.push(`${where}: keep entry ${names[0]}: unknown otherwise key "${key}"`);
          otherwise = { provider: k.otherwise.provider, reveals: k.otherwise.reveals };
        }
      }
      for (const name of names) {
        if (keepNames.has(name)) errors.push(`${where}: keep lists ${name} twice`);
        keepNames.add(name);
        // A name the keep list keeps must not be one a rule for the same hosts removes: the
        // rule would win and the keep entry would mislead.
        if (!name.endsWith('*')) {
          for (const r of [...blocks.flatMap((b) => b.params), ...globalRules]) {
            // A rule that removes only some values (Google ie only as UTF-8) leaves the
            // others to the keep entry.
            if (r.default === 'keep' || (r.conditions && r.conditions.value_regex)) continue;
            let hit = false;
            try { hit = nameMatches(r, name); } catch { /* reported by compileCheck */ }
            if (hit) errors.push(`${where}: keep names "${name}", which the rule "${r.name}" (${r.default}) removes on these hosts: drop one of them`);
          }
        }
        keepOut.push({ name, note: k.note, ...(when ? { when } : {}), ...(otherwise ? { otherwise } : {}) });
      }
    }

    // The remove list: parameters verified to do nothing on these pages. Each is removed by
    // default with its own label, even a protected short name.
    const remove = c.remove === undefined ? [] : c.remove;
    if (!Array.isArray(remove)) errors.push(`${where}: remove must be a list`);
    const removeNames = new Set();
    const removeOut = [];
    for (const r of Array.isArray(remove) ? remove : []) {
      const names = r && typeof r === 'object' ? namesOf(r) : [];
      if (!r || typeof r !== 'object' || !names.length || !names.every((x) => typeof x === 'string' && PARAM_NAME.test(x)) || !nonEmpty(r.provider) || !nonEmpty(r.reveals)) {
        errors.push(`${where}: each remove entry needs a name, a provider and reveals`);
        continue;
      }
      for (const key of Object.keys(r)) if (!CANON_REMOVE_KEYS.has(key)) errors.push(`${where}: remove entry ${names[0]} has an unknown key "${key}"`);
      for (const name of names) {
        if (removeNames.has(name)) errors.push(`${where}: remove lists ${name} twice`);
        removeNames.add(name);
        if ([...keepNames].some((k) => matchesKeepName(k, name) || matchesKeepName(name, k))) errors.push(`${where}: "${name}" is on both the keep and the remove list; use the keep entry's when and otherwise instead`);
        // A functional_keep entry that keeps the name on these hosts would win, and the
        // remove entry would mislead.
        for (const fk of functionalKeep) {
          if (fk.effect !== 'never_strip' || !fk.params) continue;
          if (!fk.hosts.some((h) => h !== '*' && (anyHost || hosts.some((x) => patternsOverlap(h, x))))) continue;
          if (fk.params.some((p) => matchesKeepName(p, name))) errors.push(`${where}: remove names "${name}", which functional_keep ${fk.id} keeps on these hosts: drop one of them`);
        }
      }
      // perClick: what the badge says. true or false in the entry wins (a search ID is unique
      // to this click, a display setting is the same for everyone); otherwise the entry's own
      // words decide, and with neither the page guesses from the value's shape.
      if (r.perClick !== undefined && typeof r.perClick !== 'boolean') errors.push(`${where}: remove entry ${names[0]}: perClick must be true or false`);
      const perClick = typeof r.perClick === 'boolean' ? r.perClick : PER_CLICK.test(`${r.provider} ${r.reveals}`) ? true : undefined;
      removeOut.push({ names: names.slice(), provider: r.provider, reveals: r.reveals, ...(perClick !== undefined ? { perClick } : {}) });
    }

    const keptProtected = protectedNames.filter((n) => keepNames.has(n));
    if (keptProtected.length) notices.push(`canonical rule "${c.id}" keeps protected ${keptProtected.map((n) => `"${n}"`).join(', ')}: accepted`);
    const removedProtected = protectedNames.filter((n) => removeNames.has(n));
    if (removedProtected.length) notices.push(`canonical rule "${c.id}" removes protected ${removedProtected.map((n) => `"${n}"`).join(', ')} on its own pages (verified there): accepted`);

    out.push({
      id: c.id,
      platform: c.platform,
      family: c.family,
      // The row's provider line is the platform alone: the "Unrecognised" label and the
      // explanation already say it is on no list.
      provider: c.platform,
      reveals: section.reveals,
      askReveals: section.reveals_ask,
      ...(c.drop_empty ? { emptyReveals: section.reveals_empty, dropEmpty: true } : {}),
      host,
      paths: paths.slice(),
      ...(requires ? { requires } : {}),
      ...(unless ? { unless } : {}),
      keep: keepOut,
      ...(removeOut.length ? { remove: removeOut } : {}),
      basis: c.basis,
    });
  });
  return out;
}

function compileParam(rule, id, where, errors) {
  const m = rule.match || {};
  if (!MATCH_TYPES.has(m.type)) errors.push(`${where}: unknown match type "${m.type}"`);
  if (m.type === 'regex') compileCheck(m.value, `${where} match`, errors);
  if (!DEFAULTS.has(rule.default)) errors.push(`${where}: unknown default "${rule.default}"`);
  if (typeof rule.provider !== 'string' || typeof rule.reveals !== 'string') errors.push(`${where}: provider and reveals are required`);
  return {
    id,
    name: rule.name,
    type: m.type,
    value: m.value,
    default: rule.default,
    provider: rule.provider,
    reveals: rule.reveals,
    affiliate: rule.affiliate || null,
    family: rule.family || null,
    breakage: (rule.breakage && rule.breakage.level) || null,
    perClick: PER_CLICK.test(`${rule.provider} ${rule.reveals}`),
    ...(RECIPIENT.test(`${rule.provider} ${rule.reveals}`) ? { recipient: true } : {}),
    conditions: checkConditions(rule.conditions, where, errors),
    // The same value on every link one account shares (Instagram mdxt): it points to the
    // sharer, not to one click, so the value's shape does not make it "unique to this click".
    ...(rule.sharer ? { sharer: true } : {}),
  };
}

export function buildRules(providerIn, extra) {
  const errors = [];
  const notices = [];
  const protectedNames = extra.protected_names.names;
  const add = extra.additions || { global: [], hosts: [], redirects: [], functional_keep: [] };
  const SUFFIX = SUFFIX_TOKEN;
  // The stopgap list is gone: the Public Suffix List decides private suffixes now.
  if (extra.suffix_deny !== undefined) errors.push('extra-rules.json: suffix_deny is replaced by the Public Suffix List (src/domain.js); remove it');
  const provider = applyCorrections(providerIn, (extra.corrections && extra.corrections.items) || [], errors);

  const protectedCheck = (list, label) => {
    for (const r of list) {
      for (const name of protectedNames) {
        let hit = false;
        try { hit = nameMatches(r, name); } catch { /* reported by compileCheck */ }
        if (!hit) continue;
        const scoped = r.conditions && Array.isArray(r.conditions.requires_any) && r.conditions.requires_any.length > 0;
        if (r.default === 'keep') notices.push(`${label} "${r.name}" names protected "${name}" but only keeps it: accepted`);
        else if (scoped) notices.push(`${label} "${r.name}" names protected "${name}" only next to ${r.conditions.requires_any.join(', ')}: accepted`);
        else errors.push(`${label} "${r.name}" (${r.default}) would remove the protected name "${name}" on every site: refused`);
      }
    }
  };
  const global = provider.global.map((r, i) => compileParam(r, `g${i}`, `global[${i}] ${r.name}`, errors));
  protectedCheck(global, 'global rule');
  const extraGlobal = (add.global || []).map((r, i) => compileParam(r, `xg${i}`, `additions.global[${i}] ${r.name}`, errors));
  protectedCheck(extraGlobal, 'added global rule');

  const hosts = provider.hosts.map((blk, b) => ({
    patterns: blk.pattern.slice(),
    family: blk.family || null,
    params: blk.params.map((r, i) => compileParam(r, `h${b}.${i}`, `hosts[${b}] ${blk.pattern.join(',')} ${r.name}`, errors)),
  }));
  const extraHosts = (add.hosts || []).map((blk, b) => ({
    patterns: blk.pattern.slice(),
    family: blk.family || null,
    params: blk.params.map((r, i) => compileParam(r, `xh${b}.${i}`, `additions.hosts[${b}] ${blk.pattern.join(',')} ${r.name}`, errors)),
  }));

  const functionalKeep = [];
  for (const fk of [...provider.functional_keep, ...(add.functional_keep || [])]) {
    if (!FK_EFFECTS.has(fk.effect)) continue; // notes only document a decision
    for (const p of fk.paths || []) compileCheck(p, `functional_keep ${fk.id} paths`, errors);
    functionalKeep.push({ id: fk.id, hosts: fk.hosts.slice(), effect: fk.effect, paths: fk.paths || null, params: fk.params || null, note: fk.note });
  }

  // A never_strip entry that applies on every path of its hosts makes any host rule that
  // strips the same name there dead (review finding F4: tiktok q).
  for (const fk of functionalKeep) {
    if (fk.effect !== 'never_strip' || fk.paths || !fk.params) continue;
    for (const blk of [...hosts, ...extraHosts]) {
      if (!blk.patterns.some((p) => fk.hosts.some((h) => patternsOverlap(p, h)))) continue;
      for (const r of blk.params) {
        if (r.default === 'keep') continue;
        const shadowed = fk.params.find((n) => (n.endsWith('*') ? r.type !== 'regex' && String(r.value).startsWith(n.slice(0, -1)) : (() => { try { return nameMatches(r, n); } catch { return false; } })()));
        if (shadowed) errors.push(`functional_keep ${fk.id} keeps "${shadowed}" on every path of ${fk.hosts.join(', ')}, so the host rule "${r.name}" for ${blk.patterns.join(', ')} can never apply: give the entry paths, or drop the rule`);
      }
    }
  }

  const pathRules = [];
  for (const pr of provider.path_rules) {
    if (pr.type !== 'strip_segment') continue; // unwrap/opaque are redirects; the rest are notes
    compileCheck(pr.regex, `path_rules ${pr.id}`, errors);
    pathRules.push({
      id: pr.id, hosts: pr.hosts.slice(), regex: pr.regex, flags: '', name: pr.name, provider: pr.provider, reveals: pr.reveals,
      default: pr.default, family: pr.family, unique: false, warning: null,
    });
  }
  for (const pr of extra.path_rules.rules) {
    compileCheck(pr.regex, `extra path_rules ${pr.id}`, errors);
    if (pr.hosts !== undefined && (!Array.isArray(pr.hosts) || !pr.hosts.length)) errors.push(`extra path_rules ${pr.id}: hosts must be a non-empty list`);
    pathRules.push({
      id: pr.id, hosts: pr.hosts ? pr.hosts.slice() : ['*'], regex: pr.regex, flags: pr.flags || '', name: pr.name, provider: pr.provider, reveals: pr.reveals,
      default: pr.default, family: pr.family, unique: !!pr.unique, warning: pr.warning || null,
    });
  }

  const redirects = [];
  for (const rd of [...provider.redirects, ...(add.redirects || [])]) {
    if (!rd.match) continue; // documentation-only entry
    const match = tightenSuffix(rd.match, SUFFIX);
    compileCheck(match, `redirects ${rd.id}`, errors);
    let extract = null;
    if (rd.extract) {
      if (!EXTRACT_TYPES.has(rd.extract.type)) errors.push(`redirects ${rd.id}: unknown extract type "${rd.extract.type}"`);
      extract = { ...rd.extract };
      if (extract.regex) {
        extract.regex = tightenSuffix(extract.regex, SUFFIX);
        compileCheck(extract.regex, `redirects ${rd.id} extract`, errors);
      }
    }
    if (rd.offline && !extract) errors.push(`redirects ${rd.id}: offline but no extract`);
    redirects.push({
      id: rd.id, family: rd.family, label: rd.label, match, offline: !!rd.offline, extract,
      action: rd.action || 'replace', note: rd.note || null,
    });
  }

  const ids = new Set();
  for (const rd of redirects) {
    if (ids.has(rd.id)) errors.push(`redirects: duplicate id ${rd.id}`);
    ids.add(rd.id);
  }

  const canonical = compileCanonical(extra.canonical, SUFFIX, [...hosts, ...extraHosts], [...global, ...extraGlobal], functionalKeep, protectedNames, errors, notices);

  return {
    errors,
    notices,
    data: {
      version: provider.version,
      date: provider.generated,
      extraVersion: extra.version,
      suffixToken: SUFFIX_TOKEN,
      protectedNames,
      global,
      hosts,
      extraGlobal,
      extraHosts,
      functionalKeep,
      pathRules,
      redirects,
      canonical,
      shortLinks: extra.short_links.services.map((s) => ({ host: s.host, service: s.service, kind: s.kind })),
      untouched: {
        signed: extra.untouched.signed.map((s) => ({ id: s.id, all: s.all.slice(), any: s.any ? s.any.slice() : null, label: s.label, caseInsensitive: !!s.case_insensitive })),
        hosts: extra.untouched.hosts.map((h) => ({ host: h.host, service: h.service })),
        authParams: extra.untouched.auth_params.slice(),
      },
      recipientTokens: {
        params: extra.recipient_tokens.params.slice(),
        pageWords: extra.recipient_tokens.page_words.map((s) => s.toLowerCase()),
        note: extra.recipient_tokens.note,
      },
    },
  };
}

// One entry per line inside arrays, so a rule change shows as a one-line diff.
function render(data) {
  const lines = [];
  lines.push('// Generated by tools/build-rules.mjs from rules/provider-rules.json and rules/extra-rules.json.');
  lines.push('// Do not edit by hand: change the JSON files and run `node tools/build-rules.mjs`.');
  lines.push(`// Provider rules ${data.version} dated ${data.date}; spec additions ${data.extraVersion}.`);
  lines.push('');
  lines.push(`export const RULES_VERSION = ${JSON.stringify(data.version)};`);
  lines.push(`export const RULES_DATE = ${JSON.stringify(data.date)};`);
  lines.push('');
  lines.push('export const RULES = {');
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      for (const item of value) lines.push(`    ${JSON.stringify(item)},`);
      lines.push('  ],');
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    }
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const provider = JSON.parse(readFileSync(opts.rules, 'utf8'));
  const extra = JSON.parse(readFileSync(opts.extra, 'utf8'));
  const { errors, notices, data } = buildRules(provider, extra);
  for (const n of notices) console.log(`note: ${n}`);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`build-rules: refused, ${errors.length} problem(s); ${path.relative(process.cwd(), opts.out) || opts.out} not written.`);
    process.exit(1);
  }
  const text = render(data);
  if (opts.check) {
    const current = existsSync(opts.out) ? readFileSync(opts.out, 'utf8') : null;
    if (current !== text) {
      console.error(`build-rules: ${opts.out} is stale; run node tools/build-rules.mjs`);
      process.exit(1);
    }
    console.log('build-rules: up to date');
    return;
  }
  writeFileSync(opts.out, text);
  const n = data.global.length + data.hosts.reduce((s, h) => s + h.params.length, 0);
  const x = data.extraGlobal.length + data.extraHosts.reduce((s, h) => s + h.params.length, 0);
  console.log(`build-rules: wrote ${opts.out} (${n} verified and ${x} added parameter rules, ${data.redirects.length} redirects, ${data.pathRules.length} path rules, ${data.canonical.length} canonical-page rules, ${data.shortLinks.length} short-link services; dated ${data.date})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
