from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class LoginRequest(BaseModel):
    id: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class ChatCreateResponse(BaseModel):
    id: UUID
    user_id: str

    class Config:
        from_attributes = True


class MessageRead(BaseModel):
    id: UUID
    chat_id: UUID
    role: str
    content: str
    created_at: datetime
    attachments: list["AttachmentRead"] = Field(default_factory=list)

    class Config:
        from_attributes = True


class MessageCreateRequest(BaseModel):
    content: str = Field(min_length=1)
    attachments: list["AttachmentCreate"] = Field(default_factory=list)


class SendMessageResponse(BaseModel):
    user_message: MessageRead
    assistant_message: MessageRead


class AttachmentCreate(BaseModel):
    file_name: str = Field(min_length=1, max_length=256)
    file_url: str = Field(min_length=1)


class AttachmentRead(BaseModel):
    id: UUID
    message_id: UUID
    file_name: str
    file_url: str

    class Config:
        from_attributes = True
