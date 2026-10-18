/**
 * dsl-ui built-ins the library re-exports under the module's id, because orch-ui's registry overrides wire their
 * events to the pages and the app-core shell's own copy is not wired. Today that is
 * SearchBar: without it, typing in the jobs page would publish nothing and the list would never filter.
 */
export const LIB_EXTRA_TYPES: readonly string[] = ['SearchBar'];

const ORCH_UI_IMPORT = /from\s+'[^']*orch-ui\/src\/components\/(\w+)\.js'/g;

/**
 * The component types that come from orch-ui, read off the library's generated entries rather than
 * kept as a second list that would go stale the day a component is added.
 */
export function readOrchUiTypes(entriesSource: string): Set<string> {
  const names = new Set<string>();
  for (const match of entriesSource.matchAll(ORCH_UI_IMPORT)) {
    names.add(match[1]!);
  }
  if (names.size === 0) {
    throw new Error('readOrchUiTypes: found no import from orch-ui/src/components in the generated entries; the file moved or its format changed, and shipping nothing would break every page.');
  }
  return names;
}

/** Every type the bundle exports and every page prefixes: orch-ui's components plus the wired built-ins. Sorted, unique. */
export function listLibTypes(entriesSource: string): string[] {
  return [...new Set([...readOrchUiTypes(entriesSource), ...LIB_EXTRA_TYPES])].sort();
}
