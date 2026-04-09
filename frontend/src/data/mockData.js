export const columns = [
  {
    id: "todo",
    title: "К выполнению",
    tasks: [
      { id: "T-101", title: "Подключить Jira API", assignee: "Алекс", due: "06 апр" },
      { id: "T-102", title: "Подготовить промпт для семантического поиска", assignee: "Мария", due: "05 апр" }
    ]
  },
  {
    id: "in-progress",
    title: "В работе",
    tasks: [
      { id: "T-201", title: "Сделать виджет ИИ-саммари", assignee: "Даниил", due: "04 апр" },
      { id: "T-202", title: "Реализовать генератор чек-листов", assignee: "Nexxa", due: "07 апр" }
    ]
  },
  {
    id: "done",
    title: "Готово",
    tasks: [
      { id: "T-301", title: "Определить границы MVP", assignee: "Команда", due: "01 апр" }
    ]
  }
];
