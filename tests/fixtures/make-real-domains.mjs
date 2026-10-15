#!/usr/bin/env node
// Makes tests/fixtures/real-domains.txt: real host names that CheckLink's look-alike checks
// (stage 3) must leave alone. Run by a person, ONLINE, once; the list is kept in the repository,
// so the tests never need the network.
//
//   node tests/fixtures/make-real-domains.mjs
//
// Sources:
//   * Wikidata (CC0 1.0, https://www.wikidata.org/wiki/Wikidata:Licensing): the official website
//     (P856) of well-known items, of organisations in Norway, Portugal and Brazil, of companies,
//     websites and brands, and every international (xn--) official website of items in Norway,
//     Denmark, Sweden, Germany, Japan, Russia, Greece, China, South Korea, Portugal, Brazil,
//     France, Spain and Turkey; the queries are below, sent to https://query.wikidata.org/sparql;
//   * CheckLink's own files: the provider hosts in rules/provider-rules.json, the links in
//     rules/provider-test-corpus.json and rules/marcos-regression.json, the hosts named in
//     rules/extra-rules.json, and every domain in rules/brands.json (with www. in front too).
// Host names only, as the browser's URL parser gives them; IP addresses and single names are
// left out. A few real names are true look-alikes and are kept apart, in KNOWN below, with why:
// tests/lookalike.test.mjs checks that each of those still gets its note.
//
// Node 24 built-ins only.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KNOWN } from './real-domains-known.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'real-domains.txt');

const QUERIES = {
  // Asked in three bands, because one query for all of them is often cut short.
  'well-known items (60 to 89 sitelinks)': 'SELECT DISTINCT ?site WHERE { ?item wdt:P856 ?site . ?item wikibase:sitelinks ?l . FILTER(?l >= 60 && ?l < 90) }',
  'well-known items (90 to 139 sitelinks)': 'SELECT DISTINCT ?site WHERE { ?item wdt:P856 ?site . ?item wikibase:sitelinks ?l . FILTER(?l >= 90 && ?l < 140) }',
  'well-known items (140+ sitelinks)': 'SELECT DISTINCT ?site WHERE { ?item wdt:P856 ?site . ?item wikibase:sitelinks ?l . FILTER(?l >= 140) }',
  'Norway (3+ sitelinks)': 'SELECT DISTINCT ?site WHERE { ?item wdt:P17 wd:Q20 . ?item wdt:P856 ?site . ?item wikibase:sitelinks ?l . FILTER(?l >= 3) }',
  'Portugal (4+ sitelinks)': 'SELECT DISTINCT ?site WHERE { ?item wdt:P17 wd:Q45 . ?item wdt:P856 ?site . ?item wikibase:sitelinks ?l . FILTER(?l >= 4) }',
  'Brazil (10+ sitelinks)': 'SELECT DISTINCT ?site WHERE { ?item wdt:P17 wd:Q155 . ?item wdt:P856 ?site . ?item wikibase:sitelinks ?l . FILTER(?l >= 10) }',
  'companies (15+ sitelinks)': 'SELECT DISTINCT ?site WHERE { ?item wdt:P31 ?t . VALUES ?t { wd:Q4830453 wd:Q891723 wd:Q6881511 wd:Q783794 wd:Q1616075 wd:Q35127 wd:Q431289 wd:Q167037 } ?item wdt:P856 ?site . ?item wikibase:sitelinks ?l . FILTER(?l >= 15) }',
  'websites and brands (5+ sitelinks)': 'SELECT DISTINCT ?site WHERE { ?item wdt:P31 ?t . VALUES ?t { wd:Q35127 wd:Q1193236 wd:Q14915 wd:Q3220391 wd:Q2001305 wd:Q20826540 wd:Q1668024 } ?item wdt:P856 ?site . ?item wikibase:sitelinks ?l . FILTER(?l >= 5) }',
};
const IDN_COUNTRIES = { Q20: 'Norway', Q35: 'Denmark', Q34: 'Sweden', Q183: 'Germany', Q17: 'Japan', Q159: 'Russia', Q41: 'Greece', Q148: 'China', Q884: 'South Korea', Q45: 'Portugal', Q155: 'Brazil', Q142: 'France', Q29: 'Spain', Q43: 'Turkey' };
for (const [id, name] of Object.entries(IDN_COUNTRIES)) {
  QUERIES[`international names, ${name}`] = `SELECT DISTINCT ?site WHERE { ?item wdt:P17 wd:${id} . ?item wdt:P856 ?site . FILTER(REGEX(STR(?site), "^https?://[^/]*([^\\\\x00-\\\\x7F]|xn--)")) }`;
}


// Wikidata's query service gives up on a slow query with a 504; it is asked three times, and a
// query that still fails is left out and named in the file's header.
async function sparql(query) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sparqlOnce(query);
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

async function sparqlOnce(query) {
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'text/csv', 'User-Agent': 'CheckLink-test-fixture/1.0 (info@stormberry.as)' }, signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
  return (await res.text()).split('\n').slice(1).map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

const hosts = new Set();
const add = (h) => {
  if (!h) return;
  const x = h.toLowerCase().replace(/\.$/, '');
  if (!x.includes('.') || x.startsWith('[') || /^\d+(\.\d+){3}$/.test(x) || KNOWN[x]) return;
  hosts.add(x);
};
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };

// The query service can end a long answer early without saying so, so one run may bring fewer
// names than the last: names already in the file are kept (the list only grows), unless they
// have since become known look-alikes.
const kept = existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')) : [];
for (const h of kept) add(h);
console.log(`${kept.length} names kept from the last run`);
const counts = {};
const failed = [];
for (const [name, q] of Object.entries(QUERIES)) {
  let sites;
  try {
    sites = await sparql(q);
  } catch (err) {
    failed.push(name);
    console.log(`${name}: left out (${err.message})`);
    continue;
  }
  const before = hosts.size;
  for (const s of sites) add(hostOf(s));
  counts[name] = hosts.size - before;
  console.log(`${name}: ${sites.length} sites, ${counts[name]} new hosts`);
}
const pr = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'provider-rules.json'), 'utf8'));
for (const h of pr.hosts) for (const p of h.pattern) if (p !== '*') add(p.replace(/\.\*$/, '.com'));
for (const k of ['functional_keep', 'path_rules']) for (const r of pr[k]) for (const p of r.hosts || []) if (p !== '*') add(p.replace(/\.\*$/, '.com'));
for (const c of JSON.parse(readFileSync(path.join(ROOT, 'rules', 'provider-test-corpus.json'), 'utf8')).samples) { add(hostOf(c.dirty)); add(hostOf(c.clean)); }
for (const c of JSON.parse(readFileSync(path.join(ROOT, 'rules', 'marcos-regression.json'), 'utf8')).cases) add(hostOf(c.dirty));
const walk = (o) => { if (typeof o === 'string') { if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(o)) add(o); } else if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') Object.values(o).forEach(walk); };
const extra = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'extra-rules.json'), 'utf8'));
walk(extra.short_links);
walk(extra.canonical);
for (const b of JSON.parse(readFileSync(path.join(ROOT, 'rules', 'brands.json'), 'utf8')).brands) for (const d of b.domains) { add(d); add(`www.${d}`); }

const date = new Date().toISOString().slice(0, 10);
const header = [
  `# Real host names that CheckLink's look-alike checks must leave alone (tests/lookalike.test.mjs).`,
  `# Made by tests/fixtures/make-real-domains.mjs on ${date}; ${hosts.size.toLocaleString('en-GB')} names, one per line.`,
  '# Sources: Wikidata official websites (CC0 1.0; the queries are in the script) and CheckLink\'s own',
  '# rule files and brand list (MIT). Real names that are true look-alikes are kept out; the script',
  '# lists them, with why.',
  ...(failed.length ? [`# Left out because Wikidata timed out three times: ${failed.join('; ')}.`] : []),
];
writeFileSync(OUT, `${header.join('\n')}\n${[...hosts].sort().join('\n')}\n`);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${hosts.size} names`);
