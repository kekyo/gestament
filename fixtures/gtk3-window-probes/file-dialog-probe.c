#include <atk/atk.h>
#include <gtk/gtk.h>
#include <string.h>

#define PROBE_TIMEOUT_SECONDS 180

static gboolean quit_later(gpointer user_data) {
  (void)user_data;
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);

  const gboolean use_parent =
      argc > 1 && strcmp(argv[1], "--parent") == 0;
  GtkWidget *parent = NULL;
  if (use_parent) {
    parent = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(parent), "Gestament Merge Probe Parent");
    gtk_window_set_default_size(GTK_WINDOW(parent), 320, 160);
    AtkObject *parent_accessible = gtk_widget_get_accessible(parent);
    atk_object_set_name(parent_accessible, "Gestament Merge Probe Parent");
    gtk_widget_show_all(parent);
  }

  GtkWidget *dialog = gtk_file_chooser_dialog_new(
      "Gestament Merge Probe File Dialog",
      use_parent ? GTK_WINDOW(parent) : NULL, GTK_FILE_CHOOSER_ACTION_OPEN,
      "_Cancel", GTK_RESPONSE_CANCEL, "_Open", GTK_RESPONSE_ACCEPT, NULL);
  gtk_window_set_default_size(GTK_WINDOW(dialog), 640, 480);
  AtkObject *dialog_accessible = gtk_widget_get_accessible(dialog);
  atk_object_set_name(dialog_accessible,
                      "Gestament Merge Probe File Dialog");
  gtk_widget_show_all(dialog);

  g_timeout_add_seconds(PROBE_TIMEOUT_SECONDS, quit_later, NULL);
  gtk_main();
  return 0;
}
