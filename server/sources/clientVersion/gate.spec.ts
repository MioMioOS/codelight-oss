import { describe, it, expect, vi } from 'vitest';
import { requireClientVersion } from './gate';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ClientInfo } from './clientVersionPlugin';

/// Build a minimal stub for the parts of FastifyReply that gate.ts touches.
/// We capture statusCode + sent payload so assertions stay focused.
function makeReply() {
    const state: { code: number | null; payload: unknown } = { code: null, payload: undefined };
    const reply = {
        code(c: number) {
            state.code = c;
            return reply;
        },
        send(p: unknown) {
            state.payload = p;
            return reply;
        },
    } as unknown as FastifyReply;
    return { reply, state };
}

function makeRequest(clientInfo: ClientInfo | undefined): FastifyRequest {
    return { clientInfo } as unknown as FastifyRequest;
}

describe('requireClientVersion — Phase 1 (enforcement off)', () => {
    it('passes through when flag is off, even for missing version', async () => {
        const handler = requireClientVersion('2.4.0', { enforceOverride: false });
        const { reply, state } = makeReply();
        const request = makeRequest(undefined);
        await handler(request, reply);
        expect(state.code).toBeNull();
        expect(state.payload).toBeUndefined();
    });

    it('passes through when flag is off, even for ancient version', async () => {
        const handler = requireClientVersion('2.4.0', { enforceOverride: false });
        const { reply, state } = makeReply();
        const request = makeRequest({ platform: 'mac', version: '1.0.0', raw: 'mac/1.0.0' });
        await handler(request, reply);
        expect(state.code).toBeNull();
        expect(state.payload).toBeUndefined();
    });
});

describe('requireClientVersion — enforcement on', () => {
    it('rejects when clientInfo is undefined (no parser ran somehow)', async () => {
        const handler = requireClientVersion('2.4.0', { enforceOverride: true });
        const { reply, state } = makeReply();
        const request = makeRequest(undefined);
        await handler(request, reply);
        expect(state.code).toBe(426);
        expect(state.payload).toMatchObject({ error: 'client_too_old' });
    });

    it('rejects when version is null (no header / malformed)', async () => {
        const handler = requireClientVersion('2.4.0', { enforceOverride: true });
        const { reply, state } = makeReply();
        const request = makeRequest({ platform: 'unknown', version: null, raw: null });
        await handler(request, reply);
        expect(state.code).toBe(426);
        expect(state.payload).toMatchObject({
            error: 'client_too_old',
            downloadUrl: 'https://miomioos.github.io/MioIsland/',
        });
    });

    it('rejects when version is below minimum', async () => {
        const handler = requireClientVersion('2.4.0', { enforceOverride: true });
        const { reply, state } = makeReply();
        const request = makeRequest({ platform: 'mac', version: '2.3.0', raw: 'mac/2.3.0' });
        await handler(request, reply);
        expect(state.code).toBe(426);
        expect(state.payload).toMatchObject({ error: 'client_too_old' });
    });

    it('passes pre-release of the same base version (TestFlight forgiving)', async () => {
        // Server-side forgiveness: pre-release suffix is ignored for the
        // gate, so TestFlight users on `mac/2.4.0-tf1` still pass when
        // minVersion is `2.4.0`. See semver.ts header comment.
        const handler = requireClientVersion('2.4.0', { enforceOverride: true });
        const { reply, state } = makeReply();
        const request = makeRequest({
            platform: 'mac',
            version: '2.4.0-tf1',
            raw: 'mac/2.4.0-tf1',
        });
        await handler(request, reply);
        expect(state.code).toBeNull();
        expect(state.payload).toBeUndefined();
    });

    it('still rejects clients on an older base version even with pre-release suffix', async () => {
        // The forgiveness applies only to the SAME base version. A TF build
        // of an OLDER release (`2.3.0-tf1` when min is `2.4.0`) still fails.
        const handler = requireClientVersion('2.4.0', { enforceOverride: true });
        const { reply, state } = makeReply();
        const request = makeRequest({
            platform: 'mac',
            version: '2.3.0-tf1',
            raw: 'mac/2.3.0-tf1',
        });
        await handler(request, reply);
        expect(state.code).toBe(426);
    });

    it('passes when version equals minimum', async () => {
        const handler = requireClientVersion('2.4.0', { enforceOverride: true });
        const { reply, state } = makeReply();
        const request = makeRequest({ platform: 'mac', version: '2.4.0', raw: 'mac/2.4.0' });
        await handler(request, reply);
        expect(state.code).toBeNull();
        expect(state.payload).toBeUndefined();
    });

    it('passes when version exceeds minimum', async () => {
        const handler = requireClientVersion('2.4.0', { enforceOverride: true });
        const { reply, state } = makeReply();
        const request = makeRequest({ platform: 'ios', version: '2.5.0', raw: 'ios/2.5.0' });
        await handler(request, reply);
        expect(state.code).toBeNull();
        expect(state.payload).toBeUndefined();
    });
});
