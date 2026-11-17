// Stand-in for Expo when the app's code runs under plain Node: no native modules here.
export function requireOptionalNativeModule() {
  return null;
}
export function requireNativeModule(name) {
  throw new Error(`${name} is not available under Node`);
}
export function getRandomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}
