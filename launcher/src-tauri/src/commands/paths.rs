use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct AppPathsPayload {
    pub app_data_dir: String,
    pub config_dir: String,
    pub data_dir: String,
    pub uploads_dir: String,
    pub backups_dir: String,
    pub database_path: String,
    pub logo_dir: String,
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|err| err.to_string())
}

pub fn resolve_app_paths(app: &AppHandle) -> Result<AppPathsPayload, String> {
    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?;

    let config_dir = app_data_dir.join("config");
    let data_dir = app_data_dir.join("data");
    let uploads_dir = app_data_dir.join("uploads");
    let backups_dir = app_data_dir.join("backups");
    let logo_dir = uploads_dir.join("logo");
    let database_path = data_dir.join("flowpos.db");

    for path in [&config_dir, &data_dir, &uploads_dir, &backups_dir, &logo_dir] {
        ensure_dir(path)?;
    }

    Ok(AppPathsPayload {
        app_data_dir: app_data_dir.display().to_string(),
        config_dir: config_dir.display().to_string(),
        data_dir: data_dir.display().to_string(),
        uploads_dir: uploads_dir.display().to_string(),
        backups_dir: backups_dir.display().to_string(),
        database_path: database_path.display().to_string(),
        logo_dir: logo_dir.display().to_string(),
    })
}

fn file_name_or_default(source_path: &str, default_name: &str) -> String {
    PathBuf::from(source_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| default_name.to_string())
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> Result<AppPathsPayload, String> {
    resolve_app_paths(&app)
}

#[tauri::command]
pub fn copy_logo_to_store_assets(app: AppHandle, source_path: String) -> Result<String, String> {
    let paths = resolve_app_paths(&app)?;
    let target_name = file_name_or_default(&source_path, "store-logo.png");
    let target_path = PathBuf::from(paths.logo_dir).join(target_name);
    fs::copy(&source_path, &target_path).map_err(|err| err.to_string())?;
    Ok(target_path.display().to_string())
}

#[tauri::command]
pub fn save_logo_file(app: AppHandle, file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let paths = resolve_app_paths(&app)?;
    let target_name = file_name_or_default(&file_name, "store-logo.png");
    let target_path = PathBuf::from(paths.logo_dir).join(target_name);
    fs::write(&target_path, bytes).map_err(|err| err.to_string())?;
    Ok(target_path.display().to_string())
}
