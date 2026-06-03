// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include "runtime_config.h"

/////////////////////////////////////////////////////////////////////////////////////////

namespace gestament {

static NativeTimeoutConfig current_native_timeout_config = {
    50,
    5000000,
    2000000,
    2000000,
};

const NativeTimeoutConfig &native_timeout_config() {
  return current_native_timeout_config;
}

void set_native_timeout_config(const NativeTimeoutConfig &config) {
  current_native_timeout_config = config;
}

}  // namespace gestament

