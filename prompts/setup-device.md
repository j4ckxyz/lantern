# Prompt: set up the Lantern desk on a Raspberry Pi

For a coding agent with a shell on the Pi (over SSH). Paste everything below the line.

---

Set up this Raspberry Pi as my Lantern desk device and connect it to my Hermes. Work through these
steps, show me what each check printed, and stop to ask when a step needs something only I can
give.

1. **Look first.** `cat /proc/device-tree/model`, `cat /etc/os-release`, `uname -m`, `free -m`,
   `python3 --version`. The desk expects a Raspberry Pi 4 or 5, Raspberry Pi OS Lite 64-bit
   (Trixie), `aarch64` and Python 3.11 or later. Tell me if anything differs before going on.
2. **The release.** I will give you a bundle (`lantern-<version>-arm64.tar.zst`) or tell you
   which GitHub release to download. Check it with `tar --zstd -tf` before using it.
3. **Install.** `sudo bash install.sh --bundle <the bundle>` (the installer is inside the bundle
   under `device/` and in the repository). It installs packages, makes the `lantern` and `kiosk`
   accounts, edits `config.txt` and `cmdline.txt` (backing both up), turns the screen and touch to
   landscape, and enables the service and the screen. Show me the summary it prints.
4. **Tailscale.** `tailscale status`. If it is not logged in, run `sudo tailscale up --ssh` and give
   me the link it prints; I will approve it. Then check that this machine can reach my Hermes:
   `curl -s <address>/api/status` should return JSON with a `version`.
5. **Connect.** Either I do it on the screen after a reboot (it asks for the address and my
   sign-in), or you run `lantern setup <address>`. If you run it, let me type the password
   myself: do not ask me to paste it into this chat, and never write it to a file yourself.
6. **Check.** `lantern doctor` should end with "all good"; `lantern status` should say `ready`.
7. **Reboot** and tell me what to look for: the navy splash, then the chat, in landscape. Ask me
   whether it is the right way up and whether a tap lands where my finger is. If the picture is
   upside down, run the installer again with `--rotate 270` and reboot. If the picture is right but
   touches land in the wrong place, say so: the touch turn in `/etc/udev/rules.d/90-lantern-touch.rules`
   has not been checked on a real panel yet.
8. **Only when I ask:** `sudo bash install.sh --bundle <the bundle> --lock-ssh` turns OpenSSH off
   so the desk is reachable only over Tailscale SSH. It refuses unless Tailscale SSH already works.

If something fails, `journalctl -u lantern -u lantern-kiosk -b` and `lantern doctor` say why. Do
not work around a failure by turning off authentication on Hermes or exposing it to the internet.
