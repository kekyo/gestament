// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include "atspi_client.h"
#include "runtime_config.h"

#include <atspi/atspi.h>
#include <dbus/dbus.h>

#include <cerrno>
#include <cctype>
#include <cstdlib>
#include <dirent.h>
#include <fstream>
#include <limits>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

/////////////////////////////////////////////////////////////////////////////////////////

namespace gestament {

namespace {

constexpr const char *kDbusService = "org.freedesktop.DBus";
constexpr const char *kDbusPath = "/org/freedesktop/DBus";
constexpr const char *kDbusInterface = "org.freedesktop.DBus";
constexpr const char *kAtspiRootPath = "/org/a11y/atspi/accessible/root";
constexpr const char *kAtspiAccessibleInterface = "org.a11y.atspi.Accessible";
#if GESTAMENT_GTK_BACKEND_GTK4
constexpr const char *kAtspiCachePath = "/org/a11y/atspi/cache";
constexpr const char *kAtspiCacheInterface = "org.a11y.atspi.Cache";
#endif

struct ProcessScope {
  guint root_process_id;
  std::set<guint> process_ids;
};

struct DbusMessageDeleter {
  void operator()(DBusMessage *message) const {
    if (message != nullptr) {
      dbus_message_unref(message);
    }
  }
};

using DbusMessagePtr = std::unique_ptr<DBusMessage, DbusMessageDeleter>;

bool parse_proc_pid(const char *name, guint *pid) {
  if (name == nullptr || name[0] == '\0' || pid == nullptr) {
    return false;
  }

  for (const char *current = name; *current != '\0'; current += 1) {
    if (!std::isdigit(static_cast<unsigned char>(*current))) {
      return false;
    }
  }

  errno = 0;
  char *end = nullptr;
  const unsigned long parsed = std::strtoul(name, &end, 10);
  if (errno != 0 || end == name || end == nullptr || *end != '\0' ||
      parsed > static_cast<unsigned long>(std::numeric_limits<guint>::max())) {
    return false;
  }

  *pid = static_cast<guint>(parsed);
  return true;
}

bool read_proc_parent_process_id(guint process_id, guint *parent_process_id) {
  if (parent_process_id == nullptr) {
    return false;
  }

  std::ifstream stream("/proc/" + std::to_string(process_id) + "/stat");
  std::string line;
  if (!std::getline(stream, line)) {
    return false;
  }

  const std::size_t close_index = line.rfind(')');
  if (close_index == std::string::npos || close_index + 2 >= line.size()) {
    return false;
  }

  std::istringstream fields(line.substr(close_index + 2));
  char state = '\0';
  unsigned long ppid = 0;
  if (!(fields >> state >> ppid) ||
      ppid > static_cast<unsigned long>(std::numeric_limits<guint>::max())) {
    return false;
  }

  *parent_process_id = static_cast<guint>(ppid);
  return true;
}

ProcessScope collect_process_scope(guint root_process_id) {
  ProcessScope scope = {
      root_process_id,
      {root_process_id},
  };

  DIR *proc = opendir("/proc");
  if (proc == nullptr) {
    return scope;
  }

  std::vector<std::pair<guint, guint>> process_tree;
  while (dirent *entry = readdir(proc)) {
    guint process_id = 0;
    if (!parse_proc_pid(entry->d_name, &process_id)) {
      continue;
    }

    guint parent_process_id = 0;
    if (read_proc_parent_process_id(process_id, &parent_process_id)) {
      process_tree.push_back({process_id, parent_process_id});
    }
  }
  closedir(proc);

  bool changed = false;
  do {
    changed = false;
    for (const auto &entry : process_tree) {
      if (scope.process_ids.find(entry.second) != scope.process_ids.end() &&
          scope.process_ids.insert(entry.first).second) {
        changed = true;
      }
    }
  } while (changed);

  return scope;
}

void clear_dbus_error(DBusError *error) {
  if (dbus_error_is_set(error)) {
    dbus_error_free(error);
  }
}

DbusMessagePtr call_dbus(DBusConnection *connection, DBusMessage *message) {
  if (connection == nullptr || message == nullptr) {
    return nullptr;
  }

  DBusError error;
  dbus_error_init(&error);
  DbusMessagePtr reply(dbus_connection_send_with_reply_and_block(
      connection, message,
      native_timeout_config().atspi_readiness_probe_timeout_ms, &error));
  clear_dbus_error(&error);
  return reply;
}

DbusMessagePtr call_dbus_method(DBusConnection *connection,
                                const char *destination, const char *path,
                                const char *interface, const char *member) {
  DbusMessagePtr message(
      dbus_message_new_method_call(destination, path, interface, member));
  if (message == nullptr) {
    return nullptr;
  }

  return call_dbus(connection, message.get());
}

bool list_bus_names(DBusConnection *connection, std::vector<std::string> *names) {
  DbusMessagePtr reply =
      call_dbus_method(connection, kDbusService, kDbusPath, kDbusInterface,
                       "ListNames");
  if (reply == nullptr ||
      dbus_message_get_type(reply.get()) != DBUS_MESSAGE_TYPE_METHOD_RETURN) {
    return false;
  }

  DBusMessageIter iter;
  if (!dbus_message_iter_init(reply.get(), &iter) ||
      dbus_message_iter_get_arg_type(&iter) != DBUS_TYPE_ARRAY) {
    return false;
  }

  DBusMessageIter array_iter;
  dbus_message_iter_recurse(&iter, &array_iter);
  while (dbus_message_iter_get_arg_type(&array_iter) == DBUS_TYPE_STRING) {
    const char *name = nullptr;
    dbus_message_iter_get_basic(&array_iter, &name);
    if (name != nullptr && name[0] == ':') {
      names->push_back(name);
    }
    dbus_message_iter_next(&array_iter);
  }

  return true;
}

bool get_connection_process_id(DBusConnection *connection,
                               const std::string &bus_name, guint *process_id) {
  DbusMessagePtr message(
      dbus_message_new_method_call(kDbusService, kDbusPath, kDbusInterface,
                                   "GetConnectionUnixProcessID"));
  if (message == nullptr) {
    return false;
  }

  const char *name = bus_name.c_str();
  if (!dbus_message_append_args(message.get(), DBUS_TYPE_STRING, &name,
                                DBUS_TYPE_INVALID)) {
    return false;
  }

  DbusMessagePtr reply = call_dbus(connection, message.get());
  if (reply == nullptr ||
      dbus_message_get_type(reply.get()) != DBUS_MESSAGE_TYPE_METHOD_RETURN) {
    return false;
  }

  dbus_uint32_t pid = 0;
  if (!dbus_message_get_args(reply.get(), nullptr, DBUS_TYPE_UINT32, &pid,
                             DBUS_TYPE_INVALID)) {
    return false;
  }

  *process_id = static_cast<guint>(pid);
  return true;
}

std::vector<std::string> find_process_scope_bus_names(
    DBusConnection *connection, const ProcessScope &scope) {
  std::vector<std::string> names;
  std::vector<std::string> matched_names;
  if (!list_bus_names(connection, &names)) {
    return matched_names;
  }

  for (const std::string &name : names) {
    guint candidate_process_id = 0;
    if (get_connection_process_id(connection, name, &candidate_process_id) &&
        scope.process_ids.find(candidate_process_id) != scope.process_ids.end()) {
      matched_names.push_back(name);
    }
  }

  return matched_names;
}

bool call_root_probe(DBusConnection *connection, const std::string &bus_name) {
  DbusMessagePtr reply =
      call_dbus_method(connection, bus_name.c_str(), kAtspiRootPath,
                       kAtspiAccessibleInterface, "GetRole");
  return reply != nullptr &&
         dbus_message_get_type(reply.get()) == DBUS_MESSAGE_TYPE_METHOD_RETURN;
}

#if GESTAMENT_GTK_BACKEND_GTK4
bool call_cache_probe(DBusConnection *connection, const std::string &bus_name) {
  DbusMessagePtr reply =
      call_dbus_method(connection, bus_name.c_str(), kAtspiCachePath,
                       kAtspiCacheInterface, "GetItems");
  return reply != nullptr &&
         dbus_message_get_type(reply.get()) == DBUS_MESSAGE_TYPE_METHOD_RETURN;
}
#endif

}  // namespace

bool ensure_atspi_initialized(NativeError *error) {
  if (atspi_is_initialized()) {
    return true;
  }

  const int result = atspi_init();
  if (result == 0 || atspi_is_initialized()) {
    return true;
  }

  if (error != nullptr) {
    *error = {
        NativeErrorCode::operation_failed,
        "Failed to initialize AT-SPI.",
    };
  }
  return false;
}

AtspiReadiness process_atspi_readiness(guint process_id) {
  NativeError init_error = {};
  if (!ensure_atspi_initialized(&init_error)) {
    return AtspiReadiness::missing_bus_name;
  }

  DBusConnection *connection = atspi_get_a11y_bus();
  if (connection == nullptr) {
    return AtspiReadiness::missing_bus_name;
  }

  const ProcessScope scope = collect_process_scope(process_id);
  const std::vector<std::string> bus_names =
      find_process_scope_bus_names(connection, scope);
  if (bus_names.empty()) {
    return AtspiReadiness::missing_bus_name;
  }

  AtspiReadiness last_readiness = AtspiReadiness::missing_root;
  for (const std::string &bus_name : bus_names) {
    if (!call_root_probe(connection, bus_name)) {
      continue;
    }
#if GESTAMENT_GTK_BACKEND_GTK4
    if (!call_cache_probe(connection, bus_name)) {
      last_readiness = AtspiReadiness::missing_cache;
      continue;
    }
#endif

    return AtspiReadiness::ready;
  }

  return last_readiness;
}

const char *atspi_readiness_to_string(AtspiReadiness readiness) {
  switch (readiness) {
    case AtspiReadiness::ready:
      return "ready";
    case AtspiReadiness::missing_bus_name:
      return "missing-bus-name";
    case AtspiReadiness::missing_root:
      return "missing-root";
    case AtspiReadiness::missing_cache:
      return "missing-cache";
  }

  return "missing-bus-name";
}

const char *native_error_code_to_string(NativeErrorCode code) {
  switch (code) {
    case NativeErrorCode::element_not_found:
      return "ELEMENT_NOT_FOUND";
    case NativeErrorCode::invalid_argument:
      return "INVALID_ARGUMENT";
    case NativeErrorCode::operation_failed:
      return "OPERATION_FAILED";
    case NativeErrorCode::stale_element:
      return "STALE_ELEMENT";
    case NativeErrorCode::unsupported_interface:
      return "UNSUPPORTED_INTERFACE";
  }

  return "OPERATION_FAILED";
}

}  // namespace gestament
