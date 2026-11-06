// keyboard/linux.js — Linux key injection.
//
// Two backends, picked at runtime:
//   • Wayland  → uinput virtual keyboard. The kernel delivers the keys to the
//     compositor, which routes them to the focused window — native Wayland
//     clients included. Needs read/write access to /dev/uinput (a udev rule or
//     the input group; most desktops already grant the logged-in user access).
//   • X11      → XTEST via libXtst / libX11. Requires an X11 session and libXtst.
//
// Tokens: a single char (a printable ASCII char) or "#XX" = raw Win32 VK in hex,
// translated to the matching native key code so saved keymaps stay cross-platform.

import fs from "node:fs";

// Win32 virtual-key (the "#XX" tokens the Keybinds UI can produce) → X11 keysym.
const VK_TO_KEYSYM = {
  0x08: 0xff08, // Backspace
  0x09: 0xff09, // Tab
  0x0d: 0xff0d, // Return
  0x1b: 0xff1b, // Escape
  0x20: 0x0020, // Space
  0x2e: 0xffff, // Delete
  0x2d: 0xff63, // Insert
  0x24: 0xff50, // Home
  0x23: 0xff57, // End
  0x21: 0xff55, // Prior (PageUp)
  0x22: 0xff56, // Next (PageDown)
  0x25: 0xff51, // Left
  0x26: 0xff52, // Up
  0x27: 0xff53, // Right
  0x28: 0xff54, // Down
};

// Win32 virtual-key → Linux input keycode (input-event-codes.h).
const VK_TO_KEYCODE = {
  0x08: 14,  // Backspace
  0x09: 15,  // Tab
  0x0d: 28,  // Enter
  0x1b: 1,   // Escape
  0x20: 57,  // Space
  0x2e: 111, // Delete
  0x2d: 110, // Insert
  0x24: 102, // Home
  0x23: 107, // End
  0x21: 104, // PageUp
  0x22: 109, // PageDown
  0x25: 105, // Left
  0x26: 103, // Up
  0x27: 106, // Right
  0x28: 108, // Down
  0x70: 59, 0x71: 60, 0x72: 61, 0x73: 62, 0x74: 63, // F1–F5
  0x75: 64, 0x76: 65, 0x77: 66, 0x78: 67, 0x79: 68, // F6–F10
  0x7a: 87, 0x7b: 88,                               // F11–F12
};

// Printable ASCII → Linux input keycode (unshifted), and the shifted variant.
const KEY = {
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  "-": 12, "=": 13, "q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22,
  "i": 23, "o": 24, "p": 25, "[": 26, "]": 27, "a": 30, "s": 31, "d": 32, "f": 33,
  "g": 34, "h": 35, "j": 36, "k": 37, "l": 38, ";": 39, "'": 40, "`": 41, "\\": 43,
  "z": 44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50, ",": 51, ".": 52,
  "/": 53, " ": 57,
};
const SHIFTED = {
  "!": 2, "@": 3, "#": 4, "$": 5, "%": 6, "^": 7, "&": 8, "*": 9, "(": 10, ")": 11,
  "_": 12, "+": 13, "{": 26, "}": 27, ":": 39, '"': 40, "~": 41, "|": 43,
  "<": 51, ">": 52, "?": 53,
};
const KEY_LEFTSHIFT = 42;

// ── X11 / XTEST backend ──────────────────────────────────────────────────────
let X11 = null, Xtst = null, display = null;

function initXTest() {
  const { dlopen, FFIType } = require("bun:ffi");
  const x11 = dlopen("libX11.so.6", {
    XOpenDisplay:     { args: [FFIType.cstring], returns: FFIType.ptr },
    XKeysymToKeycode: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u8 },
    XFlush:           { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const xtst = dlopen("libXtst.so.6", {
    XTestFakeKeyEvent: { args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  });
  X11 = x11.symbols; Xtst = xtst.symbols;
  display = X11.XOpenDisplay(null);
  if (!display) throw new Error("XOpenDisplay failed (no X11 display)");
}

function x11Keycode(token) {
  const ks = token[0] === "#"
    ? VK_TO_KEYSYM[parseInt(token.slice(1), 16)]
    : token.charCodeAt(0);                 // printable ASCII keysym == code point
  return ks ? X11.XKeysymToKeycode(display, BigInt(ks)) : 0;   // 0 = not on this keyboard
}

function x11Send(token, isPress) {
  if (!display) return;
  const code = x11Keycode(token);
  if (!code) return;
  Xtst.XTestFakeKeyEvent(display, code, isPress ? 1 : 0, 0n);
  X11.XFlush(display);
}

// ── Wayland / uinput backend ─────────────────────────────────────────────────
const UI_SET_EVBIT   = 0x40045564;
const UI_SET_KEYBIT  = 0x40045565;
const UI_DEV_CREATE  = 0x00005501;
const UI_DEV_DESTROY = 0x00005502;
const EV_KEY = 1, EV_SYN = 0, SYN_REPORT = 0;

let uinputFd = -1;
let uinputIoctl = null;

function uinputKey(token) {
  if (token[0] === "#") {
    const code = VK_TO_KEYCODE[parseInt(token.slice(1), 16)];
    return code ? { code, shift: false } : null;
  }
  const ch = token[0];
  if (SHIFTED[ch]) return { code: SHIFTED[ch], shift: true };
  if (ch >= "A" && ch <= "Z") return { code: KEY[ch.toLowerCase()], shift: true };
  const code = KEY[ch];
  return code ? { code, shift: false } : null;
}

function uinputEmit(type, code, value) {
  const b = Buffer.alloc(24);           // struct input_event (64-bit): 16B timeval + u16 + u16 + s32
  b.writeUInt16LE(type, 16);
  b.writeUInt16LE(code, 18);
  b.writeInt32LE(value, 20);
  fs.writeSync(uinputFd, b);
}
function uinputKeyEvent(code, value) {
  uinputEmit(EV_KEY, code, value);
}
function uinputSync() {
  uinputEmit(EV_SYN, SYN_REPORT, 0);
}

function initUinput() {
  const { dlopen, FFIType } = require("bun:ffi");
  const libc = dlopen("libc.so.6", {
    ioctl: { args: [FFIType.i32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  });
  uinputIoctl = libc.symbols.ioctl;

  uinputFd = fs.openSync("/dev/uinput", fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  const io = (req, val = 0) => {
    if (uinputIoctl(uinputFd, req, val) < 0)
      throw new Error(`ioctl 0x${req.toString(16)} failed`);
  };

  io(UI_SET_EVBIT, EV_KEY);
  const codes = new Set([KEY_LEFTSHIFT, ...Object.values(KEY), ...Object.values(SHIFTED), ...Object.values(VK_TO_KEYCODE)]);
  for (const code of codes) io(UI_SET_KEYBIT, code);

  // Legacy uinput_user_dev (still supported; avoids needing UI_DEV_SETUP + a
  // second pointer ioctl signature).
  const dev = Buffer.alloc(1116);
  dev.write("BuzzCast Virtual Keyboard", 0, "utf8");
  dev.writeUInt16LE(0x03, 80);   // bustype = BUS_USB
  dev.writeUInt16LE(0x1209, 82); // vendor
  dev.writeUInt16LE(0x0001, 84); // product
  dev.writeUInt16LE(1, 86);      // version
  fs.writeSync(uinputFd, dev);
  io(UI_DEV_CREATE);

  process.on("exit", () => {
    try {
      if (uinputFd >= 0) {
        uinputIoctl(uinputFd, UI_DEV_DESTROY, 0);
        fs.closeSync(uinputFd);
        uinputFd = -1;
      }
    } catch { /* already gone */ }
  });
}

function uinputSend(token, isPress) {
  const k = uinputKey(token);
  if (!k) return;
  if (isPress) {
    if (k.shift) uinputKeyEvent(KEY_LEFTSHIFT, 1);
    uinputKeyEvent(k.code, 1);
  } else {
    uinputKeyEvent(k.code, 0);
    if (k.shift) uinputKeyEvent(KEY_LEFTSHIFT, 0);
  }
  uinputSync();
}

// ── Backend selection ────────────────────────────────────────────────────────
const isWayland = process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;

export function init() {
  if (isWayland) {
    try {
      initUinput();
      console.log("[keyboard] linux backend: uinput (Wayland)");
      return;
    } catch (e) {
      console.error(`[keyboard] uinput unavailable (${e.message}) — falling back to XTEST; native Wayland windows will not receive keys`);
    }
  }
  initXTest();
  console.log("[keyboard] linux backend: XTEST (X11)");
}

// Press and release are separate so keyboard/index.js can hold the key down.
export function down(token) { if (uinputFd >= 0) uinputSend(token, true); else x11Send(token, true); }
export function up(token)   { if (uinputFd >= 0) uinputSend(token, false); else x11Send(token, false); }
