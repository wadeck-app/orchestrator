import { createRegistry } from '@wadeck-app/dsl-renderer';
import { allEntries } from './generated/entries.js';
import { applyRegistryOverrides } from './registry-overrides.js';

export const appRegistry = createRegistry(allEntries);
applyRegistryOverrides(appRegistry);
