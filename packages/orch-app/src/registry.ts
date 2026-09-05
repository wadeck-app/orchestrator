import { createRegistry } from '@wadeck-app/dsl-renderer';
import { allEntries } from './generated/entries.js';

export const appRegistry = createRegistry(allEntries);
