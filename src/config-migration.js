'use strict';
const fs = require('fs');

// Preserve the original bytes for recovery before electron-store starts.
// If the move fails, let startup fail instead of overwriting the only copy.
function quarantineUnreadableConfig(configPath, logger = console.log) {
  if (!fs.existsSync(configPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid config object');
    return null;
  } catch {
    const prefix = `${configPath}.broken-${Date.now()}`;
    let backup = prefix;
    let suffix = 0;
    while (fs.existsSync(backup)) backup = `${prefix}-${++suffix}`;
    fs.renameSync(configPath, backup);
    logger('[Migration] Preserved unreadable config at', backup);
    return backup;
  }
}

module.exports = { quarantineUnreadableConfig };
