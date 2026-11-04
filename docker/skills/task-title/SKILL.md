---
name: task-title
description: Give this task a short, specific title through the task-title helper. Use once you have understood what the task is really about, and again only if the work turns out to be about something else. The title is what the user sees in the task list and header. Never replaces a title the user set.
---

# Task title through the task-title helper

The task has a title the user sees in the board's task list and header. Until you set one it shows the
first line of the request. Once you understand the work, replace it with a concise title: up to 120
characters, saying what is being done ("Fix redirect loop after login"), not repeating the request
or a ticket key alone. Set it again only if the work turns out to be about something else.

```bash
node /usr/local/share/factory-skills/task-title/task-title.cjs "Fix redirect loop after login"
```

Pass the title as the one argument, never through an environment variable. The helper uses the lease
this attempt holds now and prints one JSON line.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | The board answered. `"updated": true` set it; `"updated": false` means the title was already that, or a person set one (`"reason": "user_title"`) | Nothing; never retry a user title |
| 1 | The board refused (bad title, the attempt is over, or too many changes this attempt) | Do not retry with the same input |
| 2 | No attempt credential or bad usage | Do not retry |
| 4 | Unknown: the board did not confirm | The title may or may not have changed; retry once later if it matters |

Never treat exit 4 as "unchanged". A title is a courtesy: if setting it fails, continue the task.

## After an issue read

When an integration read of a tracker issue succeeds and the title is still generic, set it from the
issue's actionable subject, concise and not the whole description. Only when the read succeeded: a missing
or failed lookup is never a reason to call the helper with a guessed subject, and it never blocks the task.
