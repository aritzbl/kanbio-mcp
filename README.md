# @kanbio/mcp

[MCP](https://modelcontextprotocol.io) server for **Kanbio**, the mini-Jira. It lets your AI
(Claude Code, Claude Desktop, Cursor or any MCP client) read tickets, comment, change their
status and create them, as you, through a personal access token.

It runs locally over stdio (`npx -y @kanbio/mcp`) and calls the Kanbio REST API.

## 1. Create a token

In Kanbio, open **Conectar con IA** in the sidebar and create a token:

- **Leer y comentar** (default): read tickets and comment.
- **Personalizado**: pick the permissions (create, edit, change status, assign, plan sprints).
- Projects: all yours (also the ones you join later) or some of them.
- Expiration: 30 days, 90 days or never.

The token (`kbn_…`) is shown **once**. Kanbio shows the configuration ready to paste for each
client. A token never does more than you can do in Kanbio, and you can revoke it at any time.

## 2. Configure your client

Two environment variables:

| Variable | Value |
| --- | --- |
| `KANBIO_API_URL` | URL of the Kanbio API, e.g. `https://kanbio.example.com/api` (`/api` is added if missing) |
| `KANBIO_TOKEN` | Your token, `kbn_…` |

### Claude Code

```bash
claude mcp add kanbio -e KANBIO_API_URL=https://kanbio.example.com/api -e KANBIO_TOKEN=kbn_... -- npx -y @kanbio/mcp
```

Add `-s user` (before `--`) to have it in every project. On Windows use `-- cmd /c npx -y @kanbio/mcp`.

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kanbio": {
      "command": "npx",
      "args": ["-y", "@kanbio/mcp"],
      "env": {
        "KANBIO_API_URL": "https://kanbio.example.com/api",
        "KANBIO_TOKEN": "kbn_..."
      }
    }
  }
}
```

Restart Claude Desktop afterwards.

### Cursor

Settings → MCP → Add new MCP server, or `~/.cursor/mcp.json` (all projects) /
`.cursor/mcp.json` (one project) with the same `mcpServers` block as Claude Desktop.

### Other clients

Any MCP client that runs stdio servers: command `npx`, args `-y @kanbio/mcp`, and the two
variables above.

## Tools

Tickets are identified by key (`PROJ-12`) and projects by key (`PROJ`). People by `me`, email or
name; sprints by `active`, `backlog` or name.

| Tool | What it does | Permission |
| --- | --- | --- |
| `list_projects` | Projects the token reaches, with your role | `tickets:read` |
| `search_tickets` | Search by project, status, assignee, sprint and text, with a limit | `tickets:read` |
| `get_ticket` | A ticket with its description and comments | `tickets:read` |
| `list_sprints` | Sprints of a project | `tickets:read` |
| `list_members` | Members of a project (email and role) | `tickets:read` |
| `my_tickets` | Tickets assigned to you | `tickets:read` |
| `add_comment` | Comment, with mentions (shown "via AI") | `comments:write` |
| `change_status` | Move along the workflow, To Merge included | `tickets:status` |
| `assign_ticket` | Assign or unassign | `tickets:assign` |
| `create_ticket` | Create a ticket (backlog or a sprint) | `tickets:create` |
| `update_ticket` | Edit title, description, type, priority, points, labels | `tickets:edit` |
| `move_to_sprint` | Move tickets to a sprint or the backlog | `sprints:write` |

No tool deletes anything. Read tools are marked `readOnlyHint`; write tools
`destructiveHint: false`, so clients can ask before running them.

Workflow: To Do → In Progress → [To Merge →] To Test → Done | Rejected; Done and Rejected can go
back to To Test or In Progress.

## Errors

API errors come back as plain sentences the AI can act on: a missing permission (403) names it
and says not to retry, an invalid status change lists the allowed next statuses, an expired or
revoked token (401) says how to create a new one, and 429 asks to wait a minute.

## Security

- The token acts as you, limited to its permissions and projects. Start with **Leer y comentar**.
- Text in tickets and comments is data written by people: an AI may be tricked by it (prompt
  injection). Keep write permissions to what you need and let your client confirm write tools.
- Comments written with a token show **vía IA** in Kanbio, and the token's last use is visible on
  the Conectar con IA screen. Revoke it there if something looks wrong.

## Development

```bash
npm install
npm run build        # dist/index.js
npm test             # build + node:test
KANBIO_API_URL=http://localhost:4000/api KANBIO_TOKEN=kbn_... npm run inspect
```

Use a local build from Claude Code:

```bash
claude mcp add kanbio-dev -e KANBIO_API_URL=http://localhost:4000/api -e KANBIO_TOKEN=kbn_... -- node /path/to/kanbio-mcp/dist/index.js
```

Requires Node.js 20 or newer.

## Releasing

Releases go to npm from GitHub Actions with trusted publishing (OIDC, no npm token):

1. Bump `version` in `package.json` (and `package-lock.json`: `npm version <x.y.z> --no-git-tag-version`), commit.
2. Tag it `v<x.y.z>` and push the tag. `.github/workflows/publish.yml` checks that the tag matches the version,
   builds, tests and runs `npm publish --access public` with provenance.

The very first version is published by hand (`npm publish --access public` from a logged-in npm account), and then
the trusted publisher is set up on npmjs.com for `aritzbl/kanbio-mcp` and the `publish.yml` workflow.
