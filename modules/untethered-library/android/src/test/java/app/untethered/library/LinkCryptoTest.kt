package app.untethered.library

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * The private link's native code must give the same bytes as the hub (pc/link.py) and src/link.ts.
 * The vectors are made by pc/tests/link_test.py. Run in the Android project:
 *   ./gradlew :untethered-library:testDebugUnitTest
 */
class LinkCryptoTest {
  private val v: Map<String, String> by lazy {
    var dir: File? = File("").absoluteFile
    while (dir != null && !File(dir, "pc/tests/link_vectors.json").isFile) dir = dir.parentFile
    val text = File(dir ?: error("pc/tests/link_vectors.json not found"), "pc/tests/link_vectors.json").readText()
    // Flat JSON of strings and numbers, read with a plain scan: no JSON library (and no regex over long values).
    val out = HashMap<String, String>()
    var i = 0
    fun string(): String {
      val s = StringBuilder()
      i++ // the opening quote
      while (text[i] != '"') {
        if (text[i] == '\\') {
          i++
          s.append(when (text[i]) { 'n' -> '\n'; 't' -> '\t'; else -> text[i] })
        } else s.append(text[i])
        i++
      }
      i++
      return s.toString()
    }
    while (true) {
      i = text.indexOf('"', i)
      if (i < 0) break
      val key = string()
      while (text[i] == ':' || text[i] == ' ') i++
      out[key] = if (text[i] == '"') string() else text.substring(i).takeWhile { it.isDigit() }.also { i += it.length }
    }
    out
  }

  private fun replyContext(sig: String, status: Int, index: Int, last: Boolean) =
    "aislet 2 reply\n$sig\n$status\n$index\n${if (last) 1 else 0}\n"

  @Test fun keyMatchesTheHub() {
    assertEquals(v["key"], LinkCrypto.key(v.getValue("code"), v.getValue("salt")))
  }

  @Test fun sealsRequestBodiesLikeTheHub() {
    val iv = (0 until 16).joinToString("") { "%02x".format(it) }
    val sealed = LinkCrypto.seal(v.getValue("enc"), v.getValue("mac"), "aislet 2 request body\n${v["post_sig"]}\n", iv, v.getValue("post_body"))
    assertEquals(v["post_wire"], sealed)
  }

  @Test fun opensRepliesFromTheHub() {
    val ctx = replyContext(v.getValue("get_sig"), 200, 0, true)
    assertEquals(v["reply_plain"], LinkCrypto.open(v.getValue("enc"), v.getValue("mac"), ctx, v.getValue("reply").trim()))
    val frames = v.getValue("stream").trim().split("\n")
    val opened = frames.mapIndexed { i, f ->
      LinkCrypto.open(v.getValue("enc"), v.getValue("mac"), replyContext(v.getValue("post_sig"), 200, i, i == frames.size - 1), f)
    }
    assertEquals(v["stream_plain"], opened.joinToString(""))
  }

  @Test fun refusesWhatIsntSealedForThisRequest() {
    val enc = v.getValue("enc")
    val mac = v.getValue("mac")
    val reply = v.getValue("reply").trim()
    assertNull(LinkCrypto.open(enc, mac, replyContext(v.getValue("post_sig"), 200, 0, true), reply)) // another request
    assertNull(LinkCrypto.open(enc, mac, replyContext(v.getValue("get_sig"), 500, 0, true), reply)) // another status
    assertNull(LinkCrypto.open(enc, mac, replyContext(v.getValue("get_sig"), 200, 0, false), reply)) // not the last
    assertNull(LinkCrypto.open(enc, mac, replyContext(v.getValue("get_sig"), 200, 0, true), "eyJwYWlyZWQiOnRydWV9")) // plain
    assertNull(LinkCrypto.open(enc, mac, replyContext(v.getValue("get_sig"), 200, 0, true), "not base64!"))
    val tampered = java.util.Base64.getDecoder().decode(reply).also { it[20] = (it[20].toInt() xor 1).toByte() }
    assertNull(LinkCrypto.open(enc, mac, replyContext(v.getValue("get_sig"), 200, 0, true), java.util.Base64.getEncoder().encodeToString(tampered)))
  }

  @Test fun longMessages() {
    // long_plain is every byte value (not text), so only check that the hub's long message opens here.
    assertEquals(true, LinkCrypto.open(v.getValue("enc"), v.getValue("mac"), "long", v.getValue("long_sealed")) != null)
    assertNull(LinkCrypto.open(v.getValue("enc"), v.getValue("mac"), "other", v.getValue("long_sealed")))
    val text = "Glimmerfold kite notes ✓ ".repeat(5000)
    val iv = "07".repeat(16)
    val again = LinkCrypto.open(v.getValue("enc"), v.getValue("mac"), "x", LinkCrypto.seal(v.getValue("enc"), v.getValue("mac"), "x", iv, text))
    assertEquals(text, again)
  }
}
