import React, { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { AuthPasswordEyeIcon } from "./AuthPasswordEyeIcon";
import {
  checkHealth,
  connectApi,
  createChat,
  getMessages,
  loadSession,
  listChats,
  login,
  register,
  runDecompose,
  saveSession,
  sendMessage,
  type PanelMode,
  type Tokens
} from "../lib/runtimeApi";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ExtensionPanelAppProps = {
  /** When true, the panel starts open (used by the Vite preview page, not the content script). */
  initialOpen?: boolean;
};

export default function ExtensionPanelApp({ initialOpen = false }: ExtensionPanelAppProps) {
  const panelRef = React.useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(initialOpen);
  const [backendReady, setBackendReady] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("home");
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [authMode, setAuthMode] = useState<"register" | "login">("login");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [showRegisterConfirm, setShowRegisterConfirm] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [credentials, setCredentials] = useState({ id: "", password: "" });
  const [connectExpanded, setConnectExpanded] = useState(false);
  const [apiConfig, setApiConfig] = useState({ apiKey: "", databaseId: "" });
  const [decomposeTitle, setDecomposeTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [panelSize, setPanelSize] = useState<{ width?: number; height?: number }>({});

  const isAuthenticated = Boolean(tokens?.access_token);
  const userName = useMemo(() => {
    const tokenPrefix = tokens?.access_token?.slice(0, 8);
    return tokenPrefix ? `token:${tokenPrefix}` : "Guest";
  }, [tokens]);

  useEffect(() => {
    let stopped = false;
    const bootstrap = async () => {
      try {
        const session = await loadSession();
        if (stopped) {
          return;
        }
        setTokens(session.tokens);
        setChatId(session.activeChatId);
        setPanelMode(session.panelMode);
        if (session.tokens?.access_token) {
          const chats = await listChats(session.tokens.access_token);
          if (stopped) {
            return;
          }
          let resolvedChatId = session.activeChatId;
          if (!resolvedChatId && chats.length > 0) {
            resolvedChatId = chats[0].id;
          }
          if (resolvedChatId) {
            setChatId(resolvedChatId);
            const history = await getMessages(session.tokens.access_token, resolvedChatId);
            if (!stopped) {
              setMessages(history as ChatMessage[]);
            }
          }
        }
      } catch {
        if (!stopped) {
          setTokens(null);
          setChatId(null);
          setPanelMode("home");
          setMessages([]);
        }
      } finally {
        if (!stopped) {
          setBootstrapping(false);
        }
      }
    };
    bootstrap();
    return () => {
      stopped = true;
    };
  }, []);

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

  useEffect(() => {
    if (bootstrapping) {
      return;
    }
    saveSession({
      tokens,
      activeChatId: chatId,
      panelMode
    }).catch(() => {
      // Ignore persistence errors in UI.
    });
  }, [bootstrapping, tokens, chatId, panelMode]);

  function handleResizeStart(event: React.PointerEvent<HTMLButtonElement>) {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = panel.getBoundingClientRect().width;
    const startHeight = panel.getBoundingClientRect().height;

    const minWidth = 320;
    const minHeight = 440;
    const maxWidth = Math.floor(window.innerWidth * 0.96);
    const maxHeight = Math.floor(window.innerHeight * 0.94);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.min(maxWidth, Math.max(minWidth, startWidth - (moveEvent.clientX - startX)));
      const nextHeight = Math.min(maxHeight, Math.max(minHeight, startHeight + (moveEvent.clientY - startY)));
      setPanelSize({ width: nextWidth, height: nextHeight });
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  async function ensureChat(accessToken: string) {
    if (chatId) {
      return chatId;
    }
    const chats = await listChats(accessToken);
    if (chats.length > 0) {
      setChatId(chats[0].id);
      const history = await getMessages(accessToken, chats[0].id);
      setMessages(history as ChatMessage[]);
      return chats[0].id;
    }
    const chat = await createChat(accessToken);
    setChatId(chat.id);
    setMessages([]);
    return chat.id;
  }

  async function handleAuth(event: React.FormEvent) {
    event.preventDefault();
    const userId = credentials.id.trim();
    const password = credentials.password;
    if (!userId || !password) {
      setError("Enter user id and password.");
      return;
    }
    if (authMode === "register") {
      if (confirmPassword !== password) {
        setError("Passwords do not match.");
        return;
      }
    }

    setLoading(true);
    setError("");
    setAuthNotice("");
    try {
      const tokenPayload =
        authMode === "register" ? await register(userId, password) : await login(userId, password);
      setTokens(tokenPayload);
      await ensureChat(tokenPayload.access_token);
      setPanelMode("home");
      setCredentials({ id: userId, password: "" });
      setConfirmPassword("");
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
      setPanelMode("chat");
    } catch (e: any) {
      setError(e?.message || "Failed to create chat.");
    } finally {
      setLoading(false);
    }
  }

  async function handleConnectApi(event: React.FormEvent) {
    event.preventDefault();
    if (!tokens?.access_token) {
      return;
    }
    if (!apiConfig.apiKey.trim() || !apiConfig.databaseId.trim()) {
      setError("Provide API key and database id.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await connectApi(tokens.access_token, apiConfig.apiKey.trim(), apiConfig.databaseId.trim());
      setConnectExpanded(false);
      setApiConfig((prev) => ({ ...prev, apiKey: "" }));
    } catch (e: any) {
      setError(e?.message || "Failed to connect API.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDecomposeTask() {
    if (!tokens?.access_token) {
      return;
    }
    const taskTitle = decomposeTitle.trim();
    if (!taskTitle) {
      setError("Enter task title for DECOMPOSE action.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const activeChatId = await ensureChat(tokens.access_token);
      const response = await runDecompose(tokens.access_token, activeChatId, taskTitle);
      setMessages((prev) => [...prev, response.assistant_message as ChatMessage]);
      setPanelMode("chat");
      setDecomposeTitle("");
    } catch (e: any) {
      setError(e?.message || "Failed to run DECOMPOSE.");
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
      setMessages((prev) => [...prev, data.user_message as ChatMessage, data.assistant_message as ChatMessage]);
      setPanelMode("chat");
    } catch (e: any) {
      setError(e?.message || "Failed to send message.");
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    setTokens(null);
    setChatId(null);
    setMessages([]);
    setDraft("");
    setPanelMode("home");
    setConnectExpanded(false);
    setDecomposeTitle("");
    setError("");
    setAuthNotice("");
    setAuthMode("login");
    setCredentials({ id: "", password: "" });
    setConfirmPassword("");
    setShowLoginPassword(false);
    setShowRegisterPassword(false);
    setShowRegisterConfirm(false);
  }

  function switchAuthMode(next: "register" | "login") {
    setAuthMode(next);
    setError("");
    setAuthNotice("");
    setConfirmPassword("");
    setShowLoginPassword(false);
    setShowRegisterPassword(false);
    setShowRegisterConfirm(false);
  }

  return (
    <div className={`kanban-ai-ext ${open ? "open" : "closed"}`}>
      {open ? (
        <section className="ext-panel" ref={panelRef} style={panelSize}>
          <header className="ext-topbar">
            <h1>AS.YA</h1>
            <div className="ext-actions">
              {isAuthenticated ? (
                <>
                  <button className="btn-primary" onClick={handleCreateChat} disabled={loading}>
                    New Chat
                  </button>
                  <button type="button" className="btn-logout" onClick={handleLogout} disabled={loading}>
                    Logout
                  </button>
                </>
              ) : null}
              <button type="button" className="btn-close" onClick={() => setOpen(false)}>
                x
              </button>
            </div>
          </header>

          <p className="panel-subtitle">
            {backendReady ? "Backend online." : "Backend offline."} Signed in as {userName}.
          </p>
          {bootstrapping ? <p className="chat-hint">Loading saved session...</p> : null}

          {!isAuthenticated && !bootstrapping ? (
            <form className="auth-form auth-form-figma" onSubmit={handleAuth}>
              <div className="auth-card">
                <h2 className="auth-title">
                  {authMode === "register" ? "Create an account" : "Sign in to AS.YA"}
                </h2>
                <p className="auth-lede">Use your account to access chat, decompose, and API actions.</p>

                <div
                  className={`auth-fields ${authMode === "register" ? "auth-fields--register" : "auth-fields--login"}`}
                >
                  {authMode === "register" ? (
                    <div className="auth-field">
                      <label className="auth-field-label" htmlFor="kanban-auth-id">
                        Email or username
                      </label>
                      <input
                        id="kanban-auth-id"
                        className="auth-field-input"
                        value={credentials.id}
                        onChange={(event) => setCredentials((prev) => ({ ...prev, id: event.target.value }))}
                        placeholder="example@text.com"
                        autoComplete="username"
                        disabled={loading}
                      />
                    </div>
                  ) : (
                    <div className="auth-field auth-field-plain">
                      <div className="auth-field-input-wrap">
                        <input
                          id="kanban-auth-id"
                          className="auth-field-input"
                          value={credentials.id}
                          onChange={(event) => setCredentials((prev) => ({ ...prev, id: event.target.value }))}
                          placeholder="Email address or username"
                          autoComplete="username"
                          disabled={loading}
                        />
                      </div>
                    </div>
                  )}

                  {authMode === "register" ? (
                    <div className="auth-field">
                      <label className="auth-field-label" htmlFor="kanban-auth-password">
                        Create password
                      </label>
                      <div className="auth-field-input-wrap">
                        <input
                          id="kanban-auth-password"
                          className="auth-field-input auth-field-input--padded"
                          type={showRegisterPassword ? "text" : "password"}
                          value={credentials.password}
                          onChange={(event) => setCredentials((prev) => ({ ...prev, password: event.target.value }))}
                          placeholder="Password"
                          autoComplete="new-password"
                          disabled={loading}
                        />
                        <button
                          type="button"
                          className="auth-password-toggle"
                          onClick={() => setShowRegisterPassword((prev) => !prev)}
                          aria-label={showRegisterPassword ? "Hide password" : "Show password"}
                          disabled={loading}
                        >
                          <AuthPasswordEyeIcon revealed={showRegisterPassword} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="auth-field auth-field-plain">
                      <div className="auth-field-input-wrap">
                        <input
                          id="kanban-auth-password"
                          className="auth-field-input auth-field-input--padded"
                          type={showLoginPassword ? "text" : "password"}
                          value={credentials.password}
                          onChange={(event) => setCredentials((prev) => ({ ...prev, password: event.target.value }))}
                          placeholder="Password"
                          autoComplete="current-password"
                          disabled={loading}
                        />
                        <button
                          type="button"
                          className="auth-password-toggle"
                          onClick={() => setShowLoginPassword((prev) => !prev)}
                          aria-label={showLoginPassword ? "Hide password" : "Show password"}
                          disabled={loading}
                        >
                          <AuthPasswordEyeIcon revealed={showLoginPassword} />
                        </button>
                      </div>
                    </div>
                  )}

                  {authMode === "register" ? (
                    <div className="auth-field">
                      <label className="auth-field-label" htmlFor="kanban-auth-confirm">
                        Confirm password
                      </label>
                      <div className="auth-field-input-wrap">
                        <input
                          id="kanban-auth-confirm"
                          className="auth-field-input auth-field-input--padded"
                          type={showRegisterConfirm ? "text" : "password"}
                          value={confirmPassword}
                          onChange={(event) => setConfirmPassword(event.target.value)}
                          placeholder="Confirm password"
                          autoComplete="new-password"
                          disabled={loading}
                        />
                        <button
                          type="button"
                          className="auth-password-toggle"
                          onClick={() => setShowRegisterConfirm((prev) => !prev)}
                          aria-label={showRegisterConfirm ? "Hide password" : "Show password"}
                          disabled={loading}
                        >
                          <AuthPasswordEyeIcon revealed={showRegisterConfirm} />
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <button className="auth-cta" type="submit" disabled={loading}>
                  {authMode === "register" ? "Get started" : "Log in"}
                </button>

                {authMode === "login" ? (
                  <>
                    <button
                      type="button"
                      className="auth-forgot-link"
                      onClick={() => setAuthNotice("Password reset is not available yet.")}
                      disabled={loading}
                    >
                      Forgot password?
                    </button>
                    {authNotice ? <p className="auth-inline-notice">{authNotice}</p> : null}
                  </>
                ) : null}

                {authMode === "login" ? (
                  <p className="auth-footer-line">
                    <span className="auth-footer-muted">Don&apos;t have an account? </span>
                    <button
                      type="button"
                      className="auth-footer-link"
                      onClick={() => switchAuthMode("register")}
                      disabled={loading}
                    >
                      Sign up
                    </button>
                  </p>
                ) : (
                  <p className="auth-footer-line auth-footer-line--register">
                    <span className="auth-footer-muted">Already have an account? </span>
                    <button
                      type="button"
                      className="auth-footer-link"
                      onClick={() => switchAuthMode("login")}
                      disabled={loading}
                    >
                      Sign in
                    </button>
                  </p>
                )}
              </div>
            </form>
          ) : null}

          {isAuthenticated && panelMode === "home" ? (
            <>
              <h2 className="assistant-title">Home</h2>
              <div className="action-list">
                <button type="button" className="action-item" onClick={handleCreateChat} disabled={loading}>
                  Open Chat
                </button>
                <button type="button" className="action-item" onClick={handleDecomposeTask} disabled={loading}>
                  DECOMPOSE
                </button>
                <button
                  type="button"
                  className="action-item"
                  onClick={() => setConnectExpanded((prev) => !prev)}
                  disabled={loading}
                >
                  Connect API
                </button>
              </div>
              <input
                className="hero-chat-input auth-input"
                value={decomposeTitle}
                onChange={(event) => setDecomposeTitle(event.target.value)}
                placeholder="Task title for DECOMPOSE"
                disabled={loading}
              />
              {connectExpanded ? (
                <form className="connect-form" onSubmit={handleConnectApi}>
                  <input
                    className="hero-chat-input auth-input"
                    value={apiConfig.apiKey}
                    onChange={(event) => setApiConfig((prev) => ({ ...prev, apiKey: event.target.value }))}
                    placeholder="Notion API key"
                    disabled={loading}
                  />
                  <input
                    className="hero-chat-input auth-input"
                    value={apiConfig.databaseId}
                    onChange={(event) => setApiConfig((prev) => ({ ...prev, databaseId: event.target.value }))}
                    placeholder="Notion database id"
                    disabled={loading}
                  />
                  <button className="btn-secondary" type="submit" disabled={loading}>
                    Save API Connection
                  </button>
                </form>
              ) : null}
            </>
          ) : null}

          {isAuthenticated && panelMode === "chat" ? (
            <>
              <h2 className="assistant-title">Chat</h2>
              <button className="btn-secondary" type="button" onClick={() => setPanelMode("home")} disabled={loading}>
                Back to Home
              </button>
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
            </>
          ) : null}

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
          <p className="chat-hint">{chatId ? `Connected chat: ${chatId}` : "No active chat."}</p>
          {error ? <p className="status-error">{error}</p> : null}
          <button type="button" className="resize-handle-left" onPointerDown={handleResizeStart} aria-label="Resize panel">
            <span />
          </button>
        </section>
      ) : null}
    </div>
  );
}
