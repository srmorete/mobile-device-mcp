# Mobile Device MCP Server — Specification

Version: 1.0

## 1. System Overview

The system provides mobile device automation (iOS and Android) through a three-layer architecture:

1. **On-device servers** — HTTP servers running on each mobile device that expose the device's accessibility tree and accept interaction commands (tap, scroll, type, etc.). Each device runs its own isolated server instance.

2. **UI tree filter** — A normalization layer that converts raw UI tree JSON from either platform into a unified flat element list with deduplication.

3. **MCP server** — The external interface. Exposes 14 tools via the Model Context Protocol. Handles device discovery, bootstrapping, port allocation, and request proxying to on-device servers.

All coordinates use a single unified system called **render space**, derived at server startup from the device's native dimensions. Every on-device endpoint (screenshot pixels, UI tree bounds, tap/scroll inputs, /exec bindings) speaks render space; conversion to the platform-native coordinate system happens inside the server at the edge where it talks to the OS automation API.

**Render scale rule** (per-server, fixed for the server's lifetime):

```
renderScale = 1500 / max(nativeWidth, nativeHeight)   // if both dims > 0
renderScale = 1.0                                      // otherwise (identity)
```

- `max()` makes the scale rotation-invariant — a single value remains valid after device rotation.
- Larger devices downscale (1080×2400 → 0.625), smaller devices upscale (iPhone SE points 375×667 → 2.249; iPhone Pro Max points 430×932 → 1.609).
- iOS upscales from logical points but the source screenshot is captured at native pixel density (3× on retina), so the renderer super-samples from a sharper original.
- 1500 keeps the longer side below 1568 (model vision resize threshold) and 2000 (many-image cap).

Every platform exposes a single `Coord` module that owns `renderScale`, `toRender`, `toNative`, and scale-a-bounds helpers. HTTP handlers and /exec bindings share the same seam — raw OS-automation calls with unconverted coordinates are a bug.

---

## 2. MCP Server

### 2.1 Transport

Two transport modes, selected at startup:

- **Stdio** (default): Communicates via stdin/stdout using MCP stdio transport.
- **HTTP**: Enabled with `--port <PORT>` flag. Serves MCP Streamable HTTP transport at the `/mcp` path. All other paths return 404. A random bearer token is generated at startup and printed to stderr. HTTP requests to `/mcp` must include `Authorization: Bearer {token}`. The comparison is constant-time.

On `SIGINT` or `SIGTERM`, the server cleans up all bootstrapped devices (kills processes, removes port forwards/locks) and exits.

### 2.2 Tools

All tools return MCP-formatted responses. Parameters use the names and types shown below exactly.

#### 2.2.1 list_devices

Lists available devices without bootstrapping.

| Parameter | Type | Required |
|-----------|------|----------|
| *(none)* | | |

**Returns:** JSON array of device objects (as text content):

```json
[
  {
    "id": "string",
    "platform": "android | ios",
    "name": "string",
    "state": "string",
    "deviceType": "simulator | device"   // iOS only
  }
]
```

**Discovery sources:**
- Android: `adb devices -l` — parses device ID, state, and `model:` from the info field
- iOS simulators: `xcrun simctl list devices booted -j` — includes only devices with state `Booted`
- iOS real devices: `xcrun devicectl list devices --json-output` — includes only devices connected via USB (transport type `wired`)

Read-only. Does not trigger bootstrap.

#### 2.2.2 tap

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| x | number | yes |
| y | number | yes |

POSTs to on-device `/tap` with `x` and `y` as query parameters. Returns text response.

#### 2.2.3 double_tap

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| x | number | yes |
| y | number | yes |

POSTs to on-device `/doubleTap` with `x` and `y` as query parameters.

#### 2.2.4 long_press

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| x | number | yes |
| y | number | yes |
| duration | number | no |

Duration in milliseconds, defaults to 500. POSTs to on-device `/longPress`. Only includes `duration` in query params if explicitly provided.

#### 2.2.5 scroll

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| startX | number | yes |
| startY | number | yes |
| endX | number | yes |
| endY | number | yes |

POSTs to on-device `/scroll`. To scroll up: `startY > endY`. To scroll down: `startY < endY`.

#### 2.2.6 type_text

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| text | string | yes |

POSTs to on-device `/type` with `text` as query parameter.

#### 2.2.7 press_button

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| button | enum | yes |

Valid values: `home`, `back`, `volumeUp`, `volumeDown`, `enter`, `dpadUp`, `dpadDown`, `dpadLeft`, `dpadRight`, `dpadCenter`.

POSTs to on-device `/press` with `button` as query parameter.

Note: iOS only supports `home`. The MCP tool accepts all values; the on-device server returns an error for unsupported buttons.

#### 2.2.8 screenshot

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |

GETs on-device `/screenshot`. Returns the response as base64-encoded image content with MIME type `image/jpeg`. Both platforms emit JPEG in render-space dimensions.

#### 2.2.9 uitree

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| search | string | no |
| limit | number | no |

**Processing pipeline:**

1. GET on-device `/uitree`, parse JSON response
2. Pass through the UI tree filter (Section 5) to produce a flat element list
3. If `search` is provided: case-insensitive substring filter on element `text`
4. If `limit` is provided and element count exceeds it: truncate to `limit` elements and append `\n(showing {limit} of {total} elements, use 'search' to narrow results)`
5. Serialize each element as a JSON object, one per line (JSONL format)

Returns text content containing the JSONL output.

#### 2.2.10 launch_app

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| app_id | string | yes |

POSTs to on-device `/launchApp`. The query parameter key is platform-dependent:
- iOS: `bundleId`
- Android: `packageName`

#### 2.2.11 terminate_app

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| app_id | string | yes |

Same platform-dependent parameter key as launch_app. POSTs to on-device `/terminateApp`.

#### 2.2.12 list_apps

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |

GETs on-device `/listApps`. Returns the JSON array as text content.

#### 2.2.13 run_code

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| code | string | yes |

POSTs the code string as plain-text body (Content-Type: `text/plain`) to on-device `/exec`. Returns the JSON response as text content.

#### 2.2.14 install_app

| Parameter | Type | Required |
|-----------|------|----------|
| device_id | string | yes |
| app_path | string | yes |

Installs an app from a file on the host. Pure host-tooling operation — does NOT use the on-device server or the proxy wrapper (no bootstrap triggered):

- **Android:** `adb -s {device_id} install -r {app_path}` — requires an `.apk` file
- **iOS simulator:** `xcrun simctl install {device_id} {app_path}` — requires a `.app` bundle directory
- **iOS real device:** `xcrun devicectl device install app --device {device_id} {app_path}` — requires `.app` or `.ipa`

The artifact is validated (exists, right extension, file vs directory) before invoking host tooling. Returns the installer stdout on success.

### 2.3 Request Proxying

All tool calls (except `list_devices` and `install_app`) are routed through a retry wrapper:

1. Ensure the device is bootstrapped (see 2.4)
2. Execute the HTTP request to `http://127.0.0.1:{port}{path}` with `Authorization: Bearer {authToken}` header (the per-device token generated during bootstrap)
3. On success: return response
4. On connection error (`ECONNREFUSED`, `ECONNRESET`, or `fetch failed` in the error message): remove the device entry, re-bootstrap, and retry once
5. On HTTP error (server responded with non-2xx): throw immediately, no retry

**Proxy behavior:**
- GET requests: path only, no parameters
- POST with query params: parameters URL-encoded as `?key1=val1&key2=val2` (both keys and values encoded), no request body
- POST with body: Content-Type `text/plain`, body sent as-is
- GET for binary (screenshot): response returned as Buffer
- Error format: `{METHOD} {path} failed: {status} {statusText} — {body}`

### 2.4 Device Bootstrap

When a tool is called for a device not yet in the registry:

1. **Detect platform** — Check `adb devices`, then `xcrun simctl list devices booted`, then `xcrun devicectl list devices` to determine if the device is Android, iOS simulator, or iOS real device. Throw if not found in any.

2. **Allocate ports** — See 2.5.

2b. **Generate auth token** — Generate 32 random bytes as hex (64 characters). This token authenticates all requests from the MCP server to the on-device server. Delivery method is platform-specific (see below).

3. **Platform-specific bootstrap:**

   **Android:**
   - Install two APK files from the `drivers/android/` directory: the app APK and the androidTest APK (using `adb install -r -g`)
   - Set up ADB port forward for the server:
     - `adb -s {deviceId} forward tcp:{port} tcp:{port}`
     - CDP forwarding via ADB: `adb forward tcp:0 localabstract:chrome_devtools_remote` (auto-picks host port), then `adb reverse tcp:9222 tcp:{cdpPort}` so on-device CdpClient reaches Chrome through ADB (bypasses SELinux)
   - Write auth token to device file: `adb shell "echo -n {token} > /data/local/tmp/.mds_auth_{port}"`. The file is read and deleted by the on-device server on startup. This avoids exposing the token in process arguments (visible via `ps`).
   - Spawn the instrumentation process:
     ```
     adb -s {deviceId} shell am instrument -w -r
       -e class dev.uitreeserver.UITreeServer#startServer
       -e port {port}
       dev.uitreeserver.test/androidx.test.runner.AndroidJUnitRunner
     ```

   **iOS:**
   - Locate the `.xctestrun` file from `drivers/ios/` (simulators) or `drivers/ios-device/` (real devices)
   - Spawn xcodebuild:
     ```
     xcodebuild test-without-building
       -xctestrun {path}
       -destination {destination}
       -parallel-testing-enabled NO
       [-allowProvisioningUpdates]   # real devices only
     ```
   - Pass port and auth token via environment variables `TEST_RUNNER_PORT={port}` and `TEST_RUNNER_AUTH_TOKEN={token}` (xcodebuild strips the `TEST_RUNNER_` prefix and injects `PORT` and `AUTH_TOKEN` into the test runner process)
   - For real devices: also spawn `iproxy {port} {port} -u {deviceId}` as a tunnel process

4. **Health poll** — Poll `GET http://127.0.0.1:{port}/health` every 500ms until it returns 200 OK. Timeout after 30 seconds. If timeout: kill processes and throw. The `/health` endpoint is the only endpoint exempt from auth token validation.

5. **Register** — Store the device entry (platform, port, authToken, process handles) in the registry. Registration happens AFTER health check succeeds.

**Serialization:** Bootstrap operations are serialized through a promise chain. A second call for the same device waits for the first to complete, then re-checks the registry before attempting its own bootstrap.

### 2.5 Port Allocation

Base ports: iOS 22087, Android 8080.

**Android:** Build a set of used ports from: pending ports + registry ports + host-side ADB-forwarded ports (parsed from `adb forward --list`, extracting only the host port from each line). Starting from the base, increment until a port not in the used set is found.

**iOS:** Build a set of used ports from: pending ports + registry ports. Starting from the base, increment until a port that satisfies ALL three conditions:
1. Not in the used set
2. Not currently listening (checked via `lsof -i TCP:{port} -sTCP:LISTEN`)
3. Successfully locked via file-based locking

**File-based port locking (iOS):**
- Lock directory: `~/.mdms/ports/` (user-private; created with mode 0700; symlink-checked on every access)
- Lock file: `~/.mdms/ports/{port}` containing the PID of the owning process
- Acquire: write PID with exclusive-create flag (atomic). If file exists, read the PID and check if process is alive (`kill(pid, 0)`). If dead, delete and re-create. If alive, lock fails.
- Release: delete the lock file on device removal or bootstrap failure

**Pending ports:** Newly allocated ports are added to a pending set immediately. Released from pending after health check completes (success or failure). This prevents within-process races during concurrent bootstrap.

### 2.6 Device Removal & Cleanup

When removing a device:
1. Kill the on-device server process (SIGKILL, process group if possible)
2. Kill the tunnel process if present (iOS real devices)
3. Platform-specific cleanup:
   - **Android:** Force-stop the test package (`am force-stop dev.uitreeserver.test`), then remove ALL ADB forwards for the device (parsed from `adb -s {deviceId} forward --list`) and the reverse tunnel for port 9222
   - **iOS:** Delete the port lock file

Global cleanup (on shutdown) iterates all registered devices and removes each one.

---

## 3. Android On-Device Server

An HTTP server running inside an Android instrumentation test. Provides UI tree extraction, device interaction, and WebView content extraction via Chrome DevTools Protocol.

### 3.1 Startup

Runs as an instrumentation test entry point. Accepts port configuration via instrumentation argument `port` (default: 8080). Reads auth token from `/data/local/tmp/.mds_auth_{port}` (written by MCP bootstrap), then deletes the file. If the file is missing, the auth token is empty and all non-health requests are rejected with 401.

**Security:** All endpoints except `GET /health` require `Authorization: Bearer {token}`. Token comparison uses `MessageDigest.isEqual` (constant-time). Requests with a missing or non-localhost `Host` header are rejected with 403 (DNS rebinding defense). The HTTP server binds to `127.0.0.1` only.

On startup, configures the UI automation framework with minimal timeouts (0ms for acknowledgment, idle, and selector timeouts) to reduce extraction latency.

### 3.2 Coordinate System

All coordinates are in **render space** (see Section 1). `renderScale` is computed once at server startup from `device.displayWidth` / `device.displayHeight`:

```
renderScale = 1500 / max(displayWidth, displayHeight)
```

`max()` makes the value rotation-invariant, so a single scale is valid for the server's lifetime even when the device rotates. The chosen scale is logged at startup.

UI tree bounds, reported screen dimensions, screenshot pixels, and tap/scroll/longPress inputs are all in render space. Conversion to native pixels happens at the HTTP handler edge and inside the /exec uiDevice wrapper; raw UIAutomator calls sit behind the `Coord` seam.

### 3.3 Endpoints

#### GET /health

Returns `OK` as plain text (200).

#### GET /uitree

Returns the complete accessibility tree of the device screen.

**Query parameters:**
- `webview` (optional, boolean, default: `true`): Enable WebView content augmentation via CDP

**Response (JSON):**

```json
{
  "rotation": 0,
  "screenWidth": 1080,
  "screenHeight": 1920,
  "nodes": [ ...UITreeNode ]
}
```

`rotation`: Display rotation in degrees (0, 90, 180, 270).

**UITreeNode schema:**

```json
{
  "className": "string | null",
  "text": "string | null",
  "hintText": "string | null",
  "contentDesc": "string | null",
  "resourceId": "string | null",
  "packageName": "string | null",
  "bounds": { "left": 0, "top": 0, "right": 0, "bottom": 0 } | null,
  "checkable": false,
  "checked": false,
  "clickable": false,
  "enabled": true,
  "focusable": false,
  "focused": false,
  "scrollable": false,
  "longClickable": false,
  "password": false,
  "selected": false,
  "visibleToUser": true,
  "children": [ ...UITreeNode ],
  "source": "native | webview"
}
```

**UI tree extraction behavior:**

1. **Multi-window capture:** Attempts to get all accessibility window roots (not just the active window). Falls back to the single active window root if multi-window access is unavailable.

2. **Bounds clipping:** Every node's bounds are clipped to the visible screen rectangle `[0, screenWidth] x [0, screenHeight]`. Fully off-screen nodes get zero-sized bounds.

3. **Text sanitization:** All text, hint, and content description values are sanitized for XML 1.1 compliance. Characters in these ranges are replaced with `.`:
   - U+0001–U+0008, U+000B–U+000C, U+000E–U+001F
   - U+007F–U+0084, U+0086–U+009F
   - U+FDD0–U+FDEF
   
   Tab (U+0009), newline (U+000A), and carriage return (U+000D) are preserved. A string that becomes empty after sanitization returns null.

4. **Hint text:** Only available on Android API 26+. Null on older versions.

5. **WebView augmentation** (when `webview=true`):
   - Searches the native tree for WebView containers (class `android.webkit.WebView` or resource ID `com.android.chrome:id/compositor_view_holder` for Chrome Custom Tabs)
   - If found, discovers CDP targets and extracts semantic content (see 3.4)
   - WebView elements are added as children of the native WebView node
   - WebView elements have `source: "webview"`, native elements have `source: "native"`


Fields `text`, `id`, `name`, `aria-label`, `data-testid`, `value`, `type` are omitted if empty/null. `bounds` and `center` are omitted if coordinates are unavailable.

**Clickable roles for locator elements:** button, link, menuitem, menuitemcheckbox, menuitemradio, checkbox, radio, switch, tab, treeitem, option, textbox, searchbox, combobox, listbox, slider, spinbutton.

#### GET /screenshot

Returns a JPEG image in render space at quality 75. Pixel dimensions equal `(toRender(displayWidth), toRender(displayHeight))` — i.e. a screenshot pixel at `(x, y)` corresponds to the same screen location as a hierarchy bound at `(x, y)`.

Content-Type: `image/jpeg`.

#### POST /tap

**Query parameters:** `x` (number, required), `y` (number, required)

Taps at the given render-space coordinates. The handler converts to native pixels via `Coord.toNativeInt` before calling UIAutomator. Returns `OK` (200) or error (400 for missing params, 500 if tap fails).

#### POST /doubleTap

**Query parameters:** `x` (integer), `y` (integer)

Performs two taps with a 50ms delay between them.

#### POST /longPress

**Query parameters:** `x` (integer), `y` (integer), `duration` (integer, optional, default 500ms)

Implemented as a swipe gesture from the point to itself. The number of gesture steps is `max(duration / 5, 1)` (approximately 5ms per step).

#### POST /scroll

**Query parameters:** `startX`, `startY`, `endX`, `endY` (all integer, required)

Performs a swipe gesture with 10 fixed steps from start to end coordinates.

#### POST /type

**Query parameters:** `text` (string, required, non-empty)

Sets the text of the currently focused element. Does not simulate individual keystrokes. Returns 400 if no focused element is found.

#### POST /press

**Query parameters:** `button` (string, required, case-insensitive)

**Supported buttons and their key codes:**

| Button | Key Code |
|--------|----------|
| home | KEYCODE_HOME |
| back | KEYCODE_BACK |
| volumeup | KEYCODE_VOLUME_UP |
| volumedown | KEYCODE_VOLUME_DOWN |
| enter | KEYCODE_ENTER |
| dpadup | KEYCODE_DPAD_UP |
| dpaddown | KEYCODE_DPAD_DOWN |
| dpadleft | KEYCODE_DPAD_LEFT |
| dpadright | KEYCODE_DPAD_RIGHT |
| dpadcenter | KEYCODE_DPAD_CENTER |

Returns 400 with help text for unknown buttons.

#### POST /launchApp

**Query parameters:** `packageName` (string, required, non-empty)

Resolves the launcher activity for the package:
1. Try resolving via the default user (user 0)
2. If not found, detect work profile users (non-zero user IDs) and retry resolution for each
3. Launch the activity with `am start --user {userId} -n {activity}`

Returns 404 if no launcher activity can be resolved.

#### POST /terminateApp

**Query parameters:** `packageName` (string, required, non-empty)

Force-stops the package via `am force-stop {packageName}`.

#### GET /listApps

Returns a sorted JSON array of installed package names. Parsing `pm list packages` output, filtering lines starting with `package:`, sorting alphabetically.

#### POST /exec

**Input language:** JavaScript. The API surface mirrors the UIAutomator Java API, but the code must be valid JavaScript, not Java.

**Request body:** Plain text JavaScript code (Content-Type: text/plain)

**Response (JSON):**

```json
{
  "result": "string (last expression value or 'undefined')",
  "logs": ["string (console.log output)", ...]
}
```

Returns 400 on execution error.

**Runtime:** A sandboxed JavaScript engine with UIAutomator-style bindings. The bindings expose UIAutomator API names as JavaScript objects and methods.

**Available bindings:**

| Binding | Description |
|---------|-------------|
| `uiDevice` | Device automation object (sandboxed — see below) |
| `By` | Selector builder for finding UI elements |
| `Until` | Condition builder for wait operations |
| `console.log(...)` | Output captured in response `logs` array |

**uiDevice methods:**

- Interaction: `click(x, y)`, `swipe(startX, startY, endX, endY, steps)`, `drag(startX, startY, endX, endY, steps)`
- Finding: `findObject(selector)`, `findObjects(selector)`, `wait(condition, timeout)`, `hasObject(selector)`
- Hardware: `pressBack()`, `pressHome()`, `pressKeyCode(keyCode)`, `pressKeyCode(keyCode, metaState)`, `pressRecentApps()`
- Display: `displayWidth`, `displayHeight` (both in render space — match HTTP handlers), `displayRotation`
- State: `getCurrentPackageName()`, `wakeUp()`, `sleep()`, `isScreenOn()`
- Notifications: `openNotification()`, `openQuickSettings()`
- Waiting: `waitForIdle()`, `waitForIdle(timeout)`, `waitForWindowUpdate(packageName, timeout)`

**Sandbox security:**
- **Class shutter:** Explicit whitelist of safe classes (primitives, collections, UIAutomator types). All `java.lang.reflect`, `java.lang.Runtime`, `java.lang.Process`, `java.io`, `java.nio`, `java.net` packages are blocked.
- **Wrap factory:** All Java objects bridged into JS have `getClass()`, `class`, `forName()`, and `classLoader` stripped, preventing reflection-based sandbox escape.
- **Instruction limit:** Scripts are terminated after 10 million bytecode instructions (prevents infinite loops from blocking server threads).

### 3.4 WebView Content Extraction (Chrome DevTools Protocol)

Extracts semantic accessibility content from WebViews using the Chrome DevTools Protocol. Requires ADB tunneling to be set up (the MCP server's bootstrap handles this).

**Target discovery:**

1. Query `http://localhost:9222/json` for CDP targets
2. Filter to targets with type `page` or `webview` that have a `webSocketDebuggerUrl`
3. Further filter to targets that are both `visible` and `attached`

**WebView detection in native UI tree:**
A node is considered a WebView if either:
- Its className is `android.webkit.WebView`
- Its resourceId is `com.android.chrome:id/compositor_view_holder` (Chrome Custom Tabs)

**Semantic extraction:**
Uses a single `Runtime.evaluate` CDP call that injects a JavaScript script into the page. The script walks the DOM via `querySelectorAll('*')` and extracts for each visible element:
- Role: explicit `role` attribute, or implicit role derived from HTML tag (e.g. `<a>` → link, `<button>` → button, `<nav>` → navigation). Input types refined (e.g. `type="checkbox"` → checkbox, `type="search"` → searchbox).
- Accessible name: `aria-labelledby` (resolved), `aria-label`, `alt` (images), `value`/`placeholder` (inputs), or `textContent` (for leaf-like roles only, capped at 500 chars).
- Description: `title` or `aria-description`.
- States: disabled, checked, checkable, focused, selected, password.
- Bounds: `getBoundingClientRect()` scaled by `window.devicePixelRatio`.

This replaces the previous approach of `Accessibility.getFullAXTree` + N × `DOM.getBoxModel` (one per node) with a single CDP round-trip regardless of page complexity.

**Coordinate transformation (CSS to screen pixels):**

1. The injected script multiplies `getBoundingClientRect()` values by `window.devicePixelRatio` to produce device-pixel bounds relative to the viewport origin.
2. The on-device server adds the viewport origin offset: `screenCoord = jsCoord + viewportOrigin`

**Viewport origin resolution** (for the `viewportOrigin` offset):
1. **Chrome Custom Tabs:** Search the native UI tree for `com.android.chrome:id/toolbar`. Use its bottom Y coordinate as the content origin Y (X = 0). This is stable regardless of keyboard state.
2. **Fallback:** Use the top-left corner of the native WebView element's bounds.

**ARIA role to className mapping:**

The CDP role (lowercase) maps to a className used by the UI tree filter:

| Roles | className |
|-----------|-----------|
| button | webview.Button |
| link | webview.Link |
| textbox, searchbox, spinbutton | webview.Input |
| combobox, listbox | webview.Select |
| checkbox | webview.Checkbox |
| radio | webview.Radio |
| switch | webview.Switch |
| slider | webview.Slider |
| menuitem, menuitemcheckbox, menuitemradio | webview.MenuItem |
| heading | webview.Heading |
| paragraph | webview.Paragraph |
| list | webview.List |
| listitem | webview.ListItem |
| table | webview.Table |
| row | webview.TableRow |
| cell, gridcell, columnheader, rowheader | webview.TableCell |
| navigation | webview.Navigation |
| main | webview.Main |
| article | webview.Article |
| banner | webview.Banner |
| contentinfo | webview.Footer |
| complementary | webview.Aside |
| region, section | webview.Section |
| form | webview.Form |
| dialog, alertdialog | webview.Dialog |
| img, image | webview.Image |
| *(any other role)* | webview.Element |

**Clickable roles for UI tree integration:** button, link, menuitem, menuitemcheckbox, menuitemradio, checkbox, radio, switch, tab, treeitem, option.

**WebView-to-UITreeNode conversion:**

When WebView elements are added to the native UI tree, they are converted with:
- `className` = mapped from role (table above)
- `text` = accessible name
- `contentDesc` = accessible description
- `clickable` = true if role is in the clickable roles set
- `enabled` = inverse of disabled
- `checkable` = true if checked property exists
- `checked` = checked value (false if not present)
- `password` = true if element is `<input type="password">`
- `source` = `"webview"`
- `children` = empty list
- Only elements with positive width and height bounds are included

**CDP session management:**
- Single WebSocket connection per target, multiplexed by message ID
- Command timeout: 5000ms
- Connection pool limited to 1 connection per target, 10s keep-alive

---

## 4. iOS On-Device Server

An HTTP server running inside an XCUITest bundle. Provides UI tree extraction and device interaction using accessibility APIs.

### 4.1 Startup

Runs as an XCTest entry point. Port configured via `PORT` environment variable (default: 22087). Auth token configured via `AUTH_TOKEN` environment variable. The server blocks indefinitely, acting as a long-running service within the test process.

**Security:** All endpoints except `GET /health` require `Authorization: Bearer {token}`. Token comparison uses constant-time XOR. Requests with a missing or non-localhost `Host` header are rejected (DNS rebinding defense). The HTTP server binds to the loopback address only. If no auth token is configured, all non-health requests are rejected with 401.

### 4.2 Coordinate System

All coordinates are in **render space** (see Section 1). `renderScale` is computed once at server startup by snapshotting Springboard and reading the root frame — XCTest's `UIScreen` API reports `320×480` regardless of device, so a real snapshot is the only reliable source. Formula:

```
renderScale = 1500 / max(nativePointWidth, nativePointHeight)
```

iOS native dimensions are in logical points (1× scale). Because these are always below 1500 on current devices, this always upscales: iPhone SE (375×667 pt) → scale ≈ 2.249; iPhone 15 Pro Max (430×932 pt) → scale ≈ 1.609. The source screenshot capture is at native pixel density (e.g. 3× on Pro Max), so the renderer super-samples from a sharper original when rendering to render-space pixels — visually a *downscale from raw pixels* on retina devices, net byte-efficient.

UI tree frames, reported screen dimensions, screenshot pixels, and tap/scroll/longPress inputs are all in render space. Conversion to native points happens in the single `Coord` seam shared by HTTP handlers and /exec bindings. (The /exec surface is element-query based and takes no raw x/y.)

### 4.3 Endpoints

#### GET /health

Returns `OK` as plain text (200).

#### GET /uitree

Returns the accessibility tree of the current foreground app.

**Response (JSON):**

```json
{
  "screenWidth": 430.0,
  "screenHeight": 932.0,
  "nodes": [ ...UITreeNode ]
}
```

Screen dimensions are derived from the first root node's frame (`x + width`, `y + height`). Note: the underlying test framework reports screen size as 320x480 regardless of actual device, so dimensions must come from the snapshot frame, not the screen API.

**iOS UITreeNode schema:**

```json
{
  "identifier": "string",
  "label": "string",
  "title": "string | null",
  "value": "string | null",
  "placeholderValue": "string | null",
  "elementType": 48,
  "frame": { "x": 0.0, "y": 0.0, "width": 430.0, "height": 50.0 },
  "enabled": true,
  "selected": false,
  "hasFocus": false,
  "children": [ ...UITreeNode ] | null
}
```

Fields `title`, `value`, `placeholderValue` are omitted if null. `children` is omitted if null.

**elementType values** (integer mapping of accessibility element types):

| Value | Element Type |
|-------|-------------|
| 8 | Button |
| 9 | Radio Button |
| 11 | CheckBox |
| 32 | Slider |
| 37 | Picker |
| 39 | Switch |
| 41 | Link |
| 42 | Image |
| 44 | Search Field |
| 47 | Static Text |
| 48 | Text Field |
| 49 | Secure Text Field |
| 51 | Text View |
| 57 | Web View |

**Foreground app detection:**
1. Query all active apps with their states
2. Find apps with state `runningForeground`, excluding the home screen (Springboard)
3. If a foreground app is found, snapshot its accessibility tree
4. If no foreground app: fall back to Springboard's UI tree

**Additional UI tree sources:**
- Status bar elements from Springboard are always included
- If Safari's WebView service is in the foreground, its UI tree is included as additional nodes

**Snapshot capture:**
Uses the accessibility snapshot API to get a dictionary representation of the element tree, recursively building nodes from the snapshot's attributes and children.

#### GET /screenshot

Returns a JPEG image in render space at quality 0.75.

Content-Type: `image/jpeg`.

The raw screenshot is captured at the device's native pixel scale (e.g. 3× on Pro Max). It is re-rendered into a bitmap of size `(toRender(points.width), toRender(points.height))` so that screenshot pixel coordinates match UI tree frame coordinates exactly. The renderer super-samples from the native pixel source when downscaling from retina, and interpolates when upscaling from points on smaller devices.

#### POST /tap

**Query parameters:** `x` (double, required), `y` (double, required)

Taps at the given render-space coordinates. The handler converts to native logical points via `Coord.toNative` before constructing an `XCUICoordinate` in Springboard's coordinate space.

#### POST /doubleTap

**Query parameters:** `x` (double, required), `y` (double, required)

Double-tap at coordinates.

#### POST /longPress

**Query parameters:** `x` (double), `y` (double), `duration` (double, optional, default 500ms)

Long press. Duration is converted from milliseconds to seconds internally.

#### POST /scroll

**Query parameters:** `startX`, `startY`, `endX`, `endY` (all double, required)

Implemented as: press at start for 0.1 seconds, then drag to end coordinate.

#### POST /type

**Query parameters:** `text` (string, required, non-empty)

Types text via the test daemon's keyboard input API at a maximum frequency of 60 characters per second. This is asynchronous with a completion callback.

#### POST /press

**Query parameters:** `button` (string, required, case-insensitive)

**Supported buttons:** Only `home`.

Returns 400 with message `"Unknown button: {button}. Supported: home"` for unsupported buttons.

#### POST /launchApp

**Query parameters:** `bundleId` (string, required, non-empty)

Launches the app using the test daemon's application launch API with empty arguments and environment.

#### POST /terminateApp

**Query parameters:** `bundleId` (string, required, non-empty)

Terminates the app using the test daemon's application termination API.

#### GET /listApps

Returns a sorted JSON array of all installed application bundle IDs (strings). Sorted case-insensitively.

Uses the device's application workspace API (dynamically loaded) to enumerate installed applications.

#### POST /exec

**Input language:** JavaScript. The API surface mirrors XCUITest/Swift naming conventions, but the code must be valid JavaScript, not Swift. Use `var` for variable declarations (not Swift's `let`/`var` with type annotations). Use `matchingPredicate("format string")` (not `matching(NSPredicate(format:))`). String concatenation, control flow, and expressions follow JavaScript rules.

**Request body:** JavaScript code (UTF-8)

**Response (JSON):**

```json
{
  "result": "string",
  "logs": ["string", ...]
}
```

Returns 200 on success, 400 on JavaScript error or empty body.

**Runtime:** A JavaScript engine with XCUITest-style bindings. The bindings expose XCUITest API names as JavaScript objects and methods. A Proxy shim enables bracket-access element querying (`app.buttons["Login"]`), bridging a gap where the underlying JavaScript-to-native bridge cannot auto-export subscript access.

**Available global objects:**

| Binding | Description |
|---------|-------------|
| `app` | Proxy-wrapped foreground app (auto-detected, falls back to Springboard) |
| `springboard` | Proxy-wrapped Springboard app |
| `device` | Device control (orientation, pressHome) |
| `openApp(bundleId)` | Factory function to create app instances |
| `console` | `log()`, `warn()`, `error()` — output captured in `logs` |
| `sleep(ms)` | Blocks for specified milliseconds |

**`app` / `springboard` properties (Proxy-wrapped):**
- `bundleID`, `state`
- Element query collections: `buttons`, `textFields`, `secureTextFields`, `staticTexts`, `searchFields`, `otherElements`, `scrollViews`, `alerts`, `keyboards`, `windows`, `images`, `switches`, `cells`, `tables`, `collectionViews`, `navigationBars`, `tabBars`, `toolbars`, `pickers`, `textViews`, `links`, `webViews`, `sliders`, `steppers`, `segmentedControls`
- Methods: `launch()`, `activate()`, `terminate()`, `descendants(type)` (type is elementType integer)

**Element query interface:**
- `count` — number of matches
- `firstMatch` — first matching element
- `element(key)` — element by identifier (also accessible via bracket notation: `query["key"]`)
- `elementBoundBy(index)` — element by index
- `matchingPredicate(format)` — filter by NSPredicate format string passed as a plain JavaScript string
- `containingPredicate(format)` — filter by containment predicate passed as a plain JavaScript string

**Element interface:**

Properties (guarded — return safely even if element doesn't exist):
- `exists`, `isHittable`, `isEnabled`, `isSelected`, `label`, `identifier`, `title`, `value`

Sub-queries (lazy):
- `buttons`, `textFields`, `secureTextFields`, `staticTexts`, `searchFields`, `otherElements`, `scrollViews`, `images`, `switches`, `cells`, `links`

Actions (guarded — set error if element doesn't exist):
- `tap()`, `doubleTap()`, `typeText(text)`, `swipeUp()`, `swipeDown()`, `swipeLeft()`, `swipeRight()`, `pressForDuration(seconds)`, `waitForExistence(timeout)` → bool, `descendants(type)`

**Proxy shim:**
Bracket notation on queries is intercepted: `app.buttons["Login"].tap()` calls `element("Login")` internally. Return values are recursively wrapped to maintain the proxy chain.

**Element existence guard:**
Actions on elements that don't exist set a JavaScript error rather than crashing. The pattern is: check `.exists` before accessing properties or performing actions. `waitForExistence(timeout)` is safe and never throws.

**Sandbox security:**
- **Value coercion:** `element.value` is coerced to String or NSNumber before bridging into JSC. Raw NSObjects are never exposed to user code.
- **Predicate validation:** `matchingPredicate()` and `containingPredicate()` wrap `NSPredicate(format:)` in an ObjC exception catcher. Malformed format strings produce a JS error instead of crashing the process.
- **Sleep cap:** `sleep(ms)` is capped at 30 seconds to prevent indefinite thread blocking.
- A new `JSContext` is created for each `/exec` call — no state persists between invocations.

### 4.4 Error Handling

All HTTP handlers (uitree, tap, double tap, long press, scroll, press, screenshot, exec, launch app, terminate app, list apps) are wrapped in an exception guard that catches platform-level exceptions and returns 500 with the exception reason, preventing server crashes.

---

## 5. UI Tree Filter

Normalizes raw UI tree JSON from either platform into a unified flat element list. Used by the MCP server's `uitree` tool and available as a standalone CLI.

### 5.1 Input Format

Accepts either iOS or Android UI tree JSON (auto-detected).

**Platform detection:** If the first node in the `nodes` array has an `elementType` property (number) AND a `frame` property, the input is iOS format. Otherwise, it is Android format.

**Required top-level fields:** `screenWidth` (number), `screenHeight` (number), `nodes` (array). Throws if missing.

### 5.2 iOS Normalization

iOS input is normalized to Android format before processing:

**Frame to bounds conversion:**
```
bounds.left   = frame.x
bounds.top    = frame.y
bounds.right  = frame.x + frame.width
bounds.bottom = frame.y + frame.height
```

**Text extraction for iOS:**
- For input types (elementType maps to `input`): prefer `value` > `label` > `title`
- For all other types: prefer `label` > `value` > `title`
- Falls back to null if none present

**className assignment:** `"ios.{unifiedType}"` where unifiedType comes from the elementType mapping (Section 5.3).

**Clickable derivation:** true if unified type is `button`, `link`, or `input`.

**Other fields:**
- `hintText` = `placeholderValue`
- `resourceId` = `identifier`
- `enabled`, `focused` (`hasFocus`), `selected` carried over
- `contentDesc`, `packageName` = null
- `checkable`, `checked`, `focusable`, `scrollable`, `longClickable`, `password` = false
- `visibleToUser` = true
- `rotation` = 0

### 5.3 Type Mapping

Three-tier type resolution in this priority order:

**1. iOS normalized classNames** (prefix `ios.`):
Strip `ios.` prefix → unified type. The prefix comes from normalization (5.2).

iOS elementType integer → unified type:

| elementType | Unified Type |
|-------------|-------------|
| 8 | button |
| 9 | button |
| 11 | checkbox |
| 32 | slider |
| 37 | picker |
| 39 | switch |
| 41 | link |
| 42 | image |
| 44 | input |
| 47 | text |
| 48 | input |
| 49 | input |
| 51 | input |
| 57 | webview |
| *(any other)* | other |

**2. WebView semantic classNames:**

| className | Unified Type |
|-----------|-------------|
| webview.Button | button |
| webview.Link | link |
| webview.Input | input |
| webview.Select | picker |
| webview.Checkbox | checkbox |
| webview.Radio | radio |
| webview.Switch | switch |
| webview.Slider | slider |
| webview.MenuItem | menuitem |
| webview.Heading | heading |
| webview.Paragraph | text |
| webview.Text | text |
| webview.List | list |
| webview.ListItem | listitem |
| webview.Table | table |
| webview.TableRow | tablerow |
| webview.TableCell | tablecell |
| webview.Navigation | navigation |
| webview.Main | main |
| webview.Article | article |
| webview.Section | section |
| webview.Form | form |
| webview.Dialog | dialog |
| webview.Banner | banner |
| webview.Footer | footer |
| webview.Aside | aside |
| webview.Image | image |
| webview.Element | webview |

**3. Android native classNames:**

| className | Unified Type |
|-----------|-------------|
| android.widget.Button | button |
| android.widget.EditText | input |
| android.widget.TextView | text |
| android.widget.CheckBox | checkbox |
| android.widget.Switch | switch |
| android.widget.ImageView | image |
| android.widget.ImageButton | button |
| android.view.View | container |

**4. Fallback:** If className matches none of the above, return the raw className as-is. If className is null, return `"unknown"`.

### 5.4 Text Extraction

From Android-format nodes: `text || hintText || contentDesc || ""` (first non-empty value, or empty string).

### 5.5 Filter Predicates

A node is filtered out (skipped) if ANY of these conditions is true:

1. **WebView ancestry:** The node is inside a WebView container AND its `source` is not `"webview"`. (Native elements beneath a WebView are dropped in favor of CDP-extracted elements.)

2. **Null/zero bounds:** Bounds are null OR all four values are zero (left=0, top=0, right=0, bottom=0).

3. **Zero size:** Bounds are null OR width (`right - left`) is ≤ 0 OR height (`bottom - top`) is ≤ 0.

**WebView container detection:** A node with `className === "android.webkit.WebView"` marks the start of a WebView subtree. All descendants inherit the `insideWebView` context.

**Visibility check** (applied during element conversion, not filtering):
An element is `visible: true` if its center point is within screen bounds:
```
centerX = (left + right) / 2
centerY = (top + bottom) / 2
visible = centerX >= 0 AND centerX <= screenWidth AND centerY >= 0 AND centerY <= screenHeight
```

### 5.6 Tree Flattening

The hierarchical tree is flattened to a list of elements:

1. Initialize ID counter at 1
2. Initialize context: `{ screenWidth, screenHeight, insideWebView: false }`
3. For each root node, recursively process:
   - If node is a WebView container, set `insideWebView: true` for its descendants
   - If node passes filters (5.5), check: `text is non-empty OR clickable OR source === "webview"`
     - If yes: convert to FilteredElement and add to list
   - Always process all children with current context (even if the parent was filtered out)

**Element conversion:**

```json
{
  "id": 1,
  "text": "extracted text (5.4)",
  "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 50 },
  "center": { "x": 50, "y": 25 },
  "type": "button",
  "visible": true,
  "clickable": true
}
```

- `id`: Sequential from 1, re-assigned after deduplication
- `center`: `{ x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) }`
- `type`: From type mapping (5.3)
- `clickable`: `node.clickable OR node.longClickable`
- Elements with null bounds are dropped (return null)

### 5.7 Deduplication

Three-pass deduplication applied to the flat element list after flattening:

#### Pass 1: Exact Dedup

Remove elements with identical text AND identical bounds. Key: `"{text}|{left},{top},{right},{bottom}"`. First occurrence wins.

#### Pass 2: Text Hoisting

For each clickable element with no text (`clickable === true AND !text`):
1. Find all non-clickable elements with text whose bounds are contained within the parent's bounds, excluding elements already claimed by a previous hoisting operation
2. If exactly ONE such candidate exists: copy the child's text to the parent, mark the child for removal

This resolves the pattern where a clickable container wraps a single text-only child.

#### Pass 3: Containment Dedup

For each pair of remaining elements (i < j):
1. Check text overlap: skip the pair if either text is empty OR neither is a substring of the other. (`textOverlaps(a, b)` = false when `!a || !b`; true when `a.includes(b) || b.includes(a)`.)
2. Check containment with 5-pixel tolerance:
   ```
   boundsContain(outer, inner) =
     outer.left - 5 <= inner.left AND
     outer.top - 5 <= inner.top AND
     outer.right + 5 >= inner.right AND
     outer.bottom + 5 >= inner.bottom
   ```
3. If A contains B and A's score >= B's score: drop B
4. If B contains A and B's score > A's score: drop A (and stop checking A against further elements)

**Semantic scoring:**

```
score = (clickable ? 100 : 0) + typePriority
```

Type priority values:

| Type | Priority |
|------|----------|
| button | 10 |
| link | 9 |
| input | 8 |
| heading | 7 |
| checkbox | 6 |
| switch | 6 |
| radio | 6 |
| slider | 6 |
| picker | 6 |
| menuitem | 5 |
| image | 3 |
| text | 2 |
| container | 1 |
| unknown | 0 |
| *(any other)* | 0 |

#### ID Re-assignment

After all three passes, surviving elements are re-numbered sequentially starting from 1.

### 5.8 Output Format

**FilteredElement schema:**

```json
{
  "id": 1,
  "text": "string",
  "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 50 },
  "center": { "x": 50, "y": 25 },
  "type": "button",
  "visible": true,
  "clickable": true
}
```

All fields are always present. `text` may be an empty string. `id` is a sequential integer starting from 1.

### 5.9 CLI Mode

When run as a CLI (invoked via `npm run filter` or `bun run filter`, which executes `src/filter/index.ts`):
1. Read all of stdin as UTF-8
2. Error and exit(1) if input is empty
3. Parse as JSON. Error and exit(1) if invalid
4. Run through `filterUITree()` (which auto-detects platform)
5. Output each FilteredElement as a JSON line to stdout (JSONL: one JSON object per line, no array wrapper)
6. Errors go to stderr

Typical usage: `curl -s localhost:8080/uitree | npm run filter`

---

## Appendix A: Coordinate System Summary

Every endpoint on both platforms speaks **render space**. The platform's native coordinate system (Android device pixels, iOS logical points) is an internal implementation detail, confined to the `Coord` seam.

| | Android | iOS |
|---|---------|-----|
| Native source | Device pixels | Logical points (1× scale) |
| `renderScale` source | `device.displayWidth/Height` at startup | Springboard snapshot frame at startup |
| `renderScale` rule | `1500 / max(nativeW, nativeH)` | `1500 / max(nativeW, nativeH)` |
| Rotation-invariant? | Yes (via `max`) | Yes (via `max`) |
| Screenshot format | JPEG q=75, render-space pixels | JPEG q=0.75, render-space pixels |
| UI tree ↔ Screenshot ↔ Tap | 1:1 in render space | 1:1 in render space |

## Appendix B: Platform Differences Summary

| Feature | Android | iOS |
|---------|---------|-----|
| Default port | 8080 | 22087 |
| /uitree params | `?webview=true\|false` | None |
| /uitree response | Has `rotation` field | No `rotation` field |
| /uitree node format | `className` + `bounds` | `elementType` + `frame` |
| /screenshot format | JPEG quality 75, render-space dims | JPEG quality 0.75, render-space dims |
| /press buttons | 10 buttons | Only `home` |
| /launchApp param | `packageName` | `bundleId` |
| /terminateApp param | `packageName` | `bundleId` |
| /type behavior | Sets text on focused element | Keyboard input at 60 chars/sec |
| /scroll behavior | Swipe with 10 steps | Press 0.1s then drag |
| /longPress behavior | Swipe to same point | Press for duration |
| /exec runtime | Sandboxed scripting + UI automation | JavaScriptCore + XCUITest bindings |
| /exec bindings | `uiDevice`, `By`, `Until` | `app`, `springboard`, `device`, `openApp()` |
| WebView in /uitree | Via CDP (opt-in, default on) | Natively via accessibility |
| CDP port | Allocated dynamically (base 9222) | N/A |
| Port locking | Via ADB forward list | File locks at `~/.mdms/ports/` |

## Appendix C: Building Driver Artifacts

The `drivers/` directory contains pre-built binaries for convenience. To build from source:

**Android** (requires Android SDK with build-tools):

```bash
cd android
./gradlew assembleDebug assembleDebugAndroidTest
cp app/build/outputs/apk/debug/app-debug.apk ../drivers/android/
cp app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk ../drivers/android/
```

**iOS** (requires Xcode):

```bash
cd ios
xcodebuild build-for-testing \
  -project UITreeServer.xcodeproj \
  -scheme UITreeServerUITests \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData
rm -rf ../drivers/ios/Debug-iphonesimulator
cp -R DerivedData/Build/Products/Debug-iphonesimulator ../drivers/ios/
cp DerivedData/Build/Products/*.xctestrun ../drivers/ios/
```

After building, run `npm pack` at the project root to create the distributable tarball.
