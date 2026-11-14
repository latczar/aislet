// PC: the browser's own fetch already streams.
export const fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);
