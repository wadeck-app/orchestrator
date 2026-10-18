/**
 * Registry overrides: patch auto-generated entries to wire ctx.$publishOutput
 * into component callback props when the YAML node declares $id and $outputs.
 *
 * This bridges the DSL $brains/$outputs system with dsl-lib-orch components without
 * requiring manual edits to the auto-generated entries.tsx.
 */
import type { ComponentRegistry, ComponentRegistryEntry, RegistryRenderProps } from '@wadeck-app/dsl-renderer';

type PublishFn = (id: string, event: string, payload?: unknown) => void;

/**
 * The event names the YAML node itself declares under `$outputs`.
 *
 * Injecting a callback the page did not declare is worse than injecting none. Every one of these
 * components treats "the prop is defined" as "the page owns this action" and skips its own
 * implementation -- so an undeclared event publishes into a namespace no brain reads and the click
 * does nothing at all, with no confirmation and no error. That is exactly how bulk Delete in the
 * dashboard became a silent no-op: `job-list.yaml` declares four outputs and the override injected
 * eight. Filtering on the declaration hands the undeclared ones back to the component.
 */
function declaredOutputs(node: Record<string, unknown>): Set<string> {
  const declared = node['$outputs'];
  if (declared === null || typeof declared !== 'object') {
    return new Set();
  }
  return new Set(Object.keys(declared));
}

/** Drop every entry of `extra` the node does not declare as an `$output`. See declaredOutputs. */
function keepDeclared(extra: Record<string, unknown>, node: Record<string, unknown>): Record<string, unknown> {
  const declared = declaredOutputs(node);
  const kept: Record<string, unknown> = {};
  for (const [name, callback] of Object.entries(extra)) {
    if (declared.has(name)) {
      kept[name] = callback;
    }
  }
  return kept;
}

/**
 * Wrap a render function to inject publishOutput callbacks for declared output events.
 * The wrapped render reads node['$id'] and ctx['$publishOutput'], then creates a
 * callback for each listed event name the node declares and merges them into the node props.
 */
function withOutputCallbacks(
  original: ComponentRegistryEntry['render'],
  outputNames: string[],
): ComponentRegistryEntry['render'] {
  return (props: RegistryRenderProps) => {
    const { node, ctx } = props;
    const id = node['$id'] as string | undefined;
    const pub = ctx['$publishOutput'] as PublishFn | undefined;

    if (!id || !pub) {
      return original(props);
    }

    const callbacks: Record<string, (payload?: unknown) => void> = {};
    for (const name of outputNames) {
      const eventName = name;
      callbacks[name] = (payload?: unknown) => pub(id, eventName, payload);
    }

    return original({ ...props, node: { ...node, ...keepDeclared(callbacks, node) } });
  };
}

/**
 * Apply all $outputs wiring overrides to the app registry.
 * Called once after createRegistry() in registry.ts.
 */
export function applyRegistryOverrides(registry: ComponentRegistry): void {
  // JobDetailActions: all action callbacks as DSL $outputs
  const jda = registry['JobDetailActions'];
  if (jda) {
    jda.render = withOutputCallbacks(jda.render, ['onTrigger', 'onDelete', 'onDryRun', 'onViewLogs', 'onEdit', 'onKill']);
  }

  // JobToggle: expose onToggle as DSL $output
  const jt = registry['JobToggle'];
  if (jt) {
    jt.render = withOutputCallbacks(jt.render, ['onToggle']);
  }

  // JobCardGrid: custom overrides -- onToggle publishes {id, action} object,
  // onJobClick publishes the job ID string, onAddJob and onAfterTrigger publish nothing.
  // Run now is not an output: the grid posts it itself, because a brain cannot see the 200 body that
  // says the job was already running. It only signals when it has settled, so the page can reload.
  const jcg = registry['JobCardGrid'];
  if (jcg) {
    const originalJcg = jcg.render;
    jcg.render = (props) => {
      const { node, ctx } = props;
      const id = node['$id'] as string | undefined;
      const pub = ctx['$publishOutput'] as PublishFn | undefined;
      if (!id || !pub) {
        return originalJcg(props);
      }
      const extra = {
        onAfterTrigger: () => pub(id, 'onAfterTrigger', undefined),
        onToggle: (jobId: string, enabled: boolean) => pub(id, 'onToggle', { id: jobId, action: enabled ? 'enable' : 'disable' }),
        onJobClick: (jobId: string) => pub(id, 'onJobClick', jobId),
        onAddJob: () => pub(id, 'onAddJob', undefined),
        onBulkEnable: (ids: string[]) => pub(id, 'onBulkEnable', ids),
        onBulkDisable: (ids: string[]) => pub(id, 'onBulkDisable', ids),
        onBulkTrigger: (ids: string[]) => pub(id, 'onBulkTrigger', ids),
        onBulkDelete: (ids: string[]) => pub(id, 'onBulkDelete', ids),
        onAfterBulk: () => pub(id, 'onAfterBulk', undefined),
      };
      return originalJcg({ ...props, node: { ...node, ...keepDeclared(extra, node) } });
    };
  }

  // Design variants for running job detail. Run now posts itself (see JobCardGrid above) and only
  // signals onAfterTrigger.
  const outputs = ['onAfterTrigger', 'onDelete', 'onDryRun', 'onViewLogs', 'onEdit', 'onKill'];
  for (const name of ['RunningBannerDetail', 'RunningAlertDetail', 'RunningInlineDetail']) {
    const entry = registry[name];
    if (entry) {
      entry.render = withOutputCallbacks(entry.render, outputs);
    }
  }

  // JobFormSection: form lifecycle as DSL $outputs
  const jfs = registry['JobFormSection'];
  if (jfs) {
    jfs.render = withOutputCallbacks(jfs.render, ['onSubmit', 'onSuccess', 'onCancel']);
  }

  // SearchBar: expose onChange as DSL $output (wires $vars.search updates).
  // dsl-ui's component, replacing a hand-rolled JobSearchBar that wrapped a raw input.
  const jsb = registry['SearchBar'];
  if (jsb) {
    jsb.render = withOutputCallbacks(jsb.render, ['onChange']);
  }

  // JobFilterChips: expose onChange as DSL $output (wires $vars.filter updates)
  const jfc = registry['JobFilterChips'];
  if (jfc) {
    jfc.render = withOutputCallbacks(jfc.render, ['onChange']);
  }

  // ScheduleTimeline: expose onAfterRunEarly as DSL $output. Run early posts itself, for the same
  // reason as Run now: a refusal is a 200 body the brain cannot read.
  const st = registry['ScheduleTimeline'];
  if (st) {
    const originalSt = st.render;
    st.render = (props) => {
      const { node, ctx } = props;
      const id = node['$id'] as string | undefined;
      const pub = ctx['$publishOutput'] as PublishFn | undefined;
      if (!id || !pub) {
        return originalSt(props);
      }
      const extra = {
        onAfterRunEarly: () => pub(id, 'onAfterRunEarly', undefined),
      };
      return originalSt({ ...props, node: { ...node, ...keepDeclared(extra, node) } });
    };
  }
}
