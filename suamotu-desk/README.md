# suamotu-desk

Notion worker for the Company OS **Service desk**. It files requests already
triaged by the rules in the skill *Triage a Service desk request*, and shows
each operating unit its queue.

Worker ID: `01a12b2a-28b0-755d-91b1-35b224a0c953` (workspace: Positive Coaching's Space)

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `serviceDeskDueDate` | Due date from priority + arrival date (P1 same day, P2 Friday of that week, P3 +20 working days). An earlier needed-by date wins. | No |
| `fileRequest` | Creates a Service desk request with owner unit (from type), due date, classification and a `Triage:` note; Status = Triaged. Refuses requests containing health details. | Yes |
| `myQueue` | Open requests (New, Triaged, In progress) for one unit, overdue and P1 first. | No |

Routing table (type → owner unit): Client request → Mercato · Bug, Access request → Piattaforma ·
Feature idea → Marca & Prodotto · Purchase, Data request → Operazioni.

## Use it on its own

```sh
ntn workers exec myQueue -d '{"unit":"Piattaforma","limit":10}'
ntn workers exec fileRequest -d '{"request":"Canva Pro licence for the content team","type":"Purchase","priority":"P3 later","notes":null,"neededBy":null,"channel":null}'
ntn workers exec serviceDeskDueDate -d '{"priority":"P2 this week","created":null,"neededBy":null}'
```

## Use it from a Custom Agent

Add the worker's tools to the agent in Notion. When an agent calls a tool, Notion
authenticates it with the agent's own permissions, so nothing else is needed.

## Setup for running it on its own

`ntn workers exec` needs a Notion integration token stored on the worker, and the
integration must be connected to the Company OS databases (Service desk, Operating units):

```sh
ntn workers env set --worker-id 01a12b2a-28b0-755d-91b1-35b224a0c953 NOTION_API_TOKEN="$NOTION_API_TOKEN"
```

## Develop

```sh
npm install
npm run check   # typecheck
npm test        # rule tests (dates, routing, classification)
ntn workers deploy
```

If the triage skill in Notion changes, update `src/rules.ts` to match.
