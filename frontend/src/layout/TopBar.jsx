function TopBar({
  currentUser,
  isAuthenticated,
  loading,
  onRegister,
  onLogin,
  onCreateChat
}) {
  return (
    <header className="topbar">
      <div className="topbar-copy">
        <h1>AI Assistant for Kanban</h1>
        <p>
          Keep projects moving with contextual AI support.
          {isAuthenticated
            ? ` Signed in as ${currentUser}.`
            : " Sign in to access chat features."}
        </p>
      </div>
      <div className="auth-controls">
        {!isAuthenticated ? (
          <>
            <button className="btn-secondary" onClick={onRegister} disabled={loading}>
              Register
            </button>
            <button className="btn-primary" onClick={onLogin} disabled={loading}>
              Sign In
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={onCreateChat} disabled={loading}>
            New Chat
          </button>
        )}
      </div>
    </header>
  );
}

export default TopBar;
