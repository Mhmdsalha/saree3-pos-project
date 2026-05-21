use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use super::launcher_config::ensure_launcher_config;
use super::paths::{resolve_app_paths, AppPathsPayload};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide_window(command: &mut Command) -> &mut Command {
    command.creation_flags(CREATE_NO_WINDOW)
}

pub struct ServerState(pub Mutex<ServerRuntime>);

impl Default for ServerState {
    fn default() -> Self {
        Self(Mutex::new(ServerRuntime::default()))
    }
}

pub struct ServerRuntime {
    pub child: Option<Child>,
    pub pid: Option<u32>,
    pub status: String,
    pub port: u16,
    pub error: Option<String>,
}

impl Default for ServerRuntime {
    fn default() -> Self {
        Self {
            child: None,
            pid: None,
            status: "stopped".into(),
            port: 8000,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatusPayload {
    pub status: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub url: String,
    pub mobile_url: String,
    pub error: Option<String>,
}

fn sqlite_url_for(path: &Path) -> String {
    let normalized = path.display().to_string().replace('\\', "/");
    format!("sqlite:///{normalized}")
}

fn ensure_secret_key(paths: &AppPathsPayload) -> Result<String, String> {
    let secret_path = Path::new(&paths.config_dir).join("secret.key");

    if secret_path.exists() {
        let value = fs::read_to_string(&secret_path).map_err(|err| err.to_string())?;
        let secret = value.trim().to_string();
        if !secret.is_empty() {
            return Ok(secret);
        }
    }

    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let secret = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    fs::write(&secret_path, &secret).map_err(|err| err.to_string())?;
    Ok(secret)
}

fn payload_for(runtime: &ServerRuntime) -> ServerStatusPayload {
    ServerStatusPayload {
        status: runtime.status.clone(),
        port: runtime.port,
        pid: runtime.pid.or_else(|| runtime.child.as_ref().map(|child| child.id())),
        url: format!("https://127.0.0.1:{}/frontend-react/", runtime.port),
        mobile_url: format!("https://127.0.0.1:{}/mobile-react/", runtime.port),
        error: runtime.error.clone(),
    }
}

fn current_repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn resolve_packaged_backend_command(app: &AppHandle) -> Option<(PathBuf, Vec<String>, PathBuf)> {
    let resource_dir = app.path().resource_dir().ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let target_triple = std::env::var("TAURI_ENV_TARGET_TRIPLE")
        .or_else(|_| std::env::var("TARGET"))
        .unwrap_or_default();

    let candidate_names = if cfg!(windows) {
        let mut names = vec!["flowpos-backend.exe".to_string()];
        for triple in [
            "x86_64-pc-windows-msvc",
            "aarch64-pc-windows-msvc",
            "i686-pc-windows-msvc",
        ] {
            names.push(format!("flowpos-backend-{triple}.exe"));
        }
        if !target_triple.is_empty() {
            let name = format!("flowpos-backend-{target_triple}.exe");
            if !names.contains(&name) {
                names.push(name);
            }
        }
        names
    } else {
        let mut names = vec!["flowpos-backend".to_string()];
        if !target_triple.is_empty() {
            names.push(format!("flowpos-backend-{target_triple}"));
        }
        names
    };

    let mut candidate_dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir.clone() {
        candidate_dirs.push(dir.join("binaries"));
        candidate_dirs.push(dir.clone());
        if let Some(parent) = dir.parent() {
            candidate_dirs.push(parent.join("binaries"));
            candidate_dirs.push(parent.to_path_buf());
        }
    }
    if let Some(dir) = exe_dir {
        candidate_dirs.push(dir.join("binaries"));
        candidate_dirs.push(dir);
    }

    for dir in candidate_dirs {
        for name in &candidate_names {
            let program = dir.join(name);
            if program.exists() {
                return Some((program, Vec::new(), dir));
            }
        }
    }

    None
}

fn tail_text(path: &Path, max_lines: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let lines = content
        .lines()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    if lines.trim().is_empty() {
        None
    } else {
        Some(lines)
    }
}

fn append_launcher_log(logs_dir: &Path, message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown-time".into());
    let path = logs_dir.join("launcher.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
}

fn backend_health_once(port: u16) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let stream = TcpStream::connect_timeout(&address, Duration::from_millis(900))
        .map_err(|err| err.to_string())?;
    drop(stream);
    Ok(())
}

fn wait_for_backend_health(
    port: u16,
    logs_dir: &Path,
    backend_log_path: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut last_error = String::from("backend health did not respond yet");

    while Instant::now() < deadline {
        match backend_health_once(port) {
            Ok(()) => {
                append_launcher_log(logs_dir, &format!("backend health ready port={port}"));
                return Ok(());
            }
            Err(error) => {
                last_error = error;
                thread::sleep(Duration::from_millis(450));
            }
        }
    }

    let log_tail = tail_text(backend_log_path, 24).unwrap_or_default();
    let details = if log_tail.is_empty() {
        format!("السيرفر بدأ لكن فحص منفذ HTTPS المحلي لم ينجح على البورت {port}: {last_error}")
    } else {
        format!("السيرفر بدأ لكن فحص منفذ HTTPS المحلي لم ينجح على البورت {port}: {last_error}\n{log_tail}")
    };
    append_launcher_log(logs_dir, &details.replace('\n', " | "));
    Err(details)
}

fn resolve_dev_backend_command() -> Result<(PathBuf, Vec<String>, PathBuf), String> {
    let repo_root = current_repo_root();
    let python_dir = repo_root.join("backend").join("venv").join("Scripts");
    let pythonw = python_dir.join("pythonw.exe");
    let python = if pythonw.exists() {
        pythonw
    } else {
        python_dir.join("python.exe")
    };
    let entry = repo_root.join("backend").join("launcher_entry.py");

    if python.exists() && entry.exists() {
        return Ok((
            python,
            vec![entry.display().to_string()],
            repo_root.join("backend"),
        ));
    }

    Err("تعذر العثور على مشغل backend للتطوير أو sidecar الإنتاج".into())
}

fn start_child(app: &AppHandle, port: u16) -> Result<Child, String> {
    let paths = resolve_app_paths(app)?;
    let launcher_config = ensure_launcher_config(app)?;
    let database_url = sqlite_url_for(Path::new(&paths.database_path));
    let secret_key = ensure_secret_key(&paths)?;
    let logs_dir = Path::new(&paths.app_data_dir).join("logs");
    fs::create_dir_all(&logs_dir).map_err(|err| err.to_string())?;
    let backend_log_path = logs_dir.join("backend.log");
    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&backend_log_path)
        .map_err(|err| err.to_string())?;
    let stderr_log = stdout_log.try_clone().map_err(|err| err.to_string())?;

    let (program, args, working_dir, backend_source) = match resolve_packaged_backend_command(app) {
        Some((program, args, working_dir)) => (program, args, working_dir, "packaged-sidecar"),
        None => {
            let (program, args, working_dir) = resolve_dev_backend_command()?;
            (program, args, working_dir, "development")
        }
    };
    append_launcher_log(
        &logs_dir,
        &format!(
            "starting backend source={} program=\"{}\" cwd=\"{}\" port={} exists={}",
            backend_source,
            program.display(),
            working_dir.display(),
            port,
            program.exists()
        ),
    );

    let mut command = Command::new(&program);
    command
        .args(args)
        .current_dir(working_dir)
        .env("PORT", port.to_string())
        .env("HOST", "0.0.0.0")
        .env("DATABASE_URL", database_url)
        .env("FLOWPOS_APP_DATA_DIR", &paths.app_data_dir)
        .env("FLOWPOS_CONFIG_DIR", &paths.config_dir)
        .env("FLOWPOS_UPLOADS_DIR", &paths.uploads_dir)
        .env("FLOWPOS_BACKUPS_DIR", &paths.backups_dir)
        .env("FLOWPOS_INSTALLATION_ID", launcher_config.installation_id)
        .env(
            "FLOWPOS_LAUNCHER_MODE",
            launcher_config.mode.unwrap_or_else(|| "host".into()),
        )
        .env("SECRET_KEY", secret_key)
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));

    #[cfg(windows)]
    hide_window(&mut command);

    let mut child = command.spawn().map_err(|err| {
        append_launcher_log(
            &logs_dir,
            &format!("backend spawn failed program=\"{}\" error={err}", program.display()),
        );
        err.to_string()
    })?;
    append_launcher_log(&logs_dir, &format!("backend spawned pid={}", child.id()));
    thread::sleep(Duration::from_millis(350));
    if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
        let log_tail = tail_text(&backend_log_path, 20).unwrap_or_default();
        let details = if log_tail.is_empty() {
            format!("backend exited immediately with status {status}")
        } else {
            format!("backend exited immediately with status {status}\n{log_tail}")
        };
        append_launcher_log(&logs_dir, &details.replace('\n', " | "));
        return Err(details);
    }

    if let Err(error) = wait_for_backend_health(port, &logs_dir, &backend_log_path, Duration::from_secs(55)) {
        kill_pid_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(child)
}

fn list_packaged_backend_pids() -> Vec<u32> {
    if !cfg!(windows) {
        return Vec::new();
    }

    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name 'flowpos-backend*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
    ]);

    #[cfg(windows)]
    hide_window(&mut command);

    let output = match command.output()
    {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

fn kill_pid_tree(pid: u32) {
    if cfg!(windows) {
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        hide_window(&mut command);

        let _ = command.status();
    }
}

fn stop_known_backends(runtime: &mut ServerRuntime) {
    if let Some(mut child) = runtime.child.take() {
        let pid = child.id();
        kill_pid_tree(pid);
        let _ = child.kill();
        let _ = child.wait();
    }

    if let Some(pid) = runtime.pid.take() {
        kill_pid_tree(pid);
    }

    for pid in list_packaged_backend_pids() {
        kill_pid_tree(pid);
    }
}

fn wait_for_backend_shutdown() {
    if !cfg!(windows) {
        return;
    }

    for _ in 0..10 {
        if list_packaged_backend_pids().is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(300));
    }
}

fn sync_runtime_with_system(runtime: &mut ServerRuntime) {
    let exited = match runtime.child.as_mut() {
        Some(child) => child.try_wait().ok().flatten().is_some(),
        None => false,
    };

    if exited {
        runtime.child = None;
        runtime.pid = None;
    }

    if runtime.child.is_some() {
        runtime.pid = runtime.child.as_ref().map(|child| child.id());
        runtime.status = "running".into();
        runtime.error = None;
        return;
    }

    let discovered = list_packaged_backend_pids();
    if let Some(pid) = discovered.first().copied().filter(|_| backend_health_once(runtime.port).is_ok()) {
        runtime.pid = Some(pid);
        runtime.status = "running".into();
        runtime.error = None;
    } else {
        runtime.pid = None;
        runtime.status = "stopped".into();
        runtime.error = None;
    }
}

fn refresh_runtime_state(runtime: &mut ServerRuntime) {
    sync_runtime_with_system(runtime);
}

#[tauri::command]
pub fn server_status(state: State<'_, ServerState>) -> Result<ServerStatusPayload, String> {
    let mut runtime = state.0.lock().map_err(|_| "تعذر قراءة حالة السيرفر")?;
    refresh_runtime_state(&mut runtime);
    Ok(payload_for(&runtime))
}

#[tauri::command]
pub fn start_server(
    app: AppHandle,
    state: State<'_, ServerState>,
    port: Option<u16>,
) -> Result<ServerStatusPayload, String> {
    let launcher_config = ensure_launcher_config(&app)?;
    if launcher_config.mode.as_deref() == Some("client") {
        return Err("هذا الجهاز مضبوط على وضع العميل ولا يمكنه تشغيل السيرفر المحلي".into());
    }
    let mut runtime = state.0.lock().map_err(|_| "تعذر تحديث حالة السيرفر")?;
    refresh_runtime_state(&mut runtime);

    if runtime.status == "running" {
        return Ok(payload_for(&runtime));
    }

    let next_port = port.unwrap_or(runtime.port.max(1));
    runtime.status = "starting".into();
    runtime.error = None;

    match start_child(&app, next_port) {
        Ok(child) => {
            runtime.port = next_port;
            runtime.pid = Some(child.id());
            runtime.child = Some(child);
            runtime.status = "running".into();
        }
        Err(error) => {
            runtime.status = "error".into();
            runtime.error = Some(error);
        }
    }

    Ok(payload_for(&runtime))
}

#[tauri::command]
pub fn stop_server(state: State<'_, ServerState>) -> Result<ServerStatusPayload, String> {
    let mut runtime = state.0.lock().map_err(|_| "تعذر تحديث حالة السيرفر")?;

    stop_known_backends(&mut runtime);
    wait_for_backend_shutdown();
    sync_runtime_with_system(&mut runtime);
    Ok(payload_for(&runtime))
}

#[tauri::command]
pub fn restart_server(
    app: AppHandle,
    state: State<'_, ServerState>,
    port: Option<u16>,
) -> Result<ServerStatusPayload, String> {
    {
        let mut runtime = state.0.lock().map_err(|_| "تعذر تحديث حالة السيرفر")?;
        stop_known_backends(&mut runtime);
        wait_for_backend_shutdown();
        sync_runtime_with_system(&mut runtime);
    }

    start_server(app, state, port)
}
