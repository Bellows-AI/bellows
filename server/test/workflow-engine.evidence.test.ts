import { describe, expect, it } from 'vitest';
import { nextTransition, type EngineRow } from '../src/db/workflows/workflow-engine.js';
import { validateDefinition } from '../src/db/workflows/workflow-schema-validate.js';
import type { AuthoredWorkflowDefinition, WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { BLOCK_REGISTRY, compileDefinition } from '../src/db/workflows/workflow-blocks/index.js';
import { REVIEW_MARKERS } from '../src/db/workflows/workflow-blocks/review-reconcile.js';

/** Edges fire on the run's own verdict, never on a failed run's marker or a dead service. */
const failedGate = (output: string): EngineRow['gates'] => [{ name: 'test', status: 'failed', exitCode: 1, output }];
const DEFAULT_ENTRY_NODE = 'task';
const REPAIR = 'review-reconciliation--repair';
const MERGE_REPAIR = 'merge-conflict-autofix--repair';

/** `task` (publishing) → the review block → the merge block, each optional, as a member would author it. */
function compileDefaultWorkflow(selection: { review: boolean; merge: boolean }): WorkflowDefinition {
    const authored: AuthoredWorkflowDefinition = {
        entry: DEFAULT_ENTRY_NODE,
        params: [],
        nodes: [{ name: DEFAULT_ENTRY_NODE, kind: 'agent', session: 'resume', publish: true, prompt: '{{command}}' }],
        edges: [],
    };
    if (selection.review) {
        authored.nodes.push({
            name: 'review-reconciliation',
            kind: 'block',
            uses: 'builtin/review-reconcile',
            with: { maxRounds: 3 },
        });
        authored.edges.push({ from: DEFAULT_ENTRY_NODE, to: 'review-reconciliation', when: 'succeeded' });
    }
    if (selection.merge) {
        authored.nodes.push({ name: 'merge-conflict-autofix', kind: 'block', uses: 'builtin/merge-conflict-autofix' });
        authored.edges.push(
            selection.review
                ? {
                      from: 'review-reconciliation',
                      to: 'merge-conflict-autofix',
                      when: { marker: REVIEW_MARKERS.CLEAN },
                  }
                : { from: DEFAULT_ENTRY_NODE, to: 'merge-conflict-autofix', when: 'succeeded' }
        );
    }
    const validated = validateDefinition(authored);
    if (!validated.ok) throw new Error(`${validated.refusal.code} ${validated.refusal.message}`);
    const compiled = compileDefinition(validated.definition, BLOCK_REGISTRY);
    if (!compiled.ok) throw new Error(`${compiled.refusal.code} ${compiled.refusal.message}`);
    return compiled.definition;
}
const BOTH = { review: true, merge: true };

describe('nextTransition: edge evidence', () => {
    it.each(['services', 'timeout', 'runner_error', 'cache_lost'] as const)(
        'a %s verdict carrying a failed gate report rests a node with no failed edge',
        (failureKind) => {
            const rows: EngineRow[] = [
                {
                    id: 'a',
                    node: DEFAULT_ENTRY_NODE,
                    status: 'failed',
                    output: null,
                    gates: failedGate('stale'),
                    sessionId: 's',
                },
            ];
            const transition = nextTransition({
                snapshot: compileDefaultWorkflow(BOTH),
                params: {},
                command: 'do it',
                rows,
                completed: {
                    id: 'a',
                    node: DEFAULT_ENTRY_NODE,
                    status: 'failed',
                    output: 'x',
                    gates: failedGate('stale'),
                    failureKind,
                },
            });
            expect(transition.action).toBe('rest');
        }
    );

    it.each(['services', 'publish'] as const)(
        'a %s verdict on review repair rests without spending a round',
        (kind) => {
            const rows: EngineRow[] = [
                { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'ok', gates: null, sessionId: 's' },
                {
                    id: 'b',
                    node: 'review-reconciliation--collect',
                    status: 'succeeded',
                    output: 'REVIEW-ACTIONABLE',
                    gates: null,
                    sessionId: 's',
                },
                { id: 'c', node: REPAIR, status: 'failed', output: null, gates: null, sessionId: 's' },
            ];
            const transition = nextTransition({
                snapshot: compileDefaultWorkflow(BOTH),
                params: {},
                command: 'do it',
                rows,
                completed: { id: 'c', node: REPAIR, status: 'failed', output: 'dead', gates: null, failureKind: kind },
            });
            expect(transition).toEqual({ action: 'rest', reason: kind });
        }
    );

    it('a failed run whose tail is a marker does not advance on the marker edge', () => {
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'ok', gates: null, sessionId: 's' },
            { id: 'b', node: MERGE_REPAIR, status: 'failed', output: null, gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: compileDefaultWorkflow({ review: false, merge: true }),
            params: {},
            command: 'do it',
            rows,
            completed: {
                id: 'b',
                node: MERGE_REPAIR,
                status: 'failed',
                output: 'half done\nMERGE-RESOLVED',
                gates: null,
                failureKind: 'runner_error',
            },
        });
        expect(transition.action === 'insert' ? transition.node.name : 'rest').not.toBe(
            'merge-conflict-autofix--verify'
        );
    });
});
