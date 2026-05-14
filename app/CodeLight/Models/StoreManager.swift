import Foundation
import Combine

/// OSS edition — no-op store manager.
///
/// `isPurchased` is hardcoded `true` so every entitlement check resolves to
/// "yes, full access." If you fork and want to wire your own purchase flow,
/// replace this file with a real implementation. Keep `@Published var
/// isPurchased: Bool` and the async method signatures intact so the rest of
/// the codebase compiles unchanged.
@MainActor
final class StoreManager: ObservableObject {
    static let shared = StoreManager()

    @Published var isPurchased: Bool = true
    @Published var purchasedButPendingVerify: Bool = false

    private init() {}

    func start() {}
    func retryPendingVerify() async {}
    func restorePurchase() async throws {}
}
