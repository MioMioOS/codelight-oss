import SwiftUI

/// Top-level list of paired Macs. Tap a Mac to drill into its session list.
/// Replaces the old ServerListView (which conflated "server" with "Mac").
struct LinkedMacsListView: View {
    @EnvironmentObject var appState: AppState
    // Observe StoreManager so isPurchased flips re-render the trial banner.
    // Without this, a freshly-purchased user would still see the trial banner
    // until appState.subscriptionStatus changes via server push.
    @ObservedObject private var storeManager = StoreManager.shared
    @State private var showAddPair = false
    @State private var showSettings = false

    var body: some View {
        Group {
            if appState.linkedMacs.isEmpty {
                emptyState
            } else {
                macList
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            // Two banners — only one shown at a time:
            //   • Blocked (red) — trial ended / session blocked → must upgrade to use server
            //   • Trial active (brand) — has remaining days → optional upgrade CTA
            // Permanently-paid users see neither — even if isSubscriptionBlocked
            // is stale from an earlier server `subscription-required` push that
            // wasn't cleared (race between onSubscriptionRequired and the later
            // onSubscriptionUpdated, or local StoreKit purchase before the server
            // refresh completes). Predicate matches Settings' badge logic so the
            // two screens never disagree.
            if appState.isSubscriptionBlocked && !isPermanentlyPaid {
                subscriptionBanner
            } else if shouldShowTrialBanner, let days = appState.trialDaysLeft {
                trialUpgradeBanner(daysLeft: days)
            }
        }
        .navigationTitle(String(localized: "macs"))
        .navigationDestination(for: LinkedMac.self) { mac in
            MacSessionListView(mac: mac)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    Haptics.light()
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Haptics.medium()
                    showAddPair = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showAddPair) {
            NavigationStack {
                PairingView()
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button(String(localized: "cancel")) { showAddPair = false }
                        }
                    }
            }
        }
        .sheet(isPresented: $showSettings, onDismiss: {
            // If SettingsView set pendingSubscriptionPaywall before dismissing,
            // present the paywall now from this (correct) presentation level.
            if appState.pendingSubscriptionPaywall {
                appState.pendingSubscriptionPaywall = false
                appState.showSubscriptionPaywall = true
            }
        }) {
            NavigationStack {
                SettingsView()
            }
        }
        .task {
            // Auto-connect if we have a last-used server but no active socket
            if !appState.isConnected, appState.lastUsedServerUrl != nil {
                await appState.connect()
            }
            if appState.isConnected {
                await appState.refreshLinkedMacs()
            }
        }
        .refreshable {
            await appState.refreshLinkedMacs()
            if let socket = appState.socket {
                if let fetched = try? await socket.fetchSessions() {
                    appState.sessions = fetched
                }
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "desktopcomputer")
                .font(.system(size: 56))
                .foregroundStyle(.secondary.opacity(0.5))

            VStack(spacing: 8) {
                Text(String(localized: "no_paired_macs"))
                    .font(.title3)
                    .fontWeight(.semibold)

                Text(String(localized: "tap_plus_to_pair"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            Button {
                Haptics.medium()
                showAddPair = true
            } label: {
                Label(String(localized: "pair_a_mac"), systemImage: "plus.circle.fill")
                    .font(.headline)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
                    .background(Theme.brand, in: Capsule())
                    .foregroundStyle(Theme.onBrand)
            }
            .padding(.top, 8)

            Spacer()
        }
        .padding()
    }

    // MARK: - Mac List

    /// Group Macs by their server host for display. Keeps the same server's
    /// Macs together, and puts the currently-connected server at the top.
    private var groupedMacs: [(server: String, macs: [LinkedMac])] {
        let grouped = Dictionary(grouping: appState.linkedMacs, by: \.serverUrl)
        let sorted = grouped.sorted { lhs, rhs in
            // Current server first
            if lhs.key == appState.currentServerUrl { return true }
            if rhs.key == appState.currentServerUrl { return false }
            return lhs.key < rhs.key
        }
        return sorted.map { (server: $0.key, macs: $0.value) }
    }

    private var macList: some View {
        List {
            ForEach(groupedMacs, id: \.server) { group in
                Section {
                    ForEach(group.macs) { mac in
                        NavigationLink(value: mac) {
                            MacRow(
                                mac: mac,
                                sessionCount: sessionCount(for: mac),
                                isActiveServer: mac.serverUrl == appState.currentServerUrl
                            )
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                Haptics.warning()
                                Task { await appState.unlinkMac(mac) }
                            } label: {
                                Label(String(localized: "unpair"), systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    HStack(spacing: 6) {
                        if group.server == appState.currentServerUrl && appState.isConnected {
                            Circle()
                                .fill(.green)
                                .frame(width: 6, height: 6)
                        }
                        Text(URL(string: group.server)?.host ?? group.server)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func sessionCount(for mac: LinkedMac) -> Int {
        // Only meaningful when the current server matches — otherwise sessions array
        // is for a different server and count will show 0.
        guard mac.serverUrl == appState.currentServerUrl else { return 0 }
        return appState.sessions.filter { $0.ownerDeviceId == mac.deviceId }.count
    }

    private var subscriptionBanner: some View {
        Button {
            appState.showSubscriptionPaywall = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                    .font(.system(size: 14))
                Text(String(localized: "subscription_required_banner"))
                    .font(.caption)
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                Text(String(localized: "upgrade"))
                    .font(.caption.bold())
                    .foregroundStyle(Theme.brand)
            }
            .padding(12)
            .background(Theme.bgElevated)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Theme.border, lineWidth: 0.5)
            )
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    /// Single source of truth for "this user has permanent access" — used to
    /// gate BOTH the red blocked banner and the soft trial CTA. Mirrors
    /// SettingsView.subscriptionBadge so the home screen and settings can
    /// never display contradictory subscription states (e.g., Settings says
    /// "已激活" while home banner says "需要订阅").
    private var isPermanentlyPaid: Bool {
        storeManager.isPurchased
            || (appState.subscriptionStatus == "active" && appState.trialDaysLeft == nil)
    }

    /// True iff a non-permanent access window is in effect — show the soft
    /// upgrade nudge. Excludes permanently-paid users (no daysLeft) and
    /// blocked users (handled by the red `subscriptionBanner` instead).
    private var shouldShowTrialBanner: Bool {
        guard !isPermanentlyPaid else { return false }
        guard appState.trialDaysLeft != nil else { return false }
        return appState.subscriptionStatus == "trial" || appState.subscriptionStatus == "active"
    }

    /// Soft "你在试用 — 升级到永久版" CTA. Tap → opens paywall.
    /// Critical for App Review: this is the prominent IAP entry point on the
    /// home screen so reviewers can locate the In-App Purchase within one tap.
    private func trialUpgradeBanner(daysLeft: Int) -> some View {
        Button {
            Haptics.light()
            appState.subscriptionReason = .voluntary
            appState.showSubscriptionPaywall = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Theme.brand)
                    .font(.system(size: 14))
                Text(String(format: NSLocalizedString("trial_banner_format", comment: ""), daysLeft))
                    .font(.caption)
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                Text(String(localized: "upgrade"))
                    .font(.caption.bold())
                    .foregroundStyle(Theme.brand)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.brand)
            }
            .padding(12)
            .background(Theme.bgElevated)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Theme.brand.opacity(0.3), lineWidth: 0.5)
            )
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }
}

private struct MacRow: View {
    let mac: LinkedMac
    let sessionCount: Int
    let isActiveServer: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 22))
                .foregroundStyle(isActiveServer ? Theme.brand : .secondary)
                .frame(width: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text(mac.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                if isActiveServer {
                    Text(sessionCount == 1
                         ? String(localized: "one_session")
                         : String(format: NSLocalizedString("n_sessions_format", comment: ""), sessionCount))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text(String(localized: "tap_to_switch_server"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
