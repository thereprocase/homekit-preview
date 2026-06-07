# HomeKit Preview

HomeKit Preview is a Home Assistant custom integration for answering — and now fixing — the question Home Assistant's HomeKit Bridge UI makes painfully opaque:

> What entities is this HomeKit Bridge going to expose to Apple Home?

It does **not** replace HomeKit Bridge and it does **not** talk to Apple Home. It reads Home Assistant's HomeKit config entries and entity registry, shows what each bridge/accessory is exposing, and gives you a sidebar builder for changing the HomeKit Bridge filter without spelunking through Home Assistant's Options flow.

## What it gives you

- A **HomeKit Preview** sidebar app.
- A bridge/accessory dropdown.
- A **Scan / Refresh** button.
- A room → device → entity builder.
- One-entity-at-a-time add/remove controls.
- Domain-wide include warnings, especially the “you are getting ALL switches/sensors/etc.” trap.
- Room, device, domain, and text filters.
- A live preview tab.
- A browse tab for candidate entities.
- A raw filter tab for sanity checks.
- An **Apply to HomeKit Bridge** button that writes the selected bridge filter and reloads that HomeKit entry.
- A `button.scan_homekit_preview` entity for dashboards.
- A `sensor.homekit_preview` entity with counts and preview data in attributes.
- A `homekit_preview.scan` action/service for automations.
- A persistent notification containing the same preview in Markdown.

## The important behavior

Home Assistant's HomeKit Bridge options flow behaves like this:

- If you include a domain and do not select specific entities from that domain, HomeKit gets **all supported entities in that domain**.
- If you want only some entities from a domain, select those entities explicitly and do **not** keep the domain-wide include.

The Builder follows that rule. When you click **Add** on one entity from a domain, HomeKit Preview removes the domain-wide include for that domain and switches it to selected-entity mode.

That means this workflow is now sane:

```text
HomeKit Preview
→ Build by device
→ pick room
→ pick device
→ Add the exact entities you want
→ Apply to HomeKit Bridge
```

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

## Limitations

This is still a Home Assistant-side tool, not an Apple Home emulator. Apple may rename, re-room, cache, hide, or otherwise spiritually damage things after pairing. This integration tells you what Home Assistant appears configured to offer to HomeKit.

If your HomeKit Bridge entry is YAML/import-managed, Home Assistant may overwrite UI-driven changes from YAML later.

## Development status

Useful, sharp, and still young. Built specifically because HomeKit Bridge's UI makes it too hard to answer the simple question: “what will my spouse see after scanning this QR code?”
