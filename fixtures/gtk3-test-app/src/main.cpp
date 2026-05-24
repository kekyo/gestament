// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include <gio/gio.h>
#include <gdk/gdkx.h>
#include <gestament/gtk.h>
#include <gtk/gtk.h>

#include <X11/Xlib.h>
#include <X11/Xutil.h>

#include <filesystem>
#include <iostream>
#include <sstream>
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

void set_result(AppWidgets *widgets, const std::string &text) {
  gtk_label_set_text(widgets->result_label, text.c_str());
}

struct AppOptions {
  bool cover_submit_button;
  bool status_notifier_item;
  bool widget_controls;
  bool widget_enumerables;
  bool widget_standards;
};

AppOptions app_options(int argc, char **argv) {
  AppOptions options = {
      false,
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
    if (argument == "--widget-standards") {
      options.widget_standards = true;
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
        argument == "--widget-enumerables" ||
        argument == "--widget-standards") {
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

void set_main_window_geometry_hints(GtkWidget *window) {
  GdkGeometry geometry = {};
  geometry.base_width = 80;
  geometry.base_height = 40;
  geometry.min_width = 120;
  geometry.min_height = 90;
  geometry.width_inc = 7;
  geometry.height_inc = 11;
  gtk_window_set_geometry_hints(
      GTK_WINDOW(window), window, &geometry,
      static_cast<GdkWindowHints>(GDK_HINT_BASE_SIZE | GDK_HINT_MIN_SIZE |
                                  GDK_HINT_RESIZE_INC));
}

void set_x11_main_window_geometry_hints(GtkWidget *window) {
  GdkWindow *gdk_window = gtk_widget_get_window(window);
  if (gdk_window == nullptr || !GDK_IS_X11_WINDOW(gdk_window)) {
    return;
  }

  Display *display = gdk_x11_display_get_xdisplay(
      gdk_window_get_display(gdk_window));
  Window xid = gdk_x11_window_get_xid(gdk_window);
  XSizeHints hints = {};
  hints.flags = PBaseSize | PMinSize | PResizeInc;
  hints.base_width = 80;
  hints.base_height = 40;
  hints.min_width = 120;
  hints.min_height = 90;
  hints.width_inc = 7;
  hints.height_inc = 11;
  XSetWMNormalHints(display, xid, &hints);
  XFlush(display);
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

gboolean on_input_probe_motion(GtkWidget *, GdkEventMotion *event,
                               gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  std::ostringstream text;
  text << "motion:" << static_cast<int>(event->x) << ","
       << static_cast<int>(event->y);
  set_result(widgets, text.str());
  return FALSE;
}

gboolean on_input_probe_button(GtkWidget *, GdkEventButton *event,
                               gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  std::ostringstream text;
  text << (event->type == GDK_BUTTON_PRESS ? "button-press:"
                                           : "button-release:")
       << event->button;
  set_result(widgets, text.str());
  return FALSE;
}

const char *scroll_direction_name(GdkScrollDirection direction) {
  switch (direction) {
    case GDK_SCROLL_UP:
      return "up";
    case GDK_SCROLL_DOWN:
      return "down";
    case GDK_SCROLL_LEFT:
      return "left";
    case GDK_SCROLL_RIGHT:
      return "right";
    case GDK_SCROLL_SMOOTH:
      return "smooth";
  }
  return "unknown";
}

gboolean on_input_probe_scroll(GtkWidget *, GdkEventScroll *event,
                               gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  set_result(widgets, std::string("scroll:") +
                          scroll_direction_name(event->direction));
  return FALSE;
}

gboolean on_input_probe_key(GtkWidget *, GdkEventKey *event,
                            gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  std::ostringstream text;
  text << "key:" << event->keyval;
  set_result(widgets, text.str());
  return FALSE;
}

gboolean on_window_focus_in(GtkWidget *widget, GdkEventFocus *, gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  const char *name = static_cast<const char *>(
      g_object_get_data(G_OBJECT(widget), "gestament-window-name"));
  set_result(widgets, std::string("window-active:") +
                          (name == nullptr ? "unknown" : name));
  return FALSE;
}

GtkWidget *create_input_probe(AppWidgets *widgets) {
  GtkWidget *probe = gtk_event_box_new();
  assign_widget_id(probe, "input_probe");
  assign_widget_name(probe, "Input probe");
  gtk_widget_set_can_focus(probe, TRUE);
  gtk_widget_set_size_request(probe, 300, 80);
  gtk_widget_add_events(probe, GDK_POINTER_MOTION_MASK |
                                   GDK_BUTTON_PRESS_MASK |
                                   GDK_BUTTON_RELEASE_MASK | GDK_SCROLL_MASK |
                                   GDK_KEY_PRESS_MASK | GDK_FOCUS_CHANGE_MASK);

  GtkWidget *label = gtk_label_new("Input probe");
  gtk_container_add(GTK_CONTAINER(probe), label);

  g_signal_connect(probe, "motion-notify-event",
                   G_CALLBACK(on_input_probe_motion), widgets);
  g_signal_connect(probe, "button-press-event",
                   G_CALLBACK(on_input_probe_button), widgets);
  g_signal_connect(probe, "button-release-event",
                   G_CALLBACK(on_input_probe_button), widgets);
  g_signal_connect(probe, "scroll-event", G_CALLBACK(on_input_probe_scroll),
                   widgets);
  g_signal_connect(probe, "key-press-event", G_CALLBACK(on_input_probe_key),
                   widgets);
  return probe;
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

void on_standard_button_clicked(GtkButton *, gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  set_result(widgets, "toolbar-clicked");
}

gboolean on_standard_link_activate(GtkLinkButton *button, gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  gtk_link_button_set_visited(button, TRUE);
  set_result(widgets, "link-activated");
  return TRUE;
}

void on_standard_calendar_day_selected(GtkCalendar *calendar,
                                       gpointer user_data) {
  auto *widgets = static_cast<AppWidgets *>(user_data);
  guint year = 0;
  guint month = 0;
  guint day = 0;
  gtk_calendar_get_date(calendar, &year, &month, &day);
  std::ostringstream text;
  text << "calendar:" << year << "-" << (month + 1) << "-" << day;
  set_result(widgets, text.str());
}

GtkWidget *create_standard_notebook() {
  GtkWidget *notebook = gtk_notebook_new();
  assign_widget_id(notebook, "standard_notebook");

  GtkWidget *page_a = gtk_label_new("Notebook Page A");
  assign_widget_id(page_a, "standard_notebook_panel_a");
  GtkWidget *tab_a = gtk_label_new("Notebook A");
  gtk_notebook_append_page(GTK_NOTEBOOK(notebook), page_a, tab_a);

  GtkWidget *page_b = gtk_label_new("Notebook Page B");
  assign_widget_id(page_b, "standard_notebook_panel_b");
  GtkWidget *tab_b = gtk_label_new("Notebook B");
  gtk_notebook_append_page(GTK_NOTEBOOK(notebook), page_b, tab_b);

  return notebook;
}

GtkWidget *create_standard_stack_switcher() {
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
  assign_widget_id(box, "standard_stack_box");

  GtkWidget *stack = gtk_stack_new();
  assign_widget_id(stack, "standard_stack");
  GtkWidget *page_a = gtk_label_new("Stack Page A");
  assign_widget_id(page_a, "standard_stack_panel_a");
  GtkWidget *page_b = gtk_label_new("Stack Page B");
  assign_widget_id(page_b, "standard_stack_panel_b");
  gtk_stack_add_titled(GTK_STACK(stack), page_a, "stack-a", "Stack A");
  gtk_stack_add_titled(GTK_STACK(stack), page_b, "stack-b", "Stack B");

  GtkWidget *switcher = gtk_stack_switcher_new();
  assign_widget_id(switcher, "standard_stack_switcher");
  gtk_stack_switcher_set_stack(GTK_STACK_SWITCHER(switcher), GTK_STACK(stack));

  gtk_box_pack_start(GTK_BOX(box), switcher, FALSE, TRUE, 0);
  gtk_box_pack_start(GTK_BOX(box), stack, FALSE, TRUE, 0);
  return box;
}

GtkWidget *create_standard_tree() {
  GtkTreeStore *store = gtk_tree_store_new(1, G_TYPE_STRING);
  GtkTreeIter parent = {};
  gtk_tree_store_append(store, &parent, nullptr);
  gtk_tree_store_set(store, &parent, 0, "Tree A", -1);

  GtkTreeIter child = {};
  gtk_tree_store_append(store, &child, &parent);
  gtk_tree_store_set(store, &child, 0, "Tree A.1", -1);

  GtkTreeIter parent_b = {};
  gtk_tree_store_append(store, &parent_b, nullptr);
  gtk_tree_store_set(store, &parent_b, 0, "Tree B", -1);

  GtkWidget *tree = gtk_tree_view_new_with_model(GTK_TREE_MODEL(store));
  assign_widget_id(tree, "standard_tree");
  gtk_tree_view_set_headers_visible(GTK_TREE_VIEW(tree), FALSE);
  GtkTreeSelection *selection = gtk_tree_view_get_selection(GTK_TREE_VIEW(tree));
  gtk_tree_selection_set_mode(selection, GTK_SELECTION_SINGLE);

  GtkCellRenderer *renderer = gtk_cell_renderer_text_new();
  GtkTreeViewColumn *column =
      gtk_tree_view_column_new_with_attributes("", renderer, "text", 0, nullptr);
  gtk_tree_view_append_column(GTK_TREE_VIEW(tree), column);
  gtk_tree_view_expand_all(GTK_TREE_VIEW(tree));
  gtk_widget_set_size_request(tree, 300, 120);

  g_object_unref(store);
  return tree;
}

GtkWidget *create_standard_widgets_window(AppWidgets *widgets) {
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  assign_widget_id(window, "standards_window");
  gtk_window_set_title(GTK_WINDOW(window), "Gestament GTK3 Standards");
  gtk_window_set_default_size(GTK_WINDOW(window), 520, 760);

  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
  assign_widget_id(box, "standards_box");
  gtk_widget_set_margin_start(box, 16);
  gtk_widget_set_margin_end(box, 16);
  gtk_widget_set_margin_top(box, 16);
  gtk_widget_set_margin_bottom(box, 16);
  gtk_container_add(GTK_CONTAINER(window), box);

  gtk_box_pack_start(GTK_BOX(box), create_standard_notebook(), FALSE, TRUE, 0);
  gtk_box_pack_start(GTK_BOX(box), create_standard_stack_switcher(), FALSE, TRUE,
                     0);

  GtkWidget *expander = gtk_expander_new("More options");
  assign_widget_id(expander, "standard_expander");
  GtkWidget *expander_child = gtk_label_new("Expanded content");
  assign_widget_id(expander_child, "standard_expander_child");
  gtk_container_add(GTK_CONTAINER(expander), expander_child);
  gtk_box_pack_start(GTK_BOX(box), expander, FALSE, TRUE, 0);

  GtkAdjustment *adjustment =
      gtk_adjustment_new(20, 0, 100, 5, 10, 0);
  GtkWidget *scrollbar =
      gtk_scrollbar_new(GTK_ORIENTATION_HORIZONTAL, adjustment);
  assign_widget_id(scrollbar, "standard_scrollbar");
  gtk_widget_set_size_request(scrollbar, 260, 24);
  gtk_box_pack_start(GTK_BOX(box), scrollbar, FALSE, TRUE, 0);

  GtkWidget *link =
      gtk_link_button_new_with_label("https://example.invalid", "Example Link");
  assign_widget_id(link, "standard_link");
  g_signal_connect(link, "activate-link", G_CALLBACK(on_standard_link_activate),
                   widgets);
  gtk_box_pack_start(GTK_BOX(box), link, FALSE, TRUE, 0);

  GtkWidget *separator_area = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  assign_widget_id(separator_area, "standard_separator_area");
  gtk_widget_set_size_request(separator_area, -1, 24);
  GtkWidget *separator = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
  assign_widget_id(separator, "standard_separator");
  gtk_box_pack_start(GTK_BOX(separator_area), separator, TRUE, TRUE, 0);
  gtk_box_pack_start(GTK_BOX(box), separator_area, FALSE, TRUE, 0);

  GtkWidget *calendar = gtk_calendar_new();
  assign_widget_id(calendar, "standard_calendar");
  g_signal_connect(calendar, "day-selected",
                   G_CALLBACK(on_standard_calendar_day_selected), widgets);
  gtk_box_pack_start(GTK_BOX(box), calendar, FALSE, TRUE, 0);

  gtk_box_pack_start(GTK_BOX(box), create_standard_tree(), FALSE, TRUE, 0);

  GtkWidget *toolbar = gtk_toolbar_new();
  assign_widget_id(toolbar, "standard_toolbar");
  GtkToolItem *tool_button = gtk_tool_button_new(nullptr, "Tool");
  assign_widget_id(GTK_WIDGET(tool_button), "standard_toolbar_button");
  g_signal_connect(tool_button, "clicked", G_CALLBACK(on_standard_button_clicked),
                   widgets);
  gtk_toolbar_insert(GTK_TOOLBAR(toolbar), tool_button, -1);
  gtk_box_pack_start(GTK_BOX(box), toolbar, FALSE, TRUE, 0);

  GtkWidget *info_bar = gtk_info_bar_new();
  assign_widget_id(info_bar, "standard_info_bar");
  GtkWidget *info_content = gtk_info_bar_get_content_area(GTK_INFO_BAR(info_bar));
  gtk_container_add(GTK_CONTAINER(info_content), gtk_label_new("Information"));
  gtk_box_pack_start(GTK_BOX(box), info_bar, FALSE, TRUE, 0);

  GtkWidget *status_bar = gtk_statusbar_new();
  assign_widget_id(status_bar, "standard_status_bar");
  gtk_statusbar_push(GTK_STATUSBAR(status_bar), 1, "Ready");
  gtk_box_pack_start(GTK_BOX(box), status_bar, FALSE, TRUE, 0);

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
  GtkWidget *controls_box = required_widget(builder, "controls_box");
  GtkWidget *image_control = required_widget(builder, "image_control");
  if (window == nullptr || name_entry == nullptr || submit_button == nullptr ||
      result_label == nullptr || controls_window == nullptr ||
      controls_box == nullptr || image_control == nullptr) {
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
  g_object_set_data(G_OBJECT(window), "gestament-window-name",
                    const_cast<char *>("main"));
  g_object_set_data(G_OBJECT(controls_window), "gestament-window-name",
                    const_cast<char *>("controls"));
  g_signal_connect(window, "focus-in-event", G_CALLBACK(on_window_focus_in),
                   &widgets);
  g_signal_connect(controls_window, "focus-in-event",
                   G_CALLBACK(on_window_focus_in), &widgets);
  gtk_box_pack_start(GTK_BOX(controls_box), create_input_probe(&widgets),
                     FALSE, TRUE, 0);

  TrayItemState *tray_item =
      options.status_notifier_item ? register_status_notifier_item(&widgets)
                                   : nullptr;
  GtkWidget *enumerables_window =
      options.widget_enumerables ? create_enumerables_window(&widgets)
                                 : nullptr;
  GtkWidget *standards_window =
      options.widget_standards ? create_standard_widgets_window(&widgets)
                               : nullptr;

  set_main_window_geometry_hints(window);
  gtk_widget_show_all(window);
  if (options.widget_controls) {
    gtk_widget_show_all(controls_window);
  }
  if (enumerables_window != nullptr) {
    gtk_widget_show_all(enumerables_window);
  }
  if (standards_window != nullptr) {
    gtk_widget_show_all(standards_window);
  }
  while (gtk_events_pending()) {
    gtk_main_iteration();
  }
  set_x11_main_window_geometry_hints(window);
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
