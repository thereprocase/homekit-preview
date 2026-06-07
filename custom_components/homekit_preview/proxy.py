from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    ATTR_DEVICE_CLASS,
    ATTR_UNIT_OF_MEASUREMENT,
    PERCENTAGE,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
)
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers import entity_registry as er
from homeassistant.util import slugify


PROXY_TARGET_PROFILES: list[dict[str, Any]] = [
    {
        "id": "humidity_percent",
        "label": "Humidity Sensor",
        "domain": "sensor",
        "device_class": "humidity",
        "unit": PERCENTAGE,
        "homekit_type": "HumiditySensor",
        "default_icon": "mdi:water-percent",
        "customer_facing_type": "humidity percentage sensor",
        "semantic_warning": (
            "Apple Home will treat this as humidity. Use a clear name when the "
            "source is really soil moisture or another percentage measurement."
        ),
    }
]

UNAVAILABLE_STATES = {STATE_UNAVAILABLE, STATE_UNKNOWN}


def _clean_slug(value: str) -> str:
    slug = slugify(value or "proxy").strip("_")
    return slug or "proxy"


def proxy_profiles_for_unit(unit: Any) -> list[dict[str, Any]]:
    """Return HomeKit-compatible proxy profiles that preserve the unit."""
    unit_value = str(unit) if unit is not None else None
    return [profile.copy() for profile in PROXY_TARGET_PROFILES if profile["unit"] == unit_value]


def profile_by_id(profile_id: str) -> dict[str, Any] | None:
    """Return a proxy target profile by id."""
    for profile in PROXY_TARGET_PROFILES:
        if profile["id"] == profile_id:
            return profile.copy()
    return None


def normalize_proxy_config(raw: Any) -> dict[str, Any] | None:
    """Normalize one persisted proxy config."""
    if not isinstance(raw, dict):
        return None

    source_entity_id = raw.get("source_entity_id")
    target_device_class = raw.get("target_device_class")
    target_unit = raw.get("target_unit")
    name = raw.get("name")
    proxy_id = raw.get("id")
    entity_id = raw.get("entity_id")
    if not all(
        isinstance(value, str) and value
        for value in (source_entity_id, target_device_class, target_unit, name, proxy_id, entity_id)
    ):
        return None

    return {
        "id": proxy_id,
        "entity_id": entity_id,
        "source_entity_id": source_entity_id,
        "name": name,
        "target_profile_id": str(raw.get("target_profile_id") or "custom"),
        "target_label": str(raw.get("target_label") or target_device_class.replace("_", " ").title()),
        "target_device_class": target_device_class,
        "target_unit": target_unit,
        "homekit_type": str(raw.get("homekit_type") or "HomeKit sensor"),
        "state_class": str(raw.get("state_class") or "measurement"),
        "icon": str(raw.get("icon") or "mdi:water-percent"),
        "customer_facing_type": str(raw.get("customer_facing_type") or "sensor"),
        "semantic_warning": str(raw.get("semantic_warning") or "This is a semantic HomeKit compatibility proxy."),
        "enabled": bool(raw.get("enabled", True)),
    }


def normalize_proxy_configs(raw: Any) -> list[dict[str, Any]]:
    """Normalize all persisted proxy configs."""
    if not isinstance(raw, Iterable) or isinstance(raw, (str, bytes, dict)):
        return []
    configs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        config = normalize_proxy_config(item)
        if not config or config["id"] in seen:
            continue
        seen.add(config["id"])
        configs.append(config)
    return configs


def build_proxy_config(
    hass: HomeAssistant,
    existing: list[dict[str, Any]],
    source_entity_id: str,
    target_profile_id: str,
    name: str,
) -> dict[str, Any]:
    """Build a persisted proxy config from a UI request."""
    state = hass.states.get(source_entity_id)
    if state is None:
        raise ValueError(f"Source entity does not exist: {source_entity_id}")

    profile = profile_by_id(target_profile_id)
    if profile is None:
        raise ValueError(f"Unknown proxy target profile: {target_profile_id}")

    source_unit = state.attributes.get(ATTR_UNIT_OF_MEASUREMENT)
    if source_unit != profile["unit"]:
        raise ValueError(
            f"Proxy target unit {profile['unit']} does not match source unit {source_unit}"
        )

    entity_reg = er.async_get(hass)
    source_device_class = state.attributes.get(ATTR_DEVICE_CLASS)
    base_slug = _clean_slug(name or state.name or source_entity_id)
    existing_ids = {item["id"] for item in existing}
    existing_entities = {item["entity_id"] for item in existing}
    proxy_id = base_slug
    entity_id = f"sensor.homekit_proxy_{base_slug}"
    suffix = 2
    while (
        proxy_id in existing_ids
        or entity_id in existing_entities
        or hass.states.get(entity_id) is not None
        or entity_reg.async_get(entity_id) is not None
    ):
        proxy_id = f"{base_slug}_{suffix}"
        entity_id = f"sensor.homekit_proxy_{base_slug}_{suffix}"
        suffix += 1

    return {
        "id": proxy_id,
        "entity_id": entity_id,
        "source_entity_id": source_entity_id,
        "source_device_class": str(source_device_class) if source_device_class else None,
        "source_unit": source_unit,
        "name": name or state.name or source_entity_id,
        "target_profile_id": profile["id"],
        "target_label": profile["label"],
        "target_device_class": profile["device_class"],
        "target_unit": profile["unit"],
        "homekit_type": profile["homekit_type"],
        "state_class": "measurement",
        "icon": profile["default_icon"],
        "customer_facing_type": profile["customer_facing_type"],
        "semantic_warning": profile["semantic_warning"],
        "enabled": True,
    }


class HomeKitPreviewProxySensor(SensorEntity):
    """Sensor that mirrors a source entity as a HomeKit-compatible type."""

    _attr_should_poll = False
    _attr_has_entity_name = False

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, config: dict[str, Any]) -> None:
        self.hass = hass
        self._entry = entry
        self._remove_state_listener = None
        self.async_update_config(config)

    def async_update_config(self, config: dict[str, Any]) -> None:
        """Update entity metadata from persisted config."""
        self._config = config
        self.entity_id = config["entity_id"]
        self._attr_unique_id = f"{self._entry.entry_id}_proxy_{config['id']}"
        self._attr_name = config["name"]
        self._attr_device_class = config["target_device_class"]
        self._attr_native_unit_of_measurement = config["target_unit"]
        self._attr_state_class = config.get("state_class")
        self._attr_icon = config.get("icon")

    @property
    def native_value(self) -> float | str | None:
        """Return the source state using the proxy's HomeKit-compatible metadata."""
        state = self.hass.states.get(self._config["source_entity_id"])
        if state is None or state.state in UNAVAILABLE_STATES:
            return None
        try:
            return float(state.state)
        except (TypeError, ValueError):
            return state.state

    @property
    def available(self) -> bool:
        """Mirror source availability."""
        state = self.hass.states.get(self._config["source_entity_id"])
        return state is not None and state.state not in UNAVAILABLE_STATES

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose enough metadata to make the semantic proxy auditable."""
        return {
            "homekit_preview_proxy": True,
            "source_entity_id": self._config["source_entity_id"],
            "source_device_class": self._config.get("source_device_class"),
            "source_unit": self._config.get("source_unit"),
            "target_label": self._config.get("target_label"),
            "homekit_type": self._config.get("homekit_type"),
            "customer_facing_type": self._config.get("customer_facing_type"),
            "semantic_warning": self._config.get("semantic_warning"),
        }

    async def async_added_to_hass(self) -> None:
        """Watch the source entity and write a new proxy state when it changes."""
        self._remove_state_listener = async_track_state_change_event(
            self.hass,
            [self._config["source_entity_id"]],
            self._async_source_changed,
        )

    async def async_will_remove_from_hass(self) -> None:
        """Stop watching the source entity."""
        if self._remove_state_listener is not None:
            self._remove_state_listener()
            self._remove_state_listener = None

    @callback
    def _async_source_changed(self, event: Event[EventStateChangedData]) -> None:
        """Write the mirrored value after a source state change."""
        self.async_write_ha_state()
