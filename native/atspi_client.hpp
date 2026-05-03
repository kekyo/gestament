// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#ifndef GESTAMENT_ATSPI_CLIENT_HPP
#define GESTAMENT_ATSPI_CLIENT_HPP

#include <glib.h>

#include <string>

/////////////////////////////////////////////////////////////////////////////////////////

namespace gestament {

/** Machine-readable native error codes passed through the Node addon. */
enum class NativeErrorCode {
  element_not_found,
  invalid_argument,
  operation_failed,
  stale_element,
  unsupported_interface,
};

/** Native operation error with a stable code and diagnostic message. */
struct NativeError {
  NativeErrorCode code;
  std::string message;
};

/** AT-SPI readiness state for a target application process. */
enum class AtspiReadiness {
  ready,
  missing_bus_name,
  missing_root,
  missing_cache,
};

/** Initializes AT-SPI once for this process. */
bool ensure_atspi_initialized(NativeError *error);

/** Checks whether a process has registered the AT-SPI root and cache objects. */
AtspiReadiness process_atspi_readiness(guint process_id);

/** Converts an AT-SPI readiness state to the public JavaScript string. */
const char *atspi_readiness_to_string(AtspiReadiness readiness);

/** Converts a native error code to the public JavaScript code string. */
const char *native_error_code_to_string(NativeErrorCode code);

}  // namespace gestament

#endif
