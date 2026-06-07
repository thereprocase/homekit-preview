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
    this.render();
    this.maybeLoad();
  }

  set hass(hass) {
    this._hass = hass;
    this.maybeLoad();
  }

  maybeLoad() {
    if (this._hass && !this._loadedOnce && !this._loading) {
      this.loadData(false);
    }
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

  filteredEntities(entry) {
    const exposed = entry?.exposed_entities || [];
    const q = this._search.trim().toLowerCase();
    return exposed.filter((entity) => {
      if (this._domainFilter && entity.domain !== this._domainFilter) return false;
      if (!q) return true;
      return [entity.entity_id, entity.name, entity.domain, entity.area, entity.device, entity.state]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }

  domainsFor(entry) {
    const counts = entry?.domain_counts || {};
    return Object.keys(counts).sort();
  }

  render() {
    if (!this.shadowRoot) return;
    const data = this._data || {};
    const entries = data.entries || [];
    const entry = this.selectedEntry();
    const warnings = data.warnings || [];
    const filtered = this.filteredEntities(entry);
    const domains = this.domainsFor(entry);

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 24px; box-sizing: border-box; color: var(--primary-text-color); }
        .wrap { max-width: 1280px; margin: 0 auto; }
        .top { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:16px; }
        .titleRow { display:flex; align-items:center; gap:12px; }
        .appIcon { width:44px; height:44px; border-radius:14px; background: var(--primary-color); display:grid; place-items:center; color: var(--text-primary-color); font-weight:800; box-shadow: var(--ha-card-box-shadow, none); }
        h1 { margin:0; font-size:28px; font-weight:700; }
        .sub { color: var(--secondary-text-color); margin-top:6px; }
        .controls { display:flex; align-items:center; justify-content:flex-end; gap:12px; flex-wrap:wrap; }
        select, input, button { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); min-height: 42px; box-sizing: border-box; }
        input { min-width: 260px; }
        button { cursor:pointer; background: var(--primary-color); color: var(--text-primary-color); border-color: var(--primary-color); font-weight:700; }
        button[disabled] { opacity:.6; cursor:wait; }
        .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px,1fr)); gap:12px; margin:16px 0; }
        .card { background: var(--card-background-color); border:1px solid var(--divider-color); border-radius:16px; padding:16px; box-shadow: var(--ha-card-box-shadow, none); }
        .num { font-size:28px; font-weight:800; line-height:1.1; overflow-wrap:anywhere; }
        .label { color: var(--secondary-text-color); font-size:13px; margin-top:4px; }
        .warn { border-left: 4px solid var(--warning-color, #ffa600); }
        .error { border-left: 4px solid var(--error-color, #db4437); }
        .sectionTitle { font-size:18px; font-weight:750; margin: 22px 0 8px; }
        .chips { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
        .chip { font-size:12px; padding:5px 8px; border-radius:999px; background: var(--secondary-background-color); border:1px solid var(--divider-color); }
        .tableWrap { overflow:auto; border-radius:16px; border:1px solid var(--divider-color); background: var(--card-background-color); }
        table { width:100%; border-collapse: collapse; min-width: 880px; }
        th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--divider-color); vertical-align:top; }
        th { font-size:12px; text-transform:uppercase; color: var(--secondary-text-color); background: var(--secondary-background-color); letter-spacing:.04em; position: sticky; top: 0; z-index: 1; }
        tr:last-child td { border-bottom:0; }
        code { background: var(--secondary-background-color); padding: 2px 5px; border-radius: 6px; }
        .muted { color: var(--secondary-text-color); }
        .good { color: var(--success-color, #0b8043); font-weight:700; }
        .bad { color: var(--error-color, #db4437); font-weight:700; }
        .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin: 16px 0; align-items:center; justify-content:space-between; }
        .toolbarLeft, .toolbarRight { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
        .empty { padding: 24px; text-align:center; }
        ul { margin-bottom:0; }
      </style>
      <div class="wrap">
        <div class="top">
          <div class="titleRow">
            <div class="appIcon">HK</div>
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

        ${this._error ? `<div class="card error"><b>Scan failed.</b><div class="muted">${this.escape(this._error)}</div><div class="muted">Check Settings → System → Logs for the HomeKit Preview traceback.</div></div>` : ""}
        ${warnings.length ? `<div class="card warn"><b>Warnings</b><ul>${warnings.map((warning) => `<li>${this.escape(warning)}</li>`).join("")}</ul></div>` : ""}

        <div class="cards">
          <div class="card"><div class="num">${data.entry_count ?? 0}</div><div class="label">HomeKit entries</div></div>
          <div class="card"><div class="num">${data.total_exposed ?? 0}</div><div class="label">Total exposed now</div></div>
          <div class="card"><div class="num">${entry?.exposed_count ?? 0}</div><div class="label">Selected exposes</div></div>
          <div class="card"><div class="num good">${entry?.available_count ?? 0}</div><div class="label">Available</div></div>
          <div class="card"><div class="num bad">${entry?.unavailable_count ?? 0}</div><div class="label">Unavailable/unknown</div></div>
          <div class="card"><div class="num">${entry?.mode ? this.escape(entry.mode) : "—"}</div><div class="label">Mode</div></div>
        </div>

        ${entry ? this.renderEntry(entry, filtered, domains) : `<div class="card empty">No HomeKit entries found. Configure HomeKit Bridge first, then hit Scan / Refresh.</div>`}
      </div>
    `;

    const btn = this.shadowRoot.getElementById("refresh");
    if (btn) btn.addEventListener("click", () => this.loadData(true));

    const select = this.shadowRoot.getElementById("bridgeSelect");
    if (select) select.addEventListener("change", (ev) => {
      this._selected = ev.target.value;
      this._domainFilter = "";
      this.render();
    });

    const search = this.shadowRoot.getElementById("entitySearch");
    if (search) search.addEventListener("input", (ev) => {
      this._search = ev.target.value;
      this.render();
    });

    const domain = this.shadowRoot.getElementById("domainFilter");
    if (domain) domain.addEventListener("change", (ev) => {
      this._domainFilter = ev.target.value;
      this.render();
    });
  }

  renderEntry(entry, filtered, domains) {
    const filters = [
      ["Include domains", entry.include_domains],
      ["Include entities", entry.include_entities],
      ["Include globs", entry.include_entity_globs],
      ["Exclude domains", entry.exclude_domains],
      ["Exclude entities", entry.exclude_entities],
      ["Exclude globs", entry.exclude_entity_globs],
    ].filter(([, values]) => values && values.length);

    const domainChips = Object.entries(entry.domain_counts || {})
      .map(([domain, count]) => `<span class="chip"><b>${this.escape(domain)}</b>: ${count}</span>`)
      .join("");

    return `
      <div class="card">
        <div class="sectionTitle" style="margin-top:0;">${this.escape(entry.title || "HomeKit entry")}</div>
        <div class="muted">Port: <code>${this.escape(entry.port || "unknown")}</code> · Mode: <code>${this.escape(entry.mode || "unknown")}</code></div>
        <div class="chips">
          ${filters.length ? filters.map(([label, values]) => `<span class="chip"><b>${label}:</b> ${values.map((value) => this.escape(value)).join(", ")}</span>`).join("") : `<span class="chip">No explicit filters found</span>`}
        </div>
        ${domainChips ? `<div class="chips">${domainChips}</div>` : ""}
      </div>

      <div class="toolbar">
        <div class="toolbarLeft">
          <div class="sectionTitle" style="margin:0;">Entities Apple Home will probably see</div>
          <span class="muted">Showing ${filtered.length} of ${entry.exposed_count || 0}</span>
        </div>
        <div class="toolbarRight">
          <input id="entitySearch" placeholder="Search entity, name, area, device..." value="${this.escape(this._search)}" />
          <select id="domainFilter" aria-label="Filter by domain">
            <option value="">All domains</option>
            ${domains.map((domain) => `<option value="${this.escape(domain)}" ${domain === this._domainFilter ? "selected" : ""}>${this.escape(domain)}</option>`).join("")}
          </select>
        </div>
      </div>

      ${filtered.length ? `
        <div class="tableWrap">
          <table>
            <thead><tr><th>Entity</th><th>Name</th><th>Domain</th><th>Area</th><th>Device</th><th>State</th><th>Available</th></tr></thead>
            <tbody>
              ${filtered.map((entity) => `
                <tr>
                  <td><code>${this.escape(entity.entity_id)}</code></td>
                  <td>${this.escape(entity.name || "")}</td>
                  <td>${this.escape(entity.domain || "")}</td>
                  <td>${this.escape(entity.area || "")}</td>
                  <td>${this.escape(entity.device || "")}</td>
                  <td><code>${this.escape(entity.state || "")}</code></td>
                  <td class="${entity.available ? "good" : "bad"}">${entity.available ? "yes" : "no"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        ${entry.truncated ? `<p class="muted">Backend response truncated at 500 entities for this entry; ${entry.truncated_count || 0} more were counted but not listed.</p>` : ""}
      ` : `<div class="card warn">No entities match the current search/filter for this HomeKit entry.</div>`}
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
