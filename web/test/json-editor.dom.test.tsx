import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { indentAt, JsonEditor } from '../src/components/JsonEditor.js';
import './dom.js';

describe('indentAt', () => {
    it("carries the caret line's leading spaces and tabs, up to the caret", () => {
        const text = '{\n  "x": 12\n\t\t"y": 1\n}';
        expect(indentAt(text, text.indexOf('12'))).toBe('  ');
        expect(indentAt(text, text.indexOf('"y"'))).toBe('\t\t');
        expect(indentAt(text, 1)).toBe('');
        expect(indentAt(text, 0)).toBe('');
    });

    it('stops at the caret when the caret sits inside the indent', () => {
        expect(indentAt('{\n    "x": 1\n}', 4)).toBe('  ');
    });
});

function Editor({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return <JsonEditor id="config" value={value} onChange={setValue} invalid={false} describedBy="config-help" />;
}

describe('the JSON editor under a DOM', () => {
    const original = document.execCommand;
    afterEach(() => {
        document.execCommand = original;
    });

    it("falls back to replacing the value when insertText is refused, keeping the caret after the line's indent", async () => {
        // jsdom, like a browser refusing insertText, has no editing command: the fallback path runs.
        document.execCommand = vi.fn(() => false);
        render(<Editor initial={'{\n  "x": 12\n}'} />);
        const input = screen.getByRole<HTMLTextAreaElement>('textbox');
        input.focus();
        input.setSelectionRange(9, 11);

        const user = userEvent.setup();
        await user.keyboard('{Enter}');
        expect(input.value).toBe('{\n  "x": \n  \n}');
        expect(input.selectionStart).toBe(12);

        await user.keyboard('3');
        expect(input.value).toBe('{\n  "x": \n  3\n}');
    });

    it('leaves a composing Enter to the browser', () => {
        document.execCommand = vi.fn(() => false);
        render(<Editor initial={'{\n  "x": 3\n}'} />);
        const input = screen.getByRole<HTMLTextAreaElement>('textbox');
        input.setSelectionRange(9, 9);

        const handled = !fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
        expect(handled).toBe(false);
        expect(document.execCommand).not.toHaveBeenCalled();
        expect(input.value).toBe('{\n  "x": 3\n}');
    });
});
