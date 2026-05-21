use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use super::launcher_config::ensure_launcher_config;
use super::paths::resolve_app_paths;
use super::server::{stop_server, ServerState};

fn remove_file_if_exists(path: PathBuf) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn remove_dir_contents(path: PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(&path).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let entry_path = entry.path();
        if entry_path.is_dir() {
            fs::remove_dir_all(&entry_path).map_err(|err| err.to_string())?;
        } else {
            fs::remove_file(&entry_path).map_err(|err| err.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn reset_host_store_data(app: AppHandle, state: State<'_, ServerState>) -> Result<bool, String> {
    let _ = stop_server(state);

    let paths = resolve_app_paths(&app)?;
    let config = ensure_launcher_config(&app)?;

    remove_file_if_exists(PathBuf::from(&paths.database_path))?;
    remove_dir_contents(PathBuf::from(&paths.uploads_dir))?;
    remove_file_if_exists(PathBuf::from(&paths.config_dir).join("secret.key"))?;
    remove_file_if_exists(PathBuf::from(&paths.config_dir).join("license-state.json"))?;
    remove_file_if_exists(PathBuf::from(&paths.config_dir).join("installation-id.txt"))?;

    // Recreate launcher state with host mode so the setup wizard can continue normally.
    let launcher_state_path = PathBuf::from(&paths.config_dir).join("launcher-state.json");
    let next_state = serde_json::json!({
        "mode": "host",
        "client_base_url": null,
        "installation_id": config.installation_id,
    });
    fs::write(
        launcher_state_path,
        serde_json::to_string_pretty(&next_state).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;

    Ok(true)
}
