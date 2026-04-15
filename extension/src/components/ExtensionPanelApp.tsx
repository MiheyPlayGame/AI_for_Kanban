import { useEffect, useMemo, useState } from "react";
import {
  checkHealth,
  createChat,
  getMessages,
  listChats,
  login,
  register,
  saveTokens,
  sendMessage,
  type Tokens
} from "../lib/runtimeApi";

const quickActions = [
  "Break down task",
  "Summarize discussion",
  "Find blockers",
  "Sprint health report"
];

function normalizeTokens(payload: any): Tokens {
  const accessToken = payload?.access_token ?? payload?.access_tocken;
  const refreshToken = payload?.refresh_token ?? payload?.refresh_tocken;
  const tokenType = payload?.token_type ?? "bearer";

  if (!accessToken || !refreshToken) {
    throw new Error("Sign in failed: backend did not return valid tokens.");
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: tokenType
  };
}

export default function ExtensionPanelApp() {
  const [open, setOpen] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [userId, setUserId] = useState("Guest");
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const isAuthenticated = Boolean(tokens?.access_token);
  const userName = useMemo(() => (isAuthenticated ? userId : "Guest"), [isAuthenticated, userId]);

  useEffect(() => {
    let stopped = false;
    const run = async () => {
      try {
        await checkHealth();
        if (!stopped) {
          setBackendReady(true);
        }
      } catch {
        if (!stopped) {
          setBackendReady(false);
        }
      }
    };
    run();
    const timer = window.setInterval(run, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const handler = () => setOpen((prev) => !prev);
    window.addEventListener("asya:toggle-panel", handler);
    return () => {
      window.removeEventListener("asya:toggle-panel", handler);
    };
  }, []);

  async function handleAuth(mode: "register" | "login") {
    const id = window.prompt("User id:");
    if (id === null) {
      return;
    }
    const password = window.prompt("Password:");
    if (password === null) {
      return;
    }

    setLoading(true);
    setError("");
    setNotice("");
    try {
      const trimmedId = id.trim();
      if (!trimmedId) {
        throw new Error("User id is required.");
      }

      if (mode === "register") {
        await register(trimmedId, password);
        setNotice("Registration successful. Now sign in.");
        return;
      }

      const tokenPayloadRaw = await login(trimmedId, password);
      const tokenPayload = normalizeTokens(tokenPayloadRaw);
      setTokens(tokenPayload);
      setUserId(trimmedId);
      await saveTokens(tokenPayload);
      const chats = await listChats(tokenPayload.access_token);
      if (chats.length > 0) {
        setChatId(chats[0].id);
        const history = await getMessages(tokenPayload.access_token, chats[0].id);
        setMessages(history);
      } else {
        setChatId(null);
        setMessages([]);
      }
    } catch (e: any) {
      setError(e?.message || "Authorization failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateChat() {
    if (!tokens?.access_token) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const chat = await createChat(tokens.access_token);
      setChatId(chat.id);
      setMessages([]);
    } catch (e: any) {
      setError(e?.message || "Failed to create chat.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!tokens?.access_token || !chatId || !draft.trim()) {
      return;
    }
    const messageToSend = draft.trim();
    setDraft("");
    setLoading(true);
    setError("");
    try {
      const data = await sendMessage(tokens.access_token, chatId, messageToSend);
      setMessages((prev) => [...prev, data.user_message, data.assistant_message]);
    } catch (e: any) {
      setError(e?.message || "Failed to send message.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`kanban-ai-ext ${open ? "open" : "closed"}`}>
      {open ? (
        <section className="ext-panel">
          <header className="ext-topbar">
            <h1>AS.YA</h1>
            <div className="ext-actions">
              {!isAuthenticated ? (
                <>
                  <button className="btn-secondary" onClick={() => handleAuth("register")} disabled={loading}>
                    Register
                  </button>
                  <button className="btn-primary" onClick={() => handleAuth("login")} disabled={loading}>
                    Sign In
                  </button>
                </>
              ) : (
                <button className="btn-primary" onClick={handleCreateChat} disabled={loading}>
                  New Chat
                </button>
              )}
              <button type="button" className="btn-close" onClick={() => setOpen(false)}>
                x
              </button>
            </div>
          </header>

          <p className="panel-subtitle">
            {backendReady ? "Backend online." : "Backend offline."} Signed in as {userName}.
          </p>
          <h2 className="assistant-title">What can I do today?</h2>

          <div className="action-list">
            {quickActions.map((action) => (
              <button key={action} type="button" className="action-item" disabled={!isAuthenticated || !chatId}>
                {action}
              </button>
            ))}
            <button type="button" className="action-item" disabled={!isAuthenticated || !chatId}>
              Analyze timeline
            </button>
            <button type="button" className="action-item" disabled={!isAuthenticated || !chatId}>
              Generate next steps
            </button>
          </div>

          <form className="hero-chat-form" onSubmit={handleSend}>
            <div className="hero-chat-shell">
              <input
                className="hero-chat-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Message AI assistant"
                disabled={!chatId || loading}
              />
              <div className="hero-chat-bottom">
                <span className="input-state">{loading ? "Sending..." : "Ready"}</span>
                <button className="send-btn" type="submit" disabled={!chatId || loading}>
                  ↑
                </button>
              </div>
            </div>
          </form>

          <p className="chat-hint">
            {!isAuthenticated
              ? "Sign in to unlock project-aware actions."
              : chatId
                ? `Connected chat: ${chatId}`
                : "Create a chat to start."}
          </p>
          {notice ? <p className="chat-hint">{notice}</p> : null}
          {error ? <p className="status-error">{error}</p> : null}

          {isAuthenticated ? (
            <div className="message-preview">
              {messages.length === 0 ? (
                <p className="empty-state">No conversation yet.</p>
              ) : (
                messages.slice(-6).map((message) => (
                  <div className={`message-row ${message.role}`} key={message.id}>
                    <strong>{message.role}</strong>
                    <span>{message.content}</span>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
