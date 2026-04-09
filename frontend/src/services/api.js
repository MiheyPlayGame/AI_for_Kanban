const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    ...options
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const payload = await response.json();
      message = payload.detail ?? message;
    } catch {
      // Ignore parse errors and keep generic message.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export function register(id, password) {
  return request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ id, password })
  });
}

export function login(id, password) {
  return request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ id, password })
  });
}

export function refresh(refreshToken) {
  return request("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken })
  });
}

export function createChat(accessToken) {
  return request("/chats", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function listChats(accessToken) {
  return request("/chats", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function getMessages(accessToken, chatId) {
  return request(`/chats/${chatId}/messages`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function sendMessage(accessToken, chatId, content) {
  return request(`/chats/${chatId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      content,
      attachments: []
    })
  });
}

export function checkHealth() {
  return request("/health");
}
