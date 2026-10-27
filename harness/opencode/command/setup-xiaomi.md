---
description: Set up the view-limits Xiaomi Token Plan route (Chrome cookie helper and profile)
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" setup xiaomi-token-plan --relay
```

Relay the output above verbatim.

This file runs no shell command of its own: OpenCode appends any argument the user
supplies to the command template and only then scans the result for
bang-backtick shell commands to execute, so an injected template can be made to
run a second command the user typed. The root resolution is the one expansion
here, and this command takes no argument — the Xiaomi route id is written into the
fixed call rather than passed to it.

`setup xiaomi-token-plan` appends the opt-in route, builds and installs the
read-only Chrome key helper, and saves the Chrome profile and console source it
used. Xiaomi reads console cookies, so there is no key to enter and nothing to
type into chat. Expect a macOS keychain dialog the first time: "Always Allow", not
"Allow". A failed setup leaves the previous selection in place and the route
unmonitored. For a non-default profile or console path, use the terminal form,
which takes the options: `vl.js setup xiaomi-token-plan --profile "Profile 1"`.
