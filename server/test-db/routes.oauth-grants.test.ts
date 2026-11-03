import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import {
    approveCode,
    codeForm,
    otherMember,
    startBoard,
    tokenRequest,
    type Board,
    type TokenBody,
} from './oauth-http-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const GRANTS = '/api/oauth/grants';

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});
const boards: Board[] = [];
afterEach(async () => {
    for (const board of boards.splice(0)) await board.app.close();
});
const start = async (orgId = ORG) => {
    const board = await startBoard(sql, orgId);
    boards.push(board);
    return board;
};

/** A full grant through the HTTP surface; answers the token pair. */
const connect = async (board: Board): Promise<TokenBody> => {
    const code = await approveCode(board);
    return (await tokenRequest(board, codeForm(board, code))).json() as TokenBody;
};
const listOf = async (board: Board, cookie = board.cookie) => {
    const response = await board.app.inject({ method: 'GET', url: GRANTS, headers: { cookie } });
    return { status: response.statusCode, grants: (response.json() as { grants: Record<string, unknown>[] }).grants };
};
const revoke = (board: Board, id: string, cookie = board.cookie) =>
    board.app.inject({ method: 'POST', url: `${GRANTS}/${id}/revoke`, headers: { cookie } });

describe.skipIf(!enabled)('the connected-apps API', () => {
    it("lists the caller's own grants with the client's identity, scopes and times, and no secret", async () => {
        const board = await start();
        await connect(board);
        const { status, grants } = await listOf(board);
        expect(status).toBe(HTTP_OK);
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({
            client: { id: board.world.clientId, name: 'Test client', kind: 'dcr' },
            scopes: ['factory:read'],
        });
        expect(typeof grants[0]?.createdAt).toBe('string');
        expect(typeof grants[0]?.lastUsedAt).toBe('string');
        expect(JSON.stringify(grants)).not.toMatch(/mat_|mrt_|token/i);
    });

    it('shows a member nothing of another member, and an empty list is an empty list', async () => {
        const board = await start();
        await connect(board);
        const other = await otherMember(board);
        expect(await listOf(board, other.cookie)).toEqual({ status: HTTP_OK, grants: [] });
    });

    it('revokes the own family: it leaves the list and its access token stops resolving', async () => {
        const board = await start();
        const token = await connect(board);
        const [grant] = (await listOf(board)).grants;
        const revoked = await revoke(board, String(grant?.id));
        expect(revoked.statusCode).toBe(HTTP_OK);
        expect((await listOf(board)).grants).toEqual([]);
        const refresh = await tokenRequest(board, {
            grant_type: 'refresh_token',
            refresh_token: token.refresh_token,
            client_id: board.world.clientId,
        });
        expect(refresh.statusCode).toBe(400);
    });

    it("answers 404 for another member's family, an unknown id and a revoked one", async () => {
        const board = await start();
        await connect(board);
        const [grant] = (await listOf(board)).grants;
        const other = await otherMember(board);
        expect((await revoke(board, String(grant?.id), other.cookie)).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await listOf(board)).grants).toHaveLength(1);
        expect((await revoke(board, 'not-a-uuid')).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await revoke(board, randomUUID())).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await revoke(board, String(grant?.id))).statusCode).toBe(HTTP_OK);
        expect((await revoke(board, String(grant?.id))).statusCode).toBe(HTTP_NOT_FOUND);
    });

    it("keeps another org's family out of the list and out of reach", async () => {
        const board = await start();
        await connect(board);
        const [grant] = (await listOf(board)).grants;
        // A member of a second org holds its own session there and sees none of the first org's grants.
        const elsewhere = await start(OTHER_ORG);
        expect((await listOf(elsewhere)).grants).toEqual([]);
        expect((await revoke(elsewhere, String(grant?.id))).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await listOf(board)).grants).toHaveLength(1);
    });

    it('is the cookie session only: no session, an MCP token or a personal token is refused', async () => {
        const board = await start();
        const token = await connect(board);
        const [grant] = (await listOf(board)).grants;
        for (const headers of [
            {},
            { authorization: `Bearer ${token.access_token}` },
            { authorization: 'Bearer fat_x' },
        ]) {
            const read = await board.app.inject({ method: 'GET', url: GRANTS, headers });
            const write = await board.app.inject({
                method: 'POST',
                url: `${GRANTS}/${String(grant?.id)}/revoke`,
                headers,
            });
            expect([read.statusCode, write.statusCode], JSON.stringify(headers)).toEqual([
                HTTP_UNAUTHORIZED,
                HTTP_UNAUTHORIZED,
            ]);
        }
        expect((await listOf(board)).grants).toHaveLength(1);
    });
});
