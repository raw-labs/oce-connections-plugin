import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import oauthProtocol from "../assets/oauth.json" with { type: "json" };
import { bindingSchema } from "./contracts.js";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const authorizationSchema = z.strictObject({
  client_id: z.string().min(1).max(256),
  redirect_uri: z.string().min(1).max(2048),
  response_type: z.literal("code"),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().regex(/^[\x21-\x7e]{1,2048}$/),
  scope: z.literal(oauthProtocol.scope).optional(),
});
export type Authorization = z.infer<typeof authorizationSchema>;

const enrollmentSchema = z.object({
  ticketHash: z.string(),
  connectorId: z.string(),
  request: authorizationSchema,
  expiresAt: z.number(),
  binding: bindingSchema.nullable(),
});
type Enrollment = z.infer<typeof enrollmentSchema>;

export const grantSchema = z.object({
  id: z.uuid(),
  clientId: z.string(),
  connectorId: z.string(),
  binding: bindingSchema,
});
export type Grant = z.infer<typeof grantSchema>;

const codeSchema = z.object({
  grantId: z.uuid(),
  clientId: z.string(),
  expiresAt: z.number(),
  redirectUri: z.string(),
  challenge: z.string(),
});
type Code = z.infer<typeof codeSchema>;
const credentialSchema = z.object({
  grantId: z.uuid(),
  clientId: z.string(),
  expiresAt: z.number(),
});
type Credential = z.infer<typeof credentialSchema>;

const receiptSchema = z.object({
  requestId: z.uuid(),
  requestHash: z.string(),
  actionId: z.string(),
  version: z.string(),
  status: z.enum(["dispatching", "succeeded", "rejected", "outcome_unknown"]),
  detail: z.string().nullable(),
  result: z.string().nullable(),
});
export type Receipt = z.infer<typeof receiptSchema>;
export type Completion = Pick<Receipt, "detail" | "result"> & {
  status: Exclude<Receipt["status"], "dispatching">;
};

const receiptRetention = 7 * 86400_000;
const maximumPendingEnrollments = 32;

export class Store {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    const db = new DatabaseSync(file);
    try {
      // An instance owns this database until close. Recovery must never mark
      // another instance's live dispatch as interrupted.
      db.exec(`
        PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA foreign_keys = ON;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS enrollments (
          id TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL, connector_id TEXT NOT NULL,
          request TEXT NOT NULL, expires_at INTEGER NOT NULL, binding TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS grants (
          id TEXT PRIMARY KEY, client_id TEXT NOT NULL, connector_id TEXT NOT NULL,
          account_id TEXT UNIQUE NOT NULL, binding TEXT NOT NULL, revoked_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS codes (
          hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id),
          expires_at INTEGER NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS credentials (
          hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id),
          kind TEXT CHECK(kind IN ('access', 'refresh')) NOT NULL,
          expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS receipts (
          grant_id TEXT NOT NULL REFERENCES grants(id),
          request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          action_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL,
          expires_at INTEGER NOT NULL, detail TEXT, result TEXT,
          PRIMARY KEY (grant_id, request_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS receipts_by_request ON receipts (grant_id, request_id COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS receipt_results_expiry ON receipts (expires_at)
          WHERE result IS NOT NULL;
        CREATE INDEX IF NOT EXISTS enrollment_expiry ON enrollments (expires_at);
        CREATE INDEX IF NOT EXISTS code_expiry ON codes (expires_at);
        CREATE INDEX IF NOT EXISTS credential_expiry ON credentials (expires_at);
        UPDATE receipts SET status = 'outcome_unknown', detail = 'dispatch_interrupted'
          WHERE status = 'dispatching';
        COMMIT;
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
  }

  close() {
    this.#db.close();
  }

  transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  startEnrollment(id: string, enrollment: Omit<Enrollment, "binding">) {
    this.pruneOAuth();
    return (
      this.#db
        .prepare(
          `INSERT INTO enrollments (id, ticket_hash, connector_id, request, expires_at)
           SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM enrollments) < ?`,
        )
        .run(
          id,
          enrollment.ticketHash,
          enrollment.connectorId,
          JSON.stringify(enrollment.request),
          enrollment.expiresAt,
          maximumPendingEnrollments,
        ).changes === 1
    );
  }

  setEnrollmentBinding(
    id: string,
    binding: Grant["binding"],
    expiresAt: number,
  ) {
    this.#db
      .prepare(
        "UPDATE enrollments SET binding = ?, expires_at = min(expires_at, ?) WHERE id = ?",
      )
      .run(JSON.stringify(binding), expiresAt, id);
  }

  enrollment(id: string, ticket: string): Enrollment | undefined {
    const row = this.#db
      .prepare(
        `SELECT ticket_hash AS ticketHash, connector_id AS connectorId, request,
        expires_at AS expiresAt, binding FROM enrollments
        WHERE id = ? AND ticket_hash = ? AND expires_at > ?`,
      )
      .get(id, digest(ticket), Date.now());
    if (!row) return;
    return enrollmentSchema.parse({
      ...row,
      request: JSON.parse(z.string().parse(row.request)),
      binding:
        row.binding === null ? null : JSON.parse(z.string().parse(row.binding)),
    });
  }

  saveCode(
    grant: Grant,
    ticketHash: string,
    code: string,
    details: Omit<Code, "clientId" | "grantId">,
  ): boolean {
    return this.transaction(() => {
      const consumed = this.#db
        .prepare(
          "DELETE FROM enrollments WHERE id = ? AND ticket_hash = ? AND expires_at > ?",
        )
        .run(grant.id, ticketHash, Date.now());
      if (consumed.changes !== 1) return false;
      this.#db
        .prepare("INSERT INTO grants VALUES (?, ?, ?, ?, ?, NULL)")
        .run(
          grant.id,
          grant.clientId,
          grant.connectorId,
          grant.binding.accountId,
          JSON.stringify(grant.binding),
        );
      this.#db
        .prepare("INSERT INTO codes VALUES (?, ?, ?, ?, ?)")
        .run(
          digest(code),
          grant.id,
          details.expiresAt,
          details.redirectUri,
          details.challenge,
        );
      return true;
    });
  }

  code(value: string): Code | undefined {
    const row = this.#db
      .prepare(
        `SELECT grant_id AS grantId, client_id AS clientId, expires_at AS expiresAt,
        redirect_uri AS redirectUri, challenge FROM codes
        JOIN grants ON grants.id = codes.grant_id WHERE hash = ? AND revoked_at IS NULL`,
      )
      .get(digest(value));
    return row && codeSchema.parse(row);
  }

  consumeCode(value: string): boolean {
    return (
      this.#db.prepare("DELETE FROM codes WHERE hash = ?").run(digest(value))
        .changes === 1
    );
  }

  saveTokens(
    grantId: string,
    clientId: string,
    access: string,
    accessExpiry: number,
    refresh: string,
    refreshExpiry: number,
  ): boolean {
    return this.transaction(() => {
      if (!this.grant(grantId, clientId)) return false;
      const insert = this.#db.prepare(
        "INSERT INTO credentials (hash, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)",
      );
      insert.run(digest(access), grantId, "access", accessExpiry);
      insert.run(digest(refresh), grantId, "refresh", refreshExpiry);
      return true;
    });
  }

  credential(
    kind: "access" | "refresh",
    value: string,
  ): Credential | undefined {
    const row = this.#db
      .prepare(
        `SELECT grant_id AS grantId, client_id AS clientId, expires_at AS expiresAt
        FROM credentials JOIN grants ON grants.id = credentials.grant_id
        WHERE hash = ? AND kind = ? AND consumed = 0 AND expires_at > ? AND revoked_at IS NULL`,
      )
      .get(digest(value), kind, Date.now());
    return row && credentialSchema.parse(row);
  }

  consumeRefresh(value: string): boolean {
    return (
      this.#db
        .prepare(
          "UPDATE credentials SET consumed = 1 WHERE hash = ? AND kind = 'refresh' AND consumed = 0 AND expires_at > ?",
        )
        .run(digest(value), Date.now()).changes === 1
    );
  }

  grant(id: string, clientId: string): Grant | undefined {
    const row = this.#db
      .prepare(
        "SELECT id, client_id AS clientId, connector_id AS connectorId, binding FROM grants WHERE id = ? AND client_id = ? AND revoked_at IS NULL",
      )
      .get(id, clientId);
    return (
      row &&
      grantSchema.parse({
        ...row,
        binding: JSON.parse(z.string().parse(row.binding)),
      })
    );
  }

  revocationTarget(clientId: string, value: string): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT id FROM grants JOIN credentials ON credentials.grant_id = grants.id
        WHERE client_id = ? AND hash = ? AND expires_at > ? AND revoked_at IS NULL`,
      )
      .get(clientId, digest(value), Date.now());
    return row && z.uuid().parse(row.id);
  }

  revokeGrant(id: string, clientId: string) {
    this.#db
      .prepare(
        "UPDATE grants SET revoked_at = ? WHERE id = ? AND client_id = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), id, clientId);
  }

  receipt(grantId: string, requestId: string): Receipt | undefined {
    const row = this.#db
      .prepare(
        `
      SELECT lower(request_id) AS requestId, request_hash AS requestHash, action_id AS actionId,
        version, status, detail, CASE WHEN expires_at > ? THEN result ELSE NULL END AS result
      FROM receipts WHERE grant_id = ? AND request_id = ? COLLATE NOCASE
      ORDER BY request_id = ? DESC LIMIT 1`,
      )
      .get(Date.now(), grantId, requestId, requestId);
    return row && receiptSchema.parse(row);
  }

  claimDispatch(
    grantId: string,
    receipt: Pick<
      Receipt,
      "requestId" | "requestHash" | "actionId" | "version"
    >,
  ) {
    return (
      this.#db
        .prepare(
          `INSERT INTO receipts (grant_id, request_id, request_hash, action_id,
          version, status, expires_at)
          SELECT id, ?, ?, ?, ?, 'dispatching', ? FROM grants
          WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(
          receipt.requestId,
          receipt.requestHash,
          receipt.actionId,
          receipt.version,
          Date.now() + receiptRetention,
          grantId,
        ).changes === 1
    );
  }

  finishDispatch(grantId: string, requestId: string, completion: Completion) {
    const result = this.#db
      .prepare(
        `UPDATE receipts SET status = ?, detail = ?, result = ?
      WHERE grant_id = ? AND request_id = ? AND status = 'dispatching'`,
      )
      .run(
        completion.status,
        completion.detail,
        completion.result,
        grantId,
        requestId,
      );
    if (result.changes !== 1) throw new Error("Missing dispatch receipt.");
  }

  pruneResults() {
    this.#db
      .prepare(
        "UPDATE receipts SET result = NULL WHERE result IS NOT NULL AND expires_at <= ?",
      )
      .run(Date.now());
  }

  private pruneOAuth() {
    const now = Date.now();
    for (const table of ["enrollments", "codes", "credentials"])
      this.#db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now);
  }
}
