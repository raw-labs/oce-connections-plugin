import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ComposioCatalog } from "./catalog.js";
import { body, HttpError, parameters, send } from "./http.js";
import type { ConnectionsOAuth } from "./oauth.js";
import type { Queue } from "./queue.js";
import { canonicalJson, parseJson } from "./shared/json.js";
import {
  digest,
  type Completion,
  type Grant,
  type Receipt,
  type Store,
} from "./store.js";
import type { ConnectorProvider } from "./types/provider.js";

const slug = z.string().regex(/^[A-Z][A-Z0-9_]{1,255}$/);
const cursor = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform(Number)
  .optional();
const searchQuery = z.strictObject({
  q: z.string().max(500).optional(),
  cursor,
  limit: z
    .string()
    .regex(/^(?:[1-9]|1[0-9]|2[0-5])$/)
    .transform(Number)
    .optional(),
});
const describeQuery = z.strictObject({ id: slug });
const receiptQuery = z.strictObject({ requestId: z.uuid(), cursor });
const callSchema = z.strictObject({
  actionId: slug,
  version: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value !== "latest"),
  requestId: z.uuid(),
  arguments: z.unknown(),
});
const maximumBody = 128 * 1024;
const pageSize = 8192;

export class Actions {
  constructor(
    private readonly oauth: ConnectionsOAuth,
    private readonly store: Store,
    private readonly queue: Queue,
    private readonly catalog: ComposioCatalog,
    private readonly provider: ConnectorProvider,
  ) {}

  async search(req: IncomingMessage, res: ServerResponse, url: URL) {
    const input = parse(searchQuery, parameters(url.searchParams));
    const grant = await this.oauth.access(req.headers.authorization);
    const signal = AbortSignal.timeout(30_000);
    await this.requireActive(grant, signal);
    const actions = await this.catalog.actions(grant.connectorId, signal);
    const words = (input.q ?? "").trim().toLowerCase().split(/\s+/);
    const matching = actions.filter(({ name, description, id }) =>
      words.every((word) =>
        `${name} ${description} ${id}`.toLowerCase().includes(word),
      ),
    );
    const start = input.cursor ?? 0;
    const end = start + (input.limit ?? 10);
    const items = matching
      .slice(start, end)
      .map(({ inputSchema: _input, outputSchema: _output, ...action }) => ({
        ...action,
        description: action.description.slice(0, 500),
      }));
    await this.oauth.access(req.headers.authorization);
    send(res, 200, {
      connector: grant.connectorId,
      items,
      nextCursor: end < matching.length ? String(end) : null,
    });
  }

  async describe(req: IncomingMessage, res: ServerResponse, url: URL) {
    const { id } = parse(describeQuery, parameters(url.searchParams));
    const grant = await this.oauth.access(req.headers.authorization);
    const signal = AbortSignal.timeout(30_000);
    await this.requireActive(grant, signal);
    const actions = await this.catalog.actions(grant.connectorId, signal);
    const action = actions.find((item) => item.id === id);
    if (!action) throw new HttpError(404, "action_unavailable");
    await this.oauth.access(req.headers.authorization);
    send(res, 200, { action });
  }

  async call(req: IncomingMessage, res: ServerResponse) {
    const header = req.headers.authorization;
    const grant = await this.oauth.access(header);
    const raw = await body(req, "application/json", maximumBody);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_request");
    }
    const input = parse(callSchema, value);
    const args = parseJson(input.arguments, {
      maximumDepth: 80,
      maximumBytes: maximumBody,
      plainObjectsOnly: true,
      invalid: () => {
        throw new HttpError(400, "invalid_arguments");
      },
    });
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new HttpError(400, "invalid_arguments");
    const { actionId, requestId, version } = input;
    const requestHash = digest(
      canonicalJson({ actionId, version, arguments: args }),
    );
    const receipt = await this.queue.run(grant.id, async () => {
      await this.oauth.access(header);
      const existing = this.store.receipt(grant.id, requestId);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new HttpError(409, "request_id_conflict");
        return existing;
      }
      const signal = AbortSignal.timeout(30_000);
      const actions = await this.catalog.actions(grant.connectorId, signal);
      const action = actions.find((item) => item.id === actionId);
      if (!action) throw new HttpError(404, "action_unavailable");
      if (action.version !== version)
        throw new HttpError(409, "action_version_changed");
      await this.requireActive(grant, signal);

      // Authority is checked again after provider I/O and before the durable claim.
      this.store.pruneResults();
      await this.oauth.access(header);
      const dispatch = { actionId, requestId, version, requestHash };
      this.store.claimDispatch(grant.id, dispatch);
      let completion: Completion;
      try {
        const response = await this.provider.execute(
          { binding: grant.binding, actionId, version, arguments: args },
          AbortSignal.timeout(30_000),
        );
        if (response.status === "succeeded") {
          completion = {
            status: "succeeded",
            detail:
              response.result.kind === "unavailable"
                ? "result_unavailable"
                : null,
            result:
              response.result.kind === "inline"
                ? JSON.stringify(response.result.data)
                : null,
          };
        } else {
          completion = {
            status: response.status,
            detail: response.failure.code,
            result: null,
          };
        }
      } catch {
        completion = {
          status: "outcome_unknown",
          detail: "dispatch_unconfirmed",
          result: null,
        };
      }
      this.store.finishDispatch(grant.id, requestId, completion);
      return { ...dispatch, ...completion };
    });
    send(res, 200, presentReceipt(receipt));
  }

  async receipt(req: IncomingMessage, res: ServerResponse, url: URL) {
    const input = parse(receiptQuery, parameters(url.searchParams));
    const grant = await this.oauth.access(req.headers.authorization);
    const receipt = this.store.receipt(grant.id, input.requestId);
    if (!receipt) throw new HttpError(404, "receipt_unavailable");
    send(res, 200, presentReceipt(receipt, input.cursor));
  }

  private async requireActive(grant: Grant, signal: AbortSignal) {
    const account = await this.provider.inspectAccount(grant.binding, signal);
    if (account?.state !== "active")
      throw new HttpError(409, "account_unavailable");
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "invalid_request");
  return result.data;
}

function presentReceipt(receipt: Receipt, cursor?: number) {
  const { requestId, actionId, version, status, detail, result } = receipt;
  const metadata = { requestId, actionId, version, status, detail };
  if (cursor !== undefined) {
    if (result === null || cursor >= result.length)
      throw new HttpError(400, "invalid_result_cursor");
    const text = result.slice(cursor, cursor + pageSize);
    const next = cursor + text.length;
    return {
      ...metadata,
      result: {
        kind: "page",
        text,
        nextCursor: next < result.length ? String(next) : null,
      },
    };
  }
  if (result === null) return { ...metadata, result: null };
  if (result.length > pageSize)
    return { ...metadata, result: { kind: "paged", nextCursor: "0" } };
  const data: unknown = JSON.parse(result);
  return { ...metadata, result: { kind: "inline", data } };
}
