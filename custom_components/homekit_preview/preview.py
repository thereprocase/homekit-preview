from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from typing import Any

from homeassistant.components.cover import CoverDeviceClass, CoverEntityFeature
from homeassistant.components.lawn_mower import LawnMowerEntityFeature
from homeassistant.components.media_player import (
    MediaPlayerDeviceClass,
    MediaPlayerEntityFeature,
)
from homeassistant.components.remote import RemoteEntityFeature
from homeassistant.components.sensor import SensorDeviceClass
from homeassistant.components.switch import SwitchDeviceClass
from homeassistant.const import (
    ATTR_DEVICE_CLASS,
    ATTR_SUPPORTED_FEATURES,
    ATTR_UNIT_OF_MEASUREMENT,
    LIGHT_LUX,
    PERCENTAGE,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.entityfilter import EntityFilter, FILTER_SCHEMA
from homeassistant.helpers import entity_registry as er

from .const import CONF_PROXIES, DOMAIN, HOMEKIT_DOMAIN
from .proxy import normalize_proxy_configs, proxy_profiles_for_unit

SUPPORTED_HOMEKIT_DOMAINS = {
    "alarm_control_panel",
    "automation",
    "binary_sensor",
    "button",
    "camera",
    "climate",
    "cover",
    "device_tracker",
    "fan",
    "humidifier",
    "input_boolean",
    "input_button",
    "input_select",
    "light",
    "lock",
    "lawn_mower",
    "media_player",
    "person",
    "remote",
    "scene",
    "script",
    "select",
    "sensor",
    "switch",
    "vacuum",
    "valve",
    "water_heater",
}

ACCESSORY_HINT_DOMAINS = {"camera", "lock", "media_player", "remote"}
CONF_ENTITY_CONFIG = "entity_config"
CONF_EXCLUDE_ACCESSORY_MODE = "exclude_accessory_mode"
CONF_FEATURE_LIST = "feature_list"
CONF_HOMEKIT_MODE = "mode"
CONF_TYPE = "type"
DEFAULT_EXCLUDE_ACCESSORY_MODE = False
DEFAULT_HOMEKIT_MODE = "bridge"
FEATURE_ON_OFF = "on_off"
FEATURE_PLAY_PAUSE = "play_pause"
FEATURE_PLAY_STOP = "play_stop"
FEATURE_TOGGLE_MUTE = "toggle_mute"
HOMEKIT_MODE_ACCESSORY = "accessory"
HOMEKIT_MODE_BRIDGE = "bridge"
UNAVAILABLE_STATES = {"unavailable", "unknown"}
MAX_EXPOSED_PER_ENTRY = 500
MAX_CANDIDATES_PER_ENTRY = 2000
MAX_HOMEKIT_BRIDGE_CHILDREN = 149
FAN_TYPES = {
    "air_purifier": "AirPurifier",
    "fan": "Fan",
}
SWITCH_TYPES = {
    "faucet": "ValveSwitch",
    "outlet": "Outlet",
    "shower": "ValveSwitch",
    "sprinkler": "ValveSwitch",
    "switch": "Switch",
    "valve": "ValveSwitch",
}
FILTER_KEYS = (
    "include_domains",
    "include_entities",
    "include_entity_globs",
    "exclude_domains",
    "exclude_entities",
    "exclude_entity_globs",
)


@dataclass(slots=True)
class FilterConfig:
    include_domains: set[str]
    include_entities: set[str]
    include_entity_globs: set[str]
    exclude_domains: set[str]
    exclude_entities: set[str]
    exclude_entity_globs: set[str]


def _as_set(value: Any) -> set[str]:
    if not value:
        return set()
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return {str(key) for key in value}
    try:
        return {str(item) for item in value}
    except TypeError:
        return set()


def normalize_filter(value: Any) -> dict[str, list[str]]:
    """Normalize a HomeKit filter payload from the UI/API."""
    raw = value if isinstance(value, dict) else {}
    return {key: sorted(_as_set(raw.get(key))) for key in FILTER_KEYS}


def _entry_payload(entry) -> dict[str, Any]:
    data = dict(entry.data or {})
    options = dict(entry.options or {})
    return {**data, **options}


def _read_filter(raw: dict[str, Any]) -> FilterConfig:
    filt = normalize_filter(raw.get("filter") or {})
    source = {**filt, **raw}

    include_entities = _as_set(source.get("include_entities"))
    include_entities |= _as_set(source.get("entity_id"))
    include_entities |= _as_set(source.get("entities"))

    include_domains = _as_set(source.get("include_domains"))
    include_domains |= _as_set(source.get("domains"))

    return FilterConfig(
        include_domains=include_domains,
        include_entities=include_entities,
        include_entity_globs=_as_set(source.get("include_entity_globs")),
        exclude_domains=_as_set(source.get("exclude_domains")),
        exclude_entities=_as_set(source.get("exclude_entities")),
        exclude_entity_globs=_as_set(source.get("exclude_entity_globs")),
    )


def _filter_payload(fc: FilterConfig) -> dict[str, list[str]]:
    return {
        "include_domains": sorted(fc.include_domains),
        "include_entities": sorted(fc.include_entities),
        "include_entity_globs": sorted(fc.include_entity_globs),
        "exclude_domains": sorted(fc.exclude_domains),
        "exclude_entities": sorted(fc.exclude_entities),
        "exclude_entity_globs": sorted(fc.exclude_entity_globs),
    }


def _match_any_glob(entity_id: str, globs: set[str]) -> bool:
    return any(fnmatch.fnmatch(entity_id, pattern) for pattern in globs)


def _explicit_entities_for_domain(fc: FilterConfig, domain: str) -> set[str]:
    return {entity_id for entity_id in fc.include_entities if entity_id.split(".", 1)[0] == domain}


def _has_include_filters(fc: FilterConfig) -> bool:
    return bool(fc.include_domains or fc.include_entities or fc.include_entity_globs)


def _entity_filter(fc: FilterConfig) -> EntityFilter:
    """Build the same entity filter HomeKit Bridge uses."""
    return FILTER_SCHEMA(_filter_payload(fc))


def _included(entity_id: str, entity_filter: EntityFilter) -> bool:
    return bool(entity_filter(entity_id))


def _filter_reason(entity_id: str, domain: str, fc: FilterConfig, included: bool) -> str:
    has_include = _has_include_filters(fc)
    has_exclude = bool(fc.exclude_domains or fc.exclude_entities or fc.exclude_entity_globs)

    if included:
        if entity_id in fc.include_entities:
            return "selected entity"
        if entity_id not in fc.exclude_entities and _match_any_glob(entity_id, fc.include_entity_globs):
            return "include glob"
        if domain in fc.include_domains:
            if _match_any_glob(entity_id, fc.exclude_entity_globs):
                return "selected entity"
            return f"ALL {domain} domain"
        if not has_include and has_exclude:
            return "not excluded"
        if not has_include:
            return "no include filter"
        return "included by HomeKit filter"

    if domain not in SUPPORTED_HOMEKIT_DOMAINS:
        return "unsupported domain"
    if entity_id in fc.exclude_entities:
        return "excluded entity"
    if _match_any_glob(entity_id, fc.exclude_entity_globs):
        return "excluded by glob"
    if domain in fc.exclude_domains:
        return "excluded domain"
    if has_include:
        return "not selected"
    return "not exposed"


def _domain_wide_include_hints(fc: FilterConfig, domain_counts: dict[str, int]) -> list[dict[str, Any]]:
    hints: list[dict[str, Any]] = []
    for domain in sorted(fc.include_domains):
        explicit = sorted(_explicit_entities_for_domain(fc, domain))
        count = domain_counts.get(domain, 0)
        pretty = domain.replace("_", " ")
        suffix = ""
        if explicit:
            suffix = (
                f" The filter also explicitly includes {len(explicit)} {domain} "
                "entity/entities, but HomeKit's EntityFilter does not use that "
                "to narrow a domain include."
            )
        message = (
            f"ALL supportable {pretty} entities are included because this bridge "
            f"includes the {domain} domain.{suffix} Use the Device Picker to "
            "write an exact entity list if that is not intended."
        )
        mode = "all"
        hints.append(
            {
                "domain": domain,
                "domain_name": pretty.title(),
                "count": count,
                "mode": mode,
                "explicit_entities": explicit,
                "message": message,
            }
        )
    return hints


def _area_name(area_reg, area_id: str | None) -> str | None:
    if not area_id:
        return None
    area = area_reg.async_get_area(area_id)
    return area.name if area else area_id


def _entity_area_name(entity_entry, device_entry, area_reg) -> tuple[str | None, str | None]:
    if entity_entry and getattr(entity_entry, "area_id", None):
        return entity_entry.area_id, _area_name(area_reg, entity_entry.area_id)
    if device_entry and getattr(device_entry, "area_id", None):
        return device_entry.area_id, _area_name(area_reg, device_entry.area_id)
    return None, None


def _entry_mode(entry, payload: dict[str, Any], exposed: list[dict[str, Any]]) -> str:
    mode = payload.get("mode") or payload.get("type")
    if mode:
        return str(mode)
    if payload.get("entity_id"):
        return "probably accessory"
    if len(exposed) == 1 and exposed[0].get("domain") in ACCESSORY_HINT_DOMAINS:
        return "probably accessory"
    return "probably bridge"


def _entity_preview(hass: HomeAssistant, state, entity_reg, device_reg, area_reg) -> dict[str, Any]:
    entity_id = state.entity_id
    domain = entity_id.split(".", 1)[0]
    entity_entry = entity_reg.async_get(entity_id)
    device_entry = None
    if entity_entry and entity_entry.device_id:
        device_entry = device_reg.async_get(entity_entry.device_id)
    area_id, area_name = _entity_area_name(entity_entry, device_entry, area_reg)
    device_id = getattr(entity_entry, "device_id", None) if entity_entry else None
    device_name = None
    if device_entry:
        device_name = device_entry.name_by_user or device_entry.name

    device_class = state.attributes.get(ATTR_DEVICE_CLASS)
    unit = state.attributes.get(ATTR_UNIT_OF_MEASUREMENT)
    state_class = state.attributes.get("state_class")
    return {
        "entity_id": entity_id,
        "name": state.name,
        "domain": domain,
        "state": str(state.state),
        "available": state.state not in UNAVAILABLE_STATES,
        "area_id": area_id,
        "device_class": str(_value(device_class)) if device_class is not None else None,
        "unit_of_measurement": str(unit) if unit is not None else None,
        "state_class": str(_value(state_class)) if state_class is not None else None,
        "area": area_name or "No room",
        "device_id": device_id,
        "device": device_name or "No device",
        "hidden_by": str(entity_entry.hidden_by) if entity_entry and entity_entry.hidden_by else None,
        "disabled_by": str(entity_entry.disabled_by) if entity_entry and entity_entry.disabled_by else None,
        "entity_category": str(entity_entry.entity_category) if entity_entry and entity_entry.entity_category else None,
    }


def _value(value: Any) -> Any:
    return getattr(value, "value", value)


def _feature_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    try:
        return [str(item) for item in value]
    except TypeError:
        return [str(value)]


def _media_player_features(state) -> list[str]:
    features = _feature_int(state.attributes.get(ATTR_SUPPORTED_FEATURES, 0))
    supported_modes: list[str] = []
    if features & (
        MediaPlayerEntityFeature.TURN_ON | MediaPlayerEntityFeature.TURN_OFF
    ):
        supported_modes.append(FEATURE_ON_OFF)
    if features & (MediaPlayerEntityFeature.PLAY | MediaPlayerEntityFeature.PAUSE):
        supported_modes.append(FEATURE_PLAY_PAUSE)
    if features & (MediaPlayerEntityFeature.PLAY | MediaPlayerEntityFeature.STOP):
        supported_modes.append(FEATURE_PLAY_STOP)
    if features & MediaPlayerEntityFeature.VOLUME_MUTE:
        supported_modes.append(FEATURE_TOGGLE_MUTE)
    return supported_modes


def _validate_media_player_features(state, feature_list: Any) -> bool:
    supported_modes = _media_player_features(state)
    if not supported_modes:
        return False
    requested = _as_list(feature_list)
    return not requested or all(feature in supported_modes for feature in requested)


def _state_needs_accessory_mode(state) -> bool:
    device_class = _value(state.attributes.get(ATTR_DEVICE_CLASS))
    features = _feature_int(state.attributes.get(ATTR_SUPPORTED_FEATURES, 0))
    if state.domain in ("camera", "lock"):
        return True
    if state.domain == "media_player" and device_class in (
        _value(MediaPlayerDeviceClass.TV),
        _value(MediaPlayerDeviceClass.RECEIVER),
    ):
        return True
    return bool(
        state.domain == "remote" and features & RemoteEntityFeature.ACTIVITY
    )


def _homekit_accessory_type(state, config: dict[str, Any]) -> tuple[str | None, str]:
    """Return the HomeKit accessory type selected by HomeKit's branch table."""
    domain = state.domain
    features = _feature_int(state.attributes.get(ATTR_SUPPORTED_FEATURES, 0))

    if domain == "alarm_control_panel":
        return "SecuritySystem", "supported as SecuritySystem"

    if domain in ("binary_sensor", "device_tracker", "person"):
        return "BinarySensor", "supported as BinarySensor"

    if domain == "climate":
        return "Thermostat", "supported as Thermostat"

    if domain == "cover":
        device_class = _value(state.attributes.get(ATTR_DEVICE_CLASS))
        if device_class in (
            _value(CoverDeviceClass.GARAGE),
            _value(CoverDeviceClass.GATE),
        ) and features & (CoverEntityFeature.OPEN | CoverEntityFeature.CLOSE):
            return "GarageDoorOpener", "supported as GarageDoorOpener"
        if (
            device_class == _value(CoverDeviceClass.WINDOW)
            and features & CoverEntityFeature.SET_POSITION
        ):
            return "Window", "supported as Window"
        if (
            device_class == _value(CoverDeviceClass.DOOR)
            and features & CoverEntityFeature.SET_POSITION
        ):
            return "Door", "supported as Door"
        if features & CoverEntityFeature.SET_POSITION:
            return "WindowCovering", "supported as WindowCovering"
        if features & (CoverEntityFeature.OPEN | CoverEntityFeature.CLOSE):
            return "WindowCoveringBasic", "supported as WindowCoveringBasic"
        if features & CoverEntityFeature.SET_TILT_POSITION:
            return "WindowCovering", "supported as WindowCovering"
        return None, "unsupported cover features"

    if domain == "fan":
        fan_type = config.get(CONF_TYPE)
        if fan_type:
            accessory_type = FAN_TYPES.get(fan_type)
            return (
                accessory_type,
                "supported as configured fan type"
                if accessory_type
                else "unsupported configured fan type",
            )
        return "Fan", "supported as Fan"

    if domain == "humidifier":
        return "HumidifierDehumidifier", "supported as HumidifierDehumidifier"

    if domain == "light":
        return "Light", "supported as Light"

    if domain == "lock":
        return "Lock", "supported as Lock"

    if domain == "media_player":
        device_class = _value(state.attributes.get(ATTR_DEVICE_CLASS))
        if device_class == _value(MediaPlayerDeviceClass.RECEIVER):
            return "ReceiverMediaPlayer", "supported as ReceiverMediaPlayer"
        if device_class == _value(MediaPlayerDeviceClass.TV):
            return "TelevisionMediaPlayer", "supported as TelevisionMediaPlayer"
        if _validate_media_player_features(state, config.get(CONF_FEATURE_LIST, [])):
            return "MediaPlayer", "supported as MediaPlayer"
        return None, "unsupported media_player features"

    if domain == "sensor":
        device_class = _value(state.attributes.get(ATTR_DEVICE_CLASS))
        unit = state.attributes.get(ATTR_UNIT_OF_MEASUREMENT)
        if device_class == _value(SensorDeviceClass.TEMPERATURE) or unit in (
            UnitOfTemperature.CELSIUS,
            UnitOfTemperature.FAHRENHEIT,
        ):
            return "TemperatureSensor", "supported as TemperatureSensor"
        if device_class == _value(SensorDeviceClass.HUMIDITY) and unit == PERCENTAGE:
            return "HumiditySensor", "supported as HumiditySensor"
        if device_class == _value(SensorDeviceClass.PM10):
            return "PM10Sensor", "supported as PM10Sensor"
        if device_class == _value(SensorDeviceClass.PM25):
            return "PM25Sensor", "supported as PM25Sensor"
        if device_class == _value(SensorDeviceClass.NITROGEN_DIOXIDE):
            return "NitrogenDioxideSensor", "supported as NitrogenDioxideSensor"
        if device_class == _value(SensorDeviceClass.VOLATILE_ORGANIC_COMPOUNDS):
            return "VolatileOrganicCompoundsSensor", "supported as VolatileOrganicCompoundsSensor"
        if device_class == _value(SensorDeviceClass.GAS):
            return "AirQualitySensor", "supported as AirQualitySensor"
        if device_class == _value(SensorDeviceClass.CO):
            return "CarbonMonoxideSensor", "supported as CarbonMonoxideSensor"
        if device_class == _value(SensorDeviceClass.CO2):
            return "CarbonDioxideSensor", "supported as CarbonDioxideSensor"
        if device_class == _value(SensorDeviceClass.ILLUMINANCE) or unit == LIGHT_LUX:
            return "LightSensor", "supported as LightSensor"
        if _value(SensorDeviceClass.PM10) in state.entity_id:
            return "PM10Sensor", "supported as PM10Sensor"
        if _value(SensorDeviceClass.PM25) in state.entity_id:
            return "PM25Sensor", "supported as PM25Sensor"
        if _value(SensorDeviceClass.GAS) in state.entity_id:
            return "AirQualitySensor", "supported as AirQualitySensor"
        if "co2" in state.entity_id:
            return "CarbonDioxideSensor", "supported as CarbonDioxideSensor"
        return None, "unsupported sensor class/unit"

    if domain == "switch":
        switch_type = config.get(CONF_TYPE)
        if switch_type:
            accessory_type = SWITCH_TYPES.get(switch_type)
            return (
                accessory_type,
                "supported as configured switch type"
                if accessory_type
                else "unsupported configured switch type",
            )
        if _value(state.attributes.get(ATTR_DEVICE_CLASS)) == _value(SwitchDeviceClass.OUTLET):
            return "Outlet", "supported as Outlet"
        return "Switch", "supported as Switch"

    if domain == "valve":
        return "Valve", "supported as Valve"

    if domain == "vacuum":
        return "Vacuum", "supported as Vacuum"

    if domain == "lawn_mower":
        if features & LawnMowerEntityFeature.DOCK and features & LawnMowerEntityFeature.START_MOWING:
            return "LawnMower", "supported as LawnMower"
        return None, "lawn_mower needs dock and start_mowing features"

    if domain == "remote" and features & RemoteEntityFeature.ACTIVITY:
        return "ActivityRemote", "supported as ActivityRemote"

    if domain in (
        "automation",
        "button",
        "input_boolean",
        "input_button",
        "remote",
        "scene",
        "script",
    ):
        return "Switch", "supported as Switch"

    if domain in ("input_select", "select"):
        return "SelectSwitch", "supported as SelectSwitch"

    if domain == "water_heater":
        return "WaterHeater", "supported as WaterHeater"

    if domain == "camera":
        return "Camera", "supported as Camera"

    return None, "unsupported domain"


def _entity_config(payload: dict[str, Any], entity_id: str) -> dict[str, Any]:
    configs = payload.get(CONF_ENTITY_CONFIG) or {}
    if not isinstance(configs, dict):
        return {}
    value = configs.get(entity_id) or {}
    return dict(value) if isinstance(value, dict) else {}


def _post_filter_result(state, entity_entry, entity_filter: EntityFilter, payload: dict[str, Any], mode: str) -> tuple[bool, str]:
    if entity_entry and (
        entity_entry.entity_category is not None or entity_entry.hidden_by is not None
    ) and not entity_filter.explicitly_included(state.entity_id):
        if entity_entry.hidden_by is not None:
            return False, "hidden registry entity is not explicitly included"
        return False, "entity_category entity is not explicitly included"

    exclude_accessory_mode = bool(
        payload.get(CONF_EXCLUDE_ACCESSORY_MODE, DEFAULT_EXCLUDE_ACCESSORY_MODE)
    )
    if (
        mode == HOMEKIT_MODE_BRIDGE
        and exclude_accessory_mode
        and _state_needs_accessory_mode(state)
    ):
        return False, "requires accessory mode and this bridge excludes accessory-mode entities"

    return True, "passes HomeKit post-filter checks"


def _simulation_result(state, entity_entry, fc: FilterConfig, entity_filter: EntityFilter, payload: dict[str, Any], mode: str) -> dict[str, Any]:
    domain = state.domain
    filter_included = _included(state.entity_id, entity_filter)
    filter_reason = _filter_reason(state.entity_id, domain, fc, filter_included)
    config = _entity_config(payload, state.entity_id)
    accessory_type, support_reason = _homekit_accessory_type(state, config)
    support_ok = accessory_type is not None
    post_ok, post_reason = _post_filter_result(state, entity_entry, entity_filter, payload, mode)
    would_expose = filter_included and support_ok and post_ok

    if would_expose:
        reason = filter_reason
    elif not filter_included:
        reason = filter_reason
    elif not support_ok:
        reason = support_reason
    else:
        reason = post_reason

    return {
        "would_expose": would_expose,
        "filter_included": filter_included,
        "filter_reason": filter_reason,
        "homekit_supported": support_ok,
        "homekit_type": accessory_type,
        "support_reason": support_reason,
        "post_filter_allowed": post_ok,
        "post_filter_reason": post_reason,
        "simulation_reason": reason,
    }


def _runtime_exposed_entity_ids(entry) -> tuple[set[str] | None, str]:
    runtime_data = getattr(entry, "runtime_data", None)
    homekit = getattr(runtime_data, "homekit", None)
    driver = getattr(homekit, "driver", None)
    accessory = getattr(driver, "accessory", None)
    if accessory is None:
        return None, "HomeKit runtime accessory is not loaded"

    bridge_accessories = getattr(accessory, "accessories", None)
    if bridge_accessories is not None:
        entity_ids = {
            entity_id
            for child in bridge_accessories.values()
            if (entity_id := getattr(child, "entity_id", None))
        }
        return entity_ids, "live HomeKit bridge runtime"

    entity_id = getattr(accessory, "entity_id", None)
    return ({entity_id} if entity_id else set()), "live HomeKit accessory runtime"


def _room_summary(candidates: list[dict[str, Any]], exposed_ids: set[str]) -> list[dict[str, Any]]:
    rooms: dict[str, dict[str, Any]] = {}
    for entity in candidates:
        key = entity.get("area") or "No room"
        bucket = rooms.setdefault(
            key,
            {"room": key, "candidate_count": 0, "exposed_count": 0, "device_count": set()},
        )
        bucket["candidate_count"] += 1
        if entity["entity_id"] in exposed_ids:
            bucket["exposed_count"] += 1
        bucket["device_count"].add(entity.get("device") or "No device")
    result = []
    for room in sorted(rooms.values(), key=lambda item: item["room"].casefold()):
        result.append({**room, "device_count": len(room["device_count"])})
    return result


def build_preview(hass: HomeAssistant) -> dict[str, Any]:
    """Build a best-effort preview of HomeKit exposure."""
    entity_reg = er.async_get(hass)
    device_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)

    states = list(hass.states.async_all())
    state_ids = {state.entity_id for state in states}
    entries = []
    total = 0
    warnings: list[str] = []

    hk_entries = hass.config_entries.async_entries(HOMEKIT_DOMAIN)

    for entry in hk_entries:
        payload = _entry_payload(entry)
        fc = _read_filter(payload)
        entity_filter = _entity_filter(fc)
        mode = str(payload.get(CONF_HOMEKIT_MODE, DEFAULT_HOMEKIT_MODE))
        runtime_exposed_ids, runtime_source = _runtime_exposed_entity_ids(entry)
        exposure_source = "runtime" if runtime_exposed_ids is not None else "simulated"

        exposed: list[dict[str, Any]] = []
        candidates: list[dict[str, Any]] = []
        domain_counts: dict[str, int] = {}
        simulated_domain_counts: dict[str, int] = {}
        candidate_domain_counts: dict[str, int] = {}
        unsupported_count = 0
        post_filter_skip_count = 0
        simulated_exposed_count = 0
        mismatch_count = 0
        accessory_mode_entity_chosen = False
        for state in states:
            entity_id = state.entity_id
            domain = state.domain
            if domain not in SUPPORTED_HOMEKIT_DOMAINS:
                continue

            preview = _entity_preview(hass, state, entity_reg, device_reg, area_reg)
            entity_entry = entity_reg.async_get(entity_id)
            preview["proxy_profiles"] = proxy_profiles_for_unit(preview.get("unit_of_measurement"))
            simulation = _simulation_result(state, entity_entry, fc, entity_filter, payload, mode)
            simulated_now = bool(simulation["would_expose"])
            if mode == HOMEKIT_MODE_ACCESSORY:
                if simulated_now and not accessory_mode_entity_chosen:
                    accessory_mode_entity_chosen = True
                elif simulated_now:
                    simulated_now = False
                    simulation["would_expose"] = False
                    simulation["simulation_reason"] = "accessory mode exposes only the first matching entity"
            elif simulated_now and simulated_exposed_count >= MAX_HOMEKIT_BRIDGE_CHILDREN:
                simulated_now = False
                simulation["would_expose"] = False
                simulation["simulation_reason"] = "HomeKit bridge accessory limit reached"

            if simulated_now:
                simulated_exposed_count += 1
                simulated_domain_counts[domain] = simulated_domain_counts.get(domain, 0) + 1

            if not simulation["homekit_supported"]:
                unsupported_count += 1
            elif not simulation["post_filter_allowed"]:
                post_filter_skip_count += 1

            if runtime_exposed_ids is None:
                included_now = simulated_now
            else:
                included_now = entity_id in runtime_exposed_ids
                if included_now != simulated_now:
                    mismatch_count += 1

            preview["currently_exposed"] = included_now
            preview["exposure_source"] = exposure_source
            preview["runtime_source"] = runtime_source
            preview["would_expose"] = simulated_now
            preview["selectable"] = bool(simulation["homekit_supported"]) and (
                mode != HOMEKIT_MODE_BRIDGE
                or not (
                    payload.get(CONF_EXCLUDE_ACCESSORY_MODE, DEFAULT_EXCLUDE_ACCESSORY_MODE)
                    and _state_needs_accessory_mode(state)
                )
            )
            preview.update(simulation)
            preview["inclusion_reason"] = (
                "live HomeKit runtime"
                if included_now and runtime_exposed_ids is not None
                else str(simulation["simulation_reason"])
            )
            candidates.append(preview)
            candidate_domain_counts[domain] = candidate_domain_counts.get(domain, 0) + 1

            if included_now:
                exposed.append(preview)
                domain_counts[domain] = domain_counts.get(domain, 0) + 1

        exposed_ids = {entity["entity_id"] for entity in exposed}
        candidate_by_id = {entity["entity_id"]: entity for entity in candidates}
        explicit_include_results = [
            {
                "entity_id": entity_id,
                "currently_exposed": bool(candidate.get("currently_exposed")),
                "name": candidate.get("name"),
                "state": candidate.get("state"),
                "device_class": candidate.get("device_class"),
                "unit_of_measurement": candidate.get("unit_of_measurement"),
                "area": candidate.get("area"),
                "device": candidate.get("device"),
                "proxy_profiles": candidate.get("proxy_profiles", []),
                "would_expose": bool(candidate.get("would_expose")),
                "homekit_supported": bool(candidate.get("homekit_supported")),
                "homekit_type": candidate.get("homekit_type"),
                "reason": candidate.get("simulation_reason")
                or candidate.get("inclusion_reason")
                or "not exposed",
            }
            for entity_id in sorted(fc.include_entities & state_ids)
            if (candidate := candidate_by_id.get(entity_id))
        ]
        missing_includes = sorted(fc.include_entities - state_ids)
        title = entry.title or payload.get("name") or "HomeKit entry"
        if missing_includes:
            warnings.append(
                f"{title} explicitly includes missing entities: {', '.join(missing_includes)}"
            )
        if runtime_exposed_ids is None:
            warnings.append(f"{title}: {runtime_source}; counts are simulated from the HomeKit filter.")
        if mismatch_count:
            warnings.append(
                f"{title}: live HomeKit runtime differs from simulated filter support for {mismatch_count} entity/entities."
            )
        if not exposed:
            warnings.append(f"{title} appears to expose zero current entities.")

        available_count = sum(1 for item in exposed if item["available"])
        unavailable_count = len(exposed) - available_count
        total += len(exposed)
        domain_wide_includes = _domain_wide_include_hints(fc, simulated_domain_counts)
        exposed_sorted = sorted(exposed, key=lambda item: item["entity_id"])
        candidates_sorted = sorted(candidates, key=lambda item: item["entity_id"])

        entries.append(
            {
                "entry_id": entry.entry_id,
                "title": title,
                "port": payload.get("port"),
                "mode": _entry_mode(entry, payload, exposed_sorted),
                "exposure_source": exposure_source,
                "runtime_source": runtime_source,
                "filter": _filter_payload(fc),
                "include_domains": sorted(fc.include_domains),
                "include_entities": sorted(fc.include_entities),
                "include_entity_globs": sorted(fc.include_entity_globs),
                "exclude_domains": sorted(fc.exclude_domains),
                "exclude_entities": sorted(fc.exclude_entities),
                "exclude_entity_globs": sorted(fc.exclude_entity_globs),
                "exposed_count": len(exposed),
                "simulated_exposed_count": simulated_exposed_count,
                "available_count": available_count,
                "unavailable_count": unavailable_count,
                "domain_counts": dict(sorted(domain_counts.items())),
                "simulated_domain_counts": dict(sorted(simulated_domain_counts.items())),
                "candidate_domain_counts": dict(sorted(candidate_domain_counts.items())),
                "candidate_count": len(candidates),
                "unsupported_count": unsupported_count,
                "post_filter_skip_count": post_filter_skip_count,
                "simulation_mismatch_count": mismatch_count,
                "room_summary": _room_summary(candidates_sorted, exposed_ids),
                "domain_wide_includes": domain_wide_includes,
                "domain_wide_include_count": sum(1 for item in domain_wide_includes if item.get("mode") == "all"),
                "explicit_include_results": explicit_include_results,
                "explicit_include_not_exposed": [
                    item
                    for item in explicit_include_results
                    if not item.get("currently_exposed")
                ],
                "missing_includes": missing_includes,
                "exposed_entities": exposed_sorted[:MAX_EXPOSED_PER_ENTRY],
                "candidate_entities": candidates_sorted[:MAX_CANDIDATES_PER_ENTRY],
                "truncated": len(exposed) > MAX_EXPOSED_PER_ENTRY,
                "truncated_count": max(0, len(exposed) - MAX_EXPOSED_PER_ENTRY),
                "candidates_truncated": len(candidates) > MAX_CANDIDATES_PER_ENTRY,
                "candidates_truncated_count": max(0, len(candidates) - MAX_CANDIDATES_PER_ENTRY),
            }
        )

    proxies: list[dict[str, Any]] = []
    for preview_entry in hass.config_entries.async_entries(DOMAIN):
        proxies.extend(
            normalize_proxy_configs(preview_entry.options.get(CONF_PROXIES, []))
        )
    return {
        "entry_count": len(entries),
        "total_exposed": total,
        "entries": entries,
        "warnings": warnings,
        "proxies": proxies,
        "proxy_count": len(proxies),
    }


def markdown_preview(data: dict[str, Any] | None) -> str:
    """Render preview data as Markdown for a persistent notification."""
    if not data:
        return "No HomeKit Preview data is available yet."

    lines: list[str] = []
    lines.append("# HomeKit Preview")
    lines.append("")
    lines.append(
        f"Found **{data.get('entry_count', 0)}** HomeKit entries exposing approximately **{data.get('total_exposed', 0)}** current entities."
    )

    warnings = data.get("warnings") or []
    if warnings:
        lines.append("")
        lines.append("## Warnings")
        for warning in warnings:
            lines.append(f"- {warning}")

    for entry in data.get("entries", []):
        port = entry.get("port") or "unknown port"
        lines.append("")
        lines.append(f"## {entry.get('title')} — {entry.get('mode')} — {port}")
        lines.append("")
        lines.append(
            f"Exposed: **{entry.get('exposed_count', 0)}** — Available: **{entry.get('available_count', 0)}** — Unavailable/unknown: **{entry.get('unavailable_count', 0)}**"
        )

        domain_wide_includes = entry.get("domain_wide_includes") or []
        if domain_wide_includes:
            lines.append("")
            lines.append("### Domain includes")
            for hint in domain_wide_includes:
                lines.append(f"- **{hint.get('domain')}**: {hint.get('message')}")

        for label, key in (
            ("Included domains", "include_domains"),
            ("Included entities", "include_entities"),
            ("Included globs", "include_entity_globs"),
            ("Excluded domains", "exclude_domains"),
            ("Excluded entities", "exclude_entities"),
            ("Excluded globs", "exclude_entity_globs"),
        ):
            values = entry.get(key) or []
            if values:
                lines.append(f"{label}: `{', '.join(values)}`")

        exposed = entry.get("exposed_entities") or []
        if exposed:
            lines.append("")
            lines.append("| Entity | Name | Domain | Room | Device | State | Available | Why included |")
            lines.append("|---|---|---|---|---|---|---|---|")
            for ent in exposed:
                lines.append(
                    f"| `{ent.get('entity_id')}` | {ent.get('name') or ''} | `{ent.get('domain')}` | {ent.get('area') or ''} | {ent.get('device') or ''} | `{ent.get('state')}` | {ent.get('available')} | {ent.get('inclusion_reason') or ''} |"
                )
            if entry.get("truncated"):
                lines.append("")
                lines.append(
                    f"Output truncated at {MAX_EXPOSED_PER_ENTRY} entities for this entry; {entry.get('truncated_count', 0)} more not shown."
                )

    return "\n".join(lines)
