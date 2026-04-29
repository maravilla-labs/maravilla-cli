# Maravilla Cloud Agent Skills

Reusable AI agent skills for building [Maravilla Cloud](https://www.maravilla.cloud) applications. Works with Claude Code, Cursor, GitHub Copilot, and 30+ other AI coding tools.

## Install

```bash
npx skills add maravilla-labs/maravilla-cli/packages/maravilla-skills
```

## Skills

| Skill | Description |
|-------|-------------|
| **maravilla-overview** | What Maravilla Cloud is, the V8-isolate runtime, `getPlatform()` entry point, how env / auth / realtime / push / workflows / events fit together. |
| **maravilla-config** | The `maravilla.config.ts` declarative file: auth resources, groups, relations, registration, OAuth, security, branding, transforms, indexes. |
| **maravilla-auth** | The 3-step request-scoped auth contract (`validate` → `setCurrentUser` → `can`). Register, login, OAuth, refresh, password reset. |
| **maravilla-policies** | Resource definitions and the Layer-2 policy expression language (`auth.*`, `node.*`, groups, relations). |
| **maravilla-kv** | `platform.env.KV.<namespace>` — get/put/delete/list, TTL via `expirationTtl`, prefix listing. |
| **maravilla-db** | `platform.env.DB` — MongoDB-style find/insert/update/delete, indexes (`createIndex`), and vector search (`createVectorIndex`, `findSimilar`). |
| **maravilla-storage** | `platform.env.STORAGE` — presigned upload/download URLs, capability-based access, `getAssetUrl`, `confirm`. |
| **maravilla-realtime** | `platform.realtime.publish/channels` and `presence.join/leave/members`. SSE-backed change notifications via `RenClient`. |
| **maravilla-push** | Server: `platform.push.send/schedule/cancelScheduled` (idempotent keys, `everySeconds`). Browser: `registerPush({ topics, userId, swPath })`. VAPID. |
| **maravilla-events** | `events/*.ts` triggers — `onKvChange`, `onDb`, `onAuth`, `onSchedule`, `onQueue`, `onChannel`, `onDeploy`, `onStorage`, `onRen`. |
| **maravilla-workflows** | Durable replay-based workflows. `defineWorkflow`, `step.run`, `step.sleep`, `step.sleepUntil`, `step.waitForEvent`, `step.invoke`. |
| **maravilla-frameworks-sveltekit** | `@maravilla-labs/adapter-sveltekit` — the `hooks.server.ts` cookie-binding pattern, form actions, `+page.server.ts` loads. |
| **maravilla-frameworks-react-router** | `@maravilla-labs/adapter-react-router` — server loaders, auth context propagation. |
| **maravilla-frameworks-nuxt** | `@maravilla-labs/preset-nitro` — Nitro server middleware for auth binding, Nuxt's `useFetch` against platform endpoints. |

## Learning path

1. **Start here** → `maravilla-overview`
2. **Configure your project** → `maravilla-config`
3. **Wire authentication** → `maravilla-auth` (then `maravilla-policies`)
4. **Pick your framework** → `maravilla-frameworks-sveltekit` / `react-router` / `nuxt`
5. Then as needed: `maravilla-kv`, `maravilla-db`, `maravilla-storage`, `maravilla-events`, `maravilla-workflows`, `maravilla-realtime`, `maravilla-push`

## Full docs

- Web: <https://www.maravilla.cloud>
- LLM bundle: <https://www.maravilla.cloud/llms-full.txt>
