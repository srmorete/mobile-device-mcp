// Raw input types

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IOSNode {
  identifier: string;
  label: string;
  title?: string | null;
  value?: string | null;
  placeholderValue?: string | null;
  elementType: number;
  frame: Frame;
  enabled: boolean;
  selected: boolean;
  hasFocus: boolean;
  children?: IOSNode[] | null;
}

export interface AndroidNode {
  className: string | null;
  text: string | null;
  hintText: string | null;
  contentDesc: string | null;
  resourceId: string | null;
  packageName: string | null;
  bounds: Bounds | null;
  checkable: boolean;
  checked: boolean;
  clickable: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  longClickable: boolean;
  password: boolean;
  selected: boolean;
  visibleToUser: boolean;
  children: AndroidNode[];
  source?: "native" | "webview";
}

export interface RawUITree {
  screenWidth: number;
  screenHeight: number;
  nodes: (IOSNode | AndroidNode)[];
}

// Output types

export interface FilteredElement {
  id: number;
  text: string;
  bounds: Bounds;
  center: { x: number; y: number };
  type: string;
  visible: boolean;
  clickable: boolean;
}
