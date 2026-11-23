import { z } from "zod";

const id = z.string().trim().min(1).max(256);
export const bindingSchema = z.strictObject({
  accountId: id,
  subjectId: id,
  toolkit: id,
  authConfigurationId: id,
});
export const connectorSchema = z.strictObject({
  id,
  toolkitSlug: id,
  name: z.string(),
  description: z.string(),
  category: z.string(),
  iconUrl: z.string(),
  auth: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("managed") }),
    z.strictObject({ kind: z.literal("custom"), scheme: id }),
  ]),
});
export type Connector = z.infer<typeof connectorSchema>;
export const actionSchema = z.strictObject({
  id,
  connectorId: id,
  name: z.string(),
  description: z.string(),
  version: id.refine(
    (v) => v !== "latest",
    "An exact action version is required.",
  ),
  schemaDigest: z.string(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
});
export type Action = z.infer<typeof actionSchema>;
