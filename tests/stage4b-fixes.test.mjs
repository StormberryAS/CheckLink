// Stage 4b fixes (12 October 2026): the findings of the stage 4b security, interface and emulator
// reviews that the fix round settled within the decisions of 11 October 2026.
//   * S1: the personal-data test that the QR code, PD-1 (the Share line and the sensitive Copy),
//     SEC-10 (the screenshot block) and the Email us line share finds session, key, ticket and
//     one-time-code names in any spelling, a JSON Web Token under any name, signatures, phone
//     numbers and identity numbers; names keep the underscores at their ends (__s is not s);
//   * S2: sign-in, reset and confirmation links with their token in the path;
//   * S7: no QR code of a link to a device (an IP address of any kind, localhost, .local and the
//     other names kept for local networks);
//   * S8, SC-3, SC-7, SC-8 and EMU-3: the page's QR card, read as text;
//   * S3 and SC-5: no private instance names in anything the website or the app ships;
//   * S11: the lock says what the encoder is given; S12: letter-like signs in a host are a disguise;
//   * SC-6: the four brands' own GitHub Pages names keep only the neutral github.io note.
// Run from the repository root with: node --test tests/
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse, personalReasons, reportMail } from '../src/link-core.js';
import { QR_REFUSED, makeQr, qrPng, qrRefusal, qrText } from '../src/qr-make.js';
import { decodePicture } from '../src/qr-decode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const app = text('app.js');

const refusalOf = (link) => {
  const a = analyse(link);
  const r = qrRefusal(a, a.defaultRemoved);
  return r ? r.id : null;
};
const cleanWhy = (link) => {
  const a = analyse(link);
  return personalReasons(a, a.defaultRemoved).clean;
};
// The body of a function declared in app.js, up to the next one.
const fn = (name) => {
  const start = app.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const next = app.slice(start + 1).search(/\n(?:async )?function |\nconst [A-Z_]+ = /);
  return app.slice(start, next < 0 ? undefined : start + 1 + next);
};

describe('S1: the personal-data test the QR code, PD-1, SEC-10 and the Email us line share', () => {
  // Every forbidden link of the security review's proof of concept: each made a code before.
  const FORBIDDEN = [
    ['https://example.com/callback?oauth_token=Ab12Cd34Ef56&oauth_verifier=Gh78Ij90', 'signin'],
    ['https://sp.example.com/acs?SAMLResponse=PHNhbWxwOlJlc3BvbnNlPjwvc2FtbHA6UmVzcG9uc2U%2B', 'signin'],
    ['https://app.example.com/auth/confirm?token_hash=Ab12Cd34Ef56Gh78&type=email', 'signin'],
    ['https://shop.example.com/cart?PHPSESSID=9f8e7d6c5b4a39281706f5e4d3', 'signin'],
    ['https://shop.example.com/cart?session=9f8e7d6c5b4a39281706f5e4d3', 'signin'],
    ['https://shop.example.com/cart?sid=9f8e7d6c5b4a39281706f5e4d3', 'signin'],
    ['https://api.example.com/export?authToken=9f8e7d6c5b4a39281706f5e4d3', 'signin'],
    ['https://api.example.com/export?api_token=9f8e7d6c5b4a39281706f5e4d3', 'signin'],
    ['https://api.example.com/hook?secret=9f8e7d6c5b4a39281706f5e4d3', 'signin'],
    ['https://bucket.example.com/f.pdf?X-Amz-Security-Token=FwoGZXIvYXdzEJr&X-Amz-Credential=ASIA%2F20261011', 'signin'],
    ['https://files.example.com/f.pdf?expires=1760000000&signature=9f8e7d6c5b4a39281706f5e4d3', 'signed'],
    ['https://router.example.com/login?user=admin&pass=hunter2', 'signin'],
    ['https://app.example.com/view?t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'signin'],
    ['https://shop.example.com/order?phone=%2B4791234567', 'phone'],
    ['https://forms.example.no/skjema?fnr=01019012345', 'id'],
  ];

  test('every forbidden link of the review gets no code, with its own reason, and the Email us line leaves it out', async () => {
    for (const [link, why] of FORBIDDEN) {
      const a = analyse(link);
      assert.equal(personalReasons(a, a.defaultRemoved).clean, why, link);
      assert.equal(refusalOf(link), why, link);
      assert.equal(reportMail(a, a.defaultRemoved).cleanReason, why, link);
    }
  });

  test('session, key and one-time-code names in every common spelling', () => {
    const names = ['sid', 'sessid', 'PHPSESSID', 'ASPSESSIONID', 'session', 'sessionkey', 'session_key', 'sessiontoken', 'auth', 'authtoken', 'authToken', 'auth-token',
      'auth_key', 'authkey', 'accesstoken', 'accessToken', 'access.token', 'access_key_id', 'api_token', 'apitoken', 'apiKey', 'secret', 'private_key', 'privatekey', 'ticket',
      'oauth_token', 'oauth_verifier', 'SAMLResponse', 'SAMLRequest', 'X-Amz-Security-Token', 'X-Amz-Credential', 'token_hash', 'verification_code', 'activation_code', 'otp_code',
      'pw', 'pass', 'pin', 'csrf_token', 'user_session', 'my_secret', 'passwort', 'x-client-credential'];
    for (const n of names) assert.equal(cleanWhy(`https://shop.example.com/account/view?${n}=Ab12Cd34Ef56Gh78`), 'signin', n);
    for (const n of ['sig', 'signature', 'Signature', 'hmac']) assert.equal(cleanWhy(`https://shop.example.com/f?${n}=Ab12Cd34`), 'signed', n);
    for (const n of ['phone', 'phone_number', 'tel', 'mobile', 'msisdn']) assert.equal(cleanWhy(`https://shop.example.com/order?${n}=4791234567`), 'phone', n);
    for (const n of ['ssn', 'fnr', 'fodselsnummer', 'f%C3%B8dselsnummer', 'personnummer', 'cpf', 'nif', 'dob', 'date_of_birth', 'birthdate']) assert.equal(cleanWhy(`https://forms.example.no/s?${n}=1`), 'id', n);
  });

  test('the underscores at either end of a name stay: Drip\'s __s and Klaviyo\'s _kx are not s and kx', () => {
    for (const link of ['https://x.com/NASA/status/1712345678901234567?s=46', 'https://duckduckgo.com/?q=bag&s=10', 'https://www.mojeek.com/search?q=bag&s=11', 'https://www.tiktok.com/@stormberry/video/7420000000000000000?s=2', 'https://example.com/?kx=1']) {
      assert.equal(cleanWhy(link), null, link);
      assert.equal(refusalOf(link), null, link);
    }
    assert.equal(personalReasons(analyse('https://example.com/news?__s=abc123'), []).original, 'recipient');
    assert.equal(personalReasons(analyse('https://example.com/news?_kx=abc123'), []).original, 'recipient');
  });

  test('a JSON Web Token counts under any name and in the path; text that only starts like one does not', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    assert.equal(cleanWhy(`https://app.example.com/view?x=${jwt}`), 'signin');
    assert.equal(cleanWhy(`https://app.example.com/v/${jwt}`), 'signin');
    assert.equal(cleanWhy(`https://app.example.com/view#${jwt}`), 'signin');
    assert.equal(cleanWhy('https://example.com/a?x=eyJabc'), null);
    assert.equal(cleanWhy('https://example.com/a?x=heyJude.eyJ.x'), null);
  });

  test('ordinary names nearby stay ordinary: a code is still made', () => {
    for (const link of [
      'https://www.example.com/shop/item?id=42',
      'https://www.example.com/search?q=session+musicians',
      'https://www.example.com/p?page=2&sort=price',
      'https://www.example.com/tickets/2026/concert',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42',
      'https://www.example.com/a?telescope=1&mobilepay=yes',
    ]) assert.equal(refusalOf(link), null, link);
  });

  test('each reason has its line in the Email us message, above Share and instead of the QR code', () => {
    const left = /const LEFT_OUT = \{[\s\S]*?\n\};/.exec(text('src/link-core.js'))[0];
    const notes = /const PERSONAL_NOTE = \{[\s\S]*?\n\};/.exec(app)[0];
    for (const why of ['signin', 'signed', 'wrapped', 'recipient', 'email', 'phone', 'id', 'password']) {
      assert.match(left, new RegExp(`\\n  ${why}: '[^']+'`), why);
      assert.match(notes, new RegExp(`\\n  ${why}: '[^']+'`), why);
      assert.match(QR_REFUSED[why], /^No QR code for this link: [^.]+\.$/, why);
    }
    assert.match(left, /signin: 'it carries a sign-in, key or session value'/);
    assert.equal(QR_REFUSED.phone, 'No QR code for this link: it holds a phone number.');
    assert.equal(QR_REFUSED.id, 'No QR code for this link: it holds an identity number or a date of birth.');
  });

  test('a session value or phone number the page sees asks for the screenshot block too (SEC-10 uses the same test)', () => {
    for (const link of ['https://shop.example.com/cart?PHPSESSID=9f8e7d6c5b4a39281706f5e4d3', 'https://shop.example.com/order?phone=4791234567']) {
      const a = analyse(link);
      const why = personalReasons(a, a.defaultRemoved);
      assert.ok(why.original || why.clean, link);
    }
    assert.match(fn('syncLinkSecure'), /const why = personalReasons\(a, state\.removed\);\n {4}on = !!\(why\.original \|\| why\.clean\);/);
  });
});

describe('S2: sign-in, reset and confirmation links with the token in the path', () => {
  test('the shapes of the review, Laravel, Django and Slack: no code, and the Email us line leaves them out', () => {
    for (const link of [
      'https://slack.com/z-app-123-abc/magic-login/9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'https://example.com/password/reset/9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'https://example.com/reset-password/9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'https://app.example.com/magic-link/9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'https://example.com/verify-email/9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'https://accounts.example.com/login/one-time/9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'https://example.com/reset/MQ/c8z1y2-a3b4c5d6e7f8a9b0c1d2e3f4/',
      'https://example.com/account/confirmation/9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0',
    ]) {
      assert.equal(cleanWhy(link), 'signin', link);
      assert.equal(refusalOf(link), 'signin', link);
      const m = reportMail(analyse(link), []);
      assert.deepEqual([m.original, m.originalReason, m.clean], [false, 'signin', false], link);
    }
  });

  test('ordinary paths with those words stay ordinary', () => {
    for (const link of [
      'https://www.example.com/author/a1b2c3d4e5f6g7h8i9',
      'https://github.com/login/oauth/authorize',
      'https://accounts.example.com/signin/v2/identifier',
      'https://www.example.com/reset/instructions-for-your-router',
      'https://www.example.com/password/forgotten',
      'https://www.nrk.no/norge/some-article-1.17012345',
      'https://www.example.com/invite/9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'https://www.example.com/confirm/12345678901234567890',
    ]) assert.equal(cleanWhy(link), null, link);
  });
});

describe('S7: no QR code of a link to a device', () => {
  test('an IP address of any kind, localhost and the names kept for local networks', () => {
    for (const link of ['https://192.168.1.1/cgi-bin/luci', 'https://10.0.0.1/', 'https://127.0.0.1:8080/admin', 'https://[::1]/', 'https://localhost/', 'https://localhost:8443/x', 'https://app.localhost/', 'https://printer.local/', 'https://router.home.arpa/', 'https://nas.internal/']) {
      assert.equal(refusalOf(link), 'device', link);
    }
    // A public IP address already has a Check note: that line stays.
    assert.equal(refusalOf('https://8.8.8.8/'), 'notes');
    assert.equal(QR_REFUSED.device, 'No QR code for this link: it points to a device, not to a site on the internet.');
  });

  test('ordinary names that only contain those words get a code', () => {
    for (const link of ['https://local.example.com/', 'https://www.internal.example.no/', 'https://localhost.example.com/', 'https://www.local.no/']) assert.equal(refusalOf(link), null, link);
  });
});

describe('S12: signs that look like letters in a host are a disguise', () => {
  test('the Kelvin, Angstrom and Ohm signs get the disguise note, so no code', () => {
    for (const host of ['Kxample.com', 'Ångstrom.example', 'www.Ωmega.example']) {
      const a = analyse(`https://${host}/path`);
      const note = a.warnings.find((w) => w.id === 'disguised');
      assert.ok(note && note.tier === 'check', host);
      assert.match(note.text, /a sign written as a letter/);
      assert.equal(qrRefusal(a, a.defaultRemoved).id, 'notes', host);
    }
    assert.ok(!analyse('https://kxample.com/path').warnings.some((w) => w.id === 'disguised'));
  });
});

describe('the page (app.js and index.html read as text)', () => {
  test('S8: typing closes the card at once, and Save, Share and Copy picture check the box first', () => {
    assert.match(app, /stopCamera\(CAM\.stopped\);\n(?: {4}\/\/[^\n]*\n)+ {4}closeQr\(\);\n {4}schedule\(pasted \? 0 : DEBOUNCE_MS\);/);
    for (const name of ['saveQr', 'shareQr', 'copyQr']) {
      const body = fn(name);
      assert.ok(body.indexOf('current();') >= 0 && body.indexOf('current();') < body.indexOf('if (!state.qr'), name);
    }
  });

  test('SC-3: the read-back lines by what stopped the reader, with the app\'s own wording', () => {
    const line = fn('qrReaderLine');
    assert.match(line, /if \(code === 'slow'\) return QR\.slow;/);
    assert.match(line, /if \(code === 'stopped' \|\| code === 'slow-last'\) return inApp\(\) \? QR\.stoppedApp : QR\.stopped;/);
    assert.match(line, /return inApp\(\) \? QR\.noReaderApp : QR\.noReader;/);
    const qr = /const QR = \{[\s\S]*?\n\};/.exec(app)[0];
    for (const key of ['noReaderApp', 'stoppedApp']) {
      const value = new RegExp(`\\n  ${key}: '([^']+)'`).exec(qr)[1];
      assert.ok(!/browser|this page/.test(value), `${key} says nothing of a browser or a page`);
    }
    assert.match(qr, /stoppedApp: '[^']*close CheckLink and open it again[^']*'/);
    assert.match(qr, /stopped: '[^']*load this page again[^']*'/);
  });

  test('SC-7: focus inside the card goes to Make a QR code, Copy or the box when the card closes', () => {
    const close = fn('closeQr');
    assert.match(close, /const hadFocus = card\.contains\(document\.activeElement\);/);
    assert.match(close, /queueMicrotask\(/);
    assert.match(close, /\[\$\('qr-btn'\), \$\('copy-btn'\)\]\.find\(shown\) \|\| \$\('link-input'\)/);
  });

  test('EMU-3: a link that is not a web address takes the last web link\'s lines with it', () => {
    const render = fn('renderAll');
    assert.match(render, /for \(const id of \['share-warn', 'share-note', 'qr-note'\]\) \{\n {6}\$\(id\)\.hidden = true;\n {6}\$\(id\)\.textContent = '';/);
  });

  test('every new line keeps the writing rules', () => {
    const qr = /const QR = \{[\s\S]*?\n\};/.exec(app)[0];
    const notes = /const PERSONAL_NOTE = \{[\s\S]*?\n\};/.exec(app)[0];
    for (const words of [qr, notes, JSON.stringify(QR_REFUSED)]) {
      assert.ok(!/\bsafe\b|verified|trusted|clean QR code|—| -- |!/i.test(words), words.slice(0, 60));
    }
  });
});

describe('S3 and SC-5: no private instance names in what ships', () => {
  // What the website publishes and the app bundles, plus the app's own source.
  const published = () => {
    const out = ['index.html', 'app.js', 'style.css', 'favicon.svg', 'NOTICE', 'android/web-overlay/android-bridge.js'];
    const walk = (dir) => {
      for (const f of readdirSync(path.join(ROOT, dir))) {
        const rel = `${dir}/${f}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else out.push(rel);
      }
    };
    for (const dir of ['src', 'vendor', 'licences', 'android/app/src/main']) walk(dir);
    return out.filter((f) => !/\.(woff2|wasm|png|webp)$/.test(f));
  };

  test('the names R-1 took out of the research copies appear in no published file', () => {
    const files = published();
    assert.ok(files.length > 60, `${files.length} files`);
    for (const f of files) {
      const t = text(f);
      for (const re of [/192\.168\.50\./, /search\.povoa\.no/, /searxngr6/, /search\.stormberry\.as/, /authelia/i, /protonvpn/i, /\/home\/viking/, /\/mnt\/data/]) {
        assert.doesNotMatch(t, re, `${f} ${re}`);
      }
    }
  });
});

describe('S11 and SC-6: the record says what the code does', () => {
  test('the lock says when the ECI marker is added', () => {
    const lock = JSON.parse(text('tools/upstream.lock.json'));
    const notes = lock.vendored.find((v) => v.id === 'qrcodegen').notes.join(' ');
    assert.match(notes, /ECI marker 26 \(UTF-8\)/);
    assert.doesNotMatch(notes, /with no ECI marker/);
  });

  test('a brand\'s own GitHub Pages name: no look-alike note, only the neutral github.io note, which brands.json records', () => {
    for (const host of ['google.github.io', 'microsoft.github.io', 'skatteetaten.github.io', 'metamask.github.io']) {
      const a = analyse(`https://${host}/`);
      assert.deepEqual(a.warnings.map((w) => `${w.id}:${w.tier}`), ['shared-domain:info'], host);
      assert.equal(refusalOf(`https://${host}/`), null, host);
    }
    const about = JSON.parse(text('rules/brands.json')).about.join(' ');
    assert.match(about, /The neutral note every address under github\.io gets stays on these names too/);
  });
});

describe('the read-back still works for links the fixes leave alone', () => {
  test('an ordinary link and one with a Norwegian path are made and read back exactly', async () => {
    for (const link of ['https://www.example.com/shop/item?utm_source=qr&id=42', 'https://www.example.no/sti/blåbær?gård=Ås']) {
      const a = analyse(link);
      assert.equal(qrRefusal(a, a.defaultRemoved), null, link);
      const payload = qrText(a.openUrl(a.defaultRemoved));
      const { codes } = await decodePicture(qrPng(makeQr(payload.text)));
      assert.equal(codes.length, 1);
      assert.equal(codes[0].text, payload.text);
    }
  });
});
