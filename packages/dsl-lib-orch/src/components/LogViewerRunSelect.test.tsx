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

const RUNNING = [{ startedAt: '2026-09-19T09:30:00Z', exitCode: null, pid: 1 }];
const FINISHED = [{ startedAt: '2026-09-19T09:30:00Z', finishedAt: '2026-09-19T09:31:00Z', exitCode: 0, pid: 1 }];

// The run list is internal state fetched from the API, not a prop, so the fetch is what seeds it.
// `history` answers the job-status poll; left out, that poll never says whether the job is running.
function stubFetch(runs: typeof RUNS, history?: Array<Record<string, unknown>>): void {
	vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
		ok: true,
		json: () => Promise.resolve(url.includes('/runs') ? runs : { job: {}, ...(history ? { runHistory: history } : {}) }),
	})));
}

beforeEach(() => {
	vi.stubGlobal('EventSource', class {
		onmessage: ((e: MessageEvent) => void) | null = null;
		onerror: (() => void) | null = null;
		close(): void {}
		addEventListener(): void {}
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
	it('offers the live tail as the empty value, called Live while the job is running', async () => {
		stubFetch(RUNS, RUNNING);
		await renderViewer();
		await waitFor(() => expect(screen.getAllByRole('option')[0]!.textContent).toMatch(/Live/));
		expect(screen.getAllByRole('option')[0]!).toHaveValue('');
	});

	// "Live" names output that is arriving. On a job that stopped, the newest run is still the tail the
	// reader lands on, but calling it Live says something untrue -- the same false signal the status
	// chip beside it was fixed for.
	it('does not call the tail Live once the job has stopped', async () => {
		stubFetch(RUNS, FINISHED);
		await renderViewer();

		await waitFor(() => expect(screen.getAllByRole('option')[0]!.textContent).toMatch(/Latest/));
		const tail = screen.getAllByRole('option')[0]!;
		expect(tail).toHaveValue('');
		expect(tail.textContent).not.toMatch(/Live/);
	});

	// Before the first status response, "not known yet" is not "running".
	it('does not call the tail Live before the job status is known', async () => {
		stubFetch(RUNS);
		await renderViewer();

		const tail = screen.getAllByRole('option')[0]!;
		expect(tail).toHaveValue('');
		expect(tail.textContent).not.toMatch(/Live/);
	});

	it('names the newest run on the tail option either way', async () => {
		stubFetch(RUNS, FINISHED);
		await renderViewer();

		await waitFor(() => expect(screen.getAllByRole('option')[0]!.textContent).toMatch(/Latest/));
		expect(screen.getAllByRole('option')[0]!.textContent).toContain(RUNS[0]!.name);
	});

	// The tail option already names the newest run ("Live - <newest run>"), so listing that run again
	// showed the same run twice in the dropdown, once as "follow" and once as "pin", with nothing telling
	// the two apart. The newest run is the tail option; the list below it holds the older ones.
	it('lists each run once: the newest is the tail option, not repeated below it', async () => {
		stubFetch(RUNS, RUNNING);
		await renderViewer();
		await waitFor(() => expect(screen.getAllByRole('option')[0]!.textContent).toMatch(/Live/));

		const options = screen.getAllByRole('option');
		expect(options).toHaveLength(RUNS.length);
		expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['', RUNS[1]!.name]);
	});

	it('selecting an older run pins it', async () => {
		const select = await renderViewer();

		fireEvent.change(select, { target: { value: RUNS[1]!.name } });

		expect(select).toHaveValue(RUNS[1]!.name);
	});

	it('selecting the empty value returns to the live tail', async () => {
		const select = await renderViewer();

		fireEvent.change(select, { target: { value: RUNS[1]!.name } });
		fireEvent.change(select, { target: { value: '' } });

		expect(select).toHaveValue('');
	});

	// A link or a bookmark can pin the newest run (?run=<newest>). It has no option of its own any more, so
	// the selector shows the tail option, which is that same run, rather than going blank.
	it('shows the tail option for a pin on the newest run', async () => {
		render(
			<MemoryRouter initialEntries={[`/?run=${encodeURIComponent(RUNS[0]!.name)}`]}>
				<LogViewer jobId="j1" />
			</MemoryRouter>,
		);
		const select = await waitFor(() => screen.getByLabelText('Which run to show'));

		await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(RUNS.length));
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
