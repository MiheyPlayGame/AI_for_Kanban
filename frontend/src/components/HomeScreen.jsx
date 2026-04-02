import { useState } from "react";

const quickActions = [
  "Break down task",
  "Summarize discussion",
  "Find blockers",
  "Sprint health report"
];

function HomeScreen({ backendReady, isAuthenticated, chatId, messages, loading, error, onSend }) {
  const [draft, setDraft] = useState("");

  function handleSubmit(event) {
    event.preventDefault();
    if (!draft.trim()) {
      return;
    }
    onSend(draft);
    setDraft("");
  }

  return (
    <main className="home-layout">
      {backendReady ? (
        <aside className="projects-panel">
          <div className="panel-title-row">
            <h2>Recent Projects</h2>
          </div>
          <div className="projects-empty">
            <p>No recent projects yet.</p>
            <p>Projects will appear here after data sync.</p>
          </div>
        </aside>
      ) : null}

      <section className="chat-home">
        <p className="kicker">AI Workspace</p>
        <h2>What should we do today?</h2>

        <form className="hero-chat-form" onSubmit={handleSubmit}>
          <div className="hero-chat-shell">
            <input
              className="hero-chat-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message AI assistant"
              disabled={!chatId || loading}
            />
            <div className="hero-chat-bottom">
              <div className="hero-chat-modes">
                {quickActions.map((action, index) => (
                  <button
                    key={action}
                    type="button"
                    className={`mode-pill ${index === 0 ? "mode-pill-active" : ""}`}
                    disabled={!isAuthenticated || !chatId}
                  >
                    {action}
                  </button>
                ))}
              </div>
              <div className="hero-chat-tools">
                <button className="send-btn" type="submit" disabled={!chatId || loading}>
                  ↑
                </button>
              </div>
            </div>
          </div>
        </form>

        <p className="chat-hint">
          {!isAuthenticated
            ? "Sign in to unlock projects and AI actions."
            : chatId
              ? `Connected chat: ${chatId}`
              : "Create a chat from the top bar to start."}
        </p>
        {error ? <p className="status-error">{error}</p> : null}

        {isAuthenticated ? (
          <div className="message-preview">
            {messages.length === 0 ? (
              <p className="empty-state">No conversation yet.</p>
            ) : (
              messages.slice(-4).map((message) => (
                <div className={`message-row ${message.role}`} key={message.id}>
                  <strong>{message.role}</strong>
                  <span>{message.content}</span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default HomeScreen;
