from __future__ import annotations

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DATA_COORDINATOR, DOMAIN, HOMEKIT_DOMAIN
from .preview import normalize_filter


def _first_runtime(hass: HomeAssistant):
    domain_data = hass.data.get(DOMAIN, {})
    if not domain_data:
        return None
    return next(iter(domain_data.values()))


def _admin_allowed(request) -> bool:
    user = request.get("hass_user") or request.get("user")
    return user is None or bool(getattr(user, "is_admin", False))


class HomeKitPreviewDataView(HomeAssistantView):
    """Return the latest HomeKit Preview data."""

    url = "/api/homekit_preview/preview"
    name = "api:homekit_preview:preview"
    requires_auth = True

    async def get(self, request):
        hass = request.app["hass"]
        runtime = _first_runtime(hass)
        if runtime is None:
            return self.json({"error": "HomeKit Preview is not configured"}, status_code=404)

        coordinator = runtime[DATA_COORDINATOR]
        return self.json(coordinator.data or {})


class HomeKitPreviewScanView(HomeAssistantView):
    """Refresh HomeKit Preview data and return it."""

    url = "/api/homekit_preview/scan"
    name = "api:homekit_preview:scan"
    requires_auth = True

    async def post(self, request):
        hass = request.app["hass"]
        runtime = _first_runtime(hass)
        if runtime is None:
            return self.json({"error": "HomeKit Preview is not configured"}, status_code=404)

        await runtime["async_scan_and_notify"]()
        coordinator = runtime[DATA_COORDINATOR]
        return self.json(coordinator.data or {})

    async def get(self, request):
        # Handy for debugging from a browser, but the panel uses POST.
        return await self.post(request)


class HomeKitPreviewUpdateFilterView(HomeAssistantView):
    """Update a HomeKit Bridge config entry's filter."""

    url = "/api/homekit_preview/update_filter"
    name = "api:homekit_preview:update_filter"
    requires_auth = True

    async def post(self, request):
        hass = request.app["hass"]
        if not _admin_allowed(request):
            return self.json({"error": "Admin required"}, status_code=403)

        payload = await request.json()
        entry_id = str(payload.get("entry_id") or "")
        new_filter = normalize_filter(payload.get("filter") or {})
        reload_entry = bool(payload.get("reload", True))

        homekit_entry = hass.config_entries.async_get_entry(entry_id)
        if homekit_entry is None or homekit_entry.domain != HOMEKIT_DOMAIN:
            return self.json({"error": "HomeKit entry not found", "entry_id": entry_id}, status_code=404)

        options = dict(homekit_entry.options or {})
        options["filter"] = new_filter
        hass.config_entries.async_update_entry(homekit_entry, options=options)

        if reload_entry:
            await hass.config_entries.async_reload(entry_id)

        runtime = _first_runtime(hass)
        if runtime is not None:
            coordinator = runtime[DATA_COORDINATOR]
            await coordinator.async_request_refresh()
            return self.json(coordinator.data or {})

        return self.json({"ok": True, "filter": new_filter})


def async_register_api(hass: HomeAssistant) -> None:
    """Register HomeKit Preview API views."""
    hass.http.register_view(HomeKitPreviewDataView)
    hass.http.register_view(HomeKitPreviewScanView)
    hass.http.register_view(HomeKitPreviewUpdateFilterView)
