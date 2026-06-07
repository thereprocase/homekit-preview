# HomeKit Preview

HomeKit Preview is a Home Assistant custom integration for making HomeKit Bridge sane.

It answers two questions:

> What is this HomeKit Bridge exposing right now?

and:

> How do I add exactly the entities I want without accidentally adding every switch/camera/sensor in the house?

## What it gives you

- A **HomeKit Preview** sidebar panel.
- Live preview of every HomeKit Bridge / accessory entry.
- Clear warnings for whole-domain includes such as “ALL switch domain”.
- HomeKit-style domain semantics: a domain include means all entities in that domain unless specific entities in that domain narrow it.
- A **Device Picker** flow: **Room → Device → check the entities you want → Apply exact list**.
- Room filtering and search.
- A backend write endpoint that applies an exact `include_entities` list to the selected HomeKit entry and reloads it.
- A `sensor.homekit_preview`, `button.scan_homekit_preview`, and `homekit_preview.scan` action/service.

## Install with HACS as a custom repository

1. Open Home Assistant.
2. Go to **HACS → ⋮ → Custom repositories**.
3. Add this repository URL.
4. Choose category **Integration**.
5. Download **HomeKit Preview**.
6. Restart Home Assistant.
7. Go to **Settings → Devices & services → Add integration → HomeKit Preview**.
8. Open **HomeKit Preview** in the sidebar.

## How to use

Open **HomeKit Preview → Device Picker**.

1. Pick the HomeKit Bridge entry at the top.
2. Pick a room.
3. Pick a device.
4. Check the entities you want in Apple Home.
5. Move to the next device.
6. Click **Apply exact list to HomeKit Bridge**.

The apply step intentionally writes an exact `include_entities` filter and clears domain-wide includes, so the bridge exposes exactly the selected entities.

## Why this exists

Home Assistant’s HomeKit Bridge options are easy to misread. Selecting a domain can mean “all entities in this domain,” and the entity selection screen can make it unclear when you are narrowing a domain versus exposing the whole thing. This integration makes the live result visible and gives you an entity-by-entity picker.

## Limitations

This is still a Home Assistant-side preview, not Apple Home itself. Apple may cache, rename, hide, or re-room accessories after pairing. Home Assistant remains the source of truth for the bridge filter.
