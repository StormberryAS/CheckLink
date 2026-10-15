#!/usr/bin/env node
// Builds and checks src/brands.js, the brand list of CheckLink's look-alike check (stage 3), from
// rules/brands.json. Run by a person, never by the app.
//
//   node tools/brands.mjs             write src/brands.js
//   node tools/brands.mjs --check     exit 1 if src/brands.js is missing or stale, if the list
//                                     breaks a rule below, if any domain lacks a passing record
//                                     in rules/brands-verified.json, or if a hosted name's
//                                     recheck_by date has passed (offline; node --test runs it)
//   node tools/brands.mjs --verify    ONLINE: look every domain up in the DNS and open it over
//                                     HTTPS, then write rules/brands-verified.json. Only this
//                                     option touches the network, and only for the domains listed.
//   node tools/brands.mjs --verify-missing
//                                     ONLINE, the same check for only the domains that have no
//                                     passing record yet (a domain just added); the other records
//                                     are kept as they are
//
// Rules the list must keep:
//   * every domain is written in small letters and is its own registrable domain by the Public
//     Suffix List (src/domain.js), so a host under it is recognised as the brand's;
//   * a platform (a name the brand runs that the list treats as a public suffix, such as
//     googleapis.com) is exactly such a suffix, from the list's PRIVATE section;
//   * no domain or platform belongs to two brands, and no mark label is used twice;
//   * a mark's label is small letters, digits and hyphens, its kind is distinct or word, and the
//     domain it cites as the brand's own is one of that brand's domains;
//   * a lure word is small letters, digits and hyphens;
//   * a probe host (opened by --verify instead of a bare name with no page of its own) is under
//     the domain it stands for;
//   * a hosted name (a name under a free hosting address that the brand itself holds, such as
//     google.github.io) is its own registrable domain under a suffix from the Public Suffix
//     List's PRIVATE section, belongs to no other brand, names the account that holds it, when
//     it was checked, what was found and where, and a recheck_by date at most a year after the
//     check. --verify does not open these: the record in rules/brands.json is the check, and a
//     person repeats it before recheck_by (see hosted in that file);
//   * a real name (real_names: a word or a domain the look-alike checks must leave alone) says
//     which mark it is near, when it was looked up and what was found; a word is small letters
//     and digits, a domain is its own registrable domain and belongs to no brand.
//
// What --verify counts as passing, per domain: the name resolves (an A, AAAA or NS record, asked
// of the public resolvers 1.1.1.1 and 9.9.9.9, so a local filter does not decide), and
// https://<domain>/ (or https://www.<domain>/, or the probe host the list names for a bare name
// with no page of its own) answers, after any redirects and with a valid certificate, from the
// brand itself: a host under one of its domains or platforms, or one of its marks under another
// ending (zalando.no for zalando.com). Anything else fails, and --check then refuses the list.
//
// Node 24 built-ins only.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { publicSuffix, registrableDomain } from '../src/domain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'rules', 'brands.json');
const OUT = path.join(ROOT, 'src', 'brands.js');
const VERIFIED = path.join(ROOT, 'rules', 'brands-verified.json');

const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function readBrands(file = SRC) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function validate(data) {
  const errors = [];
  const seenDomain = new Map();
  const seenMark = new Map();
  if (!/^\d+\.\d+\.\d+$/.test(data.version || '')) errors.push('version is not x.y.z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || '')) errors.push('date is not YYYY-MM-DD');
  for (const b of data.brands) {
    if (!b.name || !Array.isArray(b.marks) || !b.marks.length || !Array.isArray(b.domains) || !b.domains.length) {
      errors.push(`${b.name || '(no name)'}: needs a name, marks and domains`);
      continue;
    }
    for (const d of b.domains) {
      if (d !== d.toLowerCase() || registrableDomain(d) !== d) errors.push(`${b.name}: ${d} is not a registrable domain in small letters`);
      if (seenDomain.has(d)) errors.push(`${d} is listed for ${seenDomain.get(d)} and ${b.name}`);
      seenDomain.set(d, b.name);
    }
    for (const d of b.platforms || []) {
      const ps = publicSuffix(d);
      if (d !== d.toLowerCase() || !ps || ps.suffix !== d || !ps.private) errors.push(`${b.name}: platform ${d} is not a suffix from the Public Suffix List's PRIVATE section`);
      if (seenDomain.has(d)) errors.push(`${d} is listed for ${seenDomain.get(d)} and ${b.name}`);
      seenDomain.set(d, b.name);
    }
    for (const h of b.hosted || []) {
      const d = h && h.name;
      const ps = d ? publicSuffix(d) : null;
      if (!d || d !== d.toLowerCase() || registrableDomain(d) !== d || !ps || !ps.private) errors.push(`${b.name}: hosted ${d} is not a registrable domain in small letters under a suffix from the Public Suffix List's PRIVATE section`);
      if (d && seenDomain.has(d)) errors.push(`${d} is listed for ${seenDomain.get(d)} and ${b.name}`);
      if (d) seenDomain.set(d, b.name);
      if (!h || !h.account || !h.found || !h.source) errors.push(`${b.name}: hosted ${d} needs the account that holds it (account), what was found (found) and where (source)`);
      const checked = h && /^\d{4}-\d{2}-\d{2}$/.test(h.checked || '') ? Date.parse(`${h.checked}T00:00:00Z`) : NaN;
      const until = h && /^\d{4}-\d{2}-\d{2}$/.test(h.recheck_by || '') ? Date.parse(`${h.recheck_by}T00:00:00Z`) : NaN;
      if (Number.isNaN(checked) || Number.isNaN(until) || until <= checked || until - checked > 366 * 86400000) errors.push(`${b.name}: hosted ${d} needs the date it was checked (checked) and a recheck_by date at most a year later`);
    }
    for (const [d, host] of Object.entries(b.probe || {})) {
      if (!b.domains.includes(d) || !host.endsWith(`.${d}`)) errors.push(`${b.name}: probe ${host} does not stand for one of its domains`);
    }
    for (const m of b.marks) {
      if (!LABEL.test(m.label || '')) errors.push(`${b.name}: mark ${m.label} is not small letters, digits and hyphens`);
      if (m.kind !== 'distinct' && m.kind !== 'word') errors.push(`${b.name}: mark ${m.label} has kind ${m.kind}`);
      if (!b.domains.includes(m.own)) errors.push(`${b.name}: mark ${m.label} cites ${m.own}, which is not one of its domains`);
      if (seenMark.has(m.label)) errors.push(`mark ${m.label} is used by ${seenMark.get(m.label)} and ${b.name}`);
      seenMark.set(m.label, b.name);
    }
  }
  for (const [kind, words] of Object.entries(data.lure_words || {})) {
    for (const w of words) if (!LABEL.test(w)) errors.push(`lure word ${w} (${kind}) is not small letters, digits and hyphens`);
  }
  const rn = data.real_names || { words: [], domains: [] };
  const seenReal = new Set();
  for (const x of [...(rn.words || []), ...(rn.domains || [])]) {
    const name = x.word || x.domain;
    if (!name || (x.word && x.domain)) errors.push(`real name ${JSON.stringify(x)} needs a word or a domain`);
    if (x.word && !/^[a-z0-9]+$/.test(x.word)) errors.push(`real name ${x.word} is not small letters and digits`);
    if (x.domain && (x.domain !== x.domain.toLowerCase() || registrableDomain(x.domain) !== x.domain)) errors.push(`real name ${x.domain} is not a registrable domain in small letters`);
    if (x.domain && seenDomain.has(x.domain)) errors.push(`real name ${x.domain} is listed for ${seenDomain.get(x.domain)}`);
    if (!seenMark.has(x.near)) errors.push(`real name ${name} is near ${x.near}, which is not a mark`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.checked || '') || !x.found) errors.push(`real name ${name} needs the date it was looked up (checked) and what was found (found)`);
    if (seenReal.has(name)) errors.push(`real name ${name} is listed twice`);
    seenReal.add(name);
  }
  return errors;
}

export function brandsModule(data) {
  // Plain ASCII output: a brand name's own letters (Elkj\u00F8p) are written as \u escapes.
  const q = (s) => JSON.stringify(s).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  const lines = [
    '// The brands CheckLink names when an address looks like theirs (stage 3), generated by',
    '// tools/brands.mjs from rules/brands.json. Do not edit by hand: run node tools/brands.mjs.',
    '//',
    '// Written by Stormberry AS and released under this repository\'s MIT licence. Every domain',
    '// below was looked up in the DNS and opened over HTTPS before it was listed; the record is',
    '// rules/brands-verified.json. rules/brands.json says who is listed and why, and what the two',
    '// kinds of mark mean; src/lookalike.js uses this list.',
    '//',
    '//   BRANDS: [{ name, marks: [[label, kind, own domain]], domains: [registrable domains],',
    '//             platforms: [public suffixes whose every name is the brand\'s own],',
    '//             hosted: [names under a free hosting address that the brand itself holds] }]',
    '//   LURES: { strong, weak, concat }: words that phishing addresses join to a brand\'s name',
    '//   REAL_NAMES: { words, domains }: real names the look-alike checks leave alone (see',
    '//             real_names in rules/brands.json for what each one is)',
    '',
    `export const BRANDS_VERSION = ${q(data.version)};`,
    `export const BRANDS_DATE = ${q(data.date)};`,
    '',
    'export const BRANDS = [',
  ];
  for (const b of data.brands) {
    lines.push(`  { name: ${q(b.name)}, marks: [${b.marks.map((m) => `[${q(m.label)}, ${q(m.kind)}, ${q(m.own)}]`).join(', ')}], domains: [${b.domains.map(q).join(', ')}]${b.platforms ? `, platforms: [${b.platforms.map(q).join(', ')}]` : ''}${b.hosted ? `, hosted: [${b.hosted.map((h) => q(h.name)).join(', ')}]` : ''} },`);
  }
  lines.push('];', '');
  lines.push('export const LURES = {');
  for (const [k, words] of Object.entries(data.lure_words)) lines.push(`  ${k}: [${words.map(q).join(', ')}],`);
  lines.push('};', '');
  const rn = data.real_names || { words: [], domains: [] };
  lines.push('export const REAL_NAMES = {');
  lines.push(`  words: [${(rn.words || []).map((x) => q(x.word)).join(', ')}],`);
  lines.push(`  domains: [${(rn.domains || []).map((x) => q(x.domain)).join(', ')}],`);
  lines.push('};', '');
  return lines.join('\n');
}

// == online verification ==

// Lookups go to public resolvers rather than the machine's own, so that a local filter (an ad
// blocker that answers 0.0.0.0 for google-analytics.com) does not decide what a brand owns.
const RESOLVERS = ['1.1.1.1', '9.9.9.9'];
let resolver = null;
async function publicResolver() {
  if (!resolver) {
    const { Resolver } = await import('node:dns/promises');
    resolver = new Resolver({ timeout: 8000, tries: 2 });
    resolver.setServers(RESOLVERS);
  }
  return resolver;
}

async function resolves(domain) {
  const r = await publicResolver();
  for (const fn of ['resolve4', 'resolve6', 'resolveNs']) {
    try {
      const out = await r[fn](domain);
      if (out && out.length) return fn.replace('resolve', '');
    } catch { /* try the next record type */ }
  }
  return null;
}

// One HTTPS GET with the certificate checked, through the public resolvers, following up to eight
// redirects and keeping the cookies a site sets on the way (some send a visitor round in a loop
// until a cookie is back). Returns { status, final } or { error }.
async function opens(start) {
  const first = await openVia(start);
  if (!first.error) return first;
  // Some sites reset a plain client (a bot filter judging the TLS handshake): fetch, through the
  // machine's own resolver, gets a second try. A local filter can only make it fail, never pass.
  try {
    const res = await fetch(start, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', Accept: 'text/html,*/*' } });
    await res.body?.cancel();
    return { status: res.status, final: res.url, via: 'fetch' };
  } catch {
    return first;
  }
}

async function openVia(start) {
  const https = await import('node:https');
  const http = await import('node:http');
  const r = await publicResolver();
  const lookup = (hostname, options, cb) => {
    r.resolve4(hostname).then((a) => (options && options.all ? cb(null, a.map((address) => ({ address, family: 4 }))) : cb(null, a[0], 4)))
      .catch(() => r.resolve6(hostname).then((a) => (options && options.all ? cb(null, a.map((address) => ({ address, family: 6 }))) : cb(null, a[0], 6))).catch((err) => cb(err)));
  };
  const jar = new Map();
  let url = start;
  for (let hop = 0; hop <= 8; hop++) {
    const u = new URL(url);
    const cookie = jar.get(u.hostname);
    const res = await new Promise((resolve) => {
      // A redirect to plain http: is followed too (a site may bounce through it); the first
      // request is always https:, so the certificate of the name itself is always checked.
      const req = (u.protocol === 'http:' ? http : https).request(u, {
        method: 'GET', lookup, timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', Accept: 'text/html,*/*', ...(cookie ? { Cookie: cookie } : {}) },
      }, (resp) => {
        resp.resume();
        resolve({ status: resp.statusCode, location: resp.headers.location, setCookie: resp.headers['set-cookie'] });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => resolve({ error: String(err.code || err.message).slice(0, 120) }));
      req.end();
    });
    if (res.error) return { error: res.error };
    if (res.setCookie) jar.set(u.hostname, [cookie, ...res.setCookie.map((c) => c.split(';')[0])].filter(Boolean).join('; '));
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url).href;
      continue;
    }
    return { status: res.status, final: url };
  }
  return { error: 'too many redirects' };
}

// Whether an address answers from the brand itself: a host under one of its domains or platforms,
// or a host whose registrable name is one of its marks under an ordinary ending (zalando.no for
// zalando.com, audible.co.uk for audible.com), or under an ending that is the brand's own name
// (banco.bradesco for bradesco.com.br).
function sameBrand(brand, url) {
  try {
    const host = new URL(url).hostname;
    const reg = registrableDomain(host);
    if ((brand.platforms || []).some((p) => host === p || host.endsWith(`.${p}`))) return true;
    if (!reg) return false;
    if (brand.domains.includes(reg)) return true;
    const ps = publicSuffix(host);
    const label = reg.slice(0, reg.length - ps.suffix.length - 1);
    const marks = brand.marks.map((m) => m.label);
    return (!ps.private && marks.includes(label)) || marks.includes(ps.suffix);
  } catch {
    return false;
  }
}

async function verifyAll(data, only = null) {
  const out = {
    checked: new Date().toISOString().slice(0, 10),
    method: 'node tools/brands.mjs --verify: a DNS lookup (A, AAAA or NS, through the public resolvers 1.1.1.1 and 9.9.9.9) and an HTTPS request (certificate checked, through the same resolvers, keeping cookies across redirects) to https://<domain>/, or https://www.<domain>/ when that fails, or the probe host rules/brands.json names for a bare name with no page of its own; following redirects; passing when the final host is the brand\'s own (under one of its domains or platforms, or one of its marks under another ending).',
    brands_version: data.version,
    domains: {},
  };
  for (const b of data.brands) {
    for (const d of [...b.domains, ...(b.platforms || [])]) {
      if (only && !only.has(d)) continue;
      const dns = await resolves(d);
      const first = b.probe && b.probe[d] ? b.probe[d] : d;
      let r = await opens(`https://${first}/`);
      let tried = `https://${first}/`;
      if (!(b.probe && b.probe[d]) && (r.error || !sameBrand(b, r.final))) {
        const w = await opens(`https://www.${d}/`);
        if (!w.error && sameBrand(b, w.final)) {
          r = w;
          tried = `https://www.${d}/`;
        }
      }
      let ok = false;
      let how = null;
      if (dns && !r.error && sameBrand(b, r.final)) {
        ok = true;
        how = 'https';
      } else if (dns && !r.error) {
        how = `answers from another site: ${new URL(r.final).hostname}`;
      } else if (dns) {
        how = `resolves, no HTTPS answer (${r.error})`;
      } else {
        how = 'does not resolve';
      }
      out.domains[d] = { brand: b.name, dns, tried, status: r.status ?? null, final: r.final ?? null, ok, how, ...(only ? { checked: out.checked } : {}) };
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${b.name}: ${d} ${how}${r.final ? ` -> ${r.final}` : ''}`);
    }
  }
  return out;
}

export function checkAll(now = new Date()) {
  const errors = [];
  const ok = [];
  const data = readBrands();
  errors.push(...validate(data));
  const want = brandsModule(data);
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== want) errors.push('src/brands.js is missing or stale: run node tools/brands.mjs');
  else ok.push(`src/brands.js current (${data.brands.length} brands, ${data.brands.reduce((n, b) => n + b.domains.length, 0)} domains, ${data.brands.reduce((n, b) => n + b.marks.length, 0)} marks)`);
  if (!existsSync(VERIFIED)) errors.push('rules/brands-verified.json is missing: run node tools/brands.mjs --verify (online)');
  else {
    const v = JSON.parse(readFileSync(VERIFIED, 'utf8'));
    let missing = 0;
    for (const b of data.brands) {
      for (const d of [...b.domains, ...(b.platforms || [])]) {
        const rec = v.domains[d];
        if (!rec || rec.ok !== true || rec.brand !== b.name) {
          missing++;
          errors.push(`${b.name}: ${d} has no passing record in rules/brands-verified.json`);
        }
      }
    }
    if (!missing) ok.push(`every domain has a passing record in rules/brands-verified.json (checked ${v.checked})`);
  }
  // A hosted name is the brand's only for as long as the account that holds it is: once its
  // recheck_by date has passed, the list is refused until a person has looked again.
  const hosted = data.brands.flatMap((b) => (b.hosted || []).map((h) => ({ brand: b.name, ...h })));
  const today = now.toISOString().slice(0, 10);
  const due = hosted.filter((h) => typeof h.recheck_by === 'string' && h.recheck_by < today);
  for (const h of due) errors.push(`${h.brand}: hosted ${h.name} was due to be checked again by ${h.recheck_by}; look the account ${h.account} up again (see hosted in rules/brands.json), then update checked, found and recheck_by, or remove the name`);
  if (hosted.length && !due.length) ok.push(`${hosted.length} hosted names checked, the next due by ${hosted.map((h) => h.recheck_by).sort()[0]}`);
  return { errors, ok };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  try {
    const data = readBrands();
    if (args.includes('--verify-missing')) {
      // Only the domains with no passing record for their brand; every other record is kept.
      const errs = validate(data);
      if (errs.length) throw new Error(errs.join('; '));
      const old = existsSync(VERIFIED) ? JSON.parse(readFileSync(VERIFIED, 'utf8')) : { domains: {} };
      const missing = new Set();
      for (const b of data.brands) {
        for (const d of [...b.domains, ...(b.platforms || [])]) {
          const rec = old.domains[d];
          if (!rec || rec.ok !== true || rec.brand !== b.name) missing.add(d);
        }
      }
      if (!missing.size) {
        console.log('every domain already has a passing record');
      } else {
        const fresh = await verifyAll(data, missing);
        const merged = { ...old, brands_version: data.version, domains: { ...old.domains, ...fresh.domains } };
        if (!merged.method) merged.method = fresh.method;
        writeFileSync(VERIFIED, `${JSON.stringify(merged, null, 2)}\n`);
        const bad = Object.values(fresh.domains).filter((r) => !r.ok).length;
        console.log(`checked ${missing.size} domains: ${missing.size - bad} pass, ${bad} fail`);
        if (bad) process.exit(1);
      }
    } else if (args.includes('--verify')) {
      const errs = validate(data);
      if (errs.length) throw new Error(errs.join('; '));
      const out = await verifyAll(data);
      const old = existsSync(VERIFIED) ? JSON.parse(readFileSync(VERIFIED, 'utf8')) : null;
      // A domain that passed before and fails now only because a site was slow is kept as it was,
      // with the new attempt noted: a person decides whether to drop it.
      if (old) {
        for (const [d, rec] of Object.entries(out.domains)) {
          if (!rec.ok && old.domains[d]?.ok) out.domains[d] = { ...old.domains[d], retried: out.checked, retry_result: rec.how };
        }
      }
      writeFileSync(VERIFIED, `${JSON.stringify(out, null, 2)}\n`);
      const bad = Object.values(out.domains).filter((r) => !r.ok).length;
      console.log(`wrote rules/brands-verified.json: ${Object.keys(out.domains).length - bad} pass, ${bad} fail`);
      if (bad) process.exit(1);
    } else if (args.includes('--check')) {
      const { errors, ok } = checkAll();
      for (const line of ok) console.log(`ok   ${line}`);
      for (const line of errors) console.log(`FAIL ${line}`);
      if (errors.length) process.exit(1);
      console.log('brand list current and verified');
    } else if (!args.length) {
      const errs = validate(data);
      if (errs.length) throw new Error(errs.join('; '));
      writeFileSync(OUT, brandsModule(data));
      console.log(`wrote src/brands.js (${data.brands.length} brands)`);
    } else {
      throw new Error(`unknown arguments: ${args.join(' ')}`);
    }
  } catch (err) {
    console.error(`brands.mjs: ${err.message}`);
    process.exit(1);
  }
}
