# FastAPI + PostgreSQL сервер для ИИ-ассистента

Минимальный backend для:
- простой авторизации пользователя по `id + password`;
- хранения нескольких чатов на пользователя;
- хранения сообщений в каждом чате;
- хранения `attachments` у пользовательских сообщений;
- подключения Notion-базы пользователя как дополнительного контекста;
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
- `notion_integrations`
  - `user_id` (PK + FK -> users.id)
  - `api_key` (text)
  - `database_id` (string)

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

## Локальный запуск без Docker (Windows + PowerShell)

Рекомендуемый режим для работы с Notion/VPN: API запускается локально, PostgreSQL работает в Docker.

1. Перейди в папку `backend` и скопируй `.env.example` в `.env`, если файл еще не создан.
2. В `.env` укажи локальный адрес БД:

```bash
DATABASE_URL=postgresql+psycopg://assistant_user:assistant_pass@localhost:5432/assistant_db
```

3. Запусти только PostgreSQL в Docker:

```bash
docker compose up -d db
```

4. Убедись, что порт `5432` не занят локальным PostgreSQL на Windows.
   Если видишь конфликт, останови локальный сервис PostgreSQL или поменяй порт в `docker-compose.yml`.
5. Создай и активируй виртуальное окружение:

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

Если PowerShell блокирует активацию:

```bash
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

6. Установи зависимости:

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -r requirements-llm.txt
```

7. Запусти API локально:

```bash
python -m uvicorn app.main:app --reload
```

8. Проверь, что сервер поднялся:
   - API: `http://127.0.0.1:8000`
   - Swagger: `http://127.0.0.1:8000/docs`

## Переменные окружения

См. `.env.example`:
- `DATABASE_URL`
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `JWT_SECRET`, `JWT_ALGORITHM`
- `ACCESS_TOKEN_MINUTES`, `REFRESH_TOKEN_MINUTES`
- `HF_TOKEN`, `HF_MODEL`
- `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_REDIRECT_URI`, `NOTION_OAUTH_STATE_TTL_MINUTES`

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
- `POST /tasks/decompose-from-notion` — декомпозировать задачу из Notion-контекста и сохранить результат как сообщение ассистента в чат

### Notion
- `POST /integrations/notion/connect` — подключить Notion через `api_key + database_id`
- `POST /integrations/notion/oauth/start` — получить `auth_url` для OAuth-подключения
- `GET /integrations/notion/oauth/callback` — callback для завершения OAuth
- `GET /integrations/notion/status` — проверить статус подключения
- `GET /integrations/notion/context` — получить нормализованный контекст из доски
- `DELETE /integrations/notion` — отключить интеграцию

## OAuth подключение Notion (без UI)

1. Авторизуйся в API и получи `access_token`.
2. Вызови `POST /integrations/notion/oauth/start` с `database_id` нужной Notion-базы.
3. Открой `auth_url` из ответа в браузере и подтверди доступ.
4. Notion вернет пользователя на `NOTION_REDIRECT_URI`, а backend завершит подключение.

## Пример флоу

1. Зарегистрируй пользователя (`/auth/register`).
2. Используй `access_token` в заголовке:
   - `Authorization: Bearer <token>`
3. Создай чат (`POST /chats`).
4. Отправляй сообщения (`POST /chats/{chat_id}/messages`).
5. Если Notion подключен, контекст доски автоматически добавляется к пользовательскому сообщению перед вызовом LLM.

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
