import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '@/storage/db';

declare module 'fastify' {
    interface FastifyRequest {
        /// Parsed client version metadata, attached by `clientVersionPlugin`.
        /// ALWAYS set on every request (never undefined) — handlers can rely on it.
        /// When header is missing or malformed, `platform` is `'unknown'` and
        /// `version` is `null`; downstream code (e.g., gate.ts) treats this as
        /// "old client".
        clientInfo?: ClientInfo;
    }
}

export interface ClientInfo {
    platform: string;       // 'mac' | 'ios' | 'unknown' | future labels (free-form)
    version: string | null; // e.g., '2.4.0', null when header missing/unparseable
    raw: string | null;     // raw header value for debugging
}

// Primary header. Must match `^[a-z][a-z0-9_-]{0,15}/x.y.z(-suffix)?$`.
// Anything else falls back to User-Agent.
const X_CLIENT_VERSION_RE = /^([a-z][a-z0-9_-]{0,15})\/(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/i;

// User-Agent fallback for Mac clients. e.g.,
// `MioIsland-Mac/2.4.0 (macOS 15.4)` or `MioIsland_iOS/2.4.0 ...`.
// Only consulted if X-Client-Version is missing/unparseable.
const USER_AGENT_RE = /MioIsland[-_]?(Mac|iOS)\/(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)/i;

/// Max chars we'll store from any raw header field. Defense against
/// pathological clients sending 8KB headers — Fastify's default 8KB header
/// limit means a single header maxes ~8KB, which over 90 days × routes ×
/// devices would balloon the table. 200 chars is enough for any legitimate
/// User-Agent we care to debug.
const MAX_RAW_LEN = 200;

/// Normalize a header value that may arrive as `string | string[]` from
/// Node's IncomingHttpHeaders (duplicate-header case). Always returns the
/// first value or undefined.
function pickHeader(h: string | string[] | undefined): string | undefined {
    if (h === undefined) return undefined;
    return Array.isArray(h) ? h[0] : h;
}

function truncate(s: string | null): string | null {
    if (s === null) return null;
    return s.length > MAX_RAW_LEN ? s.slice(0, MAX_RAW_LEN) : s;
}

/**
 * Pure parser — exported for unit testing without spinning up Fastify.
 */
export function parseClientVersion(headers: {
    'x-client-version'?: string | string[];
    'user-agent'?: string | string[];
}): ClientInfo {
    const xcv = pickHeader(headers['x-client-version']);
    if (xcv) {
        const m = xcv.match(X_CLIENT_VERSION_RE);
        if (m) {
            return { platform: m[1]!.toLowerCase(), version: m[2]!, raw: truncate(xcv) };
        }
        // Header present but malformed — record the raw value (truncated) so
        // admins can investigate, but treat the client as 'unknown' for any
        // version logic.
        return { platform: 'unknown', version: null, raw: truncate(xcv) };
    }
    const ua = pickHeader(headers['user-agent']);
    if (ua) {
        const m = ua.match(USER_AGENT_RE);
        if (m) {
            return { platform: m[1]!.toLowerCase(), version: m[2]!, raw: truncate(ua) };
        }
    }
    return { platform: 'unknown', version: null, raw: truncate(ua ?? null) };
}

/**
 * Return the UTC day bucket string `YYYY-MM-DD` for a given timestamp.
 * Computed in JS so PG server timezone never enters the sampling key.
 */
export function utcDayBucket(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Register client-version parsing + sampling observation on the root Fastify
 * instance. MUST be called BEFORE any route plugins are registered so the
 * hooks apply globally.
 *
 * Hook 1 (onRequest): parse `X-Client-Version` (or `User-Agent` fallback) and
 *                     attach to `request.clientInfo`. Never throws.
 *
 * Hook 2 (onResponse): if the request was authenticated (`request.deviceId`
 *                      is set by auth middleware), the path matches `/v1/*`
 *                      but NOT `/v1/admin/*`, and the response is 2xx, then
 *                      fire-and-forget insert into `ClientVersionObservation`
 *                      with dedup by `(deviceId, endpoint, dayBucket)`.
 *
 * The observer write is intentionally async-unawaited: a slow DB must NEVER
 * delay client responses. Errors are logged to stderr and swallowed.
 */
export function registerClientVersionHooks(app: FastifyInstance): void {
    app.addHook('onRequest', async (request) => {
        request.clientInfo = parseClientVersion({
            'x-client-version': request.headers['x-client-version'],
            'user-agent': request.headers['user-agent'],
        });
    });

    app.addHook('onResponse', async (request, reply) => {
        if (!shouldObserve(request, reply)) return;

        // Prefer the matched route pattern (e.g., `/v1/sessions/:id/messages`)
        // over the actual URL — otherwise sessionId-style path params would
        // explode cardinality of the `endpoint` column. If no match (catch-all
        // route or unusual setup), strip query string from the literal URL
        // so `?token=...` and other params don't pollute the column.
        const route = request.routeOptions?.url || stripQuery(request.url);
        const info = request.clientInfo!;
        const now = new Date();
        const dayBucket = utcDayBucket(now);

        // Fire-and-forget. createMany + skipDuplicates means the UNIQUE
        // (deviceId, endpoint, dayBucket) index does the sampling for us
        // atomically — no race window between "check exists" and "insert".
        //
        // We track the promise in `inFlightObserverWrites` so the shutdown
        // handler can drain them before disconnect. Otherwise SIGINT during
        // traffic produces "Engine not connected" errors as inserts hit a
        // dead client.
        const writePromise: Promise<unknown> = db.clientVersionObservation
            .createMany({
                data: [
                    {
                        timestamp: now,
                        endpoint: route,
                        platform: info.platform,
                        version: info.version,
                        deviceId: request.deviceId!,
                        rawUserAgent: info.raw,
                        dayBucket,
                    },
                ],
                skipDuplicates: true,
            })
            .catch((err: unknown) => {
                logObserverError(err);
            })
            .finally(() => {
                inFlightObserverWrites.delete(writePromise);
            });
        inFlightObserverWrites.add(writePromise);
    });
}

function stripQuery(url: string): string {
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
}

/// Throttle observer-write error logs to one per error class per minute, so
/// a brief DB outage during high-traffic periods doesn't drown Sentry / app
/// logs with thousands of duplicate stack traces.
const lastObserverErrorLogAt = new Map<string, number>();
const OBSERVER_ERROR_LOG_THROTTLE_MS = 60_000;

function logObserverError(err: unknown): void {
    // "Engine is not yet connected" / disconnect-race errors during shutdown:
    // swallow silently. drainObserverWrites() should prevent these in practice,
    // but if a write slips through after $disconnect(), we don't want scary
    // stack traces in shutdown logs.
    if (
        err instanceof Error &&
        /engine is not yet connected|cannot make request after connection/i.test(err.message)
    ) {
        return;
    }
    const key =
        err instanceof Error ? err.name : typeof err === 'object' && err !== null ? 'object' : typeof err;
    const now = Date.now();
    const prev = lastObserverErrorLogAt.get(key);
    if (prev && now - prev < OBSERVER_ERROR_LOG_THROTTLE_MS) return;
    lastObserverErrorLogAt.set(key, now);
    console.error('[clientVersionObserver] write failed', err);
}

/// In-flight observer writes. Track all fire-and-forget createMany promises
/// so the shutdown handler can drain them before `db.$disconnect()` runs.
/// Without this, SIGINT during traffic causes "Engine not connected" errors
/// as inserts hit a disconnected client mid-flight.
const inFlightObserverWrites = new Set<Promise<unknown>>();

/**
 * Drain all in-flight observer writes. Call from main.ts shutdown handler
 * BETWEEN `app.close()` (which drains HTTP request handlers) and
 * `db.$disconnect()` (which kills the Prisma engine). Safe to call when
 * the set is empty.
 */
export async function drainObserverWrites(): Promise<void> {
    const count = inFlightObserverWrites.size;
    if (count === 0) return;
    console.log(`[clientVersionObserver] draining ${count} in-flight write(s) before disconnect`);
    await Promise.allSettled(Array.from(inFlightObserverWrites));
}

/// Test-only: expose the in-flight Set size for assertions. Production code
/// should never read this; the Set itself is module-private.
export function _inFlightObserverWriteCount(): number {
    return inFlightObserverWrites.size;
}

function shouldObserve(request: FastifyRequest, reply: FastifyReply): boolean {
    // Only authenticated requests are recorded — Phase 1 stats are about
    // active paired clients, not anonymous handshake traffic. This naturally
    // excludes `/v1/auth/login`, `/v1/pairing/init`, `/health`, etc.
    if (!request.deviceId) return false;
    // Only successful responses — server errors / client errors aren't
    // representative of "this version works".
    if (reply.statusCode < 200 || reply.statusCode >= 300) return false;
    // Only `/v1/*`.
    if (!request.url.startsWith('/v1/')) return false;
    // Exclude admin tooling traffic — caller is the operator, not a client.
    if (request.url.startsWith('/v1/admin/')) return false;
    return true;
}
