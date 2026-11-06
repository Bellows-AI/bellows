import { describe, expect, it } from 'vitest';
import {
    countActive,
    envPayload,
    isDirty,
    isKindDirty,
    payloadEquals,
    rowChange,
    rowFieldErrors,
    scopeError,
    SECRET_STATE_LABEL,
    secretState,
    seedRows,
    applyRawText,
    rowsToRawText,
    secretsNote,
    type EnvRowState,
} from '../src/panels/env-draft.js';

const storedVar = (name: string, value: string, id = name): EnvRowState => ({
    id,
    name,
    value,
    isSecret: false,
    isNew: false,
    pendingRemove: false,
    updatedAt: null,
});

const storedSecret = (name: string, id = name): EnvRowState => ({
    id,
    name,
    value: null,
    isSecret: true,
    isNew: false,
    pendingRemove: false,
    updatedAt: null,
});

describe('canonical dirty comparison', () => {
    it('reads clean after seeding and re-seeding the same rows — an echo round-trip', () => {
        const rows = seedRows([
            { name: 'LOG_LEVEL', value: 'debug', isSecret: false },
            { name: 'TOKEN', value: null, isSecret: true },
        ]);
        expect(
            isDirty(
                rows,
                rows.map((row) => ({ ...row }))
            )
        ).toBe(false);
    });

    it('stays clean when the draft is reordered — the store reads back ordered by name', () => {
        const rows = [storedVar('A', '1'), storedVar('B', '2')];
        expect(isDirty(rows, [rows[1]!, rows[0]!])).toBe(false);
    });

    it('goes dirty on an edited value, an addition, and a blank-name row nobody finished', () => {
        const rows = [storedVar('A', '1')];
        expect(isDirty(rows, [storedVar('A', '2')])).toBe(true);
        expect(isDirty(rows, [rows[0]!, storedVar('NEW', '', 'r9')])).toBe(true);
        expect(isDirty(rows, [rows[0]!, { ...storedVar('', '', 'r10'), isNew: true }])).toBe(true);
    });

    it('reads a cleared secret input as keep — the wire has one blank form, null', () => {
        const rows = [storedSecret('TOKEN')];
        // A typed-then-cleared input (value '') PUTs the same keep marker as an untouched one, so
        // undoing a replacement returns the editor to clean. The null/'' distinction the row
        // contract needs lives in secretState and the new-row validation, not on the wire.
        expect(payloadEquals(envPayload(rows), envPayload([{ ...rows[0]!, value: '' }]))).toBe(true);
        expect(envPayload(rows)).toEqual([{ name: 'TOKEN', value: null, isSecret: true }]);
        // A typed replacement is the one distinct payload.
        expect(payloadEquals(envPayload(rows), envPayload([{ ...rows[0]!, value: 'next' }]))).toBe(false);
    });

    it('excludes a pending-removed row from the payload, which makes the draft dirty', () => {
        const rows = [storedVar('A', '1'), storedVar('B', '2')];
        const draft = [rows[0]!, { ...rows[1]!, pendingRemove: true }];
        expect(envPayload(draft)).toEqual([{ name: 'A', value: '1', isSecret: false }]);
        expect(isDirty(rows, draft)).toBe(true);
    });

    it('trims names in the payload — a stray space is not a change', () => {
        const rows = [storedVar('A', '1')];
        expect(payloadEquals(envPayload(rows), envPayload([{ ...rows[0]!, name: ' A ' }]))).toBe(true);
    });
});

describe('row validation — the server rules, mirrored for early feedback', () => {
    it('requires a non-empty legal name', () => {
        const errors = rowFieldErrors([{ ...storedVar('', '', 'r1'), isNew: true }]);
        expect(errors.get('r1')?.name).toContain('Name is required.');
        const bad = rowFieldErrors([storedVar('has space', '')]);
        expect(bad.get('has space')?.name[0]).toMatch(/not a legal environment variable name/);
    });

    it('refuses over-limit and reserved names', () => {
        const OVER_NAME_LIMIT = 256;
        const long = rowFieldErrors([storedVar('A'.repeat(OVER_NAME_LIMIT), '')]);
        expect(long.get('A'.repeat(OVER_NAME_LIMIT))?.name[0]).toMatch(/255 characters/);
        const reserved = rowFieldErrors([storedVar('WORKDIR', '')]);
        expect(reserved.get('WORKDIR')?.name[0]).toMatch(/reserved by the runner/);
        const loader = rowFieldErrors([storedVar('LD_PRELOAD', '')]);
        expect(loader.get('LD_PRELOAD')?.name[0]).toMatch(/reserved by the runner/);
    });

    it('flags every member of a duplicate pair, on the trimmed name', () => {
        const errors = rowFieldErrors([storedVar('A', '1', 'r1'), storedVar('A', '2', 'r2')]);
        expect(errors.get('r1')?.name[0]).toMatch(/Duplicate name "A"/);
        expect(errors.get('r2')?.name[0]).toMatch(/Duplicate name "A"/);
    });

    it('refuses a value with a newline or past the value limit', () => {
        expect(rowFieldErrors([storedVar('A', 'one\ntwo')]).get('A')?.value[0]).toMatch(/newline/);
        const OVER_VALUE_LIMIT = 32_769;
        expect(rowFieldErrors([storedVar('A', 'x'.repeat(OVER_VALUE_LIMIT))]).get('A')?.value[0]).toMatch(
            /32.*768 characters/
        );
    });

    it('marks a new secret with no value Not set, and a stored blank secret is the keep marker', () => {
        const fresh = rowFieldErrors([{ ...storedSecret('NEW', 'r1'), isNew: true, value: '' }]);
        expect(fresh.get('r1')?.value[0]).toMatch(/Enter a value or remove the row/);
        expect(rowFieldErrors([storedSecret('OLD', 'r2')]).get('r2')).toBeUndefined();
    });

    it('never flags a pending-removed row, whatever its name', () => {
        const errors = rowFieldErrors([{ ...storedVar('has space', 'x', 'r1'), pendingRemove: true }]);
        expect(errors.get('r1')).toBeUndefined();
    });

    it('splits errors by field, so a name problem never renders as a value error and vice versa', () => {
        const nameOnly = rowFieldErrors([{ ...storedVar('', 'debug', 'r1'), isNew: true }]);
        expect(nameOnly.get('r1')).toEqual({ name: ['Name is required.'], value: [] });

        const valueOnly = rowFieldErrors([storedVar('GOOD_NAME', 'one\ntwo', 'r2')]);
        expect(valueOnly.get('r2')).toEqual({ name: [], value: ['Value contains a newline.'] });
    });

    it('caps the scope at one hundred active rows, counting pending-removed rows as gone', () => {
        const hundred = Array.from({ length: 100 }, (_, i) => storedVar(`V${i}`, 'x'));
        expect(scopeError(hundred)).toBeNull();
        expect(scopeError([...hundred, storedVar('V100', 'x')])).toMatch(/at most 100/i);
        const overButOnePending = [...hundred, { ...storedVar('V100', 'x'), pendingRemove: true }];
        expect(scopeError(overButOnePending)).toBeNull();
    });
});

describe('secret state', () => {
    it('is Set for a stored secret whose input is blank, and stays Set when the input is cleared', () => {
        expect(secretState(storedSecret('TOKEN'))).toBe('set');
        expect(secretState({ ...storedSecret('TOKEN'), value: '' })).toBe('set');
    });

    it('is Will replace when saved once a value is typed', () => {
        expect(secretState({ ...storedSecret('TOKEN'), value: 'next' })).toBe('replace');
        expect(secretState({ ...storedSecret('TOKEN', 'r1'), isNew: true, value: 'next' })).toBe('replace');
    });

    it('is Not set for a new secret row that has no value yet', () => {
        expect(secretState({ ...storedSecret('NEW'), isNew: true, value: '' })).toBe('not-set');
    });

    it('carries the row labels the tab renders', () => {
        expect(SECRET_STATE_LABEL.set).toBe('Set');
        expect(SECRET_STATE_LABEL.replace).toBe('Will replace when saved');
        expect(SECRET_STATE_LABEL['not-set']).toBe('Not set');
    });
});

describe('row counts', () => {
    it('include additions and exclude pending removals', () => {
        const rows = [
            storedVar('A', '1'),
            { ...storedVar('B', '2'), pendingRemove: true },
            { ...storedSecret('TOKEN') },
            { ...storedSecret('NEW', 'r9'), isNew: true, value: '' },
        ];
        expect(countActive(rows, false)).toBe(1);
        expect(countActive(rows, true)).toBe(2);
    });
});

describe('the shared structured/.env draft (BEL-262)', () => {
    let counter = 0;
    const nextId = () => {
        counter += 1;
        return `n${counter}`;
    };
    const blankNew: EnvRowState = {
        id: 'blank',
        name: '',
        value: '',
        isSecret: false,
        isNew: true,
        pendingRemove: false,
        updatedAt: null,
    };

    it('writes only the active variables into the text: no secret, no pending removal, no blank addition', () => {
        const rows = [
            storedVar('A', '1'),
            storedSecret('TOKEN'),
            { ...storedVar('GONE', 'x'), pendingRemove: true },
            blankNew,
            storedVar('E', ''),
        ];
        expect(rowsToRawText(rows)).toBe('A=1\nE=');
    });

    it('keeps a secret out of the text even when its value was typed', () => {
        const typed: EnvRowState = { ...storedSecret('TOKEN'), value: 'hunter2', isNew: true };
        expect(rowsToRawText([typed, storedVar('A', '1')])).not.toContain('hunter2');
        expect(rowsToRawText([typed])).toBe('');
    });

    it('applies valid text as the whole variable set and passes the secret rows around untouched', () => {
        const secret = { ...storedSecret('TOKEN'), value: 'typed', isNew: false };
        const result = applyRawText('B=2\nA=\n', [storedVar('OLD', 'x'), secret], nextId);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(envPayload(result.rows)).toEqual([
            { name: 'B', value: '2', isSecret: false },
            { name: 'A', value: '', isSecret: false },
            { name: 'TOKEN', value: 'typed', isSecret: true },
        ]);
        expect(result.rows.at(-1)).toBe(secret);
    });

    it('reports line-numbered errors and no rows for malformed text, a secret name included', () => {
        const result = applyRawText('A=1\nnot a pair\nTOKEN=x', [storedSecret('TOKEN')], nextId);
        expect(result).toEqual({
            ok: false,
            errors: [
                'line 2: expected KEY=value',
                'line 3: "TOKEN" is already a secret in this scope — edit it in the Secrets tab',
            ],
        });
    });

    it('refuses an unterminated quote and keeps every row, so no corrupted value is applied', () => {
        const rows = [storedVar('KEEP', 'x')];
        for (const text of ['A="first\nB=second"', 'A="first\n#second']) {
            const result = applyRawText(text, rows, nextId);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.errors[0]).toMatch(/^line 1: /);
        }
    });

    it('does not count a pending-removed secret as a collision', () => {
        const removed = { ...storedSecret('TOKEN'), pendingRemove: true };
        expect(applyRawText('TOKEN=x', [removed], nextId).ok).toBe(true);
    });

    it('reads clean after a structured -> text -> structured round trip of empty and quoted values', () => {
        const baseline = seedRows([
            { name: 'EMPTY', value: '', isSecret: false },
            { name: 'QUOTED', value: '"x"', isSecret: false },
            { name: 'TOKEN', value: null, isSecret: true },
        ]);
        const result = applyRawText(rowsToRawText(baseline), baseline, nextId);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(isDirty(baseline, result.rows)).toBe(false);
    });

    it('words the count note for the secrets the text does not show', () => {
        expect(secretsNote(0)).toBeNull();
        expect(secretsNote(1)).toBe('1 secret is edited in the Secrets tab.');
        expect(secretsNote(2)).toBe('2 secrets are edited in the Secrets tab.');
    });
});

describe('per-kind dirty state', () => {
    const baseline = [storedVar('A', '1'), storedSecret('TOKEN')];

    it('is clean for both kinds on an untouched draft', () => {
        expect(isKindDirty(baseline, baseline, false)).toBe(false);
        expect(isKindDirty(baseline, baseline, true)).toBe(false);
    });

    it('marks only the kind that changed', () => {
        const variableEdited = [storedVar('A', '2'), storedSecret('TOKEN')];
        expect(isKindDirty(baseline, variableEdited, false)).toBe(true);
        expect(isKindDirty(baseline, variableEdited, true)).toBe(false);

        const secretReplaced = [storedVar('A', '1'), { ...storedSecret('TOKEN'), value: 'next' }];
        expect(isKindDirty(baseline, secretReplaced, false)).toBe(false);
        expect(isKindDirty(baseline, secretReplaced, true)).toBe(true);
    });

    it('counts an addition and a pending removal for their own kind', () => {
        const added = [...baseline, { ...storedSecret('NEW', 'r1'), isNew: true, value: 'x' }];
        expect(isKindDirty(baseline, added, true)).toBe(true);
        expect(isKindDirty(baseline, added, false)).toBe(false);
        const removed = [{ ...baseline[0]!, pendingRemove: true }, baseline[1]!];
        expect(isKindDirty(baseline, removed, false)).toBe(true);
        expect(isKindDirty(baseline, removed, true)).toBe(false);
    });
});

describe('the unsaved-change marker of one row', () => {
    const baseline = [storedVar('A', '1'), storedSecret('TOKEN')];

    it('is null for a row equal to its stored twin, matched by name and not by id', () => {
        expect(rowChange(storedVar('A', '1', 'other-id'), baseline)).toBeNull();
        expect(rowChange(baseline[1]!, baseline)).toBeNull();
    });

    it('is new for an addition and for a rename, trimming the name', () => {
        expect(rowChange({ ...storedVar('B', '1'), isNew: true }, baseline)).toBe('new');
        expect(rowChange(storedVar('A2', '1', 'A'), baseline)).toBe('new');
        expect(rowChange(storedVar(' A ', '1'), baseline)).toBeNull();
    });

    it('is changed for an edited variable value', () => {
        expect(rowChange(storedVar('A', '2'), baseline)).toBe('changed');
    });

    it('matches by type: a secret of a stored variable name is new', () => {
        expect(rowChange({ ...storedSecret('A'), isNew: true, value: 'x' }, baseline)).toBe('new');
    });

    it('is changed for a secret only once a replacement is typed', () => {
        expect(rowChange({ ...storedSecret('TOKEN'), value: '' }, baseline)).toBeNull();
        expect(rowChange({ ...storedSecret('TOKEN'), value: 'next' }, baseline)).toBe('changed');
    });
});

describe('seeding keeps the last write for display', () => {
    it('carries updatedAt through, and null when the stored row has none', () => {
        const rows = seedRows([
            { name: 'A', value: '1', isSecret: false, updatedAt: '2026-09-01T00:00:00.000Z' },
            { name: 'B', value: '2', isSecret: false },
        ]);
        expect(rows.map((row) => row.updatedAt)).toEqual(['2026-09-01T00:00:00.000Z', null]);
    });
});
