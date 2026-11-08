declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string; username?: string }; wsProtocols?: string[]; shared?: boolean });
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    viewOnly: boolean;
    disconnect(): void;
    sendCredentials(c: { password?: string; username?: string }): void;
    sendCtrlAltDel(): void;
    focus(): void;
    addEventListener(type: "connect", cb: () => void): void;
    addEventListener(type: "disconnect", cb: (e: CustomEvent<{ clean: boolean }>) => void): void;
    addEventListener(type: "credentialsrequired", cb: () => void): void;
    addEventListener(type: "securityfailure", cb: (e: CustomEvent<{ status?: number; reason?: string }>) => void): void;
    addEventListener(type: string, cb: (e: Event) => void): void;
  }
}
