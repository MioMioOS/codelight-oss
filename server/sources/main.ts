import { db } from '@/storage/db';
import { startApi } from '@/api';
import { startSocket } from '@/socket/socketServer';
import { initBlobStore } from '@/blob/blobStore';
import { config } from '@/config';
// OSS edition: subscription cleanup loop intentionally removed.
import { drainObserverWrites } from '@/clientVersion/clientVersionPlugin';

async function main() {
    if (!config.masterSecret || config.masterSecret === 'change-me-to-a-random-string') {
        console.error('MASTER_SECRET must be set');
        process.exit(1);
    }

    await db.$connect();
    console.log('Database connected');

    await initBlobStore();

    const app = await startApi();

    startSocket(app.server);
    console.log('Socket.io ready on /v1/updates');

    // Auto-cleanup stale sessions every hour (inactive for >4 hours)
    setInterval(async () => {
        try {
            const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
            const result = await db.session.updateMany({
                where: { active: true, lastActiveAt: { lt: fourHoursAgo } },
                data: { active: false },
            });
            if (result.count > 0) {
                console.log(`[Auto-cleanup] Marked ${result.count} stale sessions as inactive`);
                // Clean orphan Live Activity tokens
                const inactive = await db.session.findMany({
                    where: { active: false, lastActiveAt: { lt: fourHoursAgo } },
                    select: { id: true },
                });
                const ids = inactive.map(s => s.id);
                const tokensDeleted = await db.liveActivityToken.deleteMany({
                    where: { sessionId: { in: ids } },
                });
                if (tokensDeleted.count > 0) {
                    console.log(`[Auto-cleanup] Deleted ${tokensDeleted.count} orphan Live Activity tokens`);
                }
            }

            // Purge messages older than 5 days
            const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
            const purged = await db.sessionMessage.deleteMany({
                where: { createdAt: { lt: fiveDaysAgo } },
            });
            if (purged.count > 0) {
                console.log(`[Auto-cleanup] Purged ${purged.count} messages older than 5 days`);
            }

            // Purge client version observations older than 90 days. The table
            // is statistical (Phase 1 of the version-gate rollout) — losing
            // old rows is fine, and unbounded growth would matter.
            const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
            const obsPurged = await db.clientVersionObservation.deleteMany({
                where: { timestamp: { lt: ninetyDaysAgo } },
            });
            if (obsPurged.count > 0) {
                console.log(
                    `[Auto-cleanup] Purged ${obsPurged.count} client version observations older than 90 days`
                );
            }
        } catch (err) {
            console.error('[Auto-cleanup] Error:', err);
        }
    }, 60 * 60 * 1000); // Run every hour
    console.log('Auto-cleanup scheduled (hourly, 4h threshold)');

    const shutdown = async () => {
        console.log('Shutting down...');
        await app.close();
        // Drain in-flight client-version observation writes BEFORE killing the
        // Prisma engine. Otherwise the fire-and-forget DB inserts dispatched
        // by onResponse hooks race against $disconnect and throw "Engine not
        // connected" into shutdown logs.
        await drainObserverWrites();
        await db.$disconnect();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
        process.exit(1);
    });
}

main().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
