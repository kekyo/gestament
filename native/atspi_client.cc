// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include "atspi_client.hpp"

#include <atspi/atspi.h>
#include <dbus/dbus.h>

#include <memory>
#include <string>
#include <vector>

/////////////////////////////////////////////////////////////////////////////////////////

namespace gestament {

namespace {

constexpr int kReadinessProbeTimeoutMs = 50;
constexpr const char *kDbusService = "org.freedesktop.DBus";
constexpr const char *kDbusPath = "/org/freedesktop/DBus";
constexpr const char *kDbusInterface = "org.freedesktop.DBus";
constexpr const char *kAtspiRootPath = "/org/a11y/atspi/accessible/root";
constexpr const char *kAtspiAccessibleInterface = "org.a11y.atspi.Accessible";
#if GESTAMENT_GTK_BACKEND_GTK4
constexpr const char *kAtspiCachePath = "/org/a11y/atspi/cache";
constexpr const char *kAtspiCacheInterface = "org.a11y.atspi.Cache";
#endif

struct DbusMessageDeleter {
  void operator()(DBusMessage *message) const {
    if (message != nullptr) {
      dbus_message_unref(message);
    }
  }
};

using DbusMessagePtr = std::unique_ptr<DBusMessage, DbusMessageDeleter>;

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
      connection, message, kReadinessProbeTimeoutMs, &error));
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

bool find_process_bus_name(DBusConnection *connection, guint process_id,
                           std::string *bus_name) {
  std::vector<std::string> names;
  if (!list_bus_names(connection, &names)) {
    return false;
  }

  for (const std::string &name : names) {
    guint candidate_process_id = 0;
    if (get_connection_process_id(connection, name, &candidate_process_id) &&
        candidate_process_id == process_id) {
      *bus_name = name;
      return true;
    }
  }

  return false;
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

  std::string bus_name;
  if (!find_process_bus_name(connection, process_id, &bus_name)) {
    return AtspiReadiness::missing_bus_name;
  }

  if (!call_root_probe(connection, bus_name)) {
    return AtspiReadiness::missing_root;
  }

#if GESTAMENT_GTK_BACKEND_GTK4
  if (!call_cache_probe(connection, bus_name)) {
    return AtspiReadiness::missing_cache;
  }
#endif

  return AtspiReadiness::ready;
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
