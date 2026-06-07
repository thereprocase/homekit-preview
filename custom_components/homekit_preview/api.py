from __future__ import annotations

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DATA_COORDINATOR, DATA_ENTRIES, DOMAIN
from .preview import async_apply_filter_to_homekit_entry


def _admin_allowed(request) -> bool:
    user = request.get("hass_user") or request.get("user")
    return user is None or bool(getattr(user, "is_admin", False))


def _first_runtime(hass: HomeAssistant):
    """Return the first configured runtime, if any."""
    domain_data = hass.data.get(DOMAIN, {})
    entries = domain_data.get(DATA_ENTRIES, {})
    if not entries:
        return None
    return next(iter(entries.values()))


def _runtime_for_any_entry(hass: HomeAssistant):
    """Return a runtime that can refresh preview data."""
    return _first_runtime(hass)


class HomeKitPreviewDataView(HomeAssistantView):
    """Return the latest HomeKit Preview data."""

    url = "/api/homekit_preview/preview"
    name = "api:homekit_preview:preview"
    requires_auth = True

    async def get(self, request):
        hass = request.app["hass"]
        runtime = _runtime_for_any_entry(hass)
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
        runtime = _runtime_for_any_entry(hass)
        if runtime is None:
            return self.json({"error": "HomeKit Preview is not configured"}, status_code=404)

        await runtime["async_scan_and_notify"]()
        coordinator = runtime[DATA_COORDINATOR]
        return self.json(coordinator.data or {})

    async def get(self, request):
        # Handy for debugging from a browser, but the panel uses POST.
        return await self.post(request)


class HomeKitPreviewApplyView(HomeAssistantView):
    """Apply a draft filter to a HomeKit Bridge entry."""

    url = "/api/homekit_preview/apply"
    name = "api:homekit_preview:apply"
    requires_auth = True

    async def post(self, request):
        hass = request.app["hass"]
        runtime = _runtime_for_any_entry(hass)
        if runtime is None:
            return self.json({"error": "HomeKit Preview is not configured"}, status_code=404)

        if not _admin_allowed(request):
            return self.json({"error": "Admin privileges are required"}, status_code=403)

        body = await request.json()
        entry_id = body.get("entry_id")
        raw_filter = body.get("filter")
        if not isinstance(entry_id, str) or not entry_id:
            return self.json({"error": "entry_id is required"}, status_code=400)
        if not isinstance(raw_filter, dict):
            return self.json({"error": "filter must be an object"}, status_code=400)

        try:
            applied_filter = await async_apply_filter_to_homekit_entry(
                hass,
                entry_id,
                raw_filter,
            )
        except Exception as err:  # noqa: BLE001 - return the useful error to the panel.
            return self.json(
                {"error": f"{type(err).__name__}: {err}"},
                status_code=400,
            )

        await runtime["async_scan_and_notify"]()
        coordinator = runtime[DATA_COORDINATOR]
        data = coordinator.data or {}
        data = {**data, "applied_filter": applied_filter, "applied_entry_id": entry_id}
        return self.json(data)


def async_register_api(hass: HomeAssistant) -> None:
    """Register HomeKit Preview API views."""
    hass.http.register_view(HomeKitPreviewDataView)
    hass.http.register_view(HomeKitPreviewScanView)
    hass.http.register_view(HomeKitPreviewApplyView)
