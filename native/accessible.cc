// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include "accessible.hpp"

#include <gdk-pixbuf/gdk-pixbuf.h>
#include <glib-object.h>
#include <X11/keysym.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/Xutil.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <vector>

/////////////////////////////////////////////////////////////////////////////////////////

namespace gestament {

namespace {

constexpr guint kMaxVisitedNodes = 10000;
constexpr gint64 kStateChangeTimeoutUsec = 5000000;
constexpr gulong kStateChangePollUsec = 50000;

bool is_window_role(AtspiAccessible *accessible);

const char *state_type_name(AtspiStateType state) {
  switch (state) {
    case ATSPI_STATE_INVALID:
      return "invalid";
    case ATSPI_STATE_ACTIVE:
      return "active";
    case ATSPI_STATE_ARMED:
      return "armed";
    case ATSPI_STATE_BUSY:
      return "busy";
    case ATSPI_STATE_CHECKED:
      return "checked";
    case ATSPI_STATE_COLLAPSED:
      return "collapsed";
    case ATSPI_STATE_DEFUNCT:
      return "defunct";
    case ATSPI_STATE_EDITABLE:
      return "editable";
    case ATSPI_STATE_ENABLED:
      return "enabled";
    case ATSPI_STATE_EXPANDABLE:
      return "expandable";
    case ATSPI_STATE_EXPANDED:
      return "expanded";
    case ATSPI_STATE_FOCUSABLE:
      return "focusable";
    case ATSPI_STATE_FOCUSED:
      return "focused";
    case ATSPI_STATE_HAS_TOOLTIP:
      return "hasTooltip";
    case ATSPI_STATE_HORIZONTAL:
      return "horizontal";
    case ATSPI_STATE_ICONIFIED:
      return "iconified";
    case ATSPI_STATE_MODAL:
      return "modal";
    case ATSPI_STATE_MULTI_LINE:
      return "multiLine";
    case ATSPI_STATE_MULTISELECTABLE:
      return "multiselectable";
    case ATSPI_STATE_OPAQUE:
      return "opaque";
    case ATSPI_STATE_PRESSED:
      return "pressed";
    case ATSPI_STATE_RESIZABLE:
      return "resizable";
    case ATSPI_STATE_SELECTABLE:
      return "selectable";
    case ATSPI_STATE_SELECTED:
      return "selected";
    case ATSPI_STATE_SENSITIVE:
      return "sensitive";
    case ATSPI_STATE_SHOWING:
      return "showing";
    case ATSPI_STATE_SINGLE_LINE:
      return "singleLine";
    case ATSPI_STATE_STALE:
      return "stale";
    case ATSPI_STATE_TRANSIENT:
      return "transient";
    case ATSPI_STATE_VERTICAL:
      return "vertical";
    case ATSPI_STATE_VISIBLE:
      return "visible";
    case ATSPI_STATE_MANAGES_DESCENDANTS:
      return "managesDescendants";
    case ATSPI_STATE_INDETERMINATE:
      return "indeterminate";
    case ATSPI_STATE_REQUIRED:
      return "required";
    case ATSPI_STATE_TRUNCATED:
      return "truncated";
    case ATSPI_STATE_ANIMATED:
      return "animated";
    case ATSPI_STATE_INVALID_ENTRY:
      return "invalidEntry";
    case ATSPI_STATE_SUPPORTS_AUTOCOMPLETION:
      return "supportsAutocompletion";
    case ATSPI_STATE_SELECTABLE_TEXT:
      return "selectableText";
    case ATSPI_STATE_IS_DEFAULT:
      return "isDefault";
    case ATSPI_STATE_VISITED:
      return "visited";
    case ATSPI_STATE_CHECKABLE:
      return "checkable";
    case ATSPI_STATE_HAS_POPUP:
      return "hasPopup";
    case ATSPI_STATE_READ_ONLY:
      return "readOnly";
    case ATSPI_STATE_LAST_DEFINED:
      break;
  }

  return "unknown";
}

std::string take_gerror_message(GError **error, const std::string &fallback) {
  if (error == nullptr || *error == nullptr) {
    return fallback;
  }

  std::string message = (*error)->message;
  g_clear_error(error);
  return message;
}

bool read_checked_or_pressed_state(AtspiAccessible *accessible, bool *checked) {
  if (checked == nullptr) {
    return false;
  }

  AtspiStateSet *state_set = atspi_accessible_get_state_set(accessible);
  if (state_set == nullptr) {
    return false;
  }

  *checked = atspi_state_set_contains(state_set, ATSPI_STATE_CHECKED) ||
             atspi_state_set_contains(state_set, ATSPI_STATE_PRESSED);
  g_object_unref(state_set);
  return true;
}

bool wait_checked_or_pressed_state_change(AtspiAccessible *accessible,
                                          bool initial_checked) {
  const gint64 deadline = g_get_monotonic_time() + kStateChangeTimeoutUsec;

  do {
    bool checked = false;
    if (read_checked_or_pressed_state(accessible, &checked) &&
        checked != initial_checked) {
      return true;
    }
    g_usleep(kStateChangePollUsec);
  } while (g_get_monotonic_time() < deadline);

  return false;
}

bool role_uses_checked_or_pressed_state(AtspiRole role) {
  return role == ATSPI_ROLE_CHECK_BOX || role == ATSPI_ROLE_CHECK_MENU_ITEM ||
         role == ATSPI_ROLE_RADIO_BUTTON ||
         role == ATSPI_ROLE_RADIO_MENU_ITEM ||
         role == ATSPI_ROLE_TOGGLE_BUTTON;
}

bool role_prefers_component_activation(AtspiRole role) {
  return role == ATSPI_ROLE_CHECK_BOX || role == ATSPI_ROLE_CHECK_MENU_ITEM;
}

bool role_prefers_leading_activation_point(AtspiRole role) {
  return role == ATSPI_ROLE_CHECK_BOX || role == ATSPI_ROLE_CHECK_MENU_ITEM ||
         role == ATSPI_ROLE_RADIO_BUTTON ||
         role == ATSPI_ROLE_RADIO_MENU_ITEM;
}

void unref_accessible_queue(std::deque<AtspiAccessible *> *queue) {
  while (!queue->empty()) {
    AtspiAccessible *accessible = queue->front();
    queue->pop_front();
    if (accessible != nullptr) {
      g_object_unref(accessible);
    }
  }
}

bool accessible_matches(AtspiAccessible *accessible, guint process_id,
                        const std::string &id) {
  GError *error = nullptr;
  const guint accessible_process_id =
      atspi_accessible_get_process_id(accessible, &error);
  if (error != nullptr) {
    g_clear_error(&error);
    return false;
  }

  if (accessible_process_id != process_id) {
    return false;
  }

  gchar *accessible_id =
      atspi_accessible_get_accessible_id(accessible, &error);
  if (error != nullptr) {
    g_clear_error(&error);
    return false;
  }

  const bool matches = accessible_id != nullptr && id == accessible_id;
  g_free(accessible_id);
  return matches;
}

bool accessible_matches_id(AtspiAccessible *accessible, const std::string &id) {
  GError *error = nullptr;
  gchar *accessible_id =
      atspi_accessible_get_accessible_id(accessible, &error);
  if (error != nullptr) {
    g_clear_error(&error);
    return false;
  }

  const bool matches = accessible_id != nullptr && id == accessible_id;
  g_free(accessible_id);
  return matches;
}

CaptureBounds intersect_bounds(const CaptureBounds &first,
                               const CaptureBounds &second) {
  const gint left = std::max(first.x, second.x);
  const gint top = std::max(first.y, second.y);
  const gint right = std::min(first.x + first.width, second.x + second.width);
  const gint bottom =
      std::min(first.y + first.height, second.y + second.height);

  return {
      left,
      top,
      std::max<gint>(0, right - left),
      std::max<gint>(0, bottom - top),
  };
}

bool same_bounds(const CaptureBounds &first, const CaptureBounds &second) {
  return first.x == second.x && first.y == second.y &&
         first.width == second.width && first.height == second.height;
}

bool read_component_bounds(AtspiAccessible *accessible,
                           AtspiCoordType coordinate_type,
                           const std::string &context,
                           NativeErrorCode error_code, CaptureBounds *bounds,
                           NativeError *error) {
  if (bounds == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Component bounds result must not be null.",
      };
    }
    return false;
  }

  AtspiComponent *component = atspi_accessible_get_component_iface(accessible);
  if (component == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible does not support Component" + context + ".",
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  AtspiRect *extents =
      atspi_component_get_extents(component, coordinate_type, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          error_code,
          take_gerror_message(&gerror, "Failed to read component extents."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (extents == nullptr) {
    if (error != nullptr) {
      *error = {
          error_code,
          "AT-SPI Component returned no extents" + context + ".",
      };
    }
    return false;
  }

  *bounds = {
      extents->x,
      extents->y,
      extents->width,
      extents->height,
  };
  g_free(extents);
  return true;
}

bool resolve_component_screen_bounds(AtspiAccessible *accessible,
                                     const std::string &context,
                                     NativeErrorCode error_code,
                                     CaptureBounds *bounds,
                                     NativeError *error) {
  CaptureBounds screen_bounds = {};
  if (!read_component_bounds(accessible, ATSPI_COORD_TYPE_SCREEN, context,
                             error_code, &screen_bounds, error)) {
    return false;
  }

  if (is_window_role(accessible) || screen_bounds.x != 0 ||
      screen_bounds.y != 0) {
    *bounds = screen_bounds;
    return true;
  }

  // GTK4 can report child screen extents at 0,0 while parent-relative extents
  // are correct. Reconstruct screen coordinates from the parent chain.
  CaptureBounds resolved_bounds = {};
  if (!read_component_bounds(accessible, ATSPI_COORD_TYPE_PARENT, context,
                             error_code, &resolved_bounds, nullptr)) {
    *bounds = screen_bounds;
    return true;
  }

  GError *parent_error = nullptr;
  AtspiAccessible *parent =
      atspi_accessible_get_parent(accessible, &parent_error);
  if (parent_error != nullptr) {
    g_clear_error(&parent_error);
    *bounds = screen_bounds;
    return true;
  }

  while (parent != nullptr) {
    if (is_window_role(parent)) {
      CaptureBounds window_bounds = {};
      if (read_component_bounds(parent, ATSPI_COORD_TYPE_SCREEN, context,
                                error_code, &window_bounds, nullptr)) {
        resolved_bounds.x += window_bounds.x;
        resolved_bounds.y += window_bounds.y;
      }
      g_object_unref(parent);
      *bounds = resolved_bounds;
      return true;
    }

    CaptureBounds parent_bounds = {};
    if (read_component_bounds(parent, ATSPI_COORD_TYPE_PARENT, context,
                              error_code, &parent_bounds, nullptr)) {
      resolved_bounds.x += parent_bounds.x;
      resolved_bounds.y += parent_bounds.y;
    }

    parent_error = nullptr;
    AtspiAccessible *next_parent =
        atspi_accessible_get_parent(parent, &parent_error);
    g_object_unref(parent);
    if (parent_error != nullptr) {
      g_clear_error(&parent_error);
      break;
    }
    parent = next_parent;
  }

  *bounds = resolved_bounds;
  return true;
}

guchar channel_from_pixel(unsigned long pixel, unsigned long mask) {
  if (mask == 0) {
    return 0;
  }

  unsigned int shift = 0;
  while (((mask >> shift) & 1UL) == 0UL) {
    shift += 1;
  }

  unsigned int bits = 0;
  while (((mask >> (shift + bits)) & 1UL) == 1UL) {
    bits += 1;
  }

  const unsigned long value = (pixel & mask) >> shift;
  const unsigned long max_value = (1UL << bits) - 1UL;
  return static_cast<guchar>((value * 255UL) / max_value);
}

int destroy_ximage(XImage *image) {
  return XDestroyImage(image);
}

#if GESTAMENT_GTK_BACKEND_GTK4
enum class X11ProcessMatch {
  unknown,
  matches,
  mismatches,
};

std::string read_x11_text_property(Display *display, Window window, Atom atom) {
  if (atom == None) {
    return "";
  }

  Atom actual_type = None;
  int actual_format = 0;
  unsigned long item_count = 0;
  unsigned long bytes_after = 0;
  unsigned char *data = nullptr;
  const int status =
      XGetWindowProperty(display, window, atom, 0, 1024, False,
                         AnyPropertyType, &actual_type, &actual_format,
                         &item_count, &bytes_after, &data);
  if (status != Success || data == nullptr) {
    return "";
  }

  std::string value;
  if (actual_format == 8 && item_count > 0) {
    value.assign(reinterpret_cast<char *>(data),
                 reinterpret_cast<char *>(data) + item_count);
  }
  XFree(data);
  return value;
}

std::string read_x11_window_title(Display *display, Window window) {
  const Atom net_wm_name = XInternAtom(display, "_NET_WM_NAME", True);
  const std::string net_name =
      read_x11_text_property(display, window, net_wm_name);
  if (!net_name.empty()) {
    return net_name;
  }

  char *name = nullptr;
  if (XFetchName(display, window, &name) == 0 || name == nullptr) {
    return "";
  }

  std::string value = name;
  XFree(name);
  return value;
}

X11ProcessMatch x11_window_process_match(Display *display, Window window,
                                         guint process_id) {
  const Atom pid_atom = XInternAtom(display, "_NET_WM_PID", True);
  if (pid_atom == None) {
    return X11ProcessMatch::unknown;
  }

  Atom actual_type = None;
  int actual_format = 0;
  unsigned long item_count = 0;
  unsigned long bytes_after = 0;
  unsigned char *data = nullptr;
  const int status =
      XGetWindowProperty(display, window, pid_atom, 0, 1, False,
                         AnyPropertyType, &actual_type, &actual_format,
                         &item_count, &bytes_after, &data);
  if (status != Success || data == nullptr) {
    return X11ProcessMatch::unknown;
  }

  X11ProcessMatch process_match = X11ProcessMatch::unknown;
  if (actual_format == 32 && item_count >= 1) {
    const auto *values = reinterpret_cast<unsigned long *>(data);
    process_match = values[0] == static_cast<unsigned long>(process_id)
                        ? X11ProcessMatch::matches
                        : X11ProcessMatch::mismatches;
  }
  XFree(data);
  return process_match;
}

bool read_x11_window_bounds(Display *display, Window root, Window window,
                            CaptureBounds *bounds) {
  XWindowAttributes attributes = {};
  if (XGetWindowAttributes(display, window, &attributes) == 0 ||
      attributes.map_state != IsViewable || attributes.width <= 0 ||
      attributes.height <= 0) {
    return false;
  }

  Window child = 0;
  int root_x = 0;
  int root_y = 0;
  if (XTranslateCoordinates(display, window, root, 0, 0, &root_x, &root_y,
                            &child) == 0) {
    return false;
  }

  *bounds = {
      root_x,
      root_y,
      attributes.width,
      attributes.height,
  };
  return true;
}

bool find_x11_window_bounds_by_title(Display *display, Window root,
                                     Window window, guint process_id,
                                     const std::string &title,
                                     CaptureBounds *bounds) {
  Window root_return = 0;
  Window parent_return = 0;
  Window *children = nullptr;
  unsigned int child_count = 0;
  if (XQueryTree(display, window, &root_return, &parent_return, &children,
                 &child_count) != 0) {
    for (int index = static_cast<int>(child_count) - 1; index >= 0;
         index -= 1) {
      if (find_x11_window_bounds_by_title(display, root, children[index],
                                          process_id, title, bounds)) {
        XFree(children);
        return true;
      }
    }
    if (children != nullptr) {
      XFree(children);
    }
  }

  if (x11_window_process_match(display, window, process_id) ==
          X11ProcessMatch::mismatches ||
      read_x11_window_title(display, window) != title) {
    return false;
  }
  return read_x11_window_bounds(display, root, window, bounds);
}

bool find_x11_window_bounds_by_origin(Display *display, Window root,
                                      Window window, guint process_id,
                                      const CaptureBounds &component_bounds,
                                      CaptureBounds *bounds) {
  Window root_return = 0;
  Window parent_return = 0;
  Window *children = nullptr;
  unsigned int child_count = 0;
  if (XQueryTree(display, window, &root_return, &parent_return, &children,
                 &child_count) != 0) {
    for (int index = static_cast<int>(child_count) - 1; index >= 0;
         index -= 1) {
      if (find_x11_window_bounds_by_origin(display, root, children[index],
                                           process_id, component_bounds,
                                           bounds)) {
        XFree(children);
        return true;
      }
    }
    if (children != nullptr) {
      XFree(children);
    }
  }

  if (window == root ||
      x11_window_process_match(display, window, process_id) ==
          X11ProcessMatch::mismatches) {
    return false;
  }

  CaptureBounds candidate_bounds = {};
  if (!read_x11_window_bounds(display, root, window, &candidate_bounds)) {
    return false;
  }
  if (candidate_bounds.x != component_bounds.x ||
      candidate_bounds.y != component_bounds.y ||
      candidate_bounds.width < component_bounds.width ||
      candidate_bounds.height < component_bounds.height ||
      candidate_bounds.width - component_bounds.width > 256 ||
      candidate_bounds.height - component_bounds.height > 256) {
    return false;
  }

  *bounds = candidate_bounds;
  return true;
}

bool resolve_x11_toplevel_window_bounds(guint process_id,
                                        AtspiAccessible *accessible,
                                        const CaptureBounds &component_bounds,
                                        CaptureBounds *bounds) {
  GError *gerror = nullptr;
  gchar *name = atspi_accessible_get_name(accessible, &gerror);
  if (gerror != nullptr) {
    g_clear_error(&gerror);
    return false;
  }
  const std::string title = name == nullptr ? "" : name;
  g_free(name);
  if (title.empty()) {
    return false;
  }

  std::unique_ptr<Display, decltype(&XCloseDisplay)> display(
      XOpenDisplay(nullptr), XCloseDisplay);
  if (display == nullptr) {
    return false;
  }

  Window root = DefaultRootWindow(display.get());
  if (find_x11_window_bounds_by_title(display.get(), root, root, process_id,
                                      title, bounds)) {
    return true;
  }

  return find_x11_window_bounds_by_origin(display.get(), root, root, process_id,
                                          component_bounds, bounds);
}
#endif

bool resolve_capture_screen_bounds(guint process_id,
                                   AtspiAccessible *accessible,
                                   const std::string &context,
                                   NativeErrorCode error_code,
                                   CaptureBounds *bounds,
                                   NativeError *error) {
  CaptureBounds component_bounds = {};
  if (!resolve_component_screen_bounds(accessible, context, error_code,
                                       &component_bounds, error)) {
    return false;
  }

#if GESTAMENT_GTK_BACKEND_GTK4
  if (is_window_role(accessible)) {
    CaptureBounds x11_bounds = {};
    if (resolve_x11_toplevel_window_bounds(process_id, accessible,
                                           component_bounds,
                                           &x11_bounds)) {
      *bounds = x11_bounds;
      return true;
    }
  }
#else
  (void)process_id;
#endif

  *bounds = component_bounds;
  return true;
}

bool capture_root_window_pixels(const CaptureBounds &bounds,
                                const std::string &context,
                                NativeErrorCode bounds_error_code,
                                CaptureResult *result, NativeError *error) {
  if (bounds.width <= 0 || bounds.height <= 0) {
    if (error != nullptr) {
      *error = {
          bounds_error_code,
          "Capture bounds are empty" + context,
      };
    }
    return false;
  }

  std::unique_ptr<Display, decltype(&XCloseDisplay)> display(
      XOpenDisplay(nullptr), XCloseDisplay);
  if (display == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to open the X11 display. Ensure DISPLAY points to an X11 "
          "display.",
      };
    }
    return false;
  }

  Window root_window = DefaultRootWindow(display.get());
  XWindowAttributes root_attributes = {};
  if (XGetWindowAttributes(display.get(), root_window, &root_attributes) == 0) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to get X11 root window attributes.",
      };
    }
    return false;
  }

  const CaptureBounds screen_bounds = {
      0,
      0,
      root_attributes.width,
      root_attributes.height,
  };
  const CaptureBounds visible_bounds = intersect_bounds(bounds, screen_bounds);
  if (visible_bounds.width <= 0 || visible_bounds.height <= 0) {
    if (error != nullptr) {
      *error = {
          bounds_error_code,
          "Capture bounds are outside the root window" + context,
      };
    }
    return false;
  }

  std::unique_ptr<XImage, decltype(&destroy_ximage)> image(
      XGetImage(display.get(), root_window, visible_bounds.x, visible_bounds.y,
                static_cast<unsigned int>(visible_bounds.width),
                static_cast<unsigned int>(visible_bounds.height), AllPlanes,
                ZPixmap),
      destroy_ximage);
  if (image == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to capture pixels from the X11 root window" + context,
      };
    }
    return false;
  }

  const gint row_stride = visible_bounds.width * 3;
  std::vector<guchar> pixels(
      static_cast<std::size_t>(row_stride) *
      static_cast<std::size_t>(visible_bounds.height));
  for (gint y = 0; y < visible_bounds.height; y += 1) {
    for (gint x = 0; x < visible_bounds.width; x += 1) {
      const unsigned long pixel = XGetPixel(image.get(), x, y);
      const std::size_t offset =
          static_cast<std::size_t>(y * row_stride + x * 3);
      pixels[offset] = channel_from_pixel(pixel, image->red_mask);
      pixels[offset + 1] = channel_from_pixel(pixel, image->green_mask);
      pixels[offset + 2] = channel_from_pixel(pixel, image->blue_mask);
    }
  }

  GdkPixbuf *pixbuf = gdk_pixbuf_new_from_data(
      pixels.data(), GDK_COLORSPACE_RGB, FALSE, 8, visible_bounds.width,
      visible_bounds.height, row_stride, nullptr, nullptr);
  if (pixbuf == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to create a pixbuf for captured pixels" + context,
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  gchar *png_buffer = nullptr;
  gsize png_buffer_size = 0;
  const gboolean saved = gdk_pixbuf_save_to_buffer(
      pixbuf, &png_buffer, &png_buffer_size, "png", &gerror,
      static_cast<const char *>(nullptr));
  g_object_unref(pixbuf);

  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to encode captured pixels."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!saved || png_buffer == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "GdkPixbuf did not return encoded capture data" + context,
      };
    }
    return false;
  }

  result->image.assign(
      reinterpret_cast<unsigned char *>(png_buffer),
      reinterpret_cast<unsigned char *>(png_buffer) + png_buffer_size);
  result->bounds = bounds;
  result->visible_bounds = visible_bounds;
  result->clipped = !same_bounds(bounds, visible_bounds);
  g_free(png_buffer);
  return true;
}

bool click_component_center(AtspiAccessible *accessible,
                            const std::string &context, NativeError *error) {
  CaptureBounds bounds = {};
  if (!resolve_component_screen_bounds(accessible, context,
                                       NativeErrorCode::stale_element, &bounds,
                                       error)) {
    return false;
  }

  if (bounds.width <= 0 || bounds.height <= 0) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Accessible component bounds are empty" + context + ".",
      };
    }
    return false;
  }

  AtspiComponent *component = atspi_accessible_get_component_iface(accessible);
  if (component == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible element does not support Action or Component" + context +
              ".",
      };
    }
    return false;
  }

  GError *focus_error = nullptr;
  atspi_component_grab_focus(component, &focus_error);
  if (focus_error != nullptr) {
    g_clear_error(&focus_error);
  }

  bool initial_checked = false;
  bool has_initial_checked = false;
  bool use_leading_activation_point = false;
  GError *role_error = nullptr;
  const AtspiRole role = atspi_accessible_get_role(accessible, &role_error);
  if (role_error != nullptr) {
    g_clear_error(&role_error);
  } else {
    use_leading_activation_point = role_prefers_leading_activation_point(role);
    has_initial_checked =
        role_uses_checked_or_pressed_state(role) &&
        read_checked_or_pressed_state(accessible, &initial_checked);
  }

  const gint x =
      bounds.x +
      (use_leading_activation_point
           ? std::min<gint>(std::max<gint>(bounds.width - 1, 0), 12)
           : bounds.width / 2);
  const gint y = bounds.y + bounds.height / 2;

  if (has_initial_checked) {
    std::unique_ptr<Display, decltype(&XCloseDisplay)> keyboard_display(
        XOpenDisplay(nullptr), XCloseDisplay);
    if (keyboard_display != nullptr) {
      int event_base = 0;
      int error_base = 0;
      int major_version = 0;
      int minor_version = 0;
      const KeyCode space_key =
          XKeysymToKeycode(keyboard_display.get(), XK_space);
      if (space_key != 0 &&
          XTestQueryExtension(keyboard_display.get(), &event_base, &error_base,
                              &major_version, &minor_version)) {
        const bool pressed =
            XTestFakeKeyEvent(keyboard_display.get(), space_key, True,
                              CurrentTime) != 0;
        const bool released =
            XTestFakeKeyEvent(keyboard_display.get(), space_key, False,
                              CurrentTime) != 0;
        XSync(keyboard_display.get(), False);
        if (pressed && released &&
            wait_checked_or_pressed_state_change(accessible, initial_checked)) {
          return true;
        }
      }
    }
  }

  GError *mouse_error = nullptr;
  const gboolean generated =
      atspi_generate_mouse_event(x, y, "b1c", &mouse_error);
  if (mouse_error == nullptr && generated) {
    if (!has_initial_checked ||
        wait_checked_or_pressed_state_change(accessible, initial_checked)) {
      return true;
    }
  }
  if (mouse_error != nullptr) {
    g_clear_error(&mouse_error);
  }

  std::unique_ptr<Display, decltype(&XCloseDisplay)> display(
      XOpenDisplay(nullptr), XCloseDisplay);
  if (display == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to open the X11 display for component click" + context + ".",
      };
    }
    return false;
  }

  int event_base = 0;
  int error_base = 0;
  int major_version = 0;
  int minor_version = 0;
  if (!XTestQueryExtension(display.get(), &event_base, &error_base,
                           &major_version, &minor_version)) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "XTest extension is not available for component click" + context +
              ".",
      };
    }
    return false;
  }

  const int screen = DefaultScreen(display.get());
  const bool moved =
      XTestFakeMotionEvent(display.get(), screen, x, y, CurrentTime) != 0;
  const bool pressed =
      XTestFakeButtonEvent(display.get(), Button1, True, CurrentTime) != 0;
  const bool released =
      XTestFakeButtonEvent(display.get(), Button1, False, CurrentTime) != 0;
  XSync(display.get(), False);
  if (!moved || !pressed || !released) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to synthesize component click" + context + ".",
      };
    }
    return false;
  }

  if (has_initial_checked) {
    if (wait_checked_or_pressed_state_change(accessible, initial_checked)) {
      return true;
    }
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Component click did not change state" + context + ".",
      };
    }
    return false;
  }

  return true;
}

bool click_accessible_with_fallback(AtspiAccessible *accessible,
                                    const std::string &context,
                                    NativeError *error) {
  GError *role_error = nullptr;
  const AtspiRole role = atspi_accessible_get_role(accessible, &role_error);
  bool has_role = false;
  if (role_error != nullptr) {
    g_clear_error(&role_error);
  } else {
    has_role = true;
    if (role_prefers_component_activation(role)) {
      return click_component_center(accessible, context, error);
    }
  }

  bool initial_checked = false;
  const bool has_initial_checked =
      has_role && role_uses_checked_or_pressed_state(role) &&
      read_checked_or_pressed_state(accessible, &initial_checked);

  AtspiAction *action = atspi_accessible_get_action_iface(accessible);
  if (action == nullptr) {
    return click_component_center(accessible, context, error);
  }

  GError *gerror = nullptr;
  const gint action_count = atspi_action_get_n_actions(action, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read action count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (action_count <= 0) {
    return click_component_center(accessible, context, error);
  }

  for (gint action_index = 0; action_index < action_count;
       action_index += 1) {
    const gboolean ok = atspi_action_do_action(action, action_index, &gerror);
    if (gerror != nullptr) {
      if (error != nullptr) {
        *error = {
            NativeErrorCode::stale_element,
            take_gerror_message(&gerror, "Failed to execute action."),
        };
      } else {
        g_clear_error(&gerror);
      }
      return false;
    }

    if (!ok) {
      continue;
    }

    if (!has_initial_checked ||
        wait_checked_or_pressed_state_change(accessible, initial_checked)) {
      return true;
    }
  }

  return click_component_center(accessible, context, error);
}

void enqueue_children(AtspiAccessible *accessible,
                      std::deque<AtspiAccessible *> *queue) {
  GError *error = nullptr;
  const gint child_count = atspi_accessible_get_child_count(accessible, &error);
  if (error != nullptr) {
    g_clear_error(&error);
    return;
  }

  for (gint child_index = 0; child_index < child_count; child_index += 1) {
    AtspiAccessible *child =
        atspi_accessible_get_child_at_index(accessible, child_index, &error);
    if (error != nullptr) {
      g_clear_error(&error);
      continue;
    }
    if (child != nullptr) {
      queue->push_back(child);
    }
  }
}

AccessibleLookupResult not_found_result(const std::string &id) {
  return {
      nullptr,
      {
          NativeErrorCode::element_not_found,
          "Accessible id was not found: " + id,
      },
  };
}

AccessibleLookupResult not_found_message(const std::string &message) {
  return {
      nullptr,
      {
          NativeErrorCode::element_not_found,
          message,
      },
  };
}

NativeError unsupported_interface_error(const std::string &message) {
  return {
      NativeErrorCode::unsupported_interface,
      message,
  };
}

NativeError operation_failed_error(const std::string &message) {
  return {
      NativeErrorCode::operation_failed,
      message,
  };
}

bool accessible_belongs_to_process(AtspiAccessible *accessible,
                                   guint process_id) {
  GError *error = nullptr;
  const guint accessible_process_id =
      atspi_accessible_get_process_id(accessible, &error);
  if (error != nullptr) {
    g_clear_error(&error);
    return false;
  }

  return accessible_process_id == process_id;
}

bool is_window_role(AtspiAccessible *accessible) {
  GError *error = nullptr;
  const AtspiRole role = atspi_accessible_get_role(accessible, &error);
  if (error != nullptr) {
    g_clear_error(&error);
    return false;
  }

  return role == ATSPI_ROLE_FRAME || role == ATSPI_ROLE_DIALOG ||
         role == ATSPI_ROLE_WINDOW;
}

bool accessible_is_process_window(AtspiAccessible *accessible,
                                  guint process_id) {
  return accessible_belongs_to_process(accessible, process_id) &&
         is_window_role(accessible);
}

AccessibleLookupResult find_window_by_index_impl(guint process_id, gint index) {
  NativeError init_error = {};
  if (!ensure_atspi_initialized(&init_error)) {
    return {nullptr, init_error};
  }

  if (index < 0) {
    return {
        nullptr,
        {
            NativeErrorCode::invalid_argument,
            "Window index must be a non-negative integer.",
        },
    };
  }

  std::deque<AtspiAccessible *> queue;
  const gint desktop_count = atspi_get_desktop_count();
  for (gint desktop_index = 0; desktop_index < desktop_count;
       desktop_index += 1) {
    AtspiAccessible *desktop = atspi_get_desktop(desktop_index);
    if (desktop != nullptr) {
      queue.push_back(desktop);
    }
  }

  gint matched_index = 0;
  guint visited_nodes = 0;
  while (!queue.empty() && visited_nodes < kMaxVisitedNodes) {
    AtspiAccessible *current = queue.front();
    queue.pop_front();
    visited_nodes += 1;

    if (current == nullptr) {
      continue;
    }

    if (accessible_is_process_window(current, process_id)) {
      if (matched_index == index) {
        unref_accessible_queue(&queue);
        return {current, {}};
      }
      matched_index += 1;
      g_object_unref(current);
      continue;
    }

    enqueue_children(current, &queue);
    g_object_unref(current);
  }

  unref_accessible_queue(&queue);
  return not_found_message("Window index was not found: " +
                           std::to_string(index));
}

}  // namespace

AccessibleLookupResult find_accessible_by_id(guint process_id,
                                             const std::string &id) {
  NativeError init_error = {};
  if (!ensure_atspi_initialized(&init_error)) {
    return {nullptr, init_error};
  }

  if (id.empty()) {
    return {
        nullptr,
        {
            NativeErrorCode::invalid_argument,
            "Accessible id must not be empty.",
        },
    };
  }

  std::deque<AtspiAccessible *> queue;
  const gint desktop_count = atspi_get_desktop_count();
  for (gint desktop_index = 0; desktop_index < desktop_count; desktop_index += 1) {
    AtspiAccessible *desktop = atspi_get_desktop(desktop_index);
    if (desktop != nullptr) {
      queue.push_back(desktop);
    }
  }

  guint visited_nodes = 0;
  while (!queue.empty() && visited_nodes < kMaxVisitedNodes) {
    AtspiAccessible *current = queue.front();
    queue.pop_front();
    visited_nodes += 1;

    if (current == nullptr) {
      continue;
    }

    if (accessible_matches(current, process_id, id)) {
      unref_accessible_queue(&queue);
      return {current, {}};
    }

    enqueue_children(current, &queue);
    g_object_unref(current);
  }

  unref_accessible_queue(&queue);
  return not_found_result(id);
}

AccessibleLookupResult find_accessible_by_id_any_process(
    const std::string &id) {
  NativeError init_error = {};
  if (!ensure_atspi_initialized(&init_error)) {
    return {nullptr, init_error};
  }

  if (id.empty()) {
    return {
        nullptr,
        {
            NativeErrorCode::invalid_argument,
            "Accessible id must not be empty.",
        },
    };
  }

  std::deque<AtspiAccessible *> queue;
  const gint desktop_count = atspi_get_desktop_count();
  for (gint desktop_index = 0; desktop_index < desktop_count;
       desktop_index += 1) {
    AtspiAccessible *desktop = atspi_get_desktop(desktop_index);
    if (desktop != nullptr) {
      queue.push_back(desktop);
    }
  }

  guint visited_nodes = 0;
  while (!queue.empty() && visited_nodes < kMaxVisitedNodes) {
    AtspiAccessible *current = queue.front();
    queue.pop_front();
    visited_nodes += 1;

    if (current == nullptr) {
      continue;
    }

    if (accessible_matches_id(current, id)) {
      unref_accessible_queue(&queue);
      return {current, {}};
    }

    enqueue_children(current, &queue);
    g_object_unref(current);
  }

  unref_accessible_queue(&queue);
  return not_found_result(id);
}

AccessibleLookupResult find_window_by_index(guint process_id, gint index) {
  return find_window_by_index_impl(process_id, index);
}

bool accessible_exists(guint process_id, const std::string &id,
                       NativeError *error) {
  AccessibleLookupResult lookup = find_accessible_by_id(process_id, id);
  if (lookup.accessible != nullptr) {
    g_object_unref(lookup.accessible);
    return true;
  }

  if (lookup.error.code != NativeErrorCode::element_not_found) {
    if (error != nullptr) {
      *error = lookup.error;
    }
  }
  return false;
}

bool validate_accessible(guint process_id, AtspiAccessible *accessible,
                         NativeError *error) {
  if (accessible == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          "Accessible element is no longer valid.",
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  const guint accessible_process_id =
      atspi_accessible_get_process_id(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Accessible element is stale."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (accessible_process_id != process_id) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          "Accessible element no longer belongs to the target process.",
      };
    }
    return false;
  }

  return true;
}

bool count_windows(guint process_id, gint *count, NativeError *error) {
  if (count == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Window count result must not be null.",
      };
    }
    return false;
  }

  NativeError init_error = {};
  if (!ensure_atspi_initialized(&init_error)) {
    if (error != nullptr) {
      *error = init_error;
    }
    return false;
  }

  std::deque<AtspiAccessible *> queue;
  const gint desktop_count = atspi_get_desktop_count();
  for (gint desktop_index = 0; desktop_index < desktop_count;
       desktop_index += 1) {
    AtspiAccessible *desktop = atspi_get_desktop(desktop_index);
    if (desktop != nullptr) {
      queue.push_back(desktop);
    }
  }

  gint found_count = 0;
  guint visited_nodes = 0;
  while (!queue.empty() && visited_nodes < kMaxVisitedNodes) {
    AtspiAccessible *current = queue.front();
    queue.pop_front();
    visited_nodes += 1;

    if (current == nullptr) {
      continue;
    }

    if (accessible_is_process_window(current, process_id)) {
      found_count += 1;
      g_object_unref(current);
      continue;
    }

    enqueue_children(current, &queue);
    g_object_unref(current);
  }

  unref_accessible_queue(&queue);
  *count = found_count;
  return true;
}

bool count_accessible_children(guint process_id, AtspiAccessible *accessible,
                               gint *count, NativeError *error) {
  if (count == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Child count result must not be null.",
      };
    }
    return false;
  }

  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  GError *gerror = nullptr;
  const gint child_count = atspi_accessible_get_child_count(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read child count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *count = child_count;
  return true;
}

AccessibleLookupResult get_accessible_child(guint process_id,
                                            AtspiAccessible *accessible,
                                            gint index) {
  if (index < 0) {
    return {
        nullptr,
        {
            NativeErrorCode::invalid_argument,
            "Child index must be a non-negative integer.",
        },
    };
  }

  NativeError validation_error = {};
  if (!validate_accessible(process_id, accessible, &validation_error)) {
    return {nullptr, validation_error};
  }

  GError *gerror = nullptr;
  const gint child_count = atspi_accessible_get_child_count(accessible, &gerror);
  if (gerror != nullptr) {
    return {
        nullptr,
        {
            NativeErrorCode::stale_element,
            take_gerror_message(&gerror, "Failed to read child count."),
        },
    };
  }

  if (index >= child_count) {
    return not_found_message("Accessible child index was not found: " +
                             std::to_string(index));
  }

  AtspiAccessible *child =
      atspi_accessible_get_child_at_index(accessible, index, &gerror);
  if (gerror != nullptr) {
    return {
        nullptr,
        {
            NativeErrorCode::stale_element,
            take_gerror_message(&gerror, "Failed to resolve child."),
        },
    };
  }

  if (child == nullptr) {
    return not_found_message("Accessible child index was not found: " +
                             std::to_string(index));
  }

  return {child, {}};
}

bool count_selected_accessible_children(guint process_id,
                                        AtspiAccessible *accessible,
                                        gint *count, NativeError *error) {
  if (count == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Selected child count result must not be null.",
      };
    }
    return false;
  }

  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AtspiSelection *selection =
      atspi_accessible_get_selection_iface(accessible);
  if (selection == nullptr) {
    if (error != nullptr) {
      *error =
          unsupported_interface_error("Accessible element does not support "
                                      "Selection.");
    }
    return false;
  }

  GError *gerror = nullptr;
  const gint selected_count =
      atspi_selection_get_n_selected_children(selection, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read selected child count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *count = selected_count;
  return true;
}

AccessibleLookupResult get_selected_accessible_child(
    guint process_id, AtspiAccessible *accessible, gint selected_index) {
  if (selected_index < 0) {
    return {
        nullptr,
        {
            NativeErrorCode::invalid_argument,
            "Selected child index must be a non-negative integer.",
        },
    };
  }

  NativeError validation_error = {};
  if (!validate_accessible(process_id, accessible, &validation_error)) {
    return {nullptr, validation_error};
  }

  AtspiSelection *selection =
      atspi_accessible_get_selection_iface(accessible);
  if (selection == nullptr) {
    return {nullptr,
            unsupported_interface_error(
                "Accessible element does not support Selection.")};
  }

  GError *gerror = nullptr;
  const gint selected_count =
      atspi_selection_get_n_selected_children(selection, &gerror);
  if (gerror != nullptr) {
    return {
        nullptr,
        {
            NativeErrorCode::stale_element,
            take_gerror_message(&gerror, "Failed to read selected child count."),
        },
    };
  }

  if (selected_index >= selected_count) {
    return not_found_message("Selected child index was not found: " +
                             std::to_string(selected_index));
  }

  AtspiAccessible *child =
      atspi_selection_get_selected_child(selection, selected_index, &gerror);
  if (gerror != nullptr) {
    return {
        nullptr,
        {
            NativeErrorCode::stale_element,
            take_gerror_message(&gerror, "Failed to resolve selected child."),
        },
    };
  }

  if (child == nullptr) {
    return not_found_message("Selected child index was not found: " +
                             std::to_string(selected_index));
  }

  return {child, {}};
}

bool selected_child_index_is_in_range(AtspiAccessible *accessible, gint index,
                                      NativeError *error) {
  GError *gerror = nullptr;
  const gint child_count = atspi_accessible_get_child_count(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read child count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (index >= child_count) {
    if (error != nullptr) {
      *error = operation_failed_error("Child index is out of range: " +
                                      std::to_string(index));
    }
    return false;
  }

  return true;
}

bool is_accessible_child_selected(guint process_id,
                                  AtspiAccessible *accessible, gint index,
                                  bool *selected, NativeError *error) {
  if (selected == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Selected child state result must not be null.",
      };
    }
    return false;
  }

  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  if (!selected_child_index_is_in_range(accessible, index, error)) {
    return false;
  }

  AtspiSelection *selection =
      atspi_accessible_get_selection_iface(accessible);
  if (selection == nullptr) {
    if (error != nullptr) {
      *error =
          unsupported_interface_error("Accessible element does not support "
                                      "Selection.");
    }
    return false;
  }

  GError *gerror = nullptr;
  const gboolean is_selected =
      atspi_selection_is_child_selected(selection, index, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read child selection state."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *selected = is_selected;
  return true;
}

bool select_accessible_child(guint process_id, AtspiAccessible *accessible,
                             gint index, NativeError *error) {
  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  if (!selected_child_index_is_in_range(accessible, index, error)) {
    return false;
  }

  AtspiSelection *selection =
      atspi_accessible_get_selection_iface(accessible);
  if (selection == nullptr) {
    if (error != nullptr) {
      *error =
          unsupported_interface_error("Accessible element does not support "
                                      "Selection.");
    }
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_selection_select_child(selection, index, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to select child."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error = operation_failed_error("AT-SPI Selection select returned false.");
    }
    return false;
  }

  return true;
}

bool deselect_accessible_child(guint process_id, AtspiAccessible *accessible,
                               gint index, NativeError *error) {
  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  if (!selected_child_index_is_in_range(accessible, index, error)) {
    return false;
  }

  AtspiSelection *selection =
      atspi_accessible_get_selection_iface(accessible);
  if (selection == nullptr) {
    if (error != nullptr) {
      *error =
          unsupported_interface_error("Accessible element does not support "
                                      "Selection.");
    }
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_selection_deselect_child(selection, index, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to deselect child."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error =
          operation_failed_error("AT-SPI Selection deselect returned false.");
    }
    return false;
  }

  return true;
}

bool select_all_accessible_children(guint process_id,
                                    AtspiAccessible *accessible,
                                    NativeError *error) {
  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AtspiSelection *selection =
      atspi_accessible_get_selection_iface(accessible);
  if (selection == nullptr) {
    if (error != nullptr) {
      *error =
          unsupported_interface_error("Accessible element does not support "
                                      "Selection.");
    }
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_selection_select_all(selection, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to select all children."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error =
          operation_failed_error("AT-SPI Selection select all returned false.");
    }
    return false;
  }

  return true;
}

bool clear_accessible_selection(guint process_id, AtspiAccessible *accessible,
                                NativeError *error) {
  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AtspiSelection *selection =
      atspi_accessible_get_selection_iface(accessible);
  if (selection == nullptr) {
    if (error != nullptr) {
      *error =
          unsupported_interface_error("Accessible element does not support "
                                      "Selection.");
    }
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_selection_clear_selection(selection, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to clear selection."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error =
          operation_failed_error("AT-SPI Selection clear returned false.");
    }
    return false;
  }

  return true;
}

AtspiTable *validated_table(guint process_id, AtspiAccessible *accessible,
                            NativeError *error) {
  if (!validate_accessible(process_id, accessible, error)) {
    return nullptr;
  }

  AtspiTable *table = atspi_accessible_get_table_iface(accessible);
  if (table == nullptr) {
    if (error != nullptr) {
      *error = unsupported_interface_error(
          "Accessible element does not support Table.");
    }
    return nullptr;
  }

  return table;
}

bool count_accessible_table_rows(guint process_id, AtspiAccessible *accessible,
                                 gint *count, NativeError *error) {
  if (count == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Table row count result must not be null.",
      };
    }
    return false;
  }

  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr) {
    return false;
  }

  GError *gerror = nullptr;
  const gint row_count = atspi_table_get_n_rows(table, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read table row count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *count = row_count;
  return true;
}

bool count_accessible_table_columns(guint process_id,
                                    AtspiAccessible *accessible, gint *count,
                                    NativeError *error) {
  if (count == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Table column count result must not be null.",
      };
    }
    return false;
  }

  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr) {
    return false;
  }

  GError *gerror = nullptr;
  const gint column_count = atspi_table_get_n_columns(table, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read table column count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *count = column_count;
  return true;
}

bool table_position_is_in_range(AtspiTable *table, gint row, gint column,
                                bool for_lookup, NativeError *error) {
  GError *gerror = nullptr;
  const gint row_count = atspi_table_get_n_rows(table, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read table row count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  const gint column_count = atspi_table_get_n_columns(table, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read table column count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (row >= row_count || column >= column_count) {
    if (error != nullptr) {
      *error = for_lookup
                   ? NativeError{NativeErrorCode::element_not_found,
                                 "Table cell was not found."}
                   : operation_failed_error("Table position is out of range.");
    }
    return false;
  }

  return true;
}

AccessibleLookupResult get_accessible_table_cell(guint process_id,
                                                 AtspiAccessible *accessible,
                                                 gint row, gint column) {
  if (row < 0 || column < 0) {
    return {
        nullptr,
        {
            NativeErrorCode::invalid_argument,
            "Table position must use non-negative indexes.",
        },
    };
  }

  NativeError error = {};
  AtspiTable *table = validated_table(process_id, accessible, &error);
  if (table == nullptr) {
    return {nullptr, error};
  }

  if (!table_position_is_in_range(table, row, column, true, &error)) {
    return {nullptr, error};
  }

  GError *gerror = nullptr;
  AtspiAccessible *cell =
      atspi_table_get_accessible_at(table, row, column, &gerror);
  if (gerror != nullptr) {
    return {
        nullptr,
        {
            NativeErrorCode::stale_element,
            take_gerror_message(&gerror, "Failed to resolve table cell."),
        },
    };
  }

  if (cell == nullptr) {
    return not_found_message("Table cell was not found.");
  }

  return {cell, {}};
}

bool read_gint_array(GArray *array, std::vector<gint> *values,
                     NativeError *error) {
  if (values == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Integer array result must not be null.",
      };
    }
    return false;
  }

  values->clear();
  if (array == nullptr) {
    return true;
  }

  values->reserve(array->len);
  for (guint index = 0; index < array->len; index += 1) {
    values->push_back(g_array_index(array, gint, index));
  }
  g_array_free(array, TRUE);
  return true;
}

bool read_accessible_table_selected_rows(guint process_id,
                                         AtspiAccessible *accessible,
                                         std::vector<gint> *rows,
                                         NativeError *error) {
  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr) {
    return false;
  }

  GError *gerror = nullptr;
  GArray *selected_rows = atspi_table_get_selected_rows(table, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read selected rows."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  return read_gint_array(selected_rows, rows, error);
}

bool read_accessible_table_selected_columns(guint process_id,
                                            AtspiAccessible *accessible,
                                            std::vector<gint> *columns,
                                            NativeError *error) {
  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr) {
    return false;
  }

  GError *gerror = nullptr;
  GArray *selected_columns = atspi_table_get_selected_columns(table, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read selected columns."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  return read_gint_array(selected_columns, columns, error);
}

bool table_index_is_in_range(AtspiTable *table, gint index, bool row_axis,
                             NativeError *error) {
  GError *gerror = nullptr;
  const gint count = row_axis ? atspi_table_get_n_rows(table, &gerror)
                              : atspi_table_get_n_columns(table, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read table dimension."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (index >= count) {
    if (error != nullptr) {
      *error = operation_failed_error("Table index is out of range: " +
                                      std::to_string(index));
    }
    return false;
  }

  return true;
}

bool is_accessible_table_row_selected(guint process_id,
                                      AtspiAccessible *accessible, gint row,
                                      bool *selected, NativeError *error) {
  if (selected == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Table row selection result must not be null.",
      };
    }
    return false;
  }

  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr ||
      !table_index_is_in_range(table, row, true, error)) {
    return false;
  }

  GError *gerror = nullptr;
  const gboolean is_selected = atspi_table_is_row_selected(table, row, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read row selection state."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *selected = is_selected;
  return true;
}

bool is_accessible_table_column_selected(guint process_id,
                                         AtspiAccessible *accessible,
                                         gint column, bool *selected,
                                         NativeError *error) {
  if (selected == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Table column selection result must not be null.",
      };
    }
    return false;
  }

  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr ||
      !table_index_is_in_range(table, column, false, error)) {
    return false;
  }

  GError *gerror = nullptr;
  const gboolean is_selected =
      atspi_table_is_column_selected(table, column, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read column selection state."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *selected = is_selected;
  return true;
}

bool is_accessible_table_cell_selected(guint process_id,
                                       AtspiAccessible *accessible, gint row,
                                       gint column, bool *selected,
                                       NativeError *error) {
  if (selected == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Table cell selection result must not be null.",
      };
    }
    return false;
  }

  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr ||
      !table_position_is_in_range(table, row, column, false, error)) {
    return false;
  }

  GError *gerror = nullptr;
  const gboolean is_selected =
      atspi_table_is_selected(table, row, column, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read cell selection state."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *selected = is_selected;
  return true;
}

bool select_accessible_table_row(guint process_id, AtspiAccessible *accessible,
                                 gint row, NativeError *error) {
  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr || !table_index_is_in_range(table, row, true, error)) {
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_table_add_row_selection(table, row, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to select table row."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error =
          operation_failed_error("AT-SPI Table row selection returned false.");
    }
    return false;
  }

  return true;
}

bool deselect_accessible_table_row(guint process_id,
                                   AtspiAccessible *accessible, gint row,
                                   NativeError *error) {
  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr || !table_index_is_in_range(table, row, true, error)) {
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_table_remove_row_selection(table, row, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to deselect table row."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error = operation_failed_error(
          "AT-SPI Table row deselection returned false.");
    }
    return false;
  }

  return true;
}

bool select_accessible_table_column(guint process_id,
                                    AtspiAccessible *accessible, gint column,
                                    NativeError *error) {
  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr ||
      !table_index_is_in_range(table, column, false, error)) {
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_table_add_column_selection(table, column, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to select table column."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error = operation_failed_error(
          "AT-SPI Table column selection returned false.");
    }
    return false;
  }

  return true;
}

bool deselect_accessible_table_column(guint process_id,
                                      AtspiAccessible *accessible, gint column,
                                      NativeError *error) {
  AtspiTable *table = validated_table(process_id, accessible, error);
  if (table == nullptr ||
      !table_index_is_in_range(table, column, false, error)) {
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok =
      atspi_table_remove_column_selection(table, column, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to deselect table column."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error = operation_failed_error(
          "AT-SPI Table column deselection returned false.");
    }
    return false;
  }

  return true;
}

bool set_accessible_text(guint process_id, const std::string &id,
                         const std::string &text, NativeError *error) {
  AccessibleLookupResult lookup = find_accessible_by_id(process_id, id);
  if (lookup.accessible == nullptr) {
    if (error != nullptr) {
      *error = lookup.error;
    }
    return false;
  }

  AtspiEditableText *editable_text =
      atspi_accessible_get_editable_text_iface(lookup.accessible);
  if (editable_text == nullptr) {
    g_object_unref(lookup.accessible);
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible id does not support EditableText: " + id,
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_editable_text_set_text_contents(
      editable_text, text.c_str(), &gerror);
  g_object_unref(lookup.accessible);

  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to set text contents."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "AT-SPI EditableText operation returned false: " + id,
      };
    }
    return false;
  }

  return true;
}

bool click_accessible(guint process_id, const std::string &id,
                      NativeError *error) {
  AccessibleLookupResult lookup = find_accessible_by_id(process_id, id);
  if (lookup.accessible == nullptr) {
    if (error != nullptr) {
      *error = lookup.error;
    }
    return false;
  }

  const bool ok = click_accessible_with_fallback(lookup.accessible, ": " + id,
                                                error);
  g_object_unref(lookup.accessible);
  return ok;
}

bool read_accessible_text(guint process_id, const std::string &id,
                          std::string *text, NativeError *error) {
  AccessibleLookupResult lookup = find_accessible_by_id(process_id, id);
  if (lookup.accessible == nullptr) {
    if (error != nullptr) {
      *error = lookup.error;
    }
    return false;
  }

  AtspiText *text_iface = atspi_accessible_get_text_iface(lookup.accessible);
  if (text_iface == nullptr) {
    g_object_unref(lookup.accessible);
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible id does not support Text: " + id,
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  const gint character_count =
      atspi_text_get_character_count(text_iface, &gerror);
  if (gerror != nullptr) {
    g_object_unref(lookup.accessible);
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to read character count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  gchar *contents = atspi_text_get_text(text_iface, 0, character_count, &gerror);
  g_object_unref(lookup.accessible);

  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          take_gerror_message(&gerror, "Failed to read text."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *text = contents == nullptr ? "" : contents;
  g_free(contents);
  return true;
}

bool capture_accessible(guint process_id, const std::string &id,
                        CaptureResult *result, NativeError *error) {
  if (result == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Capture result must not be null.",
      };
    }
    return false;
  }

  AccessibleLookupResult lookup = find_accessible_by_id(process_id, id);
  if (lookup.accessible == nullptr) {
    if (error != nullptr) {
      *error = lookup.error;
    }
    return false;
  }

  CaptureBounds bounds = {};
  const bool resolved = resolve_capture_screen_bounds(
      process_id, lookup.accessible, ": " + id,
      NativeErrorCode::operation_failed, &bounds, error);
  g_object_unref(lookup.accessible);

  if (!resolved) {
    return false;
  }

  return capture_root_window_pixels(bounds, ": " + id,
                                    NativeErrorCode::operation_failed, result,
                                    error);
}

bool set_accessible_proxy_text(guint process_id, AtspiAccessible *accessible,
                               const std::string &text, NativeError *error) {
  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AtspiEditableText *editable_text =
      atspi_accessible_get_editable_text_iface(accessible);
  if (editable_text == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible element does not support EditableText.",
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok = atspi_editable_text_set_text_contents(
      editable_text, text.c_str(), &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to set text contents."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "AT-SPI EditableText operation returned false.",
      };
    }
    return false;
  }

  return true;
}

bool click_accessible_proxy(guint process_id, AtspiAccessible *accessible,
                            NativeError *error) {
  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  return click_accessible_with_fallback(accessible, ".", error);
}

bool read_accessible_proxy_text(guint process_id, AtspiAccessible *accessible,
                                std::string *text, NativeError *error) {
  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AtspiText *text_iface = atspi_accessible_get_text_iface(accessible);
  if (text_iface == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible element does not support Text.",
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  const gint character_count =
      atspi_text_get_character_count(text_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read character count."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  gchar *contents = atspi_text_get_text(text_iface, 0, character_count, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read text."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  *text = contents == nullptr ? "" : contents;
  g_free(contents);
  return true;
}

bool read_accessible_proxy_value_info(guint process_id,
                                      AtspiAccessible *accessible,
                                      AccessibleValueInfo *info,
                                      NativeError *error) {
  if (info == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Accessible value info result must not be null.",
      };
    }
    return false;
  }

  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AtspiValue *value_iface = atspi_accessible_get_value_iface(accessible);
  if (value_iface == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible element does not support Value.",
      };
    }
    return false;
  }

  AccessibleValueInfo next = {};

  GError *gerror = nullptr;
  next.value = atspi_value_get_current_value(value_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read current value."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  next.minimum = atspi_value_get_minimum_value(value_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read minimum value."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  next.maximum = atspi_value_get_maximum_value(value_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read maximum value."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  next.minimum_increment =
      atspi_value_get_minimum_increment(value_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read minimum increment."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  gchar *text = atspi_value_get_text(value_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read value text."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  next.text = text == nullptr ? "" : text;
  g_free(text);

  *info = next;
  return true;
}

bool read_accessible_proxy_image_info(guint process_id,
                                      AtspiAccessible *accessible,
                                      AccessibleImageInfo *info,
                                      NativeError *error) {
  if (info == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Accessible image info result must not be null.",
      };
    }
    return false;
  }

  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AtspiImage *image_iface = atspi_accessible_get_image_iface(accessible);
  if (image_iface == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible element does not support Image.",
      };
    }
    return false;
  }

  AccessibleImageInfo next = {};

  GError *gerror = nullptr;
  gchar *description = atspi_image_get_image_description(image_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read image description."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  next.description = description == nullptr ? "" : description;
  g_free(description);

  AtspiPoint *position = atspi_image_get_image_position(
      image_iface, ATSPI_COORD_TYPE_SCREEN, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read image position."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  if (position == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "AT-SPI Image returned no position.",
      };
    }
    return false;
  }
  next.position = {
      position->x,
      position->y,
  };
  g_free(position);

  AtspiPoint *size = atspi_image_get_image_size(image_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read image size."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  if (size == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "AT-SPI Image returned no size.",
      };
    }
    return false;
  }
  next.size = {
      size->x,
      size->y,
  };
  g_free(size);

  AtspiRect *bounds = atspi_image_get_image_extents(
      image_iface, ATSPI_COORD_TYPE_SCREEN, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read image extents."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  if (bounds == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "AT-SPI Image returned no extents.",
      };
    }
    return false;
  }
  next.bounds = {
      bounds->x,
      bounds->y,
      bounds->width,
      bounds->height,
  };
  g_free(bounds);

  gchar *locale = atspi_image_get_image_locale(image_iface, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read image locale."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  next.locale = locale == nullptr ? "" : locale;
  g_free(locale);

  *info = std::move(next);
  return true;
}

bool set_accessible_proxy_value(guint process_id, AtspiAccessible *accessible,
                                gdouble value, NativeError *error) {
  if (!std::isfinite(value)) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Value must be a finite number.",
      };
    }
    return false;
  }

  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AtspiValue *value_iface = atspi_accessible_get_value_iface(accessible);
  if (value_iface == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::unsupported_interface,
          "Accessible element does not support Value.",
      };
    }
    return false;
  }

  GError *gerror = nullptr;
  const gboolean ok =
      atspi_value_set_current_value(value_iface, value, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to set current value."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  if (!ok) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "AT-SPI Value operation returned false.",
      };
    }
    return false;
  }

  return true;
}

bool capture_accessible_proxy(guint process_id, AtspiAccessible *accessible,
                              CaptureResult *result, NativeError *error) {
  if (result == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Capture result must not be null.",
      };
    }
    return false;
  }

  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  CaptureBounds bounds = {};
  if (!resolve_capture_screen_bounds(process_id, accessible, ".",
                                     NativeErrorCode::stale_element, &bounds,
                                     error)) {
    return false;
  }

  return capture_root_window_pixels(bounds, ".", NativeErrorCode::stale_element,
                                    result, error);
}

bool capture_screen(CaptureResult *result, NativeError *error) {
  if (result == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Capture result must not be null.",
      };
    }
    return false;
  }

  std::unique_ptr<Display, decltype(&XCloseDisplay)> display(
      XOpenDisplay(nullptr), XCloseDisplay);
  if (display == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to open the X11 display. Ensure DISPLAY points to an X11 "
          "display.",
      };
    }
    return false;
  }

  Window root_window = DefaultRootWindow(display.get());
  XWindowAttributes root_attributes = {};
  if (XGetWindowAttributes(display.get(), root_window, &root_attributes) == 0) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::operation_failed,
          "Failed to get X11 root window attributes.",
      };
    }
    return false;
  }

  const CaptureBounds bounds = {
      0,
      0,
      root_attributes.width,
      root_attributes.height,
  };
  return capture_root_window_pixels(bounds, " for the X11 root window",
                                    NativeErrorCode::operation_failed, result,
                                    error);
}

bool capture_screen_bounds(const CaptureBounds &bounds, CaptureResult *result,
                           NativeError *error) {
  if (result == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Capture result must not be null.",
      };
    }
    return false;
  }

  return capture_root_window_pixels(bounds, " for explicit screen bounds",
                                    NativeErrorCode::invalid_argument, result,
                                    error);
}

bool read_accessible_proxy_info(guint process_id, AtspiAccessible *accessible,
                                AccessibleInfo *info, NativeError *error) {
  if (info == nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::invalid_argument,
          "Accessible info result must not be null.",
      };
    }
    return false;
  }

  if (!validate_accessible(process_id, accessible, error)) {
    return false;
  }

  AccessibleInfo next = {};

  GError *gerror = nullptr;
  const AtspiRole role = atspi_accessible_get_role(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read role."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }

  gchar *role_name = atspi_accessible_get_role_name(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read role name."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  if (role_name == nullptr || role_name[0] == '\0') {
    g_free(role_name);
    role_name = atspi_role_get_name(role);
  }
  next.role_name = role_name == nullptr ? "" : role_name;
  g_free(role_name);

  gchar *localized_role_name =
      atspi_accessible_get_localized_role_name(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read localized role name."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  next.localized_role_name =
      localized_role_name == nullptr ? "" : localized_role_name;
  g_free(localized_role_name);

  gchar *accessible_id =
      atspi_accessible_get_accessible_id(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read accessible id."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  next.accessible_id = accessible_id == nullptr ? "" : accessible_id;
  g_free(accessible_id);

  gchar *name = atspi_accessible_get_name(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read accessible name."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  next.name = name == nullptr ? "" : name;
  g_free(name);

  gchar *description = atspi_accessible_get_description(accessible, &gerror);
  if (gerror != nullptr) {
    if (error != nullptr) {
      *error = {
          NativeErrorCode::stale_element,
          take_gerror_message(&gerror, "Failed to read accessible description."),
      };
    } else {
      g_clear_error(&gerror);
    }
    return false;
  }
  next.description = description == nullptr ? "" : description;
  g_free(description);

  GArray *interfaces = atspi_accessible_get_interfaces(accessible);
  if (interfaces != nullptr) {
    next.interfaces.reserve(interfaces->len);
    for (guint index = 0; index < interfaces->len; index += 1) {
      const gchar *interface_name = g_array_index(interfaces, gchar *, index);
      if (interface_name != nullptr) {
        next.interfaces.emplace_back(interface_name);
      }
    }
    g_array_free(interfaces, TRUE);
  }

  AtspiStateSet *state_set = atspi_accessible_get_state_set(accessible);
  if (state_set != nullptr) {
    GArray *states = atspi_state_set_get_states(state_set);
    if (states != nullptr) {
      next.states.reserve(states->len);
      for (guint index = 0; index < states->len; index += 1) {
        const AtspiStateType state =
            g_array_index(states, AtspiStateType, index);
        next.states.emplace_back(state_type_name(state));
      }
      g_array_free(states, TRUE);
    }
    g_object_unref(state_set);
  }

  *info = std::move(next);
  return true;
}

}  // namespace gestament
