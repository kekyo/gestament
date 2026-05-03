CXX ?= c++
NODE_INCLUDE_DIR ?=
GESTAMENT_PACKAGE_VERSION ?=
GESTAMENT_NATIVE_ARCH ?= unknown
GESTAMENT_GTK_BACKEND ?= gtk3
OUT_DIR ?= out
TARGET ?= $(OUT_DIR)/gestament_native.node

SOURCES := addon.cc atspi_client.cc accessible.cc tray.cc
OBJECTS := $(SOURCES:%.cc=$(OUT_DIR)/%.o)

COMMON_PKGS := atspi-2 glib-2.0 gio-2.0 gdk-pixbuf-2.0 x11 xtst

ifeq ($(GESTAMENT_GTK_BACKEND),gtk3)
GTK_PKGS := gtk+-3.0 gdk-3.0
GTK_BACKEND_DEFINE := -DGESTAMENT_GTK_BACKEND_GTK3=1 -DGESTAMENT_GTK_BACKEND_GTK4=0
else ifeq ($(GESTAMENT_GTK_BACKEND),gtk4)
GTK_PKGS := gtk4
GTK_BACKEND_DEFINE := -DGESTAMENT_GTK_BACKEND_GTK3=0 -DGESTAMENT_GTK_BACKEND_GTK4=1
GTK4_VERSION_OK := $(shell pkg-config --atleast-version=4.22 gtk4 >/dev/null 2>&1 && echo yes)
ifneq ($(GTK4_VERSION_OK),yes)
$(error GTK4 backend requires gtk4 >= 4.22)
endif
else
$(error Unsupported GESTAMENT_GTK_BACKEND: $(GESTAMENT_GTK_BACKEND). Expected gtk3 or gtk4)
endif

PKG_CFLAGS := $(shell pkg-config --cflags $(COMMON_PKGS) $(GTK_PKGS))
PKG_LIBS := $(shell pkg-config --libs $(COMMON_PKGS) $(GTK_PKGS))

ifneq ($(MAKECMDGOALS),clean)
ifeq ($(strip $(NODE_INCLUDE_DIR)),)
$(error NODE_INCLUDE_DIR is required)
endif
ifeq ($(strip $(GESTAMENT_PACKAGE_VERSION)),)
$(error GESTAMENT_PACKAGE_VERSION is required)
endif
endif

CXXFLAGS ?= -O2
CXXFLAGS += -std=c++20 -fPIC -Wall -Wextra -DNAPI_VERSION=8 \
	-DGESTAMENT_PACKAGE_VERSION=\"$(GESTAMENT_PACKAGE_VERSION)\" \
	-DGESTAMENT_NATIVE_ARCH=\"$(GESTAMENT_NATIVE_ARCH)\" \
	-DGESTAMENT_NATIVE_GTK_BACKEND=\"$(GESTAMENT_GTK_BACKEND)\" \
	$(GTK_BACKEND_DEFINE) \
	-I$(NODE_INCLUDE_DIR) $(PKG_CFLAGS)
LDFLAGS += -shared
LDLIBS += $(PKG_LIBS)

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(OBJECTS)
	$(CXX) $(LDFLAGS) -o $@ $^ $(LDLIBS)

$(OUT_DIR)/%.o: %.cc
	mkdir -p $(OUT_DIR)
	$(CXX) $(CXXFLAGS) -MMD -MP -c -o $@ $<

clean:
	rm -rf $(OUT_DIR)

-include $(OBJECTS:.o=.d)
