'use strict';

// relay: address of the relay Worker in worker/ (README.md, step 1).
window.APP_CONFIG = {
  relay: location.hostname === 'localhost' ? 'http://localhost:8789' : 'https://signalglass.tokglass.workers.dev',
};
