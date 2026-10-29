#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KanbioClient, readConfig } from './client.js';
import { Kanbio } from './kanbio.js';
import { registerTools } from './tools.js';

const { version } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

const server = new McpServer(
  { name: 'kanbio', version },
  {
    instructions:
      'Kanbio is a mini-Jira. Tickets are identified by key (PROJ-12) and projects by key (PROJ). Use list_projects first when the project is unknown, get_ticket to read a ticket with its comments, and search_tickets or my_tickets to find work. Write tools act as the token owner; none of them deletes. When a tool answers with a permission error, do not retry: tell the user which permission the token lacks.',
  },
);

const { config, problems } = readConfig(process.env);
if (config) {
  registerTools(
    server,
    new Kanbio(new KanbioClient(config, `kanbio-mcp/${version}`)),
  );
} else {
  // Start anyway, so the client shows the server and the AI can explain
  // what is missing instead of a silent crash.
  for (const problem of problems) process.stderr.write(`kanbio-mcp: ${problem}\n`);
  server.registerTool(
    'kanbio_setup_help',
    {
      title: 'Kanbio setup problem',
      description:
        'kanbio-mcp is not configured. Call this to see what is missing.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => ({
      content: [{ type: 'text', text: problems.join('\n') }],
      isError: true,
    }),
  );
}

await server.connect(new StdioServerTransport());
