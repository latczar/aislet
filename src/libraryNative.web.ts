// PC: Windows Smart App Control blocks Kiwix's reader (an unsigned DLL), so the PC has no libraries yet.
// A paired phone still searches its own libraries when it uses the laptop's AI.
import type { NativeLibrary } from './libraryNative';

export const nativeLibrary: NativeLibrary | null = null;
