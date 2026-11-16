package app.untethered.library

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * The private link to the laptop hub, in native code so big messages (a sync, a PDF to read) don't freeze the
 * app. It must give exactly the same bytes as src/link.ts and pc/link.py: see those for the design. Here:
 * the link key from a pairing code, and sealing and opening one message. Plain Java APIs only, so
 * LinkCryptoTest checks it against the shared vectors on any JVM.
 */
object LinkCrypto {
  private const val IV_BYTES = 16
  private const val TAG_BYTES = 32
  private const val ITERATIONS = 200_000

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun unhex(text: String): ByteArray {
    require(text.length % 2 == 0 && text.all { it in '0'..'9' || it in 'a'..'f' }) { "Not hex" }
    return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }

  private fun mac(key: ByteArray): Mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }

  /** PBKDF2-HMAC-SHA256 of the code (case, spaces and dashes ignored) with the hub's salt, as hex. */
  fun key(code: String, salt: String): String {
    val clean = code.uppercase().filter { it != ' ' && it != '-' && !it.isWhitespace() }
    val spec = PBEKeySpec(clean.toCharArray(), unhex(salt), ITERATIONS, 256)
    try {
      return hex(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded)
    } finally {
      spec.clearPassword()
    }
  }

  /** XOR with the keystream HMAC(enc, iv || 0), HMAC(enc, iv || 1), … (a 4-byte big-endian counter). */
  private fun xorStream(enc: ByteArray, iv: ByteArray, data: ByteArray, from: Int, length: Int, out: ByteArray, at: Int) {
    val m = mac(enc)
    val block = ByteArray(IV_BYTES + 4)
    iv.copyInto(block)
    var pos = 0
    var counter = 0
    while (pos < length) {
      block[16] = (counter ushr 24).toByte()
      block[17] = (counter ushr 16).toByte()
      block[18] = (counter ushr 8).toByte()
      block[19] = counter.toByte()
      val stream = m.doFinal(block)
      val n = minOf(32, length - pos)
      for (i in 0 until n) out[at + pos + i] = (data[from + pos + i].toInt() xor stream[i].toInt()).toByte()
      pos += 32
      counter++
    }
  }

  private fun tag(macKey: ByteArray, context: String, sealed: ByteArray, length: Int): ByteArray {
    val m = mac(macKey)
    m.update(context.toByteArray(Charsets.UTF_8))
    m.update(sealed, 0, length)
    return m.doFinal()
  }

  /** iv || ciphertext || tag, as base64. `plain` is sent as UTF-8. */
  fun seal(enc: String, macKey: String, context: String, iv: String, plain: String): String {
    val ivBytes = unhex(iv)
    require(ivBytes.size == IV_BYTES) { "Bad iv" }
    val data = plain.toByteArray(Charsets.UTF_8)
    val out = ByteArray(IV_BYTES + data.size + TAG_BYTES)
    ivBytes.copyInto(out)
    xorStream(unhex(enc), ivBytes, data, 0, data.size, out, IV_BYTES)
    tag(unhex(macKey), context, out, IV_BYTES + data.size).copyInto(out, IV_BYTES + data.size)
    return Base64.getEncoder().encodeToString(out)
  }

  /** The plain text (UTF-8), or null if the message wasn't sealed with these keys for this context. */
  fun open(enc: String, macKey: String, context: String, sealed: String): String? {
    val bytes = try { Base64.getDecoder().decode(sealed) } catch (e: IllegalArgumentException) { return null }
    if (bytes.size < IV_BYTES + TAG_BYTES) return null
    val length = bytes.size - TAG_BYTES
    val expected = tag(unhex(macKey), context, bytes, length)
    if (!MessageDigest.isEqual(expected, bytes.copyOfRange(length, bytes.size))) return null
    val plain = ByteArray(length - IV_BYTES)
    xorStream(unhex(enc), bytes.copyOfRange(0, IV_BYTES), bytes, IV_BYTES, plain.size, plain, 0)
    return String(plain, Charsets.UTF_8)
  }
}
