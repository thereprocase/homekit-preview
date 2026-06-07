from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import HOMEKIT_DOMAIN

# Mirrors the current Home Assistant HomeKit config-flow supported-domain list
# closely enough for a preview tool. The real HomeKit integration still gets
# final say at runtime.
SUPPORTED_HOMEKIT_DOMAINS = {
    "alarm_control_panel",
    "automation",
    "binary_sensor",
    "button",
    "camera",
    "climate",
    "cover",
    "demo",
    "device_tracker",
    "fan",
    "humidifier",
    "input_boolean",
    "input_button",
    "input_select",
    "light",
    "lock",
    "lawn_mower",
    "media_player",
    "person",
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
HOMEKIT_MODE_ACCESSORY = "accessory"
HOMEKIT_MODE_BRIDGE = "bridge"
UNAVAILABLE_STATES = {"unavailable", "unknown"}
MAX_EXPOSED_PER_ENTRY = 500
MAX_CANDIDATES_PER_ENTRY = 1500
FILTER_KEYS = (
    "include_domains",
    "include_entities",
    "include_entity_globs",
    "exclude_domains",
    "exclude_entities",
    "exclude_entity_globs",
)


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
        return {str(key) for key in value}
    try:
        return {str(item) for item in value}
    except TypeError:
        return set()


def _entry_payload(entry) -> dict[str, Any]:
    """Merge HomeKit entry data/options in the same spirit as HA's options flow."""
    data = dict(entry.data or {})
    options = dict(entry.options or {})
    return {**data, **options}


def _read_filter(raw: dict[str, Any]) -> FilterConfig:
    """Read HomeKit include/exclude filters from UI and YAML-ish shapes."""
    filt = raw.get("filter") or {}
    source = {**filt, **raw}

    include_entities = _as_set(source.get("include_entities"))

    # Accessory-mode entries normally store filter.include_entities, but keep
    # these fallbacks because older or imported entries can be shaped oddly.
    include_entities |= _as_set(source.get("entity_id"))
    include_entities |= _as_set(source.get("entities"))

    include_domains = _as_set(source.get("include_domains"))
    include_domains |= _as_set(source.get("domains"))

    return FilterConfig(
        include_domains=include_domains,
        include_entities=include_entities,
        include_entity_globs=_as_set(source.get("include_entity_globs")),
        exclude_domains=_as_set(source.get("exclude_domains")),
        exclude_entities=_as_set(source.get("exclude_entities")),
        exclude_entity_globs=_as_set(source.get("exclude_entity_globs")),
    )


def _filter_payload(fc: FilterConfig) -> dict[str, list[str]]:
    return {
        "include_domains": sorted(fc.include_domains),
        "include_entities": sorted(fc.include_entities),
        "include_entity_globs": sorted(fc.include_entity_globs),
        "exclude_domains": sorted(fc.exclude_domains),
        "exclude_entities": sorted(fc.exclude_entities),
        "exclude_entity_globs": sorted(fc.exclude_entity_globs),
    }


def _match_any_glob(entity_id: str, globs: set[str]) -> bool:
    return any(fnmatch.fnmatch(entity_id, pattern) for pattern in globs)


def _included(entity_id: str, domain: str, fc: FilterConfig) -> bool:
    if domain not in SUPPORTED_HOMEKIT_DOMAINS:
        return False

    explicit_includes_exist = bool(
        fc.include_domains or fc.include_entities or fc.include_entity_globs
    )

    if explicit_includes_exist and (
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

    return True


def _inclusion_reason(entity_id: str, domain: str, fc: FilterConfig) -> str:
    """Explain why an entity passed the include side of the filter."""
    if entity_id in fc.include_entities:
        return "explicit entity"
    if _match_any_glob(entity_id, fc.include_entity_globs):
        return "include glob"
    if domain in fc.include_domains:
        return "domain-wide include"
    if not (fc.include_domains or fc.include_entities or fc.include_entity_globs):
        return "no include filter"
    return "included by filter"


def _exclusion_reason(entity_id: str, domain: str, fc: FilterConfig) -> str:
    """Explain why an entity is not currently exposed."""
    if domain not in SUPPORTED_HOMEKIT_DOMAINS:
        return "unsupported domain"
    if domain in fc.exclude_domains:
        return "excluded domain"
    if entity_id in fc.exclude_entities:
        return "excluded entity"
    if _match_any_glob(entity_id, fc.exclude_entity_globs):
        return "excluded by glob"
    if fc.include_domains or fc.include_entities or fc.include_entity_globs:
        return "not included"
    return "not exposed"


def _domain_wide_include_hints(
    fc: FilterConfig, domain_counts: dict[str, int]
) -> list[dict[str, Any]]:
    """Return UI hints for domains that are currently included wholesale."""
    hints: list[dict[str, Any]] = []
    for domain in sorted(fc.include_domains):
        count = domain_counts.get(domain, 0)
        pretty = domain.replace("_", " ")
        hints.append(
            {
                "domain": domain,
                "domain_name": pretty.title(),
                "count": count,
                "message": (
                    f"ALL {pretty} entities are included because this bridge includes "
                    f"the {domain} domain. This usually happens when Bridge settings "
                    f"select the {pretty.title()} domain but no {domain} entity is "
                    "selected on the entity-selection screen. To filter this domain, "
                    "return to Bridge settings and add at least one entity of this "
                    "domain type."
                ),
            }
        )
    return hints


def _area_name(area_reg, area_id: str | None) -> str | None:
    if not area_id:
        return None
    area = area_reg.async_get_area(area_id)
    return area.name if area else area_id


def _entity_area_name(entity_entry, device_entry, area_reg) -> str | None:
    if entity_entry and getattr(entity_entry, "area_id", None):
        return _area_name(area_reg, entity_entry.area_id)
    if device_entry and getattr(device_entry, "area_id", None):
        return _area_name(area_reg, device_entry.area_id)
    return None


def _entry_mode(entry, payload: dict[str, Any], exposed: list[dict[str, Any]]) -> str:
    mode = payload.get("mode") or payload.get("type")
    if mode:
        return str(mode)
    if payload.get("entity_id"):
        return "probably accessory"
    if len(exposed) == 1 and exposed[0].get("domain") in ACCESSORY_HINT_DOMAINS:
        return "probably accessory"
    return "probably bridge"


def _entity_preview(hass: HomeAssistant, state, entity_reg, device_reg, area_reg) -> dict[str, Any]:
    entity_id = state.entity_id
    domain = entity_id.split(".", 1)[0]
    entity_entry = entity_reg.async_get(entity_id)
    device_entry = None
    if entity_entry and entity_entry.device_id:
        device_entry = device_reg.async_get(entity_entry.device_id)

    return {
        "entity_id": entity_id,
        "name": state.name,
        "domain": domain,
        "state": str(state.state),
        "available": state.state not in UNAVAILABLE_STATES,
        "area": _entity_area_name(entity_entry, device_entry, area_reg),
        "device": device_entry.name_by_user or device_entry.name if device_entry else None,
        "hidden_by": str(entity_entry.hidden_by) if entity_entry and entity_entry.hidden_by else None,
        "disabled_by": str(entity_entry.disabled_by) if entity_entry and entity_entry.disabled_by else None,
        "entity_category": str(entity_entry.entity_category) if entity_entry and entity_entry.entity_category else None,
    }


def build_preview(hass: HomeAssistant) -> dict[str, Any]:
    """Build a best-effort preview of HomeKit exposure."""
    entity_reg = er.async_get(hass)
    device_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)

    states = sorted(hass.states.async_all(), key=lambda item: item.entity_id)
    state_ids = {state.entity_id for state in states}
    entries = []
    total = 0
    warnings: list[str] = []

    hk_entries = hass.config_entries.async_entries(HOMEKIT_DOMAIN)

    for entry in hk_entries:
        payload = _entry_payload(entry)
        fc = _read_filter(payload)

        exposed = []
        candidates = []
        domain_counts: dict[str, int] = {}
        candidate_domain_counts: dict[str, int] = {}
        for state in states:
            entity_id = state.entity_id
            domain = entity_id.split(".", 1)[0]
            if domain not in SUPPORTED_HOMEKIT_DOMAINS:
                continue

            preview = _entity_preview(hass, state, entity_reg, device_reg, area_reg)
            included_now = _included(entity_id, domain, fc)
            preview["currently_exposed"] = included_now
            preview["inclusion_reason"] = (
                _inclusion_reason(entity_id, domain, fc)
                if included_now
                else _exclusion_reason(entity_id, domain, fc)
            )
            candidates.append(preview)
            candidate_domain_counts[domain] = candidate_domain_counts.get(domain, 0) + 1

            if included_now:
                exposed.append(preview)
                domain_counts[domain] = domain_counts.get(domain, 0) + 1

        missing_includes = sorted(fc.include_entities - state_ids)
        title = entry.title or payload.get("name") or "HomeKit entry"
        if missing_includes:
            warnings.append(
                f"{title} explicitly includes missing entities: {', '.join(missing_includes)}"
            )
        if not exposed:
            warnings.append(f"{title} appears to expose zero current entities.")

        available_count = sum(1 for item in exposed if item["available"])
        unavailable_count = len(exposed) - available_count
        total += len(exposed)
        domain_wide_includes = _domain_wide_include_hints(fc, domain_counts)

        entries.append(
            {
                "entry_id": entry.entry_id,
                "title": title,
                "port": payload.get("port"),
                "mode": _entry_mode(entry, payload, exposed),
                "filter": _filter_payload(fc),
                "include_domains": sorted(fc.include_domains),
                "include_entities": sorted(fc.include_entities),
                "include_entity_globs": sorted(fc.include_entity_globs),
                "exclude_domains": sorted(fc.exclude_domains),
                "exclude_entities": sorted(fc.exclude_entities),
                "exclude_entity_globs": sorted(fc.exclude_entity_globs),
                "exposed_count": len(exposed),
                "available_count": available_count,
                "unavailable_count": unavailable_count,
                "domain_counts": dict(sorted(domain_counts.items())),
                "candidate_domain_counts": dict(sorted(candidate_domain_counts.items())),
                "candidate_count": len(candidates),
                "domain_wide_includes": domain_wide_includes,
                "domain_wide_include_count": len(domain_wide_includes),
                "missing_includes": missing_includes,
                "exposed_entities": exposed[:MAX_EXPOSED_PER_ENTRY],
                "candidate_entities": candidates[:MAX_CANDIDATES_PER_ENTRY],
                "truncated": len(exposed) > MAX_EXPOSED_PER_ENTRY,
                "truncated_count": max(0, len(exposed) - MAX_EXPOSED_PER_ENTRY),
                "candidates_truncated": len(candidates) > MAX_CANDIDATES_PER_ENTRY,
                "candidates_truncated_count": max(0, len(candidates) - MAX_CANDIDATES_PER_ENTRY),
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
        f"Found **{data.get('entry_count', 0)}** HomeKit entries exposing approximately **{data.get('total_exposed', 0)}** current entities."
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
        lines.append(
            f"Exposed: **{entry.get('exposed_count', 0)}** — Available: **{entry.get('available_count', 0)}** — Unavailable/unknown: **{entry.get('unavailable_count', 0)}**"
        )

        domain_wide_includes = entry.get("domain_wide_includes") or []
        if domain_wide_includes:
            lines.append("")
            lines.append("### Whole-domain includes")
            for hint in domain_wide_includes:
                lines.append(f"- **{hint.get('domain')}**: {hint.get('message')}")

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
            lines.append("| Entity | Name | Domain | Area | State | Available | Why included |")
            lines.append("|---|---|---|---|---|---|---|")
            for ent in exposed:
                lines.append(
                    f"| `{ent.get('entity_id')}` | {ent.get('name') or ''} | `{ent.get('domain')}` | {ent.get('area') or ''} | `{ent.get('state')}` | {ent.get('available')} | {ent.get('inclusion_reason') or ''} |"
                )
            if entry.get("truncated"):
                lines.append("")
                lines.append(
                    f"Output truncated at {MAX_EXPOSED_PER_ENTRY} entities for this entry; {entry.get('truncated_count', 0)} more not shown."
                )

    return "\n".join(lines)
