mod fs;
mod process;
mod terminal;

use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    platform: &'static str,
    config_dir: Option<PathBuf>,
    home_dir: Option<PathBuf>,
    cwd: Option<PathBuf>,
    /// Skip loading init.js: POLYMER_NO_INIT=1 or a -q / --no-init argument.
    no_init: bool,
}

/// The user's config directory: $POLYMER_CONFIG_DIR, else ~/.polymer on every platform.
fn config_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("POLYMER_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    app.path().home_dir().ok().map(|h| h.join(".polymer"))
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        config_dir: config_dir(&app),
        home_dir: app.path().home_dir().ok(),
        cwd: std::env::current_dir().ok(),
        no_init: std::env::var("POLYMER_NO_INIT").map(|v| !v.is_empty() && v != "0").unwrap_or(false)
            || std::env::args().any(|a| a == "-q" || a == "--no-init"),
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    process::adopt_login_shell_path();
    tauri::Builder::default()
        .manage(terminal::Terminals::default())
        .manage(process::Processes::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            quit_app,
            fs::read_text_file,
            fs::read_binary_file,
            fs::write_text_file,
            fs::list_directory,
            fs::path_info,
            fs::make_directory,
            fs::canonicalize_path,
            process::run_process,
            process::proc_spawn,
            process::proc_write,
            process::proc_kill,
            process::proc_list,
            terminal::term_spawn,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_scroll,
            terminal::term_snapshot,
            terminal::term_kill,
            terminal::term_list,
            terminal::term_attach,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Polymer");
}
