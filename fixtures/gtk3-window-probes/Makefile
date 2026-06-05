OUT_DIR ?= ../../.build/gtk3-window-probes
CC ?= gcc
PKG_CONFIG ?= pkg-config

GTK_CFLAGS := $(shell $(PKG_CONFIG) --cflags gtk+-3.0)
GTK_LIBS := $(shell $(PKG_CONFIG) --libs gtk+-3.0)
CFLAGS += -std=c99 -Wall -Wextra -O3 -I../../include $(GTK_CFLAGS)

TARGETS := file-dialog-probe same-title-probe child-process-probe

.PHONY: all clean

all: $(addprefix $(OUT_DIR)/,$(TARGETS))

$(OUT_DIR):
	mkdir -p $@

$(OUT_DIR)/%: %.c | $(OUT_DIR)
	$(CC) $(CFLAGS) $< -o $@ $(GTK_LIBS)

clean:
	rm -rf $(OUT_DIR)
