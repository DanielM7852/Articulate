"""Owner credentials for the classroom database.

`classroom_owner.json` in the store (the identity that published a local
`articulate-classroom`) wins. Without it, the backend's SPACETIME_TOKEN owns the
configured SpacetimeDB database. The token is never returned to the browser.
"""

import ipaddress
import json
from pathlib import Path
from urllib.parse import urlparse

from app.config import Settings
from app.paths import BACKEND_ROOT


def owner_path(settings: Settings) -> Path:
    raw = Path(settings.store_dir)
    candidates = [raw / "classroom_owner.json"]
    if not raw.is_absolute():
        candidates.insert(0, BACKEND_ROOT / raw / "classroom_owner.json")
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]


def load_owner(settings: Settings) -> dict | None:
    path = owner_path(settings)
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("token") and data.get("database") and data.get("uri"):
            return data
    database = settings.classroom_database or settings.spacetime_database
    uri = settings.classroom_uri or settings.spacetime_uri
    if settings.spacetime_token and database and uri:
        return {"token": settings.spacetime_token, "database": database, "uri": uri}
    return None


def is_local_uri(uri: str) -> bool:
    return urlparse(uri).hostname in {"127.0.0.1", "localhost"}


def dev_classroom_enabled(owner: dict, settings: Settings) -> bool:
    return is_local_uri(owner["uri"]) or bool(settings.classroom_dev_identities)


def _hostname(value: str) -> str:
    raw = value.strip()
    if raw.startswith("["):
        return raw[1:].split("]", 1)[0].lower()
    if raw.count(":") == 1:
        return raw.split(":", 1)[0].lower()
    return raw.lower()


def _public_hostname(hostname: str) -> bool:
    if hostname in {"", "localhost"}:
        return False
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return True
    if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv4Address) and address in ipaddress.ip_network("100.64.0.0/10"):
        return False
    return True


def browser_database_uri(
    owner_uri: str,
    *,
    enabled: bool,
    host: str,
    forwarded_proto: str,
    forwarded_host: str = "",
    origin: str = "",
) -> str:
    """URI the browser should open.

    The publisher token stays on a local database URI. When the console is
    served from a public host that proxies the database, the browser has to
    use that host instead of 127.0.0.1. A proxy in front of the container can
    replace Host with a private address, so the public name is taken from
    X-Forwarded-Host or Origin in that case.
    """
    if not enabled:
        return owner_uri
    proto = forwarded_proto if forwarded_proto in {"http", "https"} else "https"
    if _public_hostname(_hostname(host)):
        return f"{proto}://{host}"
    forwarded = forwarded_host.split(",", 1)[0].strip()
    if _public_hostname(_hostname(forwarded)):
        return f"{proto}://{forwarded}"
    parsed = urlparse(origin)
    if parsed.scheme in {"http", "https"} and parsed.netloc and _public_hostname(_hostname(parsed.hostname or "")):
        return f"{parsed.scheme}://{parsed.netloc}"
    return owner_uri
