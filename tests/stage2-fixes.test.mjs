// Stage 2 fixes, 11 October 2026: guards for what the fixes added beyond the review's own tests
// (tests/stage2-review.test.mjs), and for the ordinary codes they must leave alone. Node 24
// built-ins only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { inspect } from '../src/qr-inspect.js';
import { cborDecode, crc16, crc32 } from '../src/payload-codecs.js';
import { sniffImage } from '../src/image-check.js';
import { DecodeError, decodePicture } from '../src/qr-decode.js';
import { BIP39_LISTS, MONERO_ENGLISH, SLIP39_WORDS } from '../src/wordlists.js';

const I = (t, o) => inspect(t, o);
const fieldOf = (p, label) => p.fields.find((f) => f.label === label);
const value = (p, label) => (fieldOf(p, label) || {}).value;
const emvCode = (body) => `${body}6304${crc16(`${body}6304`)}`;

describe('recovery phrases in every list CheckLink ships', () => {
  test('the word lists are complete and in their own order', () => {
    for (const [lang, words] of Object.entries(BIP39_LISTS)) assert.equal(words.length, 2048, lang);
    assert.equal(MONERO_ENGLISH.length, 1626);
    assert.equal(SLIP39_WORDS.length, 1024);
    assert.equal(SLIP39_WORDS[0], 'academic');
    assert.equal(MONERO_ENGLISH[0], 'abbey');
  });

  test('French, Italian and Czech BIP-39 phrases (zero entropy, so their own checksums pass) are recognised and named', () => {
    for (const [lang, name] of [['french', 'French'], ['italian', 'Italian'], ['czech', 'Czech']]) {
      const w = BIP39_LISTS[lang];
      const p = I(`${Array(11).fill(w[0]).join(' ')} ${w[3]}`);
      assert.equal(p.kind, 'secret', lang);
      assert.equal(value(p, 'Word list'), `BIP-39, ${name}`);
      assert.match(value(p, 'Checksum'), /pass the phrase/);
    }
  });

  test('a phrase typed without its accents is still recognised (the lists allow it)', () => {
    const p = I('abaco abaco abaco abaco abaco abaco abaco abaco abaco abaco abaco abierto');
    assert.equal(p.kind, 'secret');
    assert.equal(value(p, 'Word list'), 'BIP-39, Spanish');
  });

  test('Monero: the published example passes its checksum word; a changed checksum word does not', () => {
    const seed = 'sequence atlas unveil summon pebbles tuesday beer rudely snake rockets different fuselage woven tagged bested dented vegan hover rapid fawns obvious muppet randomly seasons randomly';
    const ok = I(seed);
    assert.equal(ok.title, 'A Monero wallet recovery phrase');
    assert.match(value(ok, 'Checksum'), /pass the phrase/);
    const bad = I(seed.replace(/randomly$/, 'sequence'));
    assert.equal(bad.kind, 'secret');
    assert.match(value(bad, 'Checksum'), /does not pass/);
  });

  test('SLIP-39: upstream test vectors 1 (valid) and 2 (bad checksum), from trezor/python-shamir-mnemonic vectors.json', () => {
    const valid = 'duckling enlarge academic academic agency result length solution fridge kidney coal piece deal husband erode duke ajar critical decision keyboard';
    const p = I(valid);
    assert.equal(p.title, 'A share of a wallet backup (SLIP-39)');
    assert.match(value(p, 'Checksum'), /pass the phrase/);
    assert.match(p.warnings[0].text, /^Whoever has these words and enough of the backup/);
    assert.match(value(I(valid.replace(/keyboard$/, 'kidney')), 'Checksum'), /does not pass/);
  });

  test('ordinary text is still text: a 12-word sentence, a numbered list that does not count up, a shopping list', () => {
    assert.equal(I('meet me at the station at five and bring the red bag please').kind, 'text');
    assert.equal(I('1 abandon 3 abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about').kind, 'text');
    assert.equal(I('milk eggs bread butter cheese apples pears onions garlic rice pasta coffee').kind, 'text');
  });
});

describe('keys inside other text', () => {
  test('a WIF key and an age key inside a sentence are found; the whole text is hidden', () => {
    const wif = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';
    const p = I(`backup: ${wif} (paper wallet)`);
    assert.equal(p.kind, 'secret');
    assert.equal(value(p, 'Kind'), 'Bitcoin, WIF');
    assert.ok(fieldOf(p, 'The text').secret);
    assert.equal(I('my age key AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQS3290GG thanks').kind, 'secret');
  });

  test('a public npub in a sentence and a made-up nsec with a broken checksum stay text', () => {
    assert.equal(I('Follow me: npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg').kind, 'text');
    assert.equal(I('not a key: nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq end').kind, 'text');
  });
});

describe('Cashu, vouchers and other secrets show what can be shown', () => {
  test('a cashuA token shows its mint and amount, and hides the token itself', () => {
    const a = 'cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vODMzMy5zcGFjZTozMzM4IiwicHJvb2ZzIjpbeyJhbW91bnQiOjIsImlkIjoiMDA5YTFmMjkzMjUzZTQxZSIsInNlY3JldCI6IjQwNzkxNWJjMjEyYmU2MWE3N2UzZTZkMmFlYjRjNzI3OTgwYmRhNTFjZDA2YTZhZmMyOWUyODYxNzY4YTc4MzcifV19XX0';
    const p = I(a);
    assert.equal(value(p, 'Mint (the service that issued it)'), 'https://8333.space:3338');
    assert.equal(value(p, 'Amount'), '2 sat');
    assert.equal(fieldOf(p, 'Token').secret, true);
    assert.deepEqual(p.links, []);
  });

  test('a CBOR token (cashuB) is read: mint, unit and amount', () => {
    // A small token written by hand: {m: mint, u: "sat", t: [{i: h'00', p: [{a: 8, s: "x", c: h'02'}]}]}
    const text = (s) => [0x60 + s.length, ...Buffer.from(s)];
    const cbor = new Uint8Array([0xa3, ...text('m'), ...text('https://mint.example'), ...text('u'), ...text('sat'), ...text('t'),
      0x81, 0xa2, ...text('i'), 0x41, 0x00, ...text('p'), 0x81, 0xa3, ...text('a'), 0x08, ...text('s'), ...text('x'), ...text('c'), 0x41, 0x02]);
    const decoded = cborDecode(cbor);
    assert.equal(decoded.get('m'), 'https://mint.example');
    const p = I(`cashuB${Buffer.from(cbor).toString('base64url')}`);
    assert.equal(value(p, 'Mint (the service that issued it)'), 'https://mint.example');
    assert.equal(value(p, 'Amount'), '8 sat');
    assert.equal(cborDecode(new Uint8Array([0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), null, 'an absurd length is refused, not allocated');
  });

  test('an LNURL that is not a withdrawal stays a payment link, with its address offered to check', () => {
    const p = I('lnurlp://pay.example.com/.well-known/lnurlp/alice');
    assert.equal(p.kind, 'payment');
    assert.deepEqual(p.links, ['https://pay.example.com/.well-known/lnurlp/alice']);
  });

  test('an LNbits withdraw link, named only by its path, is a voucher too', () => {
    const p = I('lnurlw://lnbits.example.com/withdraw/api/v1/lnurl/AbCdEf/12345');
    assert.equal(p.kind, 'secret');
    assert.equal(value(p, 'Service'), 'example.com');
    assert.deepEqual(p.links, [], 'the voucher address is never offered as a link to check');
  });

  test('an eSIM code with no activation code is not called a secret', () => {
    const p = I('LPA:1$smdp.example.com$');
    assert.equal(p.tier, 'check');
    assert.equal(p.secret, false);
  });

  test('a camera link without a password keeps its full link', () => {
    const p = I('rtsp://192.168.1.64:554/Streaming/Channels/101');
    assert.equal(value(p, 'Full link'), 'rtsp://192.168.1.64:554/Streaming/Channels/101');
    const q = I('rtsp://admin:hunter22@192.168.1.64:554/x');
    assert.equal(value(q, 'Full link, password left out'), 'rtsp://admin@192.168.1.64:554/x');
    assert.equal(value(q, 'User name'), 'admin');
  });
});

describe('payments: what the fixes added', () => {
  test('BIP 21: the same amount given twice is one amount, with no warning', () => {
    const p = I('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=1&amount=1');
    assert.equal(p.fields.filter((f) => f.label === 'Amount').length, 1);
    assert.ok(!p.warnings.some((w) => w.id === 'amount-twice'));
  });

  test('Ethereum: an unknown chain names no coin; no chain is Ethereum', () => {
    assert.match(value(I('ethereum:0x52908400098527886E0F7030069857D2E4169EE7@999?value=1e18'), 'Amount'), /in that network’s own coin/);
    assert.match(value(I('ethereum:0x52908400098527886E0F7030069857D2E4169EE7?value=1e18'), 'Amount'), /^1 ETH$/);
    assert.match(value(I('ethereum:0x52908400098527886E0F7030069857D2E4169EE7@137?value=1e18'), 'Amount'), /^1 POL$/);
  });

  test('UPI: one value each, no warning', () => {
    const p = I('upi://pay?pa=shop@okbank&pn=Shop&am=10');
    assert.equal(value(p, 'UPI ID'), 'shop@okbank');
    assert.ok(!p.warnings.some((w) => w.id === 'given-twice'));
  });

  test('UPI: a line break in the payee name is pointed out', () => {
    const p = I('upi://pay?pa=shop@okbank&pn=Shop%0AUPI%20ID%3A%20real@okbank&am=10');
    assert.ok(p.warnings.some((w) => w.id === 'line-break' && /Pay to/.test(w.text)), p.warnings.map((w) => w.id).join(', '));
  });

  test('EMV: PayNow parts are named; an unknown currency number is kept', () => {
    const tlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
    const paynow = tlv('00', 'SG.PAYNOW') + tlv('01', '2') + tlv('02', '201234567X') + tlv('03', '1');
    const p = I(emvCode(`000201010211${tlv('26', paynow)}52040000530370258${'02SG'}${tlv('59', 'Shop Name')}${tlv('60', 'Singapore')}`));
    assert.equal(value(p, 'PayNow mobile number or UEN'), '201234567X');
    const q = I(emvCode('000201010211520400005303999540510.005802XX5904Shop6004City'));
    assert.match(value(q, 'Amount'), /currency number 999/);
  });

  test('IBAN: the right length passes as before; a country with no length on file is judged by its check digits', () => {
    const ok = I('BCD\n002\n1\nSCT\n\nKleppesto Senter\nNO9386011117947\nEUR10.00\n\n\n\n');
    assert.match(fieldOf(ok, 'Account (IBAN)').note, /^Its check digits pass, so a typing mistake is unlikely/);
  });

  test('payment cards put who is paid and how much first, and a Lightning request after its details', () => {
    const inv = 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh';
    const p = I(`lightning:${inv}`);
    assert.equal(p.fields[0].label, 'Amount');
    assert.equal(p.fields.at(-1).label, 'Payment request');
    assert.equal(p.fields.at(-1).copy, 'Copy payment request');
  });
});

describe('wording fixes from the UI review', () => {
  test('a phone service code is titled as one; a number is still a number to call', () => {
    assert.equal(I('tel:*21*004712345678#').title, 'A phone service code');
    assert.equal(I('tel:+4712345678').title, 'A phone number to call');
  });

  test('"an" before about: and ms- links, "a" before the others', () => {
    assert.match(I('ms-msdt:/id PCWDiagnostic').summary, /^This is an ms-msdt: link/);
    assert.match(I('about:blank').summary, /^This is an about: link/);
    assert.match(I('file:///etc/passwd').summary, /^This is a file: link/);
  });

  test('a boarding pass gives the flight date in words, and says the year is not in the code', () => {
    const p = I('M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 326J001A0025 100');
    assert.equal(value(p, 'Flight date'), 'about 22 November (day 326 of the year; the year is not in the code)');
  });

  test('a Vipps MobilePay code is titled as one', () => {
    assert.equal(I('https://qr.vipps.no/28/2/01/031/4712345678').title, 'A Vipps MobilePay payment code');
  });

  test('a 2FA export with one account says so, without "Each"', () => {
    // One entry: otpauth-migration data with a single account (name "a", issuer "B", a secret).
    const entry = Buffer.from([0x0a, 0x02, 0x00, 0x01, 0x12, 0x01, 0x61, 0x1a, 0x01, 0x42]);
    const data = Buffer.concat([Buffer.from([0x0a, entry.length]), entry]).toString('base64');
    const p = I(`otpauth-migration://offline?data=${encodeURIComponent(data)}`);
    assert.match(p.summary, /setups of one account\. It holds that account’s secret\.$/);
  });

  test('a contact card with an ordinary web address still offers it as a link', () => {
    const p = I('BEGIN:VCARD\nVERSION:3.0\nFN:Ola\nURL:https://example.no/\nEND:VCARD');
    assert.equal(p.tier, 'info');
    assert.equal(value(p, 'Web address'), 'https://example.no/');
    assert.deepEqual(p.links, ['https://example.no/']);
  });

  test('a mailto with no attachment stays Good to know', () => {
    assert.equal(I('mailto:a@example.com?subject=Hi').tier, 'info');
  });

  test('U+2028 is marked in any code, not only in payments', () => {
    assert.ok(I('Hello World').warnings.some((w) => w.id === 'invisible' && /U\+2028 line separator/.test(w.text)));
  });
});

describe('the picture header readers', () => {
  test('a JPEG with two frame headers is judged by the larger', () => {
    const sof = (w, h) => [0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00];
    const b = new Uint8Array([0xff, 0xd8, ...sof(100, 100), ...sof(9000, 9000), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    assert.deepEqual([sniffImage(b).width, sniffImage(b).height], [9000, 9000]);
  });

  test('a JPEG with no frame header is refused, not decoded unchecked', async () => {
    const b = new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x41, 0x42, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    let code = null;
    try {
      await decodePicture(b);
    } catch (err) {
      code = err instanceof DecodeError ? err.code : String(err);
    }
    assert.equal(code, 'not-image');
  });

  test('an AVIF ispe box inside a 64-bit-sized meta box is still read', () => {
    const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const ispe = [...u32(20), ...Buffer.from('ispe'), 0, 0, 0, 0, ...u32(5000), ...u32(4000)];
    const ipco = [...u32(8 + ispe.length), ...Buffer.from('ipco'), ...ispe];
    const iprp = [...u32(8 + ipco.length), ...Buffer.from('iprp'), ...ipco];
    const metaBody = [0, 0, 0, 0, ...iprp];
    const meta = [...u32(1), ...Buffer.from('meta'), ...u32(0), ...u32(16 + metaBody.length), ...metaBody];
    const ftyp = [...u32(20), ...Buffer.from('ftyp'), ...Buffer.from('avif'), 0, 0, 0, 0, ...Buffer.from('mif1')];
    const s = sniffImage(new Uint8Array([...ftyp, ...meta]));
    assert.deepEqual([s.type, s.width, s.height], ['avif', 5000, 4000]);
  });
});

describe('small codecs', () => {
  test('CRC-32 of "123456789" is cbf43926', () => {
    assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  });
});

describe('the worker lockdown', () => {
  test('names every network way it takes away', () => {
    const src = readFileSync(new URL('../src/worker-lockdown.js', import.meta.url), 'utf8');
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts', 'caches', 'Worker', 'SharedWorker', 'FontFace', 'fonts']) {
      assert.ok(src.includes(`'${name}'`), name);
    }
  });
});
