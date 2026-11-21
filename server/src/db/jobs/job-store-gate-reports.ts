import type { TransactionSql } from 'postgres';
import { gateOutputTail, isStoredVerdict } from '../gate-report.js';
import type { GateReport, LastGateReport } from './job-store-types.js';

/** What a claim reads of the thread's stored gate reports (BEL-505). */
export interface ThreadGateReports {
    /** The `gates` the followed-up row stored; null when this row follows nothing or the parent stored none. */
    parent: GateReport[] | null;
    /** The latest passed or failed report per gate name across the thread's earlier rows, oldest gate first. */
    last: LastGateReport[];
}

/** The thread's rows before `jobId` that stored a gate report, oldest first, and what they say. */
export async function readThreadGateReports(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string,
    row: { id: string; parent_job_id: string | null }
): Promise<ThreadGateReports> {
    const rows = await tx<{ id: string; gates: GateReport[] }[]>`
        select j.id, j.gates
        from job j, job self
        where self.org_id = ${orgId} and self.id = ${row.id}
          and j.org_id = ${orgId} and j.root_job_id = ${rootJobId}
          and j.id <> self.id and j.created_at <= self.created_at
          and j.gates is not null
        order by j.created_at, j.id
    `;
    const latest = new Map<string, LastGateReport>();
    for (const stored of rows) {
        for (const gate of stored.gates.filter(isStoredVerdict)) {
            latest.set(gate.name, {
                name: gate.name,
                status: gate.status,
                exitCode: gate.exitCode,
                output: gate.output === null ? null : gateOutputTail(gate),
            });
        }
    }
    return {
        parent: rows.find((stored) => stored.id === row.parent_job_id)?.gates ?? null,
        last: [...latest.values()],
    };
}
