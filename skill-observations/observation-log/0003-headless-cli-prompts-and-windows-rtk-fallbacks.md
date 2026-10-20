---
id: 3
title: "Headless CLI execution requires auto-confirm flags and Windows-aware RTK binary routing"
status: open
type: open-source
skill: [rtk, graft]
proposes_skill: []
target_file: []
siblings_checked: "none"
area: "tool execution & cross-platform agent workflows"
date: 2026-10-20
session_context: "Executing graft init and rtk file exploration in Windows subshell environment"
parked_until: ""
resolved: ""
resolution: ""
reference: ""
commands_verified: "run: rtk graft init --yes (passed), rtk ls (failed: no ls in PATH)"
---

**Issue:** In automated agent subshell execution on Windows, two friction points frequently occur: (1) CLI tools expecting interactive confirmation (like `graft init`) abort silently without a TTY unless explicitly passed `--yes` or target parameters; (2) token proxy tools (`rtk`) that forward commands like `ls` to OS binaries fail on standard Windows environments where GNU coreutils are absent from PATH.

**Suggested improvement:** In non-interactive subshell runs, always supply auto-confirm flags (`--yes`, `-y`) on CLI initialization commands. On Windows environments, route directory and file queries through native shell cmdlets or built-in file tools instead of Unix-proxied aliases.

**Principle:** Tool execution in agent subshells must always default to non-interactive mode, and platform-specific binary dependencies must be checked before delegating to Unix-centric CLI proxies.
