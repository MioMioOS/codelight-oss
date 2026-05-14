import Foundation

/// Centralized client-version header support. Every HTTPS request we send to
/// the CodeLight server carries `X-Client-Version: ios/<base-semver>`. The
/// server may use this to record rollout observability and (optionally) reject
/// outdated clients with HTTP 426 + `{"error":"client_too_old", ...}`. See
/// `AppVersionGate.check`.

enum ClientVersion {
    /// Header name we use on every outgoing HTTPS request.
    static let headerName = "X-Client-Version"

    /// `ios/<MAJOR.MINOR.PATCH>`. Pre-release suffix (e.g., `-tf1` on a
    /// TestFlight build) is stripped here so admin distribution rows stay
    /// clean. The server's gate treats `ios/2.5.0-tf1` as equal to
    /// `ios/2.5.0` regardless, so stripping is technically optional — but
    /// the distribution chart in /v1/admin/clients reads much better when
    /// release vs TF builds share a single row.
    static var headerValue: String {
        let raw = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let base = raw.split(separator: "-").first.map(String.init) ?? raw
        return "ios/\(base)"
    }
}

extension URLRequest {
    /// Adds the `X-Client-Version` header to this request. Idempotent —
    /// overwrites if already set. Call AFTER the request is otherwise
    /// constructed (headers/body) and BEFORE handing it to URLSession.
    mutating func addClientVersionHeader() {
        setValue(ClientVersion.headerValue, forHTTPHeaderField: ClientVersion.headerName)
    }
}

extension Notification.Name {
    /// Posted when an HTTP response is detected as 426 Upgrade Required with
    /// `error: "client_too_old"`. RootView observes this and surfaces the
    /// upgrade prompt. UserInfo carries `downloadUrl` and `message` from the
    /// server response so the UI can pass them through.
    static let clientTooOld = Notification.Name("com.codelight.clientTooOld")
}

/// App Store deep link used by the upgrade prompt.
private let APP_STORE_DEEP_LINK = "itms-apps://itunes.apple.com/app/id6761744871"

enum AppVersionGate {
    /// Inspect a URLSession response. If it is HTTP 426 AND the body declares
    /// `error: "client_too_old"`, post `.clientTooOld` notification so the
    /// upgrade prompt UI can fire. Returns true if a gate hit was detected
    /// (caller may want to short-circuit further error handling). Safe to
    /// call on every response — no-op for non-426 statuses.
    ///
    /// We require BOTH conditions (status + error key) so a misconfigured
    /// proxy returning 426 for unrelated reasons doesn't falsely trigger
    /// the upgrade flow.
    @discardableResult
    static func check(_ data: Data, _ response: URLResponse) -> Bool {
        guard let http = response as? HTTPURLResponse, http.statusCode == 426 else { return false }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (json["error"] as? String) == "client_too_old" else { return false }
        let userInfo: [AnyHashable: Any] = [
            "downloadUrl": (json["downloadUrl"] as? String) ?? APP_STORE_DEEP_LINK,
            "message": (json["message"] as? String) ?? "",
        ]
        NotificationCenter.default.post(name: .clientTooOld, object: nil, userInfo: userInfo)
        return true
    }

    /// App Store deep link the upgrade prompt should open. Public so the
    /// alert UI can use it whether or not a notification has fired yet
    /// (e.g., from a Settings → "Check for updates" affordance later).
    static var appStoreUrl: URL {
        URL(string: APP_STORE_DEEP_LINK)!
    }
}

extension URLSession {
    /// Drop-in replacement for `data(for:)` that handles the client-version
    /// protocol end-to-end:
    ///   1. Mutates the request to add `X-Client-Version: ios/<base-semver>`
    ///   2. Performs the request
    ///   3. Inspects the response for HTTP 426 + `client_too_old` and posts
    ///      the `.clientTooOld` notification if hit
    ///   4. Returns the original `(Data, URLResponse)` tuple
    ///
    /// Use this for ALL outgoing server requests instead of `data(for:)`.
    /// Caller does not need to call `addClientVersionHeader()` or
    /// `AppVersionGate.check()` separately — both are baked in.
    func codeLightData(for request: URLRequest) async throws -> (Data, URLResponse) {
        var req = request
        req.addClientVersionHeader()
        let (data, response) = try await self.data(for: req)
        AppVersionGate.check(data, response)
        return (data, response)
    }
}

