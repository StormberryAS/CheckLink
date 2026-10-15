// Privacy and security review of batch 3 (10 October 2026): the "Did CheckLink break your
// link? Email us" mailto: (spec decision 15), the address disguise removal (decision 11)
// and the Google Maps context note (decision 10).
//
//   node --test tests/            (the gate runs this file with the others)
//
// Two kinds of test:
//  * guards: behaviour the review checked and found right; they pass today and keep it so;
//  * todo tests, one per finding still open: each states what the fixed engine must do. A
//    todo test that fails is reported but does not fail the gate. Once a fix lands, its
//    todo test passes; then drop the { todo } option so the gate keeps it.
//
// Fixer pass (10 October 2026): F1 to F10 are fixed and their tests are ordinary tests now.
//
// Node 24 built-ins only. Nothing here touches the network.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Buffer } from 'node:buffer';

import { analyse, reportMail } from '../src/link-core.js';

const enc = encodeURIComponent;

// The report for a choice (the defaults when none is given), with its parts read back.
function mail(r, ids) {
  const m = reportMail(r, ids === undefined ? r.defaultRemoved : ids);
  const q = /^mailto:([^?]*)\?(.*)$/.exec(m.href);
  const params = q[2].split('&').map((x) => x.split('='));
  return { ...m, to: q[1], params, body: decodeURIComponent(params.find((p) => p[0] === 'body')[1]) };
}

// The secret must be nowhere in the message: not in the body as read, not in the address.
function absent(m, secret, where) {
  assert.ok(!m.body.includes(secret), `${where}: "${secret}" is in the body:\n${m.body}`);
  assert.ok(!m.href.includes(secret) && !m.href.includes(enc(secret)), `${where}: "${secret}" is in the address`);
}

// ---------------------------------------------------------------------------------------
// Guards: checked in this review and right today.

describe('guards: the report mailto: cannot be bent into anything else', () => {
  const hostile = [
    'https://example.com/a%0D%0ABcc:%20victim@example.org?utm_source=x',
    'https://example.com/a?x=1%26cc%3Dvictim%40example.org&utm_source=x',
    'https://example.com/a?subject=Other&body=Other&cc=victim@example.org&bcc=b@example.org',
    'https://example.com/a?x=%E2%80%A8%C2%85%0A#frag?subject=x&body=y',
    'https://example.com/a?next=javascript:alert(1)&n=data:text/html,x',
    'https://example.com/\uD800x?utm_source=x',
  ];

  test('always mailto:info@stormberry.as with exactly a subject and a body, both fully encoded', () => {
    for (const link of hostile) {
      const r = analyse(link);
      assert.ok(r.found, link);
      for (const ids of [r.defaultRemoved, [], r.parts.map((p) => p.id)]) {
        const m = mail(r, ids);
        assert.equal(m.to, 'info@stormberry.as', link);
        assert.deepEqual(m.params.map((p) => p[0]), ['subject', 'body'], link);
        assert.equal(decodeURIComponent(m.params[0][1]), 'CheckLink: a cleaned link broke', link);
        for (const [, v] of m.params) assert.match(v, /^(?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-F]{2})*$/, `${link}: only unreserved characters and %XX`);
        assert.ok(m.href.length < 1800, link);
      }
    }
  });

  test('the only line breaks in the body are the template\'s own; %0D%0A in a link stays as text', () => {
    for (const link of hostile) {
      const r = analyse(link);
      const m = mail(r, []);
      const lines = m.body.split('\r\n');
      assert.ok(!lines.some((l) => /[\r\n\u2028\u2029\u0085]/.test(l)), `${link}: a stray line break`);
      if (m.original) assert.ok(lines.includes(`Original link: ${r.link.toWellFormed()}`), `${link}: the link is one line, as written`);
    }
    // (hostile[0] holds an email address, so it is left out; this one has none.)
    assert.match(mail(analyse('https://example.com/a%0D%0ABcc:%20someone%0D%0A?utm_source=x'), []).body, /^Original link: https:\/\/example\.com\/a%0D%0ABcc:%20someone%0D%0A\?utm_source=x$/m);
  });

  test('javascript:, vbscript:, data: and blob: input gives no report at all', () => {
    for (const text of ['javascript:alert(1)//https://example.com/', ' \u200Bjava\tscript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<a href=https://example.com/>x</a>', 'blob:https://example.com/0f1e2d3c', 'JaVaScRiPt:fetch("https://example.com/")']) {
      const r = analyse(text);
      assert.equal(r.kind, 'script', text);
      assert.equal(reportMail(r, []), null, text);
    }
  });

  test('text around the link never goes in, and neither do the other links in it', () => {
    const r = analyse('Hi Jane (jane.doe@example.org), here is https://example.com/a?utm_source=x and also https://other.example/secret?token=abc');
    const m = mail(r);
    assert.ok(!/jane|other\.example|token/i.test(m.body), m.body);
  });
});

describe('guards: the address disguise', () => {
  test('an @ in the path, query or fragment, or after a backslash, is never a user name', () => {
    for (const link of [
      'https://example.com?x=a@evil.example/', 'https://example.com#a@evil.example', 'https://example.com/a@evil.example',
      'https://example.com/?redirect=https://user@evil.example/', 'https://example.com/%40evil.example', 'https://example.com:443/@evil.example',
      'www.example.com/@evil.example', 'https://example.com/path;x@evil.example', 'https://example.com\\x@evil.example/',
      'https://example.com?@evil.example', 'https://example.com/#@evil.example?x=1',
    ]) {
      const r = analyse(link);
      assert.ok(!r.parts.some((p) => p.where === 'userinfo'), link);
      assert.equal(r.host, link.includes('www.') ? 'www.example.com' : 'example.com', link);
      assert.equal(r.cleanLink, link, link);
    }
  });

  test('removing it never sends the clean link to another host and never leaves a user name behind', () => {
    // A seeded mix of host-like pieces, encodings, slashes, backslashes, IDN and invisible
    // characters before the @. The review ran 60,000 of these; 500 keep the gate quick.
    let seed = 12345;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const atoms = ['a', 'www.google.com', 'evil.example', '@', '%40', ':', 'pw', '\\', '/', '.', '%2E', '%2F', '?', '#', 'xn--pypal-4ve.com', 'pаypal.com', '1.2.3.4', ':8443', ';', '%20', '%0A', '\u202E', '\u200B', 'ｇｏｏｇｌｅ.com', '%25', '!', "'", '(', '=', '&'];
    const schemes = ['https://', 'http://', 'https:///', 'https://\\', 'HTTPS://', 'www.'];
    let disguises = 0;
    for (let i = 0; i < 500; i++) {
      let auth = '';
      for (let j = 1 + rnd(6); j > 0; j--) auth += atoms[rnd(atoms.length)];
      const link = `${schemes[rnd(schemes.length)]}${auth}@${['evil.example', 'b.co', 'xn--pypal-4ve.com', '1.2.3.4', 'pаypal.com'][rnd(5)]}${['/', '/x?utm_source=1', '', '?a=b@c', '#f@g'][rnd(5)]}`;
      const r = analyse(link);
      if (!r.found || r.wrappers.length) continue;
      if (r.parts.some((p) => p.where === 'userinfo')) disguises++;
      for (const ids of [undefined, [], r.parts.map((p) => p.id)]) {
        const u = new URL(r.openUrl(ids));
        assert.equal(u.hostname, r.host, `${JSON.stringify(link)} ${JSON.stringify(ids)}`);
        if (ids === undefined || ids.length) assert.ok(!u.username && !u.password, `${JSON.stringify(link)}: user name left in ${u.href}`);
      }
    }
    assert.ok(disguises > 250, `the mix exercised the disguise (${disguises})`);
  });
});

describe('guards: the Google Maps note', () => {
  const mp = (name) => `https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1s${name}!3m4!1s0x1:0x2!8m2!3d60.4!4d5.2`;

  test('names are plain text: markup stays as characters, and nothing is a link', () => {
    const r = analyse(mp('%3Cimg+src%3Dx+onerror%3Dalert(1)%3E'));
    assert.equal(r.maps.context[0].name, '<img src=x onerror=alert(1)>', 'decoded for display, and app.js writes it with textContent only');
  });

  test('the pin is built only from coordinates, so nothing from the link can ride on it', () => {
    for (const [lat, lng] of [['60.4"onmouseover="x', '5.2'], ['60.4', '5.2/../../evil'], ['60.4%0A', '5.2'], ['1e2', '5'], ['60.4', '5.2,99z@evil.example']]) {
      const r = analyse(`https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1sCafes!3m4!1s0x1:0x2!8m2!3d${lat}!4d${lng}`);
      if (r.maps && r.maps.pin) assert.match(r.maps.pin.link, /^https:\/\/www\.google\.com\/maps\/@-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?,17z$/, `${lat} ${lng}`);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Findings still open. Each test fails today and states what the fixed engine must do.

describe('open findings: the report mailto:', () => {
  // F1. reportMail applies the untouched reason to the original only. The clean link is
  // then checked with personalIn(), which knows sign-in names but not signature names or
  // the URL Defense host, so a signed link behind any wrapper goes in on the clean line.
  // Outlook Safe Links around a presigned S3 download is an ordinary email.
  const signedBehindWrapper = [
    ['a presigned S3 link behind Outlook Safe Links', `https://eur01.safelinks.protection.outlook.com/?url=${enc('https://bucket.s3.eu-west-1.amazonaws.com/invoice.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261010%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20261010T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeefcafe0123456789')}&data=05%7C02%7Cme%40corp.no%7Cabc&sdata=xyz&reserved=0`, 'deadbeefcafe0123456789'],
    ['a CloudFront signed link behind Google /url', `https://www.google.com/url?q=${enc('https://d111.cloudfront.net/f.pdf?Expires=1999999999&Signature=SIGsecret123&Key-Pair-Id=APKAEXAMPLE')}&sa=D`, 'SIGsecret123'],
    ['an Azure SAS link behind Google /url', `https://www.google.com/url?q=${enc('https://acct.blob.core.windows.net/c/f.pdf?sv=2022-11-02&se=2026-12-01&sp=r&sig=AZsecretSIG%3D')}&sa=D`, 'AZsecretSIG'],
    ['a URL Defense link behind Google /url', `https://www.google.com/url?q=${enc('https://urldefense.com/v3/__https://example.com/__;!!tenantX!recipientHash$')}&sa=D`, 'recipientHash'],
  ];
  for (const [what, link, secret] of signedBehindWrapper) {
    test(`F1: ${what}: the clean link is left out too, whatever is ticked`, () => {
      const r = analyse(link);
      assert.ok(r.untouched, 'the engine knows the link inside is left untouched');
      for (const ids of [r.defaultRemoved, [], r.parts.map((p) => p.id)]) {
        const m = mail(r, ids);
        assert.equal(m.clean, false, `${JSON.stringify(ids)}: ${m.body}`);
        absent(m, secret, JSON.stringify(ids));
      }
    });
  }

  // F2. CheckLink's own rules say these identify the email recipient, but the report only
  // knows mkt_tok, mc_eid, _hsenc, ck_subscriber_id and midToken, so the original carries
  // them to info@stormberry.as. vgo_ee is "the clicker's email address in encrypted form".
  const recipientIds = [
    ['_kx', 'KLAVIYOabc.XYZ123'], ['vgo_ee', 'ENCRYPTEDemailVALUE'], ['sfmc_id', 'SFMC12345678'], ['et_rid', 'ETRID998877'],
    ['oly_enc_id', 'OLY7777X1'], ['ml_subscriber', 'MLSUB123456'], ['ml_subscriber_hash', 'MLHASH4sh'], ['__s', 'dripSUB1abc'],
    ['dm_i', 'DMIxyz123'], ['_bta_tid', 'BTAtid123'], ['sms_uph', 'UPHabc123'],
  ];
  for (const [name, value] of recipientIds) {
    test(`F2: ${name} (named by the rules as identifying the recipient): the original is left out`, () => {
      const r = analyse(`https://shop.example/product?${name}=${value}&utm_source=email`);
      const part = r.parts.find((p) => p.name === name);
      assert.ok(part, 'a part the rules know');
      const m = mail(r);
      assert.equal(m.original, false, m.body);
      assert.equal(m.originalReason, 'recipient');
      absent(m, value, 'defaults');
      assert.equal(mail(r, r.defaultRemoved.filter((id) => id !== part.id)).clean, false, 'kept by unticking: the clean link is left out too');
    });
  }

  for (const [what, link, secret] of [
    ['an Amazon SES click wrapper (per message, per recipient)', 'https://abcd1234.r.eu-west-1.awstrack.me/L0/https:%2F%2Fshop.example%2Forder%2F123/1/0102018c5f3e2b1a-9f8e7d6c-1111-2222-3333-444455556666-000000/AbCdEfGhIjKlMnOp=356', '0102018c5f3e2b1a'],
    ['an Amazon email redirect (/gp/r.html)', 'https://www.amazon.co.uk/gp/r.html?C=ABCDEF&K=RECIPIENTKEY123&M=urn:rtn:msg:2026&R=XYZ&T=C&U=https%3A%2F%2Fwww.amazon.co.uk%2Fdp%2FB0ABC&H=HASH&ref_=pe_123', 'RECIPIENTKEY123'],
  ]) {
    test(`F2: ${what}: a wrapper that records which recipient clicked keeps the original out`, () => {
      const r = analyse(link);
      const m = mail(r);
      assert.equal(m.original, false, m.body);
      absent(m, secret, 'defaults');
      assert.equal(mail(r, []).clean, false, 'wrapper kept: the clean link is the wrapper, left out too');
    });
  }

  // F3. personalIn() skips the authority, so that a disguise such as
  // google.com@kaspersky.com is not read as an email address. That also skips a real
  // password before the @, and an email address used as the user name.
  for (const [what, link, secret] of [
    ['a user name and password (a router or intranet link)', 'https://alice:Pa55word@intranet.example.com/wiki/Page', 'Pa55word'],
    ['a password and tracking', 'https://admin:hunter2secret@192.168.1.1/cgi-bin/luci?utm_source=x', 'hunter2secret'],
    ['an email address as the user name', 'https://jane.doe%40gmail.com:pw@files.example.com/share', 'jane.doe'],
  ]) {
    test(`F3: ${what}: the original is left out, and so is a clean link that keeps it`, () => {
      const r = analyse(link);
      const m = mail(r);
      assert.equal(m.original, false, m.body);
      absent(m, secret, 'defaults');
      const kept = mail(r, []);
      assert.equal(kept.clean, false, 'disguise unticked: the clean link still holds it');
      absent(kept, secret, 'nothing ticked');
    });
  }

  test('F3 keeps M8: a look-alike user name with no password still goes in', () => {
    const m = mail(analyse('http://convincing-business-related-page-name-pretending-to-be-on-google.com@kaspersky.com/blog/'));
    assert.equal(m.original, true);
  });

  // F4. An address hidden in base64 carries a reset token. The engine has already analysed
  // it (analysis.hidden[0].analysis.untouched is 'auth'), but reportMail does not look.
  test('F4: an address hidden in base64 that carries a reset token keeps both links out', () => {
    const inner = 'https://bank.example/reset?token=B64secret777';
    const r = analyse(`https://example.com/go?u=${Buffer.from(inner).toString('base64')}&utm_source=x`);
    assert.equal(r.hidden[0].analysis.untouched.id, 'auth', 'the engine knows');
    const m = mail(r);
    assert.equal(m.original, false, m.body);
    assert.equal(m.clean, false, m.body);
    absent(m, Buffer.from(inner).toString('base64'), 'defaults');
  });

  // F5. Sign-in values the report does not know by name. These need not change what is
  // cleaned; the report only has to leave the link out.
  for (const [name, link] of [
    ['pwd (a Zoom meeting passcode)', 'https://us02web.zoom.us/j/81234567890?pwd=ZzZsecretPasscode123.1'],
    ['password', 'https://example.com/login?user=jane&password=SECRETVAL123'],
    ['passwd', 'https://example.com/x?passwd=SECRETVAL123'],
    ['passcode', 'https://example.com/x?passcode=SECRETVAL123'],
    ['otp', 'https://example.com/verify?otp=SECRETVAL123'],
    ['apikey', 'https://api.example.com/v1/feed?apikey=SECRETVAL123'],
    ['api_key', 'https://api.example.com/v1/feed?api_key=SECRETVAL123'],
    ['client_secret', 'https://example.com/cb?client_id=a&client_secret=SECRETVAL123'],
    ['sessionid', 'https://example.com/x?sessionid=SECRETVAL123'],
    ['session_id', 'https://example.com/x?session_id=SECRETVAL123'],
  ]) {
    test(`F5: ${name}: the original is left out`, () => {
      const m = mail(analyse(link));
      assert.equal(m.original, false, m.body);
      assert.equal(m.clean, false, m.body);
      absent(m, name.startsWith('pwd') ? 'ZzZsecretPasscode123' : 'SECRETVAL123', 'defaults');
    });
  }

  // F6. Email addresses the report does not see.
  for (const [what, link, secret] of [
    ['an international domain, percent-encoded', 'https://example.com/x?u=jane@ex%C3%A4mple.no&utm_source=x', 'jane@'],
    ['an international domain, as written', 'https://example.com/x?u=jane@exämple.no&utm_source=x', 'jane@'],
    ['an address in base64', `https://example.com/x?e=${Buffer.from('jane.doe@example.com').toString('base64')}&utm_source=x`, Buffer.from('jane.doe@example.com').toString('base64')],
    ['an address encoded four times inside a wrapper', `https://www.google.com/url?q=${enc(enc(enc(enc('https://example.com/x?to=jane.doe@corp.no'))))}&sa=D`, 'corp.no'],
  ]) {
    test(`F6: ${what}: the original is left out`, () => {
      const m = mail(analyse(link));
      assert.equal(m.original, false, m.body);
      absent(m, secret, 'defaults');
    });
  }
});

describe('open findings: text from the link inside CheckLink\'s own sentences', () => {
  // F7. The look-alike text is percent-decoded (%20, %0A) and set unquoted inside the
  // row's sentence, so a disguise can write sentences in CheckLink's voice.
  test('F7: the disguise row cannot carry a sentence of its own', () => {
    for (const link of [
      'https://paypal.com.%20The%20link%20goes%20to%20paypal.com%20as%20well@evil.example/',
      'https://www.dnb.no%0AGoes%20to%20www.dnb.no.%20No%20warning%20signs%20found@evil.example/login',
    ]) {
      const p = analyse(link).parts.find((x) => x.where === 'userinfo');
      assert.ok(!/[\u0000-\u001F\u007F]/.test(p.reveals), `no control characters: ${JSON.stringify(p.reveals)}`);
      const m = /look like (.*)\. The link goes to evil\.example\.$/s.exec(p.reveals);
      assert.ok(m, p.reveals);
      const look = m[1];
      assert.ok(!/\s/.test(look) || /^[‘“'"].*[’”'"]$/s.test(look), `the look-alike text reads as part of the sentence: ${p.reveals}`);
    }
  });

  // F8. A name in the Maps note can close its own quotation and carry on in CheckLink's
  // voice. (No markup gets through: app.js writes the note with textContent.)
  test('F8: a Maps name cannot close its quotation in the note', () => {
    const r = analyse("https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m8!1m2!2m1!1sCaf%C3%A9s%27%29.+No+warning+signs+found+%28%27x!3m4!1s0x1:0x2!8m2!3d60.4!4d5.2");
    const note = r.warnings.find((w) => w.id === 'maps-context').text;
    assert.equal((note.match(/'\)/g) || []).length, 1, note);
    assert.ok(!/\('[^']*'\)\. No warning signs found/.test(note), note);
  });
});

describe('open findings: what the cleaned address looks like', () => {
  // F9. The hard check holds (the clean link goes where the page says), but taking the
  // disguise away leaves a homograph that reads as paypal.com, ready to copy and share.
  // Spec section 3, warning 4 (mixed alphabets, Check tier) is planned for stage 3.
  test('F9: a host written in Cyrillic letters that look Latin gets a Check note, with or without a disguise', () => {
    for (const link of ['https://www.paypal.com@pаypal.com/signin', 'https://pаypal.com/signin']) {
      const r = analyse(link);
      assert.ok(r.warnings.some((w) => w.tier === 'check' && /Cyrillic/.test(w.text) && w.text.includes('xn--pypal-4ve.com')), `${link}: ${JSON.stringify(r.warnings)}`);
    }
  });

  // F10. With a backslash, what a person reads as the host (www.google.com) is not in the
  // user name at all. The row says the address was made to look like "user", and the clean
  // link https://evil.example\@www.google.com/ still reads as www.google.com.
  test('F10: after a backslash, the disguise row names what the address reads as', () => {
    const r = analyse('https://user@evil.example\\@www.google.com/');
    const p = r.parts.find((x) => x.where === 'userinfo');
    assert.equal(r.host, 'evil.example');
    assert.ok(p.reveals.includes('www.google.com'), p.reveals);
  });
});
