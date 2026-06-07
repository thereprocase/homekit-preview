# HomeKit Preview

HomeKit Preview is a Home Assistant custom integration that answers the question Home Assistant's HomeKit Bridge UI should answer directly:

> What entities is this HomeKit Bridge probably going to expose to Apple Home?

It does **not** replace HomeKit Bridge and it does **not** talk to Apple Home. It reads Home Assistant's HomeKit config entries and entity registry, computes the effective include/exclude filter, then gives you an actual sidebar app.

## What it gives you

- A **HomeKit Preview** sidebar panel.
- A bridge/accessory dropdown.
- A **Scan / Refresh** button.
- A per-bridge exposed entity table.
- A `button.scan_homekit_preview` entity for dashboards.
- A `sensor.homekit_preview` entity with counts and preview data in attributes.
- A `homekit_preview.scan` action/service for automations.
- A persistent notification containing the same preview in Markdown.

## Install with HACS as a custom repository

1. Open Home Assistant.
2. Go to **HACS → ⋮ → Custom repositories**.
3. Add this repository URL.
4. Choose category **Integration**.
5. Download **HomeKit Preview**.
6. Restart Home Assistant.
7. Go to **Settings → Devices & services → Add integration → HomeKit Preview**.
8. Open the **HomeKit Preview** sidebar item.
9. Hit **Scan / Refresh**.

## Manual install

Copy this folder:

```text
custom_components/homekit_preview
```

into:

```text
/config/custom_components/homekit_preview
```

Restart Home Assistant, then add the integration from the UI.

## How to use

After setup, you should see **HomeKit Preview** in the left sidebar.

The panel shows:

- all HomeKit Bridge / accessory-mode entries it can find,
- the selected entry's port and guessed mode,
- include/exclude filters,
- the entities that Apple Home will probably see,
- availability for each entity.

Use **Scan / Refresh** after changing HomeKit Bridge options.

## Limitations

This is a Home Assistant-side preview, not a perfect Apple Home emulator. Apple may still rename, re-room, cache, hide, or otherwise spiritually damage things. This integration only tells you what Home Assistant appears configured to offer.

## Development status

Early proof-of-useful. Built specifically because HomeKit Bridge's UI makes it way too hard to answer the simple question: "what will my spouse see after scanning this QR code?"
