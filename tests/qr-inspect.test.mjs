// Stage 2: the QR inspector (src/qr-inspect.js). Every payload type with real-world samples
// (the examples published in each format's own specification where one exists), hostile,
// oversized and malformed content, and invariants over every payload: tiers, wording, secrets
// never shown in CheckLink's own sentences, payments never paid.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { KINDS, MAX_TEXT, formatLabel, inspect } from '../src/qr-inspect.js';
import { base58Check, bech32Decode, crc16, sha256, utf8 } from '../src/payload-codecs.js';

const fieldOf = (p, label) => p.fields.find((f) => f.label === label || f.label.startsWith(`${label} (`));
const value = (p, label) => (fieldOf(p, label) || {}).value;
const ids = (p) => p.warnings.map((w) => w.id);
const seen = [];
const I = (text, opts) => {
  const p = inspect(text, opts);
  seen.push({ text, p });
  return p;
};

// BOLT 11's own test vectors (lightning/bolts 11-payment-encoding.md, commit 14901bdc).
const BOLT11 = {
  donation: 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql',
  coffee: 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh',
  nonsense: 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpu9qrsgqhtjpauu9ur7fw2thcl4y9vfvh4m9wlfyz2gem29g5ghe2aak2pm3ps8fdhtceqsaagty2vph7utlgj48u0ged6a337aewvraedendscp573dxr',
  badChecksum: 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrnt',
  mixedCase: 'LNBC2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrny',
  subMsat: 'lnbc2500000001p1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgq0lzc236j96a95uv0m3umg28gclm5lqxtqqwk32uuk4k6673k6n5kfvx3d2h8s295fad45fdhmusm8sjudfhlf6dcsxmfvkeywmjdkxcp99202x',
  payee: 'lnbc25m1p70xwfzpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaqnp4q0n326hr8v9zprg8gsvezcch06gfaqqhde2aj730yg0durunfhv66sp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsp5cfzp9ugllvk03rltd6hvndxj26ux6gcxc5azyxk060rj9tzghct5zvjlps76gx8wpq5yuu79688k8gnm2c0al6v608s96l0xzrrlqqwnzxmu',
  pico: 'lnbc9678785340p1pwmna7lpp5gc3xfm08u9qy06djf8dfflhugl6p7lgza6dsjxq454gxhj9t7a0sd8dgfkx7cmtwd68yetpd5s9xar0wfjn5gpc8qhrsdfq24f5ggrxdaezqsnvda3kkum5wfjkzmfqf3jkgem9wgsyuctwdus9xgrcyqcjcgpzgfskx6eqf9hzqnteypzxz7fzypfhg6trddjhygrcyqezcgpzfysywmm5ypxxjemgw3hxjmn8yptk7untd9hxwg3q2d6xjcmtv4ezq7pqxgsxzmnyyqcjqmt0wfjjq6t5v4khxsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsxqyjw5qcqp2rzjq0gxwkzc8w6323m55m4jyxcjwmy7stt9hwkwe2qxmy8zpsgg7jcuwz87fcqqeuqqqyqqqqlgqqqqn3qq9q9qrsgqrvgkpnmps664wgkp43l22qsgdw4ve24aca4nymnxddlnp8vh9v2sdxlu5ywdxefsfvm0fq3sesf08uf6q9a2ke0hc9j6z6wlxg5z5kqpu2v9wz',
};

// A Base58Check string from a version and payload (for keys the tests make up).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58CheckEncode(bytes) {
  const sum = sha256(sha256(bytes)).subarray(0, 4);
  const all = new Uint8Array([...bytes, ...sum]);
  let n = 0n;
  for (const b of all) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of all) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// A Google Authenticator export (otpauth-migration) built from accounts, as the app writes it.
function migration(accounts) {
  const varint = (n) => {
    const out = [];
    let v = n;
    while (v > 127) {
      out.push((v & 127) | 128);
      v >>>= 7;
    }
    out.push(v);
    return out;
  };
  const ld = (field, bytes) => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
  const body = [];
  for (const a of accounts) {
    const p = [...ld(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), ...ld(2, [...utf8(a.name)]), ...ld(3, [...utf8(a.issuer)]), 0x20, 1, 0x28, 1, 0x30, 2];
    body.push(...ld(1, p));
  }
  body.push(0x10, 1, 0x18, 1, 0x20, 0, 0x28, 7);
  return `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(body).toString('base64'))}`;
}

describe('web addresses', () => {
  test('a plain link is a web address, handed to the link analysis', () => {
    const p = I('https://www.example.com/shop?utm_source=qr&id=42');
    assert.equal(p.kind, 'web');
    assert.equal(p.tier, 'info');
    assert.deepEqual(p.links, ['https://www.example.com/shop?utm_source=qr&id=42']);
  });
  test('a link stored in capitals (QR alphanumeric mode) is still a link, kept as written', () => {
    const p = I('HTTPS://EXAMPLE.COM/A?UTM_SOURCE=QR&ID=7');
    assert.equal(p.kind, 'web');
    assert.deepEqual(p.links, ['HTTPS://EXAMPLE.COM/A?UTM_SOURCE=QR&ID=7']);
  });
  test('a bare www. address and the DoCoMo bookmark forms are web addresses', () => {
    assert.deepEqual(I('www.example.no/side').links, ['www.example.no/side']);
    assert.equal(I('URLTO:https://example.com/a').kind, 'web');
    const b = I('MEBKM:TITLE:Example;URL:https\\://example.com/b;;');
    assert.equal(b.kind, 'web');
    assert.equal(value(b, 'Bookmark title'), 'Example');
  });
  test('text around a link makes it text, with the link listed for checking', () => {
    const p = I('Scan for the menu: https://example.com/menu?utm_source=table and enjoy');
    assert.equal(p.kind, 'text');
    assert.deepEqual(p.links, ['https://example.com/menu?utm_source=table']);
  });
  test('a Vipps MobilePay code (qr.vipps.no) is a web address with a Check note: the server decides where it leads', () => {
    const p = I('https://qr.vipps.no/28/2/01/031/4791234567?v=1');
    assert.equal(p.kind, 'web');
    assert.equal(p.tier, 'check');
    assert.ok(ids(p).includes('vipps'));
  });
  test('a Discord sign-in code (discord.com/ra/) is account linking, Stop, not a link to check', () => {
    const p = I('https://discord.com/ra/abcDEF123ghiJKL');
    assert.equal(p.kind, 'account-link');
    assert.equal(p.tier, 'stop');
    assert.deepEqual(p.links, []);
  });
});

describe('Wi-Fi', () => {
  test('WPA with escaped separators: name, security, hidden, and the password hidden behind Show', () => {
    const p = I('WIFI:T:WPA;S:Home Net;P:pa\\;ss\\;word\\:x;H:false;;');
    assert.equal(p.kind, 'wifi');
    assert.equal(p.tier, 'info');
    assert.equal(value(p, 'Network name'), 'Home Net');
    assert.equal(value(p, 'Security'), 'WPA or WPA2 password');
    assert.equal(value(p, 'Hidden network'), 'No');
    const pw = fieldOf(p, 'Password');
    assert.equal(pw.value, 'pa;ss;word:x');
    assert.equal(pw.secret, true);
    assert.equal(pw.copy, 'Copy password');
    assert.equal(fieldOf(p, 'Network name').copy, 'Copy network name');
    assert.ok(p.warnings.some((w) => /Anyone who has this code, or a picture of it, can join this network\./.test(w.text)));
    assert.ok(p.warnings.some((w) => /owner see which sites you visit/.test(w.text)));
    assert.ok(!p.summary.includes('pa;ss'), 'the password is never in CheckLink’s own words');
    // An unescaped ; ends the password, as the format says.
    assert.equal(value(I('WIFI:T:WPA;S:x;P:pa;ss;;'), 'Password'), 'pa');
  });
  test('a hidden network, WEP, open networks and WPA3 are said plainly', () => {
    assert.match(value(I('WIFI:T:WPA;S:x;P:y;H:true;;'), 'Hidden network'), /^Yes/);
    const wep = I('WIFI:T:WEP;S:Old;P:abcde;;');
    assert.ok(ids(wep).includes('wifi-wep'));
    const open = I('WIFI:S:Cafe;T:nopass;;');
    assert.equal(value(open, 'Security'), 'Open: no password');
    assert.ok(ids(open).includes('wifi-open'));
    assert.equal(fieldOf(open, 'Password'), undefined);
    assert.equal(value(I('WIFI:T:SAE;S:New;P:x;;'), 'Security'), 'WPA3 password');
  });
  test('a quoted name is taken literally (it looks like hex), and enterprise sign-in shows its user name', () => {
    assert.equal(value(I('WIFI:T:WPA;S:"414243";P:x;;'), 'Network name'), '414243');
    const e = I('WIFI:T:WPA2-EAP;S:Corp;E:PEAP;PH2:MSCHAPV2;I:alice;A:anon;P:secret;;');
    assert.equal(value(e, 'Security'), 'WPA2 Enterprise: sign-in with a user name');
    assert.equal(value(e, 'User name'), 'alice');
    assert.equal(value(e, 'Sign-in method'), 'PEAP');
  });
  test('a direction override in the network name is flagged and kept as data', () => {
    const p = I('WIFI:T:WPA;S:Free‮iFiW;P:x;;');
    assert.equal(p.tier, 'check');
    assert.ok(ids(p).includes('invisible'));
    assert.equal(value(p, 'Network name'), 'Free‮iFiW');
  });
});

describe('contacts and calendar events', () => {
  test('MECARD (ZXing’s example form): name reordered, phones, email, address, and the web address listed for checking', () => {
    const p = I('MECARD:N:Doe,John;TEL:+4712345678;EMAIL:john@example.no;URL:https\\://example.no/?utm_source=card;ADR:Storgata 1,Bergen;BDAY:19800131;NOTE:Hi\\; there;;');
    assert.equal(p.kind, 'contact');
    assert.equal(value(p, 'Name'), 'John Doe');
    assert.equal(value(p, 'Phone'), '+4712345678');
    assert.equal(value(p, 'Birthday'), '31 January 1980');
    assert.equal(value(p, 'Note'), 'Hi; there');
    assert.deepEqual(p.links, ['https://example.no/?utm_source=card']);
  });
  test('vCard 3.0 with types, folded lines and escapes', () => {
    const p = I('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Nordmann;Ola;;;\r\nFN:Ola Nordmann\r\nORG:Stormberry\\, AS\r\nTEL;TYPE=cell:+47 123 45 678\r\nEMAIL;TYPE=work:ola@example.no\r\nNOTE:Line one\\nline\r\n  two\r\nURL:https://example.no/ola\r\nEND:VCARD\r\n');
    assert.equal(value(p, 'Name'), 'Ola Nordmann');
    assert.equal(value(p, 'Organisation'), 'Stormberry, AS');
    assert.equal(fieldOf(p, 'Phone (mobile)').value, '+47 123 45 678');
    assert.equal(value(p, 'Note'), 'Line one\nline two');
    assert.deepEqual(p.links, ['https://example.no/ola']);
  });
  test('vCard 2.1 quoted-printable is read (Kleppestø), and a photo link is never loaded', () => {
    const p = I('BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Ola Kleppest=C3=B8\r\nPHOTO;VALUE=URL:https://tracker.example/p.jpg\r\nEND:VCARD');
    assert.equal(value(p, 'Name'), 'Ola Kleppestø');
    assert.equal(value(p, 'Photo'), 'A link to a picture. CheckLink does not load it.');
    assert.deepEqual(p.links, []);
  });
  test('a calendar event in plain words: title, start with its time zone, end in UTC, place and links', () => {
    const p = I('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Board meeting\nDTSTART;TZID=Europe/Oslo:20261012T100000\nDTEND:20261012T110000Z\nLOCATION:Kleppestø\nDESCRIPTION:Agenda at https://example.com/agenda\nEND:VEVENT\nEND:VCALENDAR');
    assert.equal(p.kind, 'event');
    assert.equal(value(p, 'Starts'), '12 October 2026, 10:00 (Europe/Oslo)');
    assert.equal(value(p, 'Ends'), '12 October 2026, 11:00 (UTC)');
    assert.deepEqual(p.links, ['https://example.com/agenda']);
    assert.equal(value(I('BEGIN:VEVENT\nSUMMARY:Day\nDTSTART;VALUE=DATE:20261224\nEND:VEVENT'), 'Starts'), '24 December 2026');
  });
});

describe('email, phone calls and text messages: shown, never sent', () => {
  test('mailto with a hidden copy (bcc) is Check and says so', () => {
    const p = I('mailto:info@example.com?subject=Hello%20there&bcc=spy@evil.example&body=Hi%2C%20see%20https%3A%2F%2Fexample.org');
    assert.equal(p.kind, 'email');
    assert.equal(p.tier, 'check');
    assert.equal(value(p, 'To'), 'info@example.com');
    assert.equal(value(p, 'Hidden copy (bcc)'), 'spy@evil.example');
    assert.equal(value(p, 'Subject'), 'Hello there');
    assert.ok(ids(p).includes('bcc'));
    assert.ok(p.warnings.some((w) => /never sends it/.test(w.text)));
    assert.deepEqual(p.links, ['https://example.org']);
  });
  test('MATMSG and SMTP forms', () => {
    const m = I('MATMSG:TO:a@b.no;SUB:Hei;BODY:Tekst\\;mer;;');
    assert.equal(value(m, 'Message'), 'Tekst;mer');
    const s = I('SMTP:a@b.no:Subject:Body text');
    assert.equal(value(s, 'Subject'), 'Subject');
    assert.equal(value(s, 'Message'), 'Body text');
  });
  test('a phone number; a service code (* and #, even percent-encoded) is Check; a short number is pointed out', () => {
    const n = I('tel:+47-12-34-56-78');
    assert.equal(n.kind, 'phone');
    assert.equal(n.tier, 'info');
    const fwd = I('tel:*21*12345678%23');
    assert.equal(value(fwd, 'Number'), '*21*12345678#');
    assert.equal(fwd.tier, 'check');
    assert.ok(ids(fwd).includes('service-code'));
    assert.ok(ids(I('tel:1881')).includes('short-number'));
  });
  test('a text message to a short number is Check (it can cost money); SMSTO and several recipients', () => {
    const p = I('sms:2400?body=JA');
    assert.equal(p.tier, 'check');
    assert.equal(value(p, 'To'), '2400');
    assert.equal(value(p, 'Message'), 'JA');
    const s = I('SMSTO:+4712345678:Hello: world');
    assert.equal(value(s, 'Message'), 'Hello: world');
    assert.equal(I('sms:+4711111111,+4722222222').fields.filter((f) => f.label === 'To').length, 2);
  });
});

describe('places', () => {
  test('geo: coordinates, label and Copy; out-of-range coordinates are said to be impossible', () => {
    const p = I('geo:60.4104,5.2269?q=Kleppest%C3%B8+senter');
    assert.equal(p.kind, 'geo');
    assert.equal(value(p, 'Coordinates'), '60.4104, 5.2269');
    assert.equal(fieldOf(p, 'Coordinates').copy, 'Copy coordinates');
    assert.equal(value(p, 'Label or search'), 'Kleppestø senter');
    assert.ok(ids(I('geo:91,200')).includes('geo-bad'));
    assert.equal(value(I('geo:0,0?q=Bergen'), 'Label or search'), 'Bergen');
  });
});

describe('payments: shown with amount and recipient, never paid', () => {
  test('EPC (the EPC069-12 sample: Belgian Red Cross): payee, IBAN that passes its check digits, amount', () => {
    const p = I('BCD\n002\n1\nSCT\nBPOTBEB1\nRed Cross Belgium\nBE72000000001616\nEUR1\nCHAR\n\nUrgency fund\nSample EPC QR code');
    assert.equal(p.kind, 'payment');
    assert.equal(p.tier, 'check');
    assert.equal(value(p, 'Pay to'), 'Red Cross Belgium');
    assert.equal(value(p, 'Account (IBAN)'), 'BE72 0000 0000 1616');
    assert.match(fieldOf(p, 'Account (IBAN)').note, /check digits pass/);
    assert.equal(value(p, 'Amount'), 'EUR 1.00');
    assert.equal(value(p, 'Message'), 'Urgency fund');
    assert.match(fieldOf(p, 'Message').label, /text written by whoever made this code/);
    assert.match(p.summary, /^A request to pay EUR 1\.00\. CheckLink shows payment details and never pays anything\.$/);
    assert.ok(ids(p).includes('never-paid'));
  });
  test('EPC with an altered IBAN and a structured RF reference', () => {
    const p = I('BCD\n002\n1\nSCT\n\nShop AS\nNO9386011117948\nEUR2000\n\nRF18539007547034\n\n');
    assert.ok(ids(p).includes('iban-check'));
    assert.match(fieldOf(p, 'Reference').note, /check digits pass/);
    assert.equal(value(p, 'Amount'), 'EUR 2,000.00');
  });
  test('Swiss QR-bill (SIX’s example): payee, IBAN, CHF amount, reference, payer', () => {
    const p = I('SPC\n0200\n1\nCH4431999123000889012\nS\nRobert Schneider AG\nRue du Lac\n1268\n2501\nBiel\nCH\n\n\n\n\n\n\n\n1949.75\nCHF\nS\nPia-Maria Rutschmann-Schnyder\nGrosse Marktgasse\n28\n9400\nRorschach\nCH\nQRR\n210000000003139471430009017\nOrder of 15 June 2020\nEPD');
    assert.equal(value(p, 'Pay to'), 'Robert Schneider AG');
    assert.equal(value(p, 'Amount'), 'CHF 1,949.75');
    assert.equal(value(p, 'Reference'), '210000000003139471430009017');
    assert.equal(value(p, 'Payer named in the bill'), 'Pia-Maria Rutschmann-Schnyder');
  });
  test('Czech short payment descriptor', () => {
    const p = I('SPD*1.0*ACC:CZ5855000000001265098001*AM:480.50*CC:CZK*MSG:Platba za elektrinu*X-VS:1234567890');
    assert.equal(value(p, 'Amount'), 'CZK 480.50');
    assert.equal(value(p, 'Variable symbol (reference)'), '1234567890');
  });
  test('BIP 21’s own example address fails its checksum, and CheckLink says so', () => {
    const p = I('bitcoin:175tWpb8K1S7NmH4Zx6rewF9WQrcZv245W?amount=50&label=Luke-Jr&message=Donation%20for%20project%20xyz');
    assert.equal(value(p, 'Amount'), '50 BTC (5,000,000,000 sats)');
    assert.equal(value(p, 'Label'), 'Luke-Jr');
    assert.equal(value(p, 'Message'), 'Donation for project xyz');
    assert.ok(ids(p).includes('address-check'));
    assert.ok(ids(p).includes('irreversible'));
  });
  test('a segwit address (BIP 173 vector) passes; an embedded Lightning invoice is read too', () => {
    const p = I(`bitcoin:BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4?amount=0.0025&lightning=${BOLT11.coffee}`);
    assert.ok(!ids(p).includes('address-check'));
    assert.match(fieldOf(p, 'Pay to (address)').note, /checksum passes/);
    assert.equal(value(p, 'Lightning: Amount'), '250,000 sats (0.0025 BTC)');
  });
  test('Lightning (BOLT 11 test vectors): amount, description from the maker, times, expiry', () => {
    const c = I(BOLT11.coffee);
    assert.equal(c.kind, 'payment');
    assert.equal(value(c, 'Amount'), '250,000 sats (0.0025 BTC)');
    assert.equal(value(c, 'Description'), '1 cup coffee');
    assert.equal(value(c, 'Created'), '1 June 2017, 10:57 UTC');
    assert.equal(value(c, 'Expires'), '1 June 2017, 10:58 UTC');
    assert.ok(ids(c).includes('expired'));
    assert.equal(value(I(`lightning:${BOLT11.nonsense}`), 'Description'), 'ナンセンス 1杯');
    assert.equal(value(I(BOLT11.donation), 'Amount'), 'Not given: your wallet would ask you');
    assert.equal(value(I(BOLT11.pico), 'Amount'), '967,878.534 sats (0.00967878534 BTC)');
    assert.equal(value(I(BOLT11.payee), 'Payee node'), '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad');
    assert.equal(value(I(BOLT11.coffee.toUpperCase()), 'Description'), '1 cup coffee');
  });
  test('broken Lightning requests (BOLT 11’s invalid vectors) are never read as valid', () => {
    for (const bad of [BOLT11.badChecksum, BOLT11.mixedCase]) {
      const p = I(bad);
      assert.ok(ids(p).includes('unreadable'), bad.slice(0, 20));
    }
    assert.ok(ids(I(BOLT11.subMsat)).includes('unreadable'));
  });
  test('LNURL (LUD-01’s example) decodes to the address the wallet would contact, which is checked as a link', () => {
    const p = I('LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS');
    assert.deepEqual(p.links, ['https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df']);
    assert.ok(ids(p).includes('lnurl'));
    const login = I('lightning:keyauth://site.example/login?tag=login&k1=abc');
    assert.equal(login.kind, 'account-link');
    assert.deepEqual(login.links, ['https://site.example/login?tag=login&k1=abc']);
    assert.equal(value(I('lightning:user@getalby.com'), 'Lightning address'), 'user@getalby.com');
  });
  test('Ethereum (EIP-681 examples): a payment and a token transfer', () => {
    const p = I('ethereum:0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359?value=2.014e18');
    assert.equal(value(p, 'Amount'), '2.014 ETH');
    const t = I('ethereum:0x89205a3a3b2a69de6dbf7f01ed13b2108b2c43e7/transfer?address=0x8e23ee67d1332ad560396262c48ffbb01f93d052&uint256=1');
    assert.equal(value(t, 'Action it asks for'), 'transfer');
    assert.equal(value(t, 'Sends to'), '0x8e23ee67d1332ad560396262c48ffbb01f93d052');
    assert.ok(ids(t).includes('contract-call'));
  });
  test('other coins, UPI (and its repeated-payment mandate), a Solana transaction request', () => {
    assert.equal(value(I('monero:46BeWrHpwXmHDpDEUmZBWZfoQpdc6HaERCNmx1pEYL2rAcuwufPN9rXHHtyUA4QVy66qeFQkn6sfK8aHYjA3jk3o1Bv16em?tx_amount=0.1'), 'Amount'), '0.1 XMR');
    assert.equal(value(I('litecoin:LcHKx5CkHGSE2pB6bhmT1jpRdaSCtBQXZp?amount=1.5'), 'Amount'), '1.5 LTC');
    const u = I('upi://pay?pa=shop@upi&pn=Shop&am=100&cu=INR&tn=Order%2012');
    assert.equal(value(u, 'Amount'), 'INR 100.00');
    assert.ok(ids(I('upi://mandate?pa=x@upi&am=10')).includes('mandate'));
    const sol = I('solana:https%3A%2F%2Fshop.example%2Fpay%3Forder%3D1');
    assert.deepEqual(sol.links, ['https://shop.example/pay?order=1']);
    assert.ok(ids(sol).includes('tx-request'));
  });
  test('Pix (the Banco Central example): key, payee, city; a changed code fails its own check', () => {
    const good = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
    const p = I(good);
    assert.equal(p.title, 'A Pix payment code');
    assert.equal(value(p, 'Pix key'), '123e4567-e12b-12d1-a456-426655440000');
    assert.equal(value(p, 'Pay to'), 'Fulano de Tal');
    assert.ok(!ids(p).includes('crc'));
    assert.ok(ids(I(good.replace('Fulano', 'Golpis'))).includes('crc'));
    // A dynamic Pix code, built here with correct lengths and check: the bank app would fetch
    // the payment from the address inside it, so that address is checked as a link.
    const tlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
    const body = tlv('00', '01') + tlv('01', '12') + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('25', 'pix.example.com/qr/v2/9d36b84f-c70b-478f-b95c-12729b90ca25'))
      + tlv('52', '0000') + tlv('53', '986') + tlv('54', '123.45') + tlv('58', 'BR') + tlv('59', 'Loja Exemplo') + tlv('60', 'BRASILIA') + tlv('62', tlv('05', '***')) + '6304';
    const dyn = I(body + crc16(body));
    assert.ok(!ids(dyn).includes('crc'));
    assert.deepEqual(dyn.links, ['https://pix.example.com/qr/v2/9d36b84f-c70b-478f-b95c-12729b90ca25']);
    assert.equal(value(dyn, 'Amount'), 'BRL 123.45');
  });
  test('Swish: the prefilled code and the app link, both only "looks like"', () => {
    const c = I('C1231181189;100;Testbetalning;0');
    assert.equal(value(c, 'Swish number'), '1231181189');
    assert.equal(value(c, 'Amount'), 'SEK 100.00');
    const l = I(`swish://payment?data=${encodeURIComponent(JSON.stringify({ version: 1, payee: { value: '1231181189' }, amount: { value: 50 }, message: { value: 'Hei' } }))}`);
    assert.equal(value(l, 'Amount'), 'SEK 50.00');
    assert.equal(I('swish://payment?data=%7Bnot-json').fields[0].label, 'Link as written');
  });
});

describe('secrets: never shown in full by default, and Stop', () => {
  test('a 2FA setup code (Google’s key-uri example): service, account, secret hidden, the "whoever has this code" warning', () => {
    const p = I('otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example');
    assert.equal(p.kind, 'secret');
    assert.equal(p.tier, 'stop');
    assert.equal(p.secret, true);
    assert.equal(value(p, 'Service'), 'Example');
    assert.equal(value(p, 'Account'), 'alice@google.com');
    const s = fieldOf(p, 'Secret');
    assert.equal(s.secret, true);
    assert.equal(s.value, 'JBSWY3DPEHPK3PXP');
    assert.equal(s.note, null, 'no bit count: it means nothing to most readers (UI review L5)');
    assert.match(p.warnings[0].text, /^Whoever has this code can make the same sign-in codes as you/);
    assert.equal(value(I('otpauth://hotp/Bank?secret=JBSWY3DPEHPK3PXP&counter=1&digits=8'), 'Digits'), '8');
    assert.equal(value(I('otpauth://totp/NoSecret'), 'Secret'), 'Missing: this setup code cannot work');
  });
  test('an authenticator export lists the accounts and hides every secret', () => {
    const p = I(migration([{ name: 'alice@example.com', issuer: 'Example' }, { name: 'bob', issuer: 'Bank' }]));
    assert.equal(p.kind, 'secret');
    assert.equal(value(p, 'Account 1'), 'Example: alice@example.com');
    assert.equal(value(p, 'Account 2'), 'Bank: bob');
    assert.equal(value(p, 'Secrets'), '2 hidden');
    assert.ok(fieldOf(p, 'The whole code').secret);
    assert.match(p.warnings[0].text, /Whoever has this code can make the sign-in codes for every account in it/);
    const broken = I('otpauth-migration://offline?data=%%%garbage');
    assert.equal(value(broken, 'Secrets'), 'Could not be read');
  });
  test('BIP-39 recovery phrases: the 12-word test vector passes its check, numbered words too; a wrong last word does not', () => {
    const v = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const p = I(v);
    assert.equal(p.title, 'A wallet recovery phrase');
    assert.equal(fieldOf(p, 'The words').secret, true);
    assert.equal(fieldOf(p, 'The words').copyValue, v);
    assert.match(value(p, 'Checksum'), /pass the phrase’s own check/);
    assert.match(p.warnings[0].text, /^Whoever has these words has the wallet/);
    assert.match(value(I(v.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n')), 'Checksum'), /pass/);
    assert.match(value(I(v.replace(/about$/, 'abandon')), 'Checksum'), /does not pass/);
    const v24 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote';
    assert.match(value(I(v24), 'Words'), /^24 words$/);
    assert.equal(I('the quick brown fox jumps over the lazy dog and then sleeps all day').kind, 'text');
  });
  test('SeedQR digits and a CompactSeedQR’s raw bytes are read as recovery phrases', () => {
    const digits = `${'0000'.repeat(11)}0003`;
    const s = I(digits);
    assert.match(s.title, /SeedQR/);
    assert.match(value(s, 'Checksum'), /pass/);
    const c = I('\u0000'.repeat(16), { bytes: new Uint8Array(16), contentType: 'Binary', format: 'QRCode' });
    assert.match(c.title, /CompactSeedQR/);
    assert.equal(fieldOf(c, 'The words').copyValue, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    assert.equal(I('9'.repeat(48)).kind, 'text', 'groups above 2047 are not words');
  });
  test('private keys: Nostr nsec (NIP-19 example), Bitcoin WIF, an extended key (BIP 32 vector), PEM, age, 64 hex', () => {
    const n = I('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5');
    assert.equal(n.kind, 'secret');
    assert.equal(value(n, 'Checksum'), 'Its checksum passes.');
    assert.equal(I('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ').title, 'A private key (Bitcoin, WIF)');
    assert.equal(I('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi').kind, 'secret');
    const madeUp = base58CheckEncode(new Uint8Array([0x80, ...new Array(32).fill(7), 0x01]));
    assert.equal(I(madeUp).kind, 'secret');
    assert.ok(base58Check(madeUp));
    assert.equal(I('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----').title, 'A private key (SSH)');
    assert.equal(I('-----BEGIN PGP PRIVATE KEY BLOCK-----\nxyz').title, 'A private key (PGP)');
    assert.equal(I('AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQS3290GG').title, 'A private key (age)');
    assert.equal(I(`0x${'ab'.repeat(32)}`).title, 'Possibly a private key');
    for (const p of [n, I(madeUp)]) assert.ok(p.warnings.some((w) => /^Whoever has this code has the key/.test(w.text)));
  });
  test('API keys and tokens with a known shape are Stop, and the text stays hidden', () => {
    for (const [text, name] of [
      [`ghp_${'A1b2'.repeat(9)}`, 'GitHub token'],
      ['AKIAIOSFODNN7EXAMPLE', 'AWS access key'],
      [`sk_live_${'x'.repeat(24)}`, 'Stripe secret key'],
      [`AIza${'B'.repeat(35)}`, 'Google API key'],
      [`xoxb-${'1234567890-'.repeat(2)}abcdef`, 'Slack token'],
      ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'JWT sign-in token'],
      [`token=${'sk-ant-'}${'a'.repeat(40)}`, 'Anthropic API key'],
    ]) {
      const p = I(text);
      assert.equal(p.kind, 'secret', name);
      assert.ok(value(p, 'Looks like').includes(name), name);
      assert.ok(fieldOf(p, 'The text').secret, name);
    }
  });
});

describe('account linking: Stop, with what happens in plain words', () => {
  test('Signal device linking uses the spec’s own words', () => {
    const p = I('sgnl://linkdevice?uuid=abc&pub_key=xyz');
    assert.equal(p.kind, 'account-link');
    assert.equal(p.tier, 'stop');
    // The spec's sentence, split between the summary and the warning so the card does not say
    // its first sentence twice (UI review L15).
    assert.equal(`${p.summary} ${p.warnings[0].text}`, 'This links your Signal account to another device. Whoever controls that device will read your future messages. Only scan it with Signal when you are setting up your own computer.');
  });
  test('Telegram, passkeys, WalletConnect, BankID, WhatsApp, Nostr signers and wallet connections', () => {
    for (const t of [
      'tg://login?token=AQAAABCdefGHI',
      'FIDO:/1234567890123456789012345678901234567890',
      'wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303',
      'bankid.67df3917-fa0d-44e5-b327-edcc928297f8.0.dc69358e712458a66a7525beef148ae8526b1c71610eff2c16cdffb4cdac9bf8',
      'bankid:///?autostarttoken=46f6aa68-164c-4f17-8f4e-0a8b7e0b2c0a',
      `2@${'A'.repeat(40)},${'B'.repeat(44)},${'C'.repeat(44)}`,
      'bunker://79dff8f82963424e0bb02708a22e44b4980893e3a4be0fa3cb60a43b946764e3?relay=wss://relay.example&secret=abc',
      'nostrconnect://83f3b2ae6aa368e8275397b9c26cf550101d63ebaab900d19dd4a4429f5ad8f5?relay=wss://relay.example&secret=0s8j2djs',
      'nostr+walletconnect://b889ff5b1513b641e2a139f661a661364979c5beee91842f8f0ef42ab558e9d4?relay=wss%3A%2F%2Frelay.damus.io&secret=71a8c14c1407c113601079c4302dab36460f0ccd0ad506f1f2dc73b5100e4f3c',
    ]) {
      const p = I(t);
      assert.equal(p.tier, 'stop', t.slice(0, 30));
      assert.equal(p.secret, true, t.slice(0, 30));
      assert.ok(fieldOf(p, 'The whole code').secret);
    }
  });
});

describe('scripts and app launchers', () => {
  test('scripts and local files are Stop and never offered as links, in any case and behind invisible characters', () => {
    for (const t of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:msgbox', 'ms-msdt:/id PCWDiagnostic', '​javascript:alert(1)']) {
      const p = I(t);
      assert.equal(p.kind, 'script', t);
      assert.equal(p.tier, 'stop', t);
      assert.deepEqual(p.links, []);
    }
  });
  test('an Android intent names the app, and its backup address is checked as a link', () => {
    const p = I('intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;S.browser_fallback_url=https%3A%2F%2Fexample.org%2Fapp%3Futm_source%3Dqr;end');
    assert.equal(p.kind, 'app');
    assert.equal(p.tier, 'check');
    assert.equal(value(p, 'App (package)'), 'com.google.zxing.client.android');
    assert.deepEqual(p.links, ['https://example.org/app?utm_source=qr']);
    assert.ok(p.warnings.some((w) => /CheckLink never starts it/.test(w.text)));
  });
  test('the Play Store, an iPhone install from outside the App Store, Windows shares, BitTorrent, known and unknown apps', () => {
    assert.equal(value(I('market://details?id=com.example.app'), 'App (package)'), 'com.example.app');
    const it = I('itms-services://?action=download-manifest&url=https://example.com/app.plist');
    assert.ok(ids(it).includes('sideload'));
    assert.deepEqual(it.links, ['https://example.com/app.plist']);
    assert.ok(ids(I('smb://fileserver/share')).includes('smb'));
    assert.equal(value(I('magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Ubuntu+ISO'), 'File name it gives'), 'Ubuntu ISO');
    assert.match(I('zoommtg://zoom.us/join?confno=123').summary, /This opens Zoom/);
    assert.match(I('foo://bar').summary, /whichever app on your device has claimed foo: links/);
  });
  test('ordinary text with a colon is not an app link', () => {
    assert.equal(I('Note: hello').kind, 'text');
    assert.equal(I('abc:xyz').kind, 'text');
    assert.equal(I('Password:hunter2').kind, 'text');
  });
});

describe('other kinds', () => {
  test('product numbers: EAN-13 with its check digit, ISBN, UPC-A by format, GS1 data', () => {
    const e = I('7038010001895', { format: 'EAN13' });
    assert.equal(e.kind, 'product');
    assert.equal(fieldOf(e, 'Number').note, 'Its check digit is right.');
    assert.equal(fieldOf(I('7038010001896', { format: 'EAN13' }), 'Number').note, 'Its check digit is wrong: the code may be damaged.');
    assert.equal(I('9780306406157').title, 'A book number (ISBN)');
    assert.equal(I('036000291452', { format: 'UPCA' }).kind, 'product');
    const g = I('(01)09521234543213(17)261231(10)ABC123');
    assert.equal(value(g, 'Use by or expiry'), '31 December 2026');
    assert.equal(value(g, 'Batch or lot'), 'ABC123');
  });
  test('a boarding pass (IATA BCBP example): name shown, booking reference hidden, Check', () => {
    const p = I('M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 326J001A0025 100');
    assert.equal(p.kind, 'boarding-pass');
    assert.equal(p.tier, 'check');
    assert.equal(value(p, 'Passenger'), 'DESMARAIS, LUC');
    assert.equal(fieldOf(p, 'Booking reference').secret, true);
    assert.equal(value(p, 'Flight'), 'AC 834');
    assert.equal(value(p, 'Seat'), '1A');
  });
  test('a health certificate, Nostr public addresses, data that is not text, an empty code', () => {
    assert.equal(I('HC1:NCFOXN%TS3DH3ZSUZK+.V0ETD%65NL-AH').kind, 'health');
    const np = I('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg');
    assert.equal(np.kind, 'nostr');
    assert.equal(np.tier, 'info');
    const b = I('\u0001\u0002ÿ\u0003', { bytes: new Uint8Array([1, 2, 255, 3, 4, 5]), contentType: 'Binary' });
    assert.equal(b.kind, 'binary');
    assert.equal(value(b, 'First bytes (hexadecimal)'), '01 02 ff 03 04 05');
    assert.equal(I('').kind, 'empty');
  });
  test('format labels', () => {
    assert.equal(formatLabel('QRCode'), 'QR code');
    assert.equal(formatLabel('DataMatrix'), 'Data Matrix code');
    assert.equal(formatLabel('Nonsense'), 'code');
    assert.equal(inspect('x', { format: 'Aztec' }).formatLabel, 'Aztec code');
  });
});

describe('hostile, oversized and malformed content', () => {
  test('a very long text is cut for display and still classified quickly', () => {
    const t0 = performance.now();
    const p = I(`https://example.com/${'a'.repeat(40000)}`);
    assert.ok(performance.now() - t0 < 2000);
    assert.equal(p.truncated, true);
    assert.equal(p.text.length, MAX_TEXT);
    assert.equal(p.length, 40020);
  });
  test('control characters and direction overrides are flagged, never dropped', () => {
    const p = I('Pay here: https://example.com/‮gpj.exe \u0000\u001B[31m');
    assert.equal(p.tier, 'check');
    assert.ok(ids(p).includes('invisible'));
    assert.match(p.warnings.find((w) => w.id === 'invisible').text, /U\+202E/);
    assert.ok(p.text.includes('‮') && p.text.includes('\u0000'));
  });
  test('malformed structured codes give a description, never an exception', () => {
    for (const t of [
      'WIFI:', 'WIFI:;;;;\\\\\\', `WIFI:S:${'\\;'.repeat(5000)};;`, 'MECARD:', 'MECARD:N', 'BEGIN:VCARD', `BEGIN:VCARD\n${'NOTE:x\n'.repeat(5000)}END:VCARD`,
      'BEGIN:VEVENT\nDTSTART:2026', 'mailto:', 'mailto:?%E0%A4%A', 'tel:', 'sms:', 'SMSTO:', 'geo:', 'geo:a,b', 'BCD\n', 'BCD\n002', 'SPC\n', 'SPD*1.0*',
      'bitcoin:', 'bitcoin:?amount=abc', 'lightning:', 'lightning:lnbc1', 'lnbc1qqqqqqqqqqqqqqqqqqqqqqqq', 'ethereum:', 'ethereum:0x?value=lots',
      'upi://pay?', '000201', `000201${'99'.repeat(10)}6304ABCD`, '0002011234', 'C123456;;;', 'swish://', 'otpauth://', 'otpauth://totp/?secret=%%%',
      'otpauth-migration://offline?data=CgA', 'otpauth-migration://offline?data=' + 'A'.repeat(10000), 'nsec1', 'npub1qqqqqq', 'intent://#Intent;end', 'intent:',
      'market://', 'M1', 'HC1:', '(01)', `(${'9'.repeat(50)})x`, 'LNURL1', 'lnurlp://', 'wc:', 'FIDO:/', `${'\\'.repeat(9000)}`, '�'.repeat(3000),
      '𐀀\uD800', `${'('.repeat(5000)}https://example.com${')'.repeat(5000)}`,
    ]) {
      const t0 = performance.now();
      const p = I(t);
      assert.ok(KINDS.includes(p.kind), JSON.stringify(t).slice(0, 40));
      assert.ok(performance.now() - t0 < 1500, `slow on ${JSON.stringify(t).slice(0, 40)}`);
    }
  });
  test('7,089 digits (the most a QR code holds) are plain text', () => {
    const p = I('7'.repeat(7089));
    assert.equal(p.kind, 'text');
  });
  test('inputs that are not strings do not throw', () => {
    assert.equal(inspect(null).kind, 'empty');
    assert.equal(inspect(undefined, { bytes: 'nope' }).kind, 'empty');
  });
});

// == names every object inherits (type check of 14 October 2026) ==
// A plain JavaScript object inherits constructor, toString, __proto__ and nine more names. The
// inspector looks its tables up with text from the code, so a lookup must find only a table's own
// names. Before the fix, "Constructor: ..." was a payment in a coin called "function Object()
// { [native code] }" and a web address in it was not offered for checking (the coin table); with
// only that table fixed, "constructor:x" opened "function Object() ..." (the app table); an EMV
// currency field holding such a name gave garbage as the amount; and a Nostr address with such a
// prefix was "function Object() ..." or "[object Object]".

const INHERITED = Object.getOwnPropertyNames(Object.prototype);
// A word as written, capitalised, in capitals, and in alternating capitals.
const capitals = (w) => [w, w[0].toUpperCase() + w.slice(1), w.toUpperCase(), [...w].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('')];
const NATIVE = /\[native code\]|\[object Object\]|function \w*\(/;
const noNative = (p, where) => assert.ok(!NATIVE.test(JSON.stringify(p)), `an inherited value shows in ${where}: ${JSON.stringify(p).match(NATIVE)}`);
// The same card for another word of the same length that no object inherits.
const sameCardAs = (p, q, word, other) => assert.equal(JSON.stringify(p).replace(new RegExp(word, 'gi'), '~'), JSON.stringify(q).replace(new RegExp(other, 'gi'), '~'), `${word} against ${other}`);
const TO_CHECK = 'https://evil.example/login';

// A bech32 string (BIP 173) from a prefix and 5-bit values, for prefixes the tests make up.
function bech32Encode(hrp, data) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data, 0, 0, 0, 0, 0, 0]) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  chk = (chk ^ 1) >>> 0;
  const sum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...sum].map((v) => 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'[v]).join('')}`;
}

// An EMV shop payment code with this currency field and amount 10, its own check correct.
const emvTlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
const emvWith = (currency) => {
  const body = emvTlv('00', '01') + emvTlv('53', currency) + emvTlv('54', '10') + emvTlv('59', 'Example Shop') + '6304';
  return body + crc16(body);
};

describe('names every object inherits, in text from a code', () => {
  test('"constructor:" in any capitals is plain text, not a payment, and a web address in it is offered for checking (the coin table)', () => {
    assert.ok(['toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'].every((n) => INHERITED.includes(n)));
    for (const word of capitals('constructor')) {
      for (const [rest, links] of [
        [': Ola Nordmann AS, Askoy', []],
        [':abc?amount=5', []],
        [':x', []],
        [`: Ola Nordmann AS, see ${TO_CHECK}`, [TO_CHECK]],
        [`:${TO_CHECK}`, [TO_CHECK]],
      ]) {
        const text = word + rest;
        const where = JSON.stringify(text);
        const p = I(text);
        assert.equal(p.kind, 'text', where);
        assert.equal(p.title, 'Text', where);
        assert.equal(p.tier, 'info', where);
        assert.equal(p.scheme, null, where);
        assert.deepEqual(p.fields, [], where);
        assert.deepEqual(p.links, links, where);
        assert.equal(p.summary, links.length ? 'Text with a web address in it. Nothing has been opened.' : 'Plain text. Nothing in it opens anything.', where);
        noNative(p, where);
        sameCardAs(p, I(word.replace(/constructor/i, 'contributor') + rest), 'constructor', 'contributor');
      }
    }
  });

  test('"constructor://" in any capitals is an app link like any unknown one, never "This opens function Object()" (the app table)', () => {
    for (const word of capitals('constructor')) {
      const text = `${word}://evil.example/login`;
      const p = I(text);
      assert.equal(p.kind, 'app', text);
      assert.equal(p.title, 'Opens an app', text);
      assert.equal(p.scheme, 'constructor', text);
      assert.equal(p.summary, 'This opens whichever app on your device has claimed constructor: links. Nothing has been opened.', text);
      noNative(p, text);
      sameCardAs(p, I(`${word.replace(/constructor/i, 'contributor')}://evil.example/login`), 'constructor', 'contributor');
    }
  });

  test('every name an object inherits, before a colon and in any capitals, is never a payment or a named app, and a web address in it is offered for checking', () => {
    for (const name of INHERITED) {
      for (const word of capitals(name)) {
        for (const rest of [`: see ${TO_CHECK}`, `:${TO_CHECK}`]) {
          const p = I(word + rest);
          assert.equal(p.kind, 'text', word + rest);
          assert.deepEqual(p.links, [TO_CHECK], word + rest);
          noNative(p, word + rest);
        }
        for (const rest of [':x', ':abc?amount=5', ': Ola Nordmann AS', '://evil.example/login']) {
          const p = I(word + rest);
          assert.ok(p.kind === 'text' || (p.kind === 'app' && /^This opens whichever app on your device has claimed /.test(p.summary)), `${word + rest}: ${p.kind}, ${p.summary}`);
          noNative(p, word + rest);
        }
      }
    }
  });

  test('a Nostr address whose prefix is a name every object inherits is "a Nostr address" (the Nostr kinds table)', () => {
    for (const name of INHERITED) {
      const hrp = name.toLowerCase();
      const addr = bech32Encode(hrp, [0, 1, 2, 3, 4, 5]);
      assert.equal((bech32Decode(addr, 5000) || {}).hrp, hrp, `${addr}: its checksum passes, so the table is looked up`);
      for (const text of [`nostr:${addr}`, `NOSTR:${addr.toUpperCase()}`]) {
        const p = I(text);
        assert.equal(p.kind, 'nostr', text);
        assert.equal(p.summary, 'This is a Nostr address. It is public by design and holds nothing secret.', text);
        assert.equal(fieldOf(p, 'Address').note, 'Its checksum passes.', text);
        noNative(p, text);
      }
    }
  });

  test('an EMV currency field holding a name every object inherits reads like a made-up currency: "10 (currency number constructor)"', () => {
    assert.equal(value(I(emvWith('abc')), 'Amount'), '10 (currency number abc)');
    assert.equal(value(I(emvWith('578')), 'Amount'), 'NOK 10.00');
    for (const name of INHERITED) {
      const p = I(emvWith(name));
      assert.equal(p.title, 'A shop payment code (EMV)', name);
      assert.ok(!ids(p).includes('crc'), `${name}: the code's own check passes`);
      assert.equal(value(p, 'Amount'), `10 (currency number ${name})`, name);
      assert.equal(p.summary, `A request to pay 10 (currency number ${name}). CheckLink shows payment details and never pays anything.`, name);
      noNative(p, name);
    }
  });
});

describe('invariants over every payload seen in these tests', () => {
  test('every payload has a known kind and tier, a title and a summary in calm British English', () => {
    assert.ok(seen.length > 150, `${seen.length} payloads`);
    for (const { text, p } of seen) {
      const where = JSON.stringify(text).slice(0, 50);
      assert.ok(KINDS.includes(p.kind), where);
      assert.ok(['stop', 'check', 'info'].includes(p.tier), where);
      const words = [p.title, p.summary, ...p.warnings.map((w) => w.text), ...p.fields.flatMap((f) => [f.label, f.note || '', f.copy || ''])].join('\n');
      assert.ok(!/—|–|--/.test(words), `dashes in ${where}`);
      assert.ok(!/!/.test(words.replace(/https?:\/\/\S*/g, '')), `exclamation mark in ${where}`);
      assert.ok(!/\bsafe/i.test(words), `"safe" in ${where}`);
      assert.ok(!/\b(color|organiz|gray|center|favorite|behavior|analyz|recogniz|license\b)/i.test(words), `American spelling in ${where}`);
    }
  });
  test('a hidden value never appears in CheckLink’s own sentences', () => {
    for (const { p } of seen) {
      const own = [p.title, p.summary, ...p.warnings.map((w) => w.text)].join('\n');
      for (const f of p.fields.filter((x) => x.secret && x.value.length >= 6)) assert.ok(!own.includes(f.value), `${f.label} leaked into the words of ${p.title}`);
    }
  });
  test('every Stop secret warns that whoever has the code has the secret; every payment says it is never paid', () => {
    for (const { text, p } of seen) {
      if (p.kind === 'secret') assert.ok(p.warnings.some((w) => w.tier === 'stop' && /^Whoever has (this code|these words)/.test(w.text)), JSON.stringify(text).slice(0, 40));
      // Said once, in the summary, with the advice to compare in the warnings (UI review M1).
      if (p.kind === 'payment') assert.ok(/never pays anything/.test(p.summary) && !p.warnings.some((w) => /never pays anything/.test(w.text)) && p.warnings.some((w) => /^Compare the name, account and amount/.test(w.text)), JSON.stringify(text).slice(0, 40));
      if (p.tier === 'stop') assert.ok(p.warnings.some((w) => w.tier === 'stop'), `a Stop payload names its reason: ${p.title}`);
    }
  });
  test('the page never gets a web address that is not one: every listed link reads as http or https', () => {
    for (const { p } of seen) for (const l of p.links) assert.ok(/^(https?:\/\/|www\.)/i.test(l), l);
  });
  test('qr-inspect.js and its helpers stay pure: no DOM, no network, plain ASCII', () => {
    for (const file of ['qr-inspect.js', 'payload-codecs.js', 'domain.js', 'image-check.js']) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      for (const banned of ['innerHTML', 'outerHTML', 'document.', 'window.', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'require(', 'process.', 'import(']) {
        assert.ok(!src.includes(banned), `${file} must not use ${banned}`);
      }
      assert.ok(!/[^\x00-\x7F]/.test(src), `${file} is plain ASCII`);
    }
  });
});
