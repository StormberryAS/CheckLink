#!/usr/bin/env node
// Builds and checks CheckLink's third-party data and code. Run by a person, never by the app,
// and never online: it reads only files already in this repository (and, with --zxing, one
// tarball the person downloaded and passes by path). tools/upstream.lock.json is the record of
// every pin: version, source address, size, sha256 or sha512, and licence.
//
//   node tools/vendor.mjs                 write src/psl.js, src/bip39.js, src/wordlists.js and
//                                         src/confusables.js from third_party/
//   node tools/vendor.mjs --check         exit 1 if anything below does not hold
//   node tools/vendor.mjs --release       --check, and also fail when the Public Suffix List copy
//                                         is more than 90 days old (spec section 4)
//   node tools/vendor.mjs --zxing FILE    re-vendor the QR decoder from the npm tarball FILE,
//                                         after checking FILE against the integrity in the lock
//   node tools/vendor.mjs --qrcodegen FILE
//                                         convert the QR encoder (third_party/qrcodegen/
//                                         qrcodegen.ts) to plain JavaScript again with the
//                                         TypeScript compiler in the npm tarball FILE (the
//                                         version and integrity the lock pins); stage 4b
//
// --check proves, with no network:
//   * third_party/ holds exactly the bytes the lock pins (Public Suffix List, the BIP-39 word
//     lists, the Monero and SLIP-39 word lists, Unicode's confusables.txt), and each Monero list
//     names the prefix length the lock records;
//   * src/psl.js, src/bip39.js, src/wordlists.js and src/confusables.js are what this script
//     writes from them (byte for byte);
//   * every file in vendor/zxing-wasm-<version>/ has the sha256 the lock records, the three
//     files taken from the npm tarball are unmodified, and zxing_reader.wasm.js decodes back
//     to the pinned zxing_reader.wasm: its sha256 equals both the lock and the
//     ZXING_WASM_SHA256 constant that the vendored reader itself carries;
//   * third_party/qrcodegen/qrcodegen.ts is the pinned upstream file, and
//     vendor/qrcodegen-<commit>/qrcodegen.js is the recorded conversion of it: CheckLink's header,
//     the compiler's output with the sha256 the lock records, and the one export line (stage 4b);
//   * every licence text in licences/ has the sha256 the lock records;
//   * rules/research/ holds exactly the search-engine research summaries the lock records,
//     each with its recorded sha256;
//   * every Inter font file is byte for byte the one in the Inter 4.1 release.
//
// Node 24 built-ins only.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { domainToASCII, fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(ROOT, 'tools', 'upstream.lock.json');
const MAX_PSL_AGE_DAYS = 90;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha512b64 = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function readLock() {
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
}

const byId = (lock, id) => {
  const e = lock.vendored.find((x) => x.id === id);
  if (!e) throw new Error(`tools/upstream.lock.json has no vendored entry "${id}"`);
  return e;
};

// == Public Suffix List ==

// The list's own sections, as rules in the form a browser gives host names (xn-- for
// international names; wildcards and exceptions kept). Comments and blank lines go.
export function parsePsl(text) {
  const version = /^\/\/ VERSION: (\S+)$/m.exec(text);
  const commit = /^\/\/ COMMIT: ([0-9a-f]{40})$/m.exec(text);
  if (!version || !commit) throw new Error('the Public Suffix List copy has no VERSION or COMMIT line (take it from https://publicsuffix.org/list/public_suffix_list.dat)');
  const section = (name) => {
    const begin = text.indexOf(`// ===BEGIN ${name} DOMAINS===`);
    const end = text.indexOf(`// ===END ${name} DOMAINS===`);
    if (begin < 0 || end < begin) throw new Error(`the Public Suffix List has no ${name} section`);
    const out = [];
    for (const raw of text.slice(begin, end).split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      const rule = line.split(/\s/)[0];
      const lead = rule.startsWith('!') ? '!' : '';
      const body = lead ? rule.slice(1) : rule;
      const wild = body.startsWith('*.') ? '*.' : '';
      const name = wild ? body.slice(2) : body;
      if (body === '*') throw new Error('a bare * rule is not expected in the list');
      const ascii = /^[\x21-\x7e]+$/.test(name) ? name.toLowerCase() : domainToASCII(name);
      if (!ascii || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(ascii)) throw new Error(`cannot convert the rule ${rule} to the form browsers use`);
      out.push(`${lead}${wild}${ascii}`);
    }
    return out;
  };
  return { version: version[1], commit: commit[1], date: version[1].slice(0, 10), icann: section('ICANN'), private: section('PRIVATE') };
}

function pslModule(psl, sourceSha) {
  for (const r of [...psl.icann, ...psl.private]) if (r.includes('`') || r.includes('$')) throw new Error(`unexpected character in rule ${r}`);
  return `// The Public Suffix List, generated by tools/vendor.mjs from
// third_party/publicsuffix/public_suffix_list.dat. Do not edit by hand: run node tools/vendor.mjs.
//
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// The licence text ships as licences/Public-Suffix-List-MPL-2.0.txt.
//
// Source: https://publicsuffix.org/list/public_suffix_list.dat
// Version ${psl.version}, commit ${psl.commit}
// sha256 of the source file: ${sourceSha}
//
// What changed from the source: comments and blank lines are left out, international names are
// written in the xn-- form a browser gives host names, and the two sections (ICANN and PRIVATE)
// are kept apart, one rule per line. src/domain.js reads it.

export const PSL_VERSION = '${psl.version}';
export const PSL_DATE = '${psl.date}';
export const PSL_COMMIT = '${psl.commit}';

// ${psl.icann.length} rules from the list's ICANN section.
export const PSL_ICANN = \`${psl.icann.join('\n')}\`;

// ${psl.private.length} rules from the list's PRIVATE section: names whose owner lets others
// make their own addresses under them (github.io, blogspot.com, co.no).
export const PSL_PRIVATE = \`${psl.private.join('\n')}\`;
`;
}

// == BIP-39 English words ==

function bip39Module(text, entry) {
  const words = text.split('\n').filter(Boolean);
  if (words.length !== 2048 || words.some((w) => !/^[a-z]{3,8}$/.test(w))) throw new Error('the BIP-39 list is not 2,048 words of 3 to 8 small letters');
  const sorted = [...words].sort();
  if (sorted.some((w, i) => w !== words[i])) throw new Error('the BIP-39 list is not in order');
  return `// The BIP-39 English word list (2,048 words), generated by tools/vendor.mjs from
// third_party/bip39/english.txt. Do not edit by hand: run node tools/vendor.mjs.
//
// Source: ${entry.source}
// Commit ${entry.commit}, sha256 of the source file ${entry.sha256}
// Licence: MIT (BIP 39 says "License: MIT"); the text ships as licences/BIP-0039-MIT.txt.
//
// CheckLink uses it only to recognise a wallet recovery phrase in a code, so it can hide it and
// warn. The words are in the list's own order: a word's position is its number in a phrase.

export const BIP39_ENGLISH = '${words.join(' ')}'.split(' ');
`;
}

// == the other recovery-phrase word lists ==

// The words of one list file: a BIP-39 or SLIP-39 list has one word per line; Monero's list is
// a C++ header whose words are the quoted strings of its words[] table, one per line.
function listWords(text, list) {
  if (list.format === 'monero-header') {
    const body = text.slice(text.indexOf('words[NWORDS] ='), text.indexOf('};', text.indexOf('words[NWORDS] =')));
    return [...body.matchAll(/^\s*"([^"\\]+)",?\s*$/gm)].map((m) => m[1]);
  }
  return text.split('\n').filter(Boolean);
}

// How many letters of each word a Monero list's checksum reads: the last argument of the
// Base(...) call in its header (3 for English, 1 for Chinese, 4 for most others).
function moneroPrefix(text) {
  const m = /:\s*Base\(.*,\s*\{\},\s*(\d+)\)/.exec(text);
  return m ? Number(m[1]) : null;
}

// A word as a list may write it: letters of any alphabet and their marks, so small Latin letters
// with accents, kana, Hangul, Chinese characters, German nouns with their capital letter, and
// the Lojban apostrophe between letters. Nothing that could end a string in the module.
const WORD = /^[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*$/u;
// One list as a JavaScript string: in single quotes, or in double quotes when a word holds an
// apostrophe (Lojban).
const listString = (words) => (words.some((w) => w.includes("'")) ? JSON.stringify(words.join(' ')) : `'${words.join(' ')}'`);

function wordlistsModule(entry, texts) {
  const out = [];
  for (const list of entry.lists) {
    const words = listWords(texts[list.name], list);
    if (words.length !== list.words) throw new Error(`${list.path}: ${words.length} words, the lock says ${list.words}`);
    if (new Set(words).size !== words.length) throw new Error(`${list.path}: a word appears twice`);
    if (words.some((w) => !WORD.test(w) || w.includes('`') || w.includes('$') || w.includes('"') || w.includes('\\'))) throw new Error(`${list.path}: a word is not letters only`);
    if (list.format === 'monero-header') {
      const prefix = moneroPrefix(texts[list.name]);
      if (prefix !== list.unique_prefix) throw new Error(`${list.path}: prefix length ${prefix}, the lock says ${list.unique_prefix}`);
      // Monero refuses a list whose words share a prefix, unless the list says it allows that
      // (the old English list does; its checksum reads the prefixes, so it still works).
      const dupesAllowed = /populate_maps\([^)]*ALLOW_DUPLICATE_PREFIXES/.test(texts[list.name]);
      if (!dupesAllowed && new Set(words.map((w) => Array.from(w.toLowerCase()).slice(0, prefix).join(''))).size !== words.length) throw new Error(`${list.path}: two words share their first ${prefix} letters`);
    }
    out.push({ list, words });
  }
  const lines = [
    '// Recovery-phrase word lists other than BIP-39 English (src/bip39.js), generated by',
    '// tools/vendor.mjs from third_party/. Do not edit by hand: run node tools/vendor.mjs.',
    '//',
    '// CheckLink uses them only to recognise a wallet recovery phrase in a code, so it can hide it',
    '// and warn. The words are in each list\u2019s own order (a word\u2019s position is its number) and',
    '// exactly as the source writes them (the BIP-39 lists in Unicode NFKD form, the Monero lists',
    '// in NFC). MONERO_PREFIX says how many letters of each word a Monero seed\u2019s checksum reads.',
    '//',
  ];
  for (const { list } of out) {
    lines.push(`// ${list.export}${list.key ? `.${list.key}` : ''}: ${list.what}`);
    lines.push(`//   ${list.source}`);
    lines.push(`//   commit ${list.commit}, sha256 of the source file ${list.sha256}; licence ${list.licence}`);
  }
  lines.push('');
  const groups = new Map();
  for (const item of out) {
    if (!groups.has(item.list.export)) groups.set(item.list.export, []);
    groups.get(item.list.export).push(item);
  }
  for (const [name, items] of groups) {
    if (items.length === 1 && !items[0].list.key) {
      lines.push(`export const ${name} = '${items[0].words.join(' ')}'.split(' ');`);
    } else if (items.length === 1 && name === 'MONERO_ENGLISH') {
      // English keeps its own export; its key only names it in MONERO_PREFIX.
      lines.push(`export const ${name} = ${listString(items[0].words)}.split(' ');`);
    } else {
      lines.push(`export const ${name} = {`);
      for (const { list, words } of items) lines.push(`  ${list.key}: ${listString(words)}.split(' '),`);
      lines.push('};');
    }
    lines.push('');
  }
  const monero = out.filter(({ list }) => list.format === 'monero-header');
  if (monero.length) {
    lines.push(`export const MONERO_PREFIX = { ${monero.map(({ list }) => `${list.key}: ${list.unique_prefix}`).join(', ')} };`);
    lines.push('');
  }
  return lines.join('\n');
}

function readWordlists(entry) {
  const texts = {};
  const errors = [];
  for (const list of entry.lists) {
    const p = path.join(ROOT, list.path);
    const buf = existsSync(p) ? readFileSync(p) : null;
    const got = buf ? sha256(buf) : null;
    if (got !== list.sha256) errors.push(`${list.path}: sha256 ${got} is not the pinned ${list.sha256}`);
    else texts[list.name] = buf.toString('utf8');
  }
  return { texts, errors };
}

// == Unicode confusables (stage 3) ==

// The part of Unicode's confusables.txt that CheckLink uses for its look-alike checks: every
// character whose prototype, once accents and other combining marks are taken off, is plain
// printable ASCII (the Cyrillic a -> a, the Armenian o -> o, U+2010 hyphen -> -, the digit 0 -> O,
// m -> rn, the slashed o -> o). Mappings into other non-Latin letters are left out: CheckLink only asks
// whether a name can pass for a Latin one. Returns { version, date, map } with map a Map of
// code point -> ASCII text, in code point order.
export function parseConfusables(text) {
  const version = /^# Version: (\S+)\s*$/m.exec(text);
  const date = /^# Date: (\d{4}-\d{2}-\d{2})/m.exec(text);
  if (!version || !date) throw new Error('the confusables.txt copy has no Version or Date line (take it from https://www.unicode.org/Public/<version>/security/confusables.txt)');
  const map = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const cols = line.split(';').map((s) => s.trim());
    if (cols.length < 2 || !/^[0-9A-F]{4,6}$/.test(cols[0])) throw new Error(`unexpected line in confusables.txt: ${raw.slice(0, 80)}`);
    const cp = parseInt(cols[0], 16);
    const target = String.fromCodePoint(...cols[1].split(/\s+/).map((h) => parseInt(h, 16)));
    const ascii = target.normalize('NFD').replace(/\p{M}/gu, '');
    if (!ascii || !/^[\x20-\x7e]+$/.test(ascii)) continue;
    if (map.has(cp)) throw new Error(`U+${cols[0]} appears twice in confusables.txt`);
    map.set(cp, ascii);
  }
  return { version: version[1], date: date[1], map: new Map([...map].sort((a, b) => a[0] - b[0])) };
}

function confusablesModule(conf, entry) {
  const rows = [...conf.map].map(([cp, ascii]) => `0x${cp.toString(16).toUpperCase().padStart(4, '0')}:${JSON.stringify(ascii)}`);
  const lines = [];
  for (let i = 0; i < rows.length; i += 8) lines.push(`  ${rows.slice(i, i + 8).join(',')},`);
  return `// Unicode confusables, the ASCII part, generated by tools/vendor.mjs from
// third_party/unicode/confusables.txt. Do not edit by hand: run node tools/vendor.mjs.
//
// Source: ${entry.source}
// Unicode Security Mechanisms for UTS #39, version ${conf.version}, dated ${conf.date}
// sha256 of the source file: ${entry.sha256}
//
// Copyright (c) 1991-2026 Unicode, Inc. Licensed under the Unicode License v3
// (Unicode-3.0); the full copyright and permission notice ships as licences/Unicode-3.0.txt.
//
// What changed from the source: only the ${conf.map.size.toLocaleString('en-GB')} characters whose prototype is plain
// printable ASCII once combining marks are taken off are kept (Cyrillic small a -> "a", the
// digit zero -> "O", m -> "rn", U+2010 hyphen -> "-"), keyed by code point. src/lookalike.js
// reads it to tell whether a name can pass for a Latin one.

export const CONFUSABLES_VERSION = '${conf.version}';
export const CONFUSABLES_DATE = '${conf.date}';

export const CONFUSABLES = {
${lines.join('\n')}
};
`;
}

// == the QR decoder ==

// The minimal tar reader the --zxing option needs: regular files only, ustar names.
function untar(buf) {
  const files = new Map();
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = (field(345, 500) ? `${field(345, 500)}/` : '') + field(0, 100);
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = field(156, 157) || '0';
    const start = off + 512;
    if (type === '0') files.set(name, buf.subarray(start, start + size));
    off = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function wasmModule(wasm, entry) {
  return `// zxing-wasm ${entry.version}: the decoder's zxing_reader.wasm, ${wasm.length.toLocaleString('en-GB')} bytes,
// sha256 ${sha256(wasm)},
// written as base64 in a JavaScript module, so the page loads it as a script from its own
// address and never needs a network fetch (connect-src 'none'). Generated by tools/vendor.mjs;
// node tools/vendor.mjs --check proves it decodes back to those exact bytes.
// Licences: licences/zxing-wasm-MIT.txt and the others listed in NOTICE.
export default '${wasm.toString('base64')}';
`;
}

function vendorZxing(tarball, lock) {
  const entry = byId(lock, 'zxing-wasm');
  const buf = readFileSync(tarball);
  const got = sha512b64(buf);
  if (got !== entry.integrity) throw new Error(`${tarball}: integrity ${got} is not the pinned ${entry.integrity}`);
  const files = untar(gunzipSync(buf));
  const dir = path.join(ROOT, entry.dir);
  for (const [from, to] of Object.entries(entry.taken_unmodified)) {
    const bytes = files.get(from);
    if (!bytes) throw new Error(`${tarball} has no ${from}`);
    mkdirSync(path.dirname(path.join(ROOT, to)), { recursive: true });
    writeFileSync(path.join(ROOT, to), bytes);
  }
  const wasm = files.get(entry.wasm.from);
  if (!wasm) throw new Error(`${tarball} has no ${entry.wasm.from}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(ROOT, entry.wasm.module), wasmModule(Buffer.from(wasm), entry));
  console.log(`vendored zxing-wasm ${entry.version} into ${entry.dir}; now record the new sha256 values in the lock and run --check`);
}

// == the QR encoder (stage 4b) ==

// Nayuki's QR Code generator ships as one TypeScript file and no JavaScript, so it is converted
// once, with the TypeScript compiler the lock pins: types taken out and each namespace turned
// into a function, as upstream's own build does (build.sh: tsc --strict --target ES6). CheckLink
// adds a header before the compiler's output and one export line after it, and changes nothing
// else. --check needs no compiler: it proves the three parts and their hashes.
function qrcodegenHeader(entry) {
  const tool = entry.conversion.tool;
  return `// Nayuki's QR Code generator library (TypeScript), converted to plain JavaScript for CheckLink.
//
// Source: ${entry.source}
// (commit ${entry.commit} of ${entry.commit_date.slice(0, 10)}, sha256 ${entry.sha256})
// Converted by node tools/vendor.mjs --qrcodegen with ${tool.package} ${tool.version}: types taken out
// and each namespace turned into a function, as upstream's own build (tsc --strict --target ES6)
// does, then one line at the end that exports the namespace. Nothing else is changed. The
// upstream licence (MIT) follows; it ships as licences/QR-Code-generator-MIT.txt.
//
`;
}

const QRCODEGEN_FOOTER = `
// Added by tools/vendor.mjs, not part of the upstream file: the namespace as this module's export.
export default qrcodegen;
`;

function qrcodegenModule(tscOutput, entry) {
  return `${qrcodegenHeader(entry)}${tscOutput}${QRCODEGEN_FOOTER}`;
}

function convertQrcodegen(tarball, lock) {
  const entry = byId(lock, 'qrcodegen');
  const tool = entry.conversion.tool;
  const buf = readFileSync(tarball);
  const got = sha512b64(buf);
  if (got !== tool.integrity) throw new Error(`${tarball}: integrity ${got} is not the pinned ${tool.package} ${tool.version} (${tool.integrity})`);
  const compiler = untar(gunzipSync(buf)).get('package/lib/typescript.js');
  if (!compiler) throw new Error(`${tarball} has no package/lib/typescript.js`);
  const source = readFileSync(path.join(ROOT, entry.path));
  if (sha256(source) !== entry.sha256) throw new Error(`${entry.path} is not the pinned copy: update the lock first`);
  // The compiler runs from a fresh folder of its own, outside the repository, and is deleted after.
  const dir = mkdtempSync(path.join(tmpdir(), 'checklink-tsc-'));
  try {
    writeFileSync(path.join(dir, 'typescript.js'), compiler);
    const ts = createRequire(path.join(dir, 'index.js'))('./typescript.js');
    if (ts.version !== tool.version) throw new Error(`the compiler in ${tarball} says it is ${ts.version}, not ${tool.version}`);
    const { options, errors } = ts.convertCompilerOptionsFromJson(entry.conversion.compiler_options, dir);
    if (errors.length) throw new Error(`compiler options: ${errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('; ')}`);
    const out = ts.transpileModule(source.toString('utf8'), { compilerOptions: options, reportDiagnostics: true, fileName: 'qrcodegen.ts' });
    if (out.diagnostics.length) throw new Error(`the compiler reported: ${out.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`);
    const file = path.join(ROOT, entry.converted);
    mkdirSync(path.dirname(file), { recursive: true });
    const text = qrcodegenModule(out.outputText, entry);
    writeFileSync(file, text);
    console.log(`converted ${entry.path} into ${entry.converted}: compiler output ${Buffer.byteLength(out.outputText)} bytes, sha256 ${sha256(Buffer.from(out.outputText))}; file ${Buffer.byteLength(text)} bytes, sha256 ${sha256(Buffer.from(text))}. Record both in the lock and run --check`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The converted file split back into its three parts, or null when it is not built that way.
function qrcodegenParts(text, entry) {
  const head = qrcodegenHeader(entry);
  if (!text.startsWith(head) || !text.endsWith(QRCODEGEN_FOOTER)) return null;
  return { head, output: text.slice(head.length, text.length - QRCODEGEN_FOOTER.length), foot: QRCODEGEN_FOOTER };
}

// == checks ==

function checkAll({ release }) {
  const lock = readLock();
  const errors = [];
  const ok = [];
  const fileSha = (p) => (existsSync(p) ? sha256(readFileSync(p)) : null);

  // Public Suffix List
  const pslEntry = byId(lock, 'public-suffix-list');
  const pslPath = path.join(ROOT, pslEntry.path);
  const pslSha = fileSha(pslPath);
  if (pslSha !== pslEntry.sha256) errors.push(`${pslEntry.path}: sha256 ${pslSha} is not the pinned ${pslEntry.sha256}`);
  else {
    const psl = parsePsl(readFileSync(pslPath, 'utf8'));
    if (psl.version !== pslEntry.version || psl.commit !== pslEntry.commit) errors.push(`${pslEntry.path}: version ${psl.version} / commit ${psl.commit} differ from the lock`);
    const want = pslModule(psl, pslSha);
    const out = path.join(ROOT, pslEntry.generated);
    if (!existsSync(out) || readFileSync(out, 'utf8') !== want) errors.push(`${pslEntry.generated} is missing or stale: run node tools/vendor.mjs`);
    else ok.push(`${pslEntry.generated} current (${psl.icann.length} ICANN and ${psl.private.length} private rules, version ${psl.version})`);
    const age = Math.floor((Date.now() - Date.parse(`${psl.date}T00:00:00Z`)) / 86400000);
    if (release && age > MAX_PSL_AGE_DAYS) errors.push(`the Public Suffix List copy is ${age} days old (more than ${MAX_PSL_AGE_DAYS}): take the current one from https://publicsuffix.org/list/public_suffix_list.dat`);
    else ok.push(`Public Suffix List copy is ${age} days old${release ? ` (limit ${MAX_PSL_AGE_DAYS})` : ''}`);
  }

  // BIP-39
  const bip = byId(lock, 'bip39-english');
  const bipPath = path.join(ROOT, bip.path);
  const bipSha = fileSha(bipPath);
  if (bipSha !== bip.sha256) errors.push(`${bip.path}: sha256 ${bipSha} is not the pinned ${bip.sha256}`);
  else {
    const want = bip39Module(readFileSync(bipPath, 'utf8'), bip);
    const out = path.join(ROOT, bip.generated);
    if (!existsSync(out) || readFileSync(out, 'utf8') !== want) errors.push(`${bip.generated} is missing or stale: run node tools/vendor.mjs`);
    else ok.push(`${bip.generated} current (2,048 words)`);
  }

  // The other recovery-phrase word lists
  const wl = byId(lock, 'recovery-word-lists');
  const { texts, errors: wlErrors } = readWordlists(wl);
  errors.push(...wlErrors);
  if (!wlErrors.length) {
    const want = wordlistsModule(wl, texts);
    const out = path.join(ROOT, wl.generated);
    if (!existsSync(out) || readFileSync(out, 'utf8') !== want) errors.push(`${wl.generated} is missing or stale: run node tools/vendor.mjs`);
    else ok.push(`${wl.generated} current (${wl.lists.map((l) => `${l.name} ${l.words}`).join(', ')})`);
  }

  // Unicode confusables (stage 3)
  const cf = byId(lock, 'unicode-confusables');
  const cfPath = path.join(ROOT, cf.path);
  const cfSha = fileSha(cfPath);
  if (cfSha !== cf.sha256) errors.push(`${cf.path}: sha256 ${cfSha} is not the pinned ${cf.sha256}`);
  else {
    const conf = parseConfusables(readFileSync(cfPath, 'utf8'));
    if (conf.version !== cf.version || conf.date !== cf.file_date) errors.push(`${cf.path}: version ${conf.version} dated ${conf.date} differs from the lock`);
    else if (conf.map.size !== cf.entries_kept) errors.push(`${cf.path}: ${conf.map.size} ASCII entries, the lock says ${cf.entries_kept}`);
    const want = confusablesModule(conf, cf);
    const out = path.join(ROOT, cf.generated);
    if (!existsSync(out) || readFileSync(out, 'utf8') !== want) errors.push(`${cf.generated} is missing or stale: run node tools/vendor.mjs`);
    else ok.push(`${cf.generated} current (${conf.map.size.toLocaleString('en-GB')} characters from confusables.txt ${conf.version})`);
  }

  // zxing-wasm
  const z = byId(lock, 'zxing-wasm');
  const zdir = path.join(ROOT, z.dir);
  const shipped = existsSync(zdir) ? readdirSync(zdir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => rel(path.join(d.parentPath, d.name))).sort() : [];
  const listed = Object.keys(z.files).sort();
  if (JSON.stringify(shipped) !== JSON.stringify(listed)) errors.push(`${z.dir} holds ${JSON.stringify(shipped)}, the lock lists ${JSON.stringify(listed)}`);
  for (const [p, want] of Object.entries(z.files)) {
    const got = fileSha(path.join(ROOT, p));
    if (got !== want) errors.push(`${p}: sha256 ${got} is not the pinned ${want}`);
  }
  for (const [from, to] of Object.entries(z.taken_unmodified)) {
    if (z.tarball_files[from] !== z.files[to]) errors.push(`${to} is recorded as unmodified, but its sha256 differs from ${from} in the npm tarball`);
  }
  const modPath = path.join(ROOT, z.wasm.module);
  if (existsSync(modPath)) {
    const m = /^export default '([A-Za-z0-9+/=]+)';$/m.exec(readFileSync(modPath, 'utf8'));
    const wasm = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0);
    const got = sha256(wasm);
    // The vendored reader exports the hash of the wasm it was built with as ZXING_WASM_SHA256
    // (export { ..., pe as ZXING_WASM_SHA256 } with var pe = "<hex>").
    const readerText = existsSync(path.join(ROOT, z.reader)) ? readFileSync(path.join(ROOT, z.reader), 'utf8') : '';
    const carried = (/\b([\w$]+) as ZXING_WASM_SHA256\b/.exec(readerText) || [])[1];
    const carriedValue = carried ? (new RegExp(`var ${carried.replace(/\$/g, '\\$')} = "([0-9a-f]{64})"`).exec(readerText) || [])[1] : null;
    if (got !== z.wasm.sha256) errors.push(`${z.wasm.module} decodes to sha256 ${got}, not the pinned zxing_reader.wasm ${z.wasm.sha256}`);
    else if (carriedValue !== got) errors.push(`${z.reader} does not carry ZXING_WASM_SHA256 = ${got} (it carries ${carriedValue})`);
    else if (wasm.length !== z.wasm.bytes) errors.push(`${z.wasm.module} decodes to ${wasm.length} bytes, not ${z.wasm.bytes}`);
    else if (readFileSync(modPath, 'utf8') !== wasmModule(wasm, z)) errors.push(`${z.wasm.module} is not exactly what this script writes`);
    else ok.push(`${z.wasm.module} decodes to the pinned zxing_reader.wasm (${wasm.length} bytes, sha256 ${got}), the same hash the vendored reader carries`);
  } else errors.push(`${z.wasm.module} is missing`);

  // The QR encoder (stage 4b): the pinned upstream file, and its recorded conversion.
  const qg = byId(lock, 'qrcodegen');
  const qgSha = fileSha(path.join(ROOT, qg.path));
  if (qgSha !== qg.sha256) errors.push(`${qg.path}: sha256 ${qgSha} is not the pinned ${qg.sha256}`);
  const qgDir = path.join(ROOT, path.dirname(qg.converted));
  const qgFiles = existsSync(qgDir) ? readdirSync(qgDir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => rel(path.join(d.parentPath, d.name))).sort() : [];
  if (JSON.stringify(qgFiles) !== JSON.stringify([qg.converted])) errors.push(`${path.dirname(qg.converted)} holds ${JSON.stringify(qgFiles)}, the lock lists only ${qg.converted}`);
  const qgPath = path.join(ROOT, qg.converted);
  if (existsSync(qgPath)) {
    const text = readFileSync(qgPath, 'utf8');
    const parts = qrcodegenParts(text, qg);
    const outSha = parts ? sha256(Buffer.from(parts.output)) : null;
    if (!parts) errors.push(`${qg.converted} is not the header, the compiler's output and the export line that tools/vendor.mjs writes`);
    else if (outSha !== qg.conversion.output_sha256) errors.push(`${qg.converted}: the compiler's output has sha256 ${outSha}, not the recorded ${qg.conversion.output_sha256}`);
    else if (sha256(Buffer.from(text)) !== qg.converted_sha256) errors.push(`${qg.converted}: sha256 ${sha256(Buffer.from(text))} is not the recorded ${qg.converted_sha256}`);
    else ok.push(`${qg.converted} is the recorded conversion of ${qg.path} (commit ${qg.commit.slice(0, 12)}, ${qg.conversion.tool.package} ${qg.conversion.tool.version})`);
  } else errors.push(`${qg.converted} is missing`);

  // Inter: every font file as released (Inter 4.1, web/ in the release zip)
  const inter = byId(lock, 'inter');
  let interBad = 0;
  for (const [p, want] of Object.entries(inter.files)) {
    const got = fileSha(path.join(ROOT, p));
    if (got !== want) {
      interBad++;
      errors.push(`${p}: sha256 ${got} is not Inter ${inter.version}'s ${want}`);
    }
  }
  if (!interBad) ok.push(`${Object.keys(inter.files).length} Inter ${inter.version} files match the release`);

  // licences
  for (const l of lock.licence_files) {
    const got = fileSha(path.join(ROOT, l.path));
    if (got !== l.sha256) errors.push(`${l.path}: sha256 ${got} is not the recorded ${l.sha256}`);
  }
  const licDir = path.join(ROOT, 'licences');
  const onDisk = existsSync(licDir) ? readdirSync(licDir).map((n) => `licences/${n}`).sort() : [];
  const recorded = lock.licence_files.map((l) => l.path).sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(recorded)) errors.push(`licences/ holds ${JSON.stringify(onDisk)}, the lock records ${JSON.stringify(recorded)}`);
  else ok.push(`${recorded.length} licence texts match the lock`);

  // The search-engine research summaries (decision R-1): exactly the recorded files, unchanged.
  const research = (lock.search_research_files && lock.search_research_files.files) || [];
  const resDir = path.join(ROOT, 'rules', 'research');
  const resOnDisk = existsSync(resDir) ? readdirSync(resDir).map((n) => `rules/research/${n}`).sort() : [];
  const resRecorded = research.map((f) => f.path).sort();
  let resBad = 0;
  if (JSON.stringify(resOnDisk) !== JSON.stringify(resRecorded)) {
    resBad++;
    errors.push(`rules/research/ holds ${JSON.stringify(resOnDisk)}, the lock records ${JSON.stringify(resRecorded)}`);
  }
  for (const f of research) {
    const got = fileSha(path.join(ROOT, f.path));
    if (got !== f.sha256) {
      resBad++;
      errors.push(`${f.path}: sha256 ${got} is not the recorded ${f.sha256}`);
    }
  }
  if (research.length && !resBad) ok.push(`${research.length} search-engine research summaries in rules/research/ match the lock`);

  return { errors, ok };
}

function writeGenerated() {
  const lock = readLock();
  const pslEntry = byId(lock, 'public-suffix-list');
  const pslBuf = readFileSync(path.join(ROOT, pslEntry.path));
  if (sha256(pslBuf) !== pslEntry.sha256) throw new Error(`${pslEntry.path} is not the pinned copy: update the lock first`);
  const psl = parsePsl(pslBuf.toString('utf8'));
  writeFileSync(path.join(ROOT, pslEntry.generated), pslModule(psl, sha256(pslBuf)));
  const bip = byId(lock, 'bip39-english');
  const bipBuf = readFileSync(path.join(ROOT, bip.path));
  if (sha256(bipBuf) !== bip.sha256) throw new Error(`${bip.path} is not the pinned copy: update the lock first`);
  writeFileSync(path.join(ROOT, bip.generated), bip39Module(bipBuf.toString('utf8'), bip));
  const wl = byId(lock, 'recovery-word-lists');
  const { texts, errors } = readWordlists(wl);
  if (errors.length) throw new Error(`${errors.join('; ')}: update the lock first`);
  writeFileSync(path.join(ROOT, wl.generated), wordlistsModule(wl, texts));
  const cf = byId(lock, 'unicode-confusables');
  const cfBuf = readFileSync(path.join(ROOT, cf.path));
  if (sha256(cfBuf) !== cf.sha256) throw new Error(`${cf.path} is not the pinned copy: update the lock first`);
  const conf = parseConfusables(cfBuf.toString('utf8'));
  writeFileSync(path.join(ROOT, cf.generated), confusablesModule(conf, cf));
  console.log(`wrote ${pslEntry.generated} (version ${psl.version}), ${bip.generated}, ${wl.generated} and ${cf.generated} (${conf.map.size.toLocaleString('en-GB')} characters)`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--zxing') {
      if (!args[1]) throw new Error('--zxing needs the path of the npm tarball');
      vendorZxing(path.resolve(args[1]), readLock());
    } else if (args[0] === '--qrcodegen') {
      if (!args[1]) throw new Error('--qrcodegen needs the path of the TypeScript npm tarball the lock pins');
      convertQrcodegen(path.resolve(args[1]), readLock());
    } else if (args.includes('--check') || args.includes('--release')) {
      const { errors, ok } = checkAll({ release: args.includes('--release') });
      for (const line of ok) console.log(`ok   ${line}`);
      for (const line of errors) console.log(`FAIL ${line}`);
      if (errors.length) process.exit(1);
      console.log('all third-party files match tools/upstream.lock.json');
    } else if (!args.length) {
      writeGenerated();
    } else {
      throw new Error(`unknown arguments: ${args.join(' ')}`);
    }
  } catch (err) {
    console.error(`vendor.mjs: ${err.message}`);
    process.exit(1);
  }
}

export { checkAll };
