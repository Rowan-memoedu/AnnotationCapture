"""Install the isolated gateway through the host's managed staging runner."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import time
import urllib.request


def run(*command):
    return subprocess.run(command, check=True, capture_output=True, text=True)


def healthy(url):
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            return response.status == 200 and json.load(response).get("status") == "ok"
    except (OSError, ValueError):
        return False


def main():
    stage = Path(__file__).resolve().parent.parent
    if stage.parent != Path("/tmp") or not stage.name.startswith("annotationcapture-"):
        raise ValueError("Invalid deployment stage")
    manifest = json.loads((stage / "manifest.json").read_text())
    for name, expected in manifest.items():
        if hashlib.sha256((stage / name).read_bytes()).hexdigest() != expected:
            raise ValueError("Deployment file hash mismatch")
    if shutil.disk_usage("/").free < 1024 ** 3:
        raise RuntimeError("At least 1 GiB server free space is required")
    app = Path("/opt/annotationcapture/app")
    marker = app / ".annotationcapture-managed"
    if app.exists() and not marker.exists() and any(p.is_file() or p.is_symlink() for p in app.rglob("*")):
        raise RuntimeError("Refusing to overwrite an unmanaged application directory")
    if not healthy("http://127.0.0.1:18768/api/health"):
        raise RuntimeError("Existing learning service is unhealthy before deployment")
    if not marker.exists():
        probe = socket.socket()
        occupied = probe.connect_ex(("127.0.0.1", 18879)) == 0
        probe.close()
        if occupied:
            raise RuntimeError("Gateway port is occupied")
    result = subprocess.run(["python3", "-m", "unittest", "discover", "-s", str(stage / "gateway"), "-p", "test_*.py"], capture_output=True, text=True)
    (stage / "tests.log").write_text(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError("Linux gateway tests failed")
    try:
        account = pwd.getpwnam("annotationcapture")
    except KeyError:
        run("useradd", "--system", "--user-group", "--home-dir", "/var/lib/annotationcapture", "--shell", "/usr/sbin/nologin", "annotationcapture")
        account = pwd.getpwnam("annotationcapture")
    for directory in (app / "gateway", Path("/var/lib/annotationcapture"), Path("/etc/annotationcapture")):
        if directory.is_symlink():
            raise RuntimeError("Managed directory must not be a symlink")
        directory.mkdir(parents=True, exist_ok=True)
    data = Path("/var/lib/annotationcapture")
    data.chmod(0o700)
    os.chown(data, account.pw_uid, account.pw_gid)
    Path("/etc/annotationcapture").chmod(0o700)
    config = Path("/etc/annotationcapture/provider.env")
    if not config.exists():
        config.write_text("# Unified provider is configured by the administrator.\n")
        config.chmod(0o600)
    nginx = Path("/etc/nginx/sites-available/graspmemoedu")
    unit = Path("/etc/systemd/system/annotationcapture.service")
    snippet = Path("/etc/nginx/snippets/annotationcapture.conf")
    original_nginx = nginx.read_bytes()
    destinations = {app / "gateway/server.py": stage / "gateway/server.py", unit: stage / "gateway/annotationcapture.service", snippet: stage / "gateway/nginx-location.conf"}
    previous = {str(target): target.read_bytes() if target.exists() else None for target in destinations}
    try:
        for target, source in destinations.items():
            if target.is_symlink():
                raise RuntimeError("Managed file must not be a symlink")
            shutil.copyfile(source, target)
            target.chmod(0o644)
        text = original_nginx.decode()
        include = "include /etc/nginx/snippets/annotationcapture.conf;"
        if include not in text:
            anchors = [line for line in text.splitlines() if line.lstrip().startswith("location ~ ^/(api|guide-assets|subject-guide-assets)/ {")]
            if len(anchors) != 1:
                raise RuntimeError("Expected HTTPS proxy insertion point was not found")
            anchor = anchors[0]
            indentation = anchor[:len(anchor) - len(anchor.lstrip())]
            text = text.replace(anchor, indentation + include + "\n\n" + anchor, 1)
            nginx.write_text(text)
        run("nginx", "-t")
        run("systemctl", "daemon-reload")
        run("systemctl", "enable", "--now", "annotationcapture")
        run("systemctl", "restart", "annotationcapture")
        for _ in range(20):
            if healthy("http://127.0.0.1:18879/health"):
                break
            time.sleep(1)
        else:
            raise RuntimeError("New gateway failed its local health check")
        run("systemctl", "reload", "nginx")
        for _ in range(15):
            if healthy("https://124.221.144.155/annotationcapture/api/health") and healthy("https://124.221.144.155/api/health"):
                break
            time.sleep(1)
        else:
            raise RuntimeError("Public gateway or existing service health failed")
        marker.write_text("AnnotationCapture managed gateway\n")
        print(json.dumps({"deployed": True, "gatewayHealthy": True, "learningServiceHealthy": True, "linuxGatewayTests": 10, "hashes": manifest}))
    except Exception:
        if not marker.exists():
            subprocess.run(["systemctl", "disable", "--now", "annotationcapture"], capture_output=True)
        nginx.write_bytes(original_nginx)
        for target in destinations:
            content = previous[str(target)]
            if content is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(content)
        run("nginx", "-t")
        run("systemctl", "reload", "nginx")
        run("systemctl", "daemon-reload")
        if marker.exists():
            run("systemctl", "restart", "annotationcapture")
        raise


if __name__ == "__main__":
    main()
