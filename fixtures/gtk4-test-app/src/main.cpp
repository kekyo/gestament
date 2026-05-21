// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include <gio/gio.h>
#include <gdk/x11/gdkx.h>
#include <gestament/gtk.h>
#include <gtk/gtk.h>

#include <X11/Xlib.h>
#include <X11/Xutil.h>

#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace {

// README-style test application flow.
struct AppWidgets {
  GtkWidget *window;
  GtkWidget *name_entry;
  GtkLabel *result_label;
};

struct MainWindowGeometryHints {
  int base_width;
  int base_height;
  int min_width;
  int min_height;
  int width_increment;
  int height_increment;
};

constexpr MainWindowGeometryHints kMainWindowGeometryHints = {
    80,
    40,
    120,
    90,
    7,
    11,
};
constexpr guint kDeferredGeometryHintIntervalMs = 50;
constexpr unsigned int kDeferredGeometryHintAttempts = 120;

struct DeferredGeometryHintState {
  GtkWidget *window;
  unsigned int remaining_attempts;
};

std::filesystem::path executable_directory() {
  const std::filesystem::path executable_path =
      std::filesystem::read_symlink("/proc/self/exe");
  return executable_path.parent_path();
}

std::filesystem::path ui_path() {
  return executable_directory() / "main-window.ui";
}

std::filesystem::path asset_path(const char *name) {
  return executable_directory() / name;
}

GtkWidget *required_widget(GtkBuilder *builder, const char *id) {
  GObject *object = gtk_builder_get_object(builder, id);
  if (object == nullptr || !GTK_IS_WIDGET(object)) {
    std::cerr << "Missing GTK widget: " << id << '\n';
    return nullptr;
  }

  GtkWidget *widget = GTK_WIDGET(object);
  return widget;
}

void on_submit_clicked(GtkButton *, gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  const gchar *entry_text =
      gtk_editable_get_text(GTK_EDITABLE(widgets->name_entry));
  gtk_label_set_text(widgets->result_label, entry_text);
}

struct AppOptions {
  bool cover_submit_button;
  bool status_notifier_item;
  bool widget_controls;
  bool widget_enumerables;
};

AppOptions app_options(int argc, char **argv) {
  AppOptions options = {
      false,
      false,
      false,
      false,
  };

  for (int index = 0; index < argc; index += 1) {
    const std::string argument = argv[index];
    if (argument == "--cover-submit-button") {
      options.cover_submit_button = true;
    }
    if (argument == "--status-notifier-item") {
      options.status_notifier_item = true;
    }
    if (argument == "--widget-controls") {
      options.widget_controls = true;
    }
    if (argument == "--widget-enumerables") {
      options.widget_enumerables = true;
    }
  }

  return options;
}

std::vector<char *> filtered_arguments(int argc, char **argv) {
  std::vector<char *> filtered;
  filtered.reserve(static_cast<std::size_t>(argc) + 1);

  for (int index = 0; index < argc; index += 1) {
    const std::string argument = argv[index];
    if (argument == "--cover-submit-button" ||
        argument == "--status-notifier-item" ||
        argument == "--widget-controls" ||
        argument == "--widget-enumerables") {
      continue;
    }
    filtered.push_back(argv[index]);
  }

  filtered.push_back(nullptr);
  return filtered;
}

void assign_widget_id(GtkWidget *widget, const char *id) {
  gestament_gtk_assign_accessible_id(widget, id);
}

void assign_widget_name(GtkWidget *widget, const char *name) {
  gtk_accessible_update_property(GTK_ACCESSIBLE(widget),
                                 GTK_ACCESSIBLE_PROPERTY_LABEL, name, -1);
}

GtkWidget *labelled_list_row(const char *id, const char *label_text) {
  GtkWidget *row = gtk_list_box_row_new();
  assign_widget_id(row, id);
  assign_widget_name(row, label_text);

  GtkWidget *label = gtk_label_new(label_text);
  gtk_widget_set_margin_start(label, 8);
  gtk_widget_set_margin_end(label, 8);
  gtk_widget_set_margin_top(label, 4);
  gtk_widget_set_margin_bottom(label, 4);
  gtk_list_box_row_set_child(GTK_LIST_BOX_ROW(row), label);
  return row;
}

void on_enumerable_menu_action(GSimpleAction *, GVariant *parameter,
                               gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  const char *value =
      parameter == nullptr ? "" : g_variant_get_string(parameter, nullptr);
  gtk_label_set_text(widgets->result_label, value);
}

GtkWidget *create_enumerable_menu(GtkWidget *window, AppWidgets *widgets) {
  const GActionEntry entries[] = {
      {"menu", on_enumerable_menu_action, "s", nullptr, nullptr, {0, 0, 0}},
  };
  GSimpleActionGroup *group = g_simple_action_group_new();
  g_action_map_add_action_entries(G_ACTION_MAP(group), entries, 1, widgets);
  gtk_widget_insert_action_group(window, "enum", G_ACTION_GROUP(group));
  g_object_unref(group);

  GMenu *root = g_menu_new();
  GMenu *menu = g_menu_new();
  const char *labels[] = {"Menu A", "Menu B", "Menu C"};
  const char *values[] = {"menu-0", "menu-1", "menu-2"};
  for (int index = 0; index < 3; index += 1) {
    GMenuItem *item = g_menu_item_new(labels[index], nullptr);
    g_menu_item_set_action_and_target_value(item, "enum.menu",
                                            g_variant_new_string(values[index]));
    g_menu_append_item(menu, item);
    g_object_unref(item);
  }
  g_menu_append_submenu(root, "Actions", G_MENU_MODEL(menu));

  GtkWidget *menu_bar = gtk_popover_menu_bar_new_from_model(G_MENU_MODEL(root));
  assign_widget_id(menu_bar, "enumerable_menu");
  g_object_unref(menu);
  g_object_unref(root);
  return menu_bar;
}

std::string table_cell_text(const char *row_text, int column) {
  const std::string row = row_text == nullptr ? "" : row_text;
  std::size_t start = 0;
  for (int index = 0; index < column; index += 1) {
    start = row.find('|', start);
    if (start == std::string::npos) {
      return "";
    }
    start += 1;
  }

  const std::size_t end = row.find('|', start);
  return row.substr(start, end == std::string::npos ? end : end - start);
}

void on_table_factory_setup(GtkSignalListItemFactory *, GtkListItem *list_item,
                            gpointer) {
  gtk_list_item_set_child(list_item, gtk_label_new(""));
}

void on_table_factory_bind(GtkSignalListItemFactory *, GtkListItem *list_item,
                           gpointer user_data) {
  const int column = GPOINTER_TO_INT(user_data);
  GtkWidget *label = gtk_list_item_get_child(list_item);
  auto *item = GTK_STRING_OBJECT(gtk_list_item_get_item(list_item));
  const std::string text =
      table_cell_text(gtk_string_object_get_string(item), column);
  gtk_label_set_text(GTK_LABEL(label), text.c_str());
}

GtkWidget *create_enumerable_table() {
  const char *rows[] = {"R0C0|R0C1|R0C2", "R1C0|R1C1|R1C2", nullptr};
  GtkStringList *row_model = gtk_string_list_new(rows);
  GtkMultiSelection *selection =
      gtk_multi_selection_new(G_LIST_MODEL(row_model));
  GtkWidget *table = gtk_column_view_new(GTK_SELECTION_MODEL(selection));
  assign_widget_id(table, "enumerable_table");
  gtk_column_view_set_show_column_separators(GTK_COLUMN_VIEW(table), TRUE);

  for (int column = 0; column < 3; column += 1) {
    GtkListItemFactory *factory = gtk_signal_list_item_factory_new();
    g_signal_connect(factory, "setup", G_CALLBACK(on_table_factory_setup),
                     nullptr);
    g_signal_connect(factory, "bind", G_CALLBACK(on_table_factory_bind),
                     GINT_TO_POINTER(column));
    GtkColumnViewColumn *view_column =
        gtk_column_view_column_new("", factory);
    gtk_column_view_append_column(GTK_COLUMN_VIEW(table), view_column);
    g_object_unref(view_column);
  }

  gtk_widget_set_size_request(table, 300, 120);
  return table;
}

GtkWidget *create_enumerables_window(AppWidgets *widgets) {
  GtkWidget *window = gtk_window_new();
  assign_widget_id(window, "enumerables_window");
  gtk_window_set_title(GTK_WINDOW(window), "Gestament GTK4 Enumerables");
  gtk_window_set_default_size(GTK_WINDOW(window), 420, 520);

  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
  assign_widget_id(box, "enumerables_box");
  gtk_widget_set_margin_start(box, 16);
  gtk_widget_set_margin_end(box, 16);
  gtk_widget_set_margin_top(box, 16);
  gtk_widget_set_margin_bottom(box, 16);
  gtk_window_set_child(GTK_WINDOW(window), box);

  const char *combo_items[] = {"Combo A", "Combo B", "Combo C", nullptr};
  GtkWidget *combo = gtk_drop_down_new_from_strings(combo_items);
  assign_widget_id(combo, "enumerable_combo");
  gtk_drop_down_set_selected(GTK_DROP_DOWN(combo), 0);
  gtk_box_append(GTK_BOX(box), combo);

  GtkWidget *list = gtk_list_box_new();
  assign_widget_id(list, "enumerable_list");
  gtk_list_box_set_selection_mode(GTK_LIST_BOX(list), GTK_SELECTION_MULTIPLE);
  gtk_list_box_append(GTK_LIST_BOX(list),
                      labelled_list_row("enumerable_list_item_0", "List A"));
  gtk_list_box_append(GTK_LIST_BOX(list),
                      labelled_list_row("enumerable_list_item_1", "List B"));
  gtk_list_box_append(GTK_LIST_BOX(list),
                      labelled_list_row("enumerable_list_item_2", "List C"));
  gtk_box_append(GTK_BOX(box), list);

  gtk_box_append(GTK_BOX(box), create_enumerable_menu(window, widgets));
  gtk_box_append(GTK_BOX(box), create_enumerable_table());
  return window;
}

void drain_events() {
  while (g_main_context_pending(nullptr)) {
    g_main_context_iteration(nullptr, FALSE);
  }
}

// GTK 4 has no non-deprecated API for absolute X11 root-window placement,
// but this X11-only fixture needs the native handles to test screen captures
// of covered widgets. Keep the warning suppression scoped to these accessors.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
Display *x11_display_for_surface(GdkSurface *surface) {
  return gdk_x11_display_get_xdisplay(gdk_surface_get_display(surface));
}

Window x11_window_for_surface(GdkSurface *surface) {
  return gdk_x11_surface_get_xid(surface);
}
#pragma GCC diagnostic pop

void set_x11_main_window_geometry_hints(GtkWidget *window) {
  GtkNative *native = gtk_widget_get_native(window);
  if (native == nullptr) {
    return;
  }

  GdkSurface *surface = gtk_native_get_surface(native);
  if (surface == nullptr || !GDK_IS_X11_SURFACE(surface)) {
    return;
  }

  Display *display = x11_display_for_surface(surface);
  Window xid = x11_window_for_surface(surface);
  XSizeHints hints = {};
  hints.flags = PBaseSize | PMinSize | PResizeInc;
  hints.base_width = kMainWindowGeometryHints.base_width;
  hints.base_height = kMainWindowGeometryHints.base_height;
  hints.min_width = kMainWindowGeometryHints.min_width;
  hints.min_height = kMainWindowGeometryHints.min_height;
  hints.width_inc = kMainWindowGeometryHints.width_increment;
  hints.height_inc = kMainWindowGeometryHints.height_increment;
  XSetWMNormalHints(display, xid, &hints);
  XFlush(display);
}

gboolean reapply_x11_main_window_geometry_hints(gpointer user_data) {
  auto *state = static_cast<DeferredGeometryHintState *>(user_data);
  set_x11_main_window_geometry_hints(state->window);
  state->remaining_attempts -= 1;
  return state->remaining_attempts == 0 ? G_SOURCE_REMOVE : G_SOURCE_CONTINUE;
}

void destroy_deferred_geometry_hint_state(gpointer user_data) {
  auto *state = static_cast<DeferredGeometryHintState *>(user_data);
  g_object_unref(state->window);
  delete state;
}

void schedule_x11_main_window_geometry_hints(GtkWidget *window) {
  auto *state = new DeferredGeometryHintState{
      GTK_WIDGET(g_object_ref(window)),
      kDeferredGeometryHintAttempts,
  };

  // GTK may rewrite WM_NORMAL_HINTS after map/configure on fast X11 backends.
  // Keep reapplying while later GTK4 configure cycles settle.
  g_timeout_add_full(G_PRIORITY_DEFAULT, kDeferredGeometryHintIntervalMs,
                     reapply_x11_main_window_geometry_hints, state,
                     destroy_deferred_geometry_hint_state);
}

bool widget_root_origin(GtkWidget *widget, int *x, int *y) {
  GtkNative *native = gtk_widget_get_native(widget);
  if (native == nullptr) {
    return false;
  }

  GdkSurface *surface = gtk_native_get_surface(native);
  if (surface == nullptr || !GDK_IS_X11_SURFACE(surface)) {
    return false;
  }

  Display *display = x11_display_for_surface(surface);
  Window window = x11_window_for_surface(surface);
  Window root = DefaultRootWindow(display);
  Window child = 0;
  int root_x = 0;
  int root_y = 0;
  if (XTranslateCoordinates(display, window, root, 0, 0, &root_x, &root_y,
                            &child) == 0) {
    return false;
  }

  *x = root_x;
  *y = root_y;
  return true;
}

void move_window_to_root(GtkWidget *window, int x, int y, int width,
                         int height) {
  GtkNative *native = gtk_widget_get_native(window);
  if (native == nullptr) {
    return;
  }

  GdkSurface *surface = gtk_native_get_surface(native);
  if (surface == nullptr || !GDK_IS_X11_SURFACE(surface)) {
    return;
  }

  Display *display = x11_display_for_surface(surface);
  Window xid = x11_window_for_surface(surface);
  XMoveResizeWindow(display, xid, x, y, static_cast<unsigned int>(width),
                    static_cast<unsigned int>(height));
  XRaiseWindow(display, xid);
  XFlush(display);
}

GtkWidget *show_cover_window(GtkWidget *main_window, GtkWidget *target) {
  graphene_rect_t target_bounds = {};
  if (!gtk_widget_compute_bounds(target, main_window, &target_bounds)) {
    return nullptr;
  }

  const int target_width = static_cast<int>(std::ceil(target_bounds.size.width));
  const int target_height =
      static_cast<int>(std::ceil(target_bounds.size.height));
  if (target_width <= 0 || target_height <= 0) {
    return nullptr;
  }

  int window_x = 0;
  int window_y = 0;
  if (!widget_root_origin(main_window, &window_x, &window_y)) {
    return nullptr;
  }

  GtkWidget *cover_window = gtk_window_new();
  assign_widget_id(cover_window, "cover_window");
  gtk_window_set_title(GTK_WINDOW(cover_window), "Cover Window");
  gtk_window_set_decorated(GTK_WINDOW(cover_window), FALSE);
  gtk_window_set_resizable(GTK_WINDOW(cover_window), FALSE);
  gtk_window_set_transient_for(GTK_WINDOW(cover_window), GTK_WINDOW(main_window));
  gtk_widget_set_focusable(cover_window, FALSE);
  gtk_window_set_default_size(GTK_WINDOW(cover_window), target_width,
                              target_height);
  gtk_widget_set_size_request(cover_window, target_width, target_height);

  GtkWidget *label = gtk_label_new("Covered");
  gtk_widget_set_size_request(label, target_width, target_height);
  gtk_window_set_child(GTK_WINDOW(cover_window), label);

  gtk_window_present(GTK_WINDOW(cover_window));
  drain_events();
  move_window_to_root(
      cover_window, window_x + static_cast<int>(target_bounds.origin.x),
      window_y + static_cast<int>(target_bounds.origin.y), target_width,
      target_height);
  drain_events();
  return cover_window;
}

constexpr const char *kStatusNotifierItemPath = "/StatusNotifierItem";
constexpr const char *kStatusNotifierItemInterface =
    "org.kde.StatusNotifierItem";

const char status_notifier_item_xml[] =
    "<node>"
    "  <interface name='org.kde.StatusNotifierItem'>"
    "    <method name='Activate'>"
    "      <arg name='x' type='i' direction='in'/>"
    "      <arg name='y' type='i' direction='in'/>"
    "    </method>"
    "    <method name='ContextMenu'>"
    "      <arg name='x' type='i' direction='in'/>"
    "      <arg name='y' type='i' direction='in'/>"
    "    </method>"
    "    <method name='SecondaryActivate'>"
    "      <arg name='x' type='i' direction='in'/>"
    "      <arg name='y' type='i' direction='in'/>"
    "    </method>"
    "    <method name='Scroll'>"
    "      <arg name='delta' type='i' direction='in'/>"
    "      <arg name='orientation' type='s' direction='in'/>"
    "    </method>"
    "    <property name='Category' type='s' access='read'/>"
    "    <property name='Id' type='s' access='read'/>"
    "    <property name='Title' type='s' access='read'/>"
    "    <property name='Status' type='s' access='read'/>"
    "    <property name='IconName' type='s' access='read'/>"
    "    <property name='ItemIsMenu' type='b' access='read'/>"
    "    <property name='WindowId' type='u' access='read'/>"
    "  </interface>"
    "</node>";

struct TrayItemState {
  GDBusConnection *connection;
  GDBusNodeInfo *node;
  guint registration_id;
  AppWidgets *widgets;
};

void on_tray_item_method_call(GDBusConnection *, const gchar *, const gchar *,
                              const gchar *interface_name,
                              const gchar *method_name, GVariant *,
                              GDBusMethodInvocation *invocation,
                              gpointer user_data) {
  auto *state = static_cast<TrayItemState *>(user_data);
  if (std::string(interface_name) != kStatusNotifierItemInterface) {
    g_dbus_method_invocation_return_error_literal(
        invocation, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_INTERFACE,
        "Unsupported interface.");
    return;
  }

  const std::string method = method_name == nullptr ? "" : method_name;
  if (method == "Activate") {
    gtk_label_set_text(state->widgets->result_label, "tray-activated");
    g_dbus_method_invocation_return_value(invocation, nullptr);
    return;
  }

  if (method == "ContextMenu" || method == "SecondaryActivate" ||
      method == "Scroll") {
    g_dbus_method_invocation_return_value(invocation, nullptr);
    return;
  }

  g_dbus_method_invocation_return_error_literal(
      invocation, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_METHOD,
      "Unsupported method.");
}

GVariant *on_tray_item_get_property(GDBusConnection *, const gchar *,
                                    const gchar *, const gchar *,
                                    const gchar *property_name, GError **,
                                    gpointer) {
  const std::string property = property_name == nullptr ? "" : property_name;
  if (property == "Category") {
    return g_variant_new_string("ApplicationStatus");
  }
  if (property == "Id") {
    return g_variant_new_string("gestament-fixture");
  }
  if (property == "Title") {
    return g_variant_new_string("Gestament Fixture");
  }
  if (property == "Status") {
    return g_variant_new_string("Active");
  }
  if (property == "IconName") {
    return g_variant_new_string("dialog-information");
  }
  if (property == "ItemIsMenu") {
    return g_variant_new_boolean(FALSE);
  }
  if (property == "WindowId") {
    return g_variant_new_uint32(0);
  }

  return nullptr;
}

const GDBusInterfaceVTable status_notifier_item_vtable = {
    on_tray_item_method_call,
    on_tray_item_get_property,
    nullptr,
    {nullptr},
};

TrayItemState *register_status_notifier_item(AppWidgets *widgets) {
  GError *error = nullptr;
  GDBusConnection *connection =
      g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error);
  if (error != nullptr) {
    std::cerr << "Failed to connect to session bus: " << error->message << '\n';
    g_clear_error(&error);
    return nullptr;
  }

  GDBusNodeInfo *node =
      g_dbus_node_info_new_for_xml(status_notifier_item_xml, &error);
  if (error != nullptr) {
    std::cerr << "Failed to create StatusNotifierItem interface: "
              << error->message << '\n';
    g_clear_error(&error);
    g_object_unref(connection);
    return nullptr;
  }

  auto *state = new TrayItemState{
      connection,
      node,
      0,
      widgets,
  };
  state->registration_id = g_dbus_connection_register_object(
      connection, kStatusNotifierItemPath, node->interfaces[0],
      &status_notifier_item_vtable, state, nullptr, &error);
  if (error != nullptr) {
    std::cerr << "Failed to register StatusNotifierItem object: "
              << error->message << '\n';
    g_clear_error(&error);
    g_dbus_node_info_unref(node);
    g_object_unref(connection);
    delete state;
    return nullptr;
  }

  GVariant *reply = g_dbus_connection_call_sync(
      connection, "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
      "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem",
      g_variant_new("(s)", kStatusNotifierItemPath), nullptr,
      G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error);
  if (error != nullptr) {
    std::cerr << "Failed to register with StatusNotifierWatcher: "
              << error->message << '\n';
    g_clear_error(&error);
  }
  if (reply != nullptr) {
    g_variant_unref(reply);
  }

  return state;
}

void release_status_notifier_item(TrayItemState *state) {
  if (state == nullptr) {
    return;
  }

  if (state->registration_id != 0) {
    g_dbus_connection_unregister_object(state->connection,
                                        state->registration_id);
  }
  g_dbus_node_info_unref(state->node);
  g_object_unref(state->connection);
  delete state;
}

gboolean on_close_request(GtkWindow *, gpointer user_data) {
  auto *loop = static_cast<GMainLoop *>(user_data);
  g_main_loop_quit(loop);
  return FALSE;
}

}  // namespace

int main(int argc, char **argv) {
  const AppOptions options = app_options(argc, argv);
  std::vector<char *> gtk_argv = filtered_arguments(argc, argv);
  int gtk_argc = static_cast<int>(gtk_argv.size()) - 1;
  char **gtk_argv_data = gtk_argv.data();
  (void)gtk_argc;
  (void)gtk_argv_data;

  if (!gtk_init_check()) {
    std::cerr << "Failed to initialize GTK4.\n";
    return 1;
  }

  GError *error = nullptr;
  GtkBuilder *builder = gtk_builder_new();
  const std::filesystem::path builder_file = ui_path();
  if (!gtk_builder_add_from_file(builder, builder_file.c_str(), &error)) {
    std::cerr << "Failed to load UI file: " << builder_file << '\n';
    if (error != nullptr) {
      std::cerr << error->message << '\n';
      g_clear_error(&error);
    }
    g_object_unref(builder);
    return 1;
  }
  gestament_gtk_assign_accessible_ids_from_builder(builder);

  GtkWidget *window = required_widget(builder, "main_window");
  GtkWidget *name_entry = required_widget(builder, "name_entry");
  GtkWidget *submit_button = required_widget(builder, "submit_button");
  GtkWidget *result_label = required_widget(builder, "result_label");
  GtkWidget *controls_window = required_widget(builder, "controls_window");
  GtkWidget *image_control = required_widget(builder, "image_control");
  if (window == nullptr || name_entry == nullptr || submit_button == nullptr ||
      result_label == nullptr || controls_window == nullptr ||
      image_control == nullptr) {
    g_object_unref(builder);
    return 1;
  }

  const std::filesystem::path image_file = asset_path("sp_mon.png");
  gtk_image_set_from_file(GTK_IMAGE(image_control), image_file.c_str());

  AppWidgets widgets = {
      window,
      name_entry,
      GTK_LABEL(result_label),
  };

  GMainLoop *loop = g_main_loop_new(nullptr, FALSE);
  g_signal_connect(GTK_WINDOW(window), "close-request",
                   G_CALLBACK(on_close_request), loop);
  g_signal_connect(GTK_BUTTON(submit_button), "clicked",
                   G_CALLBACK(on_submit_clicked), &widgets);

  TrayItemState *tray_item =
      options.status_notifier_item ? register_status_notifier_item(&widgets)
                                   : nullptr;
  GtkWidget *enumerables_window =
      options.widget_enumerables ? create_enumerables_window(&widgets)
                                 : nullptr;

  gtk_window_present(GTK_WINDOW(window));
  drain_events();
  set_x11_main_window_geometry_hints(window);
  schedule_x11_main_window_geometry_hints(window);
  if (options.widget_controls) {
    gtk_window_present(GTK_WINDOW(controls_window));
  }
  if (enumerables_window != nullptr) {
    gtk_window_present(GTK_WINDOW(enumerables_window));
  }
  drain_events();

  GtkWidget *cover_window =
      options.cover_submit_button ? show_cover_window(window, submit_button)
                                  : nullptr;

  g_main_loop_run(loop);

  release_status_notifier_item(tray_item);
  g_main_loop_unref(loop);
  if (enumerables_window != nullptr) {
    gtk_window_destroy(GTK_WINDOW(enumerables_window));
  }
  if (cover_window != nullptr) {
    gtk_window_destroy(GTK_WINDOW(cover_window));
  }
  gtk_window_destroy(GTK_WINDOW(controls_window));
  gtk_window_destroy(GTK_WINDOW(window));
  g_object_unref(builder);
  return 0;
}
