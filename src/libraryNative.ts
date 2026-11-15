// Phone: Kiwix libraries read by the native module in modules/untethered-library (its name is from before the rename) (Kiwix's libkiwix).
// It's missing from builds made before libraries existed, so everything checks for null.
import { requireOptionalNativeModule } from 'expo';
import type { LibraryBook, LibraryPage, LibraryTitle } from './library';

export interface NativeLibrary {
  storage(): string;
  hasAccess(): boolean;
  appFolder(): string;
  requestAccess(): Promise<void>;
  find(dirs: string[]): Promise<{ path: string; size: number }[]>;
  info(path: string): Promise<LibraryBook>;
  search(paths: string[], query: string, limit: number, maxChars: number): Promise<LibraryPage[]>;
  titles(paths: string[], queries: string[], limit: number): Promise<LibraryTitle[]>;
  read(book: string, path: string, maxChars: number): Promise<string>;
  move(from: string, toDir: string): Promise<string>;
  remove(path: string): Promise<boolean>;
}

export const nativeLibrary = requireOptionalNativeModule<NativeLibrary>('UntetheredLibrary');
