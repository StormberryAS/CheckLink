// Runs first in the decoder worker, before the decoder's own code is even loaded: it takes
// away every way the worker could reach the network that script can take away. The decoder
// never needs any of them, because its WebAssembly arrives as a module from the page's own
// site; this makes sure nothing it does can fetch anything, whatever policy the server sends
// with the worker. A worker takes its Content-Security-Policy from its own response headers,
// not from the page's meta tag, so this does not depend on the deploy-time header being right.
//
// Taken away:
//   fetch, Request, XMLHttpRequest       requests
//   WebSocket, WebSocketStream, EventSource, WebTransport   connections
//   importScripts                        classic script loading
//   caches                               the Cache API (cache.add fetches)
//   Worker, SharedWorker                 nested workers (each loads its own script)
//   FontFace, fonts                      web fonts (FontFace.load fetches its url())
//   RTCPeerConnection and kin            peer-to-peer connections, where a worker has them
// Not possible from script: dynamic import(). Only the Content-Security-Policy header stops
// that, which is why NOTICE asks for the full recommended header on every host and mirror.
const NAMES = [
  'fetch', 'Request', 'XMLHttpRequest',
  'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
  'importScripts',
  'caches',
  'Worker', 'SharedWorker',
  'FontFace', 'fonts',
  'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel',
];
for (const name of NAMES) {
  try {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false, enumerable: false });
  } catch {
    // Already not configurable: leave it, the policy still applies.
  }
}
export const LOCKED = true;
