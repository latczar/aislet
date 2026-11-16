package app.untethered.library

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.kiwix.libkiwix.JNIKiwix
import org.kiwix.libzim.Archive
import org.kiwix.libzim.Query
import org.kiwix.libzim.Searcher
import org.kiwix.libzim.SuggestionSearcher
import java.io.File

/**
 * Offline libraries on this phone: Kiwix .zim files, opened with Kiwix's own reader, and the person's own
 * files (PDFs, ebooks, text, web pages; see LibraryFiles). Aislet searches them to help answer questions.
 * Reading files outside the app's own folders needs "All files access", which the person grants in Android's settings.
 */
class LibraryModule : Module() {
  private val lock = Any()
  private var loaded = false
  private val open = HashMap<String, Pair<Long, Archive>>() // path -> (size and date, the open file)

  private val context get() = appContext.reactContext ?: throw IllegalStateException("The app isn't ready yet.")
  private val files by lazy { LibraryFiles(context.applicationContext) }

  /** The folders that may be read: without "All files access", only the app's own. */
  private fun readable(dirs: List<String>): List<File> {
    val own = context.getExternalFilesDir(null)?.absolutePath
    return (if (hasAccess()) dirs else dirs.filter { own != null && it.startsWith("$own/") }).map { File(it) }
  }

  private fun archive(path: String): Archive {
    val file = File(path)
    val stamp = file.length() * 31 + file.lastModified()
    open[path]?.let { if (it.first == stamp) return it.second }
    if (!loaded) {
      JNIKiwix(context) // loads Kiwix's native libraries
      loaded = true
    }
    val archive = Archive(path)
    open[path] = stamp to archive
    return archive
  }

  private fun meta(archive: Archive, key: String): String =
    try { archive.getMetadata(key).trim() } catch (e: Exception) { "" }

  // Android 11+ asks for "All files access"; older versions would need a permission this app doesn't request.
  private fun hasAccess(): Boolean = Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()

  override fun definition() = ModuleDefinition {
    Name("UntetheredLibrary")

    // The private link to the laptop hub (LinkCrypto): kept here, in the app's one native module, and run off the
    // JavaScript thread so a big sync or PDF doesn't freeze the app.
    AsyncFunction("linkKey") Coroutine { code: String, salt: String ->
      withContext(Dispatchers.Default) { LinkCrypto.key(code, salt) }
    }
    AsyncFunction("linkSeal") Coroutine { enc: String, mac: String, context: String, iv: String, plain: String ->
      withContext(Dispatchers.Default) { LinkCrypto.seal(enc, mac, context, iv, plain) }
    }
    AsyncFunction("linkOpen") Coroutine { enc: String, mac: String, context: String, sealed: String ->
      withContext(Dispatchers.Default) { LinkCrypto.open(enc, mac, context, sealed) }
    }

    /** The phone's shared storage, e.g. /storage/emulated/0. */
    Function("storage") { Environment.getExternalStorageDirectory().absolutePath }

    Function("hasAccess") { hasAccess() }

    /** The app's own folder for libraries (Android/data/…/files/libraries): readable without "All files access". */
    Function("appFolder") { context.getExternalFilesDir("libraries")?.absolutePath ?: "" }

    /** Open Android's "All files access" page for Untethered. */
    AsyncFunction("requestAccess") {
      val ctx = context
      if (Build.VERSION.SDK_INT < 30) throw IllegalStateException("Libraries need Android 11 or newer.")
      try {
        ctx.startActivity(
          Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${ctx.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (e: Exception) {
        ctx.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    /** Make Aislet's own library folder (only that one), so people can find it to put files in. */
    Function("makeFolder") { path: String ->
      val root = Environment.getExternalStorageDirectory().absolutePath
      if (!hasAccess() || !path.startsWith("$root/") || path.contains("/../")) return@Function false
      File(path).mkdirs() || File(path).isDirectory
    }

    // The person's own files. These are only ever read, and run off the shared queue so a long read
    // never holds up anything else.

    /** Every file in these folders, with what's known about it. Reads no file contents. */
    AsyncFunction("filesBooks") Coroutine { dirs: List<String> ->
      withContext(Dispatchers.IO) { files.books(readable(dirs)) }
    }

    /** Read new and changed files into the index; forget ones that have gone. */
    AsyncFunction("filesIndex") Coroutine { dirs: List<String> ->
      withContext(Dispatchers.IO) { files.index(readable(dirs)) }
    }

    /** Passages that match a search, best first. */
    AsyncFunction("filesSearch") Coroutine { query: String, limit: Int ->
      withContext(Dispatchers.IO) { files.search(query, limit.coerceIn(1, 20)) }
    }

    /** .zim files in these folders, up to three levels down. */
    AsyncFunction("find") { dirs: List<String> ->
      val own = context.getExternalFilesDir(null)?.absolutePath
      val allowed = if (hasAccess()) dirs else dirs.filter { own != null && it.startsWith(own) }
      val found = LinkedHashMap<String, Map<String, Any>>()
      fun walk(dir: File, depth: Int) {
        val children = dir.listFiles() ?: return
        for (f in children) {
          if (f.name.startsWith(".")) continue
          if (f.isDirectory && depth < 3) walk(f, depth + 1)
          else if (f.isFile && f.name.lowercase().endsWith(".zim")) {
            found[f.absolutePath] = mapOf("path" to f.absolutePath, "size" to f.length().toDouble())
          }
        }
      }
      allowed.forEach { walk(File(it), 0) }
      found.values.toList()
    }

    /** The library's name, description and size, or a problem when it can't be opened. */
    AsyncFunction("info") { path: String ->
      synchronized(lock) {
        try {
          val a = archive(path)
          mapOf(
            "path" to path,
            "title" to meta(a, "Title").ifEmpty { File(path).nameWithoutExtension },
            "description" to meta(a, "Description"),
            "articles" to a.articleCount,
            "size" to File(path).length().toDouble(),
            "searchable" to a.hasFulltextIndex(),
          )
        } catch (e: Throwable) {
          open.remove(path)
          mapOf(
            "path" to path,
            "title" to File(path).nameWithoutExtension,
            "description" to "",
            "articles" to 0,
            "size" to File(path).length().toDouble(),
            "searchable" to false,
            "problem" to "This file couldn't be opened. It may be incomplete or damaged.",
          )
        }
      }
    }

    /** Search each library and return the best pages, with their HTML cut to maxChars. */
    AsyncFunction("search") { paths: List<String>, query: String, limit: Int, maxChars: Int ->
      val results = ArrayList<Map<String, Any>>()
      synchronized(lock) {
        for (path in paths) {
          try {
            val a = archive(path)
            if (!a.hasFulltextIndex()) continue
            val book = meta(a, "Title").ifEmpty { File(path).nameWithoutExtension }
            val found = Searcher(a).search(Query(query)).getResults(0, limit)
            var rank = 0
            while (found.hasNext()) {
              val entry = found.next()
              val item = entry.getItem(true)
              if (!item.mimetype.startsWith("text/html")) continue
              val bytes = item.data.data
              val html = String(bytes, 0, minOf(bytes.size, maxChars * 2), Charsets.UTF_8).take(maxChars)
              results.add(
                mapOf("book" to path, "bookTitle" to book, "path" to entry.path, "title" to entry.title, "rank" to rank, "html" to html),
              )
              rank++
            }
          } catch (e: Throwable) {
            open.remove(path) // a damaged or half-moved file: skip it this time
          }
        }
      }
      results
    }

    /** Pages whose titles match each query, from Kiwix's title index (no page text). */
    AsyncFunction("titles") { paths: List<String>, queries: List<String>, limit: Int ->
      val results = ArrayList<Map<String, Any>>()
      synchronized(lock) {
        for (path in paths) {
          try {
            val a = archive(path)
            if (!a.hasTitleIndex()) continue
            val book = meta(a, "Title").ifEmpty { File(path).nameWithoutExtension }
            val searcher = SuggestionSearcher(a)
            for (q in queries) {
              val found = searcher.suggest(q).getResults(0, limit)
              while (found.hasNext()) {
                val item = found.next()
                results.add(mapOf("book" to path, "bookTitle" to book, "path" to item.path, "title" to item.title))
              }
            }
          } catch (e: Throwable) {
            open.remove(path)
          }
        }
      }
      results
    }

    /** One page's HTML, cut to maxChars. */
    AsyncFunction("read") { book: String, path: String, maxChars: Int ->
      synchronized(lock) {
        val bytes = archive(book).getEntryByPath(path).getItem(true).data.data
        String(bytes, 0, minOf(bytes.size, maxChars * 2), Charsets.UTF_8).take(maxChars)
      }
    }

    /** Move a library into toDir, by renaming when possible so no space is used twice. Returns the new path. */
    AsyncFunction("move") { from: String, toDir: String ->
      synchronized(lock) { open.remove(from) }
      val source = File(from)
      val dir = File(toDir).apply { mkdirs() }
      val dest = File(dir, source.name)
      if (dest.absolutePath == source.absolutePath) return@AsyncFunction dest.absolutePath
      val leftBehind = "${source.name} is in Untethered now, but the old copy couldn't be removed. Delete it in Kiwix to free the space."
      if (dest.exists()) {
        if (dest.length() == source.length()) { // already moved once: keep one copy
          if (!source.delete()) throw IllegalStateException(leftBehind)
          return@AsyncFunction dest.absolutePath
        }
        throw IllegalStateException("A different library called ${source.name} is already in Untethered.")
      }
      if (!source.renameTo(dest)) {
        val partial = File(dir, "${source.name}.part")
        try {
          source.inputStream().use { input -> partial.outputStream().use { input.copyTo(it, 1 shl 20) } }
          if (partial.length() != source.length() || !partial.renameTo(dest)) throw IllegalStateException("The copy didn't finish.")
        } catch (e: Exception) {
          partial.delete()
          throw IllegalStateException("${source.name} couldn't be moved. Check there's enough space, then try again.")
        }
        if (!source.delete()) throw IllegalStateException(leftBehind)
      }
      dest.absolutePath
    }

    /** Delete a library file. */
    AsyncFunction("remove") { path: String ->
      synchronized(lock) { open.remove(path) }
      File(path).delete()
    }
  }
}
