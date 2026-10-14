import type { BridgeApi } from './types';

declare global {
  interface Window {
    bridge: BridgeApi;
  }
}

export {};
