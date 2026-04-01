import os
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import create_access_token, create_refresh_token, decode_token
from app.database import Base, engine
from app.deps import get_current_user, get_db
from app.llm import generate_assistant_reply
from app.models import Attachment, Chat, Message, User
from app.schemas import (
    ChatCreateResponse,
    LoginRequest,
    MessageCreateRequest,
    MessageRead,
    RefreshRequest,
    RegisterRequest,
    SendMessageResponse,
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


@app.post("/chats/{chat_id}/messages", response_model=SendMessageResponse)
def send_message(
    chat_id: UUID,
    payload: MessageCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = get_user_chat_or_404(db, current_user.id, chat_id)
    previous_messages = list(chat.messages)

    user_message = Message(chat_id=chat.id, role="user", content=payload.content)
    db.add(user_message)
    db.flush()
    for att in payload.attachments:
        db.add(Attachment(message_id=user_message.id, file_name=att.file_name, file_url=att.file_url))

    assistant_text = generate_assistant_reply(previous_messages, payload.content)
    assistant_message = Message(chat_id=chat.id, role="assistant", content=assistant_text)
    db.add(assistant_message)
    db.commit()
    db.refresh(user_message)
    db.refresh(assistant_message)

    return SendMessageResponse(user_message=user_message, assistant_message=assistant_message)
