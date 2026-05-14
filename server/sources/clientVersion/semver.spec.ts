import { describe, it, expect } from 'vitest';
import { semverLt, parseVersion } from './semver';

describe('parseVersion', () => {
    it('parses plain semver', () => {
        expect(parseVersion('2.4.0')).toEqual({ parts: [2, 4, 0], pre: null });
    });

    it('parses semver with pre-release suffix', () => {
        expect(parseVersion('2.4.0-tf1')).toEqual({ parts: [2, 4, 0], pre: 'tf1' });
    });

    it('parses semver with multi-part suffix', () => {
        expect(parseVersion('2.4.0-rc.2')).toEqual({ parts: [2, 4, 0], pre: 'rc.2' });
    });

    it('returns null for malformed input', () => {
        expect(parseVersion('not-a-version')).toBeNull();
        expect(parseVersion('2.4')).toBeNull();
        expect(parseVersion('2')).toBeNull();
    });
});

describe('semverLt', () => {
    it('compares major versions', () => {
        expect(semverLt('1.99.99', '2.0.0')).toBe(true);
        expect(semverLt('2.0.0', '1.99.99')).toBe(false);
    });

    it('compares minor versions', () => {
        expect(semverLt('2.3.0', '2.4.0')).toBe(true);
        expect(semverLt('2.4.0', '2.3.0')).toBe(false);
    });

    it('compares patch versions', () => {
        expect(semverLt('2.4.0', '2.4.1')).toBe(true);
        expect(semverLt('2.4.1', '2.4.0')).toBe(false);
    });

    it('returns false for identical versions', () => {
        expect(semverLt('2.4.0', '2.4.0')).toBe(false);
    });

    it('treats pre-release as EQUAL to release of same base (forgiving for TestFlight)', () => {
        // We intentionally ignore pre-release suffix for comparison — this
        // saves TestFlight users from being 426'd just because the Mac/iOS
        // client forgot to strip `-tf1` before sending the header.
        expect(semverLt('2.4.0-tf1', '2.4.0')).toBe(false);
        expect(semverLt('2.4.0', '2.4.0-tf1')).toBe(false);
        expect(semverLt('2.4.0-tf1', '2.4.0-tf5')).toBe(false);
    });

    it('still compares major.minor.patch even when pre-release is present', () => {
        // Pre-release affects nothing — the M.m.p comparison still runs.
        expect(semverLt('2.3.0-tf1', '2.4.0')).toBe(true);
        expect(semverLt('2.5.0-tf1', '2.4.0')).toBe(false);
    });

    it('returns false when either side is malformed', () => {
        expect(semverLt('garbage', '2.4.0')).toBe(false);
        expect(semverLt('2.4.0', 'garbage')).toBe(false);
    });

    it('handles 2.4.1 vs 2.4.0 (newer is not less)', () => {
        expect(semverLt('2.4.1', '2.4.0')).toBe(false);
    });

    it('handles 2.5.0 vs 2.4.0 (newer is not less)', () => {
        expect(semverLt('2.5.0', '2.4.0')).toBe(false);
    });
});
