import { EventEmitter } from 'node:events';
import type { readFileSync } from 'node:fs';
import type { request as httpsRequest, RequestOptions } from 'node:https';
import { inClusterRequest, type K8sMethod, type K8sRequest } from '../../src/k8s/k8s-transport.js';

/** The size of each chunk an answer streams back in — far below any buffer the transport keeps. */
const CHUNK_CHARS = 64 * 1024;

/**
 * The real in-cluster transport over a fake API server: every answer `inner` gives is streamed back
 * through `inClusterRequest` in CHUNK_CHARS chunks, so a test sees what the transport keeps of an
 * answer — its cuts and its flags — rather than what the fake said.
 */
export function throughTransport(inner: K8sRequest): K8sRequest {
    const request = ((options: RequestOptions, respond: (response: EventEmitter) => void) => {
        const req = new EventEmitter();
        let written = '';
        Object.assign(req, {
            write(chunk: string) {
                written += chunk;
                return true;
            },
            end() {
                const body: unknown = written ? JSON.parse(written) : undefined;
                inner(options.method as K8sMethod, options.path ?? '', body).then(
                    (answer) => {
                        const response = new EventEmitter();
                        Object.assign(response, {
                            statusCode: answer.status,
                            headers: {},
                            setEncoding: () => response,
                        });
                        respond(response);
                        for (let at = 0; at < answer.body.length; at += CHUNK_CHARS) {
                            response.emit('data', answer.body.slice(at, at + CHUNK_CHARS));
                        }
                        response.emit('end');
                    },
                    (error: unknown) => req.emit('error', error)
                );
                return req;
            },
            destroy(error: Error) {
                queueMicrotask(() => req.emit('error', error));
                return req;
            },
        });
        return req;
    }) as unknown as typeof httpsRequest;
    return inClusterRequest({
        env: { KUBERNETES_SERVICE_HOST: '127.0.0.1' },
        readFile: (() => 'credential') as unknown as typeof readFileSync,
        request,
        log: () => undefined,
    });
}
