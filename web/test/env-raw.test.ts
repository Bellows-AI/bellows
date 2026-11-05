import { ENV_NAME_LIMIT, ENV_VALUE_LIMIT, MAX_ENV_VARS_PER_SCOPE, RESERVED_ENV_NAMES } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { parseEnvRaw, serializeEnv, type EnvVarRow } from '../src/panels/env-raw.js';

const noSecrets: string[] = [];

const ok = (vars: EnvVarRow[]) => ({ ok: true as const, vars });

const variable = (name: string, value: string): EnvVarRow => ({ name, value, isSecret: false });

describe('the raw .env editor parser', () => {
    it('refuses every name the server reserves', () => {
        // The editor once carried its own copy of the list and silently accepted
        // CLAUDE_CODE_CONFIG_CONTENT, which the server's PUT refuses.
        expect(RESERVED_ENV_NAMES).toContain('CLAUDE_CODE_CONFIG_CONTENT');
        for (const name of RESERVED_ENV_NAMES) {
            expect(parseEnvRaw(`${name}=x`, noSecrets)).toEqual({
                ok: false,
                errors: [`line 1: "${name}" is reserved by the runner`],
            });
        }
    });

    it('refuses a loader variable by its LD_ prefix, as the server does', () => {
        expect(parseEnvRaw('LD_AUDIT=/w/evil.so', noSecrets)).toEqual({
            ok: false,
            errors: ['line 1: "LD_AUDIT" is reserved by the runner'],
        });
    });

    it('parses KEY=value pairs', () => {
        expect(parseEnvRaw('LOG_LEVEL=debug\nPORT=8080', noSecrets)).toEqual(
            ok([variable('LOG_LEVEL', 'debug'), variable('PORT', '8080')])
        );
    });

    it('strips an export prefix', () => {
        expect(parseEnvRaw('export KEY=value', noSecrets)).toEqual(ok([variable('KEY', 'value')]));
    });

    it('skips blank lines and # comment lines', () => {
        const text = '\n# a comment\nKEY=value\n   \n   # indented comment\n';
        expect(parseEnvRaw(text, noSecrets)).toEqual(ok([variable('KEY', 'value')]));
    });

    it('strips one pair of surrounding double or single quotes', () => {
        const result = parseEnvRaw('A="quoted"\nB=\'single\'\nC="a"b"', noSecrets);
        expect(result).toEqual(ok([variable('A', 'quoted'), variable('B', 'single'), variable('C', 'a"b')]));
    });

    it('does no escape processing: backslash-n stays literal and inline # is value text', () => {
        const result = parseEnvRaw('A=line1\\nline2\nB=#notcomment\nC=a#b', noSecrets);
        expect(result).toEqual(
            ok([variable('A', 'line1\\nline2'), variable('B', '#notcomment'), variable('C', 'a#b')])
        );
    });

    it('accepts an empty value and trims around the = sign', () => {
        const result = parseEnvRaw('EMPTY=\nSPACED =  spaced value  ', noSecrets);
        expect(result).toEqual(ok([variable('EMPTY', ''), variable('SPACED', 'spaced value')]));
    });

    it('keeps spacing inside quotes after stripping the pair', () => {
        expect(parseEnvRaw('A=" v "', noSecrets)).toEqual(ok([variable('A', ' v ')]));
    });

    it('normalizes CR-LF line endings', () => {
        expect(parseEnvRaw('A=1\r\nB=2\rC=3', noSecrets)).toEqual(
            ok([variable('A', '1'), variable('B', '2'), variable('C', '3')])
        );
    });

    it('replaces the draft: the parsed set is the whole new variable list, deletions included', () => {
        // Rows that exist in the draft but not in the text are gone — the text is the truth.
        expect(parseEnvRaw('A=2\nNEW=3', noSecrets)).toEqual(ok([variable('A', '2'), variable('NEW', '3')]));
    });

    it('parses empty text to no variables — the delete-everything edit', () => {
        expect(parseEnvRaw('', noSecrets)).toEqual(ok([]));
    });
});

describe('the raw .env editor parser — refusals', () => {
    it('refuses a line with no = sign, with its line number', () => {
        const result = parseEnvRaw('A=1\nnot-a-pair\nB=2', noSecrets);
        expect(result).toEqual({ ok: false, errors: ['line 2: expected KEY=value'] });
    });

    it('refuses an empty name, with its line number', () => {
        expect(parseEnvRaw('=x', noSecrets)).toEqual({ ok: false, errors: ['line 1: expected KEY=value'] });
    });

    it('refuses illegal names, with the line number', () => {
        const result = parseEnvRaw('1BAD=x\nA-B=y', noSecrets);
        expect(result).toEqual({
            ok: false,
            errors: [
                'line 1: "1BAD" is not a legal environment variable name',
                'line 2: "A-B" is not a legal environment variable name',
            ],
        });
    });

    it('refuses a name over the length limit, with the line number', () => {
        const name = 'A'.repeat(ENV_NAME_LIMIT + 1);
        const result = parseEnvRaw(`${name}=x`, noSecrets);
        expect(result).toEqual({ ok: false, errors: [`line 1: name exceeds ${ENV_NAME_LIMIT} characters`] });
    });

    it('refuses reserved names, with the line number', () => {
        expect(parseEnvRaw('WORKDIR=/tmp', noSecrets)).toEqual({
            ok: false,
            errors: ['line 1: "WORKDIR" is reserved by the runner'],
        });
    });

    it('refuses a value over the size limit, with the line number', () => {
        const result = parseEnvRaw(`A=${'x'.repeat(ENV_VALUE_LIMIT + 1)}`, noSecrets);
        expect(result).toEqual({ ok: false, errors: [`line 1: value for "A" exceeds ${ENV_VALUE_LIMIT} characters`] });
    });

    it('refuses a quoted value that runs over the next line, because parsing is line-structured', () => {
        // The real shape of "a value containing a newline": the continuation arrives as its own
        // line, and a line with no = is refused — docker --env-file would have truncated it.
        const result = parseEnvRaw('A="starts\nstill starting"', noSecrets);
        expect(result).toEqual({ ok: false, errors: ['line 2: expected KEY=value'] });
    });

    it('refuses duplicate names within the text, with both line numbers', () => {
        const result = parseEnvRaw('A=1\nB=2\nA=3', noSecrets);
        expect(result).toEqual({ ok: false, errors: ['line 3: duplicate name "A" (first seen on line 1)'] });
    });

    it('refuses a name that collides with a secret in the scope', () => {
        expect(parseEnvRaw('A=1\nS=new', ['S'])).toEqual({
            ok: false,
            errors: ['line 2: "S" is already a secret in this scope — edit it on the Secrets tab'],
        });
    });

    it('counts secrets toward the scope cap, refusing at the tipping line', () => {
        const secretNames = Array.from({ length: 50 }, (_, i) => `S${i}`);
        const lines = Array.from({ length: 51 }, (_, i) => `V${i}=x`).join('\n');
        const result = parseEnvRaw(lines, secretNames);
        expect(result).toEqual({
            ok: false,
            errors: [`line 51: raw text would exceed the limit of ${MAX_ENV_VARS_PER_SCOPE} variables per scope`],
        });
    });

    it('accepts exactly-at-cap text', () => {
        const lines = Array.from({ length: MAX_ENV_VARS_PER_SCOPE }, (_, i) => `V${i}=x`).join('\n');
        const result = parseEnvRaw(lines, noSecrets);
        expect(result.ok).toBe(true);
    });

    it('refuses the whole text when any line is bad — nothing is applied', () => {
        const result = parseEnvRaw('A=1\nBAD NAME=x', noSecrets);
        expect(result.ok).toBe(false);
    });

    it('reports every bad line, not just the first', () => {
        const result = parseEnvRaw('1BAD=x\nA=1\nWORKDIR=/tmp', noSecrets);
        expect(result).toEqual({
            ok: false,
            errors: [
                'line 1: "1BAD" is not a legal environment variable name',
                'line 3: "WORKDIR" is reserved by the runner',
            ],
        });
    });
});

describe('serializeEnv', () => {
    it('writes one NAME=value line per non-secret row and never serializes secrets', () => {
        const rows: EnvVarRow[] = [
            { name: 'A', value: '1', isSecret: false },
            { name: 'S', value: null, isSecret: true },
            { name: 'B', value: '', isSecret: false },
        ];
        expect(serializeEnv(rows)).toBe('A=1\nB=');
    });

    it('round-trips plain, empty and inner-quote values unwrapped', () => {
        const rows: EnvVarRow[] = [variable('A', 'plain'), variable('B', ''), variable('C', 'a"b'), variable('D', 'q')];
        const result = parseEnvRaw(serializeEnv(rows), []);
        expect(result).toEqual(ok(rows));
    });

    it('quotes values with leading or trailing whitespace so the parse round-trips', () => {
        const rows: EnvVarRow[] = [variable('A', ' padded '), variable('B', '\tlead'), variable('C', '  ')];
        expect(serializeEnv(rows)).toBe('A=" padded "\nB="\tlead"\nC="  "');
        const result = parseEnvRaw(serializeEnv(rows), []);
        expect(result).toEqual(ok(rows));
    });

    it('quotes values that are themselves one pair of quotes, so the strip does not eat them', () => {
        const rows: EnvVarRow[] = [variable('A', '"dq"'), variable('B', "'sq'")];
        const text = serializeEnv(rows);
        const result = parseEnvRaw(text, []);
        expect(result).toEqual(ok(rows));
    });
});

describe('the raw .env round trip (BEL-262)', () => {
    const roundTrip = (rows: EnvVarRow[]) => parseEnvRaw(serializeEnv(rows), noSecrets);

    it('returns every value shape unchanged, empty and quoted ones included', () => {
        const values = [
            '',
            'plain',
            ' leading',
            'trailing ',
            '"quoted"',
            "'single'",
            '"',
            "'",
            '""',
            '"a" ',
            'a"',
            '"a',
            `"mixed'`,
            'a=b=c',
            'x # not a comment',
            'back\\slash\\n',
            'export FOO',
            '  "padded quoted"  ',
            '\t',
            '# starts like a comment',
        ];
        const rows = values.map((value, index) => variable(`V_${index}`, value));
        expect(roundTrip(rows)).toEqual(ok(rows));
    });

    it('returns a name that merely starts with export unchanged', () => {
        const rows = [variable('export', 'a'), variable('exported', ''), variable('EXPORT_X', '"q"')];
        expect(roundTrip(rows)).toEqual(ok(rows));
    });

    it('reads a valid quoted or empty line from hand-written text as written', () => {
        expect(parseEnvRaw('A=\nB=""\nC="x"\nD=\'y z\'\nexport E=', noSecrets)).toEqual(
            ok([variable('A', ''), variable('B', ''), variable('C', 'x'), variable('D', 'y z'), variable('E', '')])
        );
    });

    it('names both lines of a duplicate and the line of an illegal name', () => {
        expect(parseEnvRaw('A=1\n\nA=2', noSecrets)).toEqual({
            ok: false,
            errors: ['line 3: duplicate name "A" (first seen on line 1)'],
        });
        expect(parseEnvRaw('A=1\n1BAD=2', noSecrets)).toEqual({
            ok: false,
            errors: ['line 2: "1BAD" is not a legal environment variable name'],
        });
    });
});

describe('.env text that must not parse to something else (BEL-262 review)', () => {
    const refused = (text: string) => {
        const result = parseEnvRaw(text, noSecrets);
        expect(result.ok).toBe(false);
        return result.ok ? [] : result.errors;
    };

    it('refuses a quote opened and not closed on its line, naming the opening line, applying nothing', () => {
        expect(refused('A="first\nB=second"')).toEqual([expect.stringMatching(/^line 1: .*"A".*quote/)]);
        expect(refused('A="first\n#second')).toEqual([expect.stringMatching(/^line 1: .*"A".*quote/)]);
        expect(refused("ok=1\nA='first\nB=2")).toEqual([expect.stringMatching(/^line 2: .*"A".*quote/)]);
    });

    it('refuses a lone quote, mismatched quote types and text after a closing quote', () => {
        for (const text of ['A="', "A='", `A="x'`, `A='x"`, 'A="x" y', 'A="x"y', "A='x' y"]) {
            expect(refused(text)).toEqual([expect.stringMatching(/^line 1: /)]);
        }
    });

    it('still reads a quote inside or after unquoted text, and a quoted value holding quotes, literally', () => {
        expect(parseEnvRaw(`A=x "y"\nB="it's"\nC='say "hi"'\nD=a'`, noSecrets)).toEqual(
            ok([variable('A', 'x "y"'), variable('B', "it's"), variable('C', 'say "hi"'), variable('D', "a'")])
        );
    });

    it('round-trips a value that starts with a quote without being a matched pair', () => {
        const rows = ['"x', "'a", `"x'`, `'x"`, '"', "'", '"a" b', '"a"b'].map((value, i) => variable(`Q_${i}`, value));
        expect(parseEnvRaw(serializeEnv(rows), noSecrets)).toEqual(ok(rows));
    });
});
