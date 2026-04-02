import { useEffect, useMemo, useState } from "react";
import HomeScreen from "./components/HomeScreen";
import TopBar from "./layout/TopBar";
import { checkHealth, createChat, getMessages, listChats, login, register, sendMessage } from "./services/api";

function App() {
  const [credentials, setCredentials] = useState({ id: "", password: "" });
  const [tokens, setTokens] = useState(null);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [authError, setAuthError] = useState("");
  const [chatError, setChatError] = useState("");
  const [backendReady, setBackendReady] = useState(false);
  const [loading, setLoading] = useState(false);

  const isAuthenticated = Boolean(tokens?.access_token);

  const currentUser = useMemo(() => {
    if (!isAuthenticated) {
      return "Guest";
    }
    return credentials.id || "User";
  }, [credentials.id, isAuthenticated]);

  useEffect(() => {
    let cancelled = false;

    async function pingBackend() {
      try {
        await checkHealth();
        if (!cancelled) {
          setBackendReady(true);
        }
      } catch {
        if (!cancelled) {
          setBackendReady(false);
        }
      }
    }

    pingBackend();
    const timer = window.setInterval(pingBackend, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function runAuth(mode, id, password) {
    if (!id || !password) {
      setAuthError("Provide both user id and password.");
      return;
    }

    setLoading(true);
    setAuthError("");
    setChatError("");

    try {
      const tokenPayload = mode === "register" ? await register(id, password) : await login(id, password);
      setCredentials({ id, password });
      setTokens(tokenPayload);
      const chats = await listChats(tokenPayload.access_token);
      if (chats.length > 0) {
        setCurrentChatId(chats[0].id);
        const history = await getMessages(tokenPayload.access_token, chats[0].id);
        setMessages(history);
      } else {
        setCurrentChatId(null);
        setMessages([]);
      }
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAuth(mode) {
    const id = window.prompt("User id:");
    if (id === null) {
      return;
    }
    const password = window.prompt("Password:");
    if (password === null) {
      return;
    }
    await runAuth(mode, id.trim(), password);
  }

  async function handleCreateChat() {
    if (!tokens?.access_token) {
      return;
    }

    setLoading(true);
    setChatError("");
    try {
      const chat = await createChat(tokens.access_token);
      setCurrentChatId(chat.id);
      setMessages([]);
    } catch (error) {
      setChatError(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSendMessage(content) {
    if (!tokens?.access_token || !currentChatId) {
      setChatError("Create a chat first.");
      return;
    }
    if (!content.trim()) {
      return;
    }

    setLoading(true);
    setChatError("");
    try {
      const data = await sendMessage(tokens.access_token, currentChatId, content.trim());
      setMessages((prev) => [...prev, data.user_message, data.assistant_message]);
    } catch (error) {
      setChatError(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <TopBar
        currentUser={currentUser}
        isAuthenticated={isAuthenticated}
        loading={loading}
        onRegister={() => handleAuth("register")}
        onLogin={() => handleAuth("login")}
        onCreateChat={handleCreateChat}
      />
      {authError ? <p className="status-error">{authError}</p> : null}
      <HomeScreen
        backendReady={backendReady}
        isAuthenticated={isAuthenticated}
        chatId={currentChatId}
        messages={messages}
        loading={loading}
        error={chatError}
        onSend={handleSendMessage}
      />
      <footer className="app-footer">AI Assistant for Kanban - Web MVP</footer>
    </div>
  );
}

export default App;
