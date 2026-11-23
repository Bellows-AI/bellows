/**
 * The one organization AUTH_MODE=none has.
 *
 * With no GitHub sign-in there is nothing to derive an installation id from, so the offline and
 * local tooling — seed, verify:ui, test-jobs, the route tests — all live in this one partition.
 * Github mode never uses it: there the org ids are the installation ids GitHub reports.
 */
export const LOCAL_ORG_ID = 'default';

/**
 * A uuid, as `app_user.id` and `job.id` are.
 *
 * The shape of an identifier that ends up in a path, a URL and a shell command; both `routes/`
 * and `workspace/` legitimately depend on this module, where neither should depend on the other.
 * `driver/` keeps its own copy, deliberately: that package depends on nothing.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
