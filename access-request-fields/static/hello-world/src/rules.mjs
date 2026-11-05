import { branches, config, registeredFields } from '../../../src/config.mjs';

export function applyRules(api) {
  const controller = api.getFieldById(config.accessType);
  // If Jira cannot provide the controller, preserve the native form layout.
  if (!controller) return;
  const accessType = controller.getValue()?.value ?? '';
  for (const branch of branches) {
    const field = api.getFieldById(branch.id);
    if (!field) continue;
    const active = accessType === branch.type;
    // Branch fields are optional in Jira's base configuration. Require only
    // the branch selected in the current Create window.
    field.setRequired(active);
    field.setVisible(active);
    if (!active) {
      // Jira submits hidden values too. Clear stale values when switching type.
      const value = field.getValue();
      if (value !== null && value !== undefined && value !== '') field.setValue(branch.empty);
    }
  }
}

export function registerRules(uim) {
  uim.onInit(({ api }) => applyRules(api), () => registeredFields);
  uim.onChange(
    ({ api, change }) => {
      if (change.current.getId() === config.accessType) applyRules(api);
    },
    ({ change }) => change.current.getId() === config.accessType ? registeredFields : []
  );
  // Metadata only: account IDs, site IDs and field values stay out of logs.
  uim.onError(({ errors = [] }) => {
    console.error('Access Request field rules could not be applied.',
      errors.map(({ type, fieldId, method }) => ({ type, fieldId, method })));
  });
}
