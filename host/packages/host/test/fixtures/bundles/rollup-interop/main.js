'use strict';
// rollover-daily-todos' shape: a rollup bundle that reaches the module through a
// default-interop wrapper and reads `window.app` and `window.moment` while its
// own module is still evaluating.
var obsidian = require('obsidian');
function _interopDefault(e) { return e && e.__esModule ? e : { 'default': e }; }
var obsidian__default = _interopDefault(obsidian);
class RollupPlugin extends obsidian.Plugin {
  async onload() {
    this.sawTFile = obsidian__default['default'].TFile;
    this.sawWindowApp = window.app;
    this.sawMoment = typeof window.moment;
  }
}
module.exports = RollupPlugin;
