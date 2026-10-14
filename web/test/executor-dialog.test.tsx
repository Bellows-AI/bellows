import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JsonEditor } from '../src/components/JsonEditor.js';
import { AGENT_HELP, GATE_FIX_ROUNDS_HELP, INHERITED_NOTE, NAME_HELP } from '../src/workspace/executors.js';

/**
 * The add/edit executor dialog portals, so its in-dialog contracts are
 * web/test/executor-dialog.dom.test.tsx's. Static renders pin the JSON editor, which does not
 * portal, and the content rules of the help copy the dialog carries.
 */

const editor = (value: string, invalid = false) =>
    renderToStaticMarkup(
        <JsonEditor id="cfg" value={value} onChange={() => {}} invalid={invalid} describedBy="cfg-help" />
    );

describe('the executor dialog help copy', () => {
    it('says what each field decides, and promises no verification on save', () => {
        expect(NAME_HELP).toMatch(/task picker/);
        expect(NAME_HELP).toMatch(/Code review/);
        expect(AGENT_HELP).toMatch(/selected agent/);
        // Saving a name and an agent alone inherits the deployment's configuration, and the
        // sentence does not promise that saving verified anything.
        expect(INHERITED_NOTE).toMatch(/inherited from this deployment/);
        expect(INHERITED_NOTE).toMatch(/not your credentials or whether the model is available/);
        // The gate-repair field's help is the same contract: what the number decides, and that
        // zero turns automatic repair off (issue #49).
        expect(GATE_FIX_ROUNDS_HELP).toMatch(/failed gate/);
        expect(GATE_FIX_ROUNDS_HELP).toMatch(/0 turns/i);
    });
});

describe('JsonEditor', () => {
    it('is one labelled textarea carrying the raw text, its description and its invalid state', () => {
        const html = editor('{ "a": 1 }', true);
        expect(html).toMatch(/<textarea[^>]*id="cfg"/);
        expect(html).toMatch(/<textarea[^>]*aria-invalid="true"/);
        expect(html).toMatch(/<textarea[^>]*aria-describedby="cfg-help"/);
        expect(html).toMatch(/<textarea[^>]*spellCheck="false"/);
        expect(html).toContain('>{ &quot;a&quot;: 1 }</textarea>');
        expect(editor('{}')).not.toContain('aria-invalid');
    });

    it('numbers every line in an aria-hidden gutter', () => {
        const html = editor('{\n  "a": 1\n}');
        expect(html).toMatch(
            /class="json-editor-gutter" aria-hidden="true"><span>1<\/span><span>2<\/span><span>3<\/span><\/div>/
        );
    });

    it('paints a highlighted, aria-hidden copy that tells keys from values', () => {
        const html = editor('{"k": "v", "n": 2, "t": true}');
        expect(html).toMatch(/<pre class="json-editor-highlight" aria-hidden="true">/);
        expect(html).toContain('<span class="json-token-key">&quot;k&quot;</span>');
        expect(html).toContain('<span class="json-token-string">&quot;v&quot;</span>');
        expect(html).toContain('<span class="json-token-number">2</span>');
        expect(html).toContain('<span class="json-token-literal">true</span>');
    });
});
