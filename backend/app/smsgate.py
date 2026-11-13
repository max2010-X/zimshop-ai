import base64
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


_token_lock = threading.Lock()
_token_cache: dict[str, Any] = {}
_SCOPES = [
    "devices:list",
    "messages:send",
    "messages:list",
    "messages:read",
    "messages:cancel",
    "inbox:list",
    "inbox:refresh",
    "webhooks:list",
    "webhooks:write",
    "webhooks:delete",
    "settings:read",
    "settings:write",
]


class SMSGateError(RuntimeError):
    pass


def _mode() -> str:
    mode = os.getenv("SMSGATE_MODE", "cloud").strip().casefold()
    if mode not in {"cloud", "private", "local"}:
        raise SMSGateError("SMSGATE_MODE must be cloud, private, or local.")
    return mode


def _api_root() -> str:
    mode = _mode()
    configured_url = os.getenv("SMSGATE_API_URL", "").strip().rstrip("/")
    if mode == "cloud":
        if not configured_url:
            return "https://api.sms-gate.app/3rdparty/v1"
        if configured_url.endswith("/messages"):
            configured_url = configured_url[:-len("/messages")]
        return configured_url if configured_url.endswith("/3rdparty/v1") else f"{configured_url}/3rdparty/v1"
    if not configured_url:
        raise SMSGateError("Set SMSGATE_API_URL for Private Server or Local Server mode.")
    if mode == "local":
        return configured_url
    if configured_url.endswith("/api/3rdparty/v1"):
        return configured_url
    if configured_url.endswith("/api/3rdparty"):
        return f"{configured_url}/v1"
    if configured_url.endswith("/3rdparty/v1"):
        return f"{configured_url.rsplit('/3rdparty/v1', 1)[0]}/api/3rdparty/v1"
    return f"{configured_url}/api/3rdparty/v1"


def is_configured() -> bool:
    try:
        _api_root()
    except SMSGateError:
        return False
    return bool(os.getenv("SMSGATE_USERNAME", "").strip() and os.getenv("SMSGATE_PASSWORD", ""))


def connection_info() -> dict[str, str | bool]:
    mode = _mode()
    root = _api_root()
    parsed = urlsplit(root)
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")
    return {
        "mode": mode,
        "api_url": root,
        "configured": is_configured(),
        "auth_type": "basic" if mode == "local" else "jwt",
        "health_url": f"{origin}/health",
    }


def _token_request(path: str, *, refresh_token: str | None = None) -> dict[str, Any]:
    root = _api_root()
    username = os.getenv("SMSGATE_USERNAME", "").strip()
    password = os.getenv("SMSGATE_PASSWORD", "")
    headers = {"Content-Type": "application/json"}
    if refresh_token:
        headers["Authorization"] = f"Bearer {refresh_token}"
        body = None
        method = "POST"
    else:
        if not username or not password:
            raise SMSGateError("SMSGATE_USERNAME and SMSGATE_PASSWORD are required.")
        credentials = base64.b64encode(f"{username}:{password}".encode()).decode()
        headers["Authorization"] = f"Basic {credentials}"
        body = json.dumps({"ttl": 3600, "scopes": _SCOPES}).encode()
        method = "POST"
    request = Request(f"{root}/{path}", data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode())
    except (HTTPError, URLError, ValueError, json.JSONDecodeError) as exc:
        raise SMSGateError("Could not authenticate with SMSGate. Check its URL and server-side credentials.") from exc
    if not isinstance(payload, dict) or not payload.get("access_token") or not payload.get("refresh_token"):
        raise SMSGateError("SMSGate returned an invalid token response.")
    try:
        expires_at = datetime.fromisoformat(str(payload["expires_at"]).replace("Z", "+00:00"))
    except (KeyError, ValueError) as exc:
        raise SMSGateError("SMSGate returned an invalid token expiry.") from exc
    return {
        "access_token": payload["access_token"],
        "refresh_token": payload["refresh_token"],
        "expires_at": expires_at,
    }


def _get_access_token() -> str:
    cache_key = f"{_api_root()}:{os.getenv('SMSGATE_USERNAME', '').strip()}"
    with _token_lock:
        cached = _token_cache.get(cache_key)
        if cached and datetime.now(timezone.utc) + timedelta(seconds=60) < cached["expires_at"]:
            return str(cached["access_token"])
        if cached:
            try:
                _token_cache[cache_key] = _token_request("auth/token/refresh", refresh_token=cached["refresh_token"])
            except SMSGateError:
                _token_cache[cache_key] = _token_request("auth/token")
        else:
            _token_cache[cache_key] = _token_request("auth/token")
        return str(_token_cache[cache_key]["access_token"])


def _endpoint(path: str) -> str:
    mode = _mode()
    if mode == "local":
        local_paths = {
            "messages": "message",
            "health": "health",
            "inbox": "inbox",
            "settings": "settings",
        }
        mapped = local_paths.get(path.split("/", 1)[0], path)
        suffix = path[len(path.split("/", 1)[0]):]
        return f"{_api_root()}/{mapped}{suffix}"
    return f"{_api_root()}/{path.lstrip('/')}"


def request_json(
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    query: dict[str, Any] | None = None,
) -> Any:
    mode = _mode()
    url = _endpoint(path)
    if query:
        url = f"{url}?{urlencode({key: value for key, value in query.items() if value is not None})}"
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if mode == "local":
        username = os.getenv("SMSGATE_USERNAME", "").strip()
        password = os.getenv("SMSGATE_PASSWORD", "")
        if not username or not password:
            raise SMSGateError("SMSGATE_USERNAME and SMSGATE_PASSWORD are required.")
        headers["Authorization"] = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
    else:
        headers["Authorization"] = f"Bearer {_get_access_token()}"
    request = Request(url, data=body, headers=headers, method=method.upper())
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read()
    except HTTPError as exc:
        if exc.code == 401 and mode != "local":
            with _token_lock:
                _token_cache.pop(f"{_api_root()}:{os.getenv('SMSGATE_USERNAME', '').strip()}", None)
            headers["Authorization"] = f"Bearer {_get_access_token()}"
            retry = Request(url, data=body, headers=headers, method=method.upper())
            try:
                with urlopen(retry, timeout=20) as response:
                    raw = response.read()
            except (HTTPError, URLError) as retry_error:
                raise SMSGateError(f"SMSGate request failed with HTTP {retry_error.code if isinstance(retry_error, HTTPError) else 'network error'}.") from retry_error
        else:
            raise SMSGateError(f"SMSGate request failed with HTTP {exc.code}.") from exc
    except URLError as exc:
        raise SMSGateError("Could not connect to SMSGate.") from exc
    if not raw:
        return None
    try:
        return json.loads(raw.decode())
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SMSGateError("SMSGate returned an invalid JSON response.")


def health() -> Any:
    info = connection_info()
    headers = {"Accept": "application/json"}
    if _mode() == "local":
        username = os.getenv("SMSGATE_USERNAME", "").strip()
        password = os.getenv("SMSGATE_PASSWORD", "")
        if not username or not password:
            raise SMSGateError("SMSGATE_USERNAME and SMSGATE_PASSWORD are required.")
        headers["Authorization"] = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
    else:
        headers["Authorization"] = f"Bearer {_get_access_token()}"
    request = Request(str(info["health_url"]), headers=headers)
    try:
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode())
    except (HTTPError, URLError, ValueError, json.JSONDecodeError) as exc:
        raise SMSGateError("SMSGate health check failed.") from exc


def list_devices() -> list[dict[str, Any]]:
    if _mode() == "local":
        return []
    response = request_json("GET", "devices")
    if isinstance(response, list):
        return response
    if isinstance(response, dict) and isinstance(response.get("devices"), list):
        return response["devices"]
    raise SMSGateError("SMSGate returned an unexpected device list.")


def list_messages(*, limit: int = 50, offset: int = 0) -> Any:
    return request_json("GET", "messages", query={"limit": limit, "offset": offset})


def list_inbox(*, limit: int = 50, offset: int = 0) -> Any:
    if _mode() != "local":
        raise SMSGateError("SMSGate inbox retrieval is available only in Local Server mode; use webhook-backed inbox records for Cloud/Private mode.")
    return request_json("GET", "inbox", query={"limit": limit, "offset": offset, "type": "SMS"})


def send_sms_message(
    recipient: str,
    message: str,
    message_id: str,
    device_id: str | None = None,
    sim_number: int | None = None,
) -> str:
    if os.getenv("SMS_SENDING_ENABLED", "false").strip().casefold() != "true":
        raise SMSGateError("SMS sending is disabled until the production launch checks are complete.")
    payload: dict[str, Any] = {
        "id": message_id,
        "phoneNumbers": [recipient],
        "textMessage": {"text": message},
        "withDeliveryReport": True,
    }
    if device_id:
        payload["deviceId"] = device_id
    if sim_number:
        payload["simNumber"] = sim_number
    response = request_json("POST", "messages", payload=payload)
    if not isinstance(response, dict) or not response.get("id"):
        raise SMSGateError("SMSGate returned an invalid message response.")
    return str(response["id"])