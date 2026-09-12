#!/usr/bin/env node
// Built-in Home Assistant MCP server for the Agent Terminal add-on.
// Talks to Core through the Supervisor proxy (http://supervisor/core/api)
// using the add-on's SUPERVISOR_TOKEN - no long-lived token needed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";

const BASE = process.env.HA_API_BASE || "http://supervisor/core/api";

function token() {
  if (process.env.SUPERVISOR_TOKEN) return process.env.SUPERVISOR_TOKEN;
  try {
    return readFileSync(
      "/run/s6/container_environment/SUPERVISOR_TOKEN",
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

async function ha(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HA ${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const ok = (data) => ({
  content: [
    {
      type: "text",
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    },
  ],
});
const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: String(err?.message || err) }],
});

const server = new McpServer({ name: "homeassistant", version: "1.0.0" });

server.tool(
  "ha_list_entities",
  "List Home Assistant entities with their current state. Optionally filter by " +
    "domain (e.g. 'light', 'sensor') and/or a case-insensitive substring matched " +
    "against entity_id or friendly name.",
  {
    domain: z.string().optional(),
    search: z.string().optional(),
    limit: z.number().int().positive().max(2000).optional(),
  },
  async ({ domain, search, limit = 250 }) => {
    try {
      const states = await ha("/states");
      let rows = states.map((s) => ({
        entity_id: s.entity_id,
        state: s.state,
        name: s.attributes?.friendly_name ?? null,
      }));
      if (domain) rows = rows.filter((r) => r.entity_id.startsWith(`${domain}.`));
      if (search) {
        const q = search.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.entity_id.toLowerCase().includes(q) ||
            (r.name && r.name.toLowerCase().includes(q)),
        );
      }
      return ok({ count: rows.length, entities: rows.slice(0, limit) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "ha_get_entity_state",
  "Get the full state object (state, all attributes, last_changed/last_updated) " +
    "for a single entity.",
  { entity_id: z.string() },
  async ({ entity_id }) => {
    try {
      return ok(await ha(`/states/${encodeURIComponent(entity_id)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "ha_call_service",
  "Call a Home Assistant service. Example: domain='light', service='turn_on', " +
    "data={ brightness_pct: 60 }, target={ entity_id: 'light.kitchen' }. " +
    "target keys (entity_id / area_id / device_id) are merged into the request " +
    "body. THIS CHANGES REAL HOME STATE.",
  {
    domain: z.string(),
    service: z.string(),
    data: z.record(z.any()).optional(),
    target: z.record(z.any()).optional(),
  },
  async ({ domain, service, data = {}, target = {} }) => {
    try {
      const payload = { ...data, ...target };
      return ok(
        await ha(`/services/${domain}/${service}`, {
          method: "POST",
          body: payload,
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "ha_render_template",
  "Render a Jinja2 template against live Home Assistant state; returns the " +
    "rendered string. Useful for testing template sensors/automations.",
  { template: z.string() },
  async ({ template }) => {
    try {
      return ok(await ha("/template", { method: "POST", body: { template } }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "ha_list_services",
  "List callable services, optionally narrowed to one domain.",
  { domain: z.string().optional() },
  async ({ domain }) => {
    try {
      const all = await ha("/services");
      return ok(domain ? all.filter((d) => d.domain === domain) : all);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "ha_get_error_log",
  "Return the current Home Assistant error log as text.",
  {},
  async () => {
    try {
      return ok(await ha("/error_log"));
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
