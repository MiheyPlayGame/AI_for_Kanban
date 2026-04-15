from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from jose import JWTError, jwt

from app.config import settings


def create_token(user_id: str, token_type: str, expires_minutes: int) -> str:
    payload = {
        "sub": user_id,
        "type": token_type,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=expires_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: str) -> str:
    return create_token(user_id, "access", settings.access_token_minutes)


def create_refresh_token(user_id: str) -> str:
    return create_token(user_id, "refresh", settings.refresh_token_minutes)


def decode_token(token: str, expected_type: str) -> str:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        token_type = payload.get("type")
        user_id = payload.get("sub")
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    if token_type != expected_type or not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
    return user_id
