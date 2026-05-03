// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#ifndef GESTAMENT_TRAY_HPP
#define GESTAMENT_TRAY_HPP

#include "atspi_client.hpp"

#include <glib.h>

#include <string>
#include <vector>

namespace gestament {

/** StatusNotifier tray item exposed through the session bus. */
struct TrayItemInfo {
  std::string bus_name;
  std::string object_path;
  std::string id;
  std::string title;
  std::string status;
  std::string icon_name;
  std::string accessible_id;
};

/** Lists StatusNotifier tray items owned by the process id. */
bool list_tray_items(guint process_id, std::vector<TrayItemInfo> *items,
                     NativeError *error);

/** Runs the lightweight StatusNotifierWatcher and visual tray host. */
bool run_tray_host(NativeError *error);

}  // namespace gestament

#endif
