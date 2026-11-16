package app.untethered.library

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.zip.ZipFile

/**
 * Your own files as an offline library: PDFs, ebooks (EPUB), text, Markdown and web pages (HTML).
 *
 * Aislet only reads these files. It never changes, moves or deletes them: the text it reads goes into its
 * own search index (library-index.db in the app's private storage), a cache it can rebuild at any time.
 *
 * The laptop does the same in pc/library.py. Keep the limits and messages in step.
 */
class LibraryFiles(private val context: Context) {
  class Problem(message: String) : Exception(message)

  private class Found(val file: File, val size: Long, val modified: Long, val ext: String)

  companion object {
    val FORMATS = mapOf(
      "pdf" to "pdf", "epub" to "epub", "txt" to "text", "text" to "text", "md" to "markdown",
      "markdown" to "markdown", "html" to "html", "htm" to "html", "xhtml" to "html",
    )
    // Documents people may expect to work: listed with a clear message instead of being silently ignored.
    val NOT_YET = setOf("doc", "docx", "odt", "rtf", "pages", "mobi", "azw", "azw3", "djvu")

    const val MAX_FILES = 2000
    const val MAX_DEPTH = 3
    const val MAX_TEXT_FILE = 20L shl 20
    const val MAX_BOOK_FILE = 300L shl 20
    const val MAX_PAGES = 3000
    const val MAX_ENTRIES = 5000
    const val MAX_UNPACKED = 300L shl 20
    const val MAX_ENTRY = 30 shl 20
    const val MAX_CHARS = 30_000_000
    const val READ_MS = 120_000L
    const val PASSAGE = 700
    const val MAX_PASSAGE = 1200
    const val SCHEMA = "1"

    const val EMPTY = "This file is empty."
    const val NOT_TEXT = "This doesn't look like a text file."
    const val NOT_PDF = "This isn't a PDF, or it's damaged."
    const val PDF_DAMAGED = "This PDF couldn't be read. It may be damaged."
    const val PDF_LOCKED = "This PDF is password-protected, so it can't be read."
    const val PDF_SLOW = "This PDF took too long to read. It may be very large or damaged."
    const val NOT_EPUB = "This ebook is damaged, or isn't an EPUB."
    const val EPUB_BIG = "This ebook is too big when unpacked."
    const val DRM = "This ebook is copy-protected (DRM), so it can't be read."
    const val NO_TEXT = "This file has no text to search."
    const val PDF_NO_TEXT = "This PDF has no text to search. It may be scanned pages."
    const val TOO_SLOW = "This file took too long to read. It may be very large or damaged."
    const val UNREADABLE = "This file couldn't be opened. Check it isn't still downloading."
    const val DAMAGED = "This file couldn't be read. It may be damaged."

    fun count(n: Number): String = String.format(Locale.ROOT, "%,d", n)
    fun tooBig(limit: Long) = "This file is too big to read (over ${count(limit shr 20)} MB)."
    fun notYet(ext: String) = "Aislet can't read .$ext files yet. Save it as a PDF or text file instead."

    private val FONT_OBFUSCATION = setOf("http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC")
    private val WORD = Regex("[\\p{L}\\p{N}]+")
  }

  private val indexLock = Any()
  @Volatile private var visible: Set<Long> = emptySet() // documents in the last look at the folders: only these are searched
  private var pdfReady = false
  private var db: SQLiteDatabase? = null
  private var reader: ExecutorService = Executors.newSingleThreadExecutor()

  /** Read one file with a hard time limit. A file that takes too long is given up on (its thread is left to
   *  finish on its own) and recorded as too slow, so it isn't tried again until it changes. */
  private fun readWithLimit(file: File, format: String): Triple<String, Int, List<Pair<String, String>>> {
    val task = reader.submit(Callable { readFile(file, format) })
    try {
      return task.get(READ_MS + 5_000, TimeUnit.MILLISECONDS)
    } catch (e: TimeoutException) {
      task.cancel(true)
      reader.shutdownNow()
      reader = Executors.newSingleThreadExecutor()
      throw Problem(TOO_SLOW)
    } catch (e: ExecutionException) {
      throw e.cause ?: e
    }
  }

  // ---- The index: Aislet's own cache. If it's damaged or from another version, it's rebuilt. ----

  @Synchronized
  private fun database(): SQLiteDatabase {
    db?.let { if (it.isOpen) return it }
    val file = File(context.noBackupFilesDir, "library-index.db")
    val opened = try {
      open(file)
    } catch (e: SQLiteException) {
      SQLiteDatabase.deleteDatabase(file)
      open(file)
    }
    db = opened
    return opened
  }

  private fun open(file: File): SQLiteDatabase {
    val d = SQLiteDatabase.openOrCreateDatabase(file, null)
    try {
      d.enableWriteAheadLogging() // searches can run while files are being read
      d.execSQL("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
      val schema = d.rawQuery("SELECT value FROM meta WHERE key = 'schema'", null).use { if (it.moveToFirst()) it.getString(0) else null }
      if (schema != SCHEMA) {
        d.execSQL("DROP TABLE IF EXISTS docs")
        d.execSQL("DROP TABLE IF EXISTS passages")
        d.execSQL(
          "CREATE TABLE docs(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, size INTEGER NOT NULL, " +
            "modified INTEGER NOT NULL, hash TEXT NOT NULL, format TEXT NOT NULL, title TEXT NOT NULL, " +
            "parts INTEGER NOT NULL, problem TEXT NOT NULL DEFAULT '', same_as INTEGER)",
        )
        try {
          d.execSQL("CREATE VIRTUAL TABLE passages USING fts4(doc, section, text, notindexed=doc, tokenize=unicode61 \"remove_diacritics=1\")")
        } catch (e: SQLiteException) {
          d.execSQL("CREATE VIRTUAL TABLE passages USING fts4(doc, section, text, notindexed=doc)")
        }
        d.execSQL("INSERT OR REPLACE INTO meta VALUES ('schema', ?)", arrayOf(SCHEMA))
      }
      d.rawQuery("SELECT count(*) FROM docs", null).use { it.moveToFirst() }
      return d
    } catch (e: SQLiteException) {
      d.close()
      throw e
    }
  }

  // ---- Finding files (no contents read) ----

  /** Files in the library folders, and how many more were left out. Hidden files and links are skipped. */
  private fun scan(roots: List<File>): Pair<List<Found>, Int> {
    val found = ArrayList<Found>()
    var skipped = 0
    fun walk(dir: File, depth: Int) {
      val canonicalDir = try { dir.canonicalPath } catch (e: Exception) { return }
      val children = dir.listFiles() ?: return
      for (f in children.sortedBy { it.name.lowercase() }) {
        if (f.name.startsWith(".") || f.name.startsWith("~$")) continue
        val isLink = try { f.canonicalPath != File(canonicalDir, f.name).path } catch (e: Exception) { true }
        if (isLink) continue // a link could point anywhere: only files really in the folders are read
        if (f.isDirectory) {
          if (depth < MAX_DEPTH) walk(f, depth + 1)
          continue
        }
        val ext = f.extension.lowercase()
        if (ext !in FORMATS && ext !in NOT_YET) continue // .zim files are Kiwix libraries, handled separately
        if (found.size >= MAX_FILES) { skipped++; continue }
        found.add(Found(f, f.length(), f.lastModified(), ext))
      }
    }
    roots.forEach { walk(it, 0) }
    return found to skipped
  }

  private class Row(val id: Long, val size: Long, val modified: Long, val title: String, val parts: Int, val problem: String, val sameAs: Long?)

  private fun rows(d: SQLiteDatabase): Map<String, Row> {
    val out = HashMap<String, Row>()
    d.rawQuery("SELECT path, id, size, modified, title, parts, problem, same_as FROM docs", null).use { c ->
      while (c.moveToNext()) {
        out[c.getString(0)] = Row(c.getLong(1), c.getLong(2), c.getLong(3), c.getString(4), c.getInt(5), c.getString(6), if (c.isNull(7)) null else c.getLong(7))
      }
    }
    return out
  }

  /** Every file found, with what's known about it. Quick: reads no file contents. */
  fun books(roots: List<File>): Map<String, Any> {
    val (found, skipped) = scan(roots)
    val known = rows(database())
    val titles = known.values.associate { it.id to it.title }
    val seen = HashSet<Long>()
    val books = found.map { f ->
      val book = HashMap<String, Any>()
      book["path"] = f.file.absolutePath
      book["title"] = f.file.nameWithoutExtension
      book["description"] = ""
      book["articles"] = 0
      book["size"] = f.size.toDouble()
      book["searchable"] = false
      book["format"] = FORMATS[f.ext] ?: f.ext
      val row = known[f.file.absolutePath]
      when {
        f.ext in NOT_YET -> book["problem"] = notYet(f.ext)
        row != null && row.size == f.size && row.modified == f.modified -> {
          book["title"] = row.title
          book["articles"] = row.parts
          when {
            row.problem.isNotEmpty() -> book["problem"] = row.problem
            row.sameAs != null -> book["sameAs"] = titles[row.sameAs] ?: "another file"
            else -> { book["searchable"] = true; seen.add(row.id) }
          }
        }
        else -> book["pending"] = true
      }
      book
    }
    visible = seen
    return mapOf("books" to books, "skipped" to skipped)
  }

  /** Read new and changed files into the index, and forget ones that have gone. One pass at a time. */
  fun index(roots: List<File>): Map<String, Any> {
    synchronized(indexLock) {
      val (found, _) = scan(roots)
      val here = found.filter { it.ext in FORMATS }.associateBy { it.file.absolutePath }
      val d = database()
      // Forget files that have gone or changed, and copies of them: those still here are read again.
      for ((path, row) in rows(d)) {
        val f = here[path]
        if (f == null && File(path).exists()) continue // still there, just past the file limit, or a folder not looked in
        if (f == null || f.size != row.size || f.modified != row.modified) {
          d.beginTransaction()
          try { forget(d, row.id); d.setTransactionSuccessful() } finally { d.endTransaction() }
        }
      }
      val known = rows(d).keys
      for ((path, f) in here) {
        if (path in known) continue
        d.beginTransaction()
        try { readOne(d, f); d.setTransactionSuccessful() } finally { d.endTransaction() }
      }
    }
    return books(roots)
  }

  private fun forget(d: SQLiteDatabase, id: Long) {
    val copies = ArrayList<Long>()
    d.rawQuery("SELECT id FROM docs WHERE same_as = ?", arrayOf(id.toString())).use { while (it.moveToNext()) copies.add(it.getLong(0)) }
    d.execSQL("DELETE FROM passages WHERE doc = ?", arrayOf(id))
    d.execSQL("DELETE FROM docs WHERE id = ?", arrayOf(id))
    copies.forEach { forget(d, it) }
  }

  private fun readOne(d: SQLiteDatabase, f: Found) {
    val format = FORMATS.getValue(f.ext)
    var title = f.file.nameWithoutExtension
    var parts = 0
    var problem = ""
    var digest = ""
    var sameAs: Long? = null
    var sections: List<Pair<String, String>> = emptyList()
    val limit = if (format == "pdf" || format == "epub") MAX_BOOK_FILE else MAX_TEXT_FILE
    try {
      if (f.size == 0L) throw Problem(EMPTY)
      if (f.size > limit) throw Problem(tooBig(limit))
      digest = hash(f.file)
      d.rawQuery("SELECT id, parts FROM docs WHERE hash = ? AND problem = '' AND same_as IS NULL", arrayOf(digest)).use {
        if (it.moveToFirst()) { sameAs = it.getLong(0); parts = it.getInt(1) } // the same file is already here: search it once
      }
      if (sameAs == null) {
        val read = readWithLimit(f.file, format)
        title = read.first.ifBlank { title }
        parts = read.second
        sections = read.third
        if (sections.isEmpty()) throw Problem(NO_TEXT)
      }
    } catch (e: Problem) {
      problem = e.message ?: UNREADABLE
    } catch (e: java.io.IOException) {
      problem = UNREADABLE
    } catch (e: OutOfMemoryError) {
      problem = "This file is too big to read on this phone."
    } catch (e: Throwable) { // anything else odd in one file never stops the others being read
      problem = DAMAGED
    }
    val values = ContentValues().apply {
      put("path", f.file.absolutePath); put("size", f.size); put("modified", f.modified); put("hash", digest)
      put("format", format); put("title", title); put("parts", parts); put("problem", problem)
      val twin = sameAs
      if (twin != null) put("same_as", twin) else putNull("same_as")
    }
    val id = d.insertOrThrow("docs", null, values)
    var kept = 0L
    for ((section, text) in sections) {
      for (passage in splitPassages(text)) {
        if (kept + passage.length > MAX_CHARS) return
        kept += passage.length
        d.execSQL("INSERT INTO passages(doc, section, text) VALUES (?, ?, ?)", arrayOf(id, section, passage))
      }
    }
  }

  // ---- Reading files ----

  private fun hash(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(1 shl 20)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    val hex = "0123456789abcdef"
    return md.digest().joinToString("") { b -> "${hex[(b.toInt() shr 4) and 15]}${hex[b.toInt() and 15]}" }
  }

  /** (title, parts, sections) for one file: parts are pages, chapters or sections. Throws Problem. */
  private fun readFile(file: File, format: String): Triple<String, Int, List<Pair<String, String>>> {
    val started = System.currentTimeMillis()
    return when (format) {
      "pdf" -> {
        val pages = readPdf(file, started)
        val sections = pages.mapIndexedNotNull { i, t -> if (t.isBlank()) null else "page ${i + 1}" to t }
        if (sections.isEmpty()) throw Problem(PDF_NO_TEXT)
        Triple("", pages.size, sections)
      }
      "epub" -> {
        val (title, sections) = readEpub(file, started)
        Triple(title, sections.size, sections)
      }
      else -> {
        val raw = readBounded(file.inputStream(), MAX_TEXT_FILE.toInt()) ?: throw Problem(tooBig(MAX_TEXT_FILE))
        val text = decode(raw)
        val sections = when (format) {
          "html" -> listOf("" to htmlToText(text))
          "markdown" -> markdownSections(text)
          else -> listOf("" to text)
        }.filter { it.second.isNotBlank() }
        Triple("", sections.size, sections)
      }
    }
  }

  private fun readPdf(file: File, started: Long): List<String> {
    file.inputStream().use { input ->
      val head = ByteArray(1024)
      val n = input.read(head)
      if (n <= 0 || !String(head, 0, n, Charsets.ISO_8859_1).contains("%PDF-")) throw Problem(NOT_PDF)
    }
    if (!pdfReady) {
      PDFBoxResourceLoader.init(context)
      pdfReady = true
    }
    val document = try {
      PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly()) // works from a temporary file, not memory
    } catch (e: InvalidPasswordException) {
      throw Problem(PDF_LOCKED)
    } catch (e: Throwable) {
      if (e is OutOfMemoryError) throw e
      throw Problem(PDF_DAMAGED)
    }
    document.use { doc ->
      if (doc.numberOfPages > MAX_PAGES) throw Problem("This PDF has more than ${count(MAX_PAGES)} pages.")
      val stripper = PDFTextStripper()
      return (1..doc.numberOfPages).map { page ->
        if (System.currentTimeMillis() - started > READ_MS) throw Problem(PDF_SLOW)
        stripper.startPage = page
        stripper.endPage = page
        try {
          stripper.getText(doc).trim()
        } catch (e: Throwable) {
          if (e is OutOfMemoryError) throw e
          "" // one damaged page doesn't stop the rest
        }
      }
    }
  }

  /** Up to `max` bytes, or null if there are more: never trusting a size a file claims. */
  private fun readBounded(input: java.io.InputStream, max: Int): ByteArray? {
    input.use {
      val out = java.io.ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = it.read(buf)
        if (n < 0) return out.toByteArray()
        if (out.size() + n > max) return null
        out.write(buf, 0, n)
      }
    }
  }

  private fun readEpub(file: File, started: Long): Pair<String, List<Pair<String, String>>> {
    file.inputStream().use { input ->
      val head = ByteArray(4)
      if (input.read(head) != 4 || !(head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte() && head[2] == 3.toByte() && head[3] == 4.toByte())) {
        throw Problem(NOT_EPUB)
      }
    }
    val zip = try { ZipFile(file) } catch (e: Exception) { throw Problem(NOT_EPUB) }
    zip.use { z ->
      val entries = try { z.entries().toList() } catch (e: Exception) { throw Problem(NOT_EPUB) }
      if (entries.size > MAX_ENTRIES) throw Problem("This ebook has more than ${count(MAX_ENTRIES)} files inside.")
      val byName = entries.associateBy { it.name }
      var budget = MAX_UNPACKED
      fun read(name: String): String {
        val entry = byName[name] ?: throw Problem(NOT_EPUB)
        val bytes = try {
          readBounded(z.getInputStream(entry), MAX_ENTRY) ?: throw Problem(EPUB_BIG)
        } catch (e: Problem) {
          throw e
        } catch (e: Exception) {
          throw Problem(NOT_EPUB) // damaged, or protected with a zip password
        }
        budget -= bytes.size
        if (budget < 0) throw Problem(EPUB_BIG)
        return decode(bytes)
      }
      if ("META-INF/encryption.xml" in byName) {
        val algorithms = tags(read("META-INF/encryption.xml"), "EncryptionMethod").map { attr(it, "Algorithm") }.toSet()
        if ((algorithms - FONT_OBFUSCATION - "").isNotEmpty()) throw Problem(DRM)
      }
      val opfName = tags(read("META-INF/container.xml"), "rootfile").map { attr(it, "full-path") }.firstOrNull { it.isNotEmpty() }
        ?: throw Problem(NOT_EPUB)
      val opf = read(opfName)
      var title = ""
      Regex("<dc:title\\b", RegexOption.IGNORE_CASE).find(opf)?.let { m ->
        val gt = opf.indexOf('>', m.range.last + 1)
        val end = if (gt >= 0) Regex("</dc:title\\s*>", RegexOption.IGNORE_CASE).find(opf, gt + 1) else null
        if (end != null) title = htmlToText(opf.substring(gt + 1, minOf(end.range.first, gt + 1 + 2000))).replace(Regex("\\s+"), " ").trim().take(200)
      }
      val manifest = HashMap<String, Pair<String, String>>()
      for (item in tags(opf, "item")) {
        val id = attr(item, "id")
        val href = attr(item, "href")
        if (id.isNotEmpty() && href.isNotEmpty()) manifest[id] = href to attr(item, "media-type")
      }
      val base = opfName.substringBeforeLast('/', "")
      var order = tags(opf, "itemref").mapNotNull { ref ->
        val (href, kind) = manifest[attr(ref, "idref")] ?: return@mapNotNull null
        if ("html" in kind || href.lowercase().endsWith(".html") || href.lowercase().endsWith(".htm") || href.lowercase().endsWith(".xhtml")) {
          val name = try { java.net.URLDecoder.decode(href.substringBefore('#').replace("+", "%2B"), "UTF-8") } catch (e: IllegalArgumentException) { href }
          normalise(if (base.isEmpty()) name else "$base/$name")
        } else null
      }
      if (order.isEmpty()) order = byName.keys.filter { it.lowercase().let { n -> n.endsWith(".html") || n.endsWith(".htm") || n.endsWith(".xhtml") } }.sorted()
      val sections = ArrayList<Pair<String, String>>()
      for (name in order.distinct()) {
        if (name !in byName) continue
        if (System.currentTimeMillis() - started > READ_MS) throw Problem(TOO_SLOW)
        val markup = read(name)
        val text = htmlToText(markup)
        if (text.isNotEmpty()) sections.add(firstHeading(markup) to text)
      }
      return title to sections
    }
  }

  /** "OEBPS/text/../ch1.xhtml" -> "OEBPS/ch1.xhtml". Only used to look names up inside the zip. */
  private fun normalise(path: String): String {
    val out = ArrayList<String>()
    for (part in path.split('/')) {
      when (part) {
        "", "." -> {}
        ".." -> if (out.isNotEmpty()) out.removeAt(out.size - 1)
        else -> out.add(part)
      }
    }
    return out.joinToString("/")
  }

  private fun decode(raw: ByteArray): String {
    if (raw.size >= 3 && raw[0] == 0xEF.toByte() && raw[1] == 0xBB.toByte() && raw[2] == 0xBF.toByte()) return String(raw, 3, raw.size - 3, Charsets.UTF_8)
    if (raw.size >= 2 && ((raw[0] == 0xFF.toByte() && raw[1] == 0xFE.toByte()) || (raw[0] == 0xFE.toByte() && raw[1] == 0xFF.toByte()))) return String(raw, Charsets.UTF_16)
    for (i in 0 until minOf(raw.size, 8192)) if (raw[i] == 0.toByte()) throw Problem(NOT_TEXT)
    return try {
      Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(raw)).toString()
    } catch (e: CharacterCodingException) {
      String(raw, Charset.forName("windows-1252"))
    }
  }

  // Hostile files can be built to make pattern matching take hours, so markup is read by a plain left-to-right
  // scan (each character looked at a fixed number of times), and patterns only ever run on short, capped pieces.
  private val skip = setOf("script", "style", "noscript", "svg", "math", "nav", "footer", "button", "head", "template")
  private val blocks = setOf("p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "dl", "dd", "dt", "tr",
    "table", "blockquote", "pre", "figcaption", "details", "summary")
  private val tagName = Regex("^\\s*(/?)\\s*([A-Za-z][A-Za-z0-9:-]*)")
  private val maxTag = 4096 // longer "tags" are treated as text, not parsed

  /** Where `</name` starts (any case) at or after `start`, or -1. */
  private fun closeTag(markup: String, name: String, start: Int): Int {
    var j = markup.indexOf("</", start)
    while (j >= 0) {
      if (markup.regionMatches(j + 2, name, 0, name.length, ignoreCase = true)) return j
      j = markup.indexOf("</", j + 2)
    }
    return -1
  }

  /** Each `<name ...>` tag in an EPUB's index files (short ones only), found by a plain scan. */
  private fun tags(xml: String, name: String): List<String> {
    val found = ArrayList<String>()
    val open = "<$name"
    var i = 0
    while (true) {
      val lt = xml.indexOf(open, i)
      if (lt < 0) return found
      val gt = xml.indexOf('>', lt)
      if (gt < 0) return found
      val after = xml.getOrNull(lt + open.length)
      if (after != null && (after.isWhitespace() || after == '/' || after == '>') && gt - lt <= maxTag) found.add(xml.substring(lt, gt + 1))
      i = gt + 1
    }
  }

  private fun attr(tag: String, key: String): String =
    Regex("(?<![\\w:-])" + Regex.escape(key) + "\\s*=\\s*\"([^\"]*)\"").find(tag)?.groupValues?.get(1) ?: ""

  private val entities = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ", "ndash" to "–", "mdash" to "—", "hellip" to "…", "deg" to "°", "times" to "×")

  private fun decodeEntities(text: String): String = Regex("&(#x[0-9a-fA-F]+|#\\d+|[a-zA-Z]+);").replace(text) { m ->
    val code = m.groupValues[1]
    if (code.startsWith("#")) {
      val n = if (code.length > 1 && (code[1] == 'x' || code[1] == 'X')) code.substring(2).toIntOrNull(16) else code.substring(1).toIntOrNull()
      if (n != null && n in 1..0x10FFFF && n !in 0xD800..0xDFFF) String(Character.toChars(n)) else " "
    } else {
      entities[code.lowercase()] ?: m.value
    }
  }

  /** The readable text of a web page, with paragraphs kept apart (as src/library.ts does for Kiwix). */
  private fun htmlToText(markup: String): String {
    val out = StringBuilder()
    var i = 0
    val n = markup.length
    while (i < n) {
      val lt = markup.indexOf('<', i)
      if (lt < 0) { out.append(markup, i, n); break }
      out.append(markup, i, lt)
      if (markup.startsWith("<!--", lt)) {
        val end = markup.indexOf("-->", lt + 4)
        i = if (end < 0) n else end + 3
        out.append(' ')
        continue
      }
      val gt = markup.indexOf('>', lt + 1)
      if (gt < 0) break // an unfinished tag: the rest isn't text
      val m = tagName.find(markup.substring(lt + 1, minOf(gt, lt + 1 + 64)))
      val name = m?.groupValues?.get(2)?.lowercase() ?: ""
      val closing = m?.groupValues?.get(1) == "/"
      i = gt + 1
      if (gt - lt > maxTag) continue
      when {
        name in skip && !closing && markup[gt - 1] != '/' -> {
          val end = closeTag(markup, name, i)
          if (end < 0) { i = n } else { val close = markup.indexOf('>', end); i = if (close < 0) n else close + 1 }
          out.append(' ')
        }
        name == "br" || name == "hr" -> out.append('\n')
        name in blocks -> out.append("\n\n")
        (name == "td" || name == "th") && closing -> out.append(' ')
      }
    }
    var t = decodeEntities(out.toString())
    t = Regex("[ \\t\\u00a0]+").replace(t, " ")
    t = Regex(" ?\\n ?").replace(t, "\n")
    return Regex("\\n{3,}").replace(t, "\n\n").trim()
  }

  /** The first h1 to h3 in a chapter, to name it in answers. */
  private fun firstHeading(markup: String): String {
    val m = Regex("<h[1-3]\\b", RegexOption.IGNORE_CASE).find(markup) ?: return ""
    val gt = markup.indexOf('>', m.range.last + 1)
    if (gt < 0) return ""
    val end = Regex("</h[1-3]\\s*>", RegexOption.IGNORE_CASE).find(markup, gt + 1) ?: return ""
    return htmlToText(markup.substring(gt + 1, minOf(end.range.first, gt + 1 + 2000))).replace(Regex("\\s+"), " ").trim().take(120)
  }

  /** Split at headings, so an answer can say which part of the file it used. */
  private fun markdownSections(text: String): List<Pair<String, String>> {
    val sections = ArrayList<Pair<String, String>>()
    var current = ""
    val lines = ArrayList<String>()
    val pattern = Regex("^#{1,6}[ \\t]+(.+)")
    for (line in text.lines()) {
      val m = if (line.startsWith("#") && line.length <= 300) pattern.find(line) else null
      if (m != null) {
        if (lines.any { it.isNotBlank() }) sections.add(current to lines.joinToString("\n"))
        current = m.groupValues[1].trimEnd('#', ' ', '\t').take(120)
        lines.clear()
        lines.add(line)
      } else {
        lines.add(line)
      }
    }
    if (lines.any { it.isNotBlank() }) sections.add(current to lines.joinToString("\n"))
    return sections
  }

  /** Pieces of about PASSAGE characters, broken between paragraphs where possible. */
  private fun splitPassages(text: String): List<String> {
    val out = ArrayList<String>()
    var current = ""
    for (raw in text.split(Regex("\\n\\s*\\n"))) {
      var para = raw.trim()
      while (para.length > MAX_PASSAGE) {
        var cut = maxOf(para.lastIndexOf(". ", MAX_PASSAGE - 2).let { if (it >= PASSAGE / 2) it + 1 else -1 }, para.lastIndexOf(' ', MAX_PASSAGE).let { if (it >= PASSAGE / 2) it else -1 })
        if (cut <= 0) cut = MAX_PASSAGE
        if (current.isNotEmpty()) { out.add(current); current = "" }
        out.add(para.substring(0, cut).trim())
        para = para.substring(cut).trim()
      }
      if (para.isEmpty()) continue
      if (current.isNotEmpty() && current.length + para.length + 2 > MAX_PASSAGE) { out.add(current); current = "" }
      current = if (current.isEmpty()) para else "$current\n\n$para"
      if (current.length >= PASSAGE) { out.add(current); current = "" }
    }
    if (current.isNotEmpty()) out.add(current)
    return out
  }

  // ---- Searching ----

  /** Lower case without accents, so "cafe" finds "Café". */
  private fun fold(text: String): String = Normalizer.normalize(text.lowercase(), Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "")

  /** Plain words only, so nothing in a question can change how the search works. */
  private fun queryTerms(query: String): List<String> =
    WORD.findAll(fold(query.take(500))).map { it.value }.filter { it.length > 1 }.distinct().take(12).toList()

  private class Hit(val rowid: Long, val doc: Long, val section: String, val text: String, val title: String, val path: String)

  /** The passages that best match, as library pages (see LibraryPage in src/library.ts). */
  fun search(query: String, limit: Int): List<Map<String, Any>> {
    val terms = queryTerms(query)
    val shown = visible
    if (terms.isEmpty() || shown.isEmpty()) return emptyList()
    val d = database()
    val rows = LinkedHashMap<Long, Hit>()
    for (joiner in listOf(" ", " OR ")) {
      val match = terms.joinToString(joiner) { "\"$it\"" }
      d.rawQuery(
        "SELECT passages.rowid, CAST(passages.doc AS INTEGER), passages.section, passages.text, docs.title, docs.path " +
          "FROM passages JOIN docs ON docs.id = CAST(passages.doc AS INTEGER) WHERE passages MATCH ? LIMIT 400",
        arrayOf(match),
      ).use { c ->
        while (c.moveToNext()) {
          val hit = Hit(c.getLong(0), c.getLong(1), c.getString(2) ?: "", c.getString(3) ?: "", c.getString(4) ?: "", c.getString(5) ?: "")
          if (hit.doc in shown && hit.rowid !in rows) rows[hit.rowid] = hit
        }
      }
      if (rows.size >= limit * 2 || terms.size == 1) break
    }
    fun score(h: Hit): Double {
      val words = WORD.findAll(fold("${h.title} ${h.section} ${h.text}")).map { it.value }.toSet()
      return terms.count { it in words }.toDouble() / terms.size
    }
    val scored = rows.values.map { it to score(it) }
    return scored.sortedWith(compareBy<Pair<Hit, Double>>({ -it.second }, { it.first.rowid })).take(limit).map { it.first }.mapIndexed { i, h ->
      mapOf("book" to h.path, "bookTitle" to h.title, "path" to "#${h.rowid}", "title" to h.section, "rank" to i, "text" to h.text)
    }
  }
}
