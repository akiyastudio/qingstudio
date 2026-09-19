const PLUGIN_DEFINITIONS = Object.freeze({});

const findPluginByCapability = capability => Object.values(PLUGIN_DEFINITIONS)
  .find(definition => definition.capabilities.includes(capability));

module.exports = { PLUGIN_DEFINITIONS, findPluginByCapability };
