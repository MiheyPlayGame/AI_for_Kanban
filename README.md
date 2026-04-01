# FastAPI + PostgreSQL сервер для ИИ-ассистента

Минимальный backend для:
- простой авторизации пользователя по `id + password`;
- хранения нескольких чатов на пользователя;
- хранения сообщений в каждом чате;
- хранения `attachments` у пользовательских сообщений;
- проксирования пользовательского сообщения в LLM через Hugging Face.

## Стек

- Python
- FastAPI
- SQLAlchemy
- PostgreSQL
- Docker / Docker Compose
- Hugging Face Inference API (`huggingface_hub`)

## Структура БД

- `users`
  - `id` (PK, string)
  - `password` (string, хранится как есть, без хеширования)
- `chats`
  - `id` (UUID, PK)
  - `user_id` (FK -> users.id)
- `messages`
  - `id` (UUID, PK)
  - `chat_id` (FK -> chats.id)
  - `role` (`user` | `assistant`)
  - `content` (text)
  - `created_at` (datetime)
- `attachments`
  - `id` (UUID, PK)
  - `message_id` (FK -> messages.id)
  - `file_name` (string)
  - `file_url` (text)

## Запуск через Docker

1. Скопируй `.env.example` в `.env`:

```bash
cp .env.example .env
```

2. Заполни переменные в `.env` (особенно `HF_TOKEN`).

3. Запусти сервисы:

```bash
docker compose up --build
```

4. API будет доступно по адресу:
- `http://localhost:8000`
- Swagger: `http://localhost:8000/docs`

## Локальный запуск без Docker

1. Создай виртуальное окружение и установи зависимости:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

2. Подними PostgreSQL отдельно и обнови `DATABASE_URL` в `.env`.

3. Запусти сервер:

```bash
uvicorn app.main:app --reload
```

## Переменные окружения

См. `.env.example`:
- `DATABASE_URL`
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `JWT_SECRET`, `JWT_ALGORITHM`
- `ACCESS_TOKEN_MINUTES`, `REFRESH_TOKEN_MINUTES`
- `HF_TOKEN`, `HF_MODEL`

## API эндпоинты

### Auth
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`

### Chats
- `POST /chats` — создать чат
- `GET /chats` — список чатов текущего пользователя
- `DELETE /chats/{chat_id}` — удалить чат

### Messages
- `GET /chats/{chat_id}/messages` — история сообщений чата
- `POST /chats/{chat_id}/messages` — отправить сообщение в чат с `attachments`, сохранить ответ модели

## Пример флоу

1. Зарегистрируй пользователя (`/auth/register`).
2. Используй `access_token` в заголовке:
   - `Authorization: Bearer <token>`
3. Создай чат (`POST /chats`).
4. Отправляй сообщения (`POST /chats/{chat_id}/messages`).

## Важно

Эта реализация намеренно простая и небезопасная:
- пароль хранится в БД в открытом виде;
- JWT-секрет может быть слабым;
- нет ролей, аудита, rate limiting и продвинутой валидации.

## Тесты

- Папка тестов: `tests/`
- Запуск вручную:
  - `pytest -q`
- При старте сервера тесты запускаются автоматически.
  - Отключение: выставить `RUN_TESTS_ON_STARTUP=0` в `.env`.
