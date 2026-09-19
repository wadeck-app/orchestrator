import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useConfirm } from './use-confirm.js';

// violations-suppress-start: react/no-raw-button test-harness triggers, not UI - a design-system Button here would test dsl-ui's rendering rather than the hook

/*
 * Five destructive actions -- killing a running job in three places, and deleting jobs in bulk -- asked
 * for confirmation through the browser's native confirm(). It blocks the whole page, cannot be styled,
 * looks nothing like the dashboard, and on a kill dialog the stakes are exactly when the reader should
 * be able to tell they are still in the app they think they are in.
 *
 * dsl-ui has ConfirmDialog, but it is controlled: each call site would otherwise grow its own `open`
 * state, a dialog element and a pending-action ref. This hook is that boilerplate once.
 */

function Harness({ onConfirm, title = 'Kill this process?' }: { onConfirm: () => void; title?: string }) {
	const { ask, dialog } = useConfirm();
	return (
		<div>
			<button type="button" onClick={() => ask({ title, message: 'This cannot be undone.', onConfirm })}>
				Kill
			</button>
			{dialog}
		</div>
	);
}

describe('useConfirm', () => {
	it('asks nothing until the action is requested', () => {
		render(<Harness onConfirm={() => {}} />);
		expect(screen.queryByText('Kill this process?')).toBeNull();
	});

	it('shows the title and message when asked', () => {
		render(<Harness onConfirm={() => {}} />);
		fireEvent.click(screen.getByRole('button', { name: 'Kill' }));

		expect(screen.getByText('Kill this process?')).toBeInTheDocument();
		expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
	});

	it('does not run the action merely by asking', () => {
		const onConfirm = vi.fn();
		render(<Harness onConfirm={onConfirm} />);
		fireEvent.click(screen.getByRole('button', { name: 'Kill' }));

		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('runs the action once confirmed', () => {
		const onConfirm = vi.fn();
		render(<Harness onConfirm={onConfirm} />);
		fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('does not run it when cancelled', () => {
		const onConfirm = vi.fn();
		render(<Harness onConfirm={onConfirm} />);
		fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('closes after confirming, so the dialog cannot be confirmed twice', () => {
		const onConfirm = vi.fn();
		render(<Harness onConfirm={onConfirm} />);
		fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	/*
	 * The second ask must replace the first, not run it. A stale action surviving behind a new dialog is
	 * how a reader confirms "delete 3 jobs" and gets a kill, which is the one outcome a confirmation
	 * exists to prevent.
	 */
	it('a second ask replaces the first action', () => {
		const first = vi.fn();
		const second = vi.fn();
		function TwoActions() {
			const { ask, dialog } = useConfirm();
			return (
				<div>
					<button type="button" onClick={() => ask({ title: 'First', message: 'm', onConfirm: first })}>A</button>
					<button type="button" onClick={() => ask({ title: 'Second', message: 'm', onConfirm: second })}>B</button>
					{dialog}
				</div>
			);
		}
		render(<TwoActions />);

		fireEvent.click(screen.getByRole('button', { name: 'A' }));
		fireEvent.click(screen.getByRole('button', { name: 'B' }));
		expect(screen.getByText('Second')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		expect(second).toHaveBeenCalledTimes(1);
		expect(first).not.toHaveBeenCalled();
	});

	it('takes a custom confirm label', () => {
		function Custom() {
			const { ask, dialog } = useConfirm();
			return (
				<div>
					<button type="button" onClick={() => ask({ title: 't', message: 'm', confirmLabel: 'Delete', onConfirm: () => {} })}>Go</button>
					{dialog}
				</div>
			);
		}
		render(<Custom />);
		fireEvent.click(screen.getByRole('button', { name: 'Go' }));

		expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
	});
});

// violations-suppress-end: react/no-raw-button
