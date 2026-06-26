# Changelog

All notable changes to BuzzCast. Versions follow the `BuzzCast v<x.y>` releases.

## v1.3

- **Screen wake lock** — the controller keeps the phone's screen awake while playing (re-acquired automatically when you switch back to the tab).
- **Auto-update notifications** — the host checks GitHub for newer releases and shows a dismissible banner with a download link (EN/PT).

## v1.2

- **Cross-platform** — now builds for **Windows, macOS and Linux** from one codebase, with the OS-specific keyboard backend selected at runtime. CI builds all three on each tagged release (Linux AppImage + macOS `.app` included).
- **Antivirus false-positive fixed** — keyboard injection moved from PowerShell `Add-Type` (which dropped a random unsigned DLL in `%TEMP%`) to direct `bun:ffi` calls into the signed system library. No temp DLL, no subprocess, lower latency.
- **Keybinds menu** — change any pad's key from a host popup, test each button live, and the mapping is saved across runs.
- **Instructions revamp** — PCSX2 setup is now an in-app popup on the host; the player page is focused on how to join and play.
- Project reorganised into `src/` · `legacy/` · `scripts/` · `assets/` · `public/`.

> ⚠️ The **macOS and Linux** builds compile and ship but haven't been verified on real hardware yet — [feedback welcome](https://github.com/bacoinz/buzzcast/issues). Linux is X11-only (needs `libxtst6`); macOS needs Accessibility permission and is unsigned.

## v1.1

- Fixed the key map for players 6, 7 and 8.
- Lower-latency input and a live per-player latency indicator.
- Auto-reconnect with exponential backoff when WiFi drops.

## v1.0

- Initial release — up to 8 phone controllers for PCSX2, local play and remote play via Cloudflare Tunnel.
