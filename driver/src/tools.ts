import type { BoardJob, DeclaredGate } from './board/board.js';
import { AD_HOC_MAX_MINUTES } from './gate-manager.js';
import { checkoutKey } from './publish/publish.js';

/** A declared gate: a command with a verdict, run at finish unless the repository marks it `on_demand`. */
export interface GateTool {
    id: `gate:${string}`;
    name: string;
    kind: 'command';
    verdict: true;
    required: 'finish' | 'on_demand';
    /** The call may carry a `filter` for this one run. */
    filter: boolean;
    /** The declared `timeoutMinutes`, null when the gate runs to the driver's default. */
    timeout: number | null;
}

/** The built-in ad-hoc command in the gate environment: an exit code and output, never a verdict. */
export interface ExecTool {
    id: 'exec';
    name: 'exec';
    kind: 'command';
    verdict: false;
    /** Minutes. */
    timeout: number;
}

export type ToolSpec = GateTool | ExecTool;

/** The gates the finish pass runs: every declared one but those marked `on_demand`. */
export function finishGates(gates: readonly DeclaredGate[]): DeclaredGate[] {
    return gates.filter((gate) => !gate.onDemand);
}

/**
 * The tools the run's agent can call, built from the claim alone. Ids are prefixed so a gate named `exec` stays
 * `gate:exec` beside the built-in `exec`. Empty when the claim has no gate environment or no checkout to run it in —
 * the same condition under which the run's gate requests answer "no gates".
 */
export function toolManifest(job: BoardJob): ToolSpec[] {
    if (!job.gates || !checkoutKey(job)) return [];
    const gates = job.gates.gates.map(
        (gate): GateTool => ({
            id: `gate:${gate.name}`,
            name: gate.name,
            kind: 'command',
            verdict: true,
            required: gate.onDemand ? 'on_demand' : 'finish',
            filter: gate.filter === true,
            timeout: gate.timeoutMinutes ?? null,
        })
    );
    const exec: ExecTool = { id: 'exec', name: 'exec', kind: 'command', verdict: false, timeout: AD_HOC_MAX_MINUTES };
    return [...gates, exec];
}

/** The manifest's tool with this id, or null. */
export function toolOf(manifest: readonly ToolSpec[], id: string): ToolSpec | null {
    return manifest.find((tool) => tool.id === id) ?? null;
}
