import type {CatalogDB} from "../features/fore/catalog-model.server";

/** Synthetic QA only. Production rights and D1 cutover are not enabled. */
export declare const QA_OWNER_PRIMARY_READ_SCHEMA: "cove.qa.owner-primary-read.v1";
export declare const QA_OWNER_PRIMARY_READ_ROUTE: "/qa/private-primary-read";
export declare function checkedQaOwnerReadSql(sql: unknown): string;
export declare function checkedQaOwnerReadParams(params: unknown): Array<string|number|boolean|null>;
/** The caller supplies a QA-only, privately leased owner; never a public URL. */
export declare function createQaOwnerReadOnlyD1(
  owner: {fetch(request: Request): Promise<Response>},
  secret: string
): CatalogDB;
/** The real owner must positively pass its short-lived QA-lease check. */
export declare function serveQaOwnerPrimaryRead(
  request: Request, primary: CatalogDB, secret: string, qaLeaseLive: boolean
): Promise<Response>;
