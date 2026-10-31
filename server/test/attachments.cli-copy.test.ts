import { ATTACHMENT_FORMATS, MAX_FILE_BYTES, MAX_FILES_PER_REQUEST, MAX_REQUEST_BYTES } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import * as copy from '../../cli/src/attach.js';

/** The CLI imports nothing, so its accepted extensions and limits are copies; this pins them to core's. */
describe('the CLI copy of the attachment limits', () => {
    it('matches core/src/attachments.ts', () => {
        expect(copy.MAX_FILES_PER_REQUEST).toBe(MAX_FILES_PER_REQUEST);
        expect(copy.MAX_FILE_BYTES).toBe(MAX_FILE_BYTES);
        expect(copy.MAX_REQUEST_BYTES).toBe(MAX_REQUEST_BYTES);
        expect([...copy.ATTACHMENT_EXTENSIONS].sort()).toEqual(ATTACHMENT_FORMATS.flatMap((f) => f.extensions).sort());
    });
});
