// Marcos's own links (rules/marcos-regression.json): real links he tested by hand on 10
// October 2026, each with the clean link he expects. One test per case; every case must
// pass. Run from the repository root with: node --test tests/
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse } from '../src/link-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { cases } = JSON.parse(readFileSync(path.join(ROOT, 'rules', 'marcos-regression.json'), 'utf8'));

describe("Marcos's regression links", () => {
  test('there are thirteen cases, each with a unique id, and every one is marked passing', () => {
    assert.equal(cases.length, 13);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    for (const c of cases) assert.equal(c.status, 'passing', c.id);
  });

  for (const c of cases) {
    test(`${c.id}: ${c.dirty.slice(0, 70)}`, () => {
      const r = analyse(c.dirty);
      assert.equal(r.found, true);
      assert.equal(r.cleanLink, c.clean);
      assert.equal(r.changed, c.clean !== c.dirty);
      // Whatever is removed, the clean link goes where the analysis says.
      assert.equal(new URL(r.openUrl()).hostname, r.host);
    });
  }
});
