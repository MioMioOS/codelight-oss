import { FastifyInstance } from 'fastify';
import { authMiddleware } from '@/auth/middleware';

/**
 * OSS edition — single-endpoint status stub.
 *
 * Only `GET /v1/subscription/status` is exposed, returning a hard-coded
 * "permanently active" payload. The iOS client polls this on reconnect;
 * we keep the route so the client never sees a 404. If you fork and want
 * to wire your own gating, replace this file with real route handlers.
 */
export async function subscriptionRoutes(app: FastifyInstance) {
    app.get('/v1/subscription/status', {
        preHandler: authMiddleware,
    }, async () => {
        return {
            status: 'active' as const,
            allowed: true,
            reason: 'open_source' as const,
            daysLeft: null as number | null,
            expiresAt: null as string | null,
        };
    });
}
