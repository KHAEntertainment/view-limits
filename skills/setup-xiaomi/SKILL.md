---
name: setup-xiaomi
description: Set up the Xiaomi Token Plan route — builds the Chrome cookie helper and selects the Chrome profile and console source. Xiaomi reads console cookies rather than a pasted key, so it has its own command.
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" setup xiaomi-token-plan --relay 2>&1`

Relay the output above verbatim.

This is the Xiaomi route's own setup, and it takes no argument: the route id is
written into the command, so nothing the user types reaches the shell. It appends
the opt-in `xiaomi-token-plan` route, builds and installs the read-only Chrome
key helper, and saves the Chrome profile and console source it used. There is no
key to paste and nothing to type into chat — Xiaomi credentials come from the
browser session, and the keys of every other provider go through
`/view-limits:setup` or `/view-limits:update`.

Expect a macOS keychain dialog the first time: click "Always Allow", not
"Allow", or the next read will be denied and the report will say so. The route is
macOS-only, and a failure here is reported rather than half-applied: a helper that
cannot be built leaves the previous selection in place, and the route stays
unmonitored until setup succeeds. To point at a non-default Chrome profile or
console path, use the terminal form, which takes the options:
`vl.js setup xiaomi-token-plan --profile "Profile 1"`.
