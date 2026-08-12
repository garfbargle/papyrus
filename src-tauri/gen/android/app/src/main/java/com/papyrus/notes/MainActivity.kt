package com.papyrus.notes

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Must run before super.onCreate(), which starts the Rust side (Rust.create()).
    // The Rust setup() reads the native keyring, and android-native-keyring-store
    // requires ndk-context to be initialized first (Tauri/tao don't do this).
    Keyring.initializeNdkContext(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Called by wry once the WebView exists. We draw edge-to-edge (content behind
  // the status bar and gesture nav), so the frontend needs to know the size of
  // those bars to keep controls tappable. We can't rely on the CSS
  // env(safe-area-inset-*) values here: Android WebView derives them from the
  // display cutout, not the system bars, so on a phone with no notch the top
  // inset reads 0 and the header jams under the status bar. Instead we read the
  // real WindowInsets natively and publish them as CSS variables the stylesheet
  // consumes (--sait/--sair/--saib/--sail), falling back to env() elsewhere.
  override fun onWebViewCreate(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      val top = bars.top / density
      val right = bars.right / density
      val bottom = bars.bottom / density
      val left = bars.left / density
      val js = """
        (function () {
          var s = document.documentElement.style;
          s.setProperty('--sait', '${top}px');
          s.setProperty('--sair', '${right}px');
          s.setProperty('--saib', '${bottom}px');
          s.setProperty('--sail', '${left}px');
        })();
      """.trimIndent()
      view.post { webView.evaluateJavascript(js, null) }
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }
}
