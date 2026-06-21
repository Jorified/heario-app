// Heario — Tauri shell
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[cfg(target_os = "windows")]
mod capture_exclusion {
    pub fn apply(hwnd: isize) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR,
        };
        let hwnd = HWND(hwnd as *mut _);
        unsafe {
            if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).is_err() {
                let _ = SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
            }
        }
    }
}

struct SidecarState(Mutex<Option<Child>>);

fn exe_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
}

// ── Settings ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
struct Settings {
    anthropic_key:    String,
    openai_key:       String,
    deepgram_key:     String,
    tavily_key:       String,
    llm_provider:     String,
    context:          String,
    job_description:  String,
    company_name:     String,
    company_brief:    String,
    target_speaker:   String,
    user_speaker:     String,
    default_mode:     String,
    audio_source:     String,
    stt_backend:      String,
    speaker_names:    Vec<String>,
    mode_prompts:     std::collections::HashMap<String, String>,
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    let dir = exe_dir();
    let mut s = Settings {
        anthropic_key:   String::new(),
        openai_key:      String::new(),
        deepgram_key:    String::new(),
        tavily_key:      String::new(),
        llm_provider:    "anthropic".to_string(),
        context:         String::new(),
        job_description: String::new(),
        company_name:    String::new(),
        company_brief:   String::new(),
        target_speaker:  "auto".to_string(),
        user_speaker:    "none".to_string(),
        default_mode:    "technical_interview".to_string(),
        audio_source:    "microphone".to_string(),
        stt_backend:     "auto".to_string(),
        speaker_names:   vec!["Voice 1".to_string(),"Voice 2".to_string(),"Voice 3".to_string(),"Voice 4".to_string()],
        mode_prompts:    std::collections::HashMap::new(),
    };
    // Load custom mode prompts from modes.json if it exists
    if let Ok(json) = std::fs::read_to_string(dir.join("modes.json")) {
        if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String,String>>(&json) {
            s.mode_prompts = map;
        }
    }
    if let Ok(content) = std::fs::read_to_string(dir.join(".env")) {
        for line in content.lines() {
            if line.trim().starts_with('#') { continue; }
            if let Some((k, v)) = line.split_once('=') {
                match k.trim() {
                    "ANTHROPIC_API_KEY" => s.anthropic_key = v.trim().to_string(),
                    "OPENAI_API_KEY"    => s.openai_key    = v.trim().to_string(),
                    "DEEPGRAM_API_KEY"  => s.deepgram_key  = v.trim().to_string(),
                    "TAVILY_API_KEY"    => s.tavily_key    = v.trim().to_string(),
                    "LLM_PROVIDER"      => s.llm_provider  = v.trim().to_string(),
                    "COMPANY_NAME"      => s.company_name  = v.trim().to_string(),
                    "TARGET_SPEAKER"    => s.target_speaker = v.trim().to_string(),
                    "USER_SPEAKER"      => s.user_speaker   = v.trim().to_string(),
                    "MODE"              => s.default_mode   = v.trim().to_string(),
                    "AUDIO_SOURCE"      => s.audio_source   = v.trim().to_string(),
                    "STT_BACKEND"       => s.stt_backend    = v.trim().to_string(),
                    "SPEAKER_NAMES"     => s.speaker_names  = v.trim().split(',').map(|n| n.trim().to_string()).collect(),
                    _ => {}
                }
            }
        }
    }
    if let Ok(ctx) = std::fs::read_to_string(dir.join("context.txt")) {
        s.context = ctx;
    }
    if let Ok(jd) = std::fs::read_to_string(dir.join("job_description.txt")) {
        s.job_description = jd;
    }
    if let Ok(cb) = std::fs::read_to_string(dir.join("company_brief.txt")) {
        s.company_brief = cb;
    }
    Ok(s)
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let dir = exe_dir();
    let env_path = dir.join(".env");

    // Read existing .env and preserve any keys we don't manage
    const MANAGED: &[&str] = &["ANTHROPIC_API_KEY","OPENAI_API_KEY","DEEPGRAM_API_KEY","TAVILY_API_KEY","LLM_PROVIDER","TARGET_SPEAKER","USER_SPEAKER","COMPANY_NAME","MODE","AUDIO_SOURCE","STT_BACKEND","SPEAKER_NAMES"];
    let mut preserved: Vec<String> = vec![];
    if let Ok(content) = std::fs::read_to_string(&env_path) {
        for line in content.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') { continue; }
            if let Some((k, _)) = t.split_once('=') {
                if !MANAGED.contains(&k.trim()) {
                    preserved.push(line.to_string());
                }
            }
        }
    }

    let mut out = preserved.join("\n");
    if !out.is_empty() { out.push('\n'); }
    out.push_str(&format!(
        "ANTHROPIC_API_KEY={}\nOPENAI_API_KEY={}\nDEEPGRAM_API_KEY={}\nTAVILY_API_KEY={}\nLLM_PROVIDER={}\nTARGET_SPEAKER={}\nUSER_SPEAKER={}\nCOMPANY_NAME={}\nMODE={}\nAUDIO_SOURCE={}\nSTT_BACKEND={}\nSPEAKER_NAMES={}\n",
        settings.anthropic_key, settings.openai_key, settings.deepgram_key, settings.tavily_key,
        settings.llm_provider, settings.target_speaker, settings.user_speaker,
        settings.company_name, settings.default_mode, settings.audio_source,
        settings.stt_backend, settings.speaker_names.join(","),
    ));

    std::fs::write(&env_path, out).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("context.txt"), settings.context).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("job_description.txt"), settings.job_description).map_err(|e| e.to_string())?;
    // Save mode prompts to modes.json
    if !settings.mode_prompts.is_empty() {
        let json = serde_json::to_string_pretty(&settings.mode_prompts).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("modes.json"), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Company presets ───────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CompanyPreset {
    company_name:    String,
    job_description: String,
    company_brief:   String,
    default_mode:    String,
    mode_prompts:    std::collections::HashMap<String, String>,
}

fn presets_path() -> std::path::PathBuf {
    exe_dir().join("company_presets.json")
}

fn load_presets() -> std::collections::HashMap<String, CompanyPreset> {
    std::fs::read_to_string(presets_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn list_company_presets() -> std::collections::HashMap<String, CompanyPreset> {
    load_presets()
}

#[tauri::command]
fn save_company_preset(name: String, preset: CompanyPreset) -> Result<(), String> {
    let mut presets = load_presets();
    presets.insert(name, preset);
    let json = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(presets_path(), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_company_preset(name: String) -> Result<(), String> {
    let mut presets = load_presets();
    presets.remove(&name);
    let json = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(presets_path(), json).map_err(|e| e.to_string())
}

// ── Session history ───────────────────────────────────────────────────────────

#[tauri::command]
fn list_sessions() -> Vec<String> {
    let dir = exe_dir().join("sessions");
    std::fs::read_dir(&dir)
        .ok()
        .map(|entries| {
            let mut files: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().map(|x| x == "txt").unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            files.sort_by(|a, b| b.cmp(a)); // newest first
            files
        })
        .unwrap_or_default()
}

#[tauri::command]
fn read_session(name: String) -> Result<String, String> {
    let safe = std::path::Path::new(&name)
        .file_name()
        .ok_or("invalid name")?
        .to_string_lossy()
        .to_string();
    std::fs::read_to_string(exe_dir().join("sessions").join(safe))
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct SessionMatch {
    name: String,
    snippets: Vec<String>,
}

/// Case-insensitive search across every saved session transcript. Returns, per
/// matching session, up to 3 short context snippets so the dashboard can show
/// why a session matched without loading the full transcript first.
#[tauri::command]
fn search_sessions(query: String) -> Vec<SessionMatch> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }

    let mut results: Vec<SessionMatch> = list_sessions()
        .into_iter()
        .filter_map(|name| {
            let text = std::fs::read_to_string(exe_dir().join("sessions").join(&name)).ok()?;
            let snippets: Vec<String> = text
                .lines()
                .filter(|line| line.to_lowercase().contains(&q))
                .map(|line| {
                    let trimmed = line.trim();
                    let truncated: String = trimmed.chars().take(160).collect();
                    if truncated.chars().count() < trimmed.chars().count() {
                        format!("{}…", truncated)
                    } else {
                        truncated
                    }
                })
                .take(3)
                .collect();
            if snippets.is_empty() {
                None
            } else {
                Some(SessionMatch { name, snippets })
            }
        })
        .collect();

    results.sort_by(|a, b| b.name.cmp(&a.name)); // newest first
    results
}

// ── Session export ────────────────────────────────────────────────────────────

#[tauri::command]
fn open_sessions_folder() -> Result<(), String> {
    let dir = exe_dir().join("sessions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Autostart ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }
        .map_err(|e| e.to_string())
}

// ── Sidecar ───────────────────────────────────────────────────────────────────

#[tauri::command]
fn restart_sidecar(state: tauri::State<SidecarState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut child) = guard.take() { let _ = child.kill(); }
    *guard = Some(spawn_sidecar()?);
    Ok(())
}

fn spawn_sidecar() -> Result<Child, String> {
    let dir = exe_dir();
    let bundled = dir.join("heario-sidecar.exe");
    if bundled.exists() {
        Command::new(&bundled)
            .spawn()
            .map_err(|e| format!("Failed to start bundled sidecar: {e}"))
    } else {
        let python = r"C:\Users\jacko\AppData\Local\Python\pythoncore-3.14-64\python.exe";
        let script = dir.join("../../../sidecar/ws_server.py");
        Command::new(python).arg(&script)
            .spawn()
            .map_err(|e| format!("Failed to start dev sidecar: {e}"))
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let child = spawn_sidecar().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_shortcut("ctrl+shift+h")
            .unwrap()
            .with_handler(|app, _shortcut, event| {
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("main") {
                        if w.is_visible().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                }
            })
            .build())
        .manage(SidecarState(Mutex::new(child)))
        .invoke_handler(tauri::generate_handler![
            restart_sidecar,
            get_settings, save_settings,
            list_sessions, read_session, search_sessions, open_sessions_folder,
            get_autostart, set_autostart,
            list_company_presets, save_company_preset, delete_company_preset,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "windows")]
            {
                use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                if let Ok(handle) = window.window_handle() {
                    if let RawWindowHandle::Win32(h) = handle.as_raw() {
                        capture_exclusion::apply(h.hwnd.get() as isize);
                    }
                }
            }

            // System tray
            let show_item = MenuItem::with_id(app, "show", "Show Heario", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit",          true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Heario — AI Interview Copilot")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close button → hide to tray (quit from tray menu)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauri runtime error");
}
