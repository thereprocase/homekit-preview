from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from .const import CONF_CREATE_NOTIFICATION, DEFAULT_CREATE_NOTIFICATION, DOMAIN


class HomeKitPreviewConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Config flow for HomeKit Preview."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial setup step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title="HomeKit Preview", data=user_input)

        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_CREATE_NOTIFICATION,
                    default=DEFAULT_CREATE_NOTIFICATION,
                ): bool,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors={})

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        """Return the options flow."""
        return HomeKitPreviewOptionsFlow(config_entry)


class HomeKitPreviewOptionsFlow(config_entries.OptionsFlow):
    """Options flow for HomeKit Preview."""

    def __init__(self, config_entry):
        self.config_entry = config_entry

    async def async_step_init(self, user_input=None):
        """Manage options."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_CREATE_NOTIFICATION,
                    default=self.config_entry.options.get(
                        CONF_CREATE_NOTIFICATION,
                        self.config_entry.data.get(
                            CONF_CREATE_NOTIFICATION,
                            DEFAULT_CREATE_NOTIFICATION,
                        ),
                    ),
                ): bool,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
