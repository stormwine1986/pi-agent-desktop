# Entity links: which environment answered (ENV-RESOLVE)

`SSR-000092` replaces a guess with a declaration. Before this, opening an
`entity-item:` link asked every configured server which one held the key and
opened the one that answered — correct only while no two stacks shared a key.
Now the entry's environment is read from its **handshake**; the link's
`instanceId` selects which environment the writer meant, and only a pin in the
connection config can verify what answered.

Upstream contract: `SSR-000091` (ENV-ID) says where the declaration lives
(`initialize.serverInfo._meta.instanceId` / `instanceName`), and that a missing
key is "undeclared" — never `null`, `""`, `unknown`. Both deployed stacks
(demo and test) declare it today, with different builds (demo `d930b90`, test
`0c176d6`), so the same key in the same space really does exist twice and the
declaration is what tells them apart. A stack that declares nothing still opens
through the degraded path — that is the older-deployment contract, not a bug.

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
evidence (`AC-8`), and never a comparator: only a pin in the connection config can
verify an open (`AC-5b`). A link whose id matches the declaration selects that
environment and is still reported `unverified`; a link whose id contradicts it is
refused. It is not part of the tab id: the same key and space are the same tab,
and a link asking for another environment is refused by the read, not opened in
a second tab.

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

**Probing counts environments, not entries.** Several `mcp.json` names may point
at one stack (`entity-base`, `entity-base-alias`), and probing them returned two
hits in one space — the unsolvable tie, for a choice that does not exist. Hits are
folded by environment before the tie is judged (`environmentKeyOf`):

- a declared `instanceId` decides — same id is one environment, different ids are
  two (the tie stands, `409`);
- a declared id on one side and nothing on the other never merge: nothing proves
  they are the same place, so the conservative refusal stays;
- with no declaration on either side, the same connection (`url` + headers) is one
  environment; a different url is not.

`target.fingerprint` cannot be the environment key: it hashes the `server` name
too (`lib/mcp-call.ts`), so two aliases would always differ and never merge.
Merging uses the handshakes `describeAll()` already holds, so it costs no extra
connection (`AC-6`). The entry that speaks for a merged environment is chosen
deterministically — the entry the link names, then one with a pin, then dictionary
order of the entry name — so the response's `server` is predictable and a
reversed `mcp.json` gives the same answer.

The space narrows a key but does not settle a tie between *environments*. Two
older deployments that share a space *and* a key naming scheme are
indistinguishable by `workspace + key`; that case used to open whichever entry
`mcp.json` listed first, which is an open that looks opened and belongs
elsewhere. It is refused (`409`, `code: "channel"`) with every candidate named
(`server`, space, and `instanceId` or 未声明), one candidate per merged
environment and sorted so the answer does not depend on write order. Listing
entries instead produced copy that contradicted itself
(`env-alias:ins_demo`、`env-localhost:ins_demo`). The one thing that may break such
a tie is the entry the link names (`server`): that name is this project's own
entry, an instruction rather than a guess, and it is the same precedence step 1
already gives the named channel. A named entry that does not hold the key breaks
nothing — the refusal stands.

The pin (`instanceId` key on an `mcp.json` server entry) is the **only**
comparator, because it is the only one that does not come from the request. A link
that contradicts the pin is refused before any read; a pin the endpoint
contradicts is refused likewise; a link id that matches the endpoint with no pin
available is opened but marked 未验真.

## Verdicts

| `identity.verdict` | Meaning |
| --- | --- |
| `verified` | The endpoint declared an id and the **config pin** matched it (`source: "config"`). |
| `unverified` | Declared, but nothing to compare (`未 pin`) — opened, never called verified. A matching link id does not change this. |
| `degraded` | No declaration anywhere (older deployment) — opened, labelled, `source: "none"`. |

`expected` is present only when a pin supplied it; `source` is `"config"` or
`"none"`, never `"link"`. `identity.detail` is one sentence for the badge
tooltip; `instanceId`, `expected` and `source` are in the same object so a wrong
opening can be attributed afterwards. Reads that are not `verified` also log one
line: `[entity] <key> @ <server>: instanceId=… expected=… verdict=…`.

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
environments selected by declaration (opened `unverified`, since a link id never
verifies), AC-2 (two entries, one `instanceId`, opening with a deterministic
`server` that does not follow `mcp.json` write order), two aliases of one declared
environment, two entries on one connection with no declaration, two entries on one
url declaring different environments (still `409`), a refusal that lists two merged
environments rather than three entries, refusal listing both environments, pin
mismatch both directions, `未验真` with and without a link id, degraded legacy, a
link id that contradicts the endpoint declaration (`409`, nothing read), multi-hit
refusal (including two undeclared endpoints sharing one space and key, and its
independence from `mcp.json` write order), `initialize` vs `about_me`
contradiction, one read + no second handshake when cached, and config-change
invalidation. The pure cases live in `lib/entity-identity.test.mjs`.
