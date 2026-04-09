from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Attachment, Chat, Message, User


def test_user_chat_message_attachment_relations(db_session: Session):
    user = User(id="model_user", password="pass")
    db_session.add(user)
    db_session.flush()

    chat = Chat(user_id=user.id)
    db_session.add(chat)
    db_session.flush()

    message = Message(chat_id=chat.id, role="user", content="payload")
    db_session.add(message)
    db_session.flush()

    attachment = Attachment(
        message_id=message.id,
        file_name="doc.txt",
        file_url="https://example.com/doc.txt",
    )
    db_session.add(attachment)
    db_session.commit()

    saved_user = db_session.get(User, "model_user")
    assert saved_user is not None
    assert len(saved_user.chats) == 1

    saved_chat = db_session.scalar(select(Chat).where(Chat.user_id == "model_user"))
    assert saved_chat is not None
    assert len(saved_chat.messages) == 1

    saved_message = db_session.scalar(select(Message).where(Message.chat_id == saved_chat.id))
    assert saved_message is not None
    assert saved_message.content == "payload"
    assert len(saved_message.attachments) == 1
    assert saved_message.attachments[0].file_name == "doc.txt"
