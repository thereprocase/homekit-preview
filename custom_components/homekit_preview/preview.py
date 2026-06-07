from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .const import HOMEKIT_DOMAIN

# This intentionally covers the domains people commonly expose to HomeKit.
# The actual HomeKit integration may support more or fewer entities depending
# on HA version and per-platform support, so this remains a best-effort preview.
COMMON_HOMEKIT_DOMAINS = {
    "alarm_control_panel",
    "binary_sensor",
    "button",
    "camera",
    "climate",
    "cover",
    "fan",
    "humidifier",
    "input_boolean",
    "light",
    "lock",
    "media_player",
    "remote",
    "scene",
    "script",
    "select",
    "sensor",
    "switch",
    "vacuum",
    "valve",
    "water_heater",
}

ACCESSORY_HINT_DOMAINS = {"camera", "lock", "media_player", "remote"}


@dataclass(slots=True)
class FilterConfig:
    include_domains: set[str]
    include_entities: set[str]
    include_entity_globs: set[str]
    exclude_domains: set[str]
    exclude_entities: set[str]
    exclude_entity_globs: set[str]


def _as_set(value: Any) -> set[str]:
    if not value:
        return set()
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return {str(k) for k in value}
    try:
        return {str(x) for x in value}
    except TypeError:
        return set()


def _read_filter(raw: dict[str, Any]) -> FilterConfig:
    """Read HomeKit include/exclude filters from several possible shapes."""
    filt = raw.get("filter") or {}
    source = {**filt, **raw}
    return FilterConfig(
        include_domains=_as_set(source.get("include_domains")),
        include_entities=_as_set(source.get("include_entities")),
        include_entity_globs=_as_set(source.get("include_entity_globs")),
        exclude_domains=_as_set(source.get("exclude_domains")),
        exclude_entities=_as_set(source.get("exclude_entities")),
        exclude_entity_globs=_as_set(source.get("exclude_entity_globs")),
    )


def _match_any_glob(entity_id: str, globs: set[str]) -> bool:
    return any(fnmatch.fnmatch(entity_id, pattern) for pattern in globs)


def _included(entity_id: str, domain: str, fc: FilterConfig) -> bool:
    explicit_includes_exist = bool(
        fc.include_domains or fc.include_entities or fc.include_entity_globs
    )

    if explicit_includes_exist:
        if (
            entity_id not in fc.include_entities
            and domain not in fc.include_domains
            and not _match_any_glob(entity_id, fc.include_entity_globs)
        ):
            return False

    if domain in fc.exclude_domains:
        return False
    if entity_id in fc.exclude_entities:
        return False
    if _match_any_glob(entity_id, fc.exclude_entity_globs):
        return False

    return domain in COMMON_HOMEKIT_DOMAINS


def _entity_name(hass: HomeAssistant, registry_entry) -> str:
    state = hass.states.get(registry_entry.entity_id)
    if state:
        return state.name
    return registry_entry.name or registry_entry.original_name or registry_entry.entity_id


def _entity_available(hass: HomeAssistant, entity_id: str) -> bool:
    state = hass.states.get(entity_id)
    return bool(state and state.state not in {"unavailable", "unknown"})


def _entry_mode(entry, exposed: list[dict[str, Any]]) -> str:
    options = dict(entry.options or {})
    data = dict(entry.data or {})
    mode = options.get("mode") or data.get("mode") or options.get("type") or data.get("type")
    if mode:
        return str(mode)
    if len(exposed) == 1 and exposed[0].get("domain") in ACCESSORY_HINT_DOMAINS:
        return "probably accessory"
    return "probably bridge"


def build_preview(hass: HomeAssistant) -> dict[str, Any]:
    """Build a best-effort preview of HomeKit exposure."""
    entity_reg = er.async_get(hass)
    all_entities = sorted(entity_reg.entities.values(), key=lambda item: item.entity_id)
    entries = []
    total = 0
    warnings: list[str] = []

    hk_entries = [
        entry
        for entry in hass.config_entries.async_entries()
        if entry.domain == HOMEKIT_DOMAIN
    ]

    for entry in hk_entries:
        options = dict(entry.options or {})
        data = dict(entry.data or {})
        merged = {**data, **options}
        fc = _read_filter(merged)

        exposed = []
        for reg_entry in all_entities:
            entity_id = reg_entry.entity_id
            domain = entity_id.split(".", 1)[0]
            if _included(entity_id, domain, fc):
                exposed.append(
                    {
                        "entity_id": entity_id,
                        "name": _entity_name(hass, reg_entry),
                        "domain": domain,
                        "available": _entity_available(hass, entity_id),
                    }
                )

        total += len(exposed)
        title = entry.title or data.get("name") or "HomeKit entry"
        port = data.get("port") or options.get("port")
        if len(exposed) == 0:
            warnings.append(f"{title} appears to expose zero entities.")

        entries.append(
            {
                "entry_id": entry.entry_id,
                "title": title,
                "port": port,
                "mode": _entry_mode(entry, exposed),
                "include_domains": sorted(fc.include_domains),
                "include_entities": sorted(fc.include_entities),
                "include_entity_globs": sorted(fc.include_entity_globs),
                "exclude_domains": sorted(fc.exclude_domains),
                "exclude_entities": sorted(fc.exclude_entities),
                "exclude_entity_globs": sorted(fc.exclude_entity_globs),
                "exposed_count": len(exposed),
                "exposed_entities": exposed[:200],
                "truncated": len(exposed) > 200,
            }
        )

    return {
        "entry_count": len(entries),
        "total_exposed": total,
        "entries": entries,
        "warnings": warnings,
    }


def markdown_preview(data: dict[str, Any] | None) -> str:
    """Render preview data as Markdown for a persistent notification."""
    if not data:
        return "No HomeKit Preview data is available yet."

    lines: list[str] = []
    lines.append("# HomeKit Preview")
    lines.append("")
    lines.append(
        f"Found **{data.get('entry_count', 0)}** HomeKit entries exposing approximately **{data.get('total_exposed', 0)}** entities."
    )

    warnings = data.get("warnings") or []
    if warnings:
        lines.append("")
        lines.append("## Warnings")
        for warning in warnings:
            lines.append(f"- {warning}")

    for entry in data.get("entries", []):
        port = entry.get("port") or "unknown port"
        lines.append("")
        lines.append(f"## {entry.get('title')} — {entry.get('mode')} — {port}")
        lines.append("")
        lines.append(f"Exposed count: **{entry.get('exposed_count', 0)}**")

        for label, key in (
            ("Included domains", "include_domains"),
            ("Included entities", "include_entities"),
            ("Included globs", "include_entity_globs"),
            ("Excluded domains", "exclude_domains"),
            ("Excluded entities", "exclude_entities"),
            ("Excluded globs", "exclude_entity_globs"),
        ):
            values = entry.get(key) or []
            if values:
                lines.append(f"{label}: `{', '.join(values)}`")

        exposed = entry.get("exposed_entities") or []
        if exposed:
            lines.append("")
            lines.append("| Entity | Name | Domain | Available |")
            lines.append("|---|---|---|---|")
            for ent in exposed:
                lines.append(
                    f"| `{ent.get('entity_id')}` | {ent.get('name')} | `{ent.get('domain')}` | {ent.get('available')} |"
                )
            if entry.get("truncated"):
                lines.append("")
                lines.append("Output truncated at 200 entities for this entry.")

    return "\n".join(lines)
