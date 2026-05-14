export const config = {
    port: parseInt(process.env.PORT || '3005', 10),
    masterSecret: process.env.MASTER_SECRET || '',
    databaseUrl: process.env.DATABASE_URL || '',
    tokenExpiryDays: parseInt(process.env.TOKEN_EXPIRY_DAYS || '30', 10),
    // Client version gate (optional). When true, a small set of endpoints
    // rejects clients below a minimum version with HTTP 426. Default false
    // means the server only records observations and never rejects.
    enforceClientVersionGate: process.env.ENFORCE_CLIENT_VERSION_GATE === 'true',
} as const;
