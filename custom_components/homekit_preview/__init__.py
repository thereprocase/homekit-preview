from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import (
    CONF_CREATE_NOTIFICATION,
    DATA_COORDINATOR,
    DEFAULT_CREATE_NOTIFICATION,
    DOMAIN,
    SCAN_SERVICE,
)
from .preview import build_preview, markdown_preview

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["sensor"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up HomeKit Preview from a config entry."""

    async def _async_update_data():
        return build_preview(hass)

    coordinator = DataUpdateCoordinator(
        hass,
        _LOGGER,
        name="homekit_preview",
        update_method=_async_update_data,
    )
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {DATA_COORDINATOR: coordinator}

    async def handle_scan(call: ServiceCall) -> None:
        """Refresh preview data and optionally publish a notification."""
        await coordinator.async_request_refresh()
        create_notification = entry.options.get(
            CONF_CREATE_NOTIFICATION,
            entry.data.get(CONF_CREATE_NOTIFICATION, DEFAULT_CREATE_NOTIFICATION),
        )
        if create_notification:
            hass.components.persistent_notification.async_create(
                markdown_preview(coordinator.data),
                title="HomeKit Preview",
                notification_id="homekit_preview_latest",
            )

    hass.services.async_register(DOMAIN, SCAN_SERVICE, handle_scan)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload HomeKit Preview."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        if not hass.data.get(DOMAIN):
            hass.services.async_remove(DOMAIN, SCAN_SERVICE)
    return unload_ok
