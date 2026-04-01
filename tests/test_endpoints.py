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
