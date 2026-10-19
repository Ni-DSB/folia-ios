// src/components/modal/settings/pages/integration/customSourceOptions.ts
// The groups and options of the 自定义音源 section, declared apart from the rows that draw them
// so the settings search can list them without mounting the page.

import { option, type SettingsGroupDef } from '../../kit';

// src/components/modal/settings/pages/integration/customSourceOptions.ts

/** The group: installed scripts, and the way to add one. */
export const CUSTOM_SOURCE: SettingsGroupDef = {
    id: 'customSources',
    titleKey: 'options.settingsHeadingCustomSources',
    // Scripts run in the main process; the web build has no bridge to install them through.
    electronOnly: true,
};

export const CUSTOM_SOURCE_OPTIONS = {
    installed: option(CUSTOM_SOURCE, 'customSourceInstalled', 'options.customSourceInstalled'),
    add: option(CUSTOM_SOURCE, 'customSourceAdd', 'options.customSourceAdd'),
    reload: option(CUSTOM_SOURCE, 'customSourceReload', 'options.customSourceReload'),
    // The line that says what installing one means before the first is added.
    warning: option(CUSTOM_SOURCE, 'customSourceWarning', 'options.customSourceWarning'),
} as const;
