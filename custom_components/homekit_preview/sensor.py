from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    CONF_PROXIES,
    DATA_COORDINATOR,
    DATA_ENTRIES,
    DATA_PROXY_SYNC,
    DOMAIN,
)
from .proxy import HomeKitPreviewProxySensor, normalize_proxy_configs


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the preview summary sensor and configured proxy sensors."""
    runtime = hass.data[DOMAIN][DATA_ENTRIES][entry.entry_id]
    coordinator = runtime[DATA_COORDINATOR]
    async_add_entities([HomeKitPreviewSensor(coordinator, entry)])

    proxy_entities: dict[str, HomeKitPreviewProxySensor] = {}

    async def async_sync_proxy_entities() -> None:
        """Add configured proxy entities and remove disabled ones."""
        configs = normalize_proxy_configs(entry.options.get(CONF_PROXIES, []))
        wanted_ids = {
            config["id"]
            for config in configs
            if config.get("enabled", True)
        }
        new_entities: list[HomeKitPreviewProxySensor] = []
        for config in configs:
            if not config.get("enabled", True):
                continue
            proxy_id = config["id"]
            if proxy_id in proxy_entities:
                proxy_entities[proxy_id].async_update_config(config)
                proxy_entities[proxy_id].async_write_ha_state()
                continue

            entity = HomeKitPreviewProxySensor(hass, entry, config)
            proxy_entities[proxy_id] = entity
            new_entities.append(entity)

        for proxy_id in list(proxy_entities):
            if proxy_id not in wanted_ids:
                entity = proxy_entities.pop(proxy_id)
                await entity.async_remove()

        if new_entities:
            async_add_entities(new_entities, True)

    runtime[DATA_PROXY_SYNC] = async_sync_proxy_entities
    await async_sync_proxy_entities()

class HomeKitPreviewSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing HomeKit Preview summary."""

    _attr_icon = "mdi:home-export-outline"
    _attr_name = "HomeKit Preview"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_homekit_preview"

    @property
    def native_value(self):
        data = self.coordinator.data or {}
        return data.get("total_exposed", 0)

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data or {}
        entry_summaries = []
        for entry in data.get("entries", []):
            if not isinstance(entry, dict):
                continue
            entry_summaries.append(
                {
                    "entry_id": entry.get("entry_id"),
                    "title": entry.get("title"),
                    "mode": entry.get("mode"),
                    "exposure_source": entry.get("exposure_source"),
                    "exposed_count": entry.get("exposed_count", 0),
                    "simulated_exposed_count": entry.get("simulated_exposed_count", 0),
                    "candidate_count": entry.get("candidate_count", 0),
                    "unsupported_count": entry.get("unsupported_count", 0),
                    "post_filter_skip_count": entry.get("post_filter_skip_count", 0),
                    "explicit_include_not_exposed_count": len(
                        entry.get("explicit_include_not_exposed", [])
                    ),
                    "domain_wide_include_count": entry.get("domain_wide_include_count", 0),
                    "simulation_mismatch_count": entry.get("simulation_mismatch_count", 0),
                }
            )
        return {
            "homekit_entries": data.get("entry_count", 0),
            "total_exposed": data.get("total_exposed", 0),
            "entry_summaries": entry_summaries,
            "warning_count": len(data.get("warnings", [])),
            "warnings": (data.get("warnings", []) or [])[:10],
            "last_scanned": data.get("last_scanned"),
        }
