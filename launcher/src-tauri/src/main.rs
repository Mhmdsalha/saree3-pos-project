#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::server::ServerState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![
            commands::launcher_config::launcher_config,
            commands::launcher_config::save_launcher_mode,
            commands::launcher_config::save_client_connection,
            commands::maintenance::reset_host_store_data,
            commands::paths::app_paths,
            commands::paths::copy_logo_to_store_assets,
            commands::paths::save_logo_file,
            commands::backup::create_backup,
            commands::backup::restore_backup,
            commands::server::server_status,
            commands::server::start_server,
            commands::server::stop_server,
            commands::server::restart_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlowPOS launcher");
}
