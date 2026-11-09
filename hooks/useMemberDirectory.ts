"use client";

import { useEffect, useState } from "react";
import { normalizeMembers, type WorkspaceMember } from "@/lib/entity-members";

/**
 * The state of the candidate list a `user` field draws from.
 *
 * `idle` means the panel does not know which workspace to ask yet, `unavailable`
 * means it asked and nothing usable came back — the field treats the two
 * differently, so "not asked" never masquerades as "no members"
 * (`SSR-000093` AC-2).
 */
export interface MemberDirectoryState {
  status: "idle" | "loading" | "ready" | "unavailable";
  members: WorkspaceMember[];
  /** Why the list is unavailable, for the note beside the degraded control. */
  error?: string;
}

const IDLE: MemberDirectoryState = { status: "idle", members: [] };

/**
 * Reads the workspace's members once per (cwd, server, workspace), through
 * `/api/entity/members` — the same single source `SSR-000093` ② names.
 *
 * A failed read is a state, not an exception: refusing the whole form because a
 * member list is missing would block editing every other field on the entity,
 * while the contract asks for a text fallback with a visible note.
 */
export function useMemberDirectory(
  target: { cwd: string; server?: string; workspace?: string } | null,
): MemberDirectoryState {
  const cwd = target?.cwd ?? "";
  const server = target?.server ?? "";
  const workspace = target?.workspace ?? "";
  const [state, setState] = useState<MemberDirectoryState>(IDLE);

  useEffect(() => {
    if (!cwd || !server || !workspace) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading", members: [] });
    void (async () => {
      const params = new URLSearchParams({ cwd, server, workspace });
      const response = await fetch(`/api/entity/members?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json() as { members?: unknown; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      // The route already normalises; keeping the shape honest here means a stub
      // or an older route still lands on the same type.
      setState({ status: "ready", members: normalizeMembers(body.members) });
    })().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setState({
        status: "unavailable",
        members: [],
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
    return () => controller.abort();
  }, [cwd, server, workspace]);

  return state;
}
