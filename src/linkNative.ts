// Phone: the private link's slow parts in the app's native code (LinkCrypto.kt in modules/untethered-library), off
// the JavaScript thread, so the app doesn't freeze while a big sync or PDF is sealed. They give the same bytes as
// src/link.ts, which is used when they're missing.
import { requireOptionalNativeModule } from 'expo';

export interface LinkNative {
  linkKey(code: string, salt: string): Promise<string>;
  linkSeal(enc: string, mac: string, context: string, iv: string, plain: string): Promise<string>;
  linkOpen(enc: string, mac: string, context: string, sealed: string): Promise<string | null>;
}

const mod = requireOptionalNativeModule<Partial<LinkNative>>('UntetheredLibrary');
export const linkNative: LinkNative | null = mod && typeof mod.linkSeal === 'function' && typeof mod.linkOpen === 'function'
  && typeof mod.linkKey === 'function' ? (mod as LinkNative) : null;
