# Entity links: which environment answered (ENV-RESOLVE)

`SSR-000092` replaces a guess with a declaration. Before this, opening an
`entity-item:` link asked every configured server which one held the key and
opened the one that answered — correct only while no two stacks shared a key.
Now the entry's environment is read from its **handshake** and compared with what
the link asked for (or what the connection config pins).

Upstream contract: `SSR-000091` (ENV-ID) says where the declaration lives
(`initialize.serverInfo._meta.instanceId` / `instanceName`), and that a missing
key is "undeclared" — never `null`, `""`, `unknown`. **The deployed demo/test
stacks do not declare it yet**, so today every read takes the degraded path and
the panel says so; that is the intended behaviour of an older deployment, not a
bug in this code.

Files: `lib/entity-identity.ts` (pure judgement), `lib/mcp-call.ts`
(`readServerIdentity`, identity cache), `app/api/entity/route.ts`
(`pickTarget`, `loadEntity`), `lib/entity-opener.ts` (href grammar),
`components/EntityPanel.tsx` (verdict badge), `app/api/entity/route.test.mjs`,
`lib/entity-identity.test.mjs`, `lib/entity-opener.test.mjs`.

## The link

```
entity-item:<server>/<workspace>/<key>?instanceId=<id>
entity-item:<workspace>/<key>?instanceId=<id>
entity-item:<key>?instanceId=<id>
```

Every old form still parses and simply carries no declaration. The `instanceId`
is **what the writer wanted** — a selector compared against a declaration, never
evidence (`AC-8`). It is not part of the tab id: the same key and space are the
same tab, and a link asking for another environment is refused by the read, not
opened in a second tab.

## The order (nobody may skip a step)

1. **This project's config.** Only entries in the project's `.pi/mcp.json` or the
   global `mcp.json` exist as candidates; the project's file wins by name. The
   link's channel names the first candidate. A channel this project does not
   configure is still a hint, not a demand (`FM-LINK`: a reply carried from
   another project must stay openable).
2. **The declaration.** `initialize.serverInfo._meta.instanceId`, one handshake
   per connection (`readServerIdentity`). `about_me` is the per-session secondary
   and only a consistency check; `/version` is for ops/HTTP and is never called
   on this path. Error bodies and audit records are for attribution only.
3. **Exact match.** A link `instanceId` selects the entry that declares it. If
   no entry declares the requested id, and entries *do* declare other ids, the
   open is refused with the list — never "the only hit".
4. **Probe only when nothing is declared.** An environment that declares nothing
   is located by `workspace + key`: one hit opens (labelled degraded), several
   are refused with the candidates. A missing declaration never kills an older
   deployment.

The space narrows a key but does not settle a tie. Two older deployments that
share a space *and* a key naming scheme are indistinguishable by
`workspace + key`; that case used to open whichever entry `mcp.json` listed
first, which is an open that looks opened and belongs elsewhere. It is refused
(`409`, `code: "channel"`) with every candidate named (`server`, space, and
`instanceId` or 未声明), sorted so the answer does not depend on write order. The
one thing that may break such a tie is the entry the link names (`server`): that
name is this project's own entry, an instruction rather than a guess, and it is
the same precedence step 1 already gives the named channel. A named entry that
does not hold the key breaks nothing — the refusal stands.

The pin (`instanceId` key on an `mcp.json` server entry) is the only comparator
that does not come from the request. A link that contradicts the pin is refused
before any read; a pin the endpoint contradicts is refused likewise.

## Verdicts

| `identity.verdict` | Meaning |
| --- | --- |
| `verified` | The endpoint declared an id, and the link's request or the config pin matched it. |
| `unverified` | Declared, but nothing to compare (`未 pin`) — opened, never called verified. |
| `degraded` | No declaration anywhere (older deployment) — opened, labelled. |

`identity.detail` is one sentence for the badge tooltip; `instanceId`,
`expected` and `source` are in the same object so a wrong opening can be
attributed afterwards. Reads that are not `verified` also log one line:
`[entity] <key> @ <server>: instanceId=… expected=… verdict=…`.

A declaration that contradicts another surface of the *same* connection
(`initialize` vs `about_me`) is refused (`judgeConsistency`): two ids for one
connection are not a preference, they are an incoherent identity.

Refusals answer `409` with `code: "instance-mismatch"`, plus `expected`,
`actual`, and `candidates` (server, instanceId, instanceName, pin). The error
copy names all three and says what to change — `SSR-000033` (MCP-5) requires an
actionable error. The panel renders it with a line explaining this is identity
judgement, not a read failure.

## Cache and invalidation

`readServerIdentity` keeps the handshake's `serverInfo`:

- per session (`url + headers`) — the freshest value, replaced on reconnect;
- per `(cwd, server)` for when no session is live, valid only while the entry's
  **fingerprint** matches. The fingerprint is a digest of `source`, name, url and
  expanded headers, so pointing the entry at another stack, renaming it, or
  changing its token invalidates the cache and forces a new handshake.

`describeServer` is called lazily: opening through the entry the link names
handshakes only that entry, so one open is one entity read and does not connect
to the rest of the project's servers (`AC-6`). The full candidate list is
described only when a link's declaration has to be matched, or when there is no
named entry to probe.

## Tests

`app/api/entity/route.test.mjs` runs the handler against a stubbed MCP endpoint
whose `initialize` can declare `_meta` per url. It pins: same space+key in two
environments selected by declaration, AC-2 (two entries, one `instanceId`),
refusal listing both, pin mismatch both directions, `未验真`, degraded legacy,
multi-hit refusal (including two undeclared endpoints sharing one space and key,
and its independence from `mcp.json` write order), `initialize` vs `about_me`
contradiction, one read + no second handshake when cached, and config-change
invalidation. The pure cases live in `lib/entity-identity.test.mjs`.
