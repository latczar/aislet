// Stand-in for src/net.ts: Node's own fetch.
export const fetch = (...args) => globalThis.fetch(...args);
