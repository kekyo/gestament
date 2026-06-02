#include <errno.h>
#include <gestament/gtk.h>
#include <gtk/gtk.h>
#include <signal.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define PROBE_TIMEOUT_SECONDS 180

static pid_t child_pid = -1;

static gboolean quit_later(gpointer user_data) {
  (void)user_data;
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

static void terminate_parent(int signal_number) {
  (void)signal_number;
  if (child_pid > 0) {
    kill(child_pid, SIGTERM);
  }
  _exit(0);
}

static int run_child(int argc, char **argv) {
  gtk_init(&argc, &argv);

  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(window), "Gestament Child Process Window");
  gtk_window_set_default_size(GTK_WINDOW(window), 280, 120);
  gestament_gtk_assign_accessible_id(window, "child_process_window");

  GtkWidget *button = gtk_button_new_with_label("Child process button");
  gestament_gtk_assign_accessible_id(button, "child_process_button");
  gtk_container_add(GTK_CONTAINER(window), button);

  gtk_widget_show_all(window);
  g_timeout_add_seconds(PROBE_TIMEOUT_SECONDS, quit_later, NULL);
  gtk_main();
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--child") == 0) {
    return run_child(argc, argv);
  }

  signal(SIGTERM, terminate_parent);
  signal(SIGINT, terminate_parent);

  child_pid = fork();
  if (child_pid < 0) {
    return 1;
  }

  if (child_pid == 0) {
    execl(argv[0], argv[0], "--child", (char *)NULL);
    _exit(127);
  }

  while (1) {
    int status = 0;
    const pid_t result = waitpid(child_pid, &status, 0);
    if (result == child_pid) {
      return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
    }
    if (result < 0 && errno != EINTR) {
      return 1;
    }
  }
}
