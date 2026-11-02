# Legacy platform metadata after root-folder cleanup

Cove intentionally no longer tracks the source root folders `.lovable/` or `.openai/`.

| Former tracked path | Preserved source metadata |
| --- | --- |
| `.lovable/project.json` | `config/integrations/lovable-project.json` |
| `.openai/hosting.json` | `config/integrations/openai-sites-hosting.json` |

These files preserve the original contents, without changing the existing Sites project ID or its `DB` (D1) and `BUCKET` (R2) binding names.

**Build compatibility:** `npm run build` invokes `scripts/stage-sites.mjs`, which reads the relocated Sites config and still writes `dist/.openai/hosting.json` and `dist/.openai/drizzle/`. This **generated** directory is part of the legacy Sites deployment artifact and is ignored by Git. It is not a tracked source folder. The build now works without either deleted source folder.

**Lovable caveat:** the original Lovable template/revision metadata is preserved, but an external Lovable editor integration may expect `.lovable/project.json` at its previous path. Relocating that file alone does not guarantee editor synchronization or project linking. `AGENTS.md`, `@lovable.dev/vite-tanstack-config` and editor-only telemetry are left intact because they are unrelated runtime/integration dependencies. Recheck/reassociate an actively used Lovable project with the provider if necessary.

This cleanup does not create a new hosting project, alter Cloudflare or Vercel deployments, edit DNS, change API credentials or enable payments. Do not assume that the existence of legacy Sites metadata is production readiness.
