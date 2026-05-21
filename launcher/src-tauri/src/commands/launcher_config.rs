use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use super::paths::resolve_app_paths;

#[derive(Debug, Clone, Serialize)]
pub struct LauncherConfigPayload {
    pub mode: Option<String>,
    pub client_base_url: Option<String>,
    pub installation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LauncherConfigFile {
    mode: Option<String>,
    client_base_url: Option<String>,
    installation_id: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let paths = resolve_app_paths(app)?;
    Ok(PathBuf::from(paths.config_dir).join("launcher-state.json"))
}

fn generate_installation_id() -> String {
    let mut bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut bytes);
    format!(
        "inst-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn normalize_mode(mode: Option<String>) -> Option<String> {
    match mode
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "host" => Some("host".into()),
        "client" => Some("client".into()),
        _ => None,
    }
}

fn normalize_base_url(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let normalized = raw.trim().trim_end_matches('/').to_string();
        if normalized.is_empty() {
            return None;
        }
        if normalized.starts_with("http://") || normalized.starts_with("https://") {
            return Some(normalized);
        }
        Some(format!("http://{normalized}"))
    })
}

fn read_config_file(path: &PathBuf) -> Result<LauncherConfigFile, String> {
    if !path.exists() {
        return Ok(LauncherConfigFile::default());
    }

    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str::<LauncherConfigFile>(&raw).map_err(|err| err.to_string())
}

fn write_config_file(path: &PathBuf, config: &LauncherConfigFile) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    fs::write(path, raw).map_err(|err| err.to_string())
}

pub fn ensure_launcher_config(app: &AppHandle) -> Result<LauncherConfigPayload, String> {
    let path = config_path(app)?;
    let mut config = read_config_file(&path)?;
    let mut changed = false;

    let mode = normalize_mode(config.mode.clone());
    if config.mode != mode {
        config.mode = mode.clone();
        changed = true;
    }

    let client_base_url = normalize_base_url(config.client_base_url.clone());
    if config.client_base_url != client_base_url {
        config.client_base_url = client_base_url.clone();
        changed = true;
    }

    let installation_id = match config.installation_id.clone() {
        Some(existing) if !existing.trim().is_empty() => existing,
        _ => {
            let next = generate_installation_id();
            config.installation_id = Some(next.clone());
            changed = true;
            next
        }
    };

    if changed {
        write_config_file(&path, &config)?;
    }

    Ok(LauncherConfigPayload {
        mode,
        client_base_url,
        installation_id,
    })
}

#[tauri::command]
pub fn launcher_config(app: AppHandle) -> Result<LauncherConfigPayload, String> {
    ensure_launcher_config(&app)
}

#[tauri::command]
pub fn save_launcher_mode(app: AppHandle, mode: Option<String>) -> Result<LauncherConfigPayload, String> {
    let path = config_path(&app)?;
    let mut config = read_config_file(&path)?;
    let next_mode = normalize_mode(mode);
    config.mode = next_mode.clone();
    if next_mode.as_deref() == Some("host") {
        config.client_base_url = None;
    }
    if config.installation_id.as_deref().unwrap_or("").trim().is_empty() {
        config.installation_id = Some(generate_installation_id());
    }
    write_config_file(&path, &config)?;
    ensure_launcher_config(&app)
}

#[tauri::command]
pub fn save_client_connection(app: AppHandle, base_url: String) -> Result<LauncherConfigPayload, String> {
    let path = config_path(&app)?;
    let mut config = read_config_file(&path)?;
    let normalized = normalize_base_url(Some(base_url))
        .ok_or_else(|| "رابط السيرفر المضيف مطلوب".to_string())?;
    config.mode = Some("client".into());
    config.client_base_url = Some(normalized);
    if config.installation_id.as_deref().unwrap_or("").trim().is_empty() {
        config.installation_id = Some(generate_installation_id());
    }
    write_config_file(&path, &config)?;
    ensure_launcher_config(&app)
}
