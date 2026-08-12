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
  const mobileNav = matchMedia("(max-width: 840px)");
  function syncRail(open = rail?.classList.contains("open")) {
    if (!rail || !navToggle) return;
    if (!mobileNav.matches) {
      rail.classList.remove("open");
      rail.inert = false;
      rail.removeAttribute("inert");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "Open primary navigation");
      return;
    }
    rail.classList.toggle("open", !!open);
    rail.inert = !open;
    rail.toggleAttribute("inert", !open);
    navToggle.setAttribute("aria-expanded", String(!!open));
    navToggle.setAttribute("aria-label", open ? "Close primary navigation" : "Open primary navigation");
  }
  navToggle?.addEventListener("click", () => {
    syncRail(!rail.classList.contains("open"));
  });
  mobileNav.addEventListener?.("change", () => syncRail(false));
  syncRail(false);

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (rail?.classList.contains("open")) {
      syncRail(false);
      navToggle?.focus();
    }
    document.querySelector("dialog[open]")?.close();
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
    buttons.forEach((button, index) => {
      button.tabIndex = button.getAttribute("aria-selected") === "true" ? 0 : -1;
      button.addEventListener("click", () => {
        buttons.forEach(item => {
          const selected = item === button;
          item.setAttribute("aria-selected", String(selected));
          item.tabIndex = selected ? 0 : -1;
          document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
        });
        button.focus();
      });
      button.addEventListener("keydown", event => {
        let next = index;
        switch (event.key) {
          case "ArrowRight": next = (index + 1) % buttons.length; break;
          case "ArrowLeft": next = (index - 1 + buttons.length) % buttons.length; break;
          case "Home": next = 0; break;
          case "End": next = buttons.length - 1; break;
          default: return;
        }
        event.preventDefault();
        buttons[next].click();
      });
    });
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
	  try {
	    const task = await api(form.dataset.api, { method: form.dataset.method || "POST", body: JSON.stringify(body) });
	    const id = task.Task?.ID || task.ID || body.id;
	    notify("Task saved. Reloading authoritative state.");
	    location.assign(`/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(id)}`);
	  } catch (error) { notify(error.message, true); }
	}));

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

  function scheduleReload(delay = 900) {
    setTimeout(() => location.reload(), delay);
  }
  async function transitionTask(id, state) {
    return api(`/api/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(id)}/transition`, { method: "POST", body: JSON.stringify({ state }) });
  }
  async function reorderTask(id, state, orderedIds) {
    return api(`/api/projects/${encodeURIComponent(projectID)}/tasks/${encodeURIComponent(id)}/position`, { method: "POST", body: JSON.stringify({ state, ordered_ids: orderedIds }) });
  }
  async function moveTask(id, state) {
    await transitionTask(id, state);
    notify("Task moved. Reloading authoritative state.");
    scheduleReload();
  }
  document.querySelectorAll("[data-move-task]").forEach(select => select.addEventListener("change", async () => {
    if (!select.value) return;
    try { await moveTask(select.dataset.moveTask, select.value); } catch (error) { notify(error.message, true); select.value = ""; scheduleReload(1800); }
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
      const card = dragged;
      const id = card.dataset.taskId;
      const state = zone.dataset.dropzone;
      try {
        if (card.dataset.state !== state) {
          await transitionTask(id, state);
          notify("Task moved. Reloading authoritative state.");
        } else {
          const orderedIds = [...zone.querySelectorAll(".task-card")].map(item => item.dataset.taskId);
          await reorderTask(id, state, orderedIds);
          notify("Order saved. Reloading authoritative state.");
        }
        scheduleReload();
      } catch (error) {
        notify(error.message, true);
        scheduleReload(1800);
      }
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
