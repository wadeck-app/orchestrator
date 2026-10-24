import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobCard } from './JobCard.js';
import type { Job } from '../types.js';

// The colour of a tag pill is a pure function of its name: the same tag has the same colour on every card and after
// every reload, and the background and the text always come from the same palette slot. (The contrast of the palette
// itself is test/tag-colors.test.ts.)
const BASE: Job = { id: 'j1', type: 'cron', label: 'Job A', command: 'node a.js', enabled: true, triggerMode: 'fire-and-forget', schedule: '0 10 * * *' };

function renderCard(tags: string[] | undefined, id = 'j1') {
  return render(
    <MemoryRouter>
      <JobCard job={{ ...BASE, id, label: `Job ${id}`, tags }} runHistory={[]} onTrigger={vi.fn()} onToggle={vi.fn()} />
    </MemoryRouter>,
  );
}

/** The palette slot (1..6) of the pill showing `tag`, read from its bg and text classes; fails if they disagree. */
function slotOf(tag: string, scope: HTMLElement = document.body): number {
  const pill = Array.from(scope.querySelectorAll('span')).find(s => s.textContent === tag && /bg-tag-\d-bg/.test(s.className));
  if (!pill) {
    throw new Error(`No pill for tag "${tag}" found`);
  }
  const bg = /bg-tag-(\d)-bg/.exec(pill.className);
  const text = /(?:^|\s)text-tag-(\d)(?:\s|$)/.exec(pill.className);
  expect(text, `text colour of "${tag}": ${pill.className}`).not.toBeNull();
  expect(bg![1], `bg and text of "${tag}" come from the same slot`).toBe(text![1]);
  return Number(bg![1]);
}

describe('tag colours on a job card', () => {
  it('gives the same tag the same colour on two different cards', () => {
    const first = renderCard(['deploy', 'db'], 'one');
    const a = [slotOf('deploy', first.container), slotOf('db', first.container)];
    first.unmount();

    const second = renderCard(['db', 'deploy', 'extra'], 'two');
    expect([slotOf('deploy', second.container), slotOf('db', second.container)]).toEqual(a);
  });

  it('does not depend on the position of the tag or on the other tags', () => {
    const alone = renderCard(['nightly']);
    const slot = slotOf('nightly', alone.container);
    alone.unmount();

    const crowded = renderCard(['x', 'y', 'z', 'nightly']);
    expect(slotOf('nightly', crowded.container)).toBe(slot);
  });

  // Golden values: they are what users have seen so far, a change of the hash would recolour every tag.
  it.each([
    ['a', 2],
    ['b', 3],
    ['f', 1],
    ['ab', 4],
  ])('tag "%s" is drawn with palette slot %i', (tag, slot) => {
    const { container } = renderCard([tag]);
    expect(slotOf(tag, container)).toBe(slot);
  });

  it('spreads six consecutive names over the six slots', () => {
    const { container } = renderCard(['a', 'b', 'c', 'd', 'e', 'f']);
    const slots = ['a', 'b', 'c', 'd', 'e', 'f'].map(t => slotOf(t, container));
    expect([...slots].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is case sensitive: "Prod" and "prod" are two tags', () => {
    const { container } = renderCard(['Prod', 'prod']);
    // 'P' = 80 and 'p' = 112 differ by 32, so the first letter alone moves the hash by 32 * 31^3, not a multiple of 6
    expect(slotOf('Prod', container)).not.toBe(slotOf('prod', container));
  });

  it.each([
    ['a very long name', 'x'.repeat(500)],
    ['an emoji', '\u{1F680} launch'],
    ['accents', '\u00e9t\u00e9'],
    ['a space only', ' '],
  ])('always yields a real palette slot for %s', (_what, tag) => {
    const { container } = renderCard([tag]);
    const pill = Array.from(container.querySelectorAll('span')).find(s => s.textContent === tag)!;
    expect(pill.className).not.toContain('undefined');
    expect(slotOf(tag, container)).toBeGreaterThanOrEqual(1);
    expect(slotOf(tag, container)).toBeLessThanOrEqual(6);
  });

  it('draws one pill per tag and none for a job without tags', () => {
    const { container } = renderCard(['one', 'two']);
    expect(Array.from(container.querySelectorAll('span')).filter(s => /bg-tag-\d-bg/.test(s.className)).map(s => s.textContent)).toEqual(['one', 'two']);
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();

    const none = renderCard(undefined, 'untagged');
    expect(Array.from(none.container.querySelectorAll('span')).filter(s => /bg-tag-\d-bg/.test(s.className))).toHaveLength(0);
  });
});
