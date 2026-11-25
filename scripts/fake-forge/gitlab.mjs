// gitlab.com's OAuth and REST v4 surface, as far as the board's GitLab integration reaches: sign-in with rotating
// refresh tokens, projects with permissions, branches and files, merge requests, discussions, pipelines and commit
// statuses, project hooks. Plugged into server.mjs, which owns the token table, the clock and the call log.
// Routes live under GitLab's own prefixes (`/oauth`, `/api/v4`), so GitHub's never collide with them.
// The `/_control/gitlab/*` routes are the lane's door: seed projects, set member levels, set pipeline and merge
// status, fire a hook event, register OAuth clients, set the instance version, inject faults. Repositories are gitlab-repo.mjs's: bare git repos that git smart-HTTP serves too,
// behind HTTP Basic `oauth2:<token>`.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRepos, GIT_ISOLATION } from './gitlab-repo.mjs';

/** An OAuth access token's lifetime on GitLab (Doorkeeper's `access_token_expires_in`). */
export const GITLAB_TOKEN_TTL_S = 2 * 3600;
/** An authorization code's lifetime (Doorkeeper's `authorization_code_expires_in`). */
export const GITLAB_CODE_TTL_S = 600;
const DEFAULT_SCOPE = 'api';
/** The scopes gitlab.com offers an OAuth application; a registered client is limited to the ones it was given. */
const KNOWN_SCOPES = [
    'api',
    'read_api',
    'read_user',
    'read_repository',
    'write_repository',
    'read_registry',
    'write_registry',
    'openid',
    'profile',
    'email',
];
const DEFAULT_MEMBER = 'lane-member';
const USER_ID_BASE = 8000;
const UNAUTHORIZED = { message: '401 Unauthorized' };
const DEFAULT_VERSION = '17.4.0';
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
const oauthError = (error, error_description) => ({ error, error_description });
const CLIENT_ERROR = { error: 'invalid_client', error_description: 'Client authentication failed.' };
const MALFORMED_BODY = '<html>not json';
const API = '/api/v4';
const HOOK_TIMEOUT_MS = 5000;
/** One deadline for a whole git request, clone and push included. */
const GIT_DEADLINE_MS = 120_000;
const GIT_PATH = /^\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_REALM = 'Basic realm="GitLab"';

/** GitLab's access levels. A member with no entry is a Maintainer, so a test that sets nothing can do everything. */
const GUEST = 10;
const REPORTER = 20;
const DEVELOPER = 30;
const MAINTAINER = 40;

const STATUS_STATES = ['pending', 'running', 'success', 'failed', 'canceled', 'skipped'];
const UNFINISHED = ['created', 'pending', 'running'];
const HOOK_EVENTS = {
    push: { flag: 'push_events', header: 'Push Hook' },
    merge_request: { flag: 'merge_requests_events', header: 'Merge Request Hook' },
    note: { flag: 'note_events', header: 'Note Hook' },
    pipeline: { flag: 'pipeline_events', header: 'Pipeline Hook' },
};
const DRAFT_TITLE = /^\s*(?:\[draft\]|\(draft\)|draft:)/i;
const SEED_AUTHOR = { name: 'Lane Seed', email: 'seed@users.example.test' };
const GRANT_ERROR = {
    error: 'invalid_grant',
    error_description:
        'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.',
};

const flag = (value) => value === true || value === 'true';
const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const emailOf = (login) => `${login}@users.example.test`;
const authorOf = (login) => ({ name: login, email: emailOf(login) });

export const registerGitlab = (forge) => {
    const repos = createRepos(join(forge.stateDir, 'repos'));
    const pushes = [];
    /** authorization code -> the login it was issued to */
    const codes = new Map();
    /** access and refresh token -> the pair they belong to; both die together */
    const pairs = new Map();
    const projects = new Map(); // id -> project
    const userIds = new Map(); // login -> id
    const pipelines = [];
    /** client id -> { secret, redirectUris, scopes }; empty means any client is accepted */
    const clients = new Map();
    /** group full path -> its stable id, minted with the first project under it */
    const groups = new Map();
    const faults = [];
    let version = DEFAULT_VERSION;
    const now = () => new Date(forge.clock()).toISOString();

    const userId = (login) => {
        if (!userIds.has(login)) userIds.set(login, USER_ID_BASE + userIds.size + 1);
        return userIds.get(login);
    };
    const userJson = (login) => ({
        id: userId(login),
        username: login,
        name: login,
        state: 'active',
        email: emailOf(login),
        web_url: `https://gitlab.test/${login}`,
    });

    // --- OAuth ---

    const issuePair = (login, clientId = null, scope = DEFAULT_SCOPE) => {
        const id = forge.nextId();
        const pair = { access: `gloas-fake${id}`, refresh: `glrt-fake${id}`, login, clientId, scope };
        forge.tokens.set(pair.access, { kind: 'user', login, expiresAt: forge.clock() + GITLAB_TOKEN_TTL_S * 1000 });
        pairs.set(pair.access, pair);
        pairs.set(pair.refresh, pair);
        return {
            access_token: pair.access,
            token_type: 'Bearer',
            expires_in: GITLAB_TOKEN_TTL_S,
            refresh_token: pair.refresh,
            scope: pair.scope,
            created_at: Math.floor(forge.clock() / 1000),
        };
    };
    const killPair = (pair) => {
        forge.tokens.delete(pair.access);
        pairs.delete(pair.access);
        pairs.delete(pair.refresh);
    };

    forge.route(
        'GET',
        '/oauth/authorize',
        ({ response, query }) => {
            // Doorkeeper's order: the client and the redirect URI first, with a plain error page when either is wrong
            // (nothing to redirect to safely); the rest come back on the redirect as `error=`.
            const client = clients.get(query.client_id);
            if (clients.size > 0 && !client) return forge.json(response, 401, CLIENT_ERROR);
            let target;
            try {
                target = new URL(query.redirect_uri);
            } catch {
                return forge.json(response, 400, oauthError('invalid_request', 'The redirect URI is missing or invalid.'));
            }
            if (client && !client.redirectUris.includes(query.redirect_uri)) {
                return forge.json(
                    response,
                    400,
                    oauthError('invalid_redirect_uri', 'The requested redirect uri is malformed or doesn\'t match client redirect URI.')
                );
            }
            const redirect = (params) => {
                for (const [key, value] of Object.entries({ ...params, state: query.state }))
                    if (value !== undefined) target.searchParams.set(key, value);
                response.writeHead(302, { location: target.toString() });
                response.end();
            };
            if (query.response_type !== 'code') {
                return query.response_type === undefined
                    ? redirect(oauthError('invalid_request', 'The request is missing a required parameter, includes an unsupported parameter value, or is otherwise malformed.'))
                    : redirect(oauthError('unsupported_response_type', 'The authorization server does not support this response type.'));
            }
            const scope = query.scope ?? DEFAULT_SCOPE;
            const allowed = client ? client.scopes : KNOWN_SCOPES;
            if (scope.split(' ').some((one) => !allowed.includes(one))) {
                return redirect(oauthError('invalid_scope', 'The requested scope is invalid, unknown, or malformed.'));
            }
            const code = `code${forge.nextId()}`;
            codes.set(code, {
                login: query.login ?? DEFAULT_MEMBER,
                clientId: query.client_id ?? null,
                redirectUri: query.redirect_uri,
                scope,
                expiresAt: forge.clock() + GITLAB_CODE_TTL_S * 1000,
            });
            redirect({ code });
        },
        { auth: false }
    );
    // GitLab answers a bad grant with 400 and an `error` field.
    forge.route(
        'POST',
        '/oauth/token',
        ({ response, body }) => {
            if (clients.size > 0 && !(clients.has(body.client_id) && clients.get(body.client_id).secret === body.client_secret)) {
                return forge.json(response, 401, CLIENT_ERROR);
            }
            const missing = (field) => forge.json(response, 400, oauthError('invalid_request', `The ${field} is missing.`));
            if (body.grant_type === 'refresh_token') {
                if (!body.refresh_token) return missing('refresh_token');
                const pair = pairs.get(body.refresh_token);
                if (!pair || pair.refresh !== body.refresh_token || (clients.size > 0 && pair.clientId !== body.client_id)) {
                    return forge.json(response, 400, GRANT_ERROR);
                }
                killPair(pair);
                return forge.json(response, 200, issuePair(pair.login, pair.clientId, pair.scope));
            }
            if (body.grant_type !== 'authorization_code') {
                return forge.json(
                    response,
                    400,
                    oauthError('unsupported_grant_type', 'The authorization grant type is not supported by the authorization server.')
                );
            }
            if (!body.code) return missing('code');
            const issued = codes.get(body.code);
            const refused =
                issued === undefined ||
                issued.expiresAt <= forge.clock() ||
                issued.redirectUri !== body.redirect_uri ||
                (clients.size > 0 && issued.clientId !== body.client_id);
            if (refused) {
                if (issued?.expiresAt <= forge.clock()) codes.delete(body.code);
                return forge.json(response, 400, GRANT_ERROR);
            }
            codes.delete(body.code);
            forge.json(response, 200, issuePair(issued.login, issued.clientId, issued.scope));
        },
        { auth: false }
    );
    forge.route(
        'POST',
        '/oauth/revoke',
        ({ response, body }) => {
            const pair = pairs.get(body.token);
            if (pair) killPair(pair);
            forge.json(response, 200, {});
        },
        { auth: false }
    );

    // --- routing helpers ---

    /** Answer the call with the first armed fault its path matches; true when it did, and the handler must not run. */
    const faulted = ({ url, response }) => {
        const fault = faults.find((entry) => url.pathname.includes(entry.pathIncludes));
        if (!fault) return false;
        if (fault.remaining !== null && --fault.remaining <= 0) faults.splice(faults.indexOf(fault), 1);
        if (fault.mode === 'status') forge.json(response, fault.status, { message: `${fault.status} injected fault` });
        else if (fault.mode === 'malformed') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(MALFORMED_BODY);
        }
        return true; // timeout: the call is never answered
    };
    const route = (method, pattern, handler, options = {}) =>
        forge.route(method, `${API}${pattern}`, handler, {
            deny: UNAUTHORIZED,
            before: faulted,
            ...options,
        });
    const control = (pattern, handler) =>
        forge.route('POST', `/_control/gitlab/${pattern}`, handler, { auth: false });
    const notFound = (response, what = 'Not found') => forge.json(response, 404, { message: `404 ${what}` });
    const badRequest = (response, message) => forge.json(response, 400, { message });
    const inputs = (ctx) => ({ ...ctx.query, ...ctx.body });
    const origin = (request) => `http://${request.headers.host}`;

    const projectOf = (key) => {
        const text = String(key);
        if (/^\d+$/.test(text)) return projects.get(Number(text));
        return [...projects.values()].find((project) => project.path === text);
    };
    /** The level `login` holds on the project: the better of its project and group membership; 0 is no access. */
    const levelOf = (project, login) => {
        const held = project.members.get(login) ?? { project: MAINTAINER, group: null };
        return Math.max(held.project ?? 0, held.group ?? 0);
    };
    /** The project the call names, once the holder's level covers `level`; otherwise the answer is sent and this is null. */
    const guard = (ctx, level) => {
        const project = projectOf(ctx.params.id);
        const held = project ? levelOf(project, ctx.token.login) : 0;
        if (held < GUEST) return notFound(ctx.response, 'Project Not Found'), null;
        if (held < level) return forge.json(ctx.response, 403, { message: '403 Forbidden' }), null;
        return project;
    };
    const access = (level) => (level === null ? null : { access_level: level, notification_level: 3 });

    /** `Entities::Project` omits `permissions`; only a single-project request (`ProjectWithAccess`) adds it. */
    const projectJson = (project, login, request, { withPermissions = false } = {}) => {
        const held = project.members.get(login) ?? { project: MAINTAINER, group: null };
        const namespace = project.path.split('/').slice(0, -1).join('/');
        return {
            id: project.id,
            name: project.name,
            path: project.name,
            path_with_namespace: project.path,
            default_branch: project.defaultBranch,
            visibility: 'private',
            namespace: { id: groups.get(namespace)?.id ?? null, name: namespace.split('/').pop(), path: namespace, full_path: namespace, kind: 'group' },
            web_url: `${origin(request)}/${project.path}`,
            http_url_to_repo: `${origin(request)}/${project.path}.git`,
            squash_option: project.squashOption,
            only_allow_merge_if_pipeline_succeeds: project.onlyPipeline,
            only_allow_merge_if_all_discussions_are_resolved: project.onlyDiscussions,
            ...(withPermissions ? { permissions: { project_access: access(held.project), group_access: access(held.group) } } : {}),
        };
    };

    route('GET', '/version', ({ response }) => forge.json(response, 200, { version, revision: 'fake0000' }));
    route('GET', '/user', ({ response, token }) => forge.json(response, 200, userJson(token.login)));
    route('GET', '/projects/:id', (ctx) => {
        const project = guard(ctx, GUEST);
        if (project) forge.json(ctx.response, 200, projectJson(project, ctx.token.login, ctx.request, { withPermissions: true }));
    });

    // --- groups ---

    const ancestors = (path) => {
        const parts = path.split('/').slice(0, -1);
        return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    };
    const namespaceOf = (project) => project.path.split('/').slice(0, -1).join('/');
    const ensureGroups = (path) => {
        for (const group of ancestors(path)) if (!groups.has(group)) groups.set(group, { id: forge.nextId() });
    };
    /** The group's full path by its id or its path; a group the caller holds no project under is as good as absent. */
    const groupOf = (key, login) => {
        const text = String(key);
        const found = /^\d+$/.test(text)
            ? [...groups].find(([, group]) => group.id === Number(text))?.[0]
            : groups.has(text) ? text : undefined;
        const seen = (project) => levelOf(project, login) >= GUEST && ancestors(`${project.path}`).includes(found);
        return found && [...projects.values()].some(seen) ? found : undefined;
    };
    const pageUrl = (ctx, number, per) => {
        const url = new URL(ctx.url);
        url.searchParams.set('page', String(number));
        url.searchParams.set('per_page', String(per));
        return `${origin(ctx.request)}${url.pathname}${url.search}`;
    };
    const page = (ctx, items) => {
        const per = Math.min(Math.max(Number(ctx.query.per_page) || DEFAULT_PER_PAGE, 1), MAX_PER_PAGE);
        const current = Math.max(Number(ctx.query.page) || 1, 1);
        const last = Math.max(Math.ceil(items.length / per), 1);
        const next = current < last ? String(current + 1) : '';
        const prev = current > 1 ? String(current - 1) : '';
        const links = [['first', 1], ...(prev ? [['prev', current - 1]] : []), ...(next ? [['next', current + 1]] : []), ['last', last]];
        ctx.response.writeHead(200, {
            'content-type': 'application/json',
            'x-page': String(current),
            'x-per-page': String(per),
            'x-next-page': next,
            'x-prev-page': prev,
            'x-total': String(items.length),
            'x-total-pages': String(last),
            link: links.map(([rel, number]) => `<${pageUrl(ctx, number, per)}>; rel="${rel}"`).join(', '),
        });
        ctx.response.end(JSON.stringify(items.slice((current - 1) * per, current * per)));
    };
    route('GET', '/groups/:id/projects', (ctx) => {
        const group = groupOf(ctx.params.id, ctx.token.login);
        if (!group) return notFound(ctx.response, 'Group Not Found');
        const { include_subgroups: subgroups, min_access_level: min = 0 } = ctx.query;
        const visible = [...projects.values()]
            .filter((project) => {
                const namespace = namespaceOf(project);
                return namespace === group || (flag(subgroups) && namespace.startsWith(`${group}/`));
            })
            .filter((project) => levelOf(project, ctx.token.login) >= Math.max(GUEST, Number(min)))
            .sort((a, b) => a.id - b.id);
        page(ctx, visible.map((project) => projectJson(project, ctx.token.login, ctx.request)));
    });

    // --- branches and files ---

    const branchJson = (project, branch, request) => ({
        name: branch.name,
        merged: false,
        protected: false,
        developers_can_push: false,
        developers_can_merge: false,
        can_push: true,
        default: branch.name === project.defaultBranch,
        web_url: `${origin(request)}/${project.path}/-/tree/${branch.name}`,
        commit: {
            id: branch.sha,
            short_id: branch.sha.slice(0, 8),
            title: branch.message.split('\n')[0],
            message: branch.message,
            author_name: branch.author.name,
            author_email: branch.author.email,
            authored_date: branch.date,
            committer_name: branch.author.name,
            committer_email: branch.author.email,
            committed_date: branch.date,
        },
    });
    const branches = `/projects/:id/repository/branches`;
    route('GET', branches, async (ctx) => {
        const project = guard(ctx, GUEST);
        if (!project) return;
        const search = ctx.query.search;
        const all = await repos.branches(project.id);
        forge.json(
            ctx.response,
            200,
            all.filter((branch) => !search || branch.name.includes(search)).map((branch) => branchJson(project, branch, ctx.request))
        );
    });
    route('GET', `${branches}/:branch`, async (ctx) => {
        const project = guard(ctx, GUEST);
        if (!project) return;
        const branch = await repos.branch(project.id, ctx.params.branch);
        if (!branch) return notFound(ctx.response, 'Branch Not Found');
        forge.json(ctx.response, 200, branchJson(project, branch, ctx.request));
    });
    route('POST', branches, async (ctx) => {
        const project = guard(ctx, DEVELOPER);
        if (!project) return;
        const { branch: name, ref } = inputs(ctx);
        if (!name) return badRequest(ctx.response, '400 (Bad request) "branch" not given');
        if (await repos.branch(project.id, name)) return badRequest(ctx.response, 'Branch already exists');
        const created = ref ? await repos.createBranch(project.id, name, ref) : null;
        if (!created) return badRequest(ctx.response, `Invalid reference name: ${ref}`);
        forge.json(ctx.response, 201, branchJson(project, created, ctx.request));
    });
    route('DELETE', `${branches}/:branch`, async (ctx) => {
        const project = guard(ctx, DEVELOPER);
        if (!project) return;
        if (!(await repos.deleteBranch(project.id, ctx.params.branch))) return notFound(ctx.response, 'Branch Not Found');
        ctx.response.writeHead(204).end();
    });

    const fileOf = async (ctx) => {
        const project = guard(ctx, GUEST);
        if (!project) return null;
        if (!ctx.query.ref) return badRequest(ctx.response, '400 (Bad request) "ref" not given'), null;
        const file = await repos.file(project.id, ctx.query.ref, ctx.params.path);
        if (!file) return notFound(ctx.response, 'File Not Found'), null;
        return file;
    };
    const files = '/projects/:id/repository/files/:path';
    route('GET', files, async (ctx) => {
        const file = await fileOf(ctx);
        if (!file) return;
        forge.json(ctx.response, 200, {
            file_name: ctx.params.path.split('/').pop(),
            file_path: ctx.params.path,
            size: file.content.length,
            encoding: 'base64',
            content: file.content.toString('base64'),
            content_sha256: createHash('sha256').update(file.content).digest('hex'),
            ref: ctx.query.ref,
            blob_id: file.blobId,
            commit_id: file.commitId,
            last_commit_id: file.commitId,
            execute_filemode: false,
        });
    });
    route('GET', `${files}/raw`, async (ctx) => {
        const file = await fileOf(ctx);
        if (!file) return;
        ctx.response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        ctx.response.end(file.content);
    });

    // --- merge requests ---

    const userOfLogin = (login) => (login ? userJson(login) : null);
    const hasUnresolved = (mr) =>
        mr.discussions.some((thread) => thread.notes.some((note) => note.resolvable && !note.resolved));
    const pipelineJson = (pipeline, request) => ({
        id: pipeline.id,
        iid: pipeline.iid,
        project_id: pipeline.projectId,
        status: pipeline.status,
        source: pipeline.source,
        ref: pipeline.ref,
        sha: pipeline.sha,
        web_url: `${origin(request)}/${projects.get(pipeline.projectId).path}/-/pipelines/${pipeline.id}`,
        created_at: pipeline.createdAt,
        updated_at: pipeline.updatedAt,
    });
    const headPipeline = (project, sha) =>
        pipelines.findLast((pipeline) => pipeline.projectId === project.id && pipeline.sha === sha) ?? null;
    /** The source branch's head, or the last one seen once the branch is gone. */
    const headSha = async (project, mr) => {
        const branch = await repos.branch(project.id, mr.source);
        if (branch) mr.lastSha = branch.sha;
        return mr.lastSha;
    };
    const mergeStatus = (project, mr, sha, { broken = false, conflict = false } = {}) => {
        if (mr.state !== 'opened') return 'not_open';
        if (mr.statusOverride) return mr.statusOverride;
        if (broken) return 'broken_status';
        if (DRAFT_TITLE.test(mr.title)) return 'draft_status';
        if (conflict) return 'conflict';
        if (project.onlyDiscussions && hasUnresolved(mr)) return 'discussions_not_resolved';
        if (project.onlyPipeline) {
            const head = headPipeline(project, sha);
            if (head && UNFINISHED.includes(head.status)) return 'ci_still_running';
            if (!head || head.status !== 'success') return 'ci_must_pass';
        }
        return 'mergeable';
    };
    /** Whether either branch is gone, and whether the source conflicts with the target; only an open MR is asked. */
    const mergeFacts = async (project, mr) => {
        if (mr.state !== 'opened') return {};
        const [source, target] = await Promise.all([repos.branch(project.id, mr.source), repos.branch(project.id, mr.target)]);
        if (!source || !target) return { broken: true };
        return { conflict: (await repos.mergeTree(project.id, mr.source, mr.target)) === null };
    };
    const mrJson = async (project, mr, request) => {
        const sha = await headSha(project, mr);
        const status = mergeStatus(project, mr, sha, await mergeFacts(project, mr));
        const head = headPipeline(project, sha);
        return {
            id: mr.id,
            iid: mr.iid,
            project_id: project.id,
            title: mr.title,
            description: mr.description,
            state: mr.state,
            draft: DRAFT_TITLE.test(mr.title),
            source_branch: mr.source,
            target_branch: mr.target,
            source_project_id: project.id,
            target_project_id: project.id,
            sha,
            merge_commit_sha: mr.mergeCommitSha,
            squash_commit_sha: mr.squashCommitSha,
            squash: mr.squash,
            author: userOfLogin(mr.author),
            merged_by: userOfLogin(mr.mergedBy),
            merged_at: mr.mergedAt,
            created_at: mr.createdAt,
            updated_at: mr.updatedAt,
            detailed_merge_status: status,
            merge_status: status === 'mergeable' ? 'can_be_merged' : 'cannot_be_merged',
            has_conflicts: status === 'conflict',
            blocking_discussions_resolved: !project.onlyDiscussions || !hasUnresolved(mr),
            head_pipeline: head ? pipelineJson(head, request) : null,
            web_url: `${origin(request)}/${project.path}/-/merge_requests/${mr.iid}`,
        };
    };
    const findMr = (ctx, project) => {
        const mr = project.mrs.find((candidate) => candidate.iid === Number(ctx.params.iid));
        if (!mr) notFound(ctx.response, 'Merge Request Not Found');
        return mr;
    };
    const openDuplicate = (project, mr, source, target) =>
        project.mrs.find((other) => other !== mr && other.state === 'opened' && other.source === source && other.target === target);
    const duplicateMessage = (response, other) =>
        forge.json(response, 409, {
            message: [`Another open merge request already exists for this source branch: !${other.iid}`],
        });

    const mrs = '/projects/:id/merge_requests';
    route('POST', mrs, async (ctx) => {
        const project = guard(ctx, DEVELOPER);
        if (!project) return;
        const { source_branch: source, target_branch: target, title, description } = inputs(ctx);
        if (!source || !target || !title) return badRequest(ctx.response, '400 (Bad request) "source_branch", "target_branch" and "title" are required');
        if (!(await repos.branch(project.id, source))) return badRequest(ctx.response, 'Source branch does not exist');
        if (!(await repos.branch(project.id, target))) return badRequest(ctx.response, 'Target branch does not exist');
        const existing = openDuplicate(project, null, source, target);
        if (existing) return duplicateMessage(ctx.response, existing);
        const mr = {
            id: forge.nextId(),
            iid: project.mrs.length + 1,
            title,
            description: description ?? '',
            state: 'opened',
            source,
            target,
            author: ctx.token.login,
            mergedBy: null,
            mergedAt: null,
            mergeCommitSha: null,
            squashCommitSha: null,
            squash: false,
            statusOverride: null,
            lastSha: null,
            discussions: [],
            createdAt: now(),
            updatedAt: now(),
        };
        project.mrs.push(mr);
        forge.json(ctx.response, 201, await mrJson(project, mr, ctx.request));
    });
    route('GET', mrs, async (ctx) => {
        const project = guard(ctx, GUEST);
        if (!project) return;
        const { source_branch: source, target_branch: target, state = 'all' } = ctx.query;
        const matching = project.mrs.filter(
            (mr) =>
                (!source || mr.source === source) && (!target || mr.target === target) && (state === 'all' || mr.state === state)
        );
        forge.json(ctx.response, 200, await Promise.all(matching.map((mr) => mrJson(project, mr, ctx.request))));
    });
    route('GET', `${mrs}/:iid`, async (ctx) => {
        const project = guard(ctx, GUEST);
        const mr = project && findMr(ctx, project);
        if (mr) forge.json(ctx.response, 200, await mrJson(project, mr, ctx.request));
    });
    route('PUT', `${mrs}/:iid`, async (ctx) => {
        const project = guard(ctx, DEVELOPER);
        const mr = project && findMr(ctx, project);
        if (!mr) return;
        const { title, description, target_branch: target, state_event: event } = inputs(ctx);
        if (event !== undefined && !['close', 'reopen'].includes(event)) return badRequest(ctx.response, '400 (Bad request) "state_event" does not have a valid value');
        if (mr.state === 'merged') return forge.json(ctx.response, 405, { message: '405 Method Not Allowed' });
        const nextTarget = target ?? mr.target;
        if (target !== undefined && !(await repos.branch(project.id, target))) return badRequest(ctx.response, 'Target branch does not exist');
        const reopening = event === 'reopen' && mr.state === 'closed';
        const open = event === 'close' ? false : reopening || mr.state === 'opened';
        const clash = open && openDuplicate(project, mr, mr.source, nextTarget);
        if (clash) return duplicateMessage(ctx.response, clash);
        if (title !== undefined) mr.title = title;
        if (description !== undefined) mr.description = description;
        mr.target = nextTarget;
        if (event) mr.state = open ? 'opened' : 'closed';
        mr.updatedAt = now();
        forge.json(ctx.response, 200, await mrJson(project, mr, ctx.request));
    });
    route('PUT', `${mrs}/:iid/merge`, async (ctx) => {
        const project = guard(ctx, DEVELOPER);
        const mr = project && findMr(ctx, project);
        if (!mr) return;
        if (mr.state !== 'opened') return forge.json(ctx.response, 405, { message: '405 Method Not Allowed' });
        const input = inputs(ctx);
        const sha = await headSha(project, mr);
        if (input.sha && input.sha !== sha) {
            return forge.json(ctx.response, 409, { message: `SHA does not match HEAD of source branch: ${sha}` });
        }
        const status = mergeStatus(project, mr, sha, await mergeFacts(project, mr));
        if (status !== 'mergeable') {
            return forge.json(ctx.response, status === 'conflict' ? 406 : 422, { message: 'Branch cannot be merged' });
        }
        const squash = project.squashOption === 'always' || (project.squashOption !== 'never' && flag(input.squash));
        const merged = await repos.merge(project.id, {
            source: mr.source,
            target: mr.target,
            squash,
            message: squash
                ? (input.squash_commit_message ?? mr.title)
                : (input.merge_commit_message ?? `Merge branch '${mr.source}' into '${mr.target}'\n\nSee merge request !${mr.iid}`),
            author: authorOf(ctx.token.login),
            date: now(),
        });
        if (!merged) return forge.json(ctx.response, 406, { message: 'Branch cannot be merged' });
        mr.state = 'merged';
        mr.squash = squash;
        mr.mergeCommitSha = merged;
        mr.squashCommitSha = squash ? merged : null;
        mr.mergedBy = ctx.token.login;
        mr.mergedAt = now();
        mr.updatedAt = now();
        if (flag(input.should_remove_source_branch)) await repos.deleteBranch(project.id, mr.source);
        forge.json(ctx.response, 200, await mrJson(project, mr, ctx.request));
    });

    // --- discussions and notes ---

    const noteJson = (mr, note) => ({
        id: note.id,
        type: note.resolvable ? 'DiscussionNote' : null,
        body: note.body,
        author: userJson(note.author),
        created_at: note.createdAt,
        updated_at: note.updatedAt,
        system: false,
        noteable_id: mr.id,
        noteable_type: 'MergeRequest',
        noteable_iid: mr.iid,
        resolvable: note.resolvable,
        resolved: note.resolved,
        resolved_by: userOfLogin(note.resolvedBy),
        confidential: false,
        internal: false,
    });
    const discussionJson = (mr, thread) => ({
        id: thread.id,
        individual_note: thread.individual,
        notes: thread.notes.map((note) => noteJson(mr, note)),
    });
    const newNote = (login, body, resolvable) => ({
        id: forge.nextId(),
        body,
        author: login,
        resolvable,
        resolved: false,
        resolvedBy: null,
        createdAt: now(),
        updatedAt: now(),
    });
    const openThread = (mr, login, body, individual) => {
        const thread = { id: sha1(`discussion:${forge.nextId()}`), individual, notes: [newNote(login, body, !individual)] };
        mr.discussions.push(thread);
        return thread;
    };
    const mutable = (ctx) => {
        const project = guard(ctx, REPORTER);
        const mr = project && findMr(ctx, project);
        return mr || null;
    };
    const findThread = (ctx, mr) => {
        const thread = mr.discussions.find((candidate) => candidate.id === ctx.params.discussion);
        if (!thread) notFound(ctx.response, 'Discussion Not Found');
        return thread;
    };
    const bodyOf = (ctx) => {
        const { body } = inputs(ctx);
        if (!body) badRequest(ctx.response, '400 (Bad request) "body" not given');
        return body;
    };

    const discussions = `${mrs}/:iid/discussions`;
    route('GET', discussions, (ctx) => {
        const project = guard(ctx, GUEST);
        const mr = project && findMr(ctx, project);
        if (mr) forge.json(ctx.response, 200, mr.discussions.map((thread) => discussionJson(mr, thread)));
    });
    route('GET', `${discussions}/:discussion`, (ctx) => {
        const project = guard(ctx, GUEST);
        const mr = project && findMr(ctx, project);
        const thread = mr && findThread(ctx, mr);
        if (thread) forge.json(ctx.response, 200, discussionJson(mr, thread));
    });
    route('POST', discussions, (ctx) => {
        const mr = mutable(ctx);
        const body = mr && bodyOf(ctx);
        if (body) forge.json(ctx.response, 201, discussionJson(mr, openThread(mr, ctx.token.login, body, false)));
    });
    route('POST', `${discussions}/:discussion/notes`, (ctx) => {
        const mr = mutable(ctx);
        const thread = mr && findThread(ctx, mr);
        const body = thread && bodyOf(ctx);
        if (!body) return;
        if (thread.individual) return badRequest(ctx.response, '400 Bad request - Note cannot be added to an individual discussion');
        const note = newNote(ctx.token.login, body, true);
        thread.notes.push(note);
        forge.json(ctx.response, 201, noteJson(mr, note));
    });
    route('PUT', `${discussions}/:discussion`, (ctx) => {
        const mr = mutable(ctx);
        const thread = mr && findThread(ctx, mr);
        if (!thread) return;
        const resolved = flag(inputs(ctx).resolved);
        for (const note of thread.notes.filter((entry) => entry.resolvable)) {
            note.resolved = resolved;
            note.resolvedBy = resolved ? ctx.token.login : null;
        }
        forge.json(ctx.response, 200, discussionJson(mr, thread));
    });

    const notes = `${mrs}/:iid/notes`;
    route('GET', notes, (ctx) => {
        const project = guard(ctx, GUEST);
        const mr = project && findMr(ctx, project);
        if (mr) forge.json(ctx.response, 200, mr.discussions.flatMap((thread) => thread.notes).map((note) => noteJson(mr, note)));
    });
    route('POST', notes, (ctx) => {
        const mr = mutable(ctx);
        const body = mr && bodyOf(ctx);
        if (body) forge.json(ctx.response, 201, noteJson(mr, openThread(mr, ctx.token.login, body, true).notes[0]));
    });
    route('PUT', `${notes}/:note`, (ctx) => {
        const mr = mutable(ctx);
        if (!mr) return;
        const note = mr.discussions.flatMap((thread) => thread.notes).find((entry) => entry.id === Number(ctx.params.note));
        if (!note) return notFound(ctx.response, 'Note Not Found');
        const { body, resolved } = inputs(ctx);
        if (body !== undefined) note.body = body;
        if (resolved !== undefined && note.resolvable) {
            note.resolved = flag(resolved);
            note.resolvedBy = note.resolved ? ctx.token.login : null;
        }
        note.updatedAt = now();
        forge.json(ctx.response, 200, noteJson(mr, note));
    });

    // --- pipelines and commit statuses ---

    const newPipeline = (project, { ref, sha, status, source }) => {
        const pipeline = {
            id: forge.nextId(),
            iid: pipelines.filter((entry) => entry.projectId === project.id).length + 1,
            projectId: project.id,
            ref,
            sha,
            status,
            source,
            createdAt: now(),
            updatedAt: now(),
        };
        pipelines.push(pipeline);
        return pipeline;
    };
    const foldStatuses = (statuses) => {
        const states = statuses.map((entry) => entry.status);
        for (const state of ['failed', 'running', 'pending', 'canceled']) if (states.includes(state)) return state;
        return states.every((state) => state === 'skipped') ? 'skipped' : 'success';
    };
    const statusJson = (entry) => ({
        id: entry.id,
        sha: entry.sha,
        ref: entry.ref,
        status: entry.status,
        name: entry.name,
        target_url: entry.targetUrl,
        description: entry.description,
        created_at: entry.createdAt,
        started_at: null,
        finished_at: null,
        allow_failure: false,
        coverage: null,
        author: userJson(entry.author),
    });

    const pipelinesPath = '/projects/:id/pipelines';
    route('GET', pipelinesPath, (ctx) => {
        const project = guard(ctx, GUEST);
        if (!project) return;
        const { ref, sha, status } = ctx.query;
        forge.json(
            ctx.response,
            200,
            pipelines
                .filter(
                    (entry) =>
                        entry.projectId === project.id &&
                        (!ref || entry.ref === ref) &&
                        (!sha || entry.sha === sha) &&
                        (!status || entry.status === status)
                )
                .reverse()
                .map((entry) => pipelineJson(entry, ctx.request))
        );
    });
    route('GET', `${pipelinesPath}/:pipeline`, (ctx) => {
        const project = guard(ctx, GUEST);
        if (!project) return;
        const found = pipelines.find((entry) => entry.projectId === project.id && entry.id === Number(ctx.params.pipeline));
        if (!found) return notFound(ctx.response, 'Not found');
        forge.json(ctx.response, 200, pipelineJson(found, ctx.request));
    });
    route('GET', `${mrs}/:iid/pipelines`, async (ctx) => {
        const project = guard(ctx, GUEST);
        const mr = project && findMr(ctx, project);
        if (!mr) return;
        const sha = await headSha(project, mr);
        const matching = pipelines.filter((entry) => entry.projectId === project.id && entry.sha === sha).reverse();
        forge.json(ctx.response, 200, matching.map((entry) => pipelineJson(entry, ctx.request)));
    });
    route('POST', '/projects/:id/statuses/:sha', async (ctx) => {
        const project = guard(ctx, DEVELOPER);
        if (!project) return;
        const input = inputs(ctx);
        if (!STATUS_STATES.includes(input.state)) {
            return badRequest(ctx.response, '400 (Bad request) "state" does not have a valid value');
        }
        const sha = await repos.resolve(project.id, ctx.params.sha);
        if (!sha) return notFound(ctx.response, 'Commit Not Found');
        const name = input.name ?? input.context ?? 'default';
        let entry = project.statuses.find((candidate) => candidate.sha === sha && candidate.name === name);
        if (!entry) {
            entry = { id: forge.nextId(), sha, name, createdAt: now() };
            project.statuses.push(entry);
        }
        Object.assign(entry, {
            status: input.state,
            ref: input.ref ?? entry.ref ?? null,
            targetUrl: input.target_url ?? null,
            description: input.description ?? null,
            author: ctx.token.login,
        });
        const status = foldStatuses(project.statuses.filter((candidate) => candidate.sha === sha));
        const external = pipelines.find((pipeline) => pipeline.projectId === project.id && pipeline.sha === sha && pipeline.source === 'external');
        if (external) Object.assign(external, { status, updatedAt: now() });
        else newPipeline(project, { ref: entry.ref ?? '', sha, status, source: 'external' });
        forge.json(ctx.response, 201, statusJson(entry));
    });
    route('GET', '/projects/:id/repository/commits/:sha/statuses', async (ctx) => {
        const project = guard(ctx, GUEST);
        if (!project) return;
        const sha = await repos.resolve(project.id, ctx.params.sha);
        if (!sha) return notFound(ctx.response, 'Commit Not Found');
        const { ref, name } = ctx.query;
        forge.json(
            ctx.response,
            200,
            project.statuses
                .filter((entry) => entry.sha === sha && (!ref || entry.ref === ref) && (!name || entry.name === name))
                .map(statusJson)
        );
    });

    // --- project hooks ---

    const hookJson = (project, hook) => ({
        id: hook.id,
        url: hook.url,
        project_id: project.id,
        push_events: hook.push_events,
        merge_requests_events: hook.merge_requests_events,
        note_events: hook.note_events,
        pipeline_events: hook.pipeline_events,
        enable_ssl_verification: true,
        created_at: hook.createdAt,
    });
    const hooks = '/projects/:id/hooks';
    const findHook = (ctx, project) => {
        const hook = project.hooks.find((entry) => entry.id === Number(ctx.params.hook));
        if (!hook) notFound(ctx.response, 'Not found');
        return hook;
    };
    route('GET', hooks, (ctx) => {
        const project = guard(ctx, MAINTAINER);
        if (project) forge.json(ctx.response, 200, project.hooks.map((hook) => hookJson(project, hook)));
    });
    route('POST', hooks, (ctx) => {
        const project = guard(ctx, MAINTAINER);
        if (!project) return;
        const input = inputs(ctx);
        if (!input.url) return badRequest(ctx.response, '400 (Bad request) "url" not given');
        const hook = {
            id: forge.nextId(),
            url: input.url,
            secret: input.token ?? null,
            push_events: input.push_events === undefined ? true : flag(input.push_events),
            merge_requests_events: flag(input.merge_requests_events),
            note_events: flag(input.note_events),
            pipeline_events: flag(input.pipeline_events),
            createdAt: now(),
        };
        project.hooks.push(hook);
        forge.json(ctx.response, 201, hookJson(project, hook));
    });
    route('GET', `${hooks}/:hook`, (ctx) => {
        const project = guard(ctx, MAINTAINER);
        const hook = project && findHook(ctx, project);
        if (hook) forge.json(ctx.response, 200, hookJson(project, hook));
    });
    route('DELETE', `${hooks}/:hook`, (ctx) => {
        const project = guard(ctx, MAINTAINER);
        const hook = project && findHook(ctx, project);
        if (!hook) return;
        project.hooks.splice(project.hooks.indexOf(hook), 1);
        ctx.response.writeHead(204).end();
    });

    // --- git smart-HTTP ---

    const refuse = (response, status, message, headers = {}) => {
        response.writeHead(status, { 'content-type': 'text/plain', ...headers });
        response.end(message);
    };
    /** Who pushed what: each ref that moved, with the commits it gained and who wrote and committed each. */
    const recordPush = async (project, ctx, before) => {
        const after = await repos.refs(project.id);
        const known = Object.values(before);
        const refs = [];
        for (const ref of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (before[ref] === after[ref]) continue;
            const commits = after[ref] ? await repos.newCommits(project.id, after[ref], known) : [];
            refs.push({ ref, before: before[ref] ?? null, after: after[ref] ?? null, commits });
        }
        if (refs.length === 0) return;
        const entry = {
            event: 'push',
            method: ctx.request.method,
            path: ctx.url.pathname,
            project: project.path,
            tokenKind: ctx.tokenKind,
            tokenId: forge.tokenId(ctx.credential),
            holder: ctx.token.login,
            refs,
            status: 200,
        };
        pushes.push(entry);
        forge.record(entry);
    };

    // The request goes to `git http-backend` as it arrives, body unread, and the answer comes back as git writes it.
    // The child dies with the client, on the deadline and on its own error; the response always settles.
    // Pushes to one project are expected one at a time: the refs are read before and after to say what moved.
    forge.stream(GIT_PATH, async (ctx) => {
        const { request, response, url, match } = ctx;
        const [, rawPath, service] = match;
        const project = projectOf(rawPath.split('/').map(decodeURIComponent).join('/'));
        const push = service === 'git-receive-pack' || url.searchParams.get('service') === 'git-receive-pack';
        if (!ctx.token) return refuse(response, 401, 'HTTP Basic: Access denied', { 'www-authenticate': GIT_REALM });
        const held = project ? levelOf(project, ctx.token.login) : 0;
        if (held < GUEST) return refuse(response, 404, 'Not Found');
        if (push && held < DEVELOPER) return refuse(response, 403, 'You are not allowed to push code to this project.');

        const recording = request.method === 'POST' && service === 'git-receive-pack';
        const before = recording ? await repos.refs(project.id) : {};
        const headers = request.headers;
        const child = spawn('git', ['http-backend'], {
            env: {
                PATH: process.env.PATH,
                ...GIT_ISOLATION,
                GIT_PROJECT_ROOT: repos.root,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: `/${project.id}.git/${service}`,
                REQUEST_METHOD: request.method,
                QUERY_STRING: url.search.slice(1),
                REMOTE_USER: ctx.token.login,
                REMOTE_ADDR: '127.0.0.1',
                ...(headers['content-type'] ? { CONTENT_TYPE: headers['content-type'] } : {}),
                ...(headers['content-length'] ? { CONTENT_LENGTH: headers['content-length'] } : {}),
                ...(headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: headers['content-encoding'] } : {}),
                ...(headers['git-protocol'] ? { HTTP_GIT_PROTOCOL: headers['git-protocol'] } : {}),
            },
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        let started = false;
        let settled = false;
        let head = Buffer.alloc(0);
        const finish = () => {
            settled = true;
            clearTimeout(deadline);
            child.kill('SIGKILL');
        };
        const abort = (status, message) => {
            if (settled) return;
            const answered = started || response.headersSent;
            finish();
            if (answered) response.destroy();
            else refuse(response, status, message);
        };
        const deadline = setTimeout(() => abort(504, 'git http-backend timed out'), GIT_DEADLINE_MS);
        request.on('aborted', () => abort(499, 'client closed the request'));
        request.on('error', () => abort(499, 'client closed the request'));
        response.on('close', () => abort(499, 'client closed the request'));
        child.on('error', () => abort(500, 'git http-backend could not start'));
        child.stdin.on('error', () => {});
        request.pipe(child.stdin);

        child.stdout.on('data', (chunk) => {
            if (settled) return;
            let body = chunk;
            if (!started) {
                head = Buffer.concat([head, chunk]);
                const end = head.indexOf('\r\n\r\n');
                if (end < 0) return;
                started = true;
                const cgi = Object.fromEntries(
                    head
                        .subarray(0, end)
                        .toString()
                        .split('\r\n')
                        .map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])
                );
                const { status = '200', ...rest } = cgi;
                response.writeHead(Number.parseInt(status, 10), rest);
                body = head.subarray(end + 4);
            }
            if (body.length > 0 && !response.write(body)) {
                child.stdout.pause();
                response.once('drain', () => child.stdout.resume());
            }
        });
        child.on('close', async (code) => {
            if (settled) return;
            if (code !== 0 || !started) return abort(500, 'git http-backend failed');
            try {
                if (recording) await recordPush(project, ctx, before);
            } catch {
                // the push happened; a lane that needs the record sees it is missing
            }
            if (settled) return;
            clearTimeout(deadline);
            settled = true;
            response.end();
        });
    });

    forge.route('GET', '/_control/gitlab/pushes', ({ response }) => forge.json(response, 200, pushes), { auth: false });

    // --- the lane's door ---

    const controlProject = (ctx) => {
        const project = projectOf(ctx.body.project);
        if (!project) notFound(ctx.response, 'Project Not Found');
        return project;
    };
    control('sign-in', ({ response, body }) => forge.json(response, 200, issuePair(body.login ?? DEFAULT_MEMBER)));
    control('projects', async ({ response, body, request }) => {
        if (!body.path || projectOf(body.path)) return badRequest(response, 'a project path is required and must be new');
        const id = forge.nextId();
        const project = {
            id,
            path: body.path,
            name: body.path.split('/').pop(),
            defaultBranch: body.defaultBranch ?? 'main',
            squashOption: body.squashOption ?? 'default_off',
            onlyPipeline: flag(body.onlyAllowMergeIfPipelineSucceeds),
            onlyDiscussions: flag(body.onlyAllowMergeIfAllDiscussionsAreResolved),
            members: new Map(),
            mrs: [],
            hooks: [],
            statuses: [],
        };
        projects.set(id, project);
        ensureGroups(project.path);
        await repos.create(id, { defaultBranch: project.defaultBranch, files: body.files ?? {}, seedDir: body.seedDir, author: SEED_AUTHOR, date: now() });
        forge.json(response, 200, { id, path_with_namespace: project.path, http_url_to_repo: `${origin(request)}/${project.path}.git` });
    });
    control('version', ({ response, body }) => {
        version = body.version ?? DEFAULT_VERSION;
        forge.json(response, 200, { version });
    });
    control('oauth-clients', ({ response, body }) => {
        const { clientId, clientSecret, redirectUris, scopes = [DEFAULT_SCOPE] } = body;
        if (!clientId || !clientSecret || !Array.isArray(redirectUris) || redirectUris.length === 0) {
            return badRequest(response, 'clientId, clientSecret and a non-empty redirectUris are required');
        }
        clients.set(clientId, { secret: clientSecret, redirectUris, scopes });
        forge.json(response, 200, { clientId: body.clientId });
    });
    // `mode`: status (with `status`), malformed (a 200 whose body is not JSON), timeout (never answered), none (clears
    // every fault). `pathIncludes` limits it to API paths containing the text; `count` to that many calls.
    control('faults', ({ response, body }) => {
        if (body.mode === 'none') faults.length = 0;
        else if (['status', 'malformed', 'timeout'].includes(body.mode)) {
            faults.push({
                mode: body.mode,
                status: Number(body.status ?? 500),
                pathIncludes: body.pathIncludes ?? API,
                remaining: body.count === undefined ? null : Number(body.count),
            });
        } else return badRequest(response, 'unknown fault mode');
        forge.json(response, 200, { faults: faults.length });
    });
    control('commit', async (ctx) => {
        const project = controlProject(ctx);
        if (!project) return;
        const { branch, files = {}, message = 'Update', author } = ctx.body;
        const sha = await repos.commit(project.id, { branch, files, message, author: author ?? SEED_AUTHOR, date: now() });
        forge.json(ctx.response, 200, { branch, sha });
    });
    control('members', (ctx) => {
        const project = controlProject(ctx);
        if (!project) return;
        const { login, projectAccess = null, groupAccess = null } = ctx.body;
        project.members.set(login, { project: projectAccess, group: groupAccess });
        forge.json(ctx.response, 200, { login, projectAccess, groupAccess });
    });
    control('pipelines', async (ctx) => {
        const project = controlProject(ctx);
        if (!project) return;
        const { ref, status } = ctx.body;
        const sha = ctx.body.sha ?? (await repos.resolve(project.id, ref));
        const pipeline = newPipeline(project, { ref, sha, status, source: 'push' });
        forge.json(ctx.response, 200, pipelineJson(pipeline, ctx.request));
    });
    control('pipelines/:id', (ctx) => {
        const pipeline = pipelines.find((entry) => entry.id === Number(ctx.params.id));
        if (!pipeline) return notFound(ctx.response, 'Not found');
        Object.assign(pipeline, { status: ctx.body.status, updatedAt: now() });
        forge.json(ctx.response, 200, pipelineJson(pipeline, ctx.request));
    });
    control('merge_status', (ctx) => {
        const project = controlProject(ctx);
        const mr = project && project.mrs.find((entry) => entry.iid === Number(ctx.body.iid));
        if (project && !mr) return notFound(ctx.response, 'Merge Request Not Found');
        if (!mr) return;
        mr.statusOverride = ctx.body.detailedMergeStatus ?? null;
        forge.json(ctx.response, 200, { iid: mr.iid, detailedMergeStatus: mr.statusOverride });
    });
    control('hooks/fire', async (ctx) => {
        const project = controlProject(ctx);
        if (!project) return;
        const event = HOOK_EVENTS[ctx.body.event];
        if (!event) return badRequest(ctx.response, 'unknown hook event');
        const delivered = [];
        for (const hook of project.hooks.filter((entry) => entry[event.flag])) {
            const headers = { 'content-type': 'application/json', 'x-gitlab-event': event.header };
            if (hook.secret) headers['x-gitlab-token'] = hook.secret;
            try {
                const answer = await fetch(hook.url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(ctx.body.payload ?? {}),
                    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
                });
                delivered.push({ url: hook.url, status: answer.status });
            } catch {
                delivered.push({ url: hook.url, status: 0 });
            }
        }
        forge.json(ctx.response, 200, delivered);
    });
};
