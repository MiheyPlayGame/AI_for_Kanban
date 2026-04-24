import os
import json
import re
import math
from uuid import UUID
from urllib import error, request

from fastapi import Body, Depends, FastAPI, HTTPException, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import create_access_token, create_refresh_token, decode_token
from app.config import settings
from app.database import Base, engine
from app.deps import get_current_user, get_db
from app.llm import generate_assistant_reply
from app.models import Attachment, Chat, Message, NotionDatabase, NotionIntegration, User
from app.notion import (
    build_oauth_authorize_url,
    build_oauth_state,
    exchange_oauth_code,
    fetch_database_context,
    find_task_in_context,
    list_accessible_databases,
    parse_oauth_state,
    validate_database_access,
)
from app.schemas import (
    ChatCreateResponse,
    LoginRequest,
    MessageCreateRequest,
    MessageRead,
    NotionConnectRequest,
    NotionDatabaseEntry,
    NotionDatabasesResponse,
    NotionOAuthCallbackResponse,
    NotionOAuthStartRequest,
    NotionOAuthStartResponse,
    NotionContextResponse,
    NotionStatusResponse,
    RefreshRequest,
    RegisterRequest,
    SemanticChatMatch,
    SemanticInformationMatch,
    SemanticNotionMatch,
    SemanticSearchRequest,
    SemanticSearchResponse,
    SendMessageResponse,
    SummaryRequest,
    SummaryResponse,
    TaskDecomposeRequest,
    TaskDecomposeResponse,
    TokenResponse,
)

app = FastAPI(title="AI Assistant Backend")


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    run_tests_on_startup()


def run_tests_on_startup():
    should_run = os.getenv("RUN_TESTS_ON_STARTUP", "1").lower() in {"1", "true", "yes"}
    if not should_run or os.getenv("PYTEST_CURRENT_TEST"):
        return
    try:
        import pytest
    except ImportError:
        return
    exit_code = pytest.main(["-q", "tests"])
    if exit_code != 0:
        raise RuntimeError("Startup tests failed. Server startup aborted.")


def _extract_text_from_context_link(link: str, context: list[dict]) -> str | None:
    normalized_link = link.strip()
    for item in context:
        item_link = str(item.get("link") or item.get("url") or "").strip()
        if item_link != normalized_link:
            continue
        for key in ("text", "content", "description", "summary", "title"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        props = item.get("properties")
        if isinstance(props, dict):
            for key in ("text", "content", "description", "details"):
                value = props.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def _clean_html_to_text(html: str) -> str:
    without_script = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    without_style = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", without_script, flags=re.IGNORECASE)
    plain = re.sub(r"<[^>]+>", " ", without_style)
    plain = re.sub(r"\s+", " ", plain)
    return plain.strip()


def _fetch_text_from_link(link: str) -> str:
    req = request.Request(link, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
    except error.HTTPError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Failed to fetch text from link") from exc
    except error.URLError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Link is unavailable") from exc

    text = _clean_html_to_text(body)
    if not text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No text could be extracted from link")
    return text


def _tokenize_semantic(text: str) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9]+", text.lower()) if len(token) > 1]


def _term_frequencies(tokens: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for token in tokens:
        counts[token] = counts.get(token, 0) + 1
    return counts


def _build_bm25_stats(documents: list[list[str]]) -> tuple[dict[str, int], float]:
    document_frequencies: dict[str, int] = {}
    for doc_tokens in documents:
        for token in set(doc_tokens):
            document_frequencies[token] = document_frequencies.get(token, 0) + 1
    avg_doc_len = (sum(len(doc) for doc in documents) / len(documents)) if documents else 0.0
    return document_frequencies, avg_doc_len


def _bm25_term_score(
    tf: int,
    doc_len: int,
    avg_doc_len: float,
    doc_freq: int,
    total_docs: int,
    k1: float = 1.5,
    b: float = 0.75,
) -> float:
    if tf <= 0 or total_docs <= 0:
        return 0.0
    idf = math.log(1 + ((total_docs - doc_freq + 0.5) / (doc_freq + 0.5)))
    norm = k1 * (1 - b + (b * (doc_len / max(avg_doc_len, 1e-9))))
    return idf * ((tf * (k1 + 1)) / (tf + norm))


def _bm25_document_score(
    query_tokens: list[str],
    doc_tokens: list[str],
    doc_freqs: dict[str, int],
    avg_doc_len: float,
    total_docs: int,
) -> float:
    if not query_tokens or not doc_tokens:
        return 0.0
    tf = _term_frequencies(doc_tokens)
    score = 0.0
    for token in query_tokens:
        score += _bm25_term_score(
            tf=tf.get(token, 0),
            doc_len=len(doc_tokens),
            avg_doc_len=avg_doc_len,
            doc_freq=doc_freqs.get(token, 0),
            total_docs=total_docs,
        )
    return score


def _normalize_scores(raw_scores: list[float]) -> list[float]:
    if not raw_scores:
        return []
    max_score = max(raw_scores)
    if max_score <= 0:
        return [0.0 for _ in raw_scores]
    return [round(score / max_score, 4) for score in raw_scores]


def _split_into_snippets(text: str) -> list[str]:
    if not text.strip():
        return []
    parts = re.split(r"(?<=[\.\!\?])\s+|\n+", text)
    snippets = [part.strip() for part in parts if part and part.strip()]
    return snippets


def _compact_snippet(snippet: str, max_len: int = 320) -> str:
    cleaned = re.sub(r"\s+", " ", snippet).strip()
    if len(cleaned) <= max_len:
        return cleaned
    return f"{cleaned[:max_len].rstrip()}..."


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/summaries", response_model=SummaryResponse)
def summarize_text(
    payload: SummaryRequest,
    current_user: User = Depends(get_current_user),
):
    del current_user
    source = "text"
    if payload.text and payload.text.strip():
        source_text = payload.text.strip()
    else:
        assert payload.link is not None
        source = "link"
        source_text = _extract_text_from_context_link(payload.link, [item.model_dump() for item in payload.context]) or ""
        if not source_text:
            source_text = _fetch_text_from_link(payload.link)

    prompt = (
        "Create a concise and useful summary of the following text. "
        "Keep it short and clear, focusing on main points.\n\n"
        f"Text:\n{source_text}"
    )
    summary = generate_assistant_reply([], prompt)
    return SummaryResponse(summary=summary, source=source)


@app.post("/search/semantic", response_model=SemanticSearchResponse)
def semantic_search(
    payload: SemanticSearchRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notion_matches: list[SemanticNotionMatch] = []
    chat_matches: list[SemanticChatMatch] = []
    information_matches: list[SemanticInformationMatch] = []
    query_tokens = _tokenize_semantic(payload.query)

    if payload.include_notion:
        integration = db.get(NotionIntegration, current_user.id)
        if integration:
            all_items: list[dict] = []
            for database_id in _get_user_notion_database_ids(integration):
                scoped = fetch_database_context(integration.api_key, database_id, limit=payload.notion_limit)
                for row in scoped:
                    row["source_database_id"] = database_id
                all_items.extend(scoped)
            items = all_items
            title_weight = 2.5
            property_weight = 1.4
            description_weight = 0.9

            title_docs: list[list[str]] = []
            props_docs: list[list[str]] = []
            desc_docs: list[list[str]] = []
            for item in items:
                properties = item.get("properties", {}) if isinstance(item.get("properties"), dict) else {}
                title_docs.append(_tokenize_semantic(str(item.get("title", ""))))
                props_parts = []
                for key, value in properties.items():
                    if key.lower() == "description":
                        continue
                    if value is not None:
                        props_parts.append(str(value))
                props_docs.append(_tokenize_semantic(" ".join(props_parts)))
                desc_docs.append(_tokenize_semantic(str(properties.get("Description", ""))))

            title_df, title_avg = _build_bm25_stats(title_docs)
            props_df, props_avg = _build_bm25_stats(props_docs)
            desc_df, desc_avg = _build_bm25_stats(desc_docs)

            raw_scores: list[float] = []
            for idx, _item in enumerate(items):
                title_score = _bm25_document_score(query_tokens, title_docs[idx], title_df, title_avg, len(items))
                props_score = _bm25_document_score(query_tokens, props_docs[idx], props_df, props_avg, len(items))
                desc_score = _bm25_document_score(query_tokens, desc_docs[idx], desc_df, desc_avg, len(items))
                raw_scores.append(
                    (title_weight * title_score)
                    + (property_weight * props_score)
                    + (description_weight * desc_score)
                )

            normalized_scores = _normalize_scores(raw_scores)
            scored_items: list[tuple[float, dict]] = []
            for idx, item in enumerate(items):
                score = normalized_scores[idx]
                if score > 0:
                    scored_items.append((score, item))
            scored_items.sort(key=lambda pair: pair[0], reverse=True)
            notion_matches = [
                SemanticNotionMatch(score=score, item=item) for score, item in scored_items[: payload.top_k]
            ]

            snippet_entries: list[tuple[float, dict]] = []
            for item in items:
                properties = item.get("properties", {}) if isinstance(item.get("properties"), dict) else {}
                source_id = str(item.get("id") or item.get("url") or "")
                source_label = str(item.get("title", "")).strip() or "Notion item"
                candidate_texts = [source_label]
                candidate_texts.extend(str(v) for v in properties.values() if v is not None)
                for candidate in candidate_texts:
                    for snippet in _split_into_snippets(candidate):
                        score = _bm25_document_score(
                            query_tokens,
                            _tokenize_semantic(snippet),
                            *_build_bm25_stats([_tokenize_semantic(s) for s in _split_into_snippets(" ".join(candidate_texts))]),
                            max(1, len(_split_into_snippets(" ".join(candidate_texts)))),
                        )
                        if score > 0:
                            snippet_entries.append(
                                (
                                    score,
                                    {
                                        "source_type": "notion",
                                        "source_id": source_id,
                                        "source_label": source_label,
                                        "snippet": snippet,
                                    },
                                )
                            )
            snippet_entries.sort(key=lambda pair: pair[0], reverse=True)
            seen: set[tuple[str, str]] = set()
            for score, info in snippet_entries:
                compact = _compact_snippet(info["snippet"])
                dedupe_key = (info["source_id"], compact.lower())
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                information_matches.append(
                    SemanticInformationMatch(score=round(score, 4), snippet=compact, **{k: v for k, v in info.items() if k != "snippet"})
                )
                if len(information_matches) >= payload.top_k:
                    break

    if payload.include_chat_history:
        if payload.chat_id:
            chats = [get_user_chat_or_404(db, current_user.id, payload.chat_id)]
        else:
            chats = list(db.scalars(select(Chat).where(Chat.user_id == current_user.id)).all())

        all_messages: list[Message] = []
        for chat in chats:
            all_messages.extend(chat.messages)

        message_docs = [_tokenize_semantic(message.content) for message in all_messages]
        message_df, message_avg = _build_bm25_stats(message_docs)
        raw_message_scores = [
            _bm25_document_score(query_tokens, doc_tokens, message_df, message_avg, len(message_docs))
            for doc_tokens in message_docs
        ]
        normalized_message_scores = _normalize_scores(raw_message_scores)

        scored_messages: list[tuple[float, Message]] = []
        for idx, message in enumerate(all_messages):
            score = normalized_message_scores[idx]
            if score > 0:
                scored_messages.append((score, message))
        scored_messages.sort(key=lambda pair: pair[0], reverse=True)
        chat_matches = [
            SemanticChatMatch(score=score, message=message) for score, message in scored_messages[: payload.top_k]
        ]

        snippet_docs: list[list[str]] = []
        snippet_meta: list[tuple[Message, str]] = []
        for message in all_messages:
            for snippet in _split_into_snippets(message.content):
                snippet_docs.append(_tokenize_semantic(snippet))
                snippet_meta.append((message, snippet))
        snippet_df, snippet_avg = _build_bm25_stats(snippet_docs)
        raw_snippet_scores = [
            _bm25_document_score(query_tokens, doc_tokens, snippet_df, snippet_avg, len(snippet_docs))
            for doc_tokens in snippet_docs
        ]
        normalized_snippet_scores = _normalize_scores(raw_snippet_scores)
        for idx, score in enumerate(normalized_snippet_scores):
            if score <= 0:
                continue
            message, snippet = snippet_meta[idx]
            information_matches.append(
                SemanticInformationMatch(
                    score=score,
                    source_type="chat",
                    source_id=str(message.id),
                    source_label=f"{message.role} message",
                    snippet=_compact_snippet(snippet),
                )
            )

    information_matches.sort(key=lambda match: match.score, reverse=True)
    return SemanticSearchResponse(
        query=payload.query,
        notion_matches=notion_matches,
        chat_matches=chat_matches,
        information_matches=information_matches[: payload.top_k],
    )


@app.post("/auth/register", response_model=TokenResponse)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.get(User, payload.id)
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User already exists")

    user = User(id=payload.id, password=payload.password)
    db.add(user)
    db.commit()

    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


@app.post("/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.get(User, payload.id)
    if not user or user.password != payload.password:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


@app.post("/auth/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest):
    user_id = decode_token(payload.refresh_token, expected_type="refresh")
    return TokenResponse(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id),
    )


@app.post("/chats", response_model=ChatCreateResponse)
def create_chat(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    chat = Chat(user_id=current_user.id)
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return chat


@app.get("/chats", response_model=list[ChatCreateResponse])
def list_chats(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    stmt = select(Chat).where(Chat.user_id == current_user.id)
    return list(db.scalars(stmt).all())


def get_user_chat_or_404(db: Session, user_id: str, chat_id: UUID) -> Chat:
    stmt = select(Chat).where(Chat.id == chat_id, Chat.user_id == user_id)
    chat = db.scalar(stmt)
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return chat


def _normalize_db_id(value: str) -> str:
    return value.replace("-", "").strip().lower()


def _refresh_user_notion_databases(
    db: Session,
    integration: NotionIntegration,
    preferred_database_id: str | None = None,
) -> list[NotionDatabase]:
    discovered: list[dict] = []
    try:
        discovered = list_accessible_databases(integration.api_key, limit=100)
    except HTTPException:
        # Backward-compatible fallback: keep working with explicitly provided DB
        # even if listing accessible databases is temporarily unavailable.
        if preferred_database_id:
            discovered = [{"database_id": preferred_database_id, "title": ""}]
        else:
            raise
    if not discovered:
        if preferred_database_id:
            discovered = [{"database_id": preferred_database_id, "title": ""}]
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No Notion databases found. Share at least one database with the integration.",
            )

    normalized_preferred = _normalize_db_id(preferred_database_id) if preferred_database_id else None
    by_id: dict[str, NotionDatabase] = {item.database_id: item for item in integration.databases}
    ordered_ids: list[str] = []
    default_id: str | None = None

    for idx, item in enumerate(discovered):
        database_id = _normalize_db_id(str(item.get("database_id", "")))
        if not database_id:
            continue
        title = str(item.get("title") or "").strip()
        if database_id in by_id:
            row = by_id[database_id]
            row.title = title
        else:
            row = NotionDatabase(user_id=integration.user_id, database_id=database_id, title=title, is_default=False)
            db.add(row)
            integration.databases.append(row)
            by_id[database_id] = row
        ordered_ids.append(database_id)

        if normalized_preferred and database_id == normalized_preferred:
            default_id = database_id
        elif default_id is None and idx == 0:
            default_id = database_id

    if normalized_preferred and default_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provided database_id is not visible for this integration.",
        )

    for database_id, row in list(by_id.items()):
        if database_id not in ordered_ids:
            db.delete(row)

    for row in integration.databases:
        row.is_default = row.database_id == default_id

    if default_id:
        integration.database_id = default_id
    db.flush()
    return sorted(integration.databases, key=lambda row: (not row.is_default, row.title or row.database_id))


def _get_user_notion_database_ids(integration: NotionIntegration) -> list[str]:
    if integration.databases:
        return [item.database_id for item in integration.databases]
    return [_normalize_db_id(integration.database_id)] if integration.database_id else []


@app.delete("/chats/{chat_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chat(chat_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    chat = get_user_chat_or_404(db, current_user.id, chat_id)
    db.delete(chat)
    db.commit()


@app.get("/chats/{chat_id}/messages", response_model=list[MessageRead])
def get_messages(chat_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    chat = get_user_chat_or_404(db, current_user.id, chat_id)
    return chat.messages


@app.post("/integrations/notion/connect", response_model=NotionStatusResponse)
def connect_notion(
    payload_raw: object = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    payload_input: object = payload_raw
    if isinstance(payload_input, (bytes, bytearray)):
        payload_input = payload_input.decode("utf-8", errors="ignore")
    if isinstance(payload_input, str):
        stripped = payload_input.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            try:
                payload_input = json.loads(stripped)
            except json.JSONDecodeError:
                payload_input = stripped
        else:
            payload_input = stripped

    try:
        payload = NotionConnectRequest.model_validate(payload_input)
    except ValidationError as exc:
        safe_errors = []
        for error in exc.errors():
            safe_error = dict(error)
            if "input" in safe_error and isinstance(safe_error["input"], (bytes, bytearray)):
                safe_error["input"] = safe_error["input"].decode("utf-8", errors="ignore")
            safe_errors.append(safe_error)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=safe_errors) from exc

    preferred_database_id = _normalize_db_id(payload.database_id) if payload.database_id else None
    if preferred_database_id:
        validate_database_access(payload.api_key, preferred_database_id)
    integration = db.get(NotionIntegration, current_user.id)
    if integration:
        integration.api_key = payload.api_key
    else:
        integration = NotionIntegration(
            user_id=current_user.id,
            api_key=payload.api_key,
            database_id=preferred_database_id or "",
        )
        db.add(integration)
        db.flush()
    databases = _refresh_user_notion_databases(db, integration, preferred_database_id=preferred_database_id)
    db.commit()
    default_db = next((row.database_id for row in databases if row.is_default), None)
    return NotionStatusResponse(connected=True, database_id=default_db)


@app.post("/integrations/notion/oauth/start", response_model=NotionOAuthStartResponse)
def notion_oauth_start(
    payload: NotionOAuthStartRequest,
    current_user: User = Depends(get_current_user),
):
    state = build_oauth_state(
        user_id=current_user.id,
        database_id=payload.database_id,
        ttl_minutes=settings.notion_oauth_state_ttl_minutes,
    )
    return NotionOAuthStartResponse(auth_url=build_oauth_authorize_url(state))


@app.get("/integrations/notion/oauth/callback", response_model=NotionOAuthCallbackResponse)
def notion_oauth_callback(code: str, state: str, db: Session = Depends(get_db)):
    user_id, database_id = parse_oauth_state(state)
    normalized_database_id = _normalize_db_id(database_id)
    api_key = exchange_oauth_code(code)
    validate_database_access(api_key, normalized_database_id)
    integration = db.get(NotionIntegration, user_id)
    if integration:
        integration.api_key = api_key
    else:
        integration = NotionIntegration(user_id=user_id, api_key=api_key, database_id=normalized_database_id)
        db.add(integration)
        db.flush()
    _refresh_user_notion_databases(db, integration, preferred_database_id=normalized_database_id)
    db.commit()
    return NotionOAuthCallbackResponse(connected=True, database_id=normalized_database_id)


@app.get("/integrations/notion/status", response_model=NotionStatusResponse)
def notion_status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    integration = db.get(NotionIntegration, current_user.id)
    if not integration:
        return NotionStatusResponse(connected=False)
    database_ids = _get_user_notion_database_ids(integration)
    default_id = next((item.database_id for item in integration.databases if item.is_default), None)
    if not default_id and database_ids:
        default_id = database_ids[0]
    return NotionStatusResponse(connected=True, database_id=default_id)


@app.get("/integrations/notion/databases", response_model=NotionDatabasesResponse)
def notion_databases(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    integration = db.get(NotionIntegration, current_user.id)
    if not integration:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notion integration not connected")
    rows = sorted(integration.databases, key=lambda row: (not row.is_default, row.title or row.database_id))
    return NotionDatabasesResponse(
        items=[NotionDatabaseEntry(database_id=row.database_id, title=row.title, is_default=row.is_default) for row in rows]
    )


@app.delete("/integrations/notion", status_code=status.HTTP_204_NO_CONTENT)
def disconnect_notion(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    integration = db.get(NotionIntegration, current_user.id)
    if integration:
        db.delete(integration)
        db.commit()


@app.get("/integrations/notion/context", response_model=NotionContextResponse)
def notion_context(
    limit: int = 20,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    integration = db.get(NotionIntegration, current_user.id)
    if not integration:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notion integration not connected")
    items: list[dict] = []
    for database_id in _get_user_notion_database_ids(integration):
        scoped = fetch_database_context(integration.api_key, database_id, limit=limit)
        for row in scoped:
            row.setdefault("properties", {})
            row["properties"]["source_database_id"] = database_id
        items.extend(scoped)
    return NotionContextResponse(items=items)


@app.post("/tasks/decompose-from-notion", response_model=TaskDecomposeResponse)
def decompose_task_from_notion(
    payload: TaskDecomposeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    integration = db.get(NotionIntegration, current_user.id)
    if not integration:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notion integration not connected")

    chat = get_user_chat_or_404(db, current_user.id, payload.chat_id)
    context_items: list[dict] = []
    for database_id in _get_user_notion_database_ids(integration):
        scoped = fetch_database_context(integration.api_key, database_id, limit=50)
        for row in scoped:
            row.setdefault("properties", {})
            row["properties"]["source_database_id"] = database_id
        context_items.extend(scoped)
    source_task = find_task_in_context(context_items, task_id=payload.task_id, task_title=payload.task_title)
    if not source_task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found in Notion context")

    prompt = (
        "Decompose the following Notion task into actionable subtasks.\n"
        "Return concise markdown with sections: Goal, Subtasks, Dependencies, Risks, Estimate.\n\n"
        f"Task: {json.dumps(source_task, ensure_ascii=True)}"
    )
    assistant_text = generate_assistant_reply(list(chat.messages), prompt)
    assistant_message = Message(chat_id=chat.id, role="assistant", content=assistant_text)
    db.add(assistant_message)
    db.commit()
    db.refresh(assistant_message)

    return TaskDecomposeResponse(assistant_message=assistant_message, source_task=source_task)


@app.post("/chats/{chat_id}/messages", response_model=SendMessageResponse)
def send_message(
    chat_id: UUID,
    payload: MessageCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = get_user_chat_or_404(db, current_user.id, chat_id)
    previous_messages = list(chat.messages)
    integration = db.get(NotionIntegration, current_user.id)

    user_message = Message(chat_id=chat.id, role="user", content=payload.content)
    db.add(user_message)
    db.flush()
    for att in payload.attachments:
        db.add(Attachment(message_id=user_message.id, file_name=att.file_name, file_url=att.file_url))

    prompt_content = payload.content
    if integration:
        items: list[dict] = []
        for database_id in _get_user_notion_database_ids(integration):
            scoped = fetch_database_context(integration.api_key, database_id, limit=10)
            for row in scoped:
                row.setdefault("properties", {})
                row["properties"]["source_database_id"] = database_id
            items.extend(scoped)
        if items:
            serialized = json.dumps(items, ensure_ascii=True)
            prompt_content = f"{payload.content}\n\nNotion board context:\n{serialized}"

    assistant_text = generate_assistant_reply(previous_messages, prompt_content)
    assistant_message = Message(chat_id=chat.id, role="assistant", content=assistant_text)
    db.add(assistant_message)
    db.commit()
    db.refresh(user_message)
    db.refresh(assistant_message)

    return SendMessageResponse(user_message=user_message, assistant_message=assistant_message)
