import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    password: Mapped[str] = mapped_column(String(256), nullable=False)

    chats: Mapped[list["Chat"]] = relationship("Chat", back_populates="user", cascade="all, delete-orphan")
    notion_integration: Mapped["NotionIntegration | None"] = relationship(
        "NotionIntegration",
        back_populates="user",
        cascade="all, delete-orphan",
        uselist=False,
    )


class Chat(Base):
    __tablename__ = "chats"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(String(128), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    user: Mapped["User"] = relationship("User", back_populates="chats")
    messages: Mapped[list["Message"]] = relationship(
        "Message",
        back_populates="chat",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chat_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("chats.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False, default=datetime.utcnow)

    chat: Mapped["Chat"] = relationship("Chat", back_populates="messages")
    attachments: Mapped[list["Attachment"]] = relationship(
        "Attachment",
        back_populates="message",
        cascade="all, delete-orphan",
    )


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    message_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
    )
    file_name: Mapped[str] = mapped_column(String(256), nullable=False)
    file_url: Mapped[str] = mapped_column(Text, nullable=False)

    message: Mapped["Message"] = relationship("Message", back_populates="attachments")


class NotionIntegration(Base):
    __tablename__ = "notion_integrations"

    user_id: Mapped[str] = mapped_column(
        String(128),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    api_key: Mapped[str] = mapped_column(Text, nullable=False)
    database_id: Mapped[str] = mapped_column(String(128), nullable=False)

    user: Mapped["User"] = relationship("User", back_populates="notion_integration")
