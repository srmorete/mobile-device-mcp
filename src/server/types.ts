import type { Subproc } from "./proc.js";

export type Platform = "android" | "ios";
export type DeviceType = "simulator" | "device";

export interface DiscoveredDevice {
  id: string;
  platform: Platform;
  name: string;
  state: string;
  deviceType?: DeviceType; // iOS only
}

export interface RegisteredDevice {
  id: string;
  platform: Platform;
  deviceType?: DeviceType;
  port: number;
  authToken: string;
  serverProcess: Subproc;
  tunnelProcess?: Subproc; // iOS real devices only
}
