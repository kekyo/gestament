#include <atk/atk.h>
#include <gtk/gtk.h>

#define PROBE_TIMEOUT_SECONDS 180

static gboolean quit_later(gpointer user_data) {
  (void)user_data;
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

static GtkWidget *create_window(int x, int y, int width, int height) {
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(window), "Gestament Same Title");
  gtk_window_set_default_size(GTK_WINDOW(window), width, height);
  AtkObject *accessible = gtk_widget_get_accessible(window);
  atk_object_set_name(accessible, "Gestament Same Title");
  gtk_window_move(GTK_WINDOW(window), x, y);
  gtk_widget_show_all(window);
  return window;
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);

  create_window(0, 0, 220, 120);
  create_window(320, 180, 260, 160);
  while (gtk_events_pending()) {
    gtk_main_iteration();
  }

  g_timeout_add_seconds(PROBE_TIMEOUT_SECONDS, quit_later, NULL);
  gtk_main();
  return 0;
}
