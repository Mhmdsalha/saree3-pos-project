use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

use super::paths::resolve_app_paths;
use super::server::ServerState;

fn timestamp_slug() -> String {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{epoch}")
}

fn validate_sqlite_database(path: &PathBuf) -> Result<(), String> {
    if !path.is_file() {
        return Err("ملف النسخة الاحتياطية غير صالح".into());
    }

    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    let mut header = [0u8; 16];
    file.read_exact(&mut header)
        .map_err(|_| "تعذر قراءة ملف النسخة الاحتياطية".to_string())?;
    if &header != b"SQLite format 3\0" {
        return Err("ملف النسخة الاحتياطية ليس قاعدة بيانات FlowPOS صالحة".into());
    }
    Ok(())
}

#[tauri::command]
pub fn create_backup(app: AppHandle) -> Result<String, String> {
    let paths = resolve_app_paths(&app)?;
    let source = PathBuf::from(&paths.database_path);
    if !source.exists() {
        return Err("ملف قاعدة البيانات غير موجود بعد".into());
    }

    validate_sqlite_database(&source)?;

    let backup_path =
        PathBuf::from(paths.backups_dir).join(format!("flowpos-backup-{}.db", timestamp_slug()));
    fs::copy(source, &backup_path).map_err(|err| err.to_string())?;
    Ok(backup_path.display().to_string())
}

#[tauri::command]
pub fn restore_backup(
    app: AppHandle,
    state: State<'_, ServerState>,
    backup_path: String,
) -> Result<bool, String> {
    let runtime = state
        .0
        .lock()
        .map_err(|_| "تعذر قفل حالة السيرفر الحالية")?;
    if runtime.child.is_some() {
        return Err("يجب إيقاف السيرفر قبل الاستعادة".into());
    }
    drop(runtime);

    let paths = resolve_app_paths(&app)?;
    let source = PathBuf::from(backup_path);
    if !source.exists() {
        return Err("ملف النسخة الاحتياطية غير موجود".into());
    }

    validate_sqlite_database(&source)?;

    let target = PathBuf::from(paths.database_path);
    fs::copy(source, target).map_err(|err| err.to_string())?;
    Ok(true)
}
