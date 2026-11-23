// github.com's REST and OAuth surface, as far as the board's user-token flow and PR operations reach.
// Plugged into server.mjs; the token table, the clock and the hold are the base's.
/** A GitHub App user access token's lifetime (expiration on, the default). */
export const USER_TOKEN_TTL_S = 8 * 3600;
const REFRESH_TOKEN_TTL_S = 15_811_200;
const MEMBER = { login: 'lane-member', id: 7001 };
const INSTALLATION_ID = 999001;
const PUBLIC_URL = 'https://github.com';

export const registerGithub = (forge) => {
    const codes = new Set();
    /** refresh token -> { access, expiresAt }; a refresh token is deleted when used. */
    const refreshTokens = new Map();
    const pulls = new Map(); // `${owner}/${name}` -> pull[]

    const issuePair = () => {
        const id = forge.nextId();
        const access = `ghu_fake${id}`;
        const refresh = `ghr_fake${id}`;
        forge.tokens.set(access, {
            kind: 'user',
            login: MEMBER.login,
            expiresAt: forge.clock() + USER_TOKEN_TTL_S * 1000,
        });
        refreshTokens.set(refresh, { access, expiresAt: forge.clock() + REFRESH_TOKEN_TTL_S * 1000 });
        return {
            access_token: access,
            expires_in: USER_TOKEN_TTL_S,
            refresh_token: refresh,
            refresh_token_expires_in: REFRESH_TOKEN_TTL_S,
            token_type: 'bearer',
            scope: '',
        };
    };

    forge.route(
        'GET',
        '/login/oauth/authorize',
        ({ response, query }) => {
            const code = `code${forge.nextId()}`;
            codes.add(code);
            const target = new URL(query.redirect_uri);
            target.searchParams.set('code', code);
            if (query.state) target.searchParams.set('state', query.state);
            response.writeHead(302, { location: target.toString() });
            response.end();
        },
        { auth: false }
    );

    forge.route(
        'POST',
        '/login/oauth/access_token',
        ({ response, body }) => {
            // GitHub answers a bad grant with 200 and an `error` field.
            if (body.grant_type === 'refresh_token') {
                const held = refreshTokens.get(body.refresh_token);
                if (!held || held.expiresAt <= forge.clock()) {
                    return forge.json(response, 200, { error: 'bad_refresh_token' });
                }
                refreshTokens.delete(body.refresh_token);
                forge.tokens.delete(held.access);
                return forge.json(response, 200, issuePair());
            }
            if (!codes.delete(body.code)) return forge.json(response, 200, { error: 'bad_verification_code' });
            forge.json(response, 200, issuePair());
        },
        { auth: false }
    );

    forge.route('GET', '/user', ({ response }) => forge.json(response, 200, MEMBER));
    forge.route('GET', '/user/installations', ({ response }) =>
        forge.json(response, 200, {
            total_count: 1,
            installations: [{ id: INSTALLATION_ID, account: { login: 'lane-org', type: 'Organization' } }],
        })
    );

    const shape = (pull) => ({
        number: pull.number,
        html_url: pull.htmlUrl,
        state: pull.state,
        merged: pull.merged,
        draft: pull.draft,
        title: pull.title,
        body: pull.body,
        head: { ref: pull.head, label: `${pull.headOwner}:${pull.head}` },
        base: { ref: pull.base },
    });
    const listOf = (params) => {
        const key = `${params.owner}/${params.name}`;
        if (!pulls.has(key)) pulls.set(key, []);
        return pulls.get(key);
    };
    // `head` is `branch` or `owner:branch` (owner defaulting to the repo's); one identity for create, list and duplicates.
    const splitHead = (value, defaultOwner) => {
        const text = String(value ?? '');
        const at = text.indexOf(':');
        return at < 0 ? { headOwner: defaultOwner, head: text } : { headOwner: text.slice(0, at), head: text.slice(at + 1) };
    };
    const sameHead = (a, b) => a.headOwner === b.headOwner && a.head === b.head;
    const duplicate = (response, pull) =>
        forge.json(response, 422, {
            message: 'Validation Failed',
            errors: [{ message: `A pull request already exists for ${pull.headOwner}:${pull.head}.` }],
        });
    const find = (params) => listOf(params).find((pull) => pull.number === Number(params.number));
    const notFound = (response) => forge.json(response, 404, { message: 'Not Found' });
    const base = '/repos/:owner/:name/pulls';

    forge.route(
        'POST',
        base,
        ({ response, params, body, tokenKind }) => {
            const list = listOf(params);
            const identity = splitHead(body.head, params.owner);
            if (list.some((pull) => pull.state === 'open' && sameHead(pull, identity))) {
                return duplicate(response, identity);
            }
            const pull = {
                number: list.length + 1,
                owner: params.owner,
                htmlUrl: `${PUBLIC_URL}/${params.owner}/${params.name}/pull/${list.length + 1}`,
                state: 'open',
                merged: false,
                draft: Boolean(body.draft),
                title: body.title,
                body: body.body ?? '',
                ...identity,
                base: body.base,
                createdBy: tokenKind,
            };
            list.push(pull);
            forge.json(response, 201, shape(pull));
        },
        { holdable: true }
    );
    forge.route('GET', base, ({ response, params, query }) => {
        const head = query.head ? splitHead(query.head, params.owner) : null;
        const state = query.state ?? 'open';
        forge.json(
            response,
            200,
            listOf(params)
                .filter((pull) => (head === null || sameHead(pull, head)) && (state === 'all' || pull.state === state))
                .map(shape)
        );
    });
    forge.route('GET', `${base}/:number`, ({ response, params }) => {
        const pull = find(params);
        if (!pull) return notFound(response);
        forge.json(response, 200, shape(pull));
    });
    forge.route('PATCH', `${base}/:number`, ({ response, params, body }) => {
        const pull = find(params);
        if (!pull) return notFound(response);
        if (body.state !== undefined && !['open', 'closed'].includes(body.state)) {
            return forge.json(response, 422, { message: 'Validation Failed' });
        }
        if (body.state === 'open' && pull.state !== 'open') {
            if (pull.merged) return forge.json(response, 422, { message: 'Validation Failed' });
            if (listOf(params).some((other) => other.state === 'open' && sameHead(other, pull))) {
                return duplicate(response, pull);
            }
        }
        if (body.state !== undefined) pull.state = body.state;
        for (const field of ['title', 'body', 'base']) if (body[field] !== undefined) pull[field] = body[field];
        forge.json(response, 200, shape(pull));
    });
    forge.route('PUT', `${base}/:number/merge`, ({ response, params }) => {
        const pull = find(params);
        if (!pull) return notFound(response);
        if (pull.state !== 'open') return forge.json(response, 405, { message: 'Pull Request is not mergeable' });
        pull.state = 'closed';
        pull.merged = true;
        forge.json(response, 200, { merged: true, message: 'Pull Request successfully merged' });
    });

    // The lane's view of every PR, with the kind of token that created it.
    forge.route(
        'GET',
        '/_control/pulls',
        ({ response }) =>
            forge.json(
                response,
                200,
                [...pulls.values()].flat().map((pull) => ({ ...shape(pull), createdBy: pull.createdBy }))
            ),
        { auth: false }
    );
};
