# run_code API reference

`run_code` executes JavaScript on-device. Each call creates a fresh JS context — no state persists between calls.

## Response format

Both platforms return:

```json
{
  "result": "last expression value, or 'undefined'",
  "logs": ["console.log output", ...]
}
```

`result` is the stringified value of the last expression. `logs` captures all `console.log()`, `console.warn()`, and `console.error()` output.

---

## Android

Input language: JavaScript. The API mirrors UIAutomator Java naming conventions, but code must be valid JavaScript, not Java.

### Global bindings

| Binding | Description |
|---------|-------------|
| `uiDevice` | Device automation object |
| `By` | Selector builder (static methods: `text`, `res`, `clazz`, `desc`, `pkg`, etc.) |
| `Until` | Condition builder (static methods: `hasObject`, `gone`, `findObject`, etc.) |
| `console` | `log()`, `warn()`, `error()` — output captured in response `logs` array |

### uiDevice

**Methods (screen info):**
- `displayWidth()`, `displayHeight()` — screen dimensions in pixels
- `displayRotation()` — current rotation

**Interaction:**
- `click(x, y)` — tap at coordinates
- `swipe(startX, startY, endX, endY, steps)` — swipe gesture

**Finding elements:**
- `findObject(selector)` — find single element matching a `By` selector
- `hasObject(selector)` — check if element exists
- `wait(condition, timeout)` — wait for a condition (use with `Until`)

**Hardware:**
- `pressBack()`, `pressHome()`, `pressRecentApps()`
- `pressKeyCode(keyCode)`

**Waiting:**
- `waitForIdle()` — wait for device to be idle
- `waitForIdleTimeout(ms)` — wait with timeout

### Sandbox limits

- 10 million bytecode instruction limit.
- Class shutter: only safe classes (primitives, collections, UIAutomator types). Reflection, I/O, and networking are blocked.

---

## iOS

Input language: JavaScript. The API mirrors XCUITest/Swift naming conventions, but code must be valid JavaScript, not Swift. Use `var` for declarations (not Swift's typed `let` or `var`). Use `matchingPredicate("format string")` (not `matching(NSPredicate(format:))`).

### Global bindings

| Binding | Description |
|---------|-------------|
| `app` | Foreground app (auto-detected, falls back to Springboard) |
| `springboard` | Springboard app |
| `device` | Device control: `pressHome()`, `orientation()` |
| `openApp(bundleId)` | Create an app instance by bundle ID |
| `sleep(ms)` | Block for specified milliseconds (max 30s) |
| `console` | `log()`, `warn()`, `error()` — output captured in response `logs` array |

### App element queries

Access element collections on `app` or `springboard`:

`buttons`, `textFields`, `secureTextFields`, `staticTexts`, `searchFields`, `otherElements`, `scrollViews`, `alerts`, `keyboards`, `windows`, `images`, `switches`, `cells`, `tables`, `collectionViews`, `navigationBars`, `tabBars`, `toolbars`, `pickers`, `textViews`, `links`, `webViews`, `sliders`, `steppers`, `segmentedControls`

Properties: `bundleID`, `state`.

Methods: `launch()`, `activate()`, `terminate()`, `descendants(type)` (type is elementType integer).

### Element query interface

| Member | Description |
|--------|-------------|
| `count` | Number of matches (property, not a method call) |
| `firstMatch` | First matching element (property) |
| `element(key)` | Element by identifier |
| `["key"]` | Bracket access (calls `element(key)` via proxy) |
| `elementBoundBy(index)` | Element by index |
| `matchingPredicate(format)` | Filter by NSPredicate format string |
| `containingPredicate(format)` | Filter by containment predicate |

### Element interface

**Properties** (safe — return even if element doesn't exist):
`exists`, `isHittable`, `isEnabled`, `isSelected`, `label`, `identifier`, `title`, `value`

**Sub-queries** (lazy):
`buttons`, `textFields`, `secureTextFields`, `staticTexts`, `searchFields`, `otherElements`, `scrollViews`, `images`, `switches`, `cells`, `links`

**Actions** (set error if element doesn't exist):
`tap()`, `doubleTap()`, `typeText(text)`, `swipeUp()`, `swipeDown()`, `swipeLeft()`, `swipeRight()`, `pressForDuration(seconds)`, `waitForExistence(timeout)` → bool, `descendants(type)`

### Patterns

```javascript
// Bracket access for element by identifier
app.buttons["Login"].tap();

// Wait before acting
app.staticTexts["Welcome"].waitForExistence(5);

// Predicate queries
var items = app.cells.matchingPredicate("label BEGINSWITH 'Row'");
```

### Sandbox limits

- `sleep(ms)` capped at 30 seconds.
- Malformed predicates produce a JS error, not a crash.
- `element.value` is coerced to String/Number before bridging — raw NSObjects are never exposed.
