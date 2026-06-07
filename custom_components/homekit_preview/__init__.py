from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from homeassistant.components import frontend, persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .api import async_register_api
from .const import (
    CONF_CREATE_NOTIFICATION,
    DATA_API_REGISTERED,
    DATA_COORDINATOR,
    DATA_ENTRIES,
    DATA_PANEL_REGISTERED,
    DATA_STATIC_REGISTERED,
    DEFAULT_CREATE_NOTIFICATION,
    DOMAIN,
    PANEL_ICON,
    PANEL_ELEMENT_NAME,
    PANEL_JS_URL,
    PANEL_TITLE,
    PANEL_URL_PATH,
    SCAN_SERVICE,
    STATIC_URL_PATH,
)
from .preview import build_preview, markdown_preview

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["sensor", "button"]


def _domain_data(hass: HomeAssistant) -> dict[str, Any]:
    """Return domain data with stable sub-keys."""
    data = hass.data.setdefault(DOMAIN, {})
    data.setdefault(DATA_ENTRIES, {})
    return data


async def _async_build_data(hass: HomeAssistant) -> dict[str, Any]:
    """Build preview data without letting scan errors kill setup."""
    try:
        data = build_preview(hass)
    except Exception as err:  # noqa: BLE001 - unknown integrations can be weird.
        _LOGGER.exception("Failed to build HomeKit Preview data")
        data = {
            "entry_count": 0,
            "total_exposed": 0,
            "entries": [],
            "warnings": [f"Preview failed: {type(err).__name__}: {err}"],
            "errors": [f"{type(err).__name__}: {err}"],
        }

    data.setdefault("last_scanned", dt_util.utcnow().isoformat())
    return data


async def _async_register_static_path(hass: HomeAssistant) -> None:
    """Serve bundled panel assets once per HA process."""
    data = _domain_data(hass)
    if data.get(DATA_STATIC_REGISTERED):
        return

    static_dir = Path(__file__).parent / "www"

    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL_PATH, str(static_dir), False)]
        )
    except (ImportError, AttributeError, TypeError):
        # Older HA fallback.
        hass.http.register_static_path(
            STATIC_URL_PATH,
            str(static_dir),
            cache_headers=False,
        )
    except RuntimeError as err:
        # Reloads can leave the route registered. That is OK; the files are static.
        _LOGGER.debug("HomeKit Preview static path was already registered: %s", err)
    except Exception:  # noqa: BLE001 - sidebar assets should not break setup.
        _LOGGER.exception("Failed to register HomeKit Preview static path")
    finally:
        data[DATA_STATIC_REGISTERED] = True


def _register_api_once(hass: HomeAssistant) -> None:
    """Register API views once per HA process."""
    data = _domain_data(hass)
    if data.get(DATA_API_REGISTERED):
        return

    try:
        async_register_api(hass)
    except RuntimeError as err:
        # Reloads can leave the route registered. That is OK.
        _LOGGER.debug("HomeKit Preview API was already registered: %s", err)
    except Exception:  # noqa: BLE001 - do not break config entry setup.
        _LOGGER.exception("Failed to register HomeKit Preview API")
    finally:
        data[DATA_API_REGISTERED] = True


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Register or replace the HomeKit Preview sidebar panel."""
    data = _domain_data(hass)

    try:
        from homeassistant.components import panel_custom

        if frontend.async_panel_exists(hass, PANEL_URL_PATH):
            frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)

        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_URL_PATH,
            webcomponent_name=PANEL_ELEMENT_NAME,
            module_url=PANEL_JS_URL,
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=True,
            config={"icon_url": f"{STATIC_URL_PATH}/icon.svg"},
        )
        data[DATA_PANEL_REGISTERED] = True
    except Exception:  # noqa: BLE001 - panel failure should not break the helper.
        data[DATA_PANEL_REGISTERED] = False
        _LOGGER.exception("Failed to register HomeKit Preview sidebar panel")


def _remove_panel(hass: HomeAssistant) -> None:
    """Remove the sidebar panel if it is registered."""
    try:
        if frontend.async_panel_exists(hass, PANEL_URL_PATH):
            frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Failed to remove HomeKit Preview panel", exc_info=True)
    _domain_data(hass)[DATA_PANEL_REGISTERED] = False


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up HomeKit Preview from a config entry."""

    async def _async_update_data():
        return await _async_build_data(hass)

    coordinator = DataUpdateCoordinator(
        hass,
        _LOGGER,
        name="homekit_preview",
        update_method=_async_update_data,
    )
    await coordinator.async_config_entry_first_refresh()

    async def async_scan_and_notify() -> None:
        """Refresh preview data and optionally publish a notification."""
        await coordinator.async_request_refresh()
        create_notification = entry.options.get(
            CONF_CREATE_NOTIFICATION,
            entry.data.get(CONF_CREATE_NOTIFICATION, DEFAULT_CREATE_NOTIFICATION),
        )
        if not create_notification:
            return

        try:
            persistent_notification.async_create(
                hass,
                markdown_preview(coordinator.data),
                title=PANEL_TITLE,
                notification_id="homekit_preview_latest",
            )
        except Exception:  # noqa: BLE001 - don't turn a UI notification into a failed scan.
            _LOGGER.exception("Failed to create HomeKit Preview notification")

    data = _domain_data(hass)
    data[DATA_ENTRIES][entry.entry_id] = {
        DATA_COORDINATOR: coordinator,
        "async_scan_and_notify": async_scan_and_notify,
    }

    async def handle_scan(call: ServiceCall) -> None:
        """Service handler for manual scans."""
        await async_scan_and_notify()

    if not hass.services.has_service(DOMAIN, SCAN_SERVICE):
        hass.services.async_register(DOMAIN, SCAN_SERVICE, handle_scan)

    await _async_register_static_path(hass)
    _register_api_once(hass)
    await _async_register_panel(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload HomeKit Preview."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if not unload_ok:
        return False

    data = _domain_data(hass)
    entries = data[DATA_ENTRIES]
    entries.pop(entry.entry_id, None)

    if not entries:
        if hass.services.has_service(DOMAIN, SCAN_SERVICE):
            hass.services.async_remove(DOMAIN, SCAN_SERVICE)
        _remove_panel(hass)

    return True
