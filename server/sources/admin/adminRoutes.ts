import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { config } from '@/config';
import { eventRouter } from '@/socket/socketServer';
import { semverLt, parseVersion } from '@/clientVersion/semver';

/** Admin endpoints — protected by MASTER_SECRET bearer token. */
export async function adminRoutes(app: FastifyInstance) {

    // Admin auth check
    app.addHook('onRequest', async (request, reply) => {
        const auth = request.headers.authorization;
        if (!auth || auth !== `Bearer ${config.masterSecret}`) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
    });

    // Server overview stats
    app.get('/v1/admin/stats', async () => {
        const [devices, sessions, messages, links, pushTokens, activeSessions] = await Promise.all([
            db.device.count(),
            db.session.count(),
            db.sessionMessage.count(),
            db.deviceLink.count(),
            db.pushToken.count(),
            db.session.count({ where: { active: true } }),
        ]);

        // Connected sockets from EventRouter
        const connectedDevices = eventRouter.getConnectionCount();

        return {
            devices,
            sessions,
            activeSessions,
            messages,
            links,
            pushTokens,
            connectedDevices,
        };
    });

    // List all devices with their link count and last seen
    app.get('/v1/admin/devices', async () => {
        const devices = await db.device.findMany({
            orderBy: { lastSeenAt: { sort: 'desc', nulls: 'last' } },
            select: {
                id: true,
                name: true,
                kind: true,
                shortCode: true,
                lastSeenAt: true,
                notificationsEnabled: true,
                createdAt: true,
            },
        });

        // Enrich with link count and online status
        const enriched = await Promise.all(devices.map(async (d) => {
            const linkCount = await db.deviceLink.count({
                where: { OR: [{ sourceDeviceId: d.id }, { targetDeviceId: d.id }] },
            });
            return {
                ...d,
                linkCount,
                online: eventRouter.isDeviceConnected(d.id),
            };
        }));

        return { devices: enriched };
    });

    // List all sessions with owner info
    app.get('/v1/admin/sessions', async (request) => {
        const { active, limit } = request.query as { active?: string; limit?: string };
        const where = active === 'true' ? { active: true } : active === 'false' ? { active: false } : {};

        const sessions = await db.session.findMany({
            where,
            orderBy: { lastActiveAt: 'desc' },
            take: parseInt(limit || '50', 10),
            include: {
                device: { select: { name: true, kind: true } },
            },
        });

        return { sessions };
    });

    // Read messages for any session (admin only, no device scoping)
    app.get('/v1/admin/sessions/:sessionId/messages', async (request) => {
        const { sessionId } = request.params as { sessionId: string };
        const { limit, before_seq } = request.query as { limit?: string; before_seq?: string };

        const take = parseInt(limit || '50', 10);
        const where: any = { sessionId };
        if (before_seq) {
            where.seq = { lt: parseInt(before_seq, 10) };
        }

        const messages = await db.sessionMessage.findMany({
            where,
            orderBy: { seq: 'desc' },
            take,
            select: { id: true, seq: true, content: true, createdAt: true },
        });

        return {
            messages: messages.reverse(),
            hasMore: messages.length === take,
        };
    });

    // Delete a device and all its data (nuclear option)
    app.delete('/v1/admin/devices/:deviceId', async (request) => {
        const { deviceId } = request.params as { deviceId: string };

        // Delete in order: messages → sessions → links → tokens → device
        const sessions = await db.session.findMany({ where: { deviceId }, select: { id: true } });
        const sessionIds = sessions.map(s => s.id);

        if (sessionIds.length > 0) {
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: sessionIds } } });
        }
        await db.session.deleteMany({ where: { deviceId } });
        await db.deviceLink.deleteMany({
            where: { OR: [{ sourceDeviceId: deviceId }, { targetDeviceId: deviceId }] },
        });
        await db.pushToken.deleteMany({ where: { deviceId } });
        await db.liveActivityToken.deleteMany({ where: { deviceId } });
        await db.device.delete({ where: { id: deviceId } }).catch(() => {});

        return { ok: true, deletedSessions: sessionIds.length };
    });

    /// Client version distribution — admin telemetry. Returns a flat
    /// distribution + a one-glance `rolloutPercentage` + a boolean
    /// `readyForEnforcement` (the % threshold is configurable per spec).
    ///
    /// Query params:
    ///   ?days=7|30   lookback window in days (default 7)
    ///   ?minVersion=...   target minimum version (default empty)
    ///
    /// Sample response:
    ///   {
    ///     lookbackDays: 7,
    ///     minVersion: '2.4.0',
    ///     totalDevices: 412,
    ///     onMinVersion: 401,
    ///     rolloutPercentage: 97.33,
    ///     readyForEnforcement: true,
    ///     distribution: [
    ///       { platform: 'mac', version: '2.4.0', deviceCount: 220 },
    ///       { platform: 'ios', version: '2.4.0', deviceCount: 181 },
    ///       { platform: 'mac', version: '2.3.0', deviceCount: 8 },
    ///       { platform: 'unknown', version: null, deviceCount: 3 },
    ///     ]
    ///   }
    app.get('/v1/admin/clients', async (request) => {
        const { days, minVersion } = request.query as { days?: string; minVersion?: string };
        // Parse with NaN guard. parseInt('abc') → NaN → would silently propagate
        // through Math.min/max and become an Invalid Date in the SQL bind →
        // "WHERE timestamp >= NULL" matches zero rows and we'd lie about
        // rolloutPercentage being 0. Default to 7 on any unparseable input.
        const parsedDays = parseInt(days || '7', 10);
        const lookbackDays = Number.isFinite(parsedDays)
            ? Math.max(1, Math.min(90, parsedDays))
            : 7;
        // Default target = Mac MioIsland v3.0.0 (first release that sends
        // X-Client-Version header). iOS Code Light tracks on its own version
        // ladder (currently 1.5.0+) and a future patch will make the gate
        // platform-aware — for now this single threshold drives the admin
        // readiness display. Pass `?minVersion=...` to override per query.
        const min = minVersion || '3.0.0';
        const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

        // GROUP BY (platform, version) COUNT(DISTINCT deviceId).
        // Raw SQL because Prisma's groupBy doesn't expose COUNT(DISTINCT col).
        const rows = await db.$queryRaw<
            Array<{ platform: string; version: string | null; device_count: bigint }>
        >`
            SELECT
                "platform",
                "version",
                COUNT(DISTINCT "deviceId") AS device_count
            FROM "ClientVersionObservation"
            WHERE "timestamp" >= ${since}
            GROUP BY "platform", "version"
            ORDER BY device_count DESC
        `;

        const distribution = rows.map((r) => ({
            platform: r.platform,
            version: r.version,
            deviceCount: Number(r.device_count),
        }));

        const totalDevices = distribution.reduce((acc, r) => acc + r.deviceCount, 0);
        // Count toward `onMinVersion` ONLY rows whose version is non-null AND
        // parses as valid semver AND is >= min. semverLt returns false on
        // unparseable input — without the explicit parseVersion guard, a
        // garbage version string would be counted as "on min version" and
        // inflate rolloutPercentage, triggering premature readyForEnforcement.
        const onMinVersion = distribution
            .filter(
                (r) =>
                    r.version !== null &&
                    parseVersion(r.version) !== null &&
                    !semverLt(r.version, min)
            )
            .reduce((acc, r) => acc + r.deviceCount, 0);
        const rolloutPercentage =
            totalDevices === 0 ? 0 : Math.round((onMinVersion / totalDevices) * 10000) / 100;

        return {
            lookbackDays,
            minVersion: min,
            totalDevices,
            onMinVersion,
            rolloutPercentage,
            readyForEnforcement: rolloutPercentage >= 95,
            enforcementCurrentlyOn: config.enforceClientVersionGate,
            distribution,
        };
    });
}
