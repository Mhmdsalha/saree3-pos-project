from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def run(command: list[str], cwd: Path) -> None:
    completed = subprocess.run(command, cwd=cwd, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def main() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    python_exe = backend_dir / "venv" / "Scripts" / "python.exe"
    output_dir = backend_dir / "dist"
    work_dir = backend_dir / "build" / "pyinstaller-license-admin"
    spec_dir = backend_dir / "build" / "pyinstaller-spec"
    executable_name = "flowpos-license-admin"
    entrypoint = backend_dir / "scripts" / "license_admin_desktop.py"

    if not python_exe.exists():
        raise SystemExit(f"Backend python not found: {python_exe}")

    output_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    spec_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"{executable_name}.exe"
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
        str(output_dir),
        "--workpath",
        str(work_dir),
        "--specpath",
        str(spec_dir),
        "--paths",
        str(backend_dir),
        str(entrypoint),
    ]

    run(command, backend_dir)

    if not output_path.exists():
        raise SystemExit(f"Desktop build finished without output: {output_path}")

    print(output_path)


if __name__ == "__main__":
    main()
