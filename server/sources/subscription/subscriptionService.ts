/**
 * OSS edition — no-op access stubs.
 *
 * Every access check returns "allowed". The public function surface here
 * matches what `socketServer.ts`, `main.ts`, and `pairingRoutes.ts` import;
 * keep those signatures stable to avoid touching call sites if you fork
 * and want to add your own gating logic.
 */

export type AccessReason =
    | 'open_source'
    | 'device_not_found';

export interface AccessCheck {
    allowed: boolean;
    reason: AccessReason;
    status: 'active' | 'none';
    daysLeft?: number;
    expiresAt?: string;
}

export async function checkAccess(_deviceId: string): Promise<AccessCheck> {
    return { allowed: true, reason: 'open_source', status: 'active' };
}

export async function getDeviceSubscription(_deviceId: string): Promise<null> {
    return null;
}

export async function startTrial(_deviceId: string): Promise<void> {
    // No-op.
}

export async function expireStaleTrials(): Promise<number> {
    return 0;
}

export async function findExpiringTrials(): Promise<Array<{ id: string; expiresAt: Date }>> {
    return [];
}

export async function pushSubscriptionToLinkedMacs(_phoneDeviceId: string): Promise<void> {
    // No-op.
}
