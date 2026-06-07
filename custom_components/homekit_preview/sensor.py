from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DATA_COORDINATOR, DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the preview sensor."""
    coordinator = hass.data[DOMAIN][entry.entry_id][DATA_COORDINATOR]
    async_add_entities([HomeKitPreviewSensor(coordinator, entry)])


class HomeKitPreviewSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing HomeKit Preview summary."""

    _attr_icon = "mdi:home-assistant"
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
        return {
            "homekit_entries": data.get("entry_count", 0),
            "total_exposed": data.get("total_exposed", 0),
            "entries": data.get("entries", []),
            "warnings": data.get("warnings", []),
        }
