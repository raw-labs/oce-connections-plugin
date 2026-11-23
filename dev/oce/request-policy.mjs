const paths = new Set([
  "GET /v1/actions",
  "GET /v1/action",
  "GET /v1/calls",
  "POST /v1/calls",
]);
const headers = new Set([
  "accept",
  "accept-encoding",
  "user-agent",
  "content-type",
]);
const slug = /^[A-Z][A-Z0-9_]{1,255}$/;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cursor = /^\d{1,9}$/;
const limit = /^(?:[1-9]|1[0-9]|2[0-5])$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function validQuery(path, raw) {
  if (raw.length > 8192 || /%(?![0-9a-fA-F]{2})/.test(raw)) return false;
  const decoded = new URLSearchParams(raw);
  const params = new Map(decoded);
  if (params.size !== decoded.size) return false;
  if (path === "/v1/action")
    return params.size === 1 && slug.test(params.get("id") ?? "");
  if (path === "/v1/calls")
    return (
      uuid.test(params.get("requestId") ?? "") &&
      [...params.keys()].every(
        (key) => key === "requestId" || key === "cursor",
      ) &&
      (!params.has("cursor") || cursor.test(params.get("cursor")))
    );
  return [...params].every(([key, value]) => {
    if (key === "q")
      return value.length <= 500 && !/[\p{Cc}\uFFFD]/u.test(value);
    if (key === "cursor") return cursor.test(value);
    if (key === "limit") return limit.test(value);
    return false;
  });
}

function validBody(body) {
  if (body.length === 0 || body.length > 128 * 1024) return false;
  const value = JSON.parse(decoder.decode(body));
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { requestId, actionId, version, arguments: args } = value;
  return (
    Object.keys(value).length === 4 &&
    typeof requestId === "string" &&
    uuid.test(requestId) &&
    typeof actionId === "string" &&
    slug.test(actionId) &&
    typeof version === "string" &&
    version.length > 0 &&
    version.length <= 200 &&
    version !== "latest" &&
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args)
  );
}

export function createConnectionsRequestPolicy(registration) {
  const { releaseSha256, host, requestScope } = registration;
  function acceptsScope(raw) {
    try {
      const scope = JSON.parse(raw);
      return (
        Object.keys(scope).length === 4 &&
        scope.host === host &&
        scope.port === 443 &&
        scope.path === "/v1/**" &&
        Array.isArray(scope.scopes) &&
        scope.scopes.length === 1 &&
        scope.scopes[0] === "connections" &&
        requestScope ===
          JSON.stringify({
            host: scope.host,
            port: scope.port,
            path: scope.path,
            scopes: scope.scopes,
          })
      );
    } catch {
      return false;
    }
  }
  return {
    releaseSha256,
    acceptsScope,
    allows(request) {
      try {
        if (
          request.bindingId !== releaseSha256 ||
          !acceptsScope(request.bindingConfig)
        )
          return false;
        const {
          host: requestedHost,
          method,
          path,
          port,
          query,
          reportedScheme,
        } = request.target;
        if (
          requestedHost !== host ||
          port !== 443 ||
          reportedScheme !== "https" ||
          !paths.has(`${method} ${path}`)
        )
          return false;
        const fields = new Map(request.headers);
        if (
          fields.size !== request.headers.length ||
          [...fields.keys()].some((name) => !headers.has(name))
        )
          return false;
        if (method === "GET")
          return (
            !request.body.length &&
            !fields.has("content-type") &&
            validQuery(path, query)
          );
        return (
          !query &&
          fields.get("content-type") === "application/json" &&
          validBody(request.body)
        );
      } catch {
        return false;
      }
    },
  };
}

// Call before the OCE guard computes its advertised policy-set version.
export function registerConnectionsRequestPolicies(
  releasedPolicies,
  registrations,
) {
  for (const registration of registrations) {
    if (releasedPolicies.has(registration.releaseSha256))
      throw new Error("Connections release policy is already registered.");
    releasedPolicies.set(
      registration.releaseSha256,
      createConnectionsRequestPolicy(registration),
    );
  }
}
