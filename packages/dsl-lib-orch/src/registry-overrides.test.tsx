/**
 * The overrides bridge DSL `$outputs` to component callback props. The invariant under test is that
 * they inject a callback ONLY for an event the YAML node declares.
 *
 * Every component these overrides touch treats "the callback prop is defined" as "the page owns this
 * action" and skips its own implementation. So injecting an undeclared event does not add a
 * behaviour, it removes one: the click publishes into an output namespace no brain reads and nothing
 * at all happens, with no confirmation and no error. Bulk Delete in the dashboard shipped that way.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';

import type { ComponentRegistry, ComponentRegistryEntry, RegistryRenderProps } from '@wadeck-app/dsl-renderer';
import { applyRegistryOverrides } from './registry-overrides.js';

/** A registry entry that records the node it was rendered with instead of rendering anything. */
function spyEntry(name: string): { entry: ComponentRegistryEntry; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const entry: ComponentRegistryEntry = {
    name,
    category: 'composite',
    tags: [],
    render: ({ node }: RegistryRenderProps) => {
      seen.push(node);
      return null;
    },
  };
  return { entry, seen };
}

function renderWith(
  name: string,
  node: Record<string, unknown>,
): { props: Record<string, unknown>; published: { id: string; event: string; payload: unknown }[] } {
  const { entry, seen } = spyEntry(name);
  const registry: ComponentRegistry = { [name]: entry };
  applyRegistryOverrides(registry);

  const published: { id: string; event: string; payload: unknown }[] = [];
  registry[name]!.render({
    node,
    registry,
    ctx: {
      $publishOutput: (id: string, event: string, payload?: unknown) => {
        published.push({ id, event, payload });
      },
    },
  });

  expect(seen).toHaveLength(1);
  return { props: seen[0]!, published };
}

describe('applyRegistryOverrides injects only declared $outputs', () => {
  it('JobCardGrid: an undeclared bulk event is left undefined so the grid keeps its own handler', () => {
    const { props } = renderWith('JobCardGrid', {
      $type: 'JobCardGrid',
      $id: 'jobGrid',
      $outputs: { onAfterTrigger: ['_'], onToggle: ['id', 'action'], onJobClick: ['id'], onAddJob: ['_'] },
    });

    expect(typeof props['onAfterTrigger']).toBe('function');
    expect(typeof props['onToggle']).toBe('function');
    expect(props['onBulkDelete']).toBeUndefined();
    expect(props['onBulkEnable']).toBeUndefined();
    expect(props['onBulkDisable']).toBeUndefined();
    expect(props['onBulkTrigger']).toBeUndefined();
  });

  it('JobCardGrid: a declared bulk event is injected and publishes the selected ids', () => {
    const { props, published } = renderWith('JobCardGrid', {
      $type: 'JobCardGrid',
      $id: 'jobGrid',
      $outputs: { onBulkDelete: ['ids'] },
    });

    (props['onBulkDelete'] as (ids: string[]) => void)(['a', 'b']);
    expect(published).toEqual([{ id: 'jobGrid', event: 'onBulkDelete', payload: ['a', 'b'] }]);
  });

  // The grid posts the trigger itself so a refusal (a 200 body a brain cannot read) can be shown, and
  // only asks the page to reload. A page-owned onTrigger would take that back and hide the refusal.
  it('JobCardGrid: Run now is no longer page-owned, only the reload is', () => {
    const { props, published } = renderWith('JobCardGrid', {
      $type: 'JobCardGrid',
      $id: 'jobGrid',
      $outputs: { onTrigger: ['id'], onAfterTrigger: ['_'] },
    });

    expect(props['onTrigger']).toBeUndefined();
    (props['onAfterTrigger'] as () => void)();
    expect(published).toEqual([{ id: 'jobGrid', event: 'onAfterTrigger', payload: undefined }]);
  });

  it('the running-job detail variants publish onAfterTrigger and no longer onTrigger', () => {
    for (const name of ['RunningBannerDetail', 'RunningAlertDetail', 'RunningInlineDetail']) {
      const { props, published } = renderWith(name, {
        $type: name,
        $id: 'jobActions',
        $outputs: { onTrigger: ['_'], onAfterTrigger: ['_'] },
      });

      expect(props['onTrigger']).toBeUndefined();
      (props['onAfterTrigger'] as () => void)();
      expect(published).toEqual([{ id: 'jobActions', event: 'onAfterTrigger', payload: undefined }]);
    }
  });

  it('withOutputCallbacks entries filter the same way', () => {
    const { props } = renderWith('RunningBannerDetail', {
      $type: 'RunningBannerDetail',
      $id: 'jobActions',
      $outputs: { onKill: ['_'] },
    });

    expect(typeof props['onKill']).toBe('function');
    expect(props['onDelete']).toBeUndefined();
    expect(props['onDryRun']).toBeUndefined();
  });

  it('a node with no $outputs at all gets no callbacks', () => {
    const { props } = renderWith('JobDetailActions', {
      $type: 'JobDetailActions',
      $id: 'jobActions',
    });

    for (const name of ['onTrigger', 'onDelete', 'onDryRun', 'onViewLogs', 'onEdit', 'onKill']) {
      expect(props[name]).toBeUndefined();
    }
  });

  it('ScheduleTimeline filters its custom onAfterRunEarly too', () => {
    const undeclared = renderWith('ScheduleTimeline', { $type: 'ScheduleTimeline', $id: 'timeline' });
    expect(undeclared.props['onAfterRunEarly']).toBeUndefined();

    const declared = renderWith('ScheduleTimeline', {
      $type: 'ScheduleTimeline',
      $id: 'timeline',
      $outputs: { onRunEarly: ['jobId'], onAfterRunEarly: ['_'] },
    });
    // Run early is posted by the timeline itself, so the old page-owned event is gone.
    expect(declared.props['onRunEarly']).toBeUndefined();
    (declared.props['onAfterRunEarly'] as () => void)();
    expect(declared.published).toEqual([{ id: 'timeline', event: 'onAfterRunEarly', payload: undefined }]);
  });
});
