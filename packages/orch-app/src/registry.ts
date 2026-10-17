import { createRegistry } from '@wadeck-app/dsl-renderer';
import { allEntries } from './generated/entries.js';
import { applyRegistryOverrides } from '@wadeck-app/orch-ui';

export const appRegistry = createRegistry(allEntries);
applyRegistryOverrides(appRegistry);
