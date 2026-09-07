'use strict';
const { app } = require('electron');
const { startWithLinuxCompatibility } = require('./src/linux-compatibility');

// Wait for the AppImage handoff before opening stores or taking the profile's
// instance lock. A failed spawn resumes normal startup in this process.
startWithLinuxCompatibility({ app, start: () => require('./main') });
