import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAutomationLabel } from '../src/automation.mjs';

const cases = [
  ['exact label enables automation', ['access-automation'], true],
  ['other labels can coexist', ['urgent', 'access-automation'], true],
  ['no labels means manual processing', [], false],
  ['unrelated label does not enable automation', ['urgent'], false],
  ['different capitalisation does not match', ['Access-Automation'], false],
  ['partial label does not match', ['access-automation-test'], false],
  ['missing label data does not enable automation', undefined, false]
];

for (const [name, labels, expected] of cases) {
  test(name, () => {
    const issue = { fields: { labels } };

    assert.equal(hasAutomationLabel(issue), expected);
  });
}