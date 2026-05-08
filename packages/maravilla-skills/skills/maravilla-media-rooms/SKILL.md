---
name: maravilla-media-rooms
description: "Maravilla Cloud video/audio rooms via `platform.media`. Use when building real-time calls, huddles, presence-aware spaces, or any feature where multiple users share an audio/video channel. The platform provisions LiveKit-backed rooms, mints participant tokens server-side, and returns the LiveKit URL — clients use the LiveKit JS SDK with the issued token. Critical: never mint tokens in the browser; the token is a credential and must be server-issued per-participant. Returns `null` from `mediaUrl()` when media isn't configured for the project — handle that as a feature flag, not an error."
---

# Maravilla media rooms

Server-managed video/audio rooms backed by LiveKit. The Maravilla runtime exposes a thin `platform.media` surface that lets your server create rooms, mint participant tokens, and tell clients where to connect — clients then use the LiveKit JS SDK with the issued token to join the room.

`platform.media` is **optional**. If the project hasn't been configured with a media provider, `getPlatform()` returns `media: undefined`. Always check before using:

```ts
import { platform } from '~/lib/platform.server';

if (!platform.media) {
  throw new Error('Media not configured for this project');
}
```

`mediaUrl()` separately returns `string | null` — `null` means "media is supported but no LiveKit URL is configured yet." Treat both as feature gates, not errors.

## Surface

`MediaService`, `MediaRoomInfo`, `MediaRoomInfoSettings`, `MediaParticipantInfo`, `MediaTokenResult` are exported from `@maravilla-labs/platform` — import the types and let the IDE / `tsc` resolve. Method list:

| Method | Returns |
|---|---|
| `createRoom(roomId, settings?)` | `MediaRoomInfo` — idempotent; returns the existing room if `roomId` already exists |
| `deleteRoom(roomId)` | `void` |
| `listRooms()` | `MediaRoomInfo[]` |
| `generateToken(roomId, participant)` | `MediaTokenResult` — `{ token, url }` |
| `mediaUrl()` | `string \| null` — `null` means "no LiveKit URL configured" |

Notes worth knowing without opening the file:

- `MediaParticipantInfo.identity` MUST be unique within a room. A second connect with the same identity boots the prior session — use `user_id` for single-tab, append a nonce (`${user_id}#${tabId}`) for multi-tab.
- `canPublish` / `canSubscribe` / `canPublishData` all default to `true`. Set explicitly if you need a listener-only role.
- `MediaRoomInfoSettings.emptyTimeoutSecs` is server-side; 60–300 is the usual range. Short = clean rooms, breaks "BRB" UX.
- `MediaTokenResult.token` is a JWT with an embedded TTL (~6h server default). Re-issue on rejoin; don't cache past the page lifetime.

## Pattern: idempotent room creation + per-user token

A canonical "huddle" flow: every authenticated user can join a shared room scoped to a parent resource (`huddle:<groupId>`). The server provisions the room on first join (idempotent), then mints a token bound to the user's identity.

```ts
// app/routes/api.huddles.$groupId.join.ts (or +server.ts / api route)
import { platform } from '~/lib/platform.server';
import { requireUser } from '~/lib/auth.server';

export async function action({ request, params }: ActionArgs) {
  const session = await requireUser(request);            // 3-step auth contract — see [auth](../maravilla-auth/SKILL.md)
  if (!platform.media) throw new Response('Media disabled', { status: 503 });

  const roomId = `huddle:${params.groupId}`;

  // Idempotent: createRoom returns the existing room if it exists.
  await platform.media.createRoom(roomId, {
    maxParticipants: 12,
    emptyTimeoutSecs: 60,                                // tear down 60s after last participant leaves
  });

  const { token, url } = await platform.media.generateToken(roomId, {
    identity: session.id,                                // collisions are not allowed; user_id is canonical
    name: session.email.split('@')[0],
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return { token, url, roomId };
}
```

Browser side, with the LiveKit SDK:

```ts
import { Room, RoomEvent } from 'livekit-client';

const { token, url } = await fetch(`/api/huddles/${groupId}/join`, { method: 'POST' }).then((r) => r.json());

const room = new Room({ adaptiveStream: true, dynacast: true });
await room.connect(url, token);
room.on(RoomEvent.ParticipantConnected, (p) => console.log('joined', p.identity));
await room.localParticipant.setCameraEnabled(true);
await room.localParticipant.setMicrophoneEnabled(true);
```

## Presence: combine with realtime

`platform.media` only handles the call itself — it doesn't tell other parts of your app who's currently in a huddle. For presence (e.g. "5 people in this huddle right now"), use [`realtime`](../maravilla-realtime/SKILL.md) channels:

```ts
// On join: publish presence on a realtime channel scoped to the same room.
await platform.realtime.presence.join(`huddle:${groupId}`, session.id, {
  display_name: session.email.split('@')[0],
});
```

Then any `+page.server.ts` load can `presence.members(channel)` to render the live roster, and an `onChannel({ channel: 'huddle:*', type: 'presence' })` handler can mirror it into KV for cross-tab readers (see [events](../maravilla-events/SKILL.md)).

## Token lifecycle

- Tokens are JWTs with embedded grants and a TTL (server default ~6h). Re-issue when a user rejoins; don't cache them client-side past the page lifetime.
- The same `identity` connecting twice will boot the previous connection. If you need multi-tab participation, append a tab-local nonce: `${session.id}#${tabId}`.
- Revoking access = `deleteRoom(roomId)`. There's no per-user kick API in v1 — re-create with a tighter ACL or filter at your app layer.

## Footguns

- **Don't mint tokens in the browser.** The token grants room access — minting it client-side leaks the LiveKit API key. Always go through a server route.
- **`platform.media` is optional.** Code defensively (`if (!platform.media)`) — your app must work in dev where LiveKit isn't wired up.
- **`identity` is the join key.** Re-using an identity disconnects the prior session. Use `user_id` directly for "one tab per user" UX, or append a nonce for multi-tab.
- **`emptyTimeoutSecs` is server-side.** A short timeout cleans up zombie rooms but breaks "be right back" UX. 60–300 is the usual range.

## See also

- [maravilla-realtime](../maravilla-realtime/SKILL.md) — for presence rosters that mirror the call
- [maravilla-auth](../maravilla-auth/SKILL.md) — `setCurrentUser` must run before any protected `/api/huddles/...` route
- LiveKit JS SDK docs — <https://docs.livekit.io/client-sdk-js/>
- Live Maravilla reference — <https://www.maravilla.cloud/llms-full.txt>
