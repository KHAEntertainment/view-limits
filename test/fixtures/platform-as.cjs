'use strict';
// Test-only platform shim for the dashboard opener (Issue #136). Node gives a
// process no supported way to pretend to be another OS, and `dashboard open`
// picks its opener command from process.platform. Set VL_TEST_PLATFORM=win32 or
// =linux in the environment of a CLI run to exercise the argv shape that branch
// builds, on this machine, without launching anything real.
//
// It is installed through NODE_OPTIONS next to the dashboard fixture preload,
// and is only ever used against an ALREADY RUNNING daemon (the reuse path): the
// start path reads config, and lib/config.js also branches on the platform for
// the vault backend, which this shim must not disturb.
const target = process.env.VL_TEST_PLATFORM;
if (target) {
  Object.defineProperty(process, 'platform', { value: target, configurable: true });
}
