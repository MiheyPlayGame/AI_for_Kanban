import { useState } from "react";

function AiPanel({ isAuthenticated, chatId, messages, loading, error, onSend }) {
  const [draft, setDraft] = useState("");

  function handleSubmit(event) {
    event.preventDefault();
    onSend(draft);
    setDraft("");
  }

  return (
    <aside className="ai-panel">
      <div className="panel-badge">ИИ-ассистент</div>
      <h2>Умный помощник процессов</h2>
      <p>
        Задавайте вопросы по задачам и комментариям, генерируйте чек-листы
        и получайте предупреждения о блокерах до срыва дедлайнов.
      </p>

      <div className="panel-actions">
        <button className="btn-primary">Сгенерировать чек-лист</button>
        <button className="btn-secondary">Суммаризировать обсуждение</button>
      </div>

      <div className="chat-box">
        <h3>Чат с бэкендом</h3>
        <p className="chat-meta">
          {isAuthenticated
            ? chatId
              ? `ID чата: ${chatId}`
              : "Создайте чат, чтобы начать диалог."
            : "Сначала авторизуйтесь для использования эндпоинтов /chats."}
        </p>

        <div className="message-list">
          {messages.length === 0 ? (
            <p className="empty-state">Пока нет сообщений.</p>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`message-row ${message.role}`}>
                <strong>{message.role}</strong>
                <span>{message.content}</span>
              </div>
            ))
          )}
        </div>

        <form className="chat-form" onSubmit={handleSubmit}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="text-input"
            placeholder="Введите сообщение..."
            disabled={!chatId || loading}
          />
          <button type="submit" className="btn-primary" disabled={!chatId || loading}>
            Отправить
          </button>
        </form>
        {error ? <p className="status-error">{error}</p> : null}
      </div>

      <div className="insight-card warning">
        <h3>Предупреждение о блокере</h3>
        <p>На этой неделе задачи дольше обычного остаются на ревью.</p>
      </div>

      <div className="insight-card success">
        <h3>Поток в норме</h3>
        <p>Количество завершенных задач выросло на 18% относительно прошлого спринта.</p>
      </div>
    </aside>
  );
}

export default AiPanel;
