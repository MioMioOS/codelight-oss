# NOTICE

This repository is a public, stripped reference snapshot of **Code Light**.
It is **not** the full production version distributed on the App Store.

## What's different from production

- **Monetization and access control removed.** All gating logic
  (purchase verification, entitlement checks, paywall flows) has been
  replaced with no-op stubs so the codebase compiles and runs end-to-end
  without any gating. Forks that want to wire their own access control can
  replace the stub files directly — the public function surfaces are kept
  stable.
- **Secrets and operational data excluded.** No `.env` values, signing keys,
  push notification credentials, or runtime user data are included.
- **Not actively maintained.** This is a frozen snapshot. Bug reports, pull
  requests, and feature suggestions are not actively reviewed. For the
  maintained, production version, see the App Store listing in the README.

## License reminder

Use of this code is governed by the [`LICENSE`](LICENSE) file
(**CC BY-NC 4.0**). Personal study, research, and learning are permitted.
Commercial use of any kind is not permitted under this license. For
commercial licensing inquiries, contact `xmqywx@gmail.com`.

— MioMioOS Team
