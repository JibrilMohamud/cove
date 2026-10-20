import {
  resolveLiteraryBudgetDb,
  reserveLiteraryBudget,
} from "../../src/lib/literary-budget-domain.server";
import type { CoveEnv } from "../../src/features/fore/api.server";

type Env = {
  DB: CoveEnv["DB"];
  CONTENT_DB: CoveEnv["DB"];
  SMOKE_TOKEN?: string;
};

export default {
  async fetch(request: Request, env: Env) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__isolated-budget-smoke" ||
      !env.SMOKE_TOKEN ||
      env.SMOKE_TOKEN.length < 48 ||
      request.headers.get("x-smoke-token") !== env.SMOKE_TOKEN
    )
      return new Response("Not found", { status: 404 });

    const day = "2026-10-20";
    const config = {
      ...env,
      FORE_CONTENT_PROCESSOR_ENABLED: "1",
      FORE_CONTENT_PROCESSOR_ROLE: "literary",
      FORE_CONTENT_BUDGET_MODE: "isolated",
    };
    try {
      // The old primary ledger must be atomically fenced even if a stale
      // request previously observed a live PRIMARY flag.
      const forbidden = await reserveLiteraryBudget(env.DB, day, 1, 400, false);
      if (forbidden) throw Error("Primary budget fence failed");
      const budget = await resolveLiteraryBudgetDb(config, day);
      const accepted: unknown[] = [];
      for (let n = 0; n < 5; n++) {
        accepted.push(await reserveLiteraryBudget(budget, day, 60, 400, true));
      }
      const row = await env.CONTENT_DB.prepare(
        "SELECT reserved_units,calls FROM literary_profile_budget WHERE day=?",
      )
        .bind(day)
        .first<{ reserved_units: number; calls: number }>();
      const old = await env.DB.prepare(
        "SELECT reserved_units,calls FROM literary_profile_budget WHERE day=?",
      )
        .bind(day)
        .first<{ reserved_units: number; calls: number }>();
      const passed =
        accepted.filter(Boolean).length === 3 &&
        row?.reserved_units === 350 &&
        row?.calls === 5 &&
        old?.reserved_units === 170 &&
        old?.calls === 2;

      // Close the isolated test domain after the last check so a repeated
      // request cannot re-spend this seeded staging budget.
      await env.CONTENT_DB.prepare(
        "UPDATE literary_budget_cutover SET status='closed' WHERE day=?",
      )
        .bind(day)
        .run();
      const closed = await reserveLiteraryBudget(budget, day, 1, 400, true);
      if (closed) throw Error("Closed domain accepted reservation");
      return Response.json(
        { success: passed, accepted: accepted.filter(Boolean).length, content: row, primary: old },
        { status: passed ? 200 : 409 },
      );
    } catch (error) {
      return Response.json(
        { success: false, reason: String(error).slice(0, 145) },
        { status: 422 },
      );
    }
  },
};
