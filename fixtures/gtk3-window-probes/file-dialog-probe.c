#include <atk/atk.h>
#include <gtk/gtk.h>
#include <string.h>

#define PROBE_TIMEOUT_SECONDS 180

static gboolean quit_later(gpointer user_data) {
  (void)user_data;
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

static gboolean has_arg(int argc, char **argv, const char *name) {
  for (int index = 1; index < argc; index++) {
    if (strcmp(argv[index], name) == 0) {
      return TRUE;
    }
  }
  return FALSE;
}

static void on_dialog_response(GtkDialog *dialog,
                               gint response_id,
                               gpointer user_data) {
  (void)dialog;
  (void)user_data;
  if (response_id == GTK_RESPONSE_ACCEPT) {
    g_print("response=accept\n");
  } else if (response_id == GTK_RESPONSE_CANCEL) {
    g_print("response=cancel\n");
  } else {
    g_print("response=%d\n", response_id);
  }
  gtk_main_quit();
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);

  const gboolean use_parent = has_arg(argc, argv, "--parent");
  const gboolean use_default_file = has_arg(argc, argv, "--default-file");
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
  g_signal_connect(dialog, "response", G_CALLBACK(on_dialog_response), NULL);
  if (use_default_file) {
    gchar *default_path = g_build_filename(
        g_get_tmp_dir(), "gestament-file-dialog-probe-selected.txt", NULL);
    g_file_set_contents(default_path, "selected", -1, NULL);
    gtk_file_chooser_set_filename(GTK_FILE_CHOOSER(dialog), default_path);
    g_free(default_path);
  }
  gtk_widget_show_all(dialog);

  g_timeout_add_seconds(PROBE_TIMEOUT_SECONDS, quit_later, NULL);
  gtk_main();
  return 0;
}
