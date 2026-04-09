import os
import json
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import create_access_token, create_refresh_token, decode_token
from app.config import settings
from app.database import Base, engine
from app.deps import get_current_user, get_db
from app.llm import generate_assistant_reply
from app.models import Attachment, Chat, Message, NotionIntegration, User
from app.notion import (
    build_oauth_authorize_url,
    build_oauth_state,
    exchange_oauth_code,
    fetch_database_context,
    find_task_in_context,
    parse_oauth_state,
    validate_database_access,
)
from app.schemas import (
    ChatCreateResponse,
    LoginRequest,
    MessageCreateRequest,
    MessageRead,
    NotionConnectRequest,
    NotionOAuthCallbackResponse,
    NotionOAuthStartRequest,
    NotionOAuthStartResponse,
    NotionContextResponse,
    NotionStatusResponse,
    RefreshRequest,
    RegisterRequest,
    SendMessageResponse,
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


@app.get("/health")
def health():
    return {"status": "ok"}


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
    payload: NotionConnectRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    validate_database_access(payload.api_key, payload.database_id)
    integration = db.get(NotionIntegration, current_user.id)
    if integration:
        integration.api_key = payload.api_key
        integration.database_id = payload.database_id
    else:
        db.add(NotionIntegration(user_id=current_user.id, api_key=payload.api_key, database_id=payload.database_id))
    db.commit()
    return NotionStatusResponse(connected=True, database_id=payload.database_id)


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
    api_key = exchange_oauth_code(code)
    validate_database_access(api_key, database_id)
    integration = db.get(NotionIntegration, user_id)
    if integration:
        integration.api_key = api_key
        integration.database_id = database_id
    else:
        db.add(NotionIntegration(user_id=user_id, api_key=api_key, database_id=database_id))
    db.commit()
    return NotionOAuthCallbackResponse(connected=True, database_id=database_id)


@app.get("/integrations/notion/status", response_model=NotionStatusResponse)
def notion_status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    integration = db.get(NotionIntegration, current_user.id)
    if not integration:
        return NotionStatusResponse(connected=False)
    return NotionStatusResponse(connected=True, database_id=integration.database_id)


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
    items = fetch_database_context(integration.api_key, integration.database_id, limit=limit)
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
    context_items = fetch_database_context(integration.api_key, integration.database_id, limit=50)
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
        items = fetch_database_context(integration.api_key, integration.database_id, limit=10)
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
