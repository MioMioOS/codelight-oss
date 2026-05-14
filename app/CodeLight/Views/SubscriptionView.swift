import SwiftUI

/// OSS edition — no-op paywall view.
///
/// Renders as `Color.clear` and dismisses itself on appear. Preserved as a
/// type so `RootView`'s `.fullScreenCover(item:)` switch keeps compiling.
/// If you fork and want a real paywall, replace this view; keep the
/// `SubscriptionView(reason:)` constructor signature.
struct SubscriptionView: View {
    let reason: AppState.SubscriptionReason
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Color.clear
            .onAppear {
                appState.activeSheet = nil
            }
    }
}
