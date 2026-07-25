import XCTest
import FlyingFox

final class UITreeServer: XCTestCase {

    func testStartServer() async throws {
        let portString = ProcessInfo.processInfo.environment["PORT"] ?? "22087"
        let port = UInt16(portString) ?? 22087
        let authToken = ProcessInfo.processInfo.environment["AUTH_TOKEN"] ?? ""

        let server = try HTTPServer(address: .inet(ip4: "127.0.0.1", port: port))

        AppManager.installQuiescenceBypass()
        // Activate the bypass server-wide, not just during run_code (issue #15):
        // snapshotting a busy app (e.g. Safari's WebKit.WebContent on an animated
        // page) blocks in quiescence waits for 60s+ on a cold AX channel, which
        // outlives the host's 30s request timeout and wedges the first calls of
        // every session. JsEngine's own increment/decrement still composes.
        AppManager.skipQuiescence.increment()
        let extractor = UITreeExtractor()
        let interactions = Interactions(extractor: extractor)
        let appManager = AppManager()
        let jsEngine = JsEngine(extractor: extractor)

        // Security: reject non-localhost Host headers (DNS rebinding defense) and validate auth token
        func checkAuth(_ request: HTTPRequest) -> HTTPResponse? {
            guard let host = request.headers[.host] else {
                return HTTPResponse(statusCode: .badRequest, body: Data("Missing Host header".utf8))
            }
            let hostPattern = try? NSRegularExpression(pattern: "^(localhost|127\\.0\\.0\\.1)(:\\d+)?$")
            let match = hostPattern?.firstMatch(in: host, range: NSRange(host.startIndex..., in: host))
            if match == nil {
                return HTTPResponse(statusCode: .forbidden, body: Data("Forbidden".utf8))
            }
            guard !authToken.isEmpty else {
                return HTTPResponse(statusCode: .unauthorized, body: Data("Server misconfigured: no auth token".utf8))
            }
            let header = request.headers[.authorization] ?? ""
            // Constant-time comparison — always iterate over max length to avoid leaking token length
            let expected = Array("Bearer \(authToken)".utf8)
            let received = Array(header.utf8)
            let maxLen = max(expected.count, received.count)
            var mismatch: UInt8 = expected.count != received.count ? 1 : 0
            for i in 0..<maxLen {
                let e = i < expected.count ? expected[i] : 0
                let r = i < received.count ? received[i] : 0
                mismatch |= e ^ r
            }
            if mismatch != 0 {
                return HTTPResponse(statusCode: .unauthorized, body: Data("Unauthorized".utf8))
            }
            return nil
        }

        // GET /health (no auth required)
        await server.appendRoute("GET /health") { _ in
            HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
        }

        // GET /uitree
        await server.appendRoute("GET /uitree") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let started = Date()
                Self.log("GET /uitree: start")
                let tree = try extractor.captureUITree()
                let json = try JSONSerialization.data(withJSONObject: tree, options: [])
                let elapsed = String(format: "%.2f", Date().timeIntervalSince(started))
                Self.log("GET /uitree: done in \(elapsed)s, \(json.count) bytes")
                return HTTPResponse(
                    statusCode: .ok,
                    headers: [.contentType: "application/json"],
                    body: json
                )
            }
        }

        // GET /screenshot
        await server.appendRoute("GET /screenshot") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let imageData = try extractor.captureScreenshot()
                return HTTPResponse(
                    statusCode: .ok,
                    headers: [.contentType: "image/jpeg"],
                    body: imageData
                )
            }
        }

        // POST /tap
        await server.appendRoute("POST /tap") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let params = Self.queryParams(from: request)
                guard let xStr = params["x"], let x = Double(xStr),
                      let yStr = params["y"], let y = Double(yStr) else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Missing x or y".utf8))
                }
                try Self.catchObjCException { interactions.tap(x: x, y: y) }
                return HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
            }
        }

        // POST /doubleTap
        await server.appendRoute("POST /doubleTap") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let params = Self.queryParams(from: request)
                guard let xStr = params["x"], let x = Double(xStr),
                      let yStr = params["y"], let y = Double(yStr) else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Missing x or y".utf8))
                }
                try Self.catchObjCException { interactions.doubleTap(x: x, y: y) }
                return HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
            }
        }

        // POST /longPress
        await server.appendRoute("POST /longPress") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let params = Self.queryParams(from: request)
                guard let xStr = params["x"], let x = Double(xStr),
                      let yStr = params["y"], let y = Double(yStr) else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Missing x or y".utf8))
                }
                let durationMs = Double(params["duration"] ?? "") ?? 500.0
                try Self.catchObjCException { interactions.longPress(x: x, y: y, durationMs: durationMs) }
                return HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
            }
        }

        // POST /scroll
        await server.appendRoute("POST /scroll") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let params = Self.queryParams(from: request)
                guard let sx = Double(params["startX"] ?? ""),
                      let sy = Double(params["startY"] ?? ""),
                      let ex = Double(params["endX"] ?? ""),
                      let ey = Double(params["endY"] ?? "") else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Missing scroll parameters".utf8))
                }
                try Self.catchObjCException { interactions.scroll(startX: sx, startY: sy, endX: ex, endY: ey) }
                return HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
            }
        }

        // POST /type
        await server.appendRoute("POST /type") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let params = Self.queryParams(from: request)
                guard let text = params["text"], !text.isEmpty else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Missing or empty text".utf8))
                }
                try interactions.typeText(text)
                return HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
            }
        }

        // POST /press
        await server.appendRoute("POST /press") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let params = Self.queryParams(from: request)
                guard let button = params["button"] else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Missing button".utf8))
                }
                if button.lowercased() == "home" {
                    try Self.catchObjCException { interactions.pressHome() }
                    return HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
                } else {
                    return HTTPResponse(
                        statusCode: .badRequest,
                        body: Data("Unknown button: \(button). Supported: home".utf8)
                    )
                }
            }
        }

        // POST /launchApp
        await server.appendRoute("POST /launchApp") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let params = Self.queryParams(from: request)
                guard let bundleId = params["bundleId"], !bundleId.isEmpty else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Missing bundleId".utf8))
                }
                try Self.catchObjCException { appManager.launchApp(bundleId: bundleId) }
                return HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
            }
        }

        // POST /terminateApp
        await server.appendRoute("POST /terminateApp") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let params = Self.queryParams(from: request)
                guard let bundleId = params["bundleId"], !bundleId.isEmpty else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Missing bundleId".utf8))
                }
                try Self.catchObjCException { appManager.terminateApp(bundleId: bundleId) }
                return HTTPResponse(statusCode: .ok, body: Data("OK".utf8))
            }
        }

        // GET /listApps
        await server.appendRoute("GET /listApps") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let apps = appManager.listApps()
                let json = try JSONSerialization.data(withJSONObject: apps, options: [])
                return HTTPResponse(
                    statusCode: .ok,
                    headers: [.contentType: "application/json"],
                    body: json
                )
            }
        }

        // POST /exec
        await server.appendRoute("POST /exec") { request in
            if let deny = checkAuth(request) { return deny }
            return await Self.exceptionGuard {
                let bodyData = try await request.bodyData
                guard !bodyData.isEmpty else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Empty body".utf8))
                }
                guard let code = String(data: bodyData, encoding: .utf8), !code.isEmpty else {
                    return HTTPResponse(statusCode: .badRequest, body: Data("Invalid UTF-8 body".utf8))
                }
                let result = jsEngine.execute(code: code)
                let json = try JSONSerialization.data(withJSONObject: result.dict, options: [])
                let statusCode: HTTPStatusCode = result.isError ? .badRequest : .ok
                return HTTPResponse(
                    statusCode: statusCode,
                    headers: [.contentType: "application/json"],
                    body: json
                )
            }
        }

        // Block indefinitely -- the server runs as a long-lived service
        try await server.start()
    }

    // MARK: - Helpers

    /// Convenience accessor: query["name"] on FlyingFox's [QueryItem].
    static func queryParams(from request: HTTPRequest) -> [String: String] {
        var result: [String: String] = [:]
        for item in request.query {
            result[item.name] = item.value
        }
        return result
    }

    static func exceptionGuard(_ handler: () async throws -> HTTPResponse) async -> HTTPResponse {
        do {
            return try await handler()
        } catch {
            let reason = (error as NSError).localizedDescription
            // stderr lands in the host-side log file (mdms-ios-<port>.log) — an
            // otherwise empty 500 body leaves no trace (issue #15).
            Self.log("500: \(reason)")
            return HTTPResponse(
                statusCode: .internalServerError,
                body: Data(reason.utf8)
            )
        }
    }

    /// Unbuffered stderr log. NSLog only reaches the simulator system log,
    /// which the host-side log file never sees.
    static func log(_ message: String) {
        FileHandle.standardError.write(Data("[UITreeServer] \(message)\n".utf8))
    }

    /// Wraps a synchronous block that may throw ObjC NSExceptions (which Swift do/catch cannot catch).
    static func catchObjCException(_ block: @escaping () -> Void) throws {
        try ObjCExceptionCatcher.catchException(block)
    }
}
