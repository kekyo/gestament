// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include "tray.hpp"

#include <gio/gio.h>
#include <gtk/gtk.h>

#if GESTAMENT_GTK_BACKEND_GTK3
#include <atk/atk.h>
#endif

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace gestament {

namespace {

constexpr const char *kWatcherBusName = "org.kde.StatusNotifierWatcher";
constexpr const char *kWatcherObjectPath = "/StatusNotifierWatcher";
constexpr const char *kWatcherInterface = "org.kde.StatusNotifierWatcher";
constexpr const char *kItemInterface = "org.kde.StatusNotifierItem";
constexpr const char *kDefaultItemObjectPath = "/StatusNotifierItem";
constexpr const char *kTrayHostReadyLine = "gestament-tray-host-ready\n";

const char watcher_introspection_xml[] =
    "<node>"
    "  <interface name='org.kde.StatusNotifierWatcher'>"
    "    <method name='RegisterStatusNotifierItem'>"
    "      <arg name='service' type='s' direction='in'/>"
    "    </method>"
    "    <method name='RegisterStatusNotifierHost'>"
    "      <arg name='service' type='s' direction='in'/>"
    "    </method>"
    "    <property name='RegisteredStatusNotifierItems' type='as' access='read'/>"
    "    <property name='IsStatusNotifierHostRegistered' type='b' access='read'/>"
    "    <property name='ProtocolVersion' type='i' access='read'/>"
    "    <signal name='StatusNotifierItemRegistered'>"
    "      <arg name='service' type='s'/>"
    "    </signal>"
    "    <signal name='StatusNotifierItemUnregistered'>"
    "      <arg name='service' type='s'/>"
    "    </signal>"
    "    <signal name='StatusNotifierHostRegistered'/>"
    "  </interface>"
    "</node>";

struct TrayHostState;

struct TrayHostItem {
  TrayHostState *state;
  std::string bus_name;
  std::string object_path;
  std::string registered_item;
  std::string id;
  std::string title;
  std::string status;
  std::string icon_name;
  std::string accessible_id;
  GtkWidget *button;
  guint watch_id;
};

struct TrayHostState {
  GDBusConnection *connection;
  GDBusNodeInfo *watcher_node;
  guint watcher_registration_id;
  GtkWidget *window;
  GtkWidget *box;
  GMainLoop *loop;
  std::vector<TrayHostItem *> items;
};

std::string take_gerror_message(GError **error, const std::string &fallback) {
  if (error == nullptr || *error == nullptr) {
    return fallback;
  }

  std::string message = (*error)->message;
  g_clear_error(error);
  return message;
}

bool is_missing_watcher_error(GError *error) {
  if (error == nullptr || !g_dbus_error_is_remote_error(error)) {
    return false;
  }

  gchar *remote_error = g_dbus_error_get_remote_error(error);
  const bool missing =
      remote_error != nullptr &&
      (std::string(remote_error) == "org.freedesktop.DBus.Error.ServiceUnknown" ||
       std::string(remote_error) == "org.freedesktop.DBus.Error.NameHasNoOwner");
  g_free(remote_error);
  return missing;
}

void assign_widget_id(GtkWidget *widget, const char *id) {
  gtk_widget_set_name(widget, id);

#if GESTAMENT_GTK_BACKEND_GTK3
  AtkObject *accessible = gtk_widget_get_accessible(widget);
  if (accessible != nullptr) {
    atk_object_set_accessible_id(accessible, id);
  }
#else
  if (g_object_class_find_property(G_OBJECT_GET_CLASS(widget),
                                   "accessible-id") != nullptr) {
    g_object_set(widget, "accessible-id", id, nullptr);
  }
#endif
}

void show_tray_window(TrayHostState *state) {
#if GESTAMENT_GTK_BACKEND_GTK3
  gtk_widget_show_all(state->window);
  GdkWindow *window = gtk_widget_get_window(state->window);
  if (window != nullptr) {
    gdk_window_raise(window);
    gdk_display_sync(gdk_window_get_display(window));
  }
#else
  gtk_window_present(GTK_WINDOW(state->window));
#endif
  while (g_main_context_pending(nullptr)) {
    g_main_context_iteration(nullptr, FALSE);
  }
#if GESTAMENT_GTK_BACKEND_GTK3
  if (window != nullptr) {
    gdk_window_raise(window);
    gdk_display_sync(gdk_window_get_display(window));
  }
#endif
}

void remove_widget_from_parent(GtkWidget *widget) {
#if GESTAMENT_GTK_BACKEND_GTK3
  gtk_widget_destroy(widget);
#else
  GtkWidget *parent = gtk_widget_get_parent(widget);
  if (parent != nullptr && GTK_IS_BOX(parent)) {
    gtk_box_remove(GTK_BOX(parent), widget);
  } else {
    gtk_widget_unparent(widget);
  }
#endif
}

void on_window_destroy(GtkWidget *, gpointer user_data) {
  auto *state = static_cast<TrayHostState *>(user_data);
  if (state->loop != nullptr) {
    g_main_loop_quit(state->loop);
  }
}

#if GESTAMENT_GTK_BACKEND_GTK4
gboolean on_window_close_request(GtkWindow *, gpointer user_data) {
  auto *state = static_cast<TrayHostState *>(user_data);
  if (state->loop != nullptr) {
    g_main_loop_quit(state->loop);
  }
  return FALSE;
}
#endif

std::string tray_accessible_id(const std::string &registered_item) {
  constexpr char hex[] = "0123456789abcdef";
  std::string result = "gestament_tray_";
  for (unsigned char ch : registered_item) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9')) {
      result.push_back(static_cast<char>(ch));
    } else {
      result.push_back('_');
      result.push_back(hex[ch >> 4]);
      result.push_back(hex[ch & 0x0f]);
    }
  }
  return result;
}

GtkWidget *create_icon_widget(const std::string &icon_name) {
#if GESTAMENT_GTK_BACKEND_GTK3
  GtkWidget *image =
      gtk_image_new_from_icon_name(icon_name.c_str(), GTK_ICON_SIZE_MENU);
#else
  GtkWidget *image = gtk_image_new_from_icon_name(icon_name.c_str());
#endif
  gtk_image_set_pixel_size(GTK_IMAGE(image), 16);
  return image;
}

GtkWidget *create_tray_button(const std::string &label, const std::string &id,
                              const std::string &icon_name) {
#if GESTAMENT_GTK_BACKEND_GTK3
  GtkWidget *button = gtk_button_new();
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
  gtk_widget_set_halign(box, GTK_ALIGN_CENTER);
  if (!icon_name.empty()) {
    gtk_box_pack_start(GTK_BOX(box), create_icon_widget(icon_name), FALSE,
                       FALSE, 0);
  }
  gtk_box_pack_start(GTK_BOX(box), gtk_label_new(label.c_str()), FALSE, FALSE,
                     0);
  gtk_container_add(GTK_CONTAINER(button), box);
#else
  const std::string ui =
      "<interface>"
      "  <requires lib='gtk' version='4.0'/>"
      "  <object class='GtkButton' id='" +
      id +
      "'/>"
      "</interface>";
  GError *error = nullptr;
  GtkBuilder *builder = gtk_builder_new();
  if (!gtk_builder_add_from_string(builder, ui.c_str(), ui.size(), &error)) {
    g_clear_error(&error);
    g_object_unref(builder);
    return gtk_button_new_with_label(label.c_str());
  }

  GObject *object = gtk_builder_get_object(builder, id.c_str());
  GtkWidget *button =
      object != nullptr && GTK_IS_BUTTON(object) ? GTK_WIDGET(object) : nullptr;
  if (button != nullptr) {
    g_object_ref(button);
  }
  g_object_unref(builder);
  if (button == nullptr) {
    return gtk_button_new_with_label(label.c_str());
  }
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
  gtk_widget_set_halign(box, GTK_ALIGN_CENTER);
  if (!icon_name.empty()) {
    gtk_box_append(GTK_BOX(box), create_icon_widget(icon_name));
  }
  gtk_box_append(GTK_BOX(box), gtk_label_new(label.c_str()));
  gtk_button_set_child(GTK_BUTTON(button), box);
#endif
  assign_widget_id(button, id.c_str());
  return button;
}

std::string registered_item_key(const std::string &bus_name,
                                const std::string &object_path) {
  return bus_name + object_path;
}

bool parse_registered_item(const std::string &registered_item,
                           std::string *bus_name, std::string *object_path) {
  const std::size_t path_index = registered_item.find('/');
  if (path_index == std::string::npos || path_index == 0) {
    return false;
  }

  *bus_name = registered_item.substr(0, path_index);
  *object_path = registered_item.substr(path_index);
  return !bus_name->empty() && !object_path->empty();
}

void resolve_registration(const gchar *sender, const gchar *service,
                          std::string *bus_name, std::string *object_path) {
  const std::string service_value = service == nullptr ? "" : service;
  if (!service_value.empty() && service_value[0] == '/') {
    *bus_name = sender == nullptr ? "" : sender;
    *object_path = service_value;
    return;
  }

  const std::size_t path_index = service_value.find('/');
  if (path_index != std::string::npos) {
    *bus_name = service_value.substr(0, path_index);
    *object_path = service_value.substr(path_index);
    return;
  }

  *bus_name = service_value;
  *object_path = kDefaultItemObjectPath;
}

std::string read_string_property(GDBusConnection *connection,
                                 const std::string &bus_name,
                                 const std::string &object_path,
                                 const char *property_name) {
  GError *error = nullptr;
  GVariant *reply = g_dbus_connection_call_sync(
      connection, bus_name.c_str(), object_path.c_str(),
      "org.freedesktop.DBus.Properties", "Get",
      g_variant_new("(ss)", kItemInterface, property_name),
      G_VARIANT_TYPE("(v)"), G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error);
  if (error != nullptr) {
    g_clear_error(&error);
    return "";
  }

  GVariant *variant = g_variant_get_child_value(reply, 0);
  GVariant *value = g_variant_get_variant(variant);
  std::string result;
  if (g_variant_is_of_type(value, G_VARIANT_TYPE_STRING)) {
    result = g_variant_get_string(value, nullptr);
  }

  g_variant_unref(value);
  g_variant_unref(variant);
  g_variant_unref(reply);
  return result;
}

guint get_connection_process_id(GDBusConnection *connection,
                                const std::string &bus_name, GError **error) {
  GVariant *reply = g_dbus_connection_call_sync(
      connection, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "GetConnectionUnixProcessID",
      g_variant_new("(s)", bus_name.c_str()), G_VARIANT_TYPE("(u)"),
      G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, error);
  if (reply == nullptr) {
    return 0;
  }

  guint32 process_id = 0;
  g_variant_get(reply, "(u)", &process_id);
  g_variant_unref(reply);
  return process_id;
}

bool read_registered_items(GDBusConnection *connection,
                           std::vector<std::string> *registered_items,
                           NativeError *error) {
  GError *gerror = nullptr;
  GVariant *reply = g_dbus_connection_call_sync(
      connection, kWatcherBusName, kWatcherObjectPath,
      "org.freedesktop.DBus.Properties", "Get",
      g_variant_new("(ss)", kWatcherInterface, "RegisteredStatusNotifierItems"),
      G_VARIANT_TYPE("(v)"), G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &gerror);
  if (gerror != nullptr) {
    if (is_missing_watcher_error(gerror)) {
      g_clear_error(&gerror);
      return true;
    }
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to read tray watcher items."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  GVariant *variant = g_variant_get_child_value(reply, 0);
  GVariant *array = g_variant_get_variant(variant);
  GVariantIter iter;
  const gchar *registered_item = nullptr;
  g_variant_iter_init(&iter, array);
  while (g_variant_iter_next(&iter, "&s", &registered_item)) {
    if (registered_item != nullptr) {
      registered_items->push_back(registered_item);
    }
  }

  g_variant_unref(array);
  g_variant_unref(variant);
  g_variant_unref(reply);
  return true;
}

TrayHostItem *find_host_item(TrayHostState *state,
                             const std::string &registered_item) {
  const auto item = std::find_if(
      state->items.begin(), state->items.end(),
      [&](TrayHostItem *candidate) {
        return candidate->registered_item == registered_item;
      });
  return item == state->items.end() ? nullptr : *item;
}

void emit_item_signal(TrayHostState *state, const char *signal_name,
                      const std::string &registered_item) {
  g_dbus_connection_emit_signal(
      state->connection, nullptr, kWatcherObjectPath, kWatcherInterface,
      signal_name, g_variant_new("(s)", registered_item.c_str()), nullptr);
}

void remove_host_item(TrayHostItem *item, bool emit_signal) {
  TrayHostState *state = item->state;
  if (item->watch_id != 0) {
    g_bus_unwatch_name(item->watch_id);
    item->watch_id = 0;
  }
  if (item->button != nullptr) {
    remove_widget_from_parent(item->button);
    item->button = nullptr;
  }
  if (emit_signal) {
    emit_item_signal(state, "StatusNotifierItemUnregistered",
                     item->registered_item);
  }

  const auto position = std::find(state->items.begin(), state->items.end(), item);
  if (position != state->items.end()) {
    state->items.erase(position);
  }
  delete item;
}

void on_tray_button_clicked(GtkButton *, gpointer user_data) {
  auto *item = static_cast<TrayHostItem *>(user_data);
  g_dbus_connection_call(
      item->state->connection, item->bus_name.c_str(),
      item->object_path.c_str(), kItemInterface, "Activate",
      g_variant_new("(ii)", 0, 0), nullptr, G_DBUS_CALL_FLAGS_NONE, 1000,
      nullptr, nullptr, nullptr);
}

void register_host_item(TrayHostState *state, const gchar *sender,
                        const gchar *service) {
  std::string bus_name;
  std::string object_path;
  resolve_registration(sender, service, &bus_name, &object_path);
  if (bus_name.empty() || object_path.empty()) {
    return;
  }

  const std::string registered_item = registered_item_key(bus_name, object_path);
  if (find_host_item(state, registered_item) != nullptr) {
    return;
  }

  auto *item = new TrayHostItem{
      state,
      bus_name,
      object_path,
      registered_item,
      read_string_property(state->connection, bus_name, object_path, "Id"),
      read_string_property(state->connection, bus_name, object_path, "Title"),
      read_string_property(state->connection, bus_name, object_path, "Status"),
      read_string_property(state->connection, bus_name, object_path, "IconName"),
      tray_accessible_id(registered_item),
      nullptr,
      0,
  };

  const std::string label =
      !item->title.empty()
          ? item->title
          : (!item->id.empty() ? item->id : item->registered_item);
  item->button = create_tray_button(label, item->accessible_id, item->icon_name);
  gtk_widget_set_size_request(item->button, 28, 28);
  g_signal_connect(GTK_BUTTON(item->button), "clicked",
                   G_CALLBACK(on_tray_button_clicked), item);
#if GESTAMENT_GTK_BACKEND_GTK3
  gtk_box_pack_start(GTK_BOX(state->box), item->button, FALSE, FALSE, 0);
#else
  gtk_box_append(GTK_BOX(state->box), item->button);
#endif
  show_tray_window(state);

  state->items.push_back(item);
  emit_item_signal(state, "StatusNotifierItemRegistered", item->registered_item);
}

void handle_watcher_method_call(GDBusConnection *, const gchar *sender,
                                const gchar *, const gchar *interface_name,
                                const gchar *method_name, GVariant *parameters,
                                GDBusMethodInvocation *invocation,
                                gpointer user_data) {
  auto *state = static_cast<TrayHostState *>(user_data);
  if (std::string(interface_name) != kWatcherInterface) {
    g_dbus_method_invocation_return_error_literal(
        invocation, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_INTERFACE,
        "Unsupported interface.");
    return;
  }

  if (std::string(method_name) == "RegisterStatusNotifierItem") {
    const gchar *service = nullptr;
    g_variant_get(parameters, "(&s)", &service);
    register_host_item(state, sender, service);
    g_dbus_method_invocation_return_value(invocation, nullptr);
    return;
  }

  if (std::string(method_name) == "RegisterStatusNotifierHost") {
    g_dbus_connection_emit_signal(
        state->connection, nullptr, kWatcherObjectPath, kWatcherInterface,
        "StatusNotifierHostRegistered", nullptr, nullptr);
    g_dbus_method_invocation_return_value(invocation, nullptr);
    return;
  }

  g_dbus_method_invocation_return_error_literal(
      invocation, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_METHOD,
      "Unsupported method.");
}

GVariant *handle_watcher_get_property(GDBusConnection *, const gchar *,
                                      const gchar *, const gchar *,
                                      const gchar *property_name, GError **,
                                      gpointer user_data) {
  auto *state = static_cast<TrayHostState *>(user_data);
  const std::string property = property_name == nullptr ? "" : property_name;

  if (property == "RegisteredStatusNotifierItems") {
    GVariantBuilder builder;
    g_variant_builder_init(&builder, G_VARIANT_TYPE("as"));
    for (const TrayHostItem *item : state->items) {
      g_variant_builder_add(&builder, "s", item->registered_item.c_str());
    }
    return g_variant_builder_end(&builder);
  }

  if (property == "IsStatusNotifierHostRegistered") {
    return g_variant_new_boolean(TRUE);
  }

  if (property == "ProtocolVersion") {
    return g_variant_new_int32(0);
  }

  return nullptr;
}

const GDBusInterfaceVTable watcher_vtable = {
    handle_watcher_method_call,
    handle_watcher_get_property,
    nullptr,
    {nullptr},
};

void cleanup_host_state(TrayHostState *state) {
  while (!state->items.empty()) {
    remove_host_item(state->items.back(), false);
  }
  if (state->watcher_registration_id != 0) {
    g_dbus_connection_unregister_object(state->connection,
                                        state->watcher_registration_id);
  }
  if (state->watcher_node != nullptr) {
    g_dbus_node_info_unref(state->watcher_node);
  }
  if (state->connection != nullptr) {
    g_object_unref(state->connection);
  }
}

}  // namespace

bool list_tray_items(guint process_id, std::vector<TrayItemInfo> *items,
                     NativeError *error) {
  if (items == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Tray item result must not be null.",
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  GDBusConnection *connection =
      g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to connect to session bus."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  std::vector<std::string> registered_items;
  if (!read_registered_items(connection, &registered_items, error)) {
    g_object_unref(connection);
    return false;
  }

  for (const std::string &registered_item : registered_items) {
    std::string bus_name;
    std::string object_path;
    if (!parse_registered_item(registered_item, &bus_name, &object_path)) {
      continue;
    }

    GError *pid_error = nullptr;
    const guint item_process_id =
        get_connection_process_id(connection, bus_name, &pid_error);
    if (pid_error != nullptr) {
      g_clear_error(&pid_error);
      continue;
    }
    if (item_process_id != process_id) {
      continue;
    }

    items->push_back({
        bus_name,
        object_path,
        read_string_property(connection, bus_name, object_path, "Id"),
        read_string_property(connection, bus_name, object_path, "Title"),
        read_string_property(connection, bus_name, object_path, "Status"),
        read_string_property(connection, bus_name, object_path, "IconName"),
        tray_accessible_id(registered_item),
    });
  }

  g_object_unref(connection);
  return true;
}

bool run_tray_host(NativeError *error) {
#if GESTAMENT_GTK_BACKEND_GTK3
  if (!gtk_init_check(nullptr, nullptr)) {
#else
  if (!gtk_init_check()) {
#endif
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to initialize GTK for tray host.",
      };
    }
    return false;
  }

  TrayHostState state = {};
  GError *gerror = nullptr;
  state.connection = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to connect to session bus."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  state.watcher_node =
      g_dbus_node_info_new_for_xml(watcher_introspection_xml, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to create watcher interface."),
      };
    } else {
      g_clear_error(&gerror);
    }
    cleanup_host_state(&state);
    return false;
  }

  state.watcher_registration_id = g_dbus_connection_register_object(
      state.connection, kWatcherObjectPath, state.watcher_node->interfaces[0],
      &watcher_vtable, &state, nullptr, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to register watcher object."),
      };
    } else {
      g_clear_error(&gerror);
    }
    cleanup_host_state(&state);
    return false;
  }

  GVariant *request_name_reply = g_dbus_connection_call_sync(
      state.connection, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "RequestName",
      g_variant_new("(su)", kWatcherBusName, static_cast<guint32>(0)),
      G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to own tray watcher name."),
      };
    } else {
      g_clear_error(&gerror);
    }
    cleanup_host_state(&state);
    return false;
  }

  guint32 request_name_result = 0;
  g_variant_get(request_name_reply, "(u)", &request_name_result);
  g_variant_unref(request_name_reply);
  if (request_name_result != 1 && request_name_result != 4) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Another StatusNotifierWatcher already owns the session bus name.",
      };
    }
    cleanup_host_state(&state);
    return false;
  }

  state.loop = g_main_loop_new(nullptr, FALSE);

#if GESTAMENT_GTK_BACKEND_GTK3
  state.window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
#else
  state.window = gtk_window_new();
#endif
  assign_widget_id(state.window, "gestament_tray_host");
  gtk_window_set_title(GTK_WINDOW(state.window), "Gestament Tray Host");
  gtk_window_set_decorated(GTK_WINDOW(state.window), FALSE);
#if GESTAMENT_GTK_BACKEND_GTK3
  gtk_window_set_keep_above(GTK_WINDOW(state.window), TRUE);
  gtk_window_move(GTK_WINDOW(state.window), 8, 8);
#endif
  gtk_widget_set_size_request(state.window, 240, 32);
  g_signal_connect(state.window, "destroy", G_CALLBACK(on_window_destroy),
                   &state);
#if GESTAMENT_GTK_BACKEND_GTK4
  g_signal_connect(state.window, "close-request",
                   G_CALLBACK(on_window_close_request), &state);
#endif

  state.box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 2);
#if GESTAMENT_GTK_BACKEND_GTK3
  gtk_container_add(GTK_CONTAINER(state.window), state.box);
#else
  gtk_window_set_child(GTK_WINDOW(state.window), state.box);
#endif
  show_tray_window(&state);

  g_print("%s", kTrayHostReadyLine);
  fflush(stdout);
  g_main_loop_run(state.loop);

  cleanup_host_state(&state);
  g_main_loop_unref(state.loop);
  return true;
}

}  // namespace gestament
