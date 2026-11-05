import { uiModificationsApi } from '@forge/jira-bridge';
import { registerRules } from './rules.mjs';

// This resource runs invisibly inside Jira's existing global Create window.
registerRules(uiModificationsApi);
