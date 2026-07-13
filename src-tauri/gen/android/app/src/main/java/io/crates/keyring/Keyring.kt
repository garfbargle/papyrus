package io.crates.keyring

import android.content.Context

/**
 * JNI bridge for `android-native-keyring-store`.
 *
 * That crate expects the host application to populate the `ndk-context` global
 * with the JavaVM and Android `Context` before any `Store::new()` call. Tauri /
 * `tao` on Android use `android-activity`, which does NOT initialize
 * `ndk-context`, so without this bridge the keyring store panics at startup with
 * "android context was not initialized".
 *
 * The native symbol
 * `Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext` is
 * exported from `libpapyrus_lib.so` (the crate is statically linked into it), so
 * the companion object below must keep this exact package/class/name shape.
 */
class Keyring {
    companion object {
        init {
            // Idempotent: Tauri also loads this library via the `Rust` object.
            System.loadLibrary("papyrus_lib")
        }

        external fun initializeNdkContext(context: Context)
    }
}
