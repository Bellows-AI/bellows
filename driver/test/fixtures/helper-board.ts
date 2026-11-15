import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The fake board the runner's tracker helpers (factory-jira, factory-linear) talk to: the connection list, the
 * credential broker, and the operation receipts as a state machine with the board's transition rules
 * (server/src/routes/operation-receipts.ts), plus scripted faults. A node http server on 127.0.0.1.
 */

export type Json = Record<string, unknown>;

export const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        let text = '';
        req.on('data', (chunk) => {
            text += chunk;
        });
        req.on('end', () => resolve(text));
    });

export const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
};

export const listen = (server: Server): Promise<string> =>
    new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });

export type Status = 'started' | 'dispatched' | 'succeeded' | 'failed' | 'unknown';
export interface Receipt {
    id: string;
    status: Status;
    result: { commentId: string } | null;
    dispatchedAt: string | null;
    key: string;
    fingerprint: string;
    connectionId: string;
    provider: string;
}
const ALLOWED: Record<string, Status[]> = {
    started: ['dispatched', 'failed'],
    dispatched: ['succeeded', 'failed', 'unknown'],
    unknown: ['succeeded'],
};

/** A fake board for one attempt pair; `issue` is the broker's answer for a connection credential. */
export function fakeBoard(getConnections: () => unknown, pair: { job: string; lease: string; issue: () => Json }) {
    const state = {
        receipts: new Map<string, Receipt>(),
        listFailures: 0,
        listAlwaysFails: false,
        /** The pair one claim back: answered 503 LEASE_PENDING, as a takeover window does. */
        supersededLease: null as string | null,
        beginAlwaysFails: false,
        conflictOnDispatch: false,
        moves: [] as { from: Status[]; to: Status }[],
        brokerAsks: 0,
        issued: 0,
    };
    const publicOf = ({ id, status, result, dispatchedAt }: Receipt) => ({ id, status, result, dispatchedAt });
    const { job } = pair;
    const server = createServer(async (req, res) => {
        const raw = await readBody(req);
        const path = new URL(req.url ?? '', 'http://x').pathname;
        if (state.supersededLease && req.headers['x-factory-job-lease-token'] === state.supersededLease) {
            return send(res, 503, { error: 'moved', code: 'LEASE_PENDING', retryable: true });
        }
        if (req.headers['x-factory-job-id'] !== job || req.headers['x-factory-job-lease-token'] !== pair.lease) {
            return send(res, 401, { error: 'pair' });
        }
        if (req.method === 'GET' && path === `/api/jobs/${job}/credentials/connections`) {
            if (state.listAlwaysFails || state.listFailures > 0) {
                state.listFailures--;
                return send(res, 503, { error: 'later' });
            }
            return send(res, 200, { connections: getConnections() });
        }
        if (req.method === 'POST' && path.startsWith(`/api/jobs/${job}/credentials/connections/`)) {
            state.brokerAsks++;
            return send(res, 200, pair.issue());
        }
        if (req.method === 'POST' && path === `/api/jobs/${job}/operations`) {
            if (state.beginAlwaysFails) return send(res, 503, { error: 'later' });
            const body = JSON.parse(raw) as {
                connectionId: string;
                provider: string;
                key: string;
                fingerprint: string;
            };
            const existing = state.receipts.get(body.key);
            if (existing) {
                if (existing.fingerprint !== body.fingerprint || existing.connectionId !== body.connectionId) {
                    return send(res, 409, { code: 'OPERATION_KEY_REUSED' });
                }
                return send(res, 200, { receipt: publicOf(existing), created: false });
            }
            const made: Receipt = {
                id: `55555555-5555-4555-8555-${String(state.issued++).padStart(12, '0')}`,
                status: 'started',
                result: null,
                dispatchedAt: null,
                ...body,
            };
            state.receipts.set(body.key, made);
            return send(res, 200, { receipt: publicOf(made), created: true });
        }
        const move = /\/operations\/([0-9a-f-]+)$/.exec(path);
        if (req.method === 'PUT' && move) {
            const body = JSON.parse(raw) as { from: Status[]; to: Status; result?: { commentId: string } };
            state.moves.push({ from: body.from, to: body.to });
            const receipt = [...state.receipts.values()].find((r) => r.id === move[1]);
            if (!receipt) return send(res, 404, { error: 'none' });
            const refuse = state.conflictOnDispatch && body.to === 'dispatched';
            if (refuse || !body.from.includes(receipt.status) || !ALLOWED[receipt.status]?.includes(body.to)) {
                return send(res, 409, { code: 'OPERATION_CONFLICT', receipt: publicOf(receipt) });
            }
            receipt.status = body.to;
            if (body.to === 'dispatched') receipt.dispatchedAt = new Date().toISOString();
            if (body.result) receipt.result = body.result;
            return send(res, 200, { receipt: publicOf(receipt) });
        }
        return send(res, 404, { error: 'unknown' });
    });
    return { state, server };
}
