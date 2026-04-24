import React, { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { AuthPasswordEyeIcon } from "./AuthPasswordEyeIcon";
import {
  checkHealth,
  connectApi,
  createChat,
  findInText,
  getNotionStatus,
  getMessages,
  listNotionContext,
  listNotionDatabases,
  loadSession,
  listChats,
  login,
  type NotionContextItem,
  register,
  runDecompose,
  saveSession,
  sendMessage,
  startNotionOAuth,
  summarizeText,
  type NotionDatabaseEntry,
  type PanelMode,
  type Tokens
} from "../lib/runtimeApi";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type QuickAction = "chat" | "summarize" | "decompose" | "find";

type ExtensionPanelAppProps = {
  initialOpen?: boolean;
};

const settingsIconUrl = new URL("../assets/icons/Settings.svg", import.meta.url).href;
const arrowDownIconUrl = new URL("../assets/icons/Arrow down.svg", import.meta.url).href;
const arrowUpCircleIconUrl = new URL("../assets/icons/Arrow up-circle.svg", import.meta.url).href;

function makeLocalMessage(role: "user" | "assistant", content: string): ChatMessage {
  return { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, content };
}

function formatFindResponse(payload: any) {
  const answer = (payload?.answer || "").toString().trim();
  const notion = Array.isArray(payload?.notion_matches) ? payload.notion_matches : [];
  const info = Array.isArray(payload?.information_matches) ? payload.information_matches : [];
  if (!answer && notion.length === 0 && info.length === 0) {
    return "No matches found.";
  }
  const lines: string[] = [];
  if (answer) {
    lines.push(answer);
    return lines.join("\n");
  }
  lines.push("Found relevant results:");
  notion.slice(0, 3).forEach((item: any, index: number) => {
    lines.push(`${index + 1}. ${item?.item?.title || "Untitled Notion item"}`);
  });
  info.slice(0, 1).forEach((item: any) => {
    lines.push(`${item?.source_label || "Info"}: ${(item?.snippet || "").slice(0, 120)}`);
  });
  return lines.join("\n");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Request timeout")), timeoutMs);
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

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
  const [quickAction, setQuickAction] = useState<QuickAction>("chat");
  const [authMode, setAuthMode] = useState<"register" | "login">("login");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [showRegisterConfirm, setShowRegisterConfirm] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [credentials, setCredentials] = useState({ id: "", password: "" });
  const [apiConfig, setApiConfig] = useState({ apiKey: "", databaseId: "" });
  const [notionDatabases, setNotionDatabases] = useState<NotionDatabaseEntry[]>([]);
  const [notionTasks, setNotionTasks] = useState<NotionContextItem[]>([]);
  const [selectedDecomposeTaskId, setSelectedDecomposeTaskId] = useState("");
  const [notionConnected, setNotionConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [panelSize, setPanelSize] = useState<{ width?: number; height?: number }>({});

  const isAuthenticated = Boolean(tokens?.access_token);
  const isAuthScreen = !isAuthenticated && !bootstrapping;
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
        setPanelMode(session.panelMode === "settings" ? "home" : session.panelMode);
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
    const hydrateChats = async () => {
      if (!tokens?.access_token) {
        return;
      }
      try {
        const chats = await withTimeout(listChats(tokens.access_token), 5000);
        if (stopped) {
          return;
        }
        let resolvedChatId = chatId;
        if (!resolvedChatId && chats.length > 0) {
          resolvedChatId = chats[0].id;
        }
        if (resolvedChatId) {
          setChatId(resolvedChatId);
          const history = await withTimeout(getMessages(tokens.access_token, resolvedChatId), 5000);
          if (!stopped) {
            setMessages(history as ChatMessage[]);
          }
        }
      } catch {
        // Non-blocking: UI should stay usable even if backend/history is slow.
      }
    };
    hydrateChats();
    return () => {
      stopped = true;
    };
  }, [tokens?.access_token]);

  useEffect(() => {
    if (!tokens?.access_token) {
      setNotionDatabases([]);
      setNotionTasks([]);
      setSelectedDecomposeTaskId("");
      return;
    }
    withTimeout(listNotionDatabases(tokens.access_token), 5000)
      .then((payload) => {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        setNotionDatabases(items);
        const defaultDb = items.find((item) => item.is_default)?.database_id;
        if (defaultDb) {
          setApiConfig((prev) => ({ ...prev, databaseId: prev.databaseId || defaultDb }));
          setNotionConnected(true);
        }
      })
      .catch(() => {
        setNotionDatabases([]);
      });
  }, [tokens?.access_token]);

  useEffect(() => {
    if (!tokens?.access_token || !notionConnected) {
      setNotionTasks([]);
      setSelectedDecomposeTaskId("");
      return;
    }
    withTimeout(listNotionContext(tokens.access_token, 40), 6000)
      .then((payload) => {
        const items = (Array.isArray(payload?.items) ? payload.items : []).filter((item) =>
          Boolean((item?.title || "").toString().trim())
        );
        setNotionTasks(items);
        if (items.length === 0) {
          setSelectedDecomposeTaskId("");
          return;
        }
        setSelectedDecomposeTaskId((prev) => {
          if (prev && items.some((item) => (item.id || "") === prev)) {
            return prev;
          }
          return (items[0].id || "").toString();
        });
      })
      .catch(() => {
        setNotionTasks([]);
      });
  }, [tokens?.access_token, notionConnected]);

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
    saveSession({ tokens, activeChatId: chatId, panelMode }).catch(() => {
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
    if (authMode === "register" && confirmPassword !== password) {
      setError("Passwords do not match.");
      return;
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

  async function handleConnectApi(event: React.FormEvent) {
    event.preventDefault();
    if (!tokens?.access_token) {
      return;
    }
    const apiKey = apiConfig.apiKey.trim();
    const databaseId = apiConfig.databaseId.trim();
    if (!apiKey) {
      setError("Provide Notion API key.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await connectApi(tokens.access_token, apiKey, databaseId || undefined);
      setNotionConnected(true);
      const payload = await listNotionDatabases(tokens.access_token);
      const items = Array.isArray(payload?.items) ? payload.items : [];
      setNotionDatabases(items);
    } catch (e: any) {
      setError(e?.message || "Failed to connect API.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshNotionConnection(accessToken: string) {
    const status = await getNotionStatus(accessToken);
    setNotionConnected(Boolean(status?.connected));
    if (!status?.connected) {
      setNotionDatabases([]);
      return;
    }
    const payload = await listNotionDatabases(accessToken);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    setNotionDatabases(items);
    const defaultDb = items.find((item) => item.is_default)?.database_id;
    if (defaultDb) {
      setApiConfig((prev) => ({ ...prev, databaseId: defaultDb }));
    }
  }

  async function handleStartNotionOAuth() {
    if (!tokens?.access_token) {
      return;
    }
    setLoading(true);
    setError("");
    setAuthNotice("");
    try {
      const payload = await startNotionOAuth(tokens.access_token);
      if (payload?.auth_url) {
        window.open(payload.auth_url, "_blank", "noopener,noreferrer");
      }
      setAuthNotice("Notion OAuth opened in a new tab. Complete it, then click 'Check connection'.");
    } catch (e: any) {
      setError(e?.message || "Failed to start Notion OAuth.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckNotionConnection() {
    if (!tokens?.access_token) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      await refreshNotionConnection(tokens.access_token);
      setAuthNotice("Notion connection status updated.");
    } catch (e: any) {
      setError(e?.message || "Failed to check Notion status.");
    } finally {
      setLoading(false);
    }
  }

  function handleResetNotion() {
    setApiConfig({ apiKey: "", databaseId: "" });
    setNotionConnected(false);
    setError("");
  }

  async function handleQuickSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!tokens?.access_token) {
      return;
    }
    const input = draft.trim();
    const selectedTaskTitle =
      quickAction === "decompose"
        ? (notionTasks.find((item) => (item.id || "") === selectedDecomposeTaskId)?.title || "").trim()
        : "";
    if (quickAction !== "decompose" && !input) {
      return;
    }
    if (quickAction === "decompose" && !selectedTaskTitle && !input) {
      setError("Choose a Notion task or enter task title.");
      return;
    }
    setDraft("");
    setLoading(true);
    setError("");
    try {
      const activeChatId = await ensureChat(tokens.access_token);
      const actionTag =
        quickAction === "chat"
          ? "CHAT"
          : quickAction === "summarize"
            ? "SUMMARIZE"
            : quickAction === "decompose"
              ? "DECOMPOSE"
              : "FIND IN TEXT";
      const effectiveInput = quickAction === "decompose" ? selectedTaskTitle || input : input;
      const taggedPrompt = quickAction === "chat" ? effectiveInput : `[${actionTag}] ${effectiveInput}`;
      if (quickAction === "chat") {
        const payload = await sendMessage(tokens.access_token, activeChatId, input);
        setMessages((prev) => [...prev, payload.user_message as ChatMessage, payload.assistant_message as ChatMessage]);
      } else if (quickAction === "summarize") {
        setMessages((prev) => [...prev, makeLocalMessage("user", taggedPrompt)]);
        const summary = await summarizeText(tokens.access_token, input);
        setMessages((prev) => [...prev, makeLocalMessage("assistant", summary.summary)]);
      } else if (quickAction === "decompose") {
        if (!effectiveInput) {
          throw new Error("Choose a Notion task or enter task title.");
        }
        setMessages((prev) => [...prev, makeLocalMessage("user", taggedPrompt)]);
        const result = await runDecompose(tokens.access_token, activeChatId, effectiveInput);
        setMessages((prev) => [...prev, result.assistant_message as ChatMessage]);
      } else {
        setMessages((prev) => [...prev, makeLocalMessage("user", taggedPrompt)]);
        const result = await findInText(tokens.access_token, input, activeChatId);
        setMessages((prev) => [...prev, makeLocalMessage("assistant", formatFindResponse(result))]);
      }
      setPanelMode("chat");
    } catch (e: any) {
      setError(e?.message || "Action failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleChatSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!tokens?.access_token || !draft.trim()) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const activeChatId = await ensureChat(tokens.access_token);
      const payload = await sendMessage(tokens.access_token, activeChatId, draft.trim());
      setMessages((prev) => [...prev, payload.user_message as ChatMessage, payload.assistant_message as ChatMessage]);
      setDraft("");
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
    setError("");
    setAuthNotice("");
    setAuthMode("login");
    setCredentials({ id: "", password: "" });
    setConfirmPassword("");
    setShowLoginPassword(false);
    setShowRegisterPassword(false);
    setShowRegisterConfirm(false);
    setApiConfig({ apiKey: "", databaseId: "" });
    setNotionConnected(false);
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
        <section className={`ext-panel ${isAuthScreen ? "ext-panel-auth" : ""}`} ref={panelRef} style={panelSize}>
          {!isAuthScreen ? (
            <header className="ext-topbar">
              <h1>AS.YA</h1>
              <div className="ext-actions">
                {isAuthenticated ? (
                  <>
                    {panelMode === "settings" ? (
                      <button className="btn-secondary" onClick={() => setPanelMode("home")} disabled={loading}>
                        Home
                      </button>
                    ) : (
                      <button className="btn-secondary btn-icon" onClick={() => setPanelMode("settings")} disabled={loading}>
                        <img src={settingsIconUrl} alt="" aria-hidden="true" className="btn-icon-img" />
                        <span>Settings</span>
                      </button>
                    )}
                  </>
                ) : null}
                <button type="button" className="btn-close" onClick={() => setOpen(false)}>
                  x
                </button>
              </div>
            </header>
          ) : (
            <div className="auth-close-row">
              <button type="button" className="btn-close" onClick={() => setOpen(false)}>
                x
              </button>
            </div>
          )}

          {isAuthScreen ? (
            <form className="auth-form auth-form-figma" onSubmit={handleAuth}>
              <div className="auth-card">
                <h2 className="auth-title">
                  {authMode === "register" ? "Create an account" : "Sign in to AS.YA"}
                </h2>
                <p className="auth-lede">Use your account to access chat, decompose, and API actions.</p>
                <div className={`auth-fields ${authMode === "register" ? "auth-fields--register" : "auth-fields--login"}`}>
                  <div className={`auth-field ${authMode === "login" ? "auth-field-plain" : ""}`}>
                    {authMode === "register" ? (
                      <label className="auth-field-label" htmlFor="kanban-auth-id">
                        Email or username
                      </label>
                    ) : null}
                    <div className="auth-field-input-wrap">
                      <input
                        id="kanban-auth-id"
                        className="auth-field-input"
                        value={credentials.id}
                        onChange={(event) => setCredentials((prev) => ({ ...prev, id: event.target.value }))}
                        placeholder={authMode === "register" ? "example@text.com" : "Email address or username"}
                        autoComplete="username"
                        disabled={loading}
                      />
                    </div>
                  </div>
                  <div className={`auth-field ${authMode === "login" ? "auth-field-plain" : ""}`}>
                    {authMode === "register" ? (
                      <label className="auth-field-label" htmlFor="kanban-auth-password">
                        Create password
                      </label>
                    ) : null}
                    <div className="auth-field-input-wrap">
                      <input
                        id="kanban-auth-password"
                        className="auth-field-input auth-field-input--padded"
                        type={authMode === "register" ? (showRegisterPassword ? "text" : "password") : showLoginPassword ? "text" : "password"}
                        value={credentials.password}
                        onChange={(event) => setCredentials((prev) => ({ ...prev, password: event.target.value }))}
                        placeholder="Password"
                        autoComplete={authMode === "register" ? "new-password" : "current-password"}
                        disabled={loading}
                      />
                      <button
                        type="button"
                        className="auth-password-toggle"
                        onClick={() =>
                          authMode === "register"
                            ? setShowRegisterPassword((prev) => !prev)
                            : setShowLoginPassword((prev) => !prev)
                        }
                        aria-label="Toggle password"
                        disabled={loading}
                      >
                        <AuthPasswordEyeIcon revealed={authMode === "register" ? showRegisterPassword : showLoginPassword} />
                      </button>
                    </div>
                  </div>
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
                          aria-label="Toggle confirm password"
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
                    <button type="button" className="auth-footer-link" onClick={() => switchAuthMode("register")} disabled={loading}>
                      Sign up
                    </button>
                  </p>
                ) : (
                  <p className="auth-footer-line auth-footer-line--register">
                    <span className="auth-footer-muted">Already have an account? </span>
                    <button type="button" className="auth-footer-link" onClick={() => switchAuthMode("login")} disabled={loading}>
                      Sign in
                    </button>
                  </p>
                )}
              </div>
            </form>
          ) : null}

          {isAuthenticated && panelMode === "home" ? (
            <>
              <h2 className="assistant-title">Main</h2>
              <div className="quick-action-row">
                <button
                  type="button"
                  className={`action-item ${quickAction === "chat" ? "action-item-active" : ""}`}
                  onClick={() => setQuickAction("chat")}
                  disabled={loading}
                >
                  CHAT
                </button>
                <button
                  type="button"
                  className={`action-item ${quickAction === "summarize" ? "action-item-active" : ""}`}
                  onClick={() => setQuickAction("summarize")}
                  disabled={loading}
                >
                  SUMMARIZE
                </button>
                <button
                  type="button"
                  className={`action-item ${quickAction === "decompose" ? "action-item-active" : ""}`}
                  onClick={() => setQuickAction("decompose")}
                  disabled={loading}
                >
                  DECOMPOSE
                </button>
                <button
                  type="button"
                  className={`action-item ${quickAction === "find" ? "action-item-active" : ""}`}
                  onClick={() => setQuickAction("find")}
                  disabled={loading}
                >
                  FIND IN TEXT
                </button>
              </div>
              <form className="hero-chat-form" onSubmit={handleQuickSubmit}>
                <div className="hero-chat-shell">
                  {quickAction === "decompose" && notionTasks.length > 0 ? (
                    <select
                      className="hero-chat-input auth-input auth-select"
                      value={selectedDecomposeTaskId}
                      onChange={(event) => setSelectedDecomposeTaskId(event.target.value)}
                      disabled={loading}
                    >
                      {notionTasks.map((item) => (
                        <option key={item.id || item.title} value={(item.id || "").toString()}>
                          {item.title || "Untitled task"}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <input
                    className="hero-chat-input"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={
                      quickAction === "decompose"
                        ? notionTasks.length > 0
                          ? "Optional: enter task title manually"
                          : "Enter task title from Notion"
                        : quickAction === "chat"
                          ? "Type your message..."
                          : "Start chatting..."
                    }
                    disabled={loading}
                  />
                  <div className="hero-chat-bottom">
                    <span className="input-state mode-state">
                      <span>{loading ? "Processing..." : `Mode: ${quickAction.toUpperCase()}`}</span>
                      <img src={arrowDownIconUrl} alt="" aria-hidden="true" className="input-state-icon" />
                    </span>
                    <button
                      className="send-btn"
                      type="submit"
                      disabled={
                        loading ||
                        (quickAction !== "decompose" && !draft.trim()) ||
                        (quickAction === "decompose" &&
                          !draft.trim() &&
                          !(notionTasks.find((item) => (item.id || "") === selectedDecomposeTaskId)?.title || "").trim())
                      }
                    >
                      <img src={arrowUpCircleIconUrl} alt="Send" className="send-btn-icon" />
                    </button>
                  </div>
                </div>
              </form>
            </>
          ) : null}

          {isAuthenticated && panelMode === "settings" ? (
            <>
              <h2 className="assistant-title">Settings</h2>
              <form className="connect-form" onSubmit={handleConnectApi}>
                <div className="settings-buttons">
                  <button className="btn-secondary" type="button" onClick={handleStartNotionOAuth} disabled={loading}>
                    Connect via Notion OAuth
                  </button>
                  <button className="btn-secondary" type="button" onClick={handleCheckNotionConnection} disabled={loading}>
                    Check connection
                  </button>
                </div>
                <input
                  className="hero-chat-input auth-input"
                  value={apiConfig.apiKey}
                  onChange={(event) => setApiConfig((prev) => ({ ...prev, apiKey: event.target.value }))}
                  placeholder="Notion Internal Integration token (secret_...)"
                  disabled={loading}
                />
                {notionDatabases.length > 0 ? (
                  <select
                    className="hero-chat-input auth-input auth-select"
                    value={apiConfig.databaseId}
                    onChange={(event) => setApiConfig((prev) => ({ ...prev, databaseId: event.target.value }))}
                    disabled={loading}
                  >
                    <option value="">Choose database from connected list</option>
                    {notionDatabases.map((item) => (
                      <option key={item.database_id} value={item.database_id}>
                        {item.title ? `${item.title} (${item.database_id.slice(0, 8)}...)` : item.database_id}
                        {item.is_default ? " - default" : ""}
                      </option>
                    ))}
                  </select>
                ) : null}
                <div className="settings-buttons">
                  <button className="btn-secondary" type="submit" disabled={loading}>
                    Connect with token (fallback)
                  </button>
                  <button className="btn-logout" type="button" onClick={handleResetNotion} disabled={loading}>
                    Reset Notion
                  </button>
                  <button className="btn-logout" type="button" onClick={handleLogout} disabled={loading}>
                    Log out
                  </button>
                </div>
                <p className="chat-hint">
                  {notionConnected
                    ? "Notion connected. All shared databases are available."
                    : "Use OAuth first. Token connect is optional fallback."}
                </p>
                {authNotice ? <p className="chat-hint">{authNotice}</p> : null}
              </form>
            </>
          ) : null}

          {isAuthenticated && panelMode === "chat" ? (
            <>
              <h2 className="assistant-title">Chat</h2>
              <div className="message-preview message-preview-chat">
                {messages.length === 0 ? (
                  <p className="empty-state">No conversation yet.</p>
                ) : (
                  messages.map((message) => (
                    <div className={`message-row ${message.role}`} key={message.id}>
                      <strong>{message.role}</strong>
                      <span>{message.content}</span>
                    </div>
                  ))
                )}
              </div>
              <form className="hero-chat-form" onSubmit={handleChatSubmit}>
                <div className="hero-chat-shell">
                  <input
                    className="hero-chat-input"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Send a message to ML..."
                    disabled={loading}
                  />
                  <div className="hero-chat-bottom">
                    <button className="btn-secondary" type="button" onClick={() => setPanelMode("home")} disabled={loading}>
                      Home
                    </button>
                    <button className="send-btn" type="submit" disabled={loading || !draft.trim()}>
                      <img src={arrowUpCircleIconUrl} alt="Send" className="send-btn-icon" />
                    </button>
                  </div>
                </div>
              </form>
            </>
          ) : null}

          {panelMode !== "chat" && isAuthenticated ? (
            <div className="message-preview">
              {messages.length === 0 ? (
                <p className="empty-state">No conversation yet.</p>
              ) : (
                messages.slice(-5).map((message) => (
                  <div className={`message-row ${message.role}`} key={message.id}>
                    <strong>{message.role}</strong>
                    <span>{message.content}</span>
                  </div>
                ))
              )}
            </div>
          ) : null}
          {error ? <p className="status-error">{error}</p> : null}
          {!isAuthScreen ? (
            <button type="button" className="resize-handle-left" onPointerDown={handleResizeStart} aria-label="Resize panel">
              <span />
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
