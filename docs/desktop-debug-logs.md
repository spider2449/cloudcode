# Desktop debug logs

Desktop diagnostics are enabled by default. Open **Help > Open Debug Log
Folder** and copy `desktop-debug.jsonl` and its `.1` / `.2` rotated files
after a failure. On Windows the folder is normally
`%TEMP%\cloudcode\logs`. The path uses Node's environment temporary-directory
resolution (`TEMP`, then `TMP` on Windows, with the system fallback); the
menu opens that actual path. Existing logs in userData are not moved.

Each file is capped at 2 MiB, with up to three files retained. Records include
application and runtime versions, OS build, architecture, backend lifecycle,
renderer/GPU termination reasons, load failures, orderly window shutdown,
and process memory samples every 15 seconds. Backend stderr records contain
only byte counts and an out-of-memory indicator, not raw text. Console
errors record only their occurrence and line number. Error records contain
names and codes, not messages or stacks. Chat content, tool output, API keys,
and environment values are not logged.

Set `CLOUDCODE_DESKTOP_DEBUG=0` before launching to disable these logs.
Logging write failures do not interrupt the application. A hard native
crash, forced termination, or power loss may leave no final event; the last
heartbeat is evidence of activity, not a definitive crash cause. These logs
are not native crash dumps and do not establish that a crash is fixed.

When reporting a failure, include these files, the approximate failure time,
the action immediately before it, and whether the window disappeared or
only chat stopped responding. Logs remain local and are not uploaded.
