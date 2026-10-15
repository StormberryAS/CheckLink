// The real names that ARE look-alikes by CheckLink's rules, so they are kept out of
// tests/fixtures/real-domains.txt (made by make-real-domains.mjs). Each says which note it gets
// and why that note is right; tests/lookalike.test.mjs checks that each still gets it.

export const KNOWN = {
  'www.xn--gfiaegis-2m3d.com': 'look-alike-symbol: a real company site whose name uses U+2010 (a hyphen look-alike) where gfi-aegis.com uses a hyphen; it is a different address from gfi-aegis.com, as the note says',
  'xn--schl65mgn-22ha.3dn.ru': 'look-alike-letters: a real school site whose name mixes Cyrillic o into Latin "school"; mixing alphabets is exactly what the note describes',
  'microsoft.msafflnk.net': 'look-alike-brand: Microsoft\'s affiliate service run by impact.com; with its /c/ path it is a known wrapper and gets no note (tested with the corpus link), the bare host mentions Microsoft under msafflnk.net, which is true',
};
