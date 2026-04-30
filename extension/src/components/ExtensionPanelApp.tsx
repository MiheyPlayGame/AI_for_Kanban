import React, { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { AuthPasswordEyeIcon } from "./AuthPasswordEyeIcon";
import { ArrowDownIcon, ArrowUpCircleIcon, SettingsIcon } from "./UiIcons";
import {
  checkHealth,
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
  pending?: boolean;
};

type QuickAction = "chat" | "summarize" | "decompose" | "find";

type ExtensionPanelAppProps = {
  initialOpen?: boolean;
};

const quickActionMeta: Record<
  QuickAction,
  { label: string; requirement: string; placeholder: string; emptyHint: string }
> = {
  chat: {
    label: "Chat",
    requirement: "Free-form prompt.",
    placeholder: "Write a message...",
    emptyHint: "Ask a question or describe the task."
  },
  summarize: {
    label: "Summarize",
    requirement: "Requires text to summarize.",
    placeholder: "Paste text for a concise summary...",
    emptyHint: "Add text that should be summarized."
  },
  decompose: {
    label: "Decompose",
    requirement: "Select a Notion task or enter a title manually.",
    placeholder: "Enter task title...",
    emptyHint: "Pick a task from Notion or type one manually."
  },
  find: {
    label: "Find in text",
    requirement: "Enter a search query for your context.",
    placeholder: "What do you want to find?",
    emptyHint: "Type a phrase or keywords to search."
  }
};

function makeLocalMessage(role: "user" | "assistant", content: string): ChatMessage {
  return { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, content };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdownToHtml(markdown: string) {
  const safe = escapeHtml(markdown || "");
  const blocks = safe.split(/\n{2,}/);
  const rendered = blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((line) => line.trim().startsWith("- "))) {
        const items = lines
          .map((line) => line.trim().slice(2))
          .map((item) => `<li>${item}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }
      if (lines.every((line) => /^\d+\.\s/.test(line.trim()))) {
        const items = lines
          .map((line) => line.trim().replace(/^\d+\.\s/, ""))
          .map((item) => `<li>${item}</li>`)
          .join("");
        return `<ol>${items}</ol>`;
      }
      return `<p>${lines.join("<br/>")}</p>`;
    })
    .join("");
  return rendered
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
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

function toUserErrorMessage(error: unknown, fallback: string) {
  const raw = (error as any)?.message?.toString?.().trim?.() || "";
  if (!raw) {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  if (normalized.includes("timeout")) {
    return "The service is taking too long to respond. Please try again.";
  }
  if (normalized.includes("failed to fetch") || normalized.includes("networkerror")) {
    return "Unable to reach the server. Check your connection and backend status.";
  }
  if (normalized.includes("401") || normalized.includes("unauthorized")) {
    return "Your session expired. Please sign in again.";
  }
  if (normalized.includes("403") || normalized.includes("forbidden")) {
    return "You do not have permission for this action.";
  }
  if (normalized.includes("not found") || normalized.includes("404")) {
    return "We could not find the requested data.";
  }
  if (normalized.includes("validation") || normalized.includes("invalid") || normalized.includes("unprocessable")) {
    return "Some input looks incorrect. Please check and try again.";
  }
  if (normalized.includes("too many requests") || normalized.includes("429")) {
    return "Too many requests right now. Please wait a moment and retry.";
  }
  return fallback;
}

export default function ExtensionPanelApp({ initialOpen = false }: ExtensionPanelAppProps) {
  const panelRef = React.useRef<HTMLElement | null>(null);
  const messageListRef = React.useRef<HTMLDivElement | null>(null);
  const modeMenuRef = React.useRef<HTMLDivElement | null>(null);
  const forceCreateNextChatRef = React.useRef(false);
  const chatSessionVersionRef = React.useRef(0);
  const [open, setOpen] = useState(initialOpen);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("home");
  const [lastPrimaryMode, setLastPrimaryMode] = useState<"home" | "chat">("home");
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
  const [notionDatabases, setNotionDatabases] = useState<NotionDatabaseEntry[]>([]);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState("");
  const [notionTasks, setNotionTasks] = useState<NotionContextItem[]>([]);
  const [selectedDecomposeTaskId, setSelectedDecomposeTaskId] = useState("");
  const [notionConnected, setNotionConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [panelSize, setPanelSize] = useState<{ width?: number; height?: number }>({});
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  const isAuthenticated = Boolean(tokens?.access_token);
  const isAuthScreen = !isAuthenticated && !bootstrapping;
  const selectedTaskTitle = useMemo(
    () => (notionTasks.find((item) => (item.id || "") === selectedDecomposeTaskId)?.title || "").trim(),
    [notionTasks, selectedDecomposeTaskId]
  );

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
        const initialMode = session.panelMode === "settings" ? "home" : session.panelMode;
        setPanelMode(initialMode);
        setLastPrimaryMode(initialMode === "chat" ? "chat" : "home");
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
    if (panelMode === "chat" || panelMode === "home") {
      setLastPrimaryMode(panelMode);
    }
  }, [panelMode]);

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
            if (Array.isArray(history) && history.length > 0) {
              setPanelMode("chat");
            }
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
      setSelectedDatabaseId("");
      setNotionTasks([]);
      setSelectedDecomposeTaskId("");
      return;
    }
    withTimeout(listNotionDatabases(tokens.access_token), 5000)
      .then((payload) => {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        setNotionDatabases(items);
        const defaultDb = items.find((item) => item.is_default)?.database_id || items[0]?.database_id || "";
        setSelectedDatabaseId((prev) => prev || defaultDb);
        if (items.find((item) => item.is_default)?.database_id) {
          setNotionConnected(true);
        }
      })
      .catch(() => {
        setNotionDatabases([]);
        setSelectedDatabaseId("");
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
    if (!tokens?.access_token || panelMode !== "settings") {
      return;
    }
    let stopped = false;
    const refresh = async () => {
      try {
        const status = await withTimeout(getNotionStatus(tokens.access_token), 5000);
        if (!stopped) {
          setNotionConnected(Boolean(status?.connected));
        }
      } catch {
        if (!stopped) {
          setNotionConnected(false);
        }
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [tokens?.access_token, panelMode]);

  useEffect(() => {
    let stopped = false;
    const run = async () => {
      try {
        await checkHealth();
      } catch {
        if (!stopped) {
          // Keep polling health silently. UI errors are handled on user actions.
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

  useEffect(() => {
    if (panelMode !== "chat") {
      return;
    }
    const node = messageListRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [messages, panelMode]);

  useEffect(() => {
    if (!modeMenuOpen) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (modeMenuRef.current && !modeMenuRef.current.contains(target)) {
        setModeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [modeMenuOpen]);

  function handlePanelKeyDownCapture(event: React.KeyboardEvent<HTMLElement>) {
    // Keep page-level shortcuts from hijacking input while the panel is focused.
    if (event.ctrlKey || event.metaKey || event.key === "Enter" || event.key === "Escape") {
      event.stopPropagation();
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const form = event.currentTarget.closest("form");
      if (form) {
        form.requestSubmit();
      }
    }
  }

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
    if (forceCreateNextChatRef.current) {
      const freshChat = await createChat(accessToken);
      forceCreateNextChatRef.current = false;
      setChatId(freshChat.id);
      setMessages([]);
      return freshChat.id;
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
      setError(toUserErrorMessage(e, "Unable to sign in."));
    } finally {
      setLoading(false);
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
      const payload = await startNotionOAuth(tokens.access_token, selectedDatabaseId || undefined);
      if (payload?.auth_url) {
        window.open(payload.auth_url, "_blank", "noopener,noreferrer");
      }
      setAuthNotice("Notion OAuth opened in a new tab. Finish authorization and return here.");
    } catch (e: any) {
      setError(toUserErrorMessage(e, "Unable to start Notion authorization."));
    } finally {
      setLoading(false);
    }
  }

  function handleResetNotion() {
    setNotionConnected(false);
    setNotionDatabases([]);
    setSelectedDatabaseId("");
    setError("");
  }

  async function handleQuickSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!tokens?.access_token) {
      return;
    }
    const input = draft.trim();
    const modeMeta = quickActionMeta[quickAction];
    if (quickAction !== "decompose" && !input) {
      return;
    }
    if (quickAction === "decompose" && !selectedTaskTitle && !input) {
      setError("Choose a Notion task or enter a task title.");
      return;
    }
    const requestVersion = chatSessionVersionRef.current;
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
      const localUserMessage = makeLocalMessage("user", taggedPrompt);
      const pendingAssistantId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setMessages((prev) => [...prev, localUserMessage, { id: pendingAssistantId, role: "assistant", content: "Thinking...", pending: true }]);
      setPanelMode("chat");
      if (quickAction === "chat") {
        const payload = await sendMessage(tokens.access_token, activeChatId, input);
        if (requestVersion !== chatSessionVersionRef.current) {
          return;
        }
        setMessages((prev) =>
          prev.map((message) =>
            message.id === pendingAssistantId ? (payload.assistant_message as ChatMessage) : message
          )
        );
      } else if (quickAction === "summarize") {
        const summary = await summarizeText(tokens.access_token, input);
        if (requestVersion !== chatSessionVersionRef.current) {
          return;
        }
        setMessages((prev) =>
          prev.map((message) =>
            message.id === pendingAssistantId ? makeLocalMessage("assistant", summary.summary) : message
          )
        );
      } else if (quickAction === "decompose") {
        if (!effectiveInput) {
          throw new Error("Choose a Notion task or enter task title.");
        }
        const result = await runDecompose(tokens.access_token, activeChatId, effectiveInput);
        if (requestVersion !== chatSessionVersionRef.current) {
          return;
        }
        setMessages((prev) =>
          prev.map((message) =>
            message.id === pendingAssistantId ? (result.assistant_message as ChatMessage) : message
          )
        );
      } else {
        const result = await findInText(tokens.access_token, input, activeChatId);
        if (requestVersion !== chatSessionVersionRef.current) {
          return;
        }
        setMessages((prev) =>
          prev.map((message) =>
            message.id === pendingAssistantId ? makeLocalMessage("assistant", formatFindResponse(result)) : message
          )
        );
      }
    } catch (e: any) {
      setMessages((prev) => prev.filter((message) => !message.pending));
      setError(toUserErrorMessage(e, `Unable to run ${modeMeta.label} mode.`));
    } finally {
      setLoading(false);
    }
  }

  async function handleChatSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!tokens?.access_token) {
      return;
    }
    if (
      quickAction !== "decompose" &&
      !draft.trim()
    ) {
      return;
    }
    if (quickAction === "decompose" && !draft.trim() && !selectedTaskTitle) {
      setError("Select a Notion task or enter a task title.");
      return;
    }
    return handleQuickSubmit(event);
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
        <section
          className={`ext-panel ${isAuthScreen ? "ext-panel-auth" : ""} ${!isAuthScreen ? `mode-${panelMode}` : ""}`}
          ref={panelRef}
          style={panelSize}
          onKeyDownCapture={handlePanelKeyDownCapture}
        >
          {!isAuthScreen ? (
            <header className="ext-topbar">
              <h1>AS.YA</h1>
              <div className="ext-actions">
                {isAuthenticated ? (
                  <>
                    {panelMode === "chat" ? (
                      <button className="btn-secondary" onClick={() => {
                        chatSessionVersionRef.current += 1;
                        forceCreateNextChatRef.current = true;
                        setMessages([]);
                        setChatId(null);
                        setDraft("");
                        setError("");
                        setPanelMode("chat");
                      }} disabled={loading}>
                        Clear chat
                      </button>
                    ) : null}
                    {panelMode === "settings" ? (
                      <button className="btn-secondary" onClick={() => setPanelMode(lastPrimaryMode)} disabled={loading}>
                        Back
                      </button>
                    ) : (
                      <button
                        className="btn-secondary btn-icon"
                        onClick={() => {
                          setLastPrimaryMode(panelMode === "chat" ? "chat" : "home");
                          setPanelMode("settings");
                        }}
                        disabled={loading}
                      >
                        <SettingsIcon className="btn-icon-img" />
                      </button>
                    )}
                  </>
                ) : null}
                <button type="button" className="btn-close" onClick={() => setOpen(false)}>
                  x
                </button>
              </div>
            </header>
          ) : null}

          {isAuthScreen ? (
            <form className="auth-form auth-form-figma" onSubmit={handleAuth}>
              <div className="auth-card">
                <button type="button" className="btn-close auth-card-close" onClick={() => setOpen(false)} aria-label="Close panel">
                  x
                </button>
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
                {error ? <p className="status-error auth-status-error">{error}</p> : null}
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
              <form className="hero-chat-form" onSubmit={handleQuickSubmit}>
                <div className="hero-chat-shell">
                  <p className="mode-requirement">{quickActionMeta[quickAction].requirement}</p>
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
                  <textarea
                    className="hero-chat-input hero-chat-textarea"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={quickAction === "decompose" && notionTasks.length > 0 ? "Optional: type a custom task title..." : quickActionMeta[quickAction].placeholder}
                    disabled={loading}
                    rows={2}
                  />
                  <div className="hero-chat-bottom">
                    <div className="mode-dropdown" ref={modeMenuRef}>
                      <button
                        type="button"
                        className="mode-dropdown-trigger"
                        onClick={() => setModeMenuOpen((prev) => !prev)}
                        disabled={loading}
                      >
                        <span>{quickActionMeta[quickAction].label}</span>
                        <ArrowDownIcon className="mode-pill-icon" />
                      </button>
                      {modeMenuOpen ? (
                        <div className="mode-dropdown-menu">
                          {(Object.keys(quickActionMeta) as QuickAction[]).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              className={`mode-dropdown-item ${quickAction === mode ? "active" : ""}`}
                              onClick={() => {
                                setQuickAction(mode);
                                setModeMenuOpen(false);
                              }}
                            >
                              {quickActionMeta[mode].label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <span className="input-state">{loading ? "Processing request..." : quickActionMeta[quickAction].emptyHint}</span>
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
                      <ArrowUpCircleIcon className="send-btn-icon" />
                    </button>
                  </div>
                </div>
              </form>
            </>
          ) : null}

          {isAuthenticated && panelMode === "settings" ? (
            <>
              <h2 className="assistant-title">Settings</h2>
              <div className="connect-form">
                <div className="notion-connection-card">
                  <p className="notion-connection-title">Notion</p>
                  <p className={`notion-connection-badge ${notionConnected ? "connected" : "disconnected"}`}>
                    {notionConnected ? "Connected" : "Not connected"}
                  </p>
                  <p className="notion-connection-text">
                    {notionConnected
                      ? "Integration is active. You can use Notion tasks in assistant modes."
                      : "Connect your workspace with Notion OAuth."}
                  </p>
                </div>
                <div className="settings-buttons">
                  <button className="btn-secondary" type="button" onClick={handleStartNotionOAuth} disabled={loading}>
                    Connect via Notion OAuth
                  </button>
                </div>
                {notionDatabases.length > 0 ? (
                  <select
                    className="hero-chat-input auth-input auth-select"
                    value={selectedDatabaseId}
                    onChange={(event) => setSelectedDatabaseId(event.target.value)}
                    disabled={loading}
                  >
                    <option value="">Choose database</option>
                    {notionDatabases.map((item) => (
                      <option key={item.database_id} value={item.database_id}>
                        {item.title ? `${item.title} (${item.database_id.slice(0, 8)}...)` : item.database_id}
                        {item.is_default ? " - default" : ""}
                      </option>
                    ))}
                  </select>
                ) : null}
                <div className="settings-buttons">
                  <button className="btn-logout" type="button" onClick={handleResetNotion} disabled={loading}>
                    Reset Notion
                  </button>
                  <button className="btn-logout" type="button" onClick={handleLogout} disabled={loading}>
                    Log out
                  </button>
                </div>
                {authNotice ? <p className="chat-hint">{authNotice}</p> : null}
              </div>
            </>
          ) : null}

          {isAuthenticated && panelMode === "chat" ? (
            <>
              <h2 className="assistant-title">Chat</h2>
              <div className="message-preview message-preview-chat" ref={messageListRef}>
                {messages.length === 0 ? (
                  <p className="empty-state">No conversation yet.</p>
                ) : (
                  messages.map((message) => (
                    <div className={`message-row ${message.role}`} key={message.id}>
                      {message.pending ? (
                        <span className="thinking-text">Preparing</span>
                      ) : message.role === "assistant" ? (
                        <span
                          className="message-markdown"
                          dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
                        />
                      ) : (
                        <span>{message.content}</span>
                      )}
                    </div>
                  ))
                )}
              </div>
              <form className="hero-chat-form chat-composer-docked" onSubmit={handleChatSubmit}>
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
                  <textarea
                    className="hero-chat-input hero-chat-textarea"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={quickAction === "decompose" && selectedTaskTitle ? "Optional: refine the selected task title..." : quickActionMeta[quickAction].placeholder}
                    disabled={loading}
                    rows={2}
                  />
                  <div className="hero-chat-bottom">
                    <div className="mode-dropdown" ref={modeMenuRef}>
                      <button
                        type="button"
                        className="mode-dropdown-trigger"
                        onClick={() => setModeMenuOpen((prev) => !prev)}
                        disabled={loading}
                      >
                        <span>{quickActionMeta[quickAction].label}</span>
                        <ArrowDownIcon className="mode-pill-icon" />
                      </button>
                      {modeMenuOpen ? (
                        <div className="mode-dropdown-menu">
                          {(Object.keys(quickActionMeta) as QuickAction[]).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              className={`mode-dropdown-item ${quickAction === mode ? "active" : ""}`}
                              onClick={() => {
                                setQuickAction(mode);
                                setModeMenuOpen(false);
                              }}
                            >
                              {quickActionMeta[mode].label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <span className="input-state">{loading ? "Processing request..." : quickActionMeta[quickAction].emptyHint}</span>
                    <button
                      className="send-btn"
                      type="submit"
                      disabled={
                        loading ||
                        (quickAction !== "decompose" && !draft.trim()) ||
                        (quickAction === "decompose" && !draft.trim() && !selectedTaskTitle)
                      }
                    >
                      <ArrowUpCircleIcon className="send-btn-icon" />
                    </button>
                  </div>
                </div>
              </form>
            </>
          ) : null}

          {panelMode === "home" && isAuthenticated ? (
            <div className="message-preview">
              {messages.length === 0 ? (
                <p className="empty-state">No conversation yet.</p>
              ) : (
                messages.slice(-5).map((message) => (
                  <div className={`message-row ${message.role}`} key={message.id}>
                    {message.pending ? (
                      <span className="thinking-text">Preparing</span>
                    ) : message.role === "assistant" ? (
                      <span
                        className="message-markdown"
                        dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.content) }}
                      />
                    ) : (
                      <span>{message.content}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : null}
          {error && !isAuthScreen ? <p className="status-error">{error}</p> : null}
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
