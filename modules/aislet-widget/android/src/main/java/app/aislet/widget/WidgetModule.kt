package app.aislet.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** What the app needs from the widget: the token its links carry, and a way to offer adding it to the home screen. */
class WidgetModule : Module() {
  private val context get() = appContext.reactContext ?: throw IllegalStateException("The app isn't ready yet.")

  override fun definition() = ModuleDefinition {
    Name("AisletWidget")

    Function("token") { AskWidget.token(context) }

    /** Asks the home screen to add the widget; it shows its own prompt. False if the home screen can't. */
    AsyncFunction("add") {
      val manager = AppWidgetManager.getInstance(context)
      if (!manager.isRequestPinAppWidgetSupported) return@AsyncFunction false
      manager.requestPinAppWidget(ComponentName(context, AskWidget::class.java), null, null)
    }
  }
}
