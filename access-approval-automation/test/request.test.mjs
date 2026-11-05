import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_FIELDS as F, validateRequest, validationParagraphs } from '../src/request.mjs';

function request(type = 'Account Access') {
  return { fields: {
    summary: 'Request access', [F.category]: { value: 'Engineering' },
    [F.component]: { value: 'Databricks' }, [F.accessType]: { value: type },
    [F.accountId]: 'ACCOUNT-123', [F.siteId]: 'SITE-123'
  } };
}

test('account access accepts non-empty text without inventing a vendor ID format', () => {
  assert.equal(validateRequest(request()).valid, true);
});

for (const role of ['Team Member', 'Super User', 'Read Only']) {
  test(`Role Access accepts ${role} without requiring account or site fields`, () => {
    const issue = request('Role Access');
    issue.fields[F.accountId] = issue.fields[F.siteId] = null;
    issue.fields[F.role] = { value: role };
    assert.equal(validateRequest(issue).valid, true);
  });
}

for (const platform of ['EC2', 'AWS', 'Snowflake']) {
  test(`Platform Access accepts ${platform} without requiring a role`, () => {
    const issue = request('Platform Access');
    issue.fields[F.accountId] = issue.fields[F.siteId] = issue.fields[F.role] = null;
    issue.fields[F.platform] = { value: platform };
    assert.equal(validateRequest(issue).valid, true);
  });
}

const cases = [
  ['Summary is blank', e => { e.fields.summary = ' '; }, ['SUMMARY_REQUIRED']],
  ['Category is missing', e => { e.fields[F.category] = null; }, ['CATEGORY_REQUIRED']],
  ['Component is not a single option', e => { e.fields[F.component] = [{ value: 'Some component' }]; }, ['COMPONENT_REQUIRED']],
  ['Access Type is missing', e => { e.fields[F.accessType] = null; }, ['ACCESS_TYPE_REQUIRED']],
  ['Access Type is unsupported', e => { e.fields[F.accessType] = { value: 'Anything else' }; }, ['ACCESS_TYPE_INVALID']],
  ['both account fields are missing', e => { e.fields[F.accountId] = e.fields[F.siteId] = null; }, ['ACCOUNT_ID_REQUIRED', 'SITE_ID_REQUIRED']],
  ['Account ID is whitespace', e => { e.fields[F.accountId] = '  '; }, ['ACCOUNT_ID_REQUIRED']],
  ['Site ID is not text', e => { e.fields[F.siteId] = 12345; }, ['SITE_ID_INVALID']],
  ['Account ID contains a line break', e => { e.fields[F.accountId] = 'account\nnext'; }, ['ACCOUNT_ID_INVALID']],
  ['Role is missing', e => { e.fields[F.accessType] = { value: 'Role Access' }; }, ['ROLE_REQUIRED']],
  ['Role is unsupported', e => { e.fields[F.accessType] = { value: 'Role Access' }; e.fields[F.role] = { value: 'Administrator' }; }, ['ROLE_INVALID']],
  ['Platform is missing', e => { e.fields[F.accessType] = { value: 'Platform Access' }; }, ['PLATFORM_REQUIRED']],
  ['Platform is unsupported', e => { e.fields[F.accessType] = { value: 'Platform Access' }; e.fields[F.platform] = { value: 'Other service' }; }, ['PLATFORM_INVALID']]
];
for (const [name, mutate, codes] of cases) {
  test(`required-field check: ${name}`, () => {
    const issue = request();
    mutate(issue);
    const result = validateRequest(issue);
    assert.equal(result.valid, false);
    assert.deepEqual(result.errorCodes, codes);
  });
}

test('irrelevant stale hidden fields do not affect Account Access validation', () => {
  const issue = request();
  issue.fields[F.role] = { value: 'Old role' };
  issue.fields[F.platform] = { value: 'Old platform' };
  assert.equal(validateRequest(issue).valid, true);
});

test('new configured categories/components are accepted without hardcoded sample lists', () => {
  const issue = request();
  issue.fields[F.category] = { value: 'A new category' };
  issue.fields[F.component] = { value: 'A new component' };
  assert.equal(validateRequest(issue).valid, true);
});

test('an absent request cannot pass validation', () => {
  assert.equal(validateRequest(null).valid, false);
});

test('invalid details produce specific English corrections without echoing raw values', () => {
  const issue = request('Role Access');
  issue.fields[F.role] = { value: 'PRIVATE-UNSUPPORTED-VALUE' };
  const text = validationParagraphs(validateRequest(issue)).join('\n');
  assert.ok(text.includes('Team Member, Super User, or Read Only'));
  assert.ok(text.includes('new Grant access comment'));
  assert.ok(!text.includes('PRIVATE-UNSUPPORTED-VALUE'));
  assert.ok(!text.includes('passed validation'));
});

for (const value of [undefined, { valid: true }, {
  valid: false, code: 'REQUEST_FIELDS_INVALID', errorCodes: ['UNTRUSTED-MESSAGE']
}]) {
  test(`missing or unrecognized validation output fails closed: ${JSON.stringify(value)}`, () => {
    const text = validationParagraphs(value).join('\n');
    assert.ok(text.includes('administrator needs to review'));
    assert.ok(!text.includes('passed validation'));
    assert.ok(!text.includes('UNTRUSTED-MESSAGE'));
  });
}
