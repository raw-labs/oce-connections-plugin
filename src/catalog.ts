import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  actionSchema,
  connectorSchema,
  type Action,
  type Connector,
} from "./contracts.js";
import { ComposioHttp } from "./providers/composio/http.js";
import {
  array,
  invalidResponse,
  jsonValue,
  optionalText,
  record,
  text,
} from "./providers/composio/wire.js";
import { canonicalJson } from "./shared/json.js";

export function packagedCatalog(): Connector[] {
  return z
    .object({ connectors: z.array(connectorSchema) })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("../assets/catalog.json", import.meta.url),
          "utf8",
        ),
      ),
    ).connectors;
}
export class ComposioCatalog {
  private readonly cache = new Map<
    string,
    { expires: number; actions: Action[] }
  >();
  constructor(
    readonly connectors: Connector[],
    private readonly http: ComposioHttp,
  ) {}
  connector(id: string): Connector {
    const found = this.connectors.find((item) => item.id === id);
    if (!found) throw invalidResponse("not_started");
    return found;
  }
  cachedActions(id: string): Action[] | undefined {
    const cached = this.cache.get(id);
    if (cached && cached.expires > Date.now()) return cached.actions;
  }

  async actions(id: string, signal: AbortSignal): Promise<Action[]> {
    const cached = this.cachedActions(id);
    if (cached) return cached;
    const connector = this.connector(id);
    const actions: Action[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({
        toolkit_slug: connector.toolkitSlug,
        include_deprecated: "false",
        toolkit_versions: "latest",
        limit: "1000",
      });
      if (cursor) query.set("cursor", cursor);
      const response = await this.http.request({
        method: "GET",
        path: `/api/v3.1/tools?${query}`,
        signal,
      });
      if (response.missing) throw invalidResponse("not_started");
      const page = record(response.data, "not_started");
      for (const raw of array(page.items, "not_started")) {
        const tool = record(raw, "not_started");
        if (tool.is_deprecated === true || tool.is_custom === true) continue;
        const toolkit = record(tool.toolkit, "not_started");
        if (text(toolkit.slug, "not_started") !== connector.toolkitSlug)
          throw invalidResponse("not_started");
        const slug = text(tool.slug, "not_started", 256);
        if (
          !/^[A-Z][A-Z0-9_]{1,255}$/.test(slug) ||
          slug.startsWith("COMPOSIO_") ||
          /(?:^|_)(?:PROXY_EXECUTE|CUSTOM_API_CALL|RAW_API_REQUEST|RAW_HTTP_REQUEST)(?:_|$)/.test(
            slug,
          )
        )
          continue;
        const inputSchema = jsonValue(
          tool.input_parameters ?? null,
          "not_started",
        );
        const outputSchema = jsonValue(
          tool.output_parameters ?? null,
          "not_started",
        );
        const action = actionSchema.parse({
          id: slug,
          connectorId: id,
          name:
            optionalText(tool.name, "not_started") ??
            text(tool.slug, "not_started"),
          description:
            optionalText(
              tool.human_description ?? tool.description,
              "not_started",
              100_000,
            ) ?? "",
          version: text(tool.version, "not_started", 200),
          schemaDigest: createHash("sha256")
            .update(canonicalJson({ inputSchema, outputSchema }))
            .digest("hex"),
          inputSchema,
          outputSchema,
        });
        if (this.http.containsProjectKey(action))
          throw invalidResponse("not_started");
        actions.push(action);
      }
      cursor = optionalText(page.next_cursor, "not_started");
      if (
        actions.length > 50_000 ||
        seen.size >= 100 ||
        (cursor && seen.has(cursor))
      )
        throw invalidResponse("not_started");
      if (cursor) seen.add(cursor);
    } while (cursor);
    this.cache.set(id, { expires: Date.now() + 5 * 60_000, actions });
    return actions;
  }
}
