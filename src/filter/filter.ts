import type {
  AndroidNode,
  Bounds,
  FilteredElement,
  IOSNode,
  RawUITree,
} from "./types";

// --- 5.3 Type Mapping ---

const IOS_ELEMENT_TYPE_MAP: Record<number, string> = {
  8: "button",
  9: "button",
  11: "checkbox",
  32: "slider",
  37: "picker",
  39: "switch",
  41: "link",
  42: "image",
  44: "input",
  47: "text",
  48: "input",
  49: "input",
  51: "input",
  57: "webview",
};

const WEBVIEW_CLASS_MAP: Record<string, string> = {
  "webview.Button": "button",
  "webview.Link": "link",
  "webview.Input": "input",
  "webview.Select": "picker",
  "webview.Checkbox": "checkbox",
  "webview.Radio": "radio",
  "webview.Switch": "switch",
  "webview.Slider": "slider",
  "webview.MenuItem": "menuitem",
  "webview.Heading": "heading",
  "webview.Paragraph": "text",
  "webview.Text": "text",
  "webview.List": "list",
  "webview.ListItem": "listitem",
  "webview.Table": "table",
  "webview.TableRow": "tablerow",
  "webview.TableCell": "tablecell",
  "webview.Navigation": "navigation",
  "webview.Main": "main",
  "webview.Article": "article",
  "webview.Section": "section",
  "webview.Form": "form",
  "webview.Dialog": "dialog",
  "webview.Banner": "banner",
  "webview.Footer": "footer",
  "webview.Aside": "aside",
  "webview.Image": "image",
  "webview.Element": "webview",
};

const ANDROID_CLASS_MAP: Record<string, string> = {
  "android.widget.Button": "button",
  "android.widget.EditText": "input",
  "android.widget.TextView": "text",
  "android.widget.CheckBox": "checkbox",
  "android.widget.Switch": "switch",
  "android.widget.ImageView": "image",
  "android.widget.ImageButton": "button",
  "android.view.View": "container",
};

function resolveType(className: string | null): string {
  if (className === null) return "unknown";

  // Tier 1: iOS normalized (ios. prefix)
  if (className.startsWith("ios.")) {
    return className.slice(4);
  }

  // Tier 2: WebView semantic
  if (className in WEBVIEW_CLASS_MAP) {
    return WEBVIEW_CLASS_MAP[className];
  }

  // Tier 3: Android native
  if (className in ANDROID_CLASS_MAP) {
    return ANDROID_CLASS_MAP[className];
  }

  // Tier 4: Fallback — raw className as-is
  return className;
}

// --- 5.7 Scoring ---

const TYPE_PRIORITY: Record<string, number> = {
  button: 10,
  link: 9,
  input: 8,
  heading: 7,
  checkbox: 6,
  switch: 6,
  radio: 6,
  slider: 6,
  picker: 6,
  menuitem: 5,
  image: 3,
  text: 2,
  container: 1,
  unknown: 0,
};

function semanticScore(element: FilteredElement): number {
  return (element.clickable ? 100 : 0) + (TYPE_PRIORITY[element.type] ?? 0);
}

// --- 5.1 Platform Detection ---

function isIOSFormat(nodes: unknown[]): boolean {
  if (nodes.length === 0) return false;
  const first = nodes[0] as Record<string, unknown>;
  return typeof first.elementType === "number" && first.frame != null;
}

// --- 5.2 iOS Normalization ---

const IOS_INPUT_TYPES = new Set(["input"]);
const IOS_CLICKABLE_TYPES = new Set(["button", "link", "input"]);

function normalizeIOSNode(node: IOSNode): AndroidNode {
  const unifiedType = IOS_ELEMENT_TYPE_MAP[node.elementType] ?? "other";
  const isInput = IOS_INPUT_TYPES.has(unifiedType);

  // Text extraction: input types prefer value > label > title; others prefer label > value > title
  let text: string | null;
  if (isInput) {
    text = node.value || node.label || node.title || null;
  } else {
    text = node.label || node.value || node.title || null;
  }

  const frame = node.frame;
  const bounds: Bounds = {
    left: frame.x,
    top: frame.y,
    right: frame.x + frame.width,
    bottom: frame.y + frame.height,
  };

  const children = (node.children ?? []).map(normalizeIOSNode);

  return {
    className: `ios.${unifiedType}`,
    text,
    hintText: node.placeholderValue ?? null,
    contentDesc: null,
    resourceId: node.identifier || null,
    packageName: null,
    bounds,
    checkable: false,
    checked: false,
    clickable: IOS_CLICKABLE_TYPES.has(unifiedType),
    enabled: node.enabled,
    focusable: false,
    focused: node.hasFocus,
    scrollable: false,
    longClickable: false,
    password: false,
    selected: node.selected,
    visibleToUser: true,
    children,
  };
}

// --- 5.4 Text Extraction ---

function extractText(node: AndroidNode): string {
  return node.text || node.hintText || node.contentDesc || "";
}

// --- 5.5 Filter Predicates ---

function boundsAreZero(b: Bounds): boolean {
  return b.left === 0 && b.top === 0 && b.right === 0 && b.bottom === 0;
}

function shouldFilter(node: AndroidNode, insideWebView: boolean): boolean {
  // 1. WebView ancestry: inside a WebView AND not a webview-sourced element
  if (insideWebView && node.source !== "webview") return true;

  const b = node.bounds;

  // 2. Null or all-zero bounds
  if (b === null || boundsAreZero(b)) return true;

  // 3. Zero or negative size
  if (b.right - b.left <= 0 || b.bottom - b.top <= 0) return true;

  return false;
}

function isWebViewContainer(node: AndroidNode): boolean {
  return node.className === "android.webkit.WebView";
}

// --- 5.6 Tree Flattening ---

interface FlattenContext {
  screenWidth: number;
  screenHeight: number;
  insideWebView: boolean;
}

function flattenTree(
  nodes: AndroidNode[],
  ctx: FlattenContext,
  result: FilteredElement[],
  idCounter: { value: number },
): void {
  for (const node of nodes) {
    const childCtx: FlattenContext = isWebViewContainer(node)
      ? { ...ctx, insideWebView: true }
      : ctx;

    if (!shouldFilter(node, ctx.insideWebView)) {
      const text = extractText(node);
      const clickable = node.clickable || node.longClickable;

      if (text.length > 0 || clickable || node.source === "webview") {
        const b = node.bounds;
        if (b !== null) {
          const centerX = (b.left + b.right) / 2;
          const centerY = (b.top + b.bottom) / 2;
          result.push({
            id: idCounter.value,
            text,
            bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
            center: { x: Math.round(centerX), y: Math.round(centerY) },
            type: resolveType(node.className),
            visible:
              centerX >= 0 &&
              centerX <= ctx.screenWidth &&
              centerY >= 0 &&
              centerY <= ctx.screenHeight,
            clickable,
          });
          idCounter.value++;
        }
      }
    }

    // Always process children, even if parent was filtered
    flattenTree(node.children ?? [], childCtx, result, idCounter);
  }
}

// --- 5.7 Deduplication ---

function exactDedup(elements: FilteredElement[]): FilteredElement[] {
  const seen = new Set<string>();
  const result: FilteredElement[] = [];
  for (const el of elements) {
    const key = `${el.text}|${el.bounds.left},${el.bounds.top},${el.bounds.right},${el.bounds.bottom}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(el);
    }
  }
  return result;
}

function textHoisting(elements: FilteredElement[]): FilteredElement[] {
  const claimed = new Set<number>(); // ids of elements already claimed as text sources
  const toRemove = new Set<number>();

  for (const parent of elements) {
    if (!parent.clickable || parent.text) continue;

    // Find non-clickable children with text whose bounds are contained within parent
    const candidates: FilteredElement[] = [];
    for (const child of elements) {
      if (child.id === parent.id) continue;
      if (child.clickable) continue;
      if (!child.text) continue;
      if (claimed.has(child.id)) continue;
      if (toRemove.has(child.id)) continue;

      // Check bounds containment (child inside parent)
      if (
        child.bounds.left >= parent.bounds.left &&
        child.bounds.top >= parent.bounds.top &&
        child.bounds.right <= parent.bounds.right &&
        child.bounds.bottom <= parent.bounds.bottom
      ) {
        candidates.push(child);
      }
    }

    if (candidates.length === 1) {
      parent.text = candidates[0].text;
      claimed.add(candidates[0].id);
      toRemove.add(candidates[0].id);
    }
  }

  return elements.filter((el) => !toRemove.has(el.id));
}

function boundsContain(outer: Bounds, inner: Bounds): boolean {
  const tolerance = 5;
  return (
    outer.left - tolerance <= inner.left &&
    outer.top - tolerance <= inner.top &&
    outer.right + tolerance >= inner.right &&
    outer.bottom + tolerance >= inner.bottom
  );
}

function textOverlaps(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function containmentDedup(elements: FilteredElement[]): FilteredElement[] {
  const dropped = new Set<number>(); // indices

  for (let i = 0; i < elements.length; i++) {
    if (dropped.has(i)) continue;
    const a = elements[i];

    for (let j = i + 1; j < elements.length; j++) {
      if (dropped.has(j)) continue;
      const b = elements[j];

      // Skip if no text overlap
      if (!textOverlaps(a.text, b.text)) continue;

      const aContainsB = boundsContain(a.bounds, b.bounds);
      const bContainsA = boundsContain(b.bounds, a.bounds);

      if (aContainsB && semanticScore(a) >= semanticScore(b)) {
        dropped.add(j);
      } else if (bContainsA && semanticScore(b) > semanticScore(a)) {
        dropped.add(i);
        break; // stop checking A against further elements
      }
    }
  }

  return elements.filter((_, idx) => !dropped.has(idx));
}

function reassignIds(elements: FilteredElement[]): FilteredElement[] {
  for (let i = 0; i < elements.length; i++) {
    elements[i].id = i + 1;
  }
  return elements;
}

// --- Main export ---

export function filterUITree(input: RawUITree): FilteredElement[] {
  // 5.1: Validate required fields
  if (input.screenWidth == null || input.screenHeight == null || !Array.isArray(input.nodes)) {
    throw new Error(
      "Invalid UI tree: missing required fields (screenWidth, screenHeight, nodes)",
    );
  }

  let androidNodes: AndroidNode[];

  // 5.1: Platform detection
  if (input.nodes.length > 0 && isIOSFormat(input.nodes)) {
    androidNodes = (input.nodes as IOSNode[]).map(normalizeIOSNode);
  } else {
    androidNodes = input.nodes as AndroidNode[];
  }

  // 5.6: Flatten
  const ctx: FlattenContext = {
    screenWidth: input.screenWidth,
    screenHeight: input.screenHeight,
    insideWebView: false,
  };
  const flat: FilteredElement[] = [];
  flattenTree(androidNodes, ctx, flat, { value: 1 });

  // 5.7: Deduplication
  let result = exactDedup(flat);
  result = textHoisting(result);
  result = containmentDedup(result);
  result = reassignIds(result);

  return result;
}
