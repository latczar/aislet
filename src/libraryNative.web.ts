// PC: your own files in the library folder are read by the hub (pc/library.py), never changed.
// Kiwix libraries aren't read here: Windows Smart App Control blocks Kiwix's reader (an unsigned DLL).
// A paired phone still searches its own Kiwix libraries when it uses the laptop's AI.
import { hubLibrary } from './hub';
import type { FileLibrary, FileList, LibraryPage } from './library';
import type { NativeLibrary } from './libraryNative';

export const nativeLibrary: NativeLibrary | null = null;

export const fileLibrary: FileLibrary = {
  books: () => hubLibrary<FileList>('books'),
  index: () => hubLibrary<FileList>('index', {}, 30 * 60_000), // the first read of a big folder can take a while
  search: async (query: string, limit: number) => (await hubLibrary<{ pages: LibraryPage[] }>('search', { query, limit })).pages,
  openFolder: async () => { await hubLibrary('open'); },
};
