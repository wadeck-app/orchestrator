import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LogViewer } from './LogViewer.js';

/*
 * The run selector was a raw <select> carrying a suppression that said the terminal palette was
 * incompatible with the design system. It was not: RUN_SELECT_CLS used semantic tokens all along
 * (bg-muted-bg, border-border, text-content) and the pane is already wrapped in a ThemeScope, so
 * tokens resolve correctly inside it. What was actually missing was a compact label-less select --
 * PageSizeSelect is locked to pagination and FieldSelect renders a visible label. dsl-ui has
 * CompactSelect now.
 *
 * These pin the selector's behaviour, which had no coverage at all: the empty value is what keeps the
 * stream on the live tail, so a control that lost it would strand the reader on a pinned run.
 */

const RUNS = [
	{ name: 'run-2026-09-19T09-30-00.log', size: 120 },
	{ name: 'run-2026-09-18T19-05-00.log', size: 90 },
];

// The run list is internal state fetched from the API, not a prop, so the fetch is what seeds it.
function stubFetch(runs: typeof RUNS): void {
	vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(runs) })));
}

beforeEach(() => {
	vi.stubGlobal('EventSource', class {
		onmessage: ((e: MessageEvent) => void) | null = null;
		onerror: (() => void) | null = null;
		close(): void {}
	});
	stubFetch(RUNS);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

/** Renders and waits for the fetched run list to arrive, which is what reveals the selector. */
async function renderViewer(): Promise<HTMLElement> {
	render(
		<MemoryRouter>
			<LogViewer jobId="j1" />
		</MemoryRouter>,
	);
	return waitFor(() => screen.getByLabelText('Which run to show'));
}

describe('the log run selector', () => {
	it('is named, though it has no visible label', async () => {
		await renderViewer();
		expect(screen.getByLabelText('Which run to show')).toBeInTheDocument();
	});

	// The way back to the live tail. Pinning without one is a trap: the reader leaves the tail and
	// cannot return without editing the URL.
	it('offers the live tail as the empty value', async () => {
		await renderViewer();
		const live = screen.getAllByRole('option')[0]!;
		expect(live).toHaveValue('');
		expect(live.textContent).toMatch(/Live/);
	});

	it('lists every run', async () => {
		await renderViewer();
		// One per run, plus the live option.
		expect(screen.getAllByRole('option')).toHaveLength(RUNS.length + 1);
	});

	it('selecting a run pins it', async () => {
		const select = await renderViewer();

		fireEvent.change(select, { target: { value: RUNS[0]!.name } });

		expect(select).toHaveValue(RUNS[0]!.name);
	});

	it('selecting the empty value returns to the live tail', async () => {
		const select = await renderViewer();

		fireEvent.change(select, { target: { value: RUNS[0]!.name } });
		fireEvent.change(select, { target: { value: '' } });

		expect(select).toHaveValue('');
	});

	it('no runs, no selector', async () => {
		stubFetch([]);
		render(
			<MemoryRouter>
				<LogViewer jobId="j1" />
			</MemoryRouter>,
		);
		// Waited on, so this cannot pass merely by asserting before the fetch resolves.
		await waitFor(() => expect(screen.getByText(/lines|Connecting/)).toBeInTheDocument());
		expect(screen.queryByLabelText('Which run to show')).toBeNull();
	});
});
