// Only tickets with this exact label opt in to automatic processing.
export const AUTOMATION_LABEL = 'access-automation';

// Missing or unreadable Labels must not enable automation.
// This checks opt-in only; approver and request validation remain separate.
export function hasAutomationLabel(issue) {
  const labels = issue?.fields?.labels;

  return Array.isArray(labels) &&
    labels.includes(AUTOMATION_LABEL);
}