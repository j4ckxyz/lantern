#!/usr/bin/env bash
# Turn a fresh Raspberry Pi OS Lite (64-bit, Trixie) into the Lantern desk.
#
#   sudo bash install.sh --bundle lantern-0.2.0-arm64.tar.zst [--rotate 90] [--lock-ssh] [--yes]
#
# --rotate turns the screen: 90 or 270 is landscape, one for each way up (the default is 90);
# 0 keeps the panel's native portrait. Run again with the other value if the picture is upside down.
#
# What it does, in order (each step is safe to run again):
#   1. installs cage, Chromium, Plymouth, PipeWire, emoji fonts, zram and Tailscale
#   2. makes two accounts: `lantern` (the service, holds the sign-in) and `kiosk` (the screen)
#   3. installs the release from the bundle into /opt/lantern/releases/<version>
#   4. sets the boot up for the Touch Display 2 and a quiet, splash-only start
#      (config.txt and cmdline.txt are backed up first; changes sit in a marked block),
#      and turns the screen and its touch to the chosen way round
#   5. keeps logs and swap in RAM so the SD card is written as little as possible
#   6. starts the service and the screen at boot
#   7. with --lock-ssh, and only once Tailscale SSH works: turns OpenSSH off
#
# Build a bundle on your Mac or in CI with device/build-bundle.sh.

set -euo pipefail

BUNDLE=""
LOCK_SSH=0
ASSUME_YES=0
BOOT_CONFIG=1
ROTATE=90
PREFIX=/opt/lantern
BOOT=/boot/firmware

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --bundle) BUNDLE="${2:-}"; shift ;;
        --rotate) ROTATE="${2:-}"; shift ;;
        --lock-ssh) LOCK_SSH=1 ;;
        --no-boot-config) BOOT_CONFIG=0 ;;
        --yes|-y) ASSUME_YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
done
case "$ROTATE" in 0|90|180|270) ;; *) die "--rotate takes 0, 90, 180 or 270" ;; esac

confirm() {
    [ "$ASSUME_YES" = 1 ] && return 0
    local answer
    printf '%s [y/N] ' "$1"
    read -r answer </dev/tty || true
    case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

preflight() {
    [ "$(id -u)" -eq 0 ] || die "Run this with sudo."
    [ -n "$BUNDLE" ] && [ -f "$BUNDLE" ] || die "Give the release bundle: --bundle lantern-<version>-arm64.tar.zst"
    [ "$(uname -m)" = aarch64 ] || warn "This is $(uname -m), not 64-bit ARM; the desk is built for a Raspberry Pi 4 or 5."
    # shellcheck disable=SC1091
    . /etc/os-release
    [ "${VERSION_CODENAME:-}" = trixie ] || warn "This is ${PRETTY_NAME:-an unknown system}; the desk is tested on Raspberry Pi OS Trixie."
    [ -d "$BOOT" ] || BOOT=/boot
    say "Installing the Lantern desk on $(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo 'this machine')"
}

install_packages() {
    say "Installing system packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends \
        cage wlr-randr chromium plymouth pipewire pipewire-pulse wireplumber fonts-noto-color-emoji \
        zram-tools python3-venv python3-pip zstd curl ca-certificates
    if ! command -v tailscale >/dev/null 2>&1; then
        say "Installing Tailscale (from tailscale.com)"
        curl -fsSL https://tailscale.com/install.sh | sh
    fi
}

make_accounts() {
    say "Making the lantern and kiosk accounts"
    getent group lantern >/dev/null || groupadd --system lantern
    id lantern >/dev/null 2>&1 || useradd --system --gid lantern --home-dir /var/lib/lantern \
        --shell /usr/sbin/nologin lantern
    id kiosk >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/kiosk \
        --shell /usr/sbin/nologin kiosk
    # The screen needs the display, input and sound; and the start URL, which group lantern can read.
    usermod -a -G video,render,input,audio,lantern kiosk
    install -d -m 0700 -o lantern -g lantern /var/lib/lantern
}

install_release() {
    local work version
    work="$(mktemp -d)"
    say "Unpacking $BUNDLE"
    tar --zstd -xf "$BUNDLE" -C "$work"
    local root
    root="$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -n1)"
    [ -f "$root/VERSION" ] || die "That bundle has no VERSION file."
    (cd "$root" && sha256sum --quiet -c SHA256SUMS) || die "The bundle's checksums do not match; it may be damaged."
    version="$(cat "$root/VERSION")"
    local target="$PREFIX/releases/$version"
    say "Installing release $version into $target"
    rm -rf "$target"
    install -d "$PREFIX/releases"
    cp -a "$root" "$target"
    python3 -m venv "$target/venv"
    "$target/venv/bin/pip" install --quiet --no-index --find-links "$target/wheels" lantern
    chmod 0755 "$target/device/kiosk.sh"
    ln -sfn "$target" "$PREFIX/current.new"
    mv -T "$PREFIX/current.new" "$PREFIX/current"
    install -m 0755 "$target/device/system/lantern-admin" /usr/local/bin/lantern
    rm -rf "$work"
    # Keep the two newest releases for rollback.
    find "$PREFIX/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn |
        tail -n +3 | cut -d' ' -f2- | xargs -r -d '\n' rm -rf
}

configure_boot() {
    [ "$BOOT_CONFIG" = 1 ] || { warn "Leaving config.txt and cmdline.txt alone (--no-boot-config)."; return; }
    local config="$BOOT/config.txt" cmdline="$BOOT/cmdline.txt" stamp
    stamp="$(date +%Y%m%d-%H%M%S)"
    say "Setting up the boot for the Touch Display 2 and a quiet start (backups: *.lantern-$stamp)"
    cp "$config" "$config.lantern-$stamp"
    cp "$cmdline" "$cmdline.lantern-$stamp"
    # One marked block in config.txt, replaced on every run.
    sed -i '/^# lantern begin/,/^# lantern end/d' "$config"
    local kms=""
    grep -q '^dtoverlay=vc4-kms-v3d' "$config" || kms="dtoverlay=vc4-kms-v3d"
    local block
    block="$(printf '%s\n' "# lantern begin (managed by the Lantern installer; edit outside this block)" "[all]" \
        $kms "dtoverlay=vc4-kms-dsi-ili9881-5inch" "disable_splash=1" "# lantern end")"
    printf '%s\n' "$block" >>"$config"
    # cmdline.txt is one line: hide boot text on the screen (kernel messages go to tty3) and repair
    # the filesystem by itself after a power cut.
    local line
    line="$(tr -d '\n' <"$cmdline")"
    line="$(echo "$line" | sed -E 's/(^| )console=tty1( |$)/\1console=tty3\2/')"
    for token in quiet splash loglevel=3 logo.nologo vt.global_cursor_default=0 consoleblank=0 \
                 plymouth.ignore-serial-consoles fsck.repair=yes; do
        case " $line " in *" $token "*) ;; *) line="$line $token" ;; esac
    done
    echo "$line" >"$cmdline"
}

configure_display() {
    say "Turning the screen to $ROTATE degrees ($( [ "$ROTATE" = 0 ] || [ "$ROTATE" = 180 ] && echo portrait || echo landscape))"
    # The kiosk reads this at start and turns the output inside cage (kiosk.sh).
    install -d /etc/lantern
    printf '%s\n' "# The desk's screen orientation, read by the kiosk at start. 90 and 270 are landscape" \
        "# (one for each way up), 0 is the panel's native portrait. Set by install.sh --rotate." \
        "ROTATE=$ROTATE" >/etc/lantern/display
    # Touch must turn with the picture: libinput reads this matrix for any touchscreen.
    local matrix
    case "$ROTATE" in
        0) matrix="1 0 0 0 1 0" ;;
        90) matrix="0 -1 1 1 0 0" ;;
        180) matrix="-1 0 1 0 -1 1" ;;
        270) matrix="0 1 0 -1 0 1" ;;
    esac
    printf '%s\n' "# Turns touch to match the screen (install.sh --rotate $ROTATE)." \
        "ENV{ID_INPUT_TOUCHSCREEN}==\"1\", ENV{LIBINPUT_CALIBRATION_MATRIX}=\"$matrix\"" \
        >/etc/udev/rules.d/90-lantern-touch.rules
    udevadm control --reload 2>/dev/null || true
    udevadm trigger --subsystem-match=input 2>/dev/null || true
}

install_splash() {
    say "Installing the boot splash"
    install -d /usr/share/plymouth/themes/lantern
    install -m 0644 "$PREFIX/current/device/plymouth/lantern/"* /usr/share/plymouth/themes/lantern/
    plymouth-set-default-theme -R lantern >/dev/null
}

harden_storage() {
    say "Keeping logs and swap in RAM"
    install -d /etc/systemd/journald.conf.d
    install -m 0644 "$PREFIX/current/device/system/journald.conf.d/lantern.conf" /etc/systemd/journald.conf.d/
    install -m 0644 "$PREFIX/current/device/system/zramswap" /etc/default/zramswap
    if systemctl list-unit-files dphys-swapfile.service >/dev/null 2>&1; then
        systemctl disable --now dphys-swapfile.service 2>/dev/null || true
        dphys-swapfile swapoff 2>/dev/null || true
        rm -f /var/swap
    fi
    systemctl enable --now zramswap.service 2>/dev/null || warn "zram swap did not start; check: systemctl status zramswap"
    # noatime: reading a file no longer writes to the card.
    if ! awk '$2 == "/" {print $4}' /etc/fstab | grep -q noatime; then
        sed -i -E '/^[^#]\S+\s+\/\s/ s/(\s+\S+\s+)(defaults)/\1\2,noatime/' /etc/fstab
    fi
    # Updates are the desk's own business; no background apt runs that write to the card.
    systemctl disable --now apt-daily.timer apt-daily-upgrade.timer man-db.timer 2>/dev/null || true
    systemctl restart systemd-journald
}

install_units() {
    say "Starting the service and the screen at boot"
    install -m 0644 "$PREFIX/current/device/systemd/lantern.service" /etc/systemd/system/
    install -m 0644 "$PREFIX/current/device/systemd/lantern-kiosk.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl mask getty@tty1.service >/dev/null 2>&1 || true
    systemctl set-default graphical.target >/dev/null
    systemctl enable lantern.service lantern-kiosk.service >/dev/null
    systemctl restart lantern.service
}

lock_ssh() {
    [ "$LOCK_SSH" = 1 ] || return 0
    if tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"' &&
       tailscale debug prefs 2>/dev/null | grep -q '"RunSSH": *true'; then
        if confirm "Tailscale SSH is on. Turn OpenSSH off, so the desk is reachable only over Tailscale?"; then
            systemctl disable --now ssh.service ssh.socket 2>/dev/null || true
            say "OpenSSH is off. Reach the desk with: ssh <user>@<desk's tailnet name>"
        fi
    else
        warn "Not turning OpenSSH off: Tailscale SSH is not running yet. First run: sudo tailscale up --ssh"
    fi
}

main() {
    preflight
    install_packages
    make_accounts
    install_release
    configure_boot
    configure_display
    install_splash
    harden_storage
    install_units
    lock_ssh
    say "Done. Version $(cat "$PREFIX/current/VERSION") is installed."
    cat <<EOF

Next:
  1. If you have not yet: sudo tailscale up --ssh     (approve the device in your tailnet)
  2. Reboot: sudo reboot. The desk starts into its setup screen: type your Hermes address
     and sign in there. Or do it here: lantern setup https://hermes.<your-tailnet>.ts.net
  3. Later, to keep OpenSSH off the network: sudo bash install.sh --bundle ... --lock-ssh
EOF
}

main
