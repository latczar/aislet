package app.aislet.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import java.security.SecureRandom

/**
 * The home-screen widget: the bar opens a new chat, the round button starts hands-free. Both open Aislet
 * with a link (aislet://new or aislet://talk) that carries this install's secret token. Any app can open
 * aislet:// links, so Aislet only acts on ones with the token, which only these PendingIntents hold:
 * another app can't make Aislet start listening.
 */
class AskWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val views = RemoteViews(context.packageName, R.layout.aislet_widget)
    views.setOnClickPendingIntent(R.id.aislet_widget_ask, open(context, "new", 1))
    views.setOnClickPendingIntent(R.id.aislet_widget_talk, open(context, "talk", 2))
    manager.updateAppWidget(ids, views)
  }

  companion object {
    private const val PREFS = "aislet_widget"
    private const val TOKEN = "token"

    /** This install's secret for widget links, made once. */
    @Synchronized
    fun token(context: Context): String {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      prefs.getString(TOKEN, null)?.let { return it }
      val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
      val made = bytes.joinToString("") { "%02x".format(it) }
      prefs.edit().putString(TOKEN, made).commit()
      return made
    }

    private fun open(context: Context, action: String, request: Int): PendingIntent {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse("aislet://$action?k=${token(context)}"))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
  }
}
