/**
 * Registry overrides: patch auto-generated entries to wire ctx.$publishOutput
 * into component callback props when the YAML node declares $id and $outputs.
 *
 * This bridges the DSL $brains/$outputs system with orch-ui components without
 * requiring manual edits to the auto-generated entries.tsx.
 */
import type { ComponentRegistry, ComponentRegistryEntry, RegistryRenderProps } from '@wadeck-app/dsl-renderer';

type PublishFn = (id: string, event: string, payload?: unknown) => void;

/**
 * Wrap a render function to inject publishOutput callbacks for declared output events.
 * The wrapped render reads node['$id'] and ctx['$publishOutput'], then creates a
 * callback for each listed event name and merges them into the node props.
 */
function withOutputCallbacks(
  original: ComponentRegistryEntry['render'],
  outputNames: string[],
): ComponentRegistryEntry['render'] {
  return (props: RegistryRenderProps) => {
    const { node, ctx } = props;
    const id = node['$id'] as string | undefined;
    const pub = ctx['$publishOutput'] as PublishFn | undefined;

    if (!id || !pub) return original(props);

    const callbacks: Record<string, (payload?: unknown) => void> = {};
    for (const name of outputNames) {
      const eventName = name;
      callbacks[name] = (payload?: unknown) => pub(id, eventName, payload);
    }

    return original({ ...props, node: { ...node, ...callbacks } });
  };
}

/**
 * Apply all $outputs wiring overrides to the app registry.
 * Called once after createRegistry() in registry.ts.
 */
export function applyRegistryOverrides(registry: ComponentRegistry): void {
  // JobDetailActions: expose onTrigger + onDelete as DSL $outputs
  const jda = registry['JobDetailActions'];
  if (jda) {
    jda.render = withOutputCallbacks(jda.render, ['onTrigger', 'onDelete']);
  }

  // JobToggle: expose onToggle as DSL $output
  const jt = registry['JobToggle'];
  if (jt) {
    jt.render = withOutputCallbacks(jt.render, ['onToggle']);
  }

  // JobSearchBar: expose onChange as DSL $output (wires $vars.search updates)
  const jsb = registry['JobSearchBar'];
  if (jsb) {
    jsb.render = withOutputCallbacks(jsb.render, ['onChange']);
  }

  // JobFilterChips: expose onChange as DSL $output (wires $vars.filter updates)
  const jfc = registry['JobFilterChips'];
  if (jfc) {
    jfc.render = withOutputCallbacks(jfc.render, ['onChange']);
  }
}
