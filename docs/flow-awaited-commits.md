# Flow bridge: awaited, atomic graph commits

Status: **as built, 0.54.0.** Source: `src/bridges/flow.ts`. Tests:
`src/bridges/__tests__/flow-awaited-commit.test.ts`.

## The problem

Up to 0.53.0, `FlowBridgeAdapter.setNodes` / `setEdges` were typed `void` and
called without `await`. A host whose graph write is asynchronous (persisted,
gated, refusable) got this sequence from `flow_add_node`:

1. the tool returned success and emitted its `AgentActivity` event;
2. the graph was still unchanged;
3. the host's write landed later, or was refused, and the agent never heard.

`flow_delete_node` also called `setNodes` and `setEdges` as two separate writes,
so a host could apply one and refuse the other.

Reported by a consumer (Maipa) against 0.53.0 with fancy-flow 0.81.0.

## What was built

One optional adapter method, plus an optional revision reader:

```ts
commit?: (op: FlowGraphOp) => FlowAdapterCommit;
getRevision?: () => string | number;

type FlowAdapterResult = { ok: true } | { ok: false; error: string; code?: string };
type FlowAdapterCommit = void | FlowAdapterResult | Promise<void | FlowAdapterResult>;

type FlowGraphOp = {
  revision?: string | number;   // getRevision() when the op was computed
  agent: { id: string; name?: string; color?: string };
  tool: string;                 // the MCP tool that produced it
} & (
  | { op: "add_node"; node: FlowNode }
  | { op: "update_node"; id: string; node: FlowNode; previous: FlowNode }
  | { op: "remove_node"; id: string; node: FlowNode; edgeIds: string[] }
  | { op: "connect"; edge: FlowEdge }
  | { op: "disconnect"; id: string; edge: FlowEdge }
  | { op: "set_node_status"; id: string; status: NodeRunStatus; text?: string }
);
```

`FlowAdapterResult` has the same shape as the form bridge's `FormAdapterResult`
(0.52.0), and the waiting and close handling follow the form bridge.

| Tool | Op | Notes |
| --- | --- | --- |
| `flow_add_node` | `add_node` | full node, id assigned by the bridge |
| `flow_update_node` | `update_node` | merged node plus the node it replaces |
| `flow_delete_node` | `remove_node` | node plus every edge id touching it, one op |
| `flow_connect` | `connect` | full edge, id assigned by the bridge |
| `flow_disconnect` | `disconnect` | the edge being removed |
| `flow_set_node_status` | `set_node_status` | only when the adapter has no `setNodeStatus`; with one, that is called as before |

`flow_run` and `flow_cancel` are not graph writes and do not go through
`commit`.

## The contract

- **With `commit`:** each mutating tool validates, runs any `pendingMode`
  confirm, computes ONE op, and awaits `commit`. Only `void` / `{ ok: true }`
  counts as accepted; then the tool returns its usual success text and the
  activity event is emitted. A rejection, a synchronous throw, or
  `{ ok: false }` returns an error result: text = the host's message (cut at the
  first stack frame; a non-Error rejection gets a fallback), and
  `structuredContent = { ok: false, op, error, code? }`. No activity is emitted.
  `setNodes` / `setEdges` are not called.
- **Without `commit`:** exactly the 0.53.0 behaviour, including fire-and-forget
  setters and two setter calls on delete.
- **Atomicity is the adapter's job.** The bridge hands over one op per call and
  never splits one. `remove_node` must remove the node and its `edgeIds`
  together or not at all.
- **Staleness is the adapter's job.** The op is computed from the graph at call
  time (for `flow_delete_node` with a confirm, at the moment the human
  approves) and carries the `revision` read then. It is not recomputed after the
  await. The adapter must compare `revision` with its current graph and refuse
  with `{ ok: false, error: "...re-read and retry", code: "stale" }` if it moved.
- **State before resolve.** Update what `getNodes` / `getEdges` return before
  resolving, so a read right after a success sees the write.

## Fencing late results

The bridge races every pending `commit` (and the delete confirm on the commit
path) against close:

- `dispose()`;
- a second `registerFlowBridge` on the same host, which replaces the tools (same
  owner, `"flow"`) and closes the predecessor once all its own tools registered.

A call pending at close settles at once as an error saying the outcome is
unknown and that the agent should read the graph back. A result that arrives
later is ignored: no activity. A late rejection is swallowed, never unhandled. A
delete whose confirm was pending at close is never committed.

## Undo

The flow bridge records no undo entries, before or after this change, matching
the form bridge. `agent_undo` cannot revert a flow edit. Adding undo would mean
committing inverse ops through `commit`, which can themselves be refused or
stale; that is a separate design.

## Not changed

- Legacy `flow_set_node_status` without `setNodeStatus` or `commit` still sets
  `found` inside the `setNodes` updater and reports "No node" if the updater has
  not run synchronously. Left as is because the legacy path is frozen here.
