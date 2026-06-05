// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#ifndef GESTAMENT_RUNTIME_CONFIG_HPP
#define GESTAMENT_RUNTIME_CONFIG_HPP

#include <glib.h>

/////////////////////////////////////////////////////////////////////////////////////////

namespace gestament {

/** Runtime timeout values used by native AT-SPI and X11 operations. */
struct NativeTimeoutConfig {
  gint atspi_readiness_probe_timeout_ms;
  gint64 state_change_timeout_usec;
  gint64 window_geometry_timeout_usec;
  gint64 window_activation_timeout_usec;
};

/** Reads the current native runtime timeout configuration. */
const NativeTimeoutConfig &native_timeout_config();

/** Replaces the native runtime timeout configuration. */
void set_native_timeout_config(const NativeTimeoutConfig &config);

}  // namespace gestament

#endif
