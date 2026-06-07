class HomeKitPreviewPanel extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" });
    this._data = null;
    this._selected = "";
    this._loading = false;
    this._error = "";
    this.render();
    this.loadData(false);
  }

  set hass(hass) {
    this._hass = hass;
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
      const entries = this._data.entries || [];
      if (!this._selected && entries.length) this._selected = entries[0].entry_id;
      if (entries.length && !entries.some((e) => e.entry_id === this._selected)) {
        this._selected = entries[0].entry_id;
      }
    } catch (err) {
      this._error = err?.message || String(err);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  selectedEntry() {
    const entries = this._data?.entries || [];
    return entries.find((e) => e.entry_id === this._selected) || entries[0] || null;
  }

  render() {
    if (!this.shadowRoot) return;
    const data = this._data || {};
    const entries = data.entries || [];
    const entry = this.selectedEntry();
    const warnings = data.warnings || [];

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 24px; box-sizing: border-box; color: var(--primary-text-color); }
        .wrap { max-width: 1200px; margin: 0 auto; }
        .top { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:16px; }
        h1 { margin:0; font-size:28px; font-weight:650; }
        .sub { color: var(--secondary-text-color); margin-top:6px; }
        .controls { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        select, button { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        button { cursor:pointer; background: var(--primary-color); color: var(--text-primary-color); border-color: var(--primary-color); font-weight:600; }
        button[disabled] { opacity:.6; cursor:wait; }
        .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:12px; margin:16px 0; }
        .card { background: var(--card-background-color); border:1px solid var(--divider-color); border-radius:16px; padding:16px; box-shadow: var(--ha-card-box-shadow, none); }
        .num { font-size:30px; font-weight:750; }
        .label { color: var(--secondary-text-color); font-size:13px; margin-top:4px; }
        .warn { border-left: 4px solid var(--warning-color, #ffa600); }
        .error { border-left: 4px solid var(--error-color, #db4437); }
        .sectionTitle { font-size:18px; font-weight:700; margin: 22px 0 8px; }
        .chips { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
        .chip { font-size:12px; padding:5px 8px; border-radius:999px; background: var(--secondary-background-color); border:1px solid var(--divider-color); }
        table { width:100%; border-collapse: collapse; background: var(--card-background-color); border-radius:16px; overflow:hidden; border:1px solid var(--divider-color); }
        th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--divider-color); vertical-align:top; }
        th { font-size:12px; text-transform:uppercase; color: var(--secondary-text-color); background: var(--secondary-background-color); letter-spacing:.04em; }
        tr:last-child td { border-bottom:0; }
        code { background: var(--secondary-background-color); padding: 2px 5px; border-radius: 6px; }
        .muted { color: var(--secondary-text-color); }
        .good { color: var(--success-color, #0b8043); font-weight:600; }
        .bad { color: var(--error-color, #db4437); font-weight:600; }
      </style>
      <div class="wrap">
        <div class="top">
          <div>
            <h1>HomeKit Preview</h1>
            <div class="sub">Preview what Home Assistant is probably exposing to Apple Home.</div>
          </div>
          <div class="controls">
            <select id="bridgeSelect">
              ${entries.map((e) => `<option value="${this.escape(e.entry_id)}" ${e.entry_id === this._selected ? "selected" : ""}>${this.escape(e.title || "HomeKit entry")} · ${this.escape(e.port || "unknown port")}</option>`).join("")}
            </select>
            <button id="refresh" ${this._loading ? "disabled" : ""}>${this._loading ? "Scanning..." : "Scan / Refresh"}</button>
          </div>
        </div>

        ${this._error ? `<div class="card error"><b>Scan failed.</b><div class="muted">${this.escape(this._error)}</div></div>` : ""}
        ${warnings.length ? `<div class="card warn"><b>Warnings</b><ul>${warnings.map((w) => `<li>${this.escape(w)}</li>`).join("")}</ul></div>` : ""}

        <div class="cards">
          <div class="card"><div class="num">${data.entry_count ?? 0}</div><div class="label">HomeKit entries</div></div>
          <div class="card"><div class="num">${data.total_exposed ?? 0}</div><div class="label">Total exposed entities</div></div>
          <div class="card"><div class="num">${entry?.exposed_count ?? 0}</div><div class="label">Selected bridge/accessory exposes</div></div>
          <div class="card"><div class="num">${entry?.mode ? this.escape(entry.mode) : "—"}</div><div class="label">Mode guess</div></div>
        </div>

        ${entry ? this.renderEntry(entry) : `<div class="card">No HomeKit entries found. Is HomeKit Bridge configured?</div>`}
      </div>
    `;

    const btn = this.shadowRoot.getElementById("refresh");
    if (btn) btn.addEventListener("click", () => this.loadData(true));
    const select = this.shadowRoot.getElementById("bridgeSelect");
    if (select) select.addEventListener("change", (ev) => { this._selected = ev.target.value; this.render(); });
  }

  renderEntry(entry) {
    const exposed = entry.exposed_entities || [];
    const filters = [
      ["Include domains", entry.include_domains],
      ["Include entities", entry.include_entities],
      ["Include globs", entry.include_entity_globs],
      ["Exclude domains", entry.exclude_domains],
      ["Exclude entities", entry.exclude_entities],
      ["Exclude globs", entry.exclude_entity_globs],
    ].filter(([, values]) => values && values.length);

    return `
      <div class="card">
        <div class="sectionTitle" style="margin-top:0;">${this.escape(entry.title || "HomeKit entry")}</div>
        <div class="muted">Port: <code>${this.escape(entry.port || "unknown")}</code> · Mode: <code>${this.escape(entry.mode || "unknown")}</code></div>
        <div class="chips">
          ${filters.length ? filters.map(([label, values]) => `<span class="chip"><b>${label}:</b> ${values.map((v) => this.escape(v)).join(", ")}</span>`).join("") : `<span class="chip">No explicit filters found</span>`}
        </div>
      </div>

      <div class="sectionTitle">Entities Apple Home will probably see</div>
      ${exposed.length ? `
        <table>
          <thead><tr><th>Entity</th><th>Name</th><th>Domain</th><th>Available</th></tr></thead>
          <tbody>
            ${exposed.map((ent) => `
              <tr>
                <td><code>${this.escape(ent.entity_id)}</code></td>
                <td>${this.escape(ent.name || "")}</td>
                <td>${this.escape(ent.domain || "")}</td>
                <td class="${ent.available ? "good" : "bad"}">${ent.available ? "yes" : "no"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        ${entry.truncated ? `<p class="muted">Output truncated at 200 entities for this entry.</p>` : ""}
      ` : `<div class="card warn">This selected HomeKit entry appears to expose zero entities.</div>`}
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
