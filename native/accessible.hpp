// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#ifndef GESTAMENT_ACCESSIBLE_HPP
#define GESTAMENT_ACCESSIBLE_HPP

#include "atspi_client.hpp"

#include <atspi/atspi.h>

#include <string>
#include <vector>

/////////////////////////////////////////////////////////////////////////////////////////

namespace gestament {

/** Screen-relative bounds in physical pixels. */
struct CaptureBounds {
  gint x;
  gint y;
  gint width;
  gint height;
};

/** Captured PNG image and metadata for an accessible's screen area. */
struct CaptureResult {
  std::vector<unsigned char> image;
  CaptureBounds bounds;
  CaptureBounds visible_bounds;
  bool clipped;
};

/** X11 normal-size hints exposed through WM_NORMAL_HINTS. */
struct WindowResizeHints {
  gint base_width;
  gint base_height;
  gint min_width;
  gint min_height;
  gint width_increment;
  gint height_increment;
};

/** X11 metadata for a top-level window. */
struct X11WindowInfo {
  std::string window_id;
  std::string title;
  std::string class_name;
  std::string instance_name;
  WindowResizeHints normal_hints;
};

/** AT-SPI metadata exposed for an accessible element. */
struct AccessibleInfo {
  std::string role_name;
  std::string localized_role_name;
  std::string accessible_id;
  std::string name;
  std::string description;
  std::vector<std::string> interfaces;
  std::vector<std::string> states;
};

/** AT-SPI Value metadata exposed for an accessible element. */
struct AccessibleValueInfo {
  gdouble value;
  gdouble minimum;
  gdouble maximum;
  gdouble minimum_increment;
  std::string text;
};

/** Point in physical pixels. */
struct ImagePoint {
  gint x;
  gint y;
};

/** Image size in physical pixels. */
struct ImageSize {
  gint width;
  gint height;
};

/** AT-SPI Image metadata exposed for an accessible element. */
struct AccessibleImageInfo {
  std::string description;
  std::string locale;
  ImagePoint position;
  ImageSize size;
  CaptureBounds bounds;
};

/** Result of an accessible lookup. The caller owns accessible when non-null. */
struct AccessibleLookupResult {
  AtspiAccessible *accessible;
  NativeError error;
};

/** Finds an accessible by process id and AT-SPI accessible id. */
AccessibleLookupResult find_accessible_by_id(guint process_id,
                                             const std::string &id);

/** Finds an accessible by AT-SPI accessible id across all exposed processes. */
AccessibleLookupResult find_accessible_by_id_any_process(const std::string &id);

/** Finds a top-level window by process id and AT-SPI traversal order. */
AccessibleLookupResult find_window_by_index(guint process_id, gint index);

/** Returns whether an accessible exists for a process id and accessible id. */
bool accessible_exists(guint process_id, const std::string &id,
                       NativeError *error);

/** Counts top-level windows hosted by a process. */
bool count_windows(guint process_id, gint *count, NativeError *error);

/** Validates that an accessible proxy still belongs to a process. */
bool validate_accessible(guint process_id, AtspiAccessible *accessible,
                         NativeError *error);

/** Counts direct children for an accessible proxy. */
bool count_accessible_children(guint process_id, AtspiAccessible *accessible,
                               gint *count, NativeError *error);

/** Gets a direct child for an accessible proxy. */
AccessibleLookupResult get_accessible_child(guint process_id,
                                            AtspiAccessible *accessible,
                                            gint index);

/** Counts selected children for a selectable accessible proxy. */
bool count_selected_accessible_children(guint process_id,
                                        AtspiAccessible *accessible,
                                        gint *count, NativeError *error);

/** Gets a selected child for a selectable accessible proxy. */
AccessibleLookupResult get_selected_accessible_child(
    guint process_id, AtspiAccessible *accessible, gint selected_index);

/** Reads whether a child is selected for a selectable accessible proxy. */
bool is_accessible_child_selected(guint process_id,
                                  AtspiAccessible *accessible, gint index,
                                  bool *selected, NativeError *error);

/** Selects a child for a selectable accessible proxy. */
bool select_accessible_child(guint process_id, AtspiAccessible *accessible,
                             gint index, NativeError *error);

/** Deselects a child for a selectable accessible proxy. */
bool deselect_accessible_child(guint process_id, AtspiAccessible *accessible,
                               gint index, NativeError *error);

/** Selects all children for a selectable accessible proxy. */
bool select_all_accessible_children(guint process_id,
                                    AtspiAccessible *accessible,
                                    NativeError *error);

/** Clears child selection for a selectable accessible proxy. */
bool clear_accessible_selection(guint process_id, AtspiAccessible *accessible,
                                NativeError *error);

/** Counts rows for a table accessible proxy. */
bool count_accessible_table_rows(guint process_id, AtspiAccessible *accessible,
                                 gint *count, NativeError *error);

/** Counts columns for a table accessible proxy. */
bool count_accessible_table_columns(guint process_id,
                                    AtspiAccessible *accessible, gint *count,
                                    NativeError *error);

/** Gets a cell for a table accessible proxy. */
AccessibleLookupResult get_accessible_table_cell(guint process_id,
                                                 AtspiAccessible *accessible,
                                                 gint row, gint column);

/** Reads selected row indexes for a table accessible proxy. */
bool read_accessible_table_selected_rows(guint process_id,
                                         AtspiAccessible *accessible,
                                         std::vector<gint> *rows,
                                         NativeError *error);

/** Reads selected column indexes for a table accessible proxy. */
bool read_accessible_table_selected_columns(guint process_id,
                                            AtspiAccessible *accessible,
                                            std::vector<gint> *columns,
                                            NativeError *error);

/** Reads whether a table row is selected. */
bool is_accessible_table_row_selected(guint process_id,
                                      AtspiAccessible *accessible, gint row,
                                      bool *selected, NativeError *error);

/** Reads whether a table column is selected. */
bool is_accessible_table_column_selected(guint process_id,
                                         AtspiAccessible *accessible,
                                         gint column, bool *selected,
                                         NativeError *error);

/** Reads whether a table cell is selected. */
bool is_accessible_table_cell_selected(guint process_id,
                                       AtspiAccessible *accessible, gint row,
                                       gint column, bool *selected,
                                       NativeError *error);

/** Selects a table row. */
bool select_accessible_table_row(guint process_id, AtspiAccessible *accessible,
                                 gint row, NativeError *error);

/** Deselects a table row. */
bool deselect_accessible_table_row(guint process_id,
                                   AtspiAccessible *accessible, gint row,
                                   NativeError *error);

/** Selects a table column. */
bool select_accessible_table_column(guint process_id,
                                    AtspiAccessible *accessible, gint column,
                                    NativeError *error);

/** Deselects a table column. */
bool deselect_accessible_table_column(guint process_id,
                                      AtspiAccessible *accessible, gint column,
                                      NativeError *error);

/** Sets EditableText contents for an accessible id within a process. */
bool set_accessible_text(guint process_id, const std::string &id,
                         const std::string &text, NativeError *error);

/** Sets EditableText contents for an element within a process. */
bool set_accessible_proxy_text(guint process_id, AtspiAccessible *accessible,
                               const std::string &text, NativeError *error);

/** Executes the primary Action on an accessible id within a process. */
bool click_accessible(guint process_id, const std::string &id,
                      NativeError *error);

/** Executes the primary Action on an element within a process. */
bool click_accessible_proxy(guint process_id, AtspiAccessible *accessible,
                            NativeError *error);

/** Reads Text contents for an accessible id within a process. */
bool read_accessible_text(guint process_id, const std::string &id,
                          std::string *text, NativeError *error);

/** Reads Text contents for an element within a process. */
bool read_accessible_proxy_text(guint process_id, AtspiAccessible *accessible,
                                std::string *text, NativeError *error);

/** Reads Value metadata for an element within a process. */
bool read_accessible_proxy_value_info(guint process_id,
                                      AtspiAccessible *accessible,
                                      AccessibleValueInfo *info,
                                      NativeError *error);

/** Reads Image metadata for an element within a process. */
bool read_accessible_proxy_image_info(guint process_id,
                                      AtspiAccessible *accessible,
                                      AccessibleImageInfo *info,
                                      NativeError *error);

/** Sets Value contents for an element within a process. */
bool set_accessible_proxy_value(guint process_id, AtspiAccessible *accessible,
                                gdouble value, NativeError *error);

/** Captures real screen pixels for an accessible id within a process. */
bool capture_accessible(guint process_id, const std::string &id,
                        CaptureResult *result, NativeError *error);

/** Captures real screen pixels for an element within a process. */
bool capture_accessible_proxy(guint process_id, AtspiAccessible *accessible,
                              CaptureResult *result, NativeError *error);

/** Reads screen-relative bounds for an element within a process. */
bool read_accessible_proxy_bounds(guint process_id, AtspiAccessible *accessible,
                                  CaptureBounds *bounds, NativeError *error);

/** Moves a window element and returns the observed bounds. */
bool move_accessible_proxy_window(guint process_id, AtspiAccessible *accessible,
                                  gint x, gint y, CaptureBounds *bounds,
                                  NativeError *error);

/** Resizes a window element and returns the observed bounds. */
bool resize_accessible_proxy_window(guint process_id,
                                    AtspiAccessible *accessible, gint width,
                                    gint height, CaptureBounds *bounds,
                                    NativeError *error);

/** Moves and resizes a window element and returns the observed bounds. */
bool set_accessible_proxy_window_bounds(guint process_id,
                                        AtspiAccessible *accessible,
                                        const CaptureBounds &requested_bounds,
                                        CaptureBounds *bounds,
                                        NativeError *error);

/** Activates a top-level window element through the current X11 display. */
bool activate_accessible_proxy_window(guint process_id,
                                      AtspiAccessible *accessible,
                                      NativeError *error);

/** Reads X11 normal-size hints for a window element within a process. */
bool read_accessible_proxy_resize_hints(guint process_id,
                                        AtspiAccessible *accessible,
                                        WindowResizeHints *hints,
                                        NativeError *error);

/** Reads X11 metadata for a window element within a process. */
bool read_accessible_proxy_x11_info(guint process_id,
                                    AtspiAccessible *accessible,
                                    X11WindowInfo *info, NativeError *error);

/** Captures the full X11 root window currently addressed by DISPLAY. */
bool capture_screen(CaptureResult *result, NativeError *error);

/** Captures real screen pixels for explicit screen-relative bounds. */
bool capture_screen_bounds(const CaptureBounds &bounds, CaptureResult *result,
                           NativeError *error);

/** Presses or releases a keyboard modifier on the current display. */
bool input_set_modifier(const std::string &modifier, bool pressed,
                        NativeError *error);

/** Sends one press-and-release key by X11 keysym name. */
bool input_press_key_name(const std::string &key, NativeError *error);

/** Sends one press-and-release key by numeric X11 keysym value. */
bool input_press_key_sym(guint keysym, NativeError *error);

/** Moves the mouse pointer to screen-relative coordinates. */
bool input_move_mouse(gint x, gint y, NativeError *error);

/** Presses or releases a mouse button on the current display. */
bool input_set_mouse_button(const std::string &button, bool pressed,
                            NativeError *error);

/** Sends mouse wheel steps on the current display. */
bool input_scroll_wheel(gint x_steps, gint y_steps, NativeError *error);

/** Counts mapped top-level X11 windows on the current DISPLAY. */
bool count_mapped_x11_windows(guint *count, NativeError *error);

/** Reads AT-SPI metadata for an element within a process. */
bool read_accessible_proxy_info(guint process_id, AtspiAccessible *accessible,
                                AccessibleInfo *info, NativeError *error);

}  // namespace gestament

#endif
