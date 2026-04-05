---
name: use-mobile-device
description: Drive iOS and Android devices using the mobile-device-mcp tools (screenshot, tap, uitree, scroll, type_text, run_code, etc.). Use when MCP device-control tools are available and the user wants to interact with a mobile device.
---

# Using mobile devices

You have MCP tools for controlling iOS and Android devices. This skill covers how to use them effectively.

## Interaction loop

1. Call `list_devices` to get a valid `device_id`.
2. Call `screenshot` to see the current screen.
3. Call `uitree` to get elements with coordinates. Use the `search` param to filter by text.
4. Act: `tap`, `type_text`, `scroll`, `press_button`, `long_press`, `double_tap`, etc. Use the element's `center` field as tap coordinates.
5. Call `screenshot` to confirm the result.

Repeat 2-5 as needed.

## Finding elements

`uitree` returns elements as JSONL. Each line is a JSON object with these fields (all always present):

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Sequential integer starting from 1 |
| `text` | string | Element text (may be empty) |
| `type` | string | Semantic type: `button`, `input`, `text`, `switch`, `image`, etc. |
| `bounds` | object | `{left, top, right, bottom}` in screen coordinates |
| `center` | object | `{x, y}` — center of bounds, ready to use as tap coordinates |
| `visible` | boolean | Whether the element is within the screen bounds |
| `clickable` | boolean | Whether the element accepts taps |

- Use `search` to filter by text (case-insensitive substring match).
- Use `limit` to cap results when the tree is large.
- If the target element is off-screen, `scroll` to reveal it, then call `uitree` again.
- Use `center` coordinates for tapping, not visual estimation from screenshots.

## Coordinates

- Android: pixels.
- iOS: logical points (1x scale). Do not multiply by screen scale.

## Text input

Tap the target text field first to focus it, then call `type_text`.

## Scrolling

Scroll direction follows finger movement:
- Down (reveal content below): `startY > endY` (finger moves up).
- Up (reveal content above): `startY < endY` (finger moves down).
- Use mid-screen X and a Y delta of 300-500.

## Buttons

`press_button` accepts these values: `home`, `back`, `volumeUp`, `volumeDown`, `enter`, `dpadUp`, `dpadDown`, `dpadLeft`, `dpadRight`, `dpadCenter`. iOS only supports `home`.

`long_press` accepts an optional `duration` in milliseconds (1–10000, default 500).

## Apps

- `list_apps` returns installed app IDs.
- `launch_app` and `terminate_app` take `app_id`: bundle ID on iOS, package name on Android.

## Code Execution

Executes JavaScript on-device. Each call runs in a fresh context — no state persists between calls.

Returns `{ result: "last expression value", logs: ["console.log output", ...] }`.

For detailed `run_code` API reference per platform, see [examples/run-code-tool.md](examples/run-code-tool.md).

### Android

Sandboxed JS engine with UIAutomator bindings. Write JavaScript, not Java.

Global objects: `uiDevice`, `By`, `Until`, `console`.

```javascript
// Find and click a button by text
var btn = uiDevice.findObject(By.text("Submit"));
btn.click();

// Wait for an element to appear
uiDevice.wait(Until.hasObject(By.res("com.app:id/done")), 5000);

// Screen dimensions — callable functions, not bare properties
var w = uiDevice.displayWidth();
var h = uiDevice.displayHeight();
```

### iOS

JS engine with XCUITest bindings. Write JavaScript, not Swift — use `var` for declarations, not typed `let`.

Global objects: `app` (foreground app), `springboard`, `device`, `openApp(bundleId)`, `sleep(ms)`, `console`.

```javascript
// Tap a button by label
app.buttons["Login"].tap();

// Type into a text field
var field = app.textFields.firstMatch;
field.tap();
field.typeText("hello");

// Wait for element existence
var ok = app.buttons["OK"].waitForExistence(5);

// Query by predicate
var cells = app.cells.matchingPredicate("label CONTAINS 'Item'");
```

## Avoid

- Guessing coordinates from screenshots instead of reading `uitree`.
- Assuming an action succeeded without verifying via `screenshot`.
- Calling tools without a `device_id` from `list_devices`.
