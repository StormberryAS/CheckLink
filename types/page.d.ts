// Type declarations for the page (index.html, app.js): what the browser and the Android app give it
// beyond the standard DOM. Type checking only: never served, never bundled into the app.

/**
 * The bridge android/web-overlay/android-bridge.js puts on window.CLAndroid inside the Android app
 * (stage 4). Every answer is a promise of true when the app did it. On a WebView too old for the
 * bridge, window.CLAndroid is an empty frozen object, so the page checks for copyText first.
 */
interface CheckLinkAndroid {
  copyText(text: string, sensitive?: boolean): Promise<boolean>;
  shareText(text: string): Promise<boolean>;
  open(url: string): Promise<boolean>;
  openAppSettings(): Promise<boolean>;
  secure(reason: 'camera' | 'secret' | 'link', on: boolean): Promise<boolean>;
  cameraBlocked(): Promise<boolean>;
  saveImage(png: Blob): Promise<boolean>;
  shareImage(png: Blob): Promise<boolean>;
}

/** What a WebView too old for the bridge gets: an empty frozen object, with none of the methods. */
type CheckLinkAndroidStub = { readonly [K in keyof CheckLinkAndroid]?: undefined };

interface Window {
  /** Only in the Android app; see CheckLinkAndroid. */
  readonly CLAndroid?: CheckLinkAndroid | CheckLinkAndroidStub;
}

/** The events the bridge sends the page (android-bridge.js, hand). */
interface WindowEventMap {
  'clandroid:camera-stop': Event;
  'clandroid:shared-text': CustomEvent<{ text: string }>;
  'clandroid:shared-picture': CustomEvent<{ file: File }>;
}

/** Permissions Policy (and its older name, Feature Policy), where the browser has it. */
interface CheckLinkPermissionsPolicy {
  allowsFeature(feature: string): boolean;
}

interface Document {
  readonly permissionsPolicy?: CheckLinkPermissionsPolicy;
  readonly featurePolicy?: CheckLinkPermissionsPolicy;
}

/**
 * The elements app.js finds by id ($) whose type is more than HTMLElement, by id. Every id app.js
 * asks for is in index.html.
 */
interface CheckLinkElements {
  'cam-video': HTMLVideoElement;
  'copy-dialog': HTMLDialogElement;
  'go-dialog': HTMLDialogElement;
  'link-input': HTMLTextAreaElement;
  'pic-input': HTMLInputElement;
  'picture-view': HTMLCanvasElement;
  'report-link': HTMLAnchorElement;
}
