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
      $outputs: { onTrigger: ['id'], onToggle: ['id', 'action'], onJobClick: ['id'], onAddJob: ['_'] },
    });

    expect(typeof props['onTrigger']).toBe('function');
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

  it('ScheduleTimeline filters its custom onRunEarly too', () => {
    const undeclared = renderWith('ScheduleTimeline', { $type: 'ScheduleTimeline', $id: 'timeline' });
    expect(undeclared.props['onRunEarly']).toBeUndefined();

    const declared = renderWith('ScheduleTimeline', {
      $type: 'ScheduleTimeline',
      $id: 'timeline',
      $outputs: { onRunEarly: ['jobId'] },
    });
    (declared.props['onRunEarly'] as (jobId: string) => void)('nightly');
    expect(declared.published).toEqual([{ id: 'timeline', event: 'onRunEarly', payload: { jobId: 'nightly' } }]);
  });
});
