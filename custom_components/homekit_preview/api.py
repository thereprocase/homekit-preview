from __future__ import annotations

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DATA_COORDINATOR, DOMAIN


def _first_runtime(hass: HomeAssistant):
    domain_data = hass.data.get(DOMAIN, {})
    if not domain_data:
        return None
    return next(iter(domain_data.values()))


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


def async_register_api(hass: HomeAssistant) -> None:
    """Register HomeKit Preview API views."""
    hass.http.register_view(HomeKitPreviewDataView)
    hass.http.register_view(HomeKitPreviewScanView)
