# Mobile Device MCP

An MCP server that lets AI agents control iOS and Android devices (tap, scroll, type, take screenshots, read UI trees, and run code). Works with multiple devices at the same time.

## How It Works

Three-layer architecture:

1. **On-device servers** — Lightweight HTTP servers running on each mobile device (UIAutomator on Android, XCUITest on iOS) that expose the accessibility tree and accept interaction commands.
2. **UI tree filter** — Normalizes raw UI trees from both platforms into a unified flat element list.
3. **MCP server** — The external interface. Handles device discovery, bootstrapping, port allocation, and proxies requests to on-device servers.

Devices are bootstrapped on first use — the server installs the driver app, allocates a port, starts the on-device server, and polls until it's healthy. After that, all tool calls are proxied over localhost HTTP with per-device bearer token auth.

## Tools

| Tool | Description |
|------|-------------|
| `list_devices` | List available iOS and Android devices |
| `screenshot` | Capture the device screen (JPEG) |
| `uitree` | Get the UI element tree as a flat list, with optional search and limit |
| `tap` | Tap at screen coordinates |
| `double_tap` | Double-tap at screen coordinates |
| `long_press` | Long-press at screen coordinates (configurable duration) |
| `scroll` | Swipe from start to end coordinates |
| `type_text` | Type text into the focused element |
| `press_button` | Press a hardware/navigation button (home, back, enter, volumeUp/Down, dpadUp/Down/Left/Right/Center) |
| `launch_app` | Launch an app by bundle ID / package name |
| `terminate_app` | Force-stop an app |
| `list_apps` | List installed apps |
| `run_code` | Execute sandboxed JavaScript on-device (see [run_code](#run_code) below) |

### run_code

Agents can pass code _that looks like_ UIAutomator or XCUITest, both being Javascript under the hood.
The sandbox restricts (Android) potentially dangerous Java operations and only allows (iOS) some XCUITest-ish commands

- **Android:** Rhino engine with UIAutomator bindings — `uiDevice` (click, swipe, find elements, press keys, read display info), `By` (selectors), `Until` (wait conditions), `console.log()`
- **iOS:** JavaScriptCore with XCUITest bindings — `app` (query elements, tap, type, swipe), `springboard`, `device`, `openApp(bundleId)`, `sleep(ms)`, `console.log()`

Both platforms automatically kill runaway scripts (infinite loops) and create a fresh sandbox per call.

## Prerequisites

- **Node.js** 18+ (for running via `npx`)
- **Android:** Android SDK with `adb` on PATH
- **iOS Simulator:** Xcode with `xcrun`, `simctl`
- **iOS Real Device:** Xcode with `xcodebuild`, `devicectl`, and `iproxy` (from [libimobiledevice](https://libimobiledevice.org/))
- **Building from source:** [Bun](https://bun.sh/) runtime, Gradle (Android), Xcode (iOS)

## Installation

### Claude Code

```bash
claude mcp add mobile-device-mcp -- npx -y @srmorete/mobile-device-mcp@latest
```

Or with custom ports:
```bash
claude mcp add mobile-device-mcp -e MDMS_PORT_ANDROID=20000 -e MDMS_PORT_IOS=21000 -- npx -y @srmorete/mobile-device-mcp@latest
```

### Modifying `.mcp.json` (Cursor, Claude Desktop, etc)

```json
{
  "mcpServers": {
    "mobile-device-mcp": {
      "command": "npx",
      "args": ["-y", "@srmorete/mobile-device-mcp@latest"],
      "env": {
        "MDMS_PORT_ANDROID": "18000",           # optional
        "MDMS_PORT_IOS": "19000"                # optional
      }
    }
  }
}
```

## Building from Source

```bash
git clone <repo-url>
cd mobile-device-mcp
bun install

# Build drivers for both platforms and pack tarball
./scripts/build.sh
```

The build script compiles the on-device drivers (Android APKs via Gradle, iOS test bundle via xcodebuild), copies them to `drivers/`, and creates an npm tarball.

To run locally during development:

```bash
bun run start           # Start the MCP server
bun test                # Run the test suite
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MDMS_PORT_ANDROID` | 18000 | Base port for Android on-device servers |
| `MDMS_PORT_IOS` | 19000 | Base port for iOS on-device servers |

Ports are assigned sequentially — first Android device gets `18000`, second gets `18001`, and so on. Same for iOS starting at `19000`.

## Acknowledgements

Mobile Device MCP server stands on the shoulders of giants such as [mobile-mcp](https://github.com/mobile-next/mobile-mcp) and [Maestro](https://github.com/mobile-dev-inc/maestro).
Used as inspiration but reframed the current approach to be multi-device and with seamless Native/WebView support (especially on Android).

## License

MIT
