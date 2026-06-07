from __future__ import annotations

from typing import Any

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DATA_COORDINATOR, DATA_ENTRIES, DOMAIN, HOMEKIT_DOMAIN
from .preview import normalize_filter

STATUS_NAMES = {
    0: "ready",
    1: "running",
    2: "stopped",
    3: "waiting",
}


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


def _homekit_entry(hass: HomeAssistant, entry_id: str):
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None or entry.domain != HOMEKIT_DOMAIN:
        raise ValueError("Selected config entry is not a HomeKit entry")
    return entry


def _decode_pin(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode(errors="ignore")
    return str(value)


def _pairing_info(entry) -> dict[str, Any]:
    """Return best-effort HomeKit pairing status for one config entry."""
    runtime_data = getattr(entry, "runtime_data", None)
    homekit = getattr(runtime_data, "homekit", None)
    driver = getattr(homekit, "driver", None)
    state = getattr(driver, "state", None)
    accessory = getattr(driver, "accessory", None)

    status_value = getattr(homekit, "status", None)
    paired = getattr(state, "paired", None) if state is not None else None
    client_count = 0
    if state is not None:
        try:
            client_count = len(getattr(state, "paired_clients", []) or [])
        except TypeError:
            client_count = 0

    pincode = None if paired else _decode_pin(getattr(state, "pincode", None))
    xhm_uri = None
    if not paired and accessory is not None:
        try:
            xhm_uri = accessory.xhm_uri()
        except Exception:  # noqa: BLE001 - only status metadata.
            xhm_uri = None

    can_show_pairing = bool(homekit is not None and driver is not None and accessory is not None and paired is False)

    if paired is True:
        summary = "Already paired to an Apple Home. Invite additional people from Apple Home; a new QR code is not how you add a second person."
    elif paired is False:
        summary = "Not paired. You can show the pairing notification and scan the QR/PIN from Apple Home."
    elif homekit is None:
        summary = "HomeKit runtime is not loaded yet. Restart Home Assistant or reload the HomeKit entry."
    elif driver is None:
        summary = "HomeKit driver has not started yet. Wait for Home Assistant to finish starting, then scan again."
    else:
        summary = "Pairing state is unknown."

    return {
        "entry_id": entry.entry_id,
        "title": entry.title,
        "status": STATUS_NAMES.get(status_value, str(status_value) if status_value is not None else "unknown"),
        "status_value": status_value,
        "runtime_loaded": homekit is not None,
        "driver_loaded": driver is not None,
        "paired": paired,
        "client_count": client_count,
        "pincode": pincode,
        "xhm_uri_available": bool(xhm_uri),
        "can_show_pairing": can_show_pairing,
        "pairing_qr_available": bool(getattr(runtime_data, "pairing_qr", None)),
        "pairing_qr_secret_available": bool(getattr(runtime_data, "pairing_qr_secret", None)),
        "summary": summary,
    }


async def _apply_filter(hass: HomeAssistant, entry_id: str, raw_filter: dict) -> dict:
    """Apply a HomeKit Bridge filter and reload that HomeKit entry."""
    entry = _homekit_entry(hass, entry_id)
    normalized = normalize_filter(raw_filter)
    options = dict(entry.options or {})
    options["filter"] = normalized
    hass.config_entries.async_update_entry(entry, options=options)
    await hass.config_entries.async_reload(entry.entry_id)
    return normalized


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
        data = dict(coordinator.data or {})
        pairing = {entry.entry_id: _pairing_info(entry) for entry in hass.config_entries.async_entries(HOMEKIT_DOMAIN)}
        data["pairing"] = pairing
        for item in data.get("entries", []):
            if isinstance(item, dict):
                item["pairing"] = pairing.get(item.get("entry_id"))
        return self.json(data)


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
        data = dict(coordinator.data or {})
        pairing = {entry.entry_id: _pairing_info(entry) for entry in hass.config_entries.async_entries(HOMEKIT_DOMAIN)}
        data["pairing"] = pairing
        for item in data.get("entries", []):
            if isinstance(item, dict):
                item["pairing"] = pairing.get(item.get("entry_id"))
        return self.json(data)

    async def get(self, request):
        return await self.post(request)


class HomeKitPreviewPairingStatusView(HomeAssistantView):
    """Return pairing status for all HomeKit entries."""

    url = "/api/homekit_preview/pairing"
    name = "api:homekit_preview:pairing"
    requires_auth = True

    async def get(self, request):
        hass = request.app["hass"]
        return self.json({
            "entries": [_pairing_info(entry) for entry in hass.config_entries.async_entries(HOMEKIT_DOMAIN)]
        })


class HomeKitPreviewShowPairingView(HomeAssistantView):
    """Ask HomeKit to show its pairing notification for an unpaired entry."""

    url = "/api/homekit_preview/show_pairing"
    name = "api:homekit_preview:show_pairing"
    requires_auth = True

    async def post(self, request):
        hass = request.app["hass"]
        if not _admin_allowed(request):
            return self.json({"error": "Admin privileges are required"}, status_code=403)

        body = await request.json()
        entry_id = body.get("entry_id")
        if not isinstance(entry_id, str) or not entry_id:
            return self.json({"error": "entry_id is required"}, status_code=400)

        entry = _homekit_entry(hass, entry_id)
        info = _pairing_info(entry)
        if info.get("paired") is True:
            return self.json(
                {
                    "error": "This bridge is already paired. A new QR code will not add a second person; invite them from Apple Home instead.",
                    "pairing": info,
                },
                status_code=409,
            )
        if not info.get("can_show_pairing"):
            return self.json(
                {
                    "error": info.get("summary") or "Pairing code is not available yet.",
                    "pairing": info,
                },
                status_code=409,
            )

        runtime_data = getattr(entry, "runtime_data", None)
        homekit = getattr(runtime_data, "homekit", None)
        show = getattr(homekit, "_async_show_setup_message", None)
        if not callable(show):
            return self.json({"error": "HomeKit setup-message method is unavailable", "pairing": info}, status_code=409)

        show()
        return self.json({"ok": True, "message": "Pairing notification shown in Home Assistant.", "pairing": _pairing_info(entry)})


class _ApplyFilterMixin:
    async def _handle_apply(self, request):
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
            applied_filter = await _apply_filter(hass, entry_id, raw_filter)
        except Exception as err:  # noqa: BLE001 - return the useful error to the panel.
            return self.json({"error": f"{type(err).__name__}: {err}"}, status_code=400)

        await runtime["async_scan_and_notify"]()
        coordinator = runtime[DATA_COORDINATOR]
        data = dict(coordinator.data or {})
        data = {**data, "applied_filter": applied_filter, "applied_entry_id": entry_id}
        return self.json(data)


class HomeKitPreviewApplyView(_ApplyFilterMixin, HomeAssistantView):
    """Apply a draft filter to a HomeKit Bridge entry."""

    url = "/api/homekit_preview/apply"
    name = "api:homekit_preview:apply"
    requires_auth = True

    async def post(self, request):
        return await self._handle_apply(request)


class HomeKitPreviewUpdateFilterView(_ApplyFilterMixin, HomeAssistantView):
    """Compatibility endpoint used by the sidebar panel."""

    url = "/api/homekit_preview/update_filter"
    name = "api:homekit_preview:update_filter"
    requires_auth = True

    async def post(self, request):
        return await self._handle_apply(request)


def async_register_api(hass: HomeAssistant) -> None:
    """Register HomeKit Preview API views."""
    hass.http.register_view(HomeKitPreviewDataView)
    hass.http.register_view(HomeKitPreviewScanView)
    hass.http.register_view(HomeKitPreviewPairingStatusView)
    hass.http.register_view(HomeKitPreviewShowPairingView)
    hass.http.register_view(HomeKitPreviewApplyView)
    hass.http.register_view(HomeKitPreviewUpdateFilterView)
