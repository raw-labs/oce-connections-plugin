import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function parameters(values: URLSearchParams): Record<string, string> {
  if (values.size !== new Set(values.keys()).size)
    throw new HttpError(400, "invalid_request");
  return Object.fromEntries(values);
}

export async function body(
  request: IncomingMessage,
  contentType: string,
  limit: number,
): Promise<string> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== contentType)
    throw new HttpError(415, "invalid_request");
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Keep the connection available for a 413 response when the limit is hit.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new HttpError(400, "invalid_request");
    bytes += chunk.length;
    if (bytes > limit) {
      request.resume();
      throw new HttpError(413, "request_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function send(
  response: ServerResponse,
  status: number,
  payload?: unknown,
) {
  response.statusCode = status;
  if (payload === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

export function redirect(response: ServerResponse, location: string) {
  response.setHeader("location", location);
  send(response, 302);
}
