import { columns } from "../data/mockData";

function KanbanBoard() {
  return (
    <section className="board-wrapper">
      <div className="board-header">
        <h2>Доска проекта</h2>
        <button className="btn-secondary">Суммаризировать спринт</button>
      </div>

      <div className="kanban-grid">
        {columns.map((column) => (
          <article key={column.id} className="column-card">
            <h3>{column.title}</h3>
            <div className="task-list">
              {column.tasks.map((task) => (
                <div key={task.id} className="task-card">
                  <p className="task-title">{task.title}</p>
                  <div className="task-meta">
                    <span>{task.id}</span>
                    <span>{task.assignee}</span>
                    <span className="deadline">{task.due}</span>
                  </div>
                  <button className="btn-ai-inline">Разбить задачу</button>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default KanbanBoard;
