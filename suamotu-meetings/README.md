# suamotu-meetings

Notion worker for **Meetings and rituals**. It turns the actions written in a
meeting into tracked work and lists what is still open.

Worker ID: `01a12b2a-997d-74f4-a109-ebd94a79a3dc` (workspace: Positive Coaching's Space)

## How to write actions in a meeting

One action per line in the meeting's **Actions** field:

```
Task · Engineering: finish the check-in form · 20/10 · epic: Check-in
Desk · Operazioni: buy a Canva Pro licence · 17/10 · P2
```

- `Task` (or `Attività`) → a page in **App Tasks**, Status Backlog. The owner is an app squad
  (Engineering, Quality, Product, Design, Coaching content, Privacy and legal, Launch and marketing,
  Client care) or a unit with a single squad (Operazioni → Privacy and legal).
  `epic: <name>` links the task to that epic.
- `Desk` (or `Richiesta`) → a request in the **Service desk**. The owner is a unit. The type
  is recognised from the words (buy → Purchase, access → Access request, bug → Bug, data → Data
  request, idea → Feature idea, client → Client request). Priority comes from `P1`/`P2`/`P3` or the date.
- Dates: `20/10`, `20/10/2026` or `2026-10-20`.
- Each item gets "From meeting: <meeting>" in its Notes. Anything the worker cannot read fully is
  still created and marked `Check: …`. A line with no prefix becomes a Task and is flagged.
- Lines with health details are not created (they must not be stored in Notion).

After it runs, the meeting page gets an "Actions created" list with links, and its Status becomes
**Actions assigned**. Running it again on the same meeting does nothing unless `force` is set.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `meetingToActions` | Creates the tasks and requests for one meeting. `dryRun: true` previews without writing. | Yes |
| `openActions` | Unfinished actions that came from meetings, overdue first. Filter by unit or overdue only. | No |

## Use it on its own

```sh
ntn workers exec meetingToActions -d '{"meeting":"<meeting page link>","dryRun":true,"force":null}'
ntn workers exec meetingToActions -d '{"meeting":"<meeting page link>","dryRun":null,"force":null}'
ntn workers exec openActions -d '{"unit":null,"overdueOnly":null}'
```

## Use it from a Custom Agent

Add the worker's tools to the agent (for example the Monday review or Status Writer agent).
Notion authenticates tool calls with the agent's own permissions.

## Setup for running it on its own

`ntn workers exec` needs a Notion integration token stored on the worker, and the integration must be
connected to Meetings and rituals, App Tasks, Epics, Service desk and Operating units:

```sh
ntn workers env set --worker-id 01a12b2a-997d-74f4-a109-ebd94a79a3dc NOTION_API_TOKEN="$NOTION_API_TOKEN"
```

## Develop

```sh
npm install
npm run check   # typecheck
npm test        # parser tests
ntn workers deploy
```

`src/rules.ts` and `src/dates.ts` are shared with `suamotu-desk`; keep them identical.
