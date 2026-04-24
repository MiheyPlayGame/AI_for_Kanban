import json
import base64
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib import error, request

from fastapi import HTTPException, status
from jose import JWTError, jwt

from app.config import settings

NOTION_API_VERSION = "2022-06-28"


def _notion_post(api_key: str, endpoint: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"https://api.notion.com/v1/{endpoint}",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Notion-Version": NOTION_API_VERSION,
            "Content-Type": "application/json",
        },
    )
    try:
        with request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except error.HTTPError as exc:
        detail = "Failed to call Notion API"
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("message", detail)
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Notion API error: {detail}",
        ) from exc
    except error.URLError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Notion API is unavailable",
        ) from exc


def _notion_oauth_post(payload: dict) -> dict:
    credentials = f"{settings.notion_client_id}:{settings.notion_client_secret}".encode("utf-8")
    auth_value = base64.b64encode(credentials).decode("utf-8")
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        "https://api.notion.com/v1/oauth/token",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Basic {auth_value}",
            "Content-Type": "application/json",
        },
    )
    try:
        with request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except error.HTTPError as exc:
        detail = "Failed to exchange OAuth code"
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("message", detail)
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Notion OAuth error: {detail}",
        ) from exc
    except error.URLError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Notion OAuth is unavailable",
        ) from exc


def validate_database_access(api_key: str, database_id: str) -> None:
    _notion_post(api_key, f"databases/{database_id}/query", {"page_size": 1})


def fetch_database_context(api_key: str, database_id: str, limit: int = 20) -> list[dict]:
    raw = _notion_post(api_key, f"databases/{database_id}/query", {"page_size": max(1, min(limit, 50))})
    result: list[dict] = []
    for page in raw.get("results", []):
        props = page.get("properties", {})
        item = {"id": page.get("id"), "url": page.get("url"), "title": _extract_title(props), "properties": {}}
        for key, value in props.items():
            item["properties"][key] = _normalize_property(value)
        result.append(item)
    return result


def list_accessible_databases(api_key: str, limit: int = 100) -> list[dict]:
    raw = _notion_post(
        api_key,
        "search",
        {
            "filter": {"property": "object", "value": "database"},
            "page_size": max(1, min(limit, 100)),
        },
    )
    items: list[dict] = []
    for db in raw.get("results", []):
        db_id = str(db.get("id") or "")
        if not db_id:
            continue
        title_chunks = db.get("title", []) if isinstance(db.get("title"), list) else []
        title = "".join(chunk.get("plain_text", "") for chunk in title_chunks).strip()
        items.append({"database_id": db_id, "title": title})
    return items


def find_task_in_context(
    items: list[dict],
    task_id: str | None = None,
    task_title: str | None = None,
) -> dict | None:
    normalized_title = task_title.strip().lower() if task_title else None
    for item in items:
        if task_id and item.get("id") == task_id:
            return item
        title = str(item.get("title", "")).strip().lower()
        if normalized_title and title and title == normalized_title:
            return item
    return None


def build_oauth_state(user_id: str, database_id: str | None, ttl_minutes: int) -> str:
    payload = {
        "sub": user_id,
        "type": "notion_oauth_state",
        "db": database_id,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def parse_oauth_state(state: str) -> tuple[str, str | None]:
    try:
        payload = jwt.decode(state, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth state") from exc
    if payload.get("type") != "notion_oauth_state" or not payload.get("sub"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth state")
    raw_db = payload.get("db")
    return str(payload["sub"]), str(raw_db) if raw_db else None


def build_oauth_authorize_url(state: str) -> str:
    if not settings.notion_client_id or not settings.notion_redirect_uri:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Notion OAuth settings are not configured",
        )
    query = urlencode(
        {
            "client_id": settings.notion_client_id,
            "response_type": "code",
            "owner": "user",
            "redirect_uri": settings.notion_redirect_uri,
            "state": state,
        }
    )
    return f"https://api.notion.com/v1/oauth/authorize?{query}"


def exchange_oauth_code(code: str) -> str:
    if not settings.notion_client_id or not settings.notion_client_secret or not settings.notion_redirect_uri:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Notion OAuth settings are not configured",
        )
    response = _notion_oauth_post(
        {"grant_type": "authorization_code", "code": code, "redirect_uri": settings.notion_redirect_uri}
    )
    token = response.get("access_token")
    if not token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Notion OAuth did not return access token")
    return str(token)


def _extract_title(properties: dict) -> str:
    for value in properties.values():
        if value.get("type") == "title":
            parts = value.get("title", [])
            return "".join(part.get("plain_text", "") for part in parts).strip()
    return ""


def _normalize_property(prop: dict):
    typ = prop.get("type")
    if typ == "status" and prop.get("status"):
        return prop["status"].get("name")
    if typ == "select" and prop.get("select"):
        return prop["select"].get("name")
    if typ == "multi_select":
        return [item.get("name") for item in prop.get("multi_select", []) if item.get("name")]
    if typ == "date":
        date = prop.get("date")
        return date.get("start") if date else None
    if typ == "number":
        return prop.get("number")
    if typ == "checkbox":
        return prop.get("checkbox")
    if typ == "rich_text":
        return "".join(item.get("plain_text", "") for item in prop.get("rich_text", [])).strip()
    if typ == "title":
        return "".join(item.get("plain_text", "") for item in prop.get("title", [])).strip()
    return None
