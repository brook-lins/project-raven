#!/bin/bash
set -e

# Build libwebrtc-audio-processing 1.x as static libraries into deps/.
# build-webrtcdsp-plugin.sh links the GStreamer webrtcdsp plugin against
# these, so the plugin carries WebRTC AEC3 with it and the app does not
# depend on a system copy.
#
# Needs: git, meson, ninja (macOS: brew install meson ninja).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="${DEPS_DIR:-$SCRIPT_DIR/deps}"
WAP_VERSION="v1.3"
SRC_DIR="${TMPDIR:-/tmp}/webrtc-audio-processing-$WAP_VERSION"

for tool in git meson ninja; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: $tool not found. On macOS: brew install meson ninja"
        exit 1
    fi
done

if [ ! -f "$SRC_DIR/meson.build" ]; then
    echo "Cloning webrtc-audio-processing $WAP_VERSION..."
    rm -rf "$SRC_DIR"
    git clone --depth 1 --branch "$WAP_VERSION" \
        https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing.git "$SRC_DIR"
fi

# forcefallback builds the bundled abseil as static libraries too, rather
# than linking whatever abseil happens to be installed.
BUILD_DIR="$SRC_DIR/build"
if [ ! -f "$BUILD_DIR/build.ninja" ]; then
    meson setup "$BUILD_DIR" "$SRC_DIR" \
        --default-library=static --buildtype=release \
        --prefix="$DEPS_DIR" --wrap-mode=forcefallback
fi
ninja -C "$BUILD_DIR"
ninja -C "$BUILD_DIR" install

# The install step only ships the public library. The plugin also links the
# internal helper archives and abseil, and needs abseil's headers.
mkdir -p "$DEPS_DIR/lib" "$DEPS_DIR/include"
find "$BUILD_DIR" -name "*.a" -exec cp {} "$DEPS_DIR/lib/" \;
ABSL_SRC="$(find "$SRC_DIR/subprojects" -maxdepth 1 -type d -name 'abseil-cpp-*' | head -1)"
(cd "$ABSL_SRC" && find absl \( -name "*.h" -o -name "*.inc" \) -print0 | cpio -0pdm "$DEPS_DIR/include" 2>/dev/null)

echo "webrtc-audio-processing installed to $DEPS_DIR"
