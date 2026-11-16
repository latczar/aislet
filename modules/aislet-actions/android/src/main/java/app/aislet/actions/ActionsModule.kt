package app.aislet.actions

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.AlarmClock
import android.provider.CalendarContract
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Alarms, timers and calendar events, handed to the phone's own Clock and Calendar apps by intent.
 * Aislet only calls these after the person taps the card in the chat, and the Clock or Calendar app
 * shows them before they're kept. Nothing goes online. The only permission is SET_ALARM, which Android
 * grants at install without asking, because the Clock app requires it of anyone handing it an alarm.
 *
 * Everything is checked here as well as in src/deviceActions.ts (the limits must match LIMITS there).
 */
class ActionsModule : Module() {
  private val context get() = appContext.reactContext ?: throw IllegalStateException("The app isn't ready yet.")

  private fun open(intent: Intent, app: String) {
    val activity = appContext.currentActivity
    if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      (activity ?: context).startActivity(intent)
    } catch (e: ActivityNotFoundException) {
      throw IllegalStateException("This phone has no $app app that can do this.")
    } catch (e: SecurityException) {
      throw IllegalStateException("The $app app didn't let Aislet hand this over. Set it in the $app app instead.")
    }
  }

  /** Plain text of at most `max` characters: no control characters or line breaks. */
  private fun clean(text: String, max: Int): String =
    text.replace(Regex("[\\p{Cc}\\p{Cf}\\u2028\\u2029]"), " ").replace(Regex("\\s+"), " ").trim().take(max).trim()

  private fun ensure(ok: Boolean, problem: String) {
    if (!ok) throw IllegalArgumentException(problem)
  }

  override fun definition() = ModuleDefinition {
    Name("AisletActions")

    /** A new alarm in the Clock app. `days` are java.util.Calendar days (1 = Sunday … 7 = Saturday); empty means once. */
    AsyncFunction("setAlarm") { hour: Int, minutes: Int, label: String, days: List<Int> ->
      ensure(hour in 0..23 && minutes in 0..59, "That alarm time isn't a real time.")
      ensure(days.size <= 7 && days.all { it in 1..7 }, "Those alarm days aren't right.")
      val intent = Intent(AlarmClock.ACTION_SET_ALARM)
        .putExtra(AlarmClock.EXTRA_HOUR, hour)
        .putExtra(AlarmClock.EXTRA_MINUTES, minutes)
        .putExtra(AlarmClock.EXTRA_SKIP_UI, false)
      val message = clean(label, MAX_LABEL)
      if (message.isNotEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, message)
      if (days.isNotEmpty()) intent.putExtra(AlarmClock.EXTRA_DAYS, ArrayList(days.distinct()))
      open(intent, "clock")
    }

    /** A countdown timer in the Clock app. */
    AsyncFunction("setTimer") { seconds: Int, label: String ->
      ensure(seconds in 1..MAX_TIMER, "A timer can be up to 24 hours long.")
      val intent = Intent(AlarmClock.ACTION_SET_TIMER)
        .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
        .putExtra(AlarmClock.EXTRA_SKIP_UI, false)
      val message = clean(label, MAX_LABEL)
      if (message.isNotEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, message)
      open(intent, "clock")
    }

    /** The calendar's new-event screen, filled in. The person saves it there. Times are milliseconds since 1970. */
    AsyncFunction("addEvent") { title: String, begin: Double, end: Double, allDay: Boolean ->
      val name = clean(title, MAX_TITLE)
      ensure(name.isNotEmpty(), "That event has no name.")
      ensure(begin >= MIN_TIME && end <= MAX_TIME && end > begin && end - begin <= MAX_EVENT_MS, "That event's date or length isn't right.")
      val intent = Intent(Intent.ACTION_INSERT)
        .setData(CalendarContract.Events.CONTENT_URI)
        .putExtra(CalendarContract.Events.TITLE, name)
        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin.toLong())
        .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end.toLong())
        .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, allDay)
      open(intent, "calendar")
    }
  }

  companion object {
    const val MAX_LABEL = 60
    const val MAX_TITLE = 100
    const val MAX_TIMER = 24 * 3600
    const val MAX_EVENT_MS = 7.0 * 24 * 3600 * 1000
    const val MIN_TIME = 946684800000.0 // 2000-01-01
    const val MAX_TIME = 4133980800000.0 // 2101-01-01
  }
}
