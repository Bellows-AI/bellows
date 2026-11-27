import { describe, expect, it } from 'vitest';
import { changeOrgExecutorScope, deleteOrgExecutor } from '../src/api/orgExecutors.js';
import { stubFetch } from './dom.js';

describe('org executor writes that may orphan a default', () => {
    it('sends no resolution unless the admin chose one, and carries the refusal code', async () => {
        const calls = stubFetch(() => ({
            status: 409,
            body: { error: 'The executor "a" is the organization default', code: 'EXECUTOR_IS_DEFAULT' },
        }));
        expect(await deleteOrgExecutor('id-1')).toEqual({
            error: 'The executor "a" is the organization default',
            code: 'EXECUTOR_IS_DEFAULT',
        });
        expect(calls.map((call) => call.url)).toEqual(['/api/org/executors/id-1']);
    });

    it('delete carries clear or a replacement in the query, the scope move in the body', async () => {
        const calls = stubFetch(() => ({}));
        await deleteOrgExecutor('id-1', { clearDefaults: true });
        await deleteOrgExecutor('id-1', { replaceDefaultsWith: 'id-2' });
        await changeOrgExecutorScope('id-1', 'user', { clearDefaults: true });
        expect(calls.map((call) => call.url)).toEqual([
            '/api/org/executors/id-1?clearDefaults=true',
            '/api/org/executors/id-1?replaceDefaultsWith=id-2',
            '/api/org/executors/id-1/scope',
        ]);
        expect(calls[2]?.body).toEqual({ scope: 'user', clearDefaults: true });
    });
});
