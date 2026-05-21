from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path


TARGET_TRIPLE = "x86_64-pc-windows-msvc"
SIDECAR_ENV_NAME = "flowpos-sidecar.env"
SIDECAR_ENV_KEYS = {
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "FLOWPOS_DEFAULT_TELEGRAM_BOT_USERNAME",
    "ENABLE_TELEGRAM_POLLING",
}


def append_hidden_import(command: list[str], module_name: str) -> None:
    if importlib.util.find_spec(module_name) is None:
        return
    command.extend(["--hidden-import", module_name])


def run(command: list[str], cwd: Path) -> None:
    completed = subprocess.run(command, cwd=cwd, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def build_sanitized_runtime_env(source: Path, output_dir: Path) -> Path | None:
    env_entries: dict[str, str] = {}
    if source.exists():
        for raw_line in source.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key in SIDECAR_ENV_KEYS and value.strip():
                env_entries[key] = value.strip()

    for key in SIDECAR_ENV_KEYS:
        value = os.environ.get(key, "").strip()
        if value and key not in env_entries:
            env_entries[key] = value

    if not env_entries:
        return None

    output_dir.mkdir(parents=True, exist_ok=True)
    runtime_env = output_dir / SIDECAR_ENV_NAME
    runtime_env.write_text("\n".join(f"{key}={env_entries[key]}" for key in sorted(env_entries)) + "\n", encoding="utf-8")
    return runtime_env


def main() -> None:
    launcher_dir = Path(__file__).resolve().parents[1]
    repo_root = launcher_dir.parent
    backend_dir = repo_root / "backend"
    frontend_dist = repo_root / "frontend" / "dist"
    env_file = backend_dir / ".env"
    python_exe = backend_dir / "venv" / "Scripts" / "python.exe"
    target_dir = launcher_dir / "src-tauri" / "binaries"
    work_dir = launcher_dir / "src-tauri" / "target" / "pyinstaller"
    spec_dir = launcher_dir / "src-tauri" / "target" / "pyinstaller-spec"
    executable_name = f"flowpos-backend-{TARGET_TRIPLE}"

    if not python_exe.exists():
        raise SystemExit(f"Backend python not found: {python_exe}")
    if not frontend_dist.exists():
        raise SystemExit(f"Frontend dist not found: {frontend_dist}")

    target_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    spec_dir.mkdir(parents=True, exist_ok=True)
    runtime_env_file = build_sanitized_runtime_env(env_file, spec_dir)

    output_path = target_dir / f"{executable_name}.exe"
    spec_path = spec_dir / f"{executable_name}.spec"

    if output_path.exists():
        output_path.unlink()
    if spec_path.exists():
        spec_path.unlink()

    command = [
        str(python_exe),
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--noconsole",
        "--disable-windowed-traceback",
        "--name",
        executable_name,
        "--distpath",
        str(target_dir),
        "--workpath",
        str(work_dir),
        "--specpath",
        str(spec_dir),
        "--paths",
        str(backend_dir),
        "--add-data",
        f"{frontend_dist};frontend/dist",
        "--add-data",
        f"{backend_dir / 'assets'};assets",
        "--collect-all",
        "reportlab",
        "--collect-submodules",
        "passlib.handlers",
        str(backend_dir / "launcher_entry.py"),
    ]

    # Production sidecars must not embed developer-machine secrets or local store
    # configuration. Only Telegram transport keys needed by the bundled local
    # polling flow are copied into a sanitized runtime env.
    if runtime_env_file:
        command.extend(["--add-data", f"{runtime_env_file};."])

    append_hidden_import(command, "aiosqlite")
    append_hidden_import(command, "asyncpg")
    append_hidden_import(command, "sqlalchemy.dialects.sqlite.aiosqlite")
    append_hidden_import(command, "sqlalchemy.dialects.postgresql.asyncpg")
    append_hidden_import(command, "uvicorn.logging")
    append_hidden_import(command, "uvicorn.loops.auto")
    append_hidden_import(command, "uvicorn.protocols.http.auto")
    append_hidden_import(command, "uvicorn.protocols.websockets.auto")
    append_hidden_import(command, "uvicorn.lifespan.on")

    run(command, launcher_dir)

    if not output_path.exists():
        raise SystemExit(f"Sidecar build finished without output: {output_path}")

    print(output_path)


if __name__ == "__main__":
    main()
