import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The opencode session database the readout and transcript-export suites run their scripts
 * against: the per-MEMBER sqlite file two concurrent tasks share, so every suite seeds the
 * two-task contamination shape — the older OTHER task's session and MINE, the newer one.
 */
export const MINE = '/workspaces/org/member/.worktrees/mine';
export const OTHER = '/workspaces/org/member/.worktrees/other';

const OTHER_SESSION_CREATED = 1000;
const MINE_SESSION_CREATED = 2000;

/** One root session row, with the columns the scripts read. */
export const insertSession = (db: DatabaseSync, id: string, directory: string, created: number): void => {
    db.prepare('insert into session (id, parent_id, directory, time_created) values (?, null, ?, ?)').run(
        id,
        directory,
        created
    );
};

/** One message row; `data` is the JSON blob the scripts read fields out of. Answers its rowid. */
export const insertMessage = (db: DatabaseSync, sessionId: string, data: object): number => {
    const result = db
        .prepare('insert into message (session_id, data) values (?, ?)')
        .run(sessionId, JSON.stringify(data));
    return Number(result.lastInsertRowid);
};

/** One text part of a message. */
export const insertPart = (db: DatabaseSync, messageId: number, sessionId: string, text: string): void => {
    db.prepare('insert into part (message_id, session_id, data) values (?, ?, ?)').run(
        messageId,
        sessionId,
        JSON.stringify({ type: 'text', text })
    );
};

/**
 * Creates a fresh database under a `prefix` temp dir and seeds the two-task shape: OTHER's
 * session (with `otherMessage`), then MINE's, newer and empty. `parts` adds the part table up front.
 * Answers the database path.
 */
export function seedOpencodeDb(prefix: string, otherMessage: object, parts = false): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    const dbPath = join(dir, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec('create table session (id text primary key, parent_id text, directory text, time_created integer)');
    db.exec('create table message (id integer primary key, session_id text, data text)');
    if (parts) db.exec('create table part (id integer primary key, message_id integer, session_id text, data text)');
    // The other task's session is the OLDER one; a newest-root-session scrape would answer it
    // for both tasks, which is the contamination the directory scope exists to end.
    insertSession(db, 'ses_other', OTHER, OTHER_SESSION_CREATED);
    insertMessage(db, 'ses_other', otherMessage);
    // This task's, newer — the one the scripts must answer.
    insertSession(db, 'ses_mine', MINE, MINE_SESSION_CREATED);
    db.close();
    return dbPath;
}
