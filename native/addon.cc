// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

#include "accessible.hpp"
#include "atspi_client.hpp"
#include "tray.hpp"

#include <node_api.h>

#include <cstddef>
#include <cmath>
#include <limits>
#include <string>
#include <vector>

#ifndef GESTAMENT_PACKAGE_VERSION
#define GESTAMENT_PACKAGE_VERSION "unknown"
#endif

#ifndef GESTAMENT_NATIVE_ARCH
#define GESTAMENT_NATIVE_ARCH "unknown"
#endif

#ifndef GESTAMENT_NATIVE_GTK_BACKEND
#define GESTAMENT_NATIVE_GTK_BACKEND "unknown"
#endif

/////////////////////////////////////////////////////////////////////////////////////////

namespace {

constexpr char native_version_marker[] =
    "gestament-package-version=" GESTAMENT_PACKAGE_VERSION;
constexpr std::size_t native_version_prefix_length =
    sizeof("gestament-package-version=") - 1;

struct NativeElement {
  guint process_id;
  AtspiAccessible *accessible;
};

napi_value make_undefined(napi_env env) {
  napi_value value = nullptr;
  napi_get_undefined(env, &value);
  return value;
}

void throw_type_error(napi_env env, const std::string &message) {
  napi_throw_type_error(env, nullptr, message.c_str());
}

void throw_range_error(napi_env env, const std::string &message) {
  napi_throw_range_error(env, nullptr, message.c_str());
}

void finalize_element(napi_env, void *data, void *) {
  auto *element = static_cast<NativeElement *>(data);
  if (element == nullptr) {
    return;
  }
  if (element->accessible != nullptr) {
    g_object_unref(element->accessible);
  }
  delete element;
}

bool read_arguments(napi_env env, napi_callback_info info,
                    std::size_t expected_count, napi_value *args) {
  std::size_t argc = expected_count;
  const napi_status status =
      napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to read callback arguments.");
    return false;
  }

  if (argc < expected_count) {
    throw_type_error(env, "Missing required native addon arguments.");
    return false;
  }

  return true;
}

bool read_process_id(napi_env env, napi_value value, guint *process_id) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_number) {
    throw_type_error(env, "processId must be a number.");
    return false;
  }

  double numeric_value = 0;
  if (napi_get_value_double(env, value, &numeric_value) != napi_ok) {
    throw_type_error(env, "processId must be a number.");
    return false;
  }

  if (!std::isfinite(numeric_value) || std::floor(numeric_value) != numeric_value ||
      numeric_value < 0 ||
      numeric_value > static_cast<double>(std::numeric_limits<guint>::max())) {
    throw_range_error(env, "processId is out of range.");
    return false;
  }

  *process_id = static_cast<guint>(numeric_value);
  return true;
}

bool read_string_argument(napi_env env, napi_value value, const char *name,
                          std::string *result) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_string) {
    throw_type_error(env, std::string(name) + " must be a string.");
    return false;
  }

  std::size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to read string length.");
    return false;
  }

  std::vector<char> buffer(length + 1, '\0');
  std::size_t copied_length = 0;
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(),
                                 &copied_length) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to read string value.");
    return false;
  }

  result->assign(buffer.data(), copied_length);
  return true;
}

bool read_non_negative_index(napi_env env, napi_value value, const char *name,
                             gint *result) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_number) {
    throw_type_error(env, std::string(name) + " must be a number.");
    return false;
  }

  double numeric_value = 0;
  if (napi_get_value_double(env, value, &numeric_value) != napi_ok) {
    throw_type_error(env, std::string(name) + " must be a number.");
    return false;
  }

  if (!std::isfinite(numeric_value) ||
      std::floor(numeric_value) != numeric_value || numeric_value < 0 ||
      numeric_value > static_cast<double>(std::numeric_limits<gint>::max())) {
    throw_range_error(env,
                      std::string(name) +
                          " must be a non-negative integer in range.");
    return false;
  }

  *result = static_cast<gint>(numeric_value);
  return true;
}

bool read_int32_argument(napi_env env, napi_value value, const char *name,
                         gint *result) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_number) {
    throw_type_error(env, std::string(name) + " must be a number.");
    return false;
  }

  double numeric_value = 0;
  if (napi_get_value_double(env, value, &numeric_value) != napi_ok) {
    throw_type_error(env, std::string(name) + " must be a number.");
    return false;
  }

  if (!std::isfinite(numeric_value) ||
      std::floor(numeric_value) != numeric_value ||
      numeric_value < static_cast<double>(std::numeric_limits<gint>::min()) ||
      numeric_value > static_cast<double>(std::numeric_limits<gint>::max())) {
    throw_range_error(env,
                      std::string(name) + " must be an integer in range.");
    return false;
  }

  *result = static_cast<gint>(numeric_value);
  return true;
}

bool read_uint32_argument(napi_env env, napi_value value, const char *name,
                          guint *result) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_number) {
    throw_type_error(env, std::string(name) + " must be a number.");
    return false;
  }

  double numeric_value = 0;
  if (napi_get_value_double(env, value, &numeric_value) != napi_ok) {
    throw_type_error(env, std::string(name) + " must be a number.");
    return false;
  }

  if (!std::isfinite(numeric_value) ||
      std::floor(numeric_value) != numeric_value || numeric_value < 0 ||
      numeric_value > static_cast<double>(std::numeric_limits<guint>::max())) {
    throw_range_error(env,
                      std::string(name) +
                          " must be an unsigned 32-bit integer in range.");
    return false;
  }

  *result = static_cast<guint>(numeric_value);
  return true;
}

bool read_bool_argument(napi_env env, napi_value value, const char *name,
                        bool *result) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_boolean) {
    throw_type_error(env, std::string(name) + " must be a boolean.");
    return false;
  }

  bool bool_value = false;
  if (napi_get_value_bool(env, value, &bool_value) != napi_ok) {
    throw_type_error(env, std::string(name) + " must be a boolean.");
    return false;
  }

  *result = bool_value;
  return true;
}

bool read_positive_int32_argument(napi_env env, napi_value value,
                                  const char *name, gint *result) {
  if (!read_int32_argument(env, value, name, result)) {
    return false;
  }

  if (*result <= 0) {
    throw_range_error(env, std::string(name) + " must be greater than zero.");
    return false;
  }

  return true;
}

bool read_double_argument(napi_env env, napi_value value, const char *name,
                          gdouble *result) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok ||
      value_type != napi_number) {
    throw_type_error(env, std::string(name) + " must be a number.");
    return false;
  }

  double numeric_value = 0;
  if (napi_get_value_double(env, value, &numeric_value) != napi_ok) {
    throw_type_error(env, std::string(name) + " must be a number.");
    return false;
  }

  if (!std::isfinite(numeric_value)) {
    throw_range_error(env, std::string(name) + " must be a finite number.");
    return false;
  }

  *result = numeric_value;
  return true;
}

void throw_native_error(napi_env env,
                        const gestament::NativeError &native_error) {
  napi_value message = nullptr;
  napi_value error = nullptr;
  napi_value code = nullptr;

  napi_create_string_utf8(env, native_error.message.c_str(),
                          native_error.message.size(), &message);
  napi_create_error(env, nullptr, message, &error);
  napi_create_string_utf8(env,
                          gestament::native_error_code_to_string(
                              native_error.code),
                          NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, error, "code", code);
  napi_throw(env, error);
}

napi_value find_by_id(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  std::string id;
  if (!read_process_id(env, args[0], &process_id) ||
      !read_string_argument(env, args[1], "id", &id)) {
    return make_undefined(env);
  }

  gestament::AccessibleLookupResult lookup =
      gestament::find_accessible_by_id(process_id, id);
  if (lookup.accessible == nullptr) {
    if (lookup.error.code != gestament::NativeErrorCode::element_not_found) {
      throw_native_error(env, lookup.error);
    }
    return make_undefined(env);
  }

  napi_value result = nullptr;
  auto *element = new NativeElement{
      process_id,
      lookup.accessible,
  };
  if (napi_create_external(env, element, finalize_element, nullptr, &result) !=
      napi_ok) {
    finalize_element(env, element, nullptr);
    napi_throw_error(env, nullptr, "Failed to create native element.");
    return make_undefined(env);
  }
  return result;
}

napi_value process_atspi_readiness(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  if (!read_process_id(env, args[0], &process_id)) {
    return make_undefined(env);
  }

  const gestament::AtspiReadiness readiness =
      gestament::process_atspi_readiness(process_id);
  napi_value result = nullptr;
  if (napi_create_string_utf8(env,
                              gestament::atspi_readiness_to_string(readiness),
                              NAPI_AUTO_LENGTH, &result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create AT-SPI readiness value.");
    return make_undefined(env);
  }
  return result;
}

napi_value set_text_by_id(napi_env env, napi_callback_info info) {
  napi_value args[3] = {};
  if (!read_arguments(env, info, 3, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  std::string id;
  std::string text;
  if (!read_process_id(env, args[0], &process_id) ||
      !read_string_argument(env, args[1], "id", &id) ||
      !read_string_argument(env, args[2], "text", &text)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::set_accessible_text(process_id, id, text, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value click_by_id(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  std::string id;
  if (!read_process_id(env, args[0], &process_id) ||
      !read_string_argument(env, args[1], "id", &id)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::click_accessible(process_id, id, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value text_by_id(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  std::string id;
  if (!read_process_id(env, args[0], &process_id) ||
      !read_string_argument(env, args[1], "id", &id)) {
    return make_undefined(env);
  }

  std::string text;
  gestament::NativeError error = {};
  if (!gestament::read_accessible_text(process_id, id, &text, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_create_string_utf8(env, text.c_str(), text.size(), &result);
  return result;
}

bool set_string_property(napi_env env, napi_value target, const char *name,
                         const char *value) {
  napi_value property_value = nullptr;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &property_value) !=
      napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create native info value.");
    return false;
  }

  if (napi_set_named_property(env, target, name, property_value) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to set native info value.");
    return false;
  }

  return true;
}

bool set_value_property(napi_env env, napi_value target, const char *name,
                        napi_value value) {
  if (napi_set_named_property(env, target, name, value) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to set native object value.");
    return false;
  }

  return true;
}

bool set_int32_property(napi_env env, napi_value target, const char *name,
                        gint value) {
  napi_value property_value = nullptr;
  if (napi_create_int32(env, value, &property_value) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create native int32 value.");
    return false;
  }

  return set_value_property(env, target, name, property_value);
}

bool set_double_property(napi_env env, napi_value target, const char *name,
                         gdouble value) {
  napi_value property_value = nullptr;
  if (napi_create_double(env, value, &property_value) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create native double value.");
    return false;
  }

  return set_value_property(env, target, name, property_value);
}

bool set_bool_property(napi_env env, napi_value target, const char *name,
                       bool value) {
  napi_value property_value = nullptr;
  if (napi_get_boolean(env, value, &property_value) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create native boolean value.");
    return false;
  }

  return set_value_property(env, target, name, property_value);
}

bool create_bounds_object(napi_env env, const gestament::CaptureBounds &bounds,
                          napi_value *value) {
  if (napi_create_object(env, value) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create capture bounds object.");
    return false;
  }

  return set_int32_property(env, *value, "x", bounds.x) &&
         set_int32_property(env, *value, "y", bounds.y) &&
         set_int32_property(env, *value, "width", bounds.width) &&
         set_int32_property(env, *value, "height", bounds.height);
}

bool create_image_point_object(napi_env env, const gestament::ImagePoint &point,
                               napi_value *value) {
  if (napi_create_object(env, value) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create image point object.");
    return false;
  }

  return set_int32_property(env, *value, "x", point.x) &&
         set_int32_property(env, *value, "y", point.y);
}

bool create_image_size_object(napi_env env, const gestament::ImageSize &size,
                              napi_value *value) {
  if (napi_create_object(env, value) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create image size object.");
    return false;
  }

  return set_int32_property(env, *value, "width", size.width) &&
         set_int32_property(env, *value, "height", size.height);
}

bool read_native_element(napi_env env, napi_value value, const char *name,
                         NativeElement **element) {
  void *data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok ||
      data == nullptr) {
    throw_type_error(env, std::string(name) + " must be a native element.");
    return false;
  }

  *element = static_cast<NativeElement *>(data);
  return true;
}

bool create_element_external(napi_env env, guint process_id,
                             AtspiAccessible *accessible, napi_value *value) {
  auto *element = new NativeElement{
      process_id,
      accessible,
  };
  if (napi_create_external(env, element, finalize_element, nullptr, value) !=
      napi_ok) {
    finalize_element(env, element, nullptr);
    napi_throw_error(env, nullptr, "Failed to create native element.");
    return false;
  }

  return true;
}

bool create_capture_object(napi_env env, const gestament::CaptureResult &capture,
                           napi_value *result) {
  if (napi_create_object(env, result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create capture result object.");
    return false;
  }

  napi_value image = nullptr;
  if (napi_create_buffer_copy(env, capture.image.size(), capture.image.data(),
                              nullptr, &image) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create capture image buffer.");
    return false;
  }

  napi_value bounds = nullptr;
  napi_value visible_bounds = nullptr;
  return create_bounds_object(env, capture.bounds, &bounds) &&
         create_bounds_object(env, capture.visible_bounds, &visible_bounds) &&
         set_value_property(env, *result, "image", image) &&
         set_value_property(env, *result, "bounds", bounds) &&
         set_value_property(env, *result, "visibleBounds", visible_bounds) &&
         set_bool_property(env, *result, "clipped", capture.clipped);
}

bool create_resize_hints_object(napi_env env,
                                const gestament::WindowResizeHints &hints,
                                napi_value *result) {
  if (napi_create_object(env, result) != napi_ok) {
    napi_throw_error(env, nullptr,
                     "Failed to create window resize hints object.");
    return false;
  }

  return set_int32_property(env, *result, "baseWidth", hints.base_width) &&
         set_int32_property(env, *result, "baseHeight", hints.base_height) &&
         set_int32_property(env, *result, "minWidth", hints.min_width) &&
         set_int32_property(env, *result, "minHeight", hints.min_height) &&
         set_int32_property(env, *result, "widthIncrement",
                            hints.width_increment) &&
         set_int32_property(env, *result, "heightIncrement",
                            hints.height_increment);
}

bool create_x11_window_info_object(napi_env env,
                                   const gestament::X11WindowInfo &info,
                                   napi_value *result) {
  if (napi_create_object(env, result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create X11 window info object.");
    return false;
  }

  napi_value normal_hints = nullptr;
  return create_resize_hints_object(env, info.normal_hints, &normal_hints) &&
         set_string_property(env, *result, "windowId",
                             info.window_id.c_str()) &&
         set_string_property(env, *result, "title", info.title.c_str()) &&
         set_string_property(env, *result, "className",
                             info.class_name.c_str()) &&
         set_string_property(env, *result, "instanceName",
                             info.instance_name.c_str()) &&
         set_value_property(env, *result, "normalHints", normal_hints);
}

bool create_string_array(napi_env env, const std::vector<std::string> &values,
                         napi_value *result) {
  if (napi_create_array_with_length(env, values.size(), result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create native string array.");
    return false;
  }

  for (std::size_t index = 0; index < values.size(); index += 1) {
    napi_value value = nullptr;
    if (napi_create_string_utf8(env, values[index].c_str(),
                                values[index].size(), &value) != napi_ok ||
        napi_set_element(env, *result, index, value) != napi_ok) {
      napi_throw_error(env, nullptr, "Failed to set native string array item.");
      return false;
    }
  }

  return true;
}

bool create_int32_array(napi_env env, const std::vector<gint> &values,
                        napi_value *result) {
  if (napi_create_array_with_length(env, values.size(), result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create native int32 array.");
    return false;
  }

  for (std::size_t index = 0; index < values.size(); index += 1) {
    napi_value value = nullptr;
    if (napi_create_int32(env, values[index], &value) != napi_ok ||
        napi_set_element(env, *result, index, value) != napi_ok) {
      napi_throw_error(env, nullptr, "Failed to set native int32 array item.");
      return false;
    }
  }

  return true;
}

bool create_element_info_object(napi_env env,
                                const gestament::AccessibleInfo &info,
                                napi_value *result) {
  if (napi_create_object(env, result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create element info object.");
    return false;
  }

  napi_value interfaces = nullptr;
  napi_value states = nullptr;
  return create_string_array(env, info.interfaces, &interfaces) &&
         create_string_array(env, info.states, &states) &&
         set_string_property(env, *result, "roleName",
                             info.role_name.c_str()) &&
         set_string_property(env, *result, "localizedRoleName",
                             info.localized_role_name.c_str()) &&
         set_string_property(env, *result, "accessibleId",
                             info.accessible_id.c_str()) &&
         set_string_property(env, *result, "name", info.name.c_str()) &&
         set_string_property(env, *result, "description",
                             info.description.c_str()) &&
         set_value_property(env, *result, "interfaces", interfaces) &&
         set_value_property(env, *result, "states", states);
}

bool create_value_info_object(napi_env env,
                              const gestament::AccessibleValueInfo &info,
                              napi_value *result) {
  if (napi_create_object(env, result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create value info object.");
    return false;
  }

  return set_double_property(env, *result, "value", info.value) &&
         set_double_property(env, *result, "minimum", info.minimum) &&
         set_double_property(env, *result, "maximum", info.maximum) &&
         set_double_property(env, *result, "minimumIncrement",
                             info.minimum_increment) &&
         set_string_property(env, *result, "text", info.text.c_str());
}

bool create_image_info_object(napi_env env,
                              const gestament::AccessibleImageInfo &info,
                              napi_value *result) {
  if (napi_create_object(env, result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create image info object.");
    return false;
  }

  napi_value position = nullptr;
  napi_value size = nullptr;
  napi_value bounds = nullptr;
  return create_image_point_object(env, info.position, &position) &&
         create_image_size_object(env, info.size, &size) &&
         create_bounds_object(env, info.bounds, &bounds) &&
         set_string_property(env, *result, "description",
                             info.description.c_str()) &&
         set_string_property(env, *result, "locale", info.locale.c_str()) &&
         set_value_property(env, *result, "position", position) &&
         set_value_property(env, *result, "size", size) &&
         set_value_property(env, *result, "bounds", bounds);
}

napi_value find_any_by_id(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  std::string id;
  if (!read_string_argument(env, args[0], "id", &id)) {
    return make_undefined(env);
  }

  gestament::AccessibleLookupResult lookup =
      gestament::find_accessible_by_id_any_process(id);
  if (lookup.accessible == nullptr) {
    if (lookup.error.code != gestament::NativeErrorCode::element_not_found) {
      throw_native_error(env, lookup.error);
    }
    return make_undefined(env);
  }

  GError *gerror = nullptr;
  const guint process_id =
      atspi_accessible_get_process_id(lookup.accessible, &gerror);
  if (gerror != nullptr) {
    g_object_unref(lookup.accessible);
    gestament::NativeError error = {
        gestament::NativeErrorCode::operation_failed,
        gerror->message,
    };
    g_clear_error(&gerror);
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_element_external(env, process_id, lookup.accessible, &result)) {
    return make_undefined(env);
  }
  return result;
}

bool create_tray_item_object(napi_env env, const gestament::TrayItemInfo &item,
                             napi_value *result) {
  if (napi_create_object(env, result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create tray item object.");
    return false;
  }

  return set_string_property(env, *result, "busName", item.bus_name.c_str()) &&
         set_string_property(env, *result, "objectPath",
                             item.object_path.c_str()) &&
         set_string_property(env, *result, "id", item.id.c_str()) &&
         set_string_property(env, *result, "title", item.title.c_str()) &&
         set_string_property(env, *result, "status", item.status.c_str()) &&
         set_string_property(env, *result, "iconName", item.icon_name.c_str()) &&
         set_string_property(env, *result, "accessibleId",
                             item.accessible_id.c_str());
}

napi_value tray_items(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  if (!read_process_id(env, args[0], &process_id)) {
    return make_undefined(env);
  }

  std::vector<gestament::TrayItemInfo> items;
  gestament::NativeError error = {};
  if (!gestament::list_tray_items(process_id, &items, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (napi_create_array_with_length(env, items.size(), &result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create tray item array.");
    return make_undefined(env);
  }

  for (std::size_t index = 0; index < items.size(); index += 1) {
    napi_value item = nullptr;
    if (!create_tray_item_object(env, items[index], &item) ||
        napi_set_element(env, result, index, item) != napi_ok) {
      napi_throw_error(env, nullptr, "Failed to set tray item array element.");
      return make_undefined(env);
    }
  }

  return result;
}

napi_value run_tray_host(napi_env env, napi_callback_info) {
  gestament::NativeError error = {};
  if (!gestament::run_tray_host(&error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value capture_by_id(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  std::string id;
  if (!read_process_id(env, args[0], &process_id) ||
      !read_string_argument(env, args[1], "id", &id)) {
    return make_undefined(env);
  }

  gestament::CaptureResult capture = {};
  gestament::NativeError error = {};
  if (!gestament::capture_accessible(process_id, id, &capture, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (napi_create_object(env, &result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create capture result object.");
    return make_undefined(env);
  }

  napi_value image = nullptr;
  if (napi_create_buffer_copy(env, capture.image.size(), capture.image.data(),
                              nullptr, &image) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create capture image buffer.");
    return make_undefined(env);
  }

  napi_value bounds = nullptr;
  napi_value visible_bounds = nullptr;
  if (!create_bounds_object(env, capture.bounds, &bounds) ||
      !create_bounds_object(env, capture.visible_bounds, &visible_bounds) ||
      !set_value_property(env, result, "image", image) ||
      !set_value_property(env, result, "bounds", bounds) ||
      !set_value_property(env, result, "visibleBounds", visible_bounds) ||
      !set_bool_property(env, result, "clipped", capture.clipped)) {
    return make_undefined(env);
  }

  return result;
}

napi_value window_count(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  if (!read_process_id(env, args[0], &process_id)) {
    return make_undefined(env);
  }

  gint count = 0;
  gestament::NativeError error = {};
  if (!gestament::count_windows(process_id, &count, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_create_int32(env, count, &result);
  return result;
}

napi_value window_at(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  guint process_id = 0;
  gint index = 0;
  if (!read_process_id(env, args[0], &process_id) ||
      !read_non_negative_index(env, args[1], "index", &index)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  gestament::AccessibleLookupResult lookup =
      gestament::find_window_by_index(process_id, index);
  if (lookup.accessible == nullptr) {
    if (lookup.error.code != gestament::NativeErrorCode::element_not_found) {
      throw_native_error(env, lookup.error);
    }
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_element_external(env, process_id, lookup.accessible, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value child_count(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gint count = 0;
  gestament::NativeError error = {};
  if (!gestament::count_accessible_children(
          element->process_id, element->accessible, &count, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_create_int32(env, count, &result);
  return result;
}

napi_value child_at(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint index = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "index", &index)) {
    return make_undefined(env);
  }

  gestament::AccessibleLookupResult lookup = gestament::get_accessible_child(
      element->process_id, element->accessible, index);
  if (lookup.accessible == nullptr) {
    if (lookup.error.code != gestament::NativeErrorCode::element_not_found) {
      throw_native_error(env, lookup.error);
    }
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_element_external(env, element->process_id, lookup.accessible,
                               &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value selected_child_count(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gint count = 0;
  gestament::NativeError error = {};
  if (!gestament::count_selected_accessible_children(
          element->process_id, element->accessible, &count, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_create_int32(env, count, &result);
  return result;
}

napi_value selected_child_at(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint index = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "index", &index)) {
    return make_undefined(env);
  }

  gestament::AccessibleLookupResult lookup =
      gestament::get_selected_accessible_child(
          element->process_id, element->accessible, index);
  if (lookup.accessible == nullptr) {
    if (lookup.error.code != gestament::NativeErrorCode::element_not_found) {
      throw_native_error(env, lookup.error);
    }
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_element_external(env, element->process_id, lookup.accessible,
                               &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value is_child_selected(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint index = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "index", &index)) {
    return make_undefined(env);
  }

  bool selected = false;
  gestament::NativeError error = {};
  if (!gestament::is_accessible_child_selected(
          element->process_id, element->accessible, index, &selected, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_get_boolean(env, selected, &result);
  return result;
}

napi_value select_child_at(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint index = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "index", &index)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::select_accessible_child(
          element->process_id, element->accessible, index, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value deselect_child_at(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint index = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "index", &index)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::deselect_accessible_child(
          element->process_id, element->accessible, index, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value select_all_children(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::select_all_accessible_children(
          element->process_id, element->accessible, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value clear_selection(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::clear_accessible_selection(
          element->process_id, element->accessible, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value table_row_count(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gint count = 0;
  gestament::NativeError error = {};
  if (!gestament::count_accessible_table_rows(
          element->process_id, element->accessible, &count, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_create_int32(env, count, &result);
  return result;
}

napi_value table_column_count(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gint count = 0;
  gestament::NativeError error = {};
  if (!gestament::count_accessible_table_columns(
          element->process_id, element->accessible, &count, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_create_int32(env, count, &result);
  return result;
}

napi_value table_cell_at(napi_env env, napi_callback_info info) {
  napi_value args[3] = {};
  if (!read_arguments(env, info, 3, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint row = 0;
  gint column = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "row", &row) ||
      !read_non_negative_index(env, args[2], "column", &column)) {
    return make_undefined(env);
  }

  gestament::AccessibleLookupResult lookup = gestament::get_accessible_table_cell(
      element->process_id, element->accessible, row, column);
  if (lookup.accessible == nullptr) {
    if (lookup.error.code != gestament::NativeErrorCode::element_not_found) {
      throw_native_error(env, lookup.error);
    }
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_element_external(env, element->process_id, lookup.accessible,
                               &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value table_selected_rows(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  std::vector<gint> rows;
  gestament::NativeError error = {};
  if (!gestament::read_accessible_table_selected_rows(
          element->process_id, element->accessible, &rows, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_int32_array(env, rows, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value table_selected_columns(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  std::vector<gint> columns;
  gestament::NativeError error = {};
  if (!gestament::read_accessible_table_selected_columns(
          element->process_id, element->accessible, &columns, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_int32_array(env, columns, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value table_is_row_selected(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint row = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "row", &row)) {
    return make_undefined(env);
  }

  bool selected = false;
  gestament::NativeError error = {};
  if (!gestament::is_accessible_table_row_selected(
          element->process_id, element->accessible, row, &selected, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_get_boolean(env, selected, &result);
  return result;
}

napi_value table_is_column_selected(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint column = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "column", &column)) {
    return make_undefined(env);
  }

  bool selected = false;
  gestament::NativeError error = {};
  if (!gestament::is_accessible_table_column_selected(
          element->process_id, element->accessible, column, &selected,
          &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_get_boolean(env, selected, &result);
  return result;
}

napi_value table_is_cell_selected(napi_env env, napi_callback_info info) {
  napi_value args[3] = {};
  if (!read_arguments(env, info, 3, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint row = 0;
  gint column = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "row", &row) ||
      !read_non_negative_index(env, args[2], "column", &column)) {
    return make_undefined(env);
  }

  bool selected = false;
  gestament::NativeError error = {};
  if (!gestament::is_accessible_table_cell_selected(
          element->process_id, element->accessible, row, column, &selected,
          &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_get_boolean(env, selected, &result);
  return result;
}

napi_value table_select_row(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint row = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "row", &row)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::select_accessible_table_row(
          element->process_id, element->accessible, row, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value table_deselect_row(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint row = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "row", &row)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::deselect_accessible_table_row(
          element->process_id, element->accessible, row, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value table_select_column(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint column = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "column", &column)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::select_accessible_table_column(
          element->process_id, element->accessible, column, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value table_deselect_column(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint column = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_non_negative_index(env, args[1], "column", &column)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::deselect_accessible_table_column(
          element->process_id, element->accessible, column, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value set_text(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  std::string text;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_string_argument(env, args[1], "text", &text)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::set_accessible_proxy_text(element->process_id,
                                            element->accessible, text, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value click(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::click_accessible_proxy(element->process_id,
                                         element->accessible, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value activate_window(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::activate_accessible_proxy_window(
          element->process_id, element->accessible, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value input_set_modifier(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  std::string modifier;
  bool pressed = false;
  if (!read_string_argument(env, args[0], "modifier", &modifier) ||
      !read_bool_argument(env, args[1], "pressed", &pressed)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::input_set_modifier(modifier, pressed, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value input_press_key_name(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  std::string key;
  if (!read_string_argument(env, args[0], "key", &key)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::input_press_key_name(key, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value input_press_key_sym(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  guint keysym = 0;
  if (!read_uint32_argument(env, args[0], "keysym", &keysym)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::input_press_key_sym(keysym, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value input_move_mouse(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  gint x = 0;
  gint y = 0;
  if (!read_int32_argument(env, args[0], "x", &x) ||
      !read_int32_argument(env, args[1], "y", &y)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::input_move_mouse(x, y, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value input_set_mouse_button(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  std::string button;
  bool pressed = false;
  if (!read_string_argument(env, args[0], "button", &button) ||
      !read_bool_argument(env, args[1], "pressed", &pressed)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::input_set_mouse_button(button, pressed, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value input_scroll_wheel(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  gint x_steps = 0;
  gint y_steps = 0;
  if (!read_int32_argument(env, args[0], "xSteps", &x_steps) ||
      !read_int32_argument(env, args[1], "ySteps", &y_steps)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::input_scroll_wheel(x_steps, y_steps, &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value text(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  std::string text;
  gestament::NativeError error = {};
  if (!gestament::read_accessible_proxy_text(
          element->process_id, element->accessible, &text, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  napi_create_string_utf8(env, text.c_str(), text.size(), &result);
  return result;
}

napi_value value_info(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::AccessibleValueInfo value = {};
  gestament::NativeError error = {};
  if (!gestament::read_accessible_proxy_value_info(
          element->process_id, element->accessible, &value, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_value_info_object(env, value, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value image_info(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::AccessibleImageInfo image = {};
  gestament::NativeError error = {};
  if (!gestament::read_accessible_proxy_image_info(
          element->process_id, element->accessible, &image, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_image_info_object(env, image, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value set_value(napi_env env, napi_callback_info info) {
  napi_value args[2] = {};
  if (!read_arguments(env, info, 2, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gdouble value = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_double_argument(env, args[1], "value", &value)) {
    return make_undefined(env);
  }

  gestament::NativeError error = {};
  if (!gestament::set_accessible_proxy_value(element->process_id,
                                             element->accessible, value,
                                             &error)) {
    throw_native_error(env, error);
  }

  return make_undefined(env);
}

napi_value capture(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::CaptureResult capture = {};
  gestament::NativeError error = {};
  if (!gestament::capture_accessible_proxy(
          element->process_id, element->accessible, &capture, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_capture_object(env, capture, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value capture_screen(napi_env env, napi_callback_info) {
  gestament::CaptureResult capture = {};
  gestament::NativeError error = {};
  if (!gestament::capture_screen(&capture, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_capture_object(env, capture, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value capture_bounds(napi_env env, napi_callback_info info) {
  napi_value args[4] = {};
  if (!read_arguments(env, info, 4, args)) {
    return make_undefined(env);
  }

  gestament::CaptureBounds bounds = {};
  if (!read_int32_argument(env, args[0], "x", &bounds.x) ||
      !read_int32_argument(env, args[1], "y", &bounds.y) ||
      !read_positive_int32_argument(env, args[2], "width", &bounds.width) ||
      !read_positive_int32_argument(env, args[3], "height", &bounds.height)) {
    return make_undefined(env);
  }

  gestament::CaptureResult capture = {};
  gestament::NativeError error = {};
  if (!gestament::capture_screen_bounds(bounds, &capture, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_capture_object(env, capture, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value bounds(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::CaptureBounds capture_bounds = {};
  gestament::NativeError error = {};
  if (!gestament::read_accessible_proxy_bounds(
          element->process_id, element->accessible, &capture_bounds, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_bounds_object(env, capture_bounds, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value move_window(napi_env env, napi_callback_info info) {
  napi_value args[3] = {};
  if (!read_arguments(env, info, 3, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint x = 0;
  gint y = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_int32_argument(env, args[1], "x", &x) ||
      !read_int32_argument(env, args[2], "y", &y)) {
    return make_undefined(env);
  }

  gestament::CaptureBounds actual_bounds = {};
  gestament::NativeError error = {};
  if (!gestament::move_accessible_proxy_window(
          element->process_id, element->accessible, x, y, &actual_bounds,
          &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_bounds_object(env, actual_bounds, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value resize_window(napi_env env, napi_callback_info info) {
  napi_value args[3] = {};
  if (!read_arguments(env, info, 3, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gint width = 0;
  gint height = 0;
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_positive_int32_argument(env, args[1], "width", &width) ||
      !read_positive_int32_argument(env, args[2], "height", &height)) {
    return make_undefined(env);
  }

  gestament::CaptureBounds actual_bounds = {};
  gestament::NativeError error = {};
  if (!gestament::resize_accessible_proxy_window(
          element->process_id, element->accessible, width, height,
          &actual_bounds, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_bounds_object(env, actual_bounds, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value set_window_bounds(napi_env env, napi_callback_info info) {
  napi_value args[5] = {};
  if (!read_arguments(env, info, 5, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  gestament::CaptureBounds requested_bounds = {};
  if (!read_native_element(env, args[0], "element", &element) ||
      !read_int32_argument(env, args[1], "x", &requested_bounds.x) ||
      !read_int32_argument(env, args[2], "y", &requested_bounds.y) ||
      !read_positive_int32_argument(env, args[3], "width",
                                    &requested_bounds.width) ||
      !read_positive_int32_argument(env, args[4], "height",
                                    &requested_bounds.height)) {
    return make_undefined(env);
  }

  gestament::CaptureBounds actual_bounds = {};
  gestament::NativeError error = {};
  if (!gestament::set_accessible_proxy_window_bounds(
          element->process_id, element->accessible, requested_bounds,
          &actual_bounds, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_bounds_object(env, actual_bounds, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value resize_hints(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::WindowResizeHints hints = {};
  gestament::NativeError error = {};
  if (!gestament::read_accessible_proxy_resize_hints(
          element->process_id, element->accessible, &hints, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_resize_hints_object(env, hints, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value x11_info(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::X11WindowInfo window_info = {};
  gestament::NativeError error = {};
  if (!gestament::read_accessible_proxy_x11_info(
          element->process_id, element->accessible, &window_info, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_x11_window_info_object(env, window_info, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value mapped_x11_window_count(napi_env env, napi_callback_info) {
  guint count = 0;
  gestament::NativeError error = {};
  if (!gestament::count_mapped_x11_windows(&count, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (napi_create_uint32(env, count, &result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create X11 window count value.");
    return make_undefined(env);
  }
  return result;
}

napi_value element_info(napi_env env, napi_callback_info info) {
  napi_value args[1] = {};
  if (!read_arguments(env, info, 1, args)) {
    return make_undefined(env);
  }

  NativeElement *element = nullptr;
  if (!read_native_element(env, args[0], "element", &element)) {
    return make_undefined(env);
  }

  gestament::AccessibleInfo accessible_info = {};
  gestament::NativeError error = {};
  if (!gestament::read_accessible_proxy_info(
          element->process_id, element->accessible, &accessible_info, &error)) {
    throw_native_error(env, error);
    return make_undefined(env);
  }

  napi_value result = nullptr;
  if (!create_element_info_object(env, accessible_info, &result)) {
    return make_undefined(env);
  }
  return result;
}

napi_value native_info(napi_env env, napi_callback_info) {
  napi_value result = nullptr;
  if (napi_create_object(env, &result) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create native info object.");
    return make_undefined(env);
  }

  if (!set_string_property(env, result, "version",
                           native_version_marker +
                               native_version_prefix_length) ||
      !set_string_property(env, result, "arch", GESTAMENT_NATIVE_ARCH) ||
      !set_string_property(env, result, "gtkBackend",
                           GESTAMENT_NATIVE_GTK_BACKEND)) {
    return make_undefined(env);
  }

  napi_value napi_version = nullptr;
  if (napi_create_uint32(env, NAPI_VERSION, &napi_version) != napi_ok ||
      napi_set_named_property(env, result, "napiVersion", napi_version) !=
          napi_ok) {
    napi_throw_error(env, nullptr, "Failed to set native info value.");
    return make_undefined(env);
  }

  return result;
}

/////////////////////////////////////////////////////////////////////////////////////////

bool set_function(napi_env env, napi_value exports, const char *name,
                  napi_callback callback) {
  napi_value function = nullptr;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr,
                           &function) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create native function.");
    return false;
  }

  if (napi_set_named_property(env, exports, name, function) != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to export native function.");
    return false;
  }

  return true;
}

napi_value initialize(napi_env env, napi_value exports) {
  set_function(env, exports, "findById", find_by_id);
  set_function(env, exports, "processAtspiReadiness", process_atspi_readiness);
  set_function(env, exports, "findAnyById", find_any_by_id);
  set_function(env, exports, "setTextById", set_text_by_id);
  set_function(env, exports, "clickById", click_by_id);
  set_function(env, exports, "textById", text_by_id);
  set_function(env, exports, "captureById", capture_by_id);
  set_function(env, exports, "windowCount", window_count);
  set_function(env, exports, "windowAt", window_at);
  set_function(env, exports, "childCount", child_count);
  set_function(env, exports, "childAt", child_at);
  set_function(env, exports, "selectedChildCount", selected_child_count);
  set_function(env, exports, "selectedChildAt", selected_child_at);
  set_function(env, exports, "isChildSelected", is_child_selected);
  set_function(env, exports, "selectChildAt", select_child_at);
  set_function(env, exports, "deselectChildAt", deselect_child_at);
  set_function(env, exports, "selectAllChildren", select_all_children);
  set_function(env, exports, "clearSelection", clear_selection);
  set_function(env, exports, "tableRowCount", table_row_count);
  set_function(env, exports, "tableColumnCount", table_column_count);
  set_function(env, exports, "tableCellAt", table_cell_at);
  set_function(env, exports, "tableSelectedRows", table_selected_rows);
  set_function(env, exports, "tableSelectedColumns", table_selected_columns);
  set_function(env, exports, "tableIsRowSelected", table_is_row_selected);
  set_function(env, exports, "tableIsColumnSelected",
               table_is_column_selected);
  set_function(env, exports, "tableIsCellSelected", table_is_cell_selected);
  set_function(env, exports, "tableSelectRow", table_select_row);
  set_function(env, exports, "tableDeselectRow", table_deselect_row);
  set_function(env, exports, "tableSelectColumn", table_select_column);
  set_function(env, exports, "tableDeselectColumn", table_deselect_column);
  set_function(env, exports, "setText", set_text);
  set_function(env, exports, "click", click);
  set_function(env, exports, "activateWindow", activate_window);
  set_function(env, exports, "inputSetModifier", input_set_modifier);
  set_function(env, exports, "inputPressKeyName", input_press_key_name);
  set_function(env, exports, "inputPressKeySym", input_press_key_sym);
  set_function(env, exports, "inputMoveMouse", input_move_mouse);
  set_function(env, exports, "inputSetMouseButton", input_set_mouse_button);
  set_function(env, exports, "inputScrollWheel", input_scroll_wheel);
  set_function(env, exports, "text", text);
  set_function(env, exports, "valueInfo", value_info);
  set_function(env, exports, "imageInfo", image_info);
  set_function(env, exports, "setValue", set_value);
  set_function(env, exports, "capture", capture);
  set_function(env, exports, "bounds", bounds);
  set_function(env, exports, "moveWindow", move_window);
  set_function(env, exports, "resizeWindow", resize_window);
  set_function(env, exports, "setWindowBounds", set_window_bounds);
  set_function(env, exports, "resizeHints", resize_hints);
  set_function(env, exports, "x11Info", x11_info);
  set_function(env, exports, "captureScreen", capture_screen);
  set_function(env, exports, "captureBounds", capture_bounds);
  set_function(env, exports, "mappedX11WindowCount", mapped_x11_window_count);
  set_function(env, exports, "elementInfo", element_info);
  set_function(env, exports, "trayItems", tray_items);
  set_function(env, exports, "runTrayHost", run_tray_host);
  set_function(env, exports, "nativeInfo", native_info);
  return exports;
}

}  // namespace

NAPI_MODULE(gestament_native, initialize)
