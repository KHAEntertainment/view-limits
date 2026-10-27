---
name: view-limits-setup-xiaomi
description: Set up the Xiaomi Token Plan route in view-limits — builds the Chrome cookie helper and selects the Chrome profile. Use when asked to add or repair Xiaomi monitoring, or when a report says the Chrome key helper is unavailable.
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" setup xiaomi-token-plan --relay
```

Relay the output above verbatim.

This is the Xiaomi route's own setup, and it takes no argument: the route id is
written into the command rather than passed to it. It appends the opt-in
`xiaomi-token-plan` route, builds and installs the read-only Chrome key helper,
and saves the Chrome profile and console source it used. Xiaomi reads console
cookies, so there is no key to enter and nothing to type into chat; the keys of
other providers are set through the Claude `/view-limits:setup` and
`/view-limits:update` commands, or `vl.js setup` and `vl.js update` here.

Expect a macOS keychain dialog the first time: click "Always Allow", not
"Allow", or the next read is denied and the report says so. The route is
macOS-only. A failed setup is reported rather than half-applied — the helper
build, the grant and the config commit happen in one hold of the provider
mutation lock, so a failure leaves the previous selection in place and the route
unmonitored. For a non-default Chrome profile or console path, use the terminal
form, which takes the options: `vl.js setup xiaomi-token-plan --profile "Profile 1"`.
