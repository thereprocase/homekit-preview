from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .api import async_register_api
from .const import (
    CONF_CREATE_NOTIFICATION,
    DATA_COORDINATOR,
    DEFAULT_CREATE_NOTIFICATION,
    DOMAIN,
    SCAN_SERVICE,
)
from .preview import build_preview, markdown_preview

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["sensor", "button"]
PANEL_URL_PATH = "homekit-preview"
PANEL_JS_URL = "/homekit_preview_static/panel.js?v=0.5.0"
STATIC_URL_PATH = "/homekit_preview_static"


async def _async_register_static_path(hass: HomeAssistant) -> None:
    """Serve bundled panel assets."""
    static_dir = Path(__file__).parent / "www"
    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL_PATH, str(static_dir), False)]
        )
        return
    except (ImportError, AttributeError, TypeError, RuntimeError, ValueError):
        pass

    try:
        hass.http.register_static_path(
            STATIC_URL_PATH,
            str(static_dir),
            cache_headers=False,
        )
    except (RuntimeError, ValueError):
        _LOGGER.debug("HomeKit Preview static path was already registered")


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Register the HomeKit Preview sidebar panel."""
    try:
        from homeassistant.components import frontend, panel_custom

        try:
            frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
        except Exception:  # noqa: BLE001 - removal is only to make reloads clean.
            pass

        await panel_custom.async_register_panel(
            hass,
            webcomponent_name="homekit-preview-panel",
            frontend_url_path=PANEL_URL_PATH,
            module_url=PANEL_JS_URL,
            sidebar_title="HomeKit Preview",
            sidebar_icon="mdi:home-edit-outline",
            require_admin=True,
            config={},
        )
    except Exception:  # noqa: BLE001 - sidebar failure should not break the helper.
        _LOGGER.exception("Failed to register HomeKit Preview sidebar panel")


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

    async def async_scan_and_notify() -> None:
        """Refresh preview data and optionally publish a notification."""
        try:
            await coordinator.async_request_refresh()
            create_notification = entry.options.get(
                CONF_CREATE_NOTIFICATION,
                entry.data.get(CONF_CREATE_NOTIFICATION, DEFAULT_CREATE_NOTIFICATION),
            )
            if create_notification:
                persistent_notification.async_create(
                    hass,
                    markdown_preview(coordinator.data),
                    title="HomeKit Preview",
                    notification_id="homekit_preview_latest",
                )
        except Exception:  # noqa: BLE001 - surface full traceback in HA logs.
            _LOGGER.exception("HomeKit Preview scan failed")
            raise

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {
        DATA_COORDINATOR: coordinator,
        "async_scan_and_notify": async_scan_and_notify,
    }

    async def handle_scan(call: ServiceCall) -> None:
        """Service handler for manual scans."""
        await async_scan_and_notify()

    hass.services.async_register(DOMAIN, SCAN_SERVICE, handle_scan)
    await _async_register_static_path(hass)
    async_register_api(hass)
    await _async_register_panel(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload HomeKit Preview."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        if not hass.data.get(DOMAIN):
            hass.services.async_remove(DOMAIN, SCAN_SERVICE)
            try:
                from homeassistant.components import frontend

                frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
            except Exception:  # noqa: BLE001
                pass
    return unload_ok
