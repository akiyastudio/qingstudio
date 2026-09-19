/** @deprecated Import the generic helper through this compatibility path only for old tests/adapters. */
const { adoptLegacyOutputV1 } = require('../services/component-project-capabilities.cjs');
module.exports = { adoptDeprecatedV1OutputReceipt: adoptLegacyOutputV1 };
