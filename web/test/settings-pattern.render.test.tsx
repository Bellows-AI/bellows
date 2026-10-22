import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSaveActions, UNSAVED_CHANGES_LABEL } from '../src/components/SettingsSaveActions.js';

/**
 * The piece every settings editor shares (issue 282): the Save/Cancel footer with its
 * "Unsaved changes" indicator. It is presentational, so a
 * static render is a complete render.
 */

const actions = (overrides: Partial<Parameters<typeof SettingsSaveActions>[0]> = {}) =>
    renderToStaticMarkup(
        <SettingsSaveActions
            dirty={false}
            saving={false}
            canSave={false}
            onSave={() => {}}
            onCancel={() => {}}
            {...overrides}
        />
    );

/** The opening tag of the button whose label is `label`. */
const buttonTag = (html: string, label: string) => {
    const match = html.match(new RegExp(`<button[^>]*>${label}</button>`));
    expect(match, `a ${label} button`).toBeTruthy();
    return match![0];
};

describe('SettingsSaveActions', () => {
    it('offers Save and Cancel, both disabled, and no indicator while clean', () => {
        const html = actions();
        expect(html).toContain('class="settings-actions"');
        expect(buttonTag(html, 'Save changes')).toContain('disabled');
        expect(buttonTag(html, 'Cancel')).toContain('disabled');
        expect(html).not.toContain(UNSAVED_CHANGES_LABEL);
    });

    it('shows Unsaved changes and enables Cancel and Save while dirty and valid', () => {
        const html = actions({ dirty: true, canSave: true });
        expect(html).toContain(`class="settings-dirty">${UNSAVED_CHANGES_LABEL}<`);
        expect(buttonTag(html, 'Save changes')).not.toContain('disabled');
        expect(buttonTag(html, 'Cancel')).not.toContain('disabled');
    });

    it('keeps Save disabled for a dirty draft that cannot save, while Cancel stays enabled', () => {
        const html = actions({ dirty: true, canSave: false });
        expect(html).toContain(UNSAVED_CHANGES_LABEL);
        expect(buttonTag(html, 'Save changes')).toContain('disabled');
        expect(buttonTag(html, 'Cancel')).not.toContain('disabled');
    });

    it('renames Save and locks both while a save runs', () => {
        const html = actions({ dirty: true, canSave: false, saving: true });
        expect(buttonTag(html, 'Saving changes…')).toContain('disabled');
        expect(buttonTag(html, 'Cancel')).toContain('disabled');
    });

    it('has exactly one primary action, and it is Save', () => {
        const html = actions({ dirty: true, canSave: true });
        expect(html.match(/class="[^"]*\bprimary\b/g)).toHaveLength(1);
        expect(buttonTag(html, 'Save changes')).toContain('primary');
    });
});
