// Use the existing fields from the customized Create form. Do not create a
// second set of fields or change which fields are required in Jira's UI.
export const REQUEST_FIELDS = Object.freeze({
  accessType: 'customfield_10052', accountId: 'customfield_10053',
  siteId: 'customfield_10054', role: 'customfield_10055',
  platform: 'customfield_10056', category: 'customfield_10058',
  component: 'customfield_10059'
});

export const REQUEST_MESSAGES = Object.freeze({
  SUMMARY_REQUIRED: 'Enter a Summary for this access request.',
  CATEGORY_REQUIRED: 'Select a Category for this access request.',
  COMPONENT_REQUIRED: 'Select a Component for this access request.',
  ACCESS_TYPE_REQUIRED: 'Select Account Access, Role Access, or Platform Access.',
  ACCESS_TYPE_INVALID: 'The selected Access Type is not supported. Select Account Access, Role Access, or Platform Access.',
  ACCOUNT_ID_REQUIRED: 'Enter the Account ID required for Account Access.',
  ACCOUNT_ID_INVALID: 'Enter Account ID as a single line of text.',
  SITE_ID_REQUIRED: 'Enter the Site ID required for Account Access.',
  SITE_ID_INVALID: 'Enter Site ID as a single line of text.',
  ROLE_REQUIRED: 'Select a Role: Team Member, Super User, or Read Only.',
  ROLE_INVALID: 'The selected Role is not supported. Select Team Member, Super User, or Read Only.',
  PLATFORM_REQUIRED: 'Select a Platform: EC2, AWS, or Snowflake.',
  PLATFORM_INVALID: 'The selected Platform is not supported. Select EC2, AWS, or Snowflake.'
});

function option(value) {
  // Jira single-select custom fields return an option object, not an array.
  return value && !Array.isArray(value) && typeof value.value === 'string'
    ? value.value.trim() : '';
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// Phase 2 checks the submitted details. It does not check vendor accounts or
// grant access: its final action is approval acknowledgement and Jira Done.
export function validateRequest(issue) {
  const fields = issue?.fields ?? {}, errorCodes = [];
  if (typeof fields.summary !== 'string' || !fields.summary.trim()) errorCodes.push('SUMMARY_REQUIRED');
  if (!option(fields[REQUEST_FIELDS.category])) errorCodes.push('CATEGORY_REQUIRED');
  if (!option(fields[REQUEST_FIELDS.component])) errorCodes.push('COMPONENT_REQUIRED');
  const type = option(fields[REQUEST_FIELDS.accessType]);

  function requireText(field, prefix) {
    const value = fields[field];
    if (value == null || typeof value === 'string' && !value.trim()) {
      errorCodes.push(`${prefix}_REQUIRED`);
    } else if (typeof value !== 'string' || hasControlCharacters(value)) {
      errorCodes.push(`${prefix}_INVALID`);
    }
  }

  function requireOption(field, allowed, prefix) {
    const value = option(fields[field]);
    if (!value) errorCodes.push(`${prefix}_REQUIRED`);
    else if (!allowed.includes(value)) errorCodes.push(`${prefix}_INVALID`);
  }

  // Fields hidden for another access type are deliberately not inspected.
  // Changing Access Type must not make an irrelevant old value a requirement.
  if (type === 'Account Access') {
    requireText(REQUEST_FIELDS.accountId, 'ACCOUNT_ID');
    requireText(REQUEST_FIELDS.siteId, 'SITE_ID');
  } else if (type === 'Role Access') {
    requireOption(REQUEST_FIELDS.role, ['Team Member', 'Super User', 'Read Only'], 'ROLE');
  } else if (type === 'Platform Access') {
    requireOption(REQUEST_FIELDS.platform, ['EC2', 'AWS', 'Snowflake'], 'PLATFORM');
  } else errorCodes.push(type ? 'ACCESS_TYPE_INVALID' : 'ACCESS_TYPE_REQUIRED');

  return {
    valid: errorCodes.length === 0,
    code: errorCodes.length ? 'REQUEST_FIELDS_INVALID' : 'REQUIRED_FIELDS_VALID',
    errorCodes
  };
}

// Use fixed English messages instead of echoing account IDs or arbitrary field
// contents into a comment. Missing/malformed validation results fail closed.
export function validationParagraphs(validation) {
  if (validation?.valid === true && validation.code === 'REQUIRED_FIELDS_VALID' &&
      Array.isArray(validation.errorCodes) && validation.errorCodes.length === 0) {
    return ['The selected approver approved this request, and the required details passed the checks.'];
  }
  if (validation?.valid === false && validation.code === 'REQUEST_FIELDS_INVALID' &&
      Array.isArray(validation.errorCodes) && validation.errorCodes.length > 0 &&
      validation.errorCodes.every(code => Object.hasOwn(REQUEST_MESSAGES, code))) {
    return [
      'The selected approver approved this request, but it could not be completed because some required details are missing or incorrect.',
      ...validation.errorCodes.map(code => REQUEST_MESSAGES[code]),
      'Correct the details, then ask the selected Approver to add a new Grant access comment. The bot has not moved this ticket to Done.'
    ];
  }
  return ['The required request details could not be checked. An administrator needs to review this request. ' +
    'The bot has not moved this ticket to Done.'];
}
