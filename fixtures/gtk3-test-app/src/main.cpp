// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include <gio/gio.h>
#include <gestament/gtk.h>
#include <gtk/gtk.h>

#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace {

// README-style test application flow.
struct AppWidgets {
  GtkWidget *window;
  GtkEntry *name_entry;
  GtkLabel *result_label;
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
  const gchar *entry_text = gtk_entry_get_text(widgets->name_entry);
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
  AtkObject *accessible = gtk_widget_get_accessible(widget);
  if (accessible != nullptr) {
    atk_object_set_name(accessible, name);
  }
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
  gtk_container_add(GTK_CONTAINER(row), label);
  return row;
}

void on_enumerable_menu_item_activate(GtkMenuItem *item, gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  const char *value =
      static_cast<const char *>(g_object_get_data(G_OBJECT(item), "value"));
  gtk_label_set_text(widgets->result_label, value == nullptr ? "" : value);
}

GtkWidget *create_enumerable_menu(AppWidgets *widgets) {
  GtkWidget *menu = gtk_menu_bar_new();
  assign_widget_id(menu, "enumerable_menu");

  const char *labels[] = {"Menu A", "Menu B", "Menu C"};
  const char *ids[] = {"enumerable_menu_item_0", "enumerable_menu_item_1",
                       "enumerable_menu_item_2"};
  const char *values[] = {"menu-0", "menu-1", "menu-2"};
  for (int index = 0; index < 3; index += 1) {
    GtkWidget *item = gtk_menu_item_new_with_label(labels[index]);
    assign_widget_id(item, ids[index]);
    g_object_set_data(G_OBJECT(item), "value",
                      const_cast<char *>(values[index]));
    g_signal_connect(GTK_MENU_ITEM(item), "activate",
                     G_CALLBACK(on_enumerable_menu_item_activate), widgets);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), item);
  }

  return menu;
}

GtkWidget *create_enumerable_table() {
  GtkListStore *store =
      gtk_list_store_new(3, G_TYPE_STRING, G_TYPE_STRING, G_TYPE_STRING);
  const char *rows[][3] = {
      {"R0C0", "R0C1", "R0C2"},
      {"R1C0", "R1C1", "R1C2"},
  };
  for (int row = 0; row < 2; row += 1) {
    GtkTreeIter iter = {};
    gtk_list_store_append(store, &iter);
    gtk_list_store_set(store, &iter, 0, rows[row][0], 1, rows[row][1], 2,
                       rows[row][2], -1);
  }

  GtkWidget *table = gtk_tree_view_new_with_model(GTK_TREE_MODEL(store));
  assign_widget_id(table, "enumerable_table");
  gtk_tree_view_set_headers_visible(GTK_TREE_VIEW(table), FALSE);
  GtkTreeSelection *selection = gtk_tree_view_get_selection(GTK_TREE_VIEW(table));
  gtk_tree_selection_set_mode(selection, GTK_SELECTION_MULTIPLE);

  for (int column = 0; column < 3; column += 1) {
    GtkCellRenderer *renderer = gtk_cell_renderer_text_new();
    GtkTreeViewColumn *view_column = gtk_tree_view_column_new_with_attributes(
        "", renderer, "text", column, nullptr);
    gtk_tree_view_append_column(GTK_TREE_VIEW(table), view_column);
  }

  gtk_widget_set_size_request(table, 300, 120);
  g_object_unref(store);
  return table;
}

GtkWidget *create_enumerables_window(AppWidgets *widgets) {
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  assign_widget_id(window, "enumerables_window");
  gtk_window_set_title(GTK_WINDOW(window), "Gestament GTK3 Enumerables");
  gtk_window_set_default_size(GTK_WINDOW(window), 420, 520);

  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
  assign_widget_id(box, "enumerables_box");
  gtk_widget_set_margin_start(box, 16);
  gtk_widget_set_margin_end(box, 16);
  gtk_widget_set_margin_top(box, 16);
  gtk_widget_set_margin_bottom(box, 16);
  gtk_container_add(GTK_CONTAINER(window), box);

  GtkWidget *combo = gtk_combo_box_text_new();
  assign_widget_id(combo, "enumerable_combo");
  gtk_combo_box_text_append(GTK_COMBO_BOX_TEXT(combo), "combo-0", "Combo A");
  gtk_combo_box_text_append(GTK_COMBO_BOX_TEXT(combo), "combo-1", "Combo B");
  gtk_combo_box_text_append(GTK_COMBO_BOX_TEXT(combo), "combo-2", "Combo C");
  gtk_combo_box_set_active(GTK_COMBO_BOX(combo), 0);
  gtk_box_pack_start(GTK_BOX(box), combo, FALSE, TRUE, 0);

  GtkWidget *list = gtk_list_box_new();
  assign_widget_id(list, "enumerable_list");
  gtk_list_box_set_selection_mode(GTK_LIST_BOX(list), GTK_SELECTION_MULTIPLE);
  gtk_container_add(GTK_CONTAINER(list),
                    labelled_list_row("enumerable_list_item_0", "List A"));
  gtk_container_add(GTK_CONTAINER(list),
                    labelled_list_row("enumerable_list_item_1", "List B"));
  gtk_container_add(GTK_CONTAINER(list),
                    labelled_list_row("enumerable_list_item_2", "List C"));
  gtk_box_pack_start(GTK_BOX(box), list, FALSE, TRUE, 0);

  gtk_box_pack_start(GTK_BOX(box), create_enumerable_menu(widgets), FALSE, TRUE,
                     0);
  gtk_box_pack_start(GTK_BOX(box), create_enumerable_table(), FALSE, TRUE, 0);
  return window;
}

void show_cover_window(GtkWidget *main_window, GtkWidget *target) {
  GtkAllocation allocation = {};
  gtk_widget_get_allocation(target, &allocation);

  gint window_x = 0;
  gint window_y = 0;
  GdkWindow *gdk_window = gtk_widget_get_window(main_window);
  if (gdk_window != nullptr) {
    gdk_window_get_origin(gdk_window, &window_x, &window_y);
  }

  gint target_x = 0;
  gint target_y = 0;
  gtk_widget_translate_coordinates(target, main_window, 0, 0, &target_x,
                                   &target_y);

  GtkWidget *cover_window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  assign_widget_id(cover_window, "cover_window");
  gtk_window_set_title(GTK_WINDOW(cover_window), "Cover Window");
  gtk_window_set_decorated(GTK_WINDOW(cover_window), FALSE);
  gtk_window_set_keep_above(GTK_WINDOW(cover_window), TRUE);
  gtk_window_set_accept_focus(GTK_WINDOW(cover_window), FALSE);
  gtk_widget_set_size_request(cover_window, allocation.width,
                              allocation.height);

  GtkWidget *label = gtk_label_new("Covered");
  gtk_container_add(GTK_CONTAINER(cover_window), label);

  gtk_window_move(GTK_WINDOW(cover_window), window_x + target_x,
                  window_y + target_y);
  gtk_widget_show_all(cover_window);
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

}  // namespace

int main(int argc, char **argv) {
  const AppOptions options = app_options(argc, argv);
  std::vector<char *> gtk_argv = filtered_arguments(argc, argv);
  int gtk_argc = static_cast<int>(gtk_argv.size()) - 1;
  char **gtk_argv_data = gtk_argv.data();

  gtk_init(&gtk_argc, &gtk_argv_data);

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
      GTK_ENTRY(name_entry),
      GTK_LABEL(result_label),
  };

  g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), nullptr);
  g_signal_connect(GTK_BUTTON(submit_button), "clicked",
                   G_CALLBACK(on_submit_clicked), &widgets);

  TrayItemState *tray_item =
      options.status_notifier_item ? register_status_notifier_item(&widgets)
                                   : nullptr;
  GtkWidget *enumerables_window =
      options.widget_enumerables ? create_enumerables_window(&widgets)
                                 : nullptr;

  gtk_widget_show_all(window);
  if (options.widget_controls) {
    gtk_widget_show_all(controls_window);
  }
  if (enumerables_window != nullptr) {
    gtk_widget_show_all(enumerables_window);
  }
  while (gtk_events_pending()) {
    gtk_main_iteration();
  }
  if (options.cover_submit_button) {
    show_cover_window(window, submit_button);
    while (gtk_events_pending()) {
      gtk_main_iteration();
    }
  }
  gtk_main();

  release_status_notifier_item(tray_item);
  g_object_unref(builder);
  return 0;
}
