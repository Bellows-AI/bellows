import { checkoutSkillDirsOf, EXECUTOR_TYPES } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../driver/src/board/board.js';
import { checkoutSkillDirsOf as driverDirs } from '../../driver/src/skill-inputs.js';

/** The driver imports nothing, so its skill-directory list is a copy; this pins it to core's for every type. */
describe('the driver copy of the checkout skill directories', () => {
    it.each([...EXECUTOR_TYPES, null])('agrees with core for executor type %s', (type) => {
        const job = { executorType: type } as unknown as BoardJob;
        expect(driverDirs(job)).toEqual(checkoutSkillDirsOf(type));
    });
});
