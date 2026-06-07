const ICON_URL = "/homekit_preview_static/icon.svg";
const FILTER_KEYS = [
  "include_domains",
  "include_entities",
  "include_entity_globs",
  "exclude_domains",
  "exclude_entities",
  "exclude_entity_globs",
];

class HomeKitPreviewPanel extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._data = this._data || null;
    this._selected = this._selected || "";
    this._loading = false;
    this._loadedOnce = false;
    this._error = "";
    this._search = this._search || "";
    this._domainFilter = this._domainFilter || "";
    this._activeTab = this._activeTab || "preview";
    this._builderView = this._builderView || "all";
    this._drafts = this._drafts || {};
    this.render();
    this.maybeLoad();
  }

  set hass(hass) {
    this._hass = hass;
    this.maybeLoad();
  }

  maybeLoad() {
    if (this._hass && !this._loadedOnce && !this._loading) this.loadData(false);
  }

  async loadData(scan) {
    if (!this._hass) return;
    this._loading = true;
    this._error = "";
    this.render();
    try {
      const data = scan
        ? await this._hass.callApi("POST", "homekit_preview/scan")
        : await this._hass.callApi("GET", "homekit_preview/preview");
      this._data = data || {};
      this._loadedOnce = true;
      const entries = this._data.entries || [];
      if (!this._selected && entries.length) this._selected = entries[0].entry_id;
      if (entries.length && !entries.some((entry) => entry.entry_id === this._selected)) {
        this._selected = entries[0].entry_id;
      }
    } catch (err) {
      this._error = err?.message || String(err);
      this._loadedOnce = true;
    } finally {
      this._loading = false;
      this.render();
    }
  }

  selectedEntry() {
    const entries = this._data?.entries || [];
    return entries.find((entry) => entry.entry_id === this._selected) || entries[0] || null;
  }

  normalizeFilter(filter) {
    const normalized = {};
    for (const key of FILTER_KEYS) {
      normalized[key] = [...new Set((filter?.[key] || []).map((value) => String(value)).filter(Boolean))].sort();
    }
    return normalized;
  }

  liveFilter(entry) {
    return this.normalizeFilter(entry?.filter || {
      include_domains: entry?.include_domains || [],
      include_entities: entry?.include_entities || [],
      include_entity_globs: entry?.include_entity_globs || [],
      exclude_domains: entry?.exclude_domains || [],
      exclude_entities: entry?.exclude_entities || [],
      exclude_entity_globs: entry?.exclude_entity_globs || [],
    });
  }

  ensureDraft(entry) {
    if (!entry) return this.normalizeFilter({});
    if (!this._drafts[entry.entry_id]) {
      this._drafts[entry.entry_id] = this.liveFilter(entry);
    }
    return this._drafts[entry.entry_id];
  }

  setDraft(entry, draft) {
    this._drafts[entry.entry_id] = this.normalizeFilter(draft);
  }

  globMatch(value, pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`).test(value);
  }

  matchesAnyGlob(value, globs) {
    return (globs || []).some((pattern) => this.globMatch(value, pattern));
  }

  draftIncludes(entity, draft) {
    const haveIncludes = Boolean(
      draft.include_domains.length || draft.include_entities.length || draft.include_entity_globs.length
    );
    const included = !haveIncludes
      || draft.include_entities.includes(entity.entity_id)
      || draft.include_domains.includes(entity.domain)
      || this.matchesAnyGlob(entity.entity_id, draft.include_entity_globs);
    const excluded = draft.exclude_entities.includes(entity.entity_id)
      || draft.exclude_domains.includes(entity.domain)
      || this.matchesAnyGlob(entity.entity_id, draft.exclude_entity_globs);
    return included && !excluded;
  }

  draftReason(entity, draft) {
    if (draft.exclude_entities.includes(entity.entity_id)) return "excluded entity";
    if (draft.exclude_domains.includes(entity.domain)) return "excluded domain";
    if (this.matchesAnyGlob(entity.entity_id, draft.exclude_entity_globs)) return "excluded glob";
    if (draft.include_entities.includes(entity.entity_id)) return "explicit entity";
    if (this.matchesAnyGlob(entity.entity_id, draft.include_entity_globs)) return "include glob";
    if (draft.include_domains.includes(entity.domain)) return "domain-wide include";
    if (!(draft.include_domains.length || draft.include_entities.length || draft.include_entity_globs.length)) return "no include filter";
    return "not included";
  }

  candidatesFor(entry) {
    return entry?.candidate_entities || entry?.exposed_entities || [];
  }

  draftStats(entry) {
    const draft = this.ensureDraft(entry);
    const candidates = this.candidatesFor(entry);
    const live = new Set(candidates.filter((entity) => entity.currently_exposed).map((entity) => entity.entity_id));
    const drafted = new Set(candidates.filter((entity) => this.draftIncludes(entity, draft)).map((entity) => entity.entity_id));
    let added = 0;
    let removed = 0;
    for (const entityId of drafted) if (!live.has(entityId)) added += 1;
    for (const entityId of live) if (!drafted.has(entityId)) removed += 1;
    return { live: live.size, draft: drafted.size, added, removed, changed: added + removed };
  }

  filteredEntities(entry) {
    const exposed = entry?.exposed_entities || [];
    const q = this._search.trim().toLowerCase();
    return exposed.filter((entity) => this.rowMatches(entity, q));
  }

  filteredBuilderRows(entry) {
    const draft = this.ensureDraft(entry);
    const q = this._search.trim().toLowerCase();
    return this.candidatesFor(entry).filter((entity) => {
      if (!this.rowMatches(entity, q)) return false;
      const live = Boolean(entity.currently_exposed);
      const drafted = this.draftIncludes(entity, draft);
      const explicit = draft.include_entities.includes(entity.entity_id) || draft.exclude_entities.includes(entity.entity_id);
      const domainWide = draft.include_domains.includes(entity.domain) || entry.include_domains?.includes(entity.domain);
      if (this._builderView === "live") return live;
      if (this._builderView === "draft") return drafted;
      if (this._builderView === "changed") return live !== drafted;
      if (this._builderView === "explicit") return explicit;
      if (this._builderView === "domainwide") return domainWide;
      return true;
    });
  }

  rowMatches(entity, q) {
    if (this._domainFilter && entity.domain !== this._domainFilter) return false;
    if (!q) return true;
    return [entity.entity_id, entity.name, entity.domain, entity.area, entity.device, entity.state, entity.inclusion_reason]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  }

  domainsFor(entry) {
    const counts = entry?.candidate_domain_counts || entry?.domain_counts || {};
    return Object.keys(counts).sort();
  }

  toggleValue(list, value, force) {
    const set = new Set(list || []);
    if (force === true) set.add(value);
    else if (force === false) set.delete(value);
    else if (set.has(value)) set.delete(value);
    else set.add(value);
    return [...set].sort();
  }

  entityAction(entry, action, entityId) {
    const draft = { ...this.ensureDraft(entry) };
    if (action === "include") {
      draft.include_entities = this.toggleValue(draft.include_entities, entityId, true);
      draft.exclude_entities = this.toggleValue(draft.exclude_entities, entityId, false);
    } else if (action === "exclude") {
      draft.exclude_entities = this.toggleValue(draft.exclude_entities, entityId, true);
      draft.include_entities = this.toggleValue(draft.include_entities, entityId, false);
    } else if (action === "clear") {
      draft.include_entities = this.toggleValue(draft.include_entities, entityId, false);
      draft.exclude_entities = this.toggleValue(draft.exclude_entities, entityId, false);
    }
    this.setDraft(entry, draft);
    this.render();
  }

  domainAction(entry, action, domain) {
    const draft = { ...this.ensureDraft(entry) };
    if (action === "include") {
      draft.include_domains = this.toggleValue(draft.include_domains, domain, true);
      draft.exclude_domains = this.toggleValue(draft.exclude_domains, domain, false);
    } else if (action === "exclude") {
      draft.exclude_domains = this.toggleValue(draft.exclude_domains, domain, true);
      draft.include_domains = this.toggleValue(draft.include_domains, domain, false);
    } else if (action === "clear") {
      draft.include_domains = this.toggleValue(draft.include_domains, domain, false);
      draft.exclude_domains = this.toggleValue(draft.exclude_domains, domain, false);
    }
    this.setDraft(entry, draft);
    this.render();
  }

  makeExactFromLive(entry) {
    const liveEntities = this.candidatesFor(entry)
      .filter((entity) => entity.currently_exposed)
      .map((entity) => entity.entity_id)
      .sort();
    this.setDraft(entry, {
      include_domains: [],
      include_entities: liveEntities,
      include_entity_globs: [],
      exclude_domains: [],
      exclude_entities: [],
      exclude_entity_globs: [],
    });
    this.render();
  }

  resetDraft(entry) {
    delete this._drafts[entry.entry_id];
    this.ensureDraft(entry);
    this.render();
  }

  async copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      this._error = `${label} copied to clipboard.`;
    } catch (err) {
      this._error = `Copy failed: ${err?.message || err}`;
    }
    this.render();
  }

  copyDraft(entry) {
    this.copyText(JSON.stringify({ filter: this.ensureDraft(entry) }, null, 2), "Draft filter");
  }

  copyDraftEntities(entry) {
    const draft = this.ensureDraft(entry);
    const entities = this.candidatesFor(entry)
      .filter((entity) => this.draftIncludes(entity, draft))
      .map((entity) => entity.entity_id)
      .join("\n");
    this.copyText(entities, "Draft entity list");
  }

  render() {
    if (!this.shadowRoot) return;
    const data = this._data || {};
    const entries = data.entries || [];
    const entry = this.selectedEntry();
    const warnings = data.warnings || [];
    const filtered = this.filteredEntities(entry);
    const builderRows = this.filteredBuilderRows(entry);
    const domains = this.domainsFor(entry);
    const domainWideCount = entry?.domain_wide_include_count || 0;
    const stats = entry ? this.draftStats(entry) : { live: 0, draft: 0, added: 0, removed: 0, changed: 0 };

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 24px; box-sizing: border-box; color: var(--primary-text-color); }
        .wrap { max-width: 1360px; margin: 0 auto; }
        .top { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:16px; }
        .titleRow { display:flex; align-items:center; gap:12px; }
        .appIcon { width:44px; height:44px; border-radius:14px; display:block; box-shadow: var(--ha-card-box-shadow, none); }
        h1 { margin:0; font-size:28px; font-weight:700; }
        .sub { color: var(--secondary-text-color); margin-top:6px; }
        .controls, .toolbarLeft, .toolbarRight { display:flex; align-items:center; justify-content:flex-end; gap:12px; flex-wrap:wrap; }
        select, input, button { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); min-height: 42px; box-sizing: border-box; }
        input { min-width: 260px; }
        button { cursor:pointer; background: var(--primary-color); color: var(--text-primary-color); border-color: var(--primary-color); font-weight:700; }
        button.secondary { background: var(--card-background-color); color: var(--primary-text-color); border-color: var(--divider-color); }
        button.danger { background: var(--error-color, #db4437); border-color: var(--error-color, #db4437); color: var(--text-primary-color); }
        button[disabled] { opacity:.6; cursor:wait; }
        .tabs, .pills { display:flex; gap:8px; flex-wrap:wrap; margin: 12px 0; }
        .tab, .pill, .miniBtn { background: var(--card-background-color); color: var(--primary-text-color); border:1px solid var(--divider-color); border-radius:999px; min-height:unset; padding:7px 10px; font-size:13px; }
        .tab.active, .pill.active { background: var(--primary-color); color: var(--text-primary-color); border-color: var(--primary-color); }
        .miniBtn { padding:4px 8px; font-size:12px; }
        .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:12px; margin:16px 0; }
        .card { background: var(--card-background-color); border:1px solid var(--divider-color); border-radius:16px; padding:16px; box-shadow: var(--ha-card-box-shadow, none); }
        .num { font-size:28px; font-weight:800; line-height:1.1; overflow-wrap:anywhere; }
        .label { color: var(--secondary-text-color); font-size:13px; margin-top:4px; }
        .warn { border-left: 4px solid var(--warning-color, #ffa600); }
        .error { border-left: 4px solid var(--error-color, #db4437); }
        .sectionTitle { font-size:18px; font-weight:750; margin: 22px 0 8px; }
        .chips { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
        .chip { font-size:12px; padding:5px 8px; border-radius:999px; background: var(--secondary-background-color); border:1px solid var(--divider-color); }
        .warnChip { border-color: var(--warning-color, #ffa600); background: color-mix(in srgb, var(--warning-color, #ffa600) 18%, var(--card-background-color)); }
        .domainHint { margin-top:14px; padding:14px; border-radius:14px; background: color-mix(in srgb, var(--warning-color, #ffa600) 12%, var(--card-background-color)); border:1px solid color-mix(in srgb, var(--warning-color, #ffa600) 45%, var(--divider-color)); }
        .domainHintTitle { font-weight:800; margin-bottom:6px; }
        .domainHintBody { color: var(--primary-text-color); line-height:1.45; }
        .domainGrid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:10px; margin-top:12px; }
        .domainCard { border:1px solid var(--divider-color); border-radius:14px; padding:12px; background: var(--secondary-background-color); }
        .domainCard.activeInclude { border-color: var(--primary-color); }
        .domainCard.activeExclude { border-color: var(--error-color, #db4437); }
        .tableWrap { overflow:auto; border-radius:16px; border:1px solid var(--divider-color); background: var(--card-background-color); }
        table { width:100%; border-collapse: collapse; min-width: 1040px; }
        th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--divider-color); vertical-align:top; }
        th { font-size:12px; text-transform:uppercase; color: var(--secondary-text-color); background: var(--secondary-background-color); letter-spacing:.04em; position: sticky; top: 0; z-index: 1; }
        tr:last-child td { border-bottom:0; }
        tr.rowAdd td { background: color-mix(in srgb, var(--success-color, #0b8043) 10%, transparent); }
        tr.rowRemove td { background: color-mix(in srgb, var(--error-color, #db4437) 10%, transparent); }
        code, pre { background: var(--secondary-background-color); padding: 2px 5px; border-radius: 6px; }
        pre { padding:16px; overflow:auto; white-space:pre-wrap; }
        .muted { color: var(--secondary-text-color); }
        .good { color: var(--success-color, #0b8043); font-weight:700; }
        .bad { color: var(--error-color, #db4437); font-weight:700; }
        .reasonWarn { color: var(--warning-color, #ffa600); font-weight:800; }
        .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin: 16px 0; align-items:center; justify-content:space-between; }
        .empty { padding: 24px; text-align:center; }
        ul { margin-bottom:0; }
      </style>
      <div class="wrap">
        <div class="top">
          <div class="titleRow">
            <img class="appIcon" src="${ICON_URL}" alt="">
            <div>
              <h1>HomeKit Preview</h1>
              <div class="sub">See exactly what each Home Assistant HomeKit entry is configured to expose.</div>
            </div>
          </div>
          <div class="controls">
            <select id="bridgeSelect" aria-label="HomeKit bridge or accessory">
              ${entries.map((item) => `<option value="${this.escape(item.entry_id)}" ${item.entry_id === this._selected ? "selected" : ""}>${this.escape(item.title || "HomeKit entry")} · ${this.escape(item.port || "unknown port")}</option>`).join("")}
            </select>
            <button id="refresh" ${this._loading ? "disabled" : ""}>${this._loading ? "Scanning..." : "Scan / Refresh"}</button>
          </div>
        </div>

        <div class="tabs">
          <button class="tab ${this._activeTab === "preview" ? "active" : ""}" data-tab="preview">Preview</button>
          <button class="tab ${this._activeTab === "builder" ? "active" : ""}" data-tab="builder">Filter Builder</button>
          <button class="tab ${this._activeTab === "raw" ? "active" : ""}" data-tab="raw">Raw</button>
        </div>

        ${this._error ? `<div class="card ${this._error.includes("copied") ? "" : "error"}"><b>${this.escape(this._error)}</b></div>` : ""}
        ${warnings.length ? `<div class="card warn"><b>Warnings</b><ul>${warnings.map((warning) => `<li>${this.escape(warning)}</li>`).join("")}</ul></div>` : ""}

        <div class="cards">
          <div class="card"><div class="num">${data.entry_count ?? 0}</div><div class="label">HomeKit entries</div></div>
          <div class="card"><div class="num">${data.total_exposed ?? 0}</div><div class="label">Total exposed now</div></div>
          <div class="card"><div class="num">${entry?.exposed_count ?? 0}</div><div class="label">Selected exposes</div></div>
          <div class="card ${domainWideCount ? "warn" : ""}"><div class="num">${domainWideCount}</div><div class="label">Whole-domain includes</div></div>
          <div class="card"><div class="num good">${entry?.available_count ?? 0}</div><div class="label">Available</div></div>
          <div class="card"><div class="num bad">${entry?.unavailable_count ?? 0}</div><div class="label">Unavailable/unknown</div></div>
          <div class="card"><div class="num">${entry?.mode ? this.escape(entry.mode) : "—"}</div><div class="label">Mode</div></div>
        </div>

        ${entry ? (
          this._activeTab === "builder" ? this.renderBuilder(entry, builderRows, domains, stats)
          : this._activeTab === "raw" ? this.renderRaw(entry)
          : this.renderPreview(entry, filtered, domains)
        ) : `<div class="card empty">No HomeKit entries found. Configure HomeKit Bridge first, then hit Scan / Refresh.</div>`}
      </div>
    `;

    this.bindEvents(entry);
  }

  bindEvents(entry) {
    this.shadowRoot.getElementById("refresh")?.addEventListener("click", () => this.loadData(true));
    this.shadowRoot.getElementById("bridgeSelect")?.addEventListener("change", (ev) => {
      this._selected = ev.target.value;
      this._domainFilter = "";
      this.render();
    });
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
      this._activeTab = button.dataset.tab;
      this.render();
    }));
    this.shadowRoot.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
      this._builderView = button.dataset.view;
      this.render();
    }));
    this.shadowRoot.getElementById("entitySearch")?.addEventListener("input", (ev) => {
      this._search = ev.target.value;
      this.render();
    });
    this.shadowRoot.getElementById("domainFilter")?.addEventListener("change", (ev) => {
      this._domainFilter = ev.target.value;
      this.render();
    });
    this.shadowRoot.querySelectorAll("[data-entity-action]").forEach((button) => button.addEventListener("click", () => {
      this.entityAction(entry, button.dataset.entityAction, button.dataset.entity);
    }));
    this.shadowRoot.querySelectorAll("[data-domain-action]").forEach((button) => button.addEventListener("click", () => {
      this.domainAction(entry, button.dataset.domainAction, button.dataset.domain);
    }));
    this.shadowRoot.getElementById("makeExact")?.addEventListener("click", () => this.makeExactFromLive(entry));
    this.shadowRoot.getElementById("resetDraft")?.addEventListener("click", () => this.resetDraft(entry));
    this.shadowRoot.getElementById("copyDraft")?.addEventListener("click", () => this.copyDraft(entry));
    this.shadowRoot.getElementById("copyDraftEntities")?.addEventListener("click", () => this.copyDraftEntities(entry));
  }

  renderPreview(entry, filtered, domains) {
    const filters = [
      ["Include domains", entry.include_domains],
      ["Include entities", entry.include_entities],
      ["Include globs", entry.include_entity_globs],
      ["Exclude domains", entry.exclude_domains],
      ["Exclude entities", entry.exclude_entities],
      ["Exclude globs", entry.exclude_entity_globs],
    ].filter(([, values]) => values && values.length);

    const domainWideIncludes = entry.domain_wide_includes || [];
    const domainWideDomains = new Set(domainWideIncludes.map((item) => item.domain));
    const domainChips = Object.entries(entry.domain_counts || {})
      .map(([domain, count]) => `<span class="chip ${domainWideDomains.has(domain) ? "warnChip" : ""}"><b>${this.escape(domain)}</b>: ${count}${domainWideDomains.has(domain) ? " · ALL" : ""}</span>`)
      .join("");

    return `
      <div class="card">
        <div class="sectionTitle" style="margin-top:0;">${this.escape(entry.title || "HomeKit entry")}</div>
        <div class="muted">Port: <code>${this.escape(entry.port || "unknown")}</code> · Mode: <code>${this.escape(entry.mode || "unknown")}</code></div>
        <div class="chips">
          ${filters.length ? filters.map(([label, values]) => `<span class="chip"><b>${label}:</b> ${values.map((value) => this.escape(value)).join(", ")}</span>`).join("") : `<span class="chip">No explicit filters found</span>`}
        </div>
        ${domainChips ? `<div class="chips">${domainChips}</div>` : ""}
        ${this.renderDomainWideIncludes(domainWideIncludes)}
      </div>

      ${this.renderEntityToolbar(filtered.length, entry.exposed_count || 0, domains)}
      ${this.renderEntityTable(filtered, true)}
    `;
  }

  renderEntityToolbar(shown, total, domains) {
    return `
      <div class="toolbar">
        <div class="toolbarLeft">
          <div class="sectionTitle" style="margin:0;">Entities Apple Home will probably see</div>
          <span class="muted">Showing ${shown} of ${total}</span>
        </div>
        <div class="toolbarRight">
          <input id="entitySearch" placeholder="Search entity, name, area, device..." value="${this.escape(this._search)}" />
          <select id="domainFilter" aria-label="Filter by domain">
            <option value="">All domains</option>
            ${domains.map((domain) => `<option value="${this.escape(domain)}" ${domain === this._domainFilter ? "selected" : ""}>${this.escape(domain)}</option>`).join("")}
          </select>
        </div>
      </div>
    `;
  }

  renderEntityTable(rows, previewMode) {
    if (!rows.length) return `<div class="card warn">No entities match the current search/filter for this HomeKit entry.</div>`;
    return `
      <div class="tableWrap">
        <table>
          <thead><tr><th>Entity</th><th>Name</th><th>Domain</th><th>Area</th><th>Device</th><th>State</th><th>Available</th><th>Why included</th>${previewMode ? "" : "<th>Live</th><th>Draft</th><th>Actions</th>"}</tr></thead>
          <tbody>${rows.map((entity) => this.renderEntityRow(entity, previewMode)).join("")}</tbody>
        </table>
      </div>
    `;
  }

  renderEntityRow(entity, previewMode) {
    const entry = this.selectedEntry();
    const draft = this.ensureDraft(entry);
    const live = Boolean(entity.currently_exposed);
    const drafted = this.draftIncludes(entity, draft);
    const rowClass = !previewMode && drafted && !live ? "rowAdd" : !previewMode && live && !drafted ? "rowRemove" : "";
    const why = previewMode ? entity.inclusion_reason : this.draftReason(entity, draft);
    return `
      <tr class="${rowClass}">
        <td><code>${this.escape(entity.entity_id)}</code></td>
        <td>${this.escape(entity.name || "")}</td>
        <td>${this.escape(entity.domain || "")}</td>
        <td>${this.escape(entity.area || "")}</td>
        <td>${this.escape(entity.device || "")}</td>
        <td><code>${this.escape(entity.state || "")}</code></td>
        <td class="${entity.available ? "good" : "bad"}">${entity.available ? "yes" : "no"}</td>
        <td class="${why === "domain-wide include" ? "reasonWarn" : ""}">${this.escape(why || "")}</td>
        ${previewMode ? "" : `<td>${live ? "yes" : "no"}</td><td>${drafted ? "yes" : "no"}</td><td><button class="miniBtn" data-entity-action="include" data-entity="${this.escape(entity.entity_id)}">+ include</button> <button class="miniBtn" data-entity-action="exclude" data-entity="${this.escape(entity.entity_id)}">− exclude</button> <button class="miniBtn" data-entity-action="clear" data-entity="${this.escape(entity.entity_id)}">clear</button></td>`}
      </tr>
    `;
  }

  renderBuilder(entry, rows, domains, stats) {
    const draft = this.ensureDraft(entry);
    return `
      <div class="card warn">
        <div class="sectionTitle" style="margin-top:0;">Filter Builder</div>
        <div class="muted">Sandbox mode: click around, make a draft, then copy the filter or entity list. It does not write to Home Assistant by itself.</div>
        <div class="controls" style="justify-content:flex-start; margin-top:12px;">
          <button id="makeExact">Make exact from live preview</button>
          <button id="resetDraft" class="secondary">Reset draft</button>
          <button id="copyDraft" class="secondary">Copy draft filter</button>
          <button id="copyDraftEntities" class="secondary">Copy draft entity list</button>
        </div>
      </div>

      <div class="cards">
        <div class="card"><div class="num">${entry.candidate_count ?? this.candidatesFor(entry).length}</div><div class="label">Browsable candidates</div></div>
        <div class="card"><div class="num">${stats.live}</div><div class="label">Live exposes</div></div>
        <div class="card"><div class="num">${stats.draft}</div><div class="label">Draft exposes</div></div>
        <div class="card"><div class="num good">${stats.added}</div><div class="label">Would add</div></div>
        <div class="card"><div class="num bad">${stats.removed}</div><div class="label">Would remove</div></div>
        <div class="card"><div class="num">${draft.include_domains.length}</div><div class="label">Include domains</div></div>
        <div class="card"><div class="num">${draft.include_entities.length}</div><div class="label">Include entities</div></div>
        <div class="card"><div class="num">${draft.exclude_domains.length + draft.exclude_entities.length}</div><div class="label">Exclusions</div></div>
      </div>

      <div class="pills">
        ${[["all", "All candidates"], ["live", "Live exposed"], ["draft", "Draft exposed"], ["changed", "Changed"], ["explicit", "Explicit picks"], ["domainwide", "Domain-wide"]].map(([view, label]) => `<button class="pill ${this._builderView === view ? "active" : ""}" data-view="${view}">${label}</button>`).join("")}
      </div>

      ${this.renderDomainBrowser(entry, domains)}
      ${this.renderEntityToolbar(rows.length, this.candidatesFor(entry).length, domains)}
      ${this.renderEntityTable(rows, false)}
      ${entry.candidates_truncated ? `<p class="muted">Candidate list truncated at 1500; ${entry.candidates_truncated_count || 0} more candidates were counted but not listed.</p>` : ""}
    `;
  }

  renderDomainBrowser(entry, domains) {
    const draft = this.ensureDraft(entry);
    const counts = entry.candidate_domain_counts || entry.domain_counts || {};
    return `
      <div class="card">
        <div class="sectionTitle" style="margin-top:0;">Domain pills</div>
        <div class="muted">Include all means the entire domain. Exclude all overrides the domain. Clear removes the domain rule.</div>
        <div class="domainGrid">
          ${domains.map((domain) => {
            const include = draft.include_domains.includes(domain);
            const exclude = draft.exclude_domains.includes(domain);
            return `<div class="domainCard ${include ? "activeInclude" : ""} ${exclude ? "activeExclude" : ""}">
              <b>${this.escape(domain)}</b> <span class="muted">${counts[domain] || 0} candidates</span>
              <div class="chips">
                ${include ? `<span class="chip warnChip">including ALL</span>` : ""}
                ${exclude ? `<span class="chip">excluded</span>` : ""}
              </div>
              <div class="controls" style="justify-content:flex-start; margin-top:8px; gap:6px;">
                <button class="miniBtn" data-domain-action="include" data-domain="${this.escape(domain)}">include all</button>
                <button class="miniBtn" data-domain-action="exclude" data-domain="${this.escape(domain)}">exclude all</button>
                <button class="miniBtn" data-domain-action="clear" data-domain="${this.escape(domain)}">clear</button>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>
    `;
  }

  renderRaw(entry) {
    return `<div class="card"><div class="sectionTitle" style="margin-top:0;">Raw selected entry payload</div><pre>${this.escape(JSON.stringify(entry, null, 2))}</pre></div>`;
  }

  renderDomainWideIncludes(domainWideIncludes) {
    if (!domainWideIncludes.length) return "";
    return `
      <div class="domainHint">
        <div class="domainHintTitle">⚠ Whole-domain include active</div>
        <div class="domainHintBody">
          ${domainWideIncludes.map((item) => `<p><b>${this.escape(item.domain)}</b>: ${this.escape(item.message)}</p>`).join("")}
        </div>
      </div>
    `;
  }

  escape(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    }[char]));
  }
}

customElements.define("homekit-preview-panel", HomeKitPreviewPanel);
