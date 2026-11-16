// Phone: libraries read by the native module in modules/untethered-library (its name is from before the rename):
// Kiwix libraries with Kiwix's libkiwix, and your own files with LibraryFiles.kt (read only, never changed).
// It's missing from builds made before libraries existed, so everything checks for null.
import { requireOptionalNativeModule } from 'expo';
import { type FileLibrary, type FileList, LIBRARY_FOLDER, type LibraryBook, type LibraryPage, type LibraryTitle, OLD_LIBRARY_FOLDER } from './library';

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
  makeFolder(path: string): boolean;
  filesBooks(dirs: string[]): Promise<Omit<FileList, 'folder'>>;
  filesIndex(dirs: string[]): Promise<Omit<FileList, 'folder'>>;
  filesSearch(query: string, limit: number): Promise<LibraryPage[]>;
}

export const nativeLibrary = requireOptionalNativeModule<NativeLibrary>('UntetheredLibrary');

/** Your own files in Aislet's library folder (and the one from before the rename, and the app's own folder). */
export const fileLibrary: FileLibrary | null = nativeLibrary && (() => {
  const lib = nativeLibrary;
  const folder = () => `${lib.storage()}/${LIBRARY_FOLDER}`;
  const dirs = () => [folder(), `${lib.storage()}/${OLD_LIBRARY_FOLDER}`, lib.appFolder()].filter(Boolean);
  return {
    books: async () => ({ folder: folder(), ...(await lib.filesBooks(dirs())) }),
    index: async () => ({ folder: folder(), ...(await lib.filesIndex(dirs())) }),
    search: (query: string, limit: number) => lib.filesSearch(query, limit),
    openFolder: null,
  };
})();
