from __future__ import annotations

import ipaddress
import json
import os
import socket
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


ROOT_CA_DAYS = 3650
# iOS is stricter than most desktop browsers with locally trusted TLS certs.
# Keep the leaf/server certificate comfortably below Apple's modern 398-day
# validity window while reusing the same long-lived Root CA on mobiles.
SERVER_CERT_DAYS = 397
SERVER_RENEW_AFTER_DAYS = 360


@dataclass(frozen=True)
class LocalSslState:
    ssl_dir: Path
    root_ca_path: Path
    server_cert_path: Path
    server_key_path: Path
    cert_state_path: Path
    lan_ip: str
    cert_ready: bool
    root_ca_ready: bool
    server_cert_ready: bool
    root_ca_installed: bool
    status: str
    message: str


def _paths_for(app_data_dir: str | os.PathLike[str] | None) -> tuple[Path, Path, Path, Path, Path, Path]:
    base_dir = Path(app_data_dir or Path.cwd()).resolve()
    ssl_dir = base_dir / "ssl"
    return (
        ssl_dir,
        ssl_dir / "root_ca.pem",
        ssl_dir / "root_ca_key.pem",
        ssl_dir / "server_cert.pem",
        ssl_dir / "server_key.pem",
        ssl_dir / "cert_state.json",
    )


def get_lan_ip() -> str:
    for ip in get_local_ipv4_addresses():
        if not ip.startswith("127."):
            return ip

    return "127.0.0.1"


def get_local_ipv4_addresses() -> list[str]:
    seen: set[str] = set()
    addresses: list[str] = []

    def add(candidate: str | None) -> None:
        if not candidate:
            return
        try:
            ip = ipaddress.ip_address(candidate.strip())
        except Exception:
            return
        if ip.version != 4:
            return
        text = str(ip)
        if text.startswith("169.254."):
            return
        if text not in seen:
            seen.add(text)
            addresses.append(text)

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.2)
        sock.connect(("8.8.8.8", 80))
        add(sock.getsockname()[0])
        sock.close()
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        for candidate in socket.gethostbyname_ex(hostname)[2]:
            add(candidate)
    except Exception:
        pass

    if os.name == "nt":
        try:
            completed = subprocess.run(
                ["ipconfig"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            for line in (completed.stdout or "").splitlines():
                if "IPv4" not in line:
                    continue
                if ":" not in line:
                    continue
                add(line.split(":", 1)[1].strip())
        except Exception:
            pass

    add("127.0.0.1")
    return addresses


def get_local_ssl_runtime_status(app_data_dir: str | os.PathLike[str] | None) -> dict:
    """Report whether the running HTTPS certificate still matches the current LAN IP.

    Uvicorn loads the certificate at startup. If the LAN IP changes while the
    server is running, the certificate on disk can be renewed on next startup,
    but the active process still needs a restart before mobile browsers trust
    the scanner URL for the new IP.
    """
    ssl_dir, root_ca_path, _root_key_path, server_cert_path, _server_key_path, cert_state_path = _paths_for(app_data_dir)
    current_lan_ip = get_lan_ip()
    local_ips = get_local_ipv4_addresses()
    state_lan_ip: str | None = None
    try:
        if cert_state_path.exists():
            raw_state = json.loads(cert_state_path.read_text(encoding="utf-8"))
            state_lan_ip = str(raw_state.get("lan_ip") or "").strip() or None
    except Exception:
        state_lan_ip = None

    root_ready = root_ca_path.exists()
    server_ready = server_cert_path.exists()
    cert_ips: list[str] = []
    cert_dns: list[str] = []
    cert_covers_current_ip = False
    cert_not_after: str | None = None

    if server_ready:
        try:
            cert = _load_cert(server_cert_path)
            cert_not_after = cert.not_valid_after_utc.isoformat()
            san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            cert_ips = [str(value) for value in san.get_values_for_type(x509.IPAddress)]
            cert_dns = list(san.get_values_for_type(x509.DNSName))
            cert_covers_current_ip = all(str(ipaddress.ip_address(ip)) in cert_ips for ip in local_ips)
        except Exception:
            server_ready = False

    restart_required = bool(root_ready and server_ready and not cert_covers_current_ip)
    if restart_required:
        status = "ip_changed_restart_required"
        message = "تغيّر عنوان الشبكة. اضغط تحديث اتصال الماسح ثم امسح QR جديد؛ لا تحتاج تثبيت شهادة جديدة."
    elif root_ready and server_ready:
        status = "ready"
        message = "صلاحية شهادة الاتصال سليمة"
    else:
        status = "not_ready"
        message = "شهادة الاتصال المحلي غير جاهزة"

    return {
        "ssl_dir": str(ssl_dir),
        "lan_ip": current_lan_ip,
        "local_ips": local_ips,
        "cert_lan_ip": state_lan_ip,
        "cert_ips": cert_ips,
        "cert_dns": cert_dns,
        "server_cert_not_after": cert_not_after,
        "root_ca_ready": root_ready,
        "server_cert_ready": server_ready,
        "cert_covers_current_ip": cert_covers_current_ip,
        "restart_required": restart_required,
        "status": status,
        "message": message,
    }


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _write_private_key(path: Path, key) -> None:
    path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def _write_cert(path: Path, cert: x509.Certificate) -> None:
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _load_key(path: Path):
    return serialization.load_pem_private_key(path.read_bytes(), password=None)


def _load_cert(path: Path) -> x509.Certificate:
    return x509.load_pem_x509_certificate(path.read_bytes())


def _generate_root_ca(root_ca_path: Path, root_key_path: Path) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    subject = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "PS"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "FlowPOS Saree Local"),
        x509.NameAttribute(NameOID.COMMON_NAME, "FlowPOS Saree Local Root CA"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(_now() - timedelta(days=1))
        .not_valid_after(_now() + timedelta(days=ROOT_CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.KeyUsage(
            digital_signature=True,
            key_cert_sign=True,
            crl_sign=True,
            key_encipherment=False,
            data_encipherment=False,
            key_agreement=False,
            content_commitment=False,
            encipher_only=False,
            decipher_only=False,
        ), critical=True)
        .sign(key, hashes.SHA256())
    )
    _write_private_key(root_key_path, key)
    _write_cert(root_ca_path, cert)


def _server_alt_names(lan_ip: str) -> x509.SubjectAlternativeName:
    names: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
    ]
    for candidate in [lan_ip, *get_local_ipv4_addresses()]:
        try:
            ip_name = x509.IPAddress(ipaddress.ip_address(candidate))
        except Exception:
            continue
        if ip_name not in names:
            names.append(ip_name)
    return x509.SubjectAlternativeName(names)


def _server_cert_needs_renewal(cert_path: Path, lan_ip: str) -> bool:
    if not cert_path.exists():
        return True
    try:
        cert = _load_cert(cert_path)
        expires_at = cert.not_valid_after_utc
        total_lifetime = cert.not_valid_after_utc - cert.not_valid_before_utc
        if total_lifetime > timedelta(days=SERVER_CERT_DAYS, minutes=10):
            return True
        if expires_at <= _now() + timedelta(days=25):
            return True
        lifetime_used = _now() - cert.not_valid_before_utc
        if lifetime_used >= timedelta(days=SERVER_RENEW_AFTER_DAYS):
            return True
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        cert_ips = san.get_values_for_type(x509.IPAddress)
        for candidate in [lan_ip, *get_local_ipv4_addresses()]:
            try:
                if ipaddress.ip_address(candidate) not in cert_ips:
                    return True
            except Exception:
                return True
        if "localhost" not in san.get_values_for_type(x509.DNSName):
            return True
        return False
    except Exception:
        return True


def _generate_server_cert(
    root_ca_path: Path,
    root_key_path: Path,
    server_cert_path: Path,
    server_key_path: Path,
    lan_ip: str,
) -> None:
    root_cert = _load_cert(root_ca_path)
    root_key = _load_key(root_key_path)
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "FlowPOS Saree Local"),
        x509.NameAttribute(NameOID.COMMON_NAME, "FlowPOS Local HTTPS Server"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(root_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(_now() - timedelta(minutes=5))
        .not_valid_after(_now() + timedelta(days=SERVER_CERT_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(_server_alt_names(lan_ip), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(server_key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), critical=False)
        .add_extension(x509.KeyUsage(
            digital_signature=True,
            key_cert_sign=False,
            crl_sign=False,
            key_encipherment=True,
            data_encipherment=False,
            key_agreement=False,
            content_commitment=False,
            encipher_only=False,
            decipher_only=False,
        ), critical=True)
        .sign(root_key, hashes.SHA256())
    )
    _write_private_key(server_key_path, server_key)
    _write_cert(server_cert_path, cert)


def _install_windows_user_root(root_ca_path: Path) -> bool:
    if os.name != "nt":
        return False
    try:
        completed = subprocess.run(
            ["certutil", "-user", "-addstore", "Root", str(root_ca_path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        combined = f"{completed.stdout or ''}\n{completed.stderr or ''}".lower()
        return completed.returncode == 0 or "already exists" in combined
    except Exception:
        return False


def ensure_local_ssl(app_data_dir: str | os.PathLike[str] | None) -> LocalSslState:
    ssl_dir, root_ca_path, root_key_path, server_cert_path, server_key_path, cert_state_path = _paths_for(app_data_dir)
    ssl_dir.mkdir(parents=True, exist_ok=True)
    lan_ip = get_lan_ip()

    root_ready = root_ca_path.exists() and root_key_path.exists()
    if root_ready:
        try:
            _load_cert(root_ca_path)
            _load_key(root_key_path)
        except Exception:
            root_ready = False

    if not root_ready:
        _generate_root_ca(root_ca_path, root_key_path)
        root_ready = True

    server_ready = server_cert_path.exists() and server_key_path.exists()
    if server_ready:
        try:
            _load_key(server_key_path)
        except Exception:
            server_ready = False

    if not server_ready or _server_cert_needs_renewal(server_cert_path, lan_ip):
        _generate_server_cert(root_ca_path, root_key_path, server_cert_path, server_key_path, lan_ip)
        server_ready = True
        status = "server_cert_updated"
        message = "تم تحديث شهادة الاتصال المحلي"
    else:
        status = "ready"
        message = "صلاحية شهادة الاتصال سليمة"

    root_installed = _install_windows_user_root(root_ca_path)
    state = {
        "lan_ip": lan_ip,
        "local_ips": get_local_ipv4_addresses(),
        "status": status,
        "root_ca_path": str(root_ca_path),
        "server_cert_path": str(server_cert_path),
        "server_cert_not_after": _load_cert(server_cert_path).not_valid_after_utc.isoformat(),
        "updated_at": _now().isoformat(),
    }
    cert_state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    return LocalSslState(
        ssl_dir=ssl_dir,
        root_ca_path=root_ca_path,
        server_cert_path=server_cert_path,
        server_key_path=server_key_path,
        cert_state_path=cert_state_path,
        lan_ip=lan_ip,
        cert_ready=root_ready and server_ready,
        root_ca_ready=root_ready,
        server_cert_ready=server_ready,
        root_ca_installed=root_installed,
        status=status,
        message=message,
    )
