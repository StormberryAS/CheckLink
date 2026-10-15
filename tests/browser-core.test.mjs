// Runs src/link-core.js inside headless Chromium, under the app's meta Content-Security-Policy
// (connect-src 'none', as in the MetadataScrubber template), and checks that the browser
// gives exactly the same analysis as Node for the whole corpus and the tricky cases, with no
// request leaving for any other host. Driven over the DevTools protocol with Node's own
// WebSocket; no packages. Skipped when Chromium is missing (CHROMIUM=/path overrides).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse } from '../src/link-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; worker-src 'self'";

const corpus = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'provider-test-corpus.json'), 'utf8'));
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const INPUTS = [
  ...corpus.samples.map((c) => c.dirty),
  'Have a look: https://example.com/a?utm_source=x&id=2, thanks! Also www.example.no/side?fbclid=abc.',
  'https://tromsø.no/kart?utm_campaign=x',
  'https://example.com/a%20b?name=John%20Smith&q=red+shoes&fbclid=abc',
  'http://0x7f.1/',
  'https://goo\u200Bgle.com/x',
  'https://pay\u00ADpal.com/',
  'https://\uFF47\uFF4F\uFF4F\uFF47\uFF4C\uFF45.com/',
  'https://%67oogle.com/',
  'https://evil.example\\@google.com/',
  'https://google.com@evil.example/login',
  'http://192.168.1.1/admin',
  'http://[::1]:8080/',
  'https://\u202Eexample.com/',
  'javascript:alert(1)',
  'java\nscript:alert(1)',
  'www.example.no/side?utm_source=x',
  '(see https://en.wikipedia.org/wiki/Bergen_(city))',
  'https://example.com/login?next=https://evil.example/?utm_source=x',
  `https://example.com/r?d=${Buffer.from('https://evil.example/path').toString('base64')}`,
  `https://www.bing.com/ck/a?!&&p=abc&u=a1${b64url('https://www.example.no/a?utm_source=bing&x=1')}&ntb=1`,
  'https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Signature=abc&utm_source=x',
  'https://example.com/reset?token=abc123&utm_source=x',
  'https://example.com/unsubscribe?mc_eid=abc123&utm_source=x',
  'https://shop.example.com/cart;JSESSIONID=0123ABCD?item=4',
  'https://qrco.de/bfAbC1',
  'https://example.com/?a=1&&utm_source=x&',
  // Stage 3 look-alikes: the browser's Unicode script data must give the same answers as Node's.
  'https://p\u0430ypal.com/',
  'https://g\u0585\u0585gle.com/',
  'https://\uABA9ipps.no/',
  'https://\u0441\u0430\u0445\u0430\u0440.\u0440\u0444/',
  'https://www.norsk\u2010tipping.no/',
  'https://col\u00B7legi.cat/',
  'https://\u30B3\u30FC\u30D2\u30FC.jp/',
  'https://paypal-secure-login.com/',
  'https://www.paypal.com.evil.io/signin',
  'https://paypa1.com/',
  'https://paypal.pages.dev/',
  'https://v\u00EDpps.no/',
  'https://example.com/login?next=https://\u0430\u0440\u0440\u04CF\u0435.com/',
];

function summary(r) {
  return {
    found: r.found, kind: r.kind, link: r.link, cleanLink: r.cleanLink, host: r.host,
    warnings: r.warnings.map((w) => `${w.tier}:${w.id}:${w.text}`),
    parts: r.parts.map((p) => `${p.id}:${p.name}:${p.value}:${p.unique}:${p.affiliate}:${p.defaultRemove}`),
    wrappers: r.wrappers.map((w) => w.id), shortLink: r.shortLink && r.shortLink.id, untouched: r.untouched && r.untouched.id,
    hidden: r.hidden.map((h) => h.link), segments: r.segments, kept: r.kept.map((k) => k.name),
    allRemoved: r.clean(r.parts.map((p) => p.id)),
  };
}

const PROBE = `import { analyse } from './src/link-core.js';
const INPUTS = ${JSON.stringify(INPUTS)};
${summary.toString()}
window.__results = JSON.stringify(INPUTS.map((i) => summary(analyse(i))));
// Proof that the policy is in force: a fetch must be refused by connect-src 'none'.
document.addEventListener('securitypolicyviolation', (e) => { window.__csp = e.violatedDirective; window.__done = true; });
fetch('/canary').catch(() => {});
`;
const PAGE = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>engine probe</title><script type="module" src="/probe.js"></script></head><body></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Stage 3 added the look-alike checks and the two tables they read.
const ENGINE_MODULES = ['link-core.js', 'rules.js', 'domain.js', 'psl.js', 'lookalike.js', 'confusables.js', 'brands.js'];

test('link-core.js gives the same results in headless Chromium, under the CSP, with no outside request', { skip: !existsSync(CHROMIUM) && `Chromium not found at ${CHROMIUM}`, timeout: 90000 }, async () => {
  const served = [];
  const files = {
    '/': ['text/html; charset=utf-8', PAGE],
    '/probe.js': ['text/javascript; charset=utf-8', PROBE],
    // The engine and every module it imports (the rule table, and since stage 2 the Public
    // Suffix List and its reader).
    ...Object.fromEntries(ENGINE_MODULES.map((m) => [`/src/${m}`, ['text/javascript; charset=utf-8', readFileSync(path.join(ROOT, 'src', m))]])),
  };
  const server = http.createServer((req, res) => {
    // bump_assets.py stamps the engine's import of rules.js with ?v=<hash>; the stamp is a
    // cache key only, so the file is looked up without it.
    const url = req.url.split('?')[0];
    served.push(url);
    const f = files[url];
    if (!f) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not here');
      return;
    }
    res.writeHead(200, { 'content-type': f[0], 'cache-control': 'no-store' });
    res.end(f[1]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = mkdtempSync(path.join(os.tmpdir(), 'checklink-chromium-'));
  const proc = spawn(CHROMIUM, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { stdio: 'ignore', env: { ...process.env, XDG_CONFIG_HOME: path.join(profile, 'xdg'), XDG_CACHE_HOME: path.join(profile, 'cache') } });

  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(50);
    const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
    ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let nextId = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) events.push(msg);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    for (const domain of ['Network', 'Runtime', 'Log', 'Page']) await send(`${domain}.enable`, {}, sessionId);
    await send('Page.navigate', { url: `${origin}/` }, sessionId);

    let done = false;
    for (let i = 0; i < 400 && !done; i++) {
      await sleep(50);
      const r = await send('Runtime.evaluate', { expression: 'window.__done === true', returnByValue: true }, sessionId);
      done = r.result.value === true;
    }
    assert.ok(done, 'the probe finished in the browser');
    const { result } = await send('Runtime.evaluate', { expression: 'window.__results', returnByValue: true }, sessionId);
    const browser = JSON.parse(result.value);
    const csp = await send('Runtime.evaluate', { expression: 'window.__csp', returnByValue: true }, sessionId);
    assert.equal(csp.result.value, 'connect-src', 'the CSP refused the canary fetch');
    assert.ok(!served.includes('/canary'), 'the canary request never reached the server');

    assert.equal(browser.length, INPUTS.length);
    INPUTS.forEach((input, i) => assert.deepEqual(browser[i], summary(analyse(input)), `same result for ${JSON.stringify(input).slice(0, 80)}`));

    const requested = events.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => e.params.request.url);
    for (const url of requested.filter((u) => !u.endsWith('/canary'))) assert.ok(url.startsWith(`${origin}/`), `no request leaves the page's own origin: ${url}`);
    for (const url of served) assert.ok(['/', '/probe.js', ...ENGINE_MODULES.map((m) => `/src/${m}`), '/favicon.ico'].includes(url), `only the page and its modules were fetched: ${url}`);
    const problems = events.filter((e) => e.method === 'Runtime.exceptionThrown'
      || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon|canary/.test(`${e.params.entry.url || ''} ${e.params.entry.text}`))
      || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    assert.deepEqual(problems.map((e) => JSON.stringify(e.params).slice(0, 300)), [], 'no exception, console error or policy violation');
  } finally {
    try { ws && ws.close(); } catch { /* closing */ }
    proc.kill('SIGKILL');
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    server.close();
    // Chromium helpers can still be writing to the profile for a moment after the kill (seen
    // once as ENOTEMPTY on 10 October 2026), so retry the removal briefly.
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
