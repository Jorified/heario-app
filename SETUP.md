# Heario — Phase 2 Setup

## Install prerequisites (one-time)

### 1. Node.js
Download and install from https://nodejs.org (LTS version)
Verify: `node --version` and `npm --version`

### 2. Rust
```powershell
winget install Rustlang.Rustup
# or: https://rustup.rs
rustup default stable
```
Verify: `cargo --version`

### 3. Tauri CLI + prerequisites
```powershell
npm install -g @tauri-apps/cli@latest
cargo install tauri-cli
# Windows also needs:
winget install Microsoft.VisualStudio.2022.BuildTools
# (C++ build tools — select "Desktop development with C++" workload)
```

## Run in dev mode

**Terminal 1 — Python sidecar (pipeline + websocket bridge):**
```powershell
cd C:\Users\jacko\heario-poc
python C:\Users\jacko\heario-app\sidecar\ws_server.py
```

**Terminal 2 — Tauri dev shell:**
```powershell
cd C:\Users\jacko\heario-app
cargo tauri dev
```

This starts the React UI on http://localhost:1420 AND opens the native Tauri overlay window.
The overlay is always-on-top, frameless, transparent, and invisible to screen-share.

## Build a distributable .exe
```powershell
cd C:\Users\jacko\heario-app
cargo tauri build
# Output: src-tauri/target/release/bundle/nsis/Heario_0.1.4_x64-setup.exe
```

## Architecture recap
```
[Python sidecar: ws_server.py]
  ↕  ws://localhost:7433  (JSON events + commands)
[Tauri Rust shell: main.rs]
  ↕  webview IPC
[React UI: App.jsx]
  (the overlay the user sees)
```
