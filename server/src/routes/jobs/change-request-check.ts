import { ERROR_CODES, GITHUB_HOST, parseChangeRequestUrl } from '@factory-ai/core';
import { PR_URL_LIMIT } from './job-limits.js';

/** Why a reported change request is refused: the code the route answers and the message naming the field. */
export interface ChangeRequestProblem {
    code: string;
    message: string;
}

/**
 * Checks a reported change request's url against the repo and number reported beside it. Null when it is a
 * GitHub pull url for that very repo and number; a well-formed GitLab merge request url is `FORGE_UNSUPPORTED`
 * until the GitLab client lands; anything else is `malformedCode`.
 */
export function changeRequestProblem({
    field,
    url,
    repo,
    number,
    malformedCode,
}: {
    field: string;
    url: unknown;
    repo: string;
    number: number;
    malformedCode: string;
}): ChangeRequestProblem | null {
    const parsed = typeof url === 'string' && url.length <= PR_URL_LIMIT ? parseChangeRequestUrl(url) : null;
    if (parsed === null) return { code: malformedCode, message: `${field} must be a pull or merge request url` };
    if (parsed.ref.forge !== 'github') {
        return {
            code: ERROR_CODES.FORGE_UNSUPPORTED,
            message: `${field} names a ${parsed.ref.forge} change request, which is not supported yet`,
        };
    }
    if (
        parsed.ref.host !== GITHUB_HOST ||
        parsed.ref.path.toLowerCase() !== repo.toLowerCase() ||
        parsed.number !== number
    ) {
        return { code: malformedCode, message: `${field} must name the reported repo and number` };
    }
    return null;
}
