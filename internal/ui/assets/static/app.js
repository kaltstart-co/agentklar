(() => {
  "use strict";

  const toast = document.querySelector("[data-toast]");
  const projectID = document.documentElement.dataset.project;
  const human = document.documentElement.dataset.human === "true";

  function notify(message, error = false) {
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show${error ? " error" : ""}`;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => { toast.className = "toast"; }, 3600);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { "Accept": "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || payload.error || `Request failed (${response.status})`);
    return payload;
  }

  const rail = document.querySelector("[data-rail]");
  const navToggle = document.querySelector("[data-nav-toggle]");
  navToggle?.addEventListener("click", () => {
    const open = rail.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close primary navigation" : "Open primary navigation");
  });

  document.querySelector("[data-project-switcher]")?.addEventListener("change", (event) => {
    location.assign(`/projects/${encodeURIComponent(event.target.value)}/board`);
  });

  document.querySelectorAll("[data-open-dialog]").forEach(button => button.addEventListener("click", () => {
    document.getElementById(button.dataset.openDialog)?.showModal();
  }));
  document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  }));

  document.querySelectorAll("[data-tabs]").forEach(tabs => {
    const buttons = [...tabs.querySelectorAll('[role="tab"]')];
    buttons.forEach(button => button.addEventListener("click", () => {
      buttons.forEach(item => {
        const selected = item === button;
        item.setAttribute("aria-selected", String(selected));
        document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
      });
      button.focus();
    }));
  });

  function values(form) {
    const data = Object.fromEntries(new FormData(form));
    data.criteria = (data.criteria || "").split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    data.labels = (data.labels || "").split(",").map(v => v.trim()).filter(Boolean);
    data.dependencies = [...form.querySelectorAll('[name="dependencies"] option:checked')].map(option => option.value);
    return data;
  }

  document.querySelectorAll("[data-task-form]").forEach(form => form.addEventListener("submit", async event => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const body = values(form);
    const dependencies = body.dependencies;
    delete body.dependencies;
    try {
      const task = await api(form.dataset.api, { method: form.dataset.method || "POST", body: JSON.stringify(body) });
      const id = task.Task?.ID || task.ID || body.id;
      if (form.querySelector('[name="dependencies"]')) await api(`/api/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(id)}/dependencies`, { method: "PUT", body: JSON.stringify({ dependencies }) });
      notify("Task saved. Reloading authoritative state.");
      location.assign(`/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(id)}`);
    } catch (error) { notify(error.message, true); }
  }));
  document.querySelectorAll("[data-deps-api]").forEach(async form => {
    try {
      const result = await api(form.dataset.depsApi);
      const selected = new Set(result.dependencies || []);
      form.querySelectorAll('[name="dependencies"] option').forEach(option => { option.selected = selected.has(option.value); });
    } catch (_) { /* The detail page still renders when derived controls are unavailable. */ }
  });

  const cards = [...document.querySelectorAll(".task-card")];
  const filters = [...document.querySelectorAll("[data-filter]")];
  function applyFilters() {
    const by = Object.fromEntries(filters.map(input => [input.dataset.filter, input.value.trim().toLowerCase()]));
    cards.forEach(card => {
      const text = `${card.dataset.taskId} ${card.querySelector(".task-title")?.textContent}`.toLowerCase();
      card.classList.toggle("hidden", !!(
        (by.search && !text.includes(by.search)) ||
        (by.assignee && !card.dataset.assignee.toLowerCase().includes(by.assignee)) ||
        (by.priority && card.dataset.priority !== by.priority) ||
        (by.label && !card.dataset.labels.toLowerCase().includes(by.label))
      ));
    });
  }
  filters.forEach(input => input.addEventListener("input", applyFilters));
  document.querySelector("[data-clear-filters]")?.addEventListener("click", () => { filters.forEach(input => { input.value = ""; }); applyFilters(); });

  async function moveTask(id, state) {
    await api(`/api/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(id)}/transition`, { method: "POST", body: JSON.stringify({ state }) });
    notify("Task moved. Reloading authoritative state.");
    location.reload();
  }
  document.querySelectorAll("[data-move-task]").forEach(select => select.addEventListener("change", async () => {
    if (!select.value) return;
    try { await moveTask(select.dataset.moveTask, select.value); } catch (error) { notify(error.message, true); select.value = ""; location.reload(); }
  }));

  let dragged = null;
  cards.forEach(card => {
    card.addEventListener("dragstart", () => { dragged = card; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); dragged = null; });
  });
  document.querySelectorAll("[data-dropzone]").forEach(zone => {
    zone.addEventListener("dragover", event => {
      if (!dragged) return;
      event.preventDefault();
      const next = [...zone.querySelectorAll(".task-card:not(.dragging)")].find(card => event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2);
      zone.insertBefore(dragged, next || null);
    });
    zone.addEventListener("drop", async event => {
      event.preventDefault();
      if (!dragged) return;
      const id = dragged.dataset.taskId;
      const state = zone.dataset.dropzone;
      try {
        if (dragged.dataset.state !== state) await api(`/api/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(id)}/transition`, { method: "POST", body: JSON.stringify({ state }) });
        const orderedIds = [...zone.querySelectorAll(".task-card")].map(card => card.dataset.taskId);
        await api(`/api/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(id)}/position`, { method: "POST", body: JSON.stringify({ state, ordered_ids: orderedIds }) });
        notify("Order saved. Reloading authoritative state.");
      } catch (error) { notify(error.message, true); }
      location.reload();
    });
  });

  document.querySelectorAll("[data-comment-form]").forEach(form => form.addEventListener("submit", async event => {
    event.preventDefault();
    try { await api(form.dataset.api, { method: "POST", body: JSON.stringify({ body: new FormData(form).get("body"), type: "note" }) }); location.reload(); }
    catch (error) { notify(error.message, true); }
  }));

  document.querySelectorAll("[data-request-changes]").forEach(button => button.addEventListener("click", async () => {
    const reason = prompt("What must change before approval?");
    if (!reason?.trim()) return;
    const pid = button.dataset.project || projectID;
    try { await api(`/api/projects/${encodeURIComponent(pid)}/tasks/${encodeURIComponent(button.dataset.requestChanges)}/request-changes`, { method: "POST", body: JSON.stringify({ reason }) }); location.reload(); }
    catch (error) { notify(error.message, true); }
  }));

  document.querySelectorAll("[data-archive-task]").forEach(button => button.addEventListener("click", async () => {
    if (!confirm("Archive this task from the active board?")) return;
    try { await api(`/api/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(button.dataset.archiveTask)}/archive`, { method: "POST" }); location.assign(`/projects/${encodeURIComponent(projectID)}/board`); }
    catch (error) { notify(error.message, true); }
  }));

  document.querySelectorAll("[data-forget-memory]").forEach(button => button.addEventListener("click", async () => {
    if (!confirm("Forget this memory and remove it from context search?")) return;
    try { await api(`/api/projects/${encodeURIComponent(projectID)}/memory/${encodeURIComponent(button.dataset.forgetMemory)}`, { method: "DELETE" }); button.closest("article").remove(); notify("Memory forgotten and context projection removed."); }
    catch (error) { notify(error.message, true); }
  }));

  document.querySelector("[data-context-reindex]")?.addEventListener("click", async event => {
    event.target.disabled = true;
    try { const result = await api(event.target.dataset.api, { method: "POST" }); notify(`Index ${result.status}: ${result.documents} documents, ${result.code_files} code files.`); location.reload(); }
    catch (error) { notify(error.message, true); event.target.disabled = false; }
  });

  if (!human) document.querySelectorAll("[data-task-form], [data-comment-form]").forEach(form => form.setAttribute("aria-disabled", "true"));
})();
