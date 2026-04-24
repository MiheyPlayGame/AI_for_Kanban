from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_health(client: TestClient):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_register_login_refresh(client: TestClient):
    register = client.post("/auth/register", json={"id": "alice", "password": "123"})
    assert register.status_code == 200
    register_json = register.json()
    assert register_json["access_token"]
    assert register_json["refresh_token"]

    duplicate = client.post("/auth/register", json={"id": "alice", "password": "123"})
    assert duplicate.status_code == 400

    login = client.post("/auth/login", json={"id": "alice", "password": "123"})
    assert login.status_code == 200

    bad_login = client.post("/auth/login", json={"id": "alice", "password": "wrong"})
    assert bad_login.status_code == 401

    refresh = client.post("/auth/refresh", json={"refresh_token": register_json["refresh_token"]})
    assert refresh.status_code == 200
    assert refresh.json()["access_token"]


def test_chats_crud_and_visibility(client: TestClient):
    token_a = client.post("/auth/register", json={"id": "user_a", "password": "pass"}).json()["access_token"]
    token_b = client.post("/auth/register", json={"id": "user_b", "password": "pass"}).json()["access_token"]

    create = client.post("/chats", headers=auth_headers(token_a))
    assert create.status_code == 200
    chat_id = create.json()["id"]

    list_a = client.get("/chats", headers=auth_headers(token_a))
    assert list_a.status_code == 200
    assert len(list_a.json()) == 1

    list_b = client.get("/chats", headers=auth_headers(token_b))
    assert list_b.status_code == 200
    assert list_b.json() == []

    forbidden_for_b = client.delete(f"/chats/{chat_id}", headers=auth_headers(token_b))
    assert forbidden_for_b.status_code == 404

    deleted = client.delete(f"/chats/{chat_id}", headers=auth_headers(token_a))
    assert deleted.status_code == 204

    list_after_delete = client.get("/chats", headers=auth_headers(token_a))
    assert list_after_delete.status_code == 200
    assert list_after_delete.json() == []


def test_messages_and_attachments_flow(client: TestClient, monkeypatch):
    monkeypatch.setattr("app.main.generate_assistant_reply", lambda _history, _new: "assistant response")

    token = client.post("/auth/register", json={"id": "writer", "password": "pass"}).json()["access_token"]
    chat_id = client.post("/chats", headers=auth_headers(token)).json()["id"]

    send = client.post(
        f"/chats/{chat_id}/messages",
        headers=auth_headers(token),
        json={
            "content": "hello",
            "attachments": [
                {"file_name": "spec.pdf", "file_url": "https://example.com/spec.pdf"},
                {"file_name": "image.png", "file_url": "https://example.com/image.png"},
            ],
        },
    )
    assert send.status_code == 200
    data = send.json()
    assert data["assistant_message"]["content"] == "assistant response"
    assert len(data["user_message"]["attachments"]) == 2
    assert data["user_message"]["attachments"][0]["file_name"] == "spec.pdf"

    history = client.get(f"/chats/{chat_id}/messages", headers=auth_headers(token))
    assert history.status_code == 200
    messages = history.json()
    assert len(messages) == 2
    assert messages[0]["role"] == "user"
    assert len(messages[0]["attachments"]) == 2
    assert messages[1]["role"] == "assistant"
    assert messages[1]["attachments"] == []


def test_auth_required(client: TestClient):
    response = client.get("/chats")
    assert response.status_code == 401


def test_notion_integration_connect_status_context_disconnect(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "notion_user", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)

    monkeypatch.setattr("app.main.validate_database_access", lambda _key, _db_id: None)
    monkeypatch.setattr(
        "app.main.fetch_database_context",
        lambda _key, _db_id, limit=20: [{"id": "p1", "url": "https://notion.so/p1", "title": "Task 1", "properties": {}}],
    )

    initial_status = client.get("/integrations/notion/status", headers=headers)
    assert initial_status.status_code == 200
    assert initial_status.json() == {"connected": False, "database_id": None}

    connect = client.post(
        "/integrations/notion/connect",
        headers=headers,
        json={"api_key": "secret_key", "database_id": "db_123"},
    )
    assert connect.status_code == 200
    assert connect.json() == {"connected": True, "database_id": "db_123"}

    status_after_connect = client.get("/integrations/notion/status", headers=headers)
    assert status_after_connect.status_code == 200
    assert status_after_connect.json() == {"connected": True, "database_id": "db_123"}

    context = client.get("/integrations/notion/context", headers=headers)
    assert context.status_code == 200
    assert context.json()["items"][0]["title"] == "Task 1"

    disconnect = client.delete("/integrations/notion", headers=headers)
    assert disconnect.status_code == 204

    status_after_disconnect = client.get("/integrations/notion/status", headers=headers)
    assert status_after_disconnect.status_code == 200
    assert status_after_disconnect.json() == {"connected": False, "database_id": None}


def test_send_message_includes_notion_context_when_connected(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "ctx_user", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)
    chat_id = client.post("/chats", headers=headers).json()["id"]

    monkeypatch.setattr("app.main.validate_database_access", lambda _key, _db_id: None)
    client.post(
        "/integrations/notion/connect",
        headers=headers,
        json={"api_key": "secret_key", "database_id": "db_123"},
    )

    captured = {"message": ""}

    def fake_generate(_history, new_message):
        captured["message"] = new_message
        return "assistant response"

    monkeypatch.setattr("app.main.generate_assistant_reply", fake_generate)
    monkeypatch.setattr(
        "app.main.fetch_database_context",
        lambda _key, _db_id, limit=10: [{"id": "x", "url": "", "title": "Board item", "properties": {}}],
    )

    send = client.post(
        f"/chats/{chat_id}/messages",
        headers=headers,
        json={"content": "what is priority?", "attachments": []},
    )
    assert send.status_code == 200
    assert "Notion board context" in captured["message"]
    assert "Board item" in captured["message"]


def test_notion_oauth_start_and_callback_flow(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "oauth_user", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)

    monkeypatch.setattr("app.main.build_oauth_state", lambda user_id, database_id, ttl_minutes: "state_123")
    monkeypatch.setattr(
        "app.main.build_oauth_authorize_url",
        lambda state: f"https://api.notion.com/v1/oauth/authorize?state={state}",
    )
    monkeypatch.setattr("app.main.parse_oauth_state", lambda state: ("oauth_user", "db_777"))
    monkeypatch.setattr("app.main.exchange_oauth_code", lambda code: "oauth_token")
    monkeypatch.setattr("app.main.validate_database_access", lambda _key, _db_id: None)

    start = client.post("/integrations/notion/oauth/start", headers=headers, json={})
    assert start.status_code == 200
    assert start.json()["auth_url"].endswith("state=state_123")

    callback = client.get("/integrations/notion/oauth/callback", params={"code": "abc", "state": "state_123"})
    assert callback.status_code == 200
    assert callback.json() == {"connected": True, "database_id": "db_777"}

    status = client.get("/integrations/notion/status", headers=headers)
    assert status.status_code == 200
    assert status.json() == {"connected": True, "database_id": "db_777"}


def test_decompose_task_from_notion_saves_assistant_message(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "decomposer", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)
    chat_id = client.post("/chats", headers=headers).json()["id"]

    monkeypatch.setattr("app.main.validate_database_access", lambda _key, _db_id: None)
    client.post(
        "/integrations/notion/connect",
        headers=headers,
        json={"api_key": "secret_key", "database_id": "db_123"},
    )

    monkeypatch.setattr(
        "app.main.fetch_database_context",
        lambda _key, _db_id, limit=50: [
            {"id": "task_1", "url": "https://notion.so/task_1", "title": "Build API", "properties": {"status": "Todo"}}
        ],
    )
    monkeypatch.setattr("app.main.generate_assistant_reply", lambda _history, _prompt: "## Subtasks\n- Define routes")

    resp = client.post(
        "/tasks/decompose-from-notion",
        headers=headers,
        json={"chat_id": chat_id, "task_id": "task_1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["assistant_message"]["role"] == "assistant"
    assert "Define routes" in body["assistant_message"]["content"]
    assert body["source_task"]["id"] == "task_1"

    history = client.get(f"/chats/{chat_id}/messages", headers=headers)
    assert history.status_code == 200
    messages = history.json()
    assert len(messages) == 2
    assert messages[0]["role"] == "user"
    assert messages[1]["role"] == "assistant"
    assert "Define routes" in messages[1]["content"]


def test_decompose_task_from_notion_not_found(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "decomposer2", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)
    chat_id = client.post("/chats", headers=headers).json()["id"]

    monkeypatch.setattr("app.main.validate_database_access", lambda _key, _db_id: None)
    client.post(
        "/integrations/notion/connect",
        headers=headers,
        json={"api_key": "secret_key", "database_id": "db_123"},
    )
    monkeypatch.setattr(
        "app.main.fetch_database_context",
        lambda _key, _db_id, limit=50: [{"id": "x", "url": "", "title": "Other task", "properties": {}}],
    )

    resp = client.post(
        "/tasks/decompose-from-notion",
        headers=headers,
        json={"chat_id": chat_id, "task_id": "task_missing"},
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Task not found in Notion context"


def test_summarize_from_text(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "summarizer", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)

    captured = {"prompt": ""}

    def fake_generate(_history, prompt):
        captured["prompt"] = prompt
        return "Short summary"

    monkeypatch.setattr("app.main.generate_assistant_reply", fake_generate)
    response = client.post(
        "/summaries",
        headers=headers,
        json={"text": "Long task details and progress notes."},
    )
    assert response.status_code == 200
    assert response.json() == {"summary": "Short summary", "source": "text"}
    assert "Long task details" in captured["prompt"]
    chats = client.get("/chats", headers=headers).json()
    assert len(chats) == 1
    chat_id = chats[0]["id"]
    history = client.get(f"/chats/{chat_id}/messages", headers=headers).json()
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[1]["role"] == "assistant"
    assert "Short summary" in history[1]["content"]


def test_summarize_from_link_context(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "summarizer2", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)

    captured = {"prompt": ""}

    def fake_generate(_history, prompt):
        captured["prompt"] = prompt
        return "Context summary"

    monkeypatch.setattr("app.main.generate_assistant_reply", fake_generate)
    response = client.post(
        "/summaries",
        headers=headers,
        json={
            "link": "https://example.com/task-1",
            "context": [
                {
                    "link": "https://example.com/task-1",
                    "text": "This is context text for task one and should be summarized.",
                }
            ],
        },
    )
    assert response.status_code == 200
    assert response.json() == {"summary": "Context summary", "source": "link"}
    assert "context text for task one" in captured["prompt"].lower()


def test_summarize_requires_exactly_one_source(client: TestClient):
    token = client.post("/auth/register", json={"id": "summarizer3", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)

    response = client.post("/summaries", headers=headers, json={"text": "a", "link": "https://example.com"})
    assert response.status_code == 422


def test_summarize_link_not_found_or_fetchable(client: TestClient):
    token = client.post("/auth/register", json={"id": "summarizer4", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)

    response = client.post(
        "/summaries",
        headers=headers,
        json={
            "link": "https://127.0.0.1.invalid/nope",
            "context": [{"link": "https://example.com/other", "text": "other text"}],
        },
    )
    assert response.status_code in {400, 502}


def test_semantic_search_returns_notion_and_chat_matches(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "semantic_user", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)
    chat_id = client.post("/chats", headers=headers).json()["id"]

    monkeypatch.setattr("app.main.validate_database_access", lambda _key, _db_id: None)
    client.post(
        "/integrations/notion/connect",
        headers=headers,
        json={"api_key": "secret_key", "database_id": "db_123"},
    )
    monkeypatch.setattr(
        "app.main.fetch_database_context",
        lambda _key, _db_id, limit=20: [
            {
                "id": "n1",
                "url": "https://notion.so/n1",
                "title": "Publish release notes",
                "properties": {"Description": "Prepare release highlights and known issues section"},
            },
            {
                "id": "n2",
                "url": "https://notion.so/n2",
                "title": "Refactor auth middleware",
                "properties": {"Description": "Improve token parsing"},
            },
        ],
    )

    monkeypatch.setattr("app.main.generate_assistant_reply", lambda _history, _new: "assistant response")
    client.post(
        f"/chats/{chat_id}/messages",
        headers=headers,
        json={"content": "Need help drafting release notes for v2.3.0", "attachments": []},
    )

    response = client.post(
        "/search/semantic",
        headers=headers,
        json={"query": "release notes", "chat_id": chat_id, "top_k": 3},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "release notes"
    assert body["notion_matches"][0]["item"]["title"] == "Publish release notes"
    assert "release notes" in body["chat_matches"][0]["message"]["content"].lower()
    assert len(body["information_matches"]) >= 1
    assert body["information_matches"][0]["source_type"] in {"notion", "chat"}


def test_semantic_search_chat_only_without_notion(client: TestClient, monkeypatch):
    token = client.post("/auth/register", json={"id": "semantic_user2", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)
    chat_id = client.post("/chats", headers=headers).json()["id"]
    client.post(
        f"/chats/{chat_id}/messages",
        headers=headers,
        json={"content": "Discuss API pagination strategy", "attachments": []},
    )
    monkeypatch.setattr("app.main.generate_assistant_reply", lambda _history, _new: "semantic response")

    response = client.post(
        "/search/semantic",
        headers=headers,
        json={"query": "pagination", "include_notion": False, "top_k": 2},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["notion_matches"] == []
    assert len(body["chat_matches"]) >= 1


def test_semantic_search_invalid_chat_id_for_user(client: TestClient, monkeypatch):
    token_a = client.post("/auth/register", json={"id": "semantic_a", "password": "pass"}).json()["access_token"]
    token_b = client.post("/auth/register", json={"id": "semantic_b", "password": "pass"}).json()["access_token"]
    chat_id_b = client.post("/chats", headers=auth_headers(token_b)).json()["id"]
    monkeypatch.setattr("app.main.generate_assistant_reply", lambda _history, _new: "semantic response")

    response = client.post(
        "/search/semantic",
        headers=auth_headers(token_a),
        json={"query": "anything", "chat_id": chat_id_b},
    )
    assert response.status_code == 404


def test_semantic_search_bm25_prefers_document_update_task(client: TestClient, monkeypatch):
    monkeypatch.setattr("app.main.generate_assistant_reply", lambda _history, _new: "semantic response")
    token = client.post("/auth/register", json={"id": "semantic_user3", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)

    monkeypatch.setattr("app.main.validate_database_access", lambda _key, _db_id: None)
    client.post(
        "/integrations/notion/connect",
        headers=headers,
        json={"api_key": "secret_key", "database_id": "db_123"},
    )
    monkeypatch.setattr(
        "app.main.fetch_database_context",
        lambda _key, _db_id, limit=20: [
            {
                "id": "n1",
                "url": "https://notion.so/n1",
                "title": "Publish release notes",
                "properties": {
                    "Priority": "Low",
                    "Description": "very long generic text with many words but little about documents updates",
                },
            },
            {
                "id": "n2",
                "url": "https://notion.so/n2",
                "title": "Update help center & FAQ",
                "properties": {
                    "Priority": "Medium",
                    "Description": "Update support documents to reflect new product releases.",
                },
            },
        ],
    )

    response = client.post(
        "/search/semantic",
        headers=headers,
        json={"query": "in which task we need to update documents?", "include_chat_history": False, "top_k": 2},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["notion_matches"][0]["item"]["title"] == "Update help center & FAQ"


def test_semantic_search_information_match_returns_relevant_snippet(client: TestClient, monkeypatch):
    monkeypatch.setattr("app.main.generate_assistant_reply", lambda _history, _new: "semantic response")
    token = client.post("/auth/register", json={"id": "semantic_user4", "password": "pass"}).json()["access_token"]
    headers = auth_headers(token)

    monkeypatch.setattr("app.main.validate_database_access", lambda _key, _db_id: None)
    client.post(
        "/integrations/notion/connect",
        headers=headers,
        json={"api_key": "secret_key", "database_id": "db_123"},
    )
    monkeypatch.setattr(
        "app.main.fetch_database_context",
        lambda _key, _db_id, limit=20: [
            {
                "id": "n1",
                "url": "https://notion.so/n1",
                "title": "Publish release notes",
                "properties": {
                    "Description": "Send for review, but publish anyway if nobody responds.",
                },
            }
        ],
    )

    response = client.post(
        "/search/semantic",
        headers=headers,
        json={"query": "publish anyway", "include_chat_history": False},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["information_matches"]) >= 1
    snippets = [item["snippet"].lower() for item in body["information_matches"]]
    assert any("publish anyway" in snippet for snippet in snippets)
