import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '@/config';
import { semverLt } from './semver';

/**
 * Response shape returned when a client is too old. Clients should
 * pattern-match on `error: 'client_too_old'` to surface their own localized
 * "please upgrade" UI.
 */
const CLIENT_TOO_OLD_RESPONSE = {
    error: 'client_too_old' as const,
    message: 'Please upgrade your client to the latest version.',
    downloadUrl: 'https://github.com/MioMioOS/MioIsland',
};

export interface RequireClientVersionOptions {
    /// Override `config.enforceClientVersionGate` — used by tests.
    enforceOverride?: boolean;
}

/**
 * Build a Fastify preHandler that rejects requests from clients older than
 * `minVersion`. Disabled by default; enable by setting
 * `ENFORCE_CLIENT_VERSION_GATE=true`.
 */
export function requireClientVersion(
    minVersion: string,
    options: RequireClientVersionOptions = {}
) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const enforced =
            options.enforceOverride !== undefined
                ? options.enforceOverride
                : config.enforceClientVersionGate;

        if (!enforced) return;

        const info = request.clientInfo;
        if (!info || !info.version) {
            reply.code(426).send(CLIENT_TOO_OLD_RESPONSE);
            return reply;
        }

        if (semverLt(info.version, minVersion)) {
            reply.code(426).send(CLIENT_TOO_OLD_RESPONSE);
            return reply;
        }
    };
}
