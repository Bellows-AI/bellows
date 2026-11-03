import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StateNote } from '../src/components/StateNote.js';

describe('StateNote', () => {
    afterEach(cleanup);

    it('announces loading as a polite status', () => {
        render(<StateNote state="loading">Loading tasks…</StateNote>);
        expect(screen.getByRole('status').textContent).toBe('Loading tasks…');
    });

    it('announces an error as an alert carrying the message, never as an empty list', () => {
        render(<StateNote state="error">Tasks could not be read.</StateNote>);
        expect(screen.getByRole('alert').textContent).toBe('Tasks could not be read.');
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('renders empty as plain text: no live role, no table, no zero', () => {
        const { container } = render(<StateNote state="empty">No tasks yet.</StateNote>);
        expect(container.textContent).toBe('No tasks yet.');
        expect(screen.queryByRole('status')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(container.querySelector('table')).toBeNull();
    });
});
