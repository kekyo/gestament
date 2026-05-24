/*
 * gestament - TypeScript based test driver for GTK.
 * Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
 * Under MIT.
 * https://github.com/kekyo/gestament
 */

#ifndef GESTAMENT_GTK_H
#define GESTAMENT_GTK_H

#include <gtk/gtk.h>

#if GTK_MAJOR_VERSION < 4
#include <atk/atk.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

static inline gboolean gestament_gtk_id_is_available(const char *id) {
  return id != NULL && id[0] != '\0';
}

/**
 * Assigns a stable accessible id to a GTK widget.
 *
 * @param widget GTK widget to expose to gestament.
 * @param id Stable id used by gestament tests.
 *
 * The id is also assigned as the widget name so CSS/debugging tools show the
 * same stable identifier. GTK3 exposes this value through ATK accessible id.
 * GTK4 does not provide a public API for assigning an AT-SPI AccessibleId to a
 * programmatically-created widget, so use GtkBuilder object ids when GTK4
 * getById() support is required. Invalid or empty arguments are ignored.
 */
static inline void gestament_gtk_assign_accessible_id(GtkWidget *widget,
                                                      const char *id) {
  if (widget == NULL || !GTK_IS_WIDGET(widget) ||
      !gestament_gtk_id_is_available(id)) {
    return;
  }

  gtk_widget_set_name(widget, id);

#if GTK_MAJOR_VERSION >= 4
  if (g_object_class_find_property(G_OBJECT_GET_CLASS(widget),
                                   "accessible-id") != NULL) {
    g_object_set(widget, "accessible-id", id, NULL);
  }
#else
  AtkObject *accessible = gtk_widget_get_accessible(widget);
  if (accessible != NULL) {
    atk_object_set_accessible_id(accessible, id);
  }
#endif
}

/**
 * Assigns a GTK widget's GtkBuilder id as its accessible id.
 *
 * @param widget GTK widget created by GtkBuilder.
 * @return TRUE when a non-empty GtkBuilder id was found and assigned.
 */
static inline gboolean
gestament_gtk_assign_accessible_id_from_buildable(GtkWidget *widget) {
  if (widget == NULL || !GTK_IS_WIDGET(widget) || !GTK_IS_BUILDABLE(widget)) {
    return FALSE;
  }

#if GTK_MAJOR_VERSION >= 4
  const char *id = gtk_buildable_get_buildable_id(GTK_BUILDABLE(widget));
#else
  const char *id = gtk_buildable_get_name(GTK_BUILDABLE(widget));
#endif

  if (!gestament_gtk_id_is_available(id)) {
    return FALSE;
  }

  gestament_gtk_assign_accessible_id(widget, id);
  return TRUE;
}

/**
 * Assigns GtkBuilder ids as accessible ids for every widget in a builder.
 *
 * @param builder GtkBuilder containing the application UI.
 * @return Number of widgets whose accessible id was assigned.
 */
static inline guint
gestament_gtk_assign_accessible_ids_from_builder(GtkBuilder *builder) {
  if (builder == NULL || !GTK_IS_BUILDER(builder)) {
    return 0;
  }

  guint assigned_count = 0;
  GSList *objects = gtk_builder_get_objects(builder);
  for (GSList *node = objects; node != NULL; node = node->next) {
    if (GTK_IS_WIDGET(node->data) &&
        gestament_gtk_assign_accessible_id_from_buildable(
            GTK_WIDGET(node->data))) {
      assigned_count += 1;
    }
  }
  g_slist_free(objects);

  return assigned_count;
}

#ifdef __cplusplus
}
#endif

#endif
