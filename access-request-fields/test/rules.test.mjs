import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, registerRules } from '../static/hello-world/src/rules.mjs';
import { branches, config } from '../src/config.mjs';

function fixture(type, initial = {}) {
  const fields = new Map();
  fields.set(config.accessType, { getValue: () => type ? { value: type } : null });
  for (const branch of branches) {
    fields.set(branch.id, {
      value: initial[branch.id] ?? branch.empty,
      getValue() { return this.value; },
      setVisible(value) { this.visible = value; },
      setRequired(value) { this.required = value; },
      setValue(value) { this.value = value; }
    });
  }
  return { fields, api: { getFieldById: id => fields.get(id) } };
}

for (const [type, visibleIds] of [
  ['Account Access', [config.accountId, config.siteId]],
  ['Role Access', [config.role]],
  ['Platform Access', [config.platform]],
  [null, []],
  ['Unsupported Access', []]
]) {
  test(`shows and requires exactly the selected branch: ${type}`, () => {
    const { fields, api } = fixture(type);
    applyRules(api);
    for (const { id } of branches) {
      assert.equal(fields.get(id).visible, visibleIds.includes(id));
      assert.equal(fields.get(id).required, visibleIds.includes(id));
    }
  });
}

test('changing from account to role clears hidden IDs and preserves the selected role', () => {
  const role = { id: 'example-role-option', value: 'Team Member' };
  const { fields, api } = fixture('Role Access', {
    [config.accountId]: 'ACC-123', [config.siteId]: 'SITE-45', [config.role]: role,
    [config.platform]: { id: 'example-platform-option', value: 'AWS' }
  });
  applyRules(api);
  assert.equal(fields.get(config.accountId).value, '');
  assert.equal(fields.get(config.siteId).value, '');
  assert.equal(fields.get(config.platform).value, null);
  assert.equal(fields.get(config.role).value, role);
});

test('missing controller preserves the native layout', () => {
  assert.equal(applyRules({ getFieldById: () => undefined }), undefined);
});

test('unrelated changes do not reset entered data', () => {
  const handlers = {};
  registerRules({ onInit: callback => handlers.init = callback,
    onChange: (callback, register) => { handlers.change = callback; handlers.register = register; },
    onError() {} });
  const change = { current: { getId: () => 'summary' } };
  assert.deepEqual(handlers.register({ change }), []);
  handlers.change({ change, api: { getFieldById() { throw new Error('Must not touch fields'); } } });
});
