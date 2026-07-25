import { describe, test, expect } from "bun:test";
import { filterUITree, rankSearchResults } from "../src/filter/filter";
import type { AndroidNode, FilteredElement, IOSNode, RawUITree } from "../src/filter/types";

// --- Helpers ---

function androidNode(overrides: Partial<AndroidNode> = {}): AndroidNode {
  return {
    className: "android.widget.TextView",
    text: null,
    hintText: null,
    contentDesc: null,
    resourceId: null,
    packageName: null,
    bounds: { left: 100, top: 200, right: 300, bottom: 250 },
    checkable: false,
    checked: false,
    clickable: false,
    enabled: true,
    focusable: false,
    focused: false,
    scrollable: false,
    longClickable: false,
    password: false,
    selected: false,
    visibleToUser: true,
    children: [],
    ...overrides,
  };
}

function iosNode(overrides: Partial<IOSNode> = {}): IOSNode {
  return {
    identifier: "",
    label: "",
    elementType: 48, // XCUIElementTypeStaticText → text
    frame: { x: 100, y: 200, width: 200, height: 50 },
    enabled: true,
    selected: false,
    hasFocus: false,
    ...overrides,
  };
}

function tree(
  nodes: (AndroidNode | IOSNode)[],
  width = 1080,
  height = 1920,
): RawUITree {
  return { screenWidth: width, screenHeight: height, nodes };
}

// --- Validation ---

describe("filterUITree validation", () => {
  test("throws on missing screenWidth", () => {
    expect(() =>
      filterUITree({ screenHeight: 1920, nodes: [] } as any),
    ).toThrow("Invalid UI tree");
  });

  test("throws on missing screenHeight", () => {
    expect(() =>
      filterUITree({ screenWidth: 1080, nodes: [] } as any),
    ).toThrow("Invalid UI tree");
  });

  test("throws on missing nodes", () => {
    expect(() =>
      filterUITree({ screenWidth: 1080, screenHeight: 1920 } as any),
    ).toThrow("Invalid UI tree");
  });

  test("throws on zero screen dimensions", () => {
    expect(() => filterUITree(tree([], 0, 1920))).toThrow("non-positive screen dimensions");
    expect(() => filterUITree(tree([], 1080, 0))).toThrow("non-positive screen dimensions");
  });

  test("returns empty array for empty nodes", () => {
    expect(filterUITree(tree([]))).toEqual([]);
  });
});

// --- Android basic ---

describe("Android nodes", () => {
  test("text element produces one FilteredElement with correct fields", () => {
    const result = filterUITree(
      tree([androidNode({ text: "Hello" })]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 1,
      text: "Hello",
      type: "text",
      bounds: { left: 100, top: 200, right: 300, bottom: 250 },
      center: { x: 200, y: 225 },
      visible: true,
      clickable: false,
    });
  });

  test("clickable button", () => {
    const result = filterUITree(
      tree([
        androidNode({
          text: "Submit",
          className: "android.widget.Button",
          clickable: true,
        }),
      ]),
    );
    expect(result[0].type).toBe("button");
    expect(result[0].clickable).toBe(true);
  });

  test("clickable element with no text is included", () => {
    const result = filterUITree(
      tree([androidNode({ clickable: true, className: "android.widget.Button" })]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("");
  });

  test("non-clickable element with no text is excluded", () => {
    const result = filterUITree(tree([androidNode()]));
    expect(result).toHaveLength(0);
  });

  test("hintText used when text is null", () => {
    const result = filterUITree(
      tree([androidNode({ hintText: "Enter email", className: "android.widget.EditText" })]),
    );
    expect(result[0].text).toBe("Enter email");
  });

  test("contentDesc used as fallback", () => {
    const result = filterUITree(
      tree([androidNode({ contentDesc: "Menu", clickable: true })]),
    );
    expect(result[0].text).toBe("Menu");
  });

  test("longClickable element is included and marked clickable", () => {
    const result = filterUITree(
      tree([androidNode({ longClickable: true, clickable: false, className: "android.view.View" })]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].clickable).toBe(true);
  });
});

// --- Bounds filtering ---

describe("bounds filtering", () => {
  test("zero bounds filtered out", () => {
    const result = filterUITree(
      tree([androidNode({ text: "X", bounds: { left: 0, top: 0, right: 0, bottom: 0 } })]),
    );
    expect(result).toHaveLength(0);
  });

  test("null bounds filtered out", () => {
    const result = filterUITree(
      tree([androidNode({ text: "X", bounds: null })]),
    );
    expect(result).toHaveLength(0);
  });

  test("negative-size bounds filtered out", () => {
    const result = filterUITree(
      tree([androidNode({ text: "X", bounds: { left: 300, top: 200, right: 100, bottom: 250 } })]),
    );
    expect(result).toHaveLength(0);
  });

  test("zero-width bounds filtered out", () => {
    const result = filterUITree(
      tree([androidNode({ text: "X", bounds: { left: 100, top: 200, right: 100, bottom: 250 } })]),
    );
    expect(result).toHaveLength(0);
  });
});

// --- iOS nodes ---

describe("iOS nodes", () => {
  test("button is normalized", () => {
    const result = filterUITree(tree([iosNode({ label: "Tap me", elementType: 9 })]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "Tap me", type: "button", clickable: true });
  });

  test("input prefers value over label", () => {
    const result = filterUITree(
      tree([iosNode({ label: "Username", value: "john@example.com", elementType: 49 })]),
    );
    expect(result[0].text).toBe("john@example.com");
  });

  test("non-input prefers label over value", () => {
    const result = filterUITree(
      tree([iosNode({ label: "Status", value: "Active", elementType: 48 })]),
    );
    expect(result[0].text).toBe("Status");
  });

  test("frame converted to bounds", () => {
    const result = filterUITree(
      tree([iosNode({ label: "Test", frame: { x: 10, y: 20, width: 100, height: 50 } })]),
    );
    expect(result[0].bounds).toEqual({ left: 10, top: 20, right: 110, bottom: 70 });
  });

  test("link is clickable", () => {
    const result = filterUITree(tree([iosNode({ label: "Click here", elementType: 42 })]));
    expect(result[0].clickable).toBe(true);
    expect(result[0].type).toBe("link");
  });

  test("children are normalized recursively", () => {
    const result = filterUITree(
      tree([
        iosNode({
          label: "Container",
          elementType: 48,
          children: [iosNode({ label: "Child Button", elementType: 9 })],
        }),
      ]),
    );
    const btn = result.find((e) => e.text === "Child Button");
    expect(btn).toBeDefined();
    expect(btn!.type).toBe("button");
    expect(btn!.clickable).toBe(true);
  });
});

// --- Type resolution ---

describe("type resolution", () => {
  test("android.widget.Button → button", () => {
    const r = filterUITree(tree([androidNode({ text: "OK", className: "android.widget.Button" })]));
    expect(r[0].type).toBe("button");
  });

  test("android.widget.EditText → input", () => {
    const r = filterUITree(tree([androidNode({ text: "v", className: "android.widget.EditText" })]));
    expect(r[0].type).toBe("input");
  });

  test("android.widget.ImageButton → button", () => {
    const r = filterUITree(tree([androidNode({ clickable: true, className: "android.widget.ImageButton" })]));
    expect(r[0].type).toBe("button");
  });

  test("webview.Link → link", () => {
    const r = filterUITree(tree([androidNode({ text: "Click", className: "webview.Link", source: "webview" })]));
    expect(r[0].type).toBe("link");
  });

  test("unknown className used as-is", () => {
    const r = filterUITree(tree([androidNode({ text: "X", className: "com.custom.Widget" })]));
    expect(r[0].type).toBe("com.custom.Widget");
  });

  test("null className → unknown", () => {
    const r = filterUITree(tree([androidNode({ text: "X", className: null })]));
    expect(r[0].type).toBe("unknown");
  });
});

// --- Visibility (intersection semantics, off-screen excluded by default) ---

describe("visibility", () => {
  test("on screen → visible", () => {
    const r = filterUITree(tree([androidNode({ text: "V" })], 1080, 1920));
    expect(r[0].visible).toBe(true);
  });

  test("off screen right → excluded by default", () => {
    const r = filterUITree(
      tree([androidNode({ text: "V", bounds: { left: 1100, top: 200, right: 1300, bottom: 250 } })], 1080, 1920),
    );
    expect(r).toHaveLength(0);
  });

  test("off screen bottom → excluded by default", () => {
    const r = filterUITree(
      tree([androidNode({ text: "V", bounds: { left: 100, top: 2000, right: 300, bottom: 2050 } })], 1080, 1920),
    );
    expect(r).toHaveLength(0);
  });

  test("off screen above (negative coords) → excluded by default", () => {
    const r = filterUITree(
      tree([androidNode({ text: "V", bounds: { left: 100, top: -800, right: 300, bottom: -700 } })], 1080, 1920),
    );
    expect(r).toHaveLength(0);
  });

  test("includeInvisible keeps off-screen elements flagged visible:false", () => {
    const r = filterUITree(
      tree([androidNode({ text: "V", bounds: { left: 1100, top: 200, right: 1300, bottom: 250 } })], 1080, 1920),
      { includeInvisible: true },
    );
    expect(r).toHaveLength(1);
    expect(r[0].visible).toBe(false);
  });

  test("giant container with off-screen center is visible (intersects screen)", () => {
    const r = filterUITree(
      tree([androidNode({ text: "Page", bounds: { left: 0, top: 97, right: 690, bottom: 9571 } })], 690, 1330),
    );
    expect(r).toHaveLength(1);
    expect(r[0].visible).toBe(true);
  });

  test("partially off-screen edge element is visible", () => {
    const r = filterUITree(
      tree([androidNode({ text: "V", bounds: { left: 1000, top: 200, right: 1200, bottom: 250 } })], 1080, 1920),
    );
    expect(r).toHaveLength(1);
    expect(r[0].visible).toBe(true);
  });
});

// --- iOS element type mapping (public XCUIElementType numbering) ---

describe("iOS element type mapping", () => {
  const typeOf = (elementType: number) =>
    filterUITree(tree([iosNode({ label: "X", elementType })]))[0];

  test("static text (48) → text, not clickable", () => {
    expect(typeOf(48)).toMatchObject({ type: "text", clickable: false });
  });

  test("link (42) → link, clickable", () => {
    expect(typeOf(42)).toMatchObject({ type: "link", clickable: true });
  });

  test("search field (45) → input, clickable", () => {
    expect(typeOf(45)).toMatchObject({ type: "input", clickable: true });
  });

  test("text field (49) / secure text field (50) / text view (52) → input", () => {
    expect(typeOf(49).type).toBe("input");
    expect(typeOf(50).type).toBe("input");
    expect(typeOf(52).type).toBe("input");
  });

  test("button (9) → button, clickable", () => {
    expect(typeOf(9)).toMatchObject({ type: "button", clickable: true });
  });

  test("switch (40) → switch; image (43) → image; webview (58) → webview", () => {
    expect(typeOf(40).type).toBe("switch");
    expect(typeOf(43).type).toBe("image");
    expect(typeOf(58).type).toBe("webview");
  });

  test("interactive controls are clickable: switch (40), toggle (41), checkbox (12), slider (33), picker (38)", () => {
    expect(typeOf(40)).toMatchObject({ type: "switch", clickable: true });
    expect(typeOf(41)).toMatchObject({ type: "switch", clickable: true });
    expect(typeOf(12)).toMatchObject({ type: "checkbox", clickable: true });
    expect(typeOf(33)).toMatchObject({ type: "slider", clickable: true });
    expect(typeOf(38)).toMatchObject({ type: "picker", clickable: true });
  });

  test("unlabeled switch is kept (clickable alone is enough)", () => {
    const r = filterUITree(tree([iosNode({ label: "", elementType: 40 })]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ type: "switch", clickable: true });
  });

  test("unmapped type → other", () => {
    expect(typeOf(1).type).toBe("other");
  });
});

// --- Search ranking (leaf-oriented) ---

describe("rankSearchResults", () => {
  const el = (overrides: Partial<FilteredElement>): FilteredElement => ({
    id: 0,
    text: "match",
    bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    center: { x: 50, y: 25 },
    type: "text",
    visible: true,
    clickable: false,
    ...overrides,
  });

  test("container containing another match ranks after the leaf", () => {
    const container = el({ bounds: { left: 0, top: 0, right: 690, bottom: 9571 } });
    const leaf = el({ bounds: { left: 10, top: 100, right: 200, bottom: 150 } });
    const ranked = rankSearchResults([container, leaf]);
    expect(ranked[0]).toBe(leaf);
    expect(ranked[1]).toBe(container);
  });

  test("visible ranks before invisible", () => {
    const invisible = el({ visible: false, bounds: { left: 0, top: 0, right: 50, bottom: 50 } });
    const visible = el({ bounds: { left: 0, top: 0, right: 500, bottom: 500 } });
    const ranked = rankSearchResults([invisible, visible]);
    expect(ranked[0]).toBe(visible);
  });

  test("smaller area ranks first among leaves", () => {
    const big = el({ bounds: { left: 0, top: 0, right: 400, bottom: 400 } });
    const small = el({ bounds: { left: 0, top: 500, right: 100, bottom: 550 } });
    const ranked = rankSearchResults([big, small]);
    expect(ranked[0]).toBe(small);
  });

  test("equal-bounds duplicates are not treated as container/leaf", () => {
    const a = el({ text: "a" });
    const b = el({ text: "b" });
    const ranked = rankSearchResults([a, b]);
    expect(ranked[0]).toBe(a); // stable order preserved
  });
});

// --- Exact dedup ---

describe("exact dedup", () => {
  test("same text + same bounds → one element", () => {
    const node = () => androidNode({ text: "Dup", bounds: { left: 10, top: 10, right: 100, bottom: 50 } });
    const result = filterUITree(tree([node(), node()]));
    expect(result).toHaveLength(1);
  });

  test("same text + different bounds → both kept", () => {
    const result = filterUITree(
      tree([
        androidNode({ text: "Same", bounds: { left: 10, top: 10, right: 100, bottom: 50 } }),
        androidNode({ text: "Same", bounds: { left: 400, top: 10, right: 500, bottom: 50 } }),
      ]),
    );
    expect(result).toHaveLength(2);
  });
});

// --- Text hoisting ---

describe("text hoisting", () => {
  test("clickable parent steals text from sole non-clickable child", () => {
    const parent = androidNode({
      clickable: true,
      className: "android.widget.Button",
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      children: [
        androidNode({
          text: "Click me",
          bounds: { left: 50, top: 10, right: 350, bottom: 90 },
        }),
      ],
    });
    const result = filterUITree(tree([parent]));
    const btn = result.find((e) => e.type === "button");
    expect(btn).toBeDefined();
    expect(btn!.text).toBe("Click me");
    // Child text should be removed
    expect(result.filter((e) => e.type === "text" && e.text === "Click me")).toHaveLength(0);
  });

  test("no hoisting with multiple text children", () => {
    const parent = androidNode({
      clickable: true,
      className: "android.widget.Button",
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      children: [
        androidNode({ text: "Line 1", bounds: { left: 10, top: 10, right: 390, bottom: 45 } }),
        androidNode({ text: "Line 2", bounds: { left: 10, top: 55, right: 390, bottom: 90 } }),
      ],
    });
    const result = filterUITree(tree([parent]));
    expect(result.find((e) => e.text === "Line 1")).toBeDefined();
    expect(result.find((e) => e.text === "Line 2")).toBeDefined();
    // Parent button should still have empty text (no hoisting occurred)
    const btn = result.find((e) => e.type === "button");
    expect(btn).toBeDefined();
    expect(btn!.text).toBe("");
  });
});

// --- Containment dedup ---

describe("containment dedup", () => {
  test("clickable button wins over contained text with same content", () => {
    const result = filterUITree(
      tree([
        androidNode({
          text: "Submit",
          clickable: true,
          className: "android.widget.Button",
          bounds: { left: 100, top: 200, right: 400, bottom: 280 },
        }),
        androidNode({
          text: "Submit",
          bounds: { left: 120, top: 210, right: 380, bottom: 270 },
        }),
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("button");
    expect(result[0].clickable).toBe(true);
  });

  test("no dedup when texts don't overlap", () => {
    const result = filterUITree(
      tree([
        androidNode({ text: "First", bounds: { left: 0, top: 0, right: 500, bottom: 100 } }),
        androidNode({ text: "Second", bounds: { left: 10, top: 10, right: 490, bottom: 90 } }),
      ]),
    );
    expect(result).toHaveLength(2);
  });

  test("outer button drops inner text when B contains A (reversed order)", () => {
    const result = filterUITree(
      tree([
        // A (first): non-clickable text at smaller bounds (score 2)
        androidNode({
          text: "Submit",
          className: "android.widget.TextView",
          bounds: { left: 120, top: 210, right: 380, bottom: 270 },
        }),
        // B (second): clickable button at larger bounds (score 110) — B contains A
        androidNode({
          text: "Submit",
          clickable: true,
          className: "android.widget.Button",
          bounds: { left: 100, top: 200, right: 400, bottom: 280 },
        }),
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("button");
    expect(result[0].clickable).toBe(true);
  });

  test("containment with 5px tolerance keeps the clickable element", () => {
    const result = filterUITree(
      tree([
        androidNode({
          text: "Label",
          clickable: true,
          className: "android.widget.Button",
          bounds: { left: 100, top: 200, right: 400, bottom: 280 },
        }),
        androidNode({
          text: "Label",
          // Inner slightly outside outer, but within 5px tolerance
          bounds: { left: 96, top: 196, right: 404, bottom: 284 },
        }),
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].clickable).toBe(true);
  });
});

// --- WebView filtering ---

describe("webview filtering", () => {
  test("native element inside WebView container is filtered", () => {
    const result = filterUITree(
      tree([
        androidNode({
          className: "android.webkit.WebView",
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          children: [
            androidNode({
              text: "Native inside webview",
              bounds: { left: 10, top: 10, right: 200, bottom: 50 },
            }),
          ],
        }),
      ]),
    );
    expect(result.find((e) => e.text === "Native inside webview")).toBeUndefined();
  });

  test("webview-sourced element inside WebView is kept", () => {
    const result = filterUITree(
      tree([
        androidNode({
          className: "android.webkit.WebView",
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          children: [
            androidNode({
              text: "Web content",
              className: "webview.Link",
              source: "webview",
              bounds: { left: 10, top: 10, right: 200, bottom: 50 },
            }),
          ],
        }),
      ]),
    );
    const web = result.find((e) => e.text === "Web content");
    expect(web).toBeDefined();
    expect(web!.type).toBe("link");
  });
});

// --- ID reassignment ---

describe("IDs", () => {
  test("sequential starting from 1 after dedup", () => {
    const result = filterUITree(
      tree([
        androidNode({ text: "A", bounds: { left: 0, top: 0, right: 100, bottom: 50 } }),
        androidNode({ text: "B", bounds: { left: 0, top: 100, right: 100, bottom: 150 } }),
        androidNode({ text: "C", bounds: { left: 0, top: 200, right: 100, bottom: 250 } }),
      ]),
    );
    expect(result.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

// --- Center calculation ---

describe("center", () => {
  test("rounded to nearest integer", () => {
    const result = filterUITree(
      tree([androidNode({ text: "X", bounds: { left: 0, top: 0, right: 101, bottom: 51 } })]),
    );
    // (0+101)/2 = 50.5 → 51, (0+51)/2 = 25.5 → 26
    expect(result[0].center).toEqual({ x: 51, y: 26 });
  });
});

// --- Tree traversal ---

describe("tree traversal", () => {
  test("children of filtered parents are still processed", () => {
    const result = filterUITree(
      tree([
        androidNode({
          // No text, not clickable → filtered, but child should survive
          bounds: { left: 0, top: 0, right: 500, bottom: 500 },
          children: [androidNode({ text: "Nested", bounds: { left: 10, top: 10, right: 200, bottom: 50 } })],
        }),
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Nested");
  });

  test("deeply nested elements are flattened", () => {
    const result = filterUITree(
      tree([
        androidNode({
          bounds: { left: 0, top: 0, right: 500, bottom: 500 },
          children: [
            androidNode({
              bounds: { left: 0, top: 0, right: 500, bottom: 500 },
              children: [androidNode({ text: "Deep", bounds: { left: 10, top: 10, right: 100, bottom: 50 } })],
            }),
          ],
        }),
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Deep");
  });
});
