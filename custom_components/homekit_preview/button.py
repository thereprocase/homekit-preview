from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the scan button."""
    runtime = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([HomeKitPreviewScanButton(runtime, entry)])


class HomeKitPreviewScanButton(ButtonEntity):
    """Button that refreshes HomeKit Preview."""

    _attr_icon = "mdi:refresh"
    _attr_name = "Scan HomeKit Preview"

    def __init__(self, runtime, entry: ConfigEntry) -> None:
        self._runtime = runtime
        self._attr_unique_id = f"{entry.entry_id}_scan_homekit_preview"

    async def async_press(self) -> None:
        await self._runtime["async_scan_and_notify"]()
