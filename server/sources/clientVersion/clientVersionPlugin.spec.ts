import { describe, it, expect } from 'vitest';
import {
    parseClientVersion,
    utcDayBucket,
    drainObserverWrites,
    _inFlightObserverWriteCount,
} from './clientVersionPlugin';

describe('parseClientVersion — X-Client-Version primary', () => {
    it('parses mac/2.4.0', () => {
        expect(parseClientVersion({ 'x-client-version': 'mac/2.4.0' })).toEqual({
            platform: 'mac',
            version: '2.4.0',
            raw: 'mac/2.4.0',
        });
    });

    it('parses ios/2.4.0', () => {
        expect(parseClientVersion({ 'x-client-version': 'ios/2.4.0' })).toEqual({
            platform: 'ios',
            version: '2.4.0',
            raw: 'ios/2.4.0',
        });
    });

    it('parses pre-release suffixes', () => {
        expect(parseClientVersion({ 'x-client-version': 'mac/2.4.0-tf1' })).toEqual({
            platform: 'mac',
            version: '2.4.0-tf1',
            raw: 'mac/2.4.0-tf1',
        });
    });

    it('lowercases the platform label', () => {
        expect(parseClientVersion({ 'x-client-version': 'MAC/2.4.0' })).toEqual({
            platform: 'mac',
            version: '2.4.0',
            raw: 'MAC/2.4.0',
        });
    });

    it('returns unknown/null when header is missing', () => {
        expect(parseClientVersion({})).toEqual({
            platform: 'unknown',
            version: null,
            raw: null,
        });
    });

    it('returns unknown/null but preserves raw when X-Client-Version is malformed', () => {
        expect(parseClientVersion({ 'x-client-version': 'garbage' })).toEqual({
            platform: 'unknown',
            version: null,
            raw: 'garbage',
        });
    });

    it('accepts free-form platform labels for future client kinds', () => {
        // Future-proofing — if a `web` or `cli` client appears, parser shouldn't
        // reject it; the admin distribution view will surface a new platform row.
        expect(parseClientVersion({ 'x-client-version': 'web/1.0.0' })).toEqual({
            platform: 'web',
            version: '1.0.0',
            raw: 'web/1.0.0',
        });
    });
});

describe('parseClientVersion — User-Agent fallback', () => {
    it('falls back to User-Agent when X-Client-Version is missing', () => {
        expect(
            parseClientVersion({ 'user-agent': 'MioIsland-Mac/2.4.0 (macOS 15.4)' })
        ).toEqual({
            platform: 'mac',
            version: '2.4.0',
            raw: 'MioIsland-Mac/2.4.0 (macOS 15.4)',
        });
    });

    it('falls back to User-Agent with iOS form', () => {
        expect(
            parseClientVersion({ 'user-agent': 'MioIsland-iOS/2.4.0 (iOS 18.0)' })
        ).toEqual({
            platform: 'ios',
            version: '2.4.0',
            raw: 'MioIsland-iOS/2.4.0 (iOS 18.0)',
        });
    });

    it('does NOT fall back when User-Agent is unrelated', () => {
        expect(parseClientVersion({ 'user-agent': 'Mozilla/5.0 (...)' })).toEqual({
            platform: 'unknown',
            version: null,
            raw: 'Mozilla/5.0 (...)',
        });
    });

    it('prefers X-Client-Version over User-Agent', () => {
        // If both are present, X-Client-Version wins. Helps clients explicitly
        // override what their HTTP framework auto-fills in User-Agent.
        expect(
            parseClientVersion({
                'x-client-version': 'mac/2.4.0',
                'user-agent': 'MioIsland-Mac/2.3.5 (...)',
            })
        ).toEqual({
            platform: 'mac',
            version: '2.4.0',
            raw: 'mac/2.4.0',
        });
    });
});

describe('parseClientVersion — defensive truncation + array headers', () => {
    it('truncates a giant raw header to MAX_RAW_LEN=200 chars', () => {
        const giant = 'mac/' + 'a'.repeat(500);
        const result = parseClientVersion({ 'x-client-version': giant });
        expect(result.platform).toBe('unknown'); // regex won't match the giant
        expect(result.version).toBeNull();
        expect(result.raw).not.toBeNull();
        expect(result.raw!.length).toBe(200);
    });

    it('truncates a giant User-Agent', () => {
        const giant = 'NotMioIsland/' + 'x'.repeat(1000);
        const result = parseClientVersion({ 'user-agent': giant });
        expect(result.raw!.length).toBe(200);
    });

    it('handles duplicate X-Client-Version headers (array form)', () => {
        // Node IncomingHttpHeaders allows string[] for duplicated headers.
        // We pick the first value; do not let the cast-to-string lie.
        const result = parseClientVersion({
            'x-client-version': ['mac/2.4.0', 'evil/9.9.9'] as unknown as string,
        });
        expect(result).toEqual({ platform: 'mac', version: '2.4.0', raw: 'mac/2.4.0' });
    });

    it('handles duplicate User-Agent headers (array form)', () => {
        const result = parseClientVersion({
            'user-agent': ['MioIsland-Mac/2.4.0', 'evil-ua'] as unknown as string,
        });
        expect(result.platform).toBe('mac');
        expect(result.version).toBe('2.4.0');
    });
});

describe('drainObserverWrites', () => {
    it('resolves immediately when the in-flight set is empty', async () => {
        // Fresh module state — no requests have been processed.
        expect(_inFlightObserverWriteCount()).toBe(0);
        const start = Date.now();
        await drainObserverWrites();
        const elapsed = Date.now() - start;
        // Should be near-instant. Allow 50ms for noise but anything larger
        // means we accidentally awaited something we shouldn't.
        expect(elapsed).toBeLessThan(50);
    });

    // Note: full integration test of the in-flight tracking (createMany write
    // gets added to set, then deleted on .finally) requires a Prisma client
    // with a real DB. The DB integration is verified manually + via the unit
    // structure (the .finally callback deletes from a module-private Set).
    // Here we only assert the drain-helper contract for the empty case.
});

describe('utcDayBucket', () => {
    it('formats UTC date as YYYY-MM-DD', () => {
        // 2026-05-13 12:34:56 UTC
        const d = new Date(Date.UTC(2026, 4, 13, 12, 34, 56));
        expect(utcDayBucket(d)).toBe('2026-05-13');
    });

    it('does NOT shift to local time near day boundaries', () => {
        // 2026-05-13 23:30 UTC — depending on machine TZ, local would be next day,
        // but we always want UTC-based bucketing.
        const d = new Date(Date.UTC(2026, 4, 13, 23, 30, 0));
        expect(utcDayBucket(d)).toBe('2026-05-13');
    });

    it('pads month and day to 2 digits', () => {
        const d = new Date(Date.UTC(2026, 0, 3, 0, 0, 0));
        expect(utcDayBucket(d)).toBe('2026-01-03');
    });
});
