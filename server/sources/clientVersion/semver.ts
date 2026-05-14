/**
 * Minimal semver comparator — NO npm dep. We only need `<` for the version
 * gate: "is this client below the minimum we're willing to serve?".
 *
 * Behavior:
 * - Compares major.minor.patch as integers.
 * - Pre-release suffix (e.g., `-tf1`, `-rc.2`, `-beta`) is **ignored** for
 *   comparison. `2.4.0-tf1` is treated as **equal** to `2.4.0`. This
 *   intentionally deviates from standard semver ordering: it makes the
 *   server forgiving when a TestFlight build forgets to strip its build
 *   tag before sending the X-Client-Version header. Loses a tiny bit of
 *   expressiveness (we can never set `minVersion` to a pre-release tag),
 *   but that's not a real production need — minVersion is always a
 *   shipped release.
 * - Invalid format on either side returns `false` (i.e., we do NOT claim
 *   "older than"). Callers should already null-check `clientInfo.version`
 *   before relying on the gate result.
 */

export interface ParsedVersion {
    parts: [number, number, number];
    pre: string | null;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/;

export function parseVersion(v: string): ParsedVersion | null {
    const m = v.match(VERSION_RE);
    if (!m) return null;
    return {
        parts: [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)],
        pre: m[4] || null,
    };
}

export function semverLt(a: string, b: string): boolean {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return false;

    for (let i = 0; i < 3; i++) {
        if (pa.parts[i] !== pb.parts[i]) return pa.parts[i]! < pb.parts[i]!;
    }

    // All three parts equal. Pre-release suffix is intentionally IGNORED —
    // a TestFlight build sending `mac/2.4.0-tf1` passes the same gate as
    // `mac/2.4.0`. See the file header comment for the rationale.
    return false;
}
