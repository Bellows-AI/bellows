import { describe, expect, it } from 'vitest';
import {
    OBSERVED_USAGE_NOTE,
    TOKEN_TYPE_LABELS,
    TOTAL_INPUT_LABEL,
    UNASSIGNED_SENTENCES,
    coverageLabel,
    figure,
    precisionLabel,
    precisionMark,
    rowKey,
} from '../src/components/usage/usage-format.js';

describe('usage format', () => {
    it('renders null as a dash, a measured zero as 0, a value grouped', () => {
        expect(figure(null)).toBe('—');
        expect(figure(0)).toBe('0');
        expect(figure(1234567)).toBe('1,234,567');
    });

    it('marks only estimated and mixed precision', () => {
        expect(precisionMark('exact')).toBe('');
        expect(precisionMark(null)).toBe('');
        expect(precisionMark('estimated')).toBe('~');
        expect(precisionMark('mixed')).toBe('~');
        expect(precisionLabel('estimated')).toBe('estimated');
        expect(precisionLabel('mixed')).toBe('mixed estimated and exact');
        expect(precisionLabel('exact')).toBe('');
    });

    it('words partial coverage and stays silent when every contributor measured', () => {
        expect(coverageLabel({ measured: 3, contributors: 5 })).toBe('3 of 5 sessions measured');
        expect(coverageLabel({ measured: 5, contributors: 5 })).toBeNull();
        expect(coverageLabel({ measured: 0, contributors: 0 })).toBeNull();
    });

    it('labels the four types apart and the one sanctioned sum explicitly', () => {
        expect(TOKEN_TYPE_LABELS).toEqual({
            input: 'Uncached input',
            cacheRead: 'Cache read',
            cacheCreation: 'Cache write',
            output: 'Output',
        });
        expect(TOTAL_INPUT_LABEL).toBe('Total input');
        expect(OBSERVED_USAGE_NOTE).toBe('Figures describe observed usage, not guaranteed complete consumption');
    });

    it('has a sentence for every unassigned reason and keys child rows under their parent', () => {
        expect(Object.keys(UNASSIGNED_SENTENCES).sort()).toEqual(
            [
                'cumulative-spans-runs',
                'no-segment',
                'no-task',
                'overlap',
                'refused-launch',
                'unconfirmed-launch',
                'unknown-boundary',
            ].sort()
        );
        const parent = {
            model: 'm',
            rawModels: [],
            querySource: null,
            tokens: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
        };
        expect(rowKey(parent)).not.toBe(rowKey({ ...parent, querySource: 'repl' }));
    });
});
