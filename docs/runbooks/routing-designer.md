# Routing designer: build, test and publish a routing point (Wave 18)

For editors and admins. Concepts and the API are in [routing.md](../architecture/routing.md); human queues in
[human-queues.md](../architecture/human-queues.md). The designer is at **Routing** in the console (group Inbound).

## Before you start

- Routing must be on (`OVO_ROUTING_ENABLED=true`). If it is off, every routing screen says "Routing is not enabled here" and
  calls keep going straight to their agent.
- You need at least two agents: one to speak as the router (any agent release with a speech recogniser) and one to be the
  default agent every fallback ends at. Viewers can read everything; editors change drafts, pools and clips and run the
  simulator; admins bind numbers and run real engines.

## 1. Pools

1. **Routing > New pool**, give it a name and its first agent.
2. Open the pool. Add a member per agent and language: the languages it speaks, the products and skills it handles, a
   priority (higher is tried first, equal priorities share calls), a capacity (or no limit) and opening hours.
3. **Who would answer?** asks for a language, product, skills and a time and shows each member as eligible or not, with the reason
   (turned off, closed, wrong language, other product, missing skill, full). Use it before sending real callers.
4. **Live load** shows the calls each member holds, refreshed every 10 seconds. "Stale" means the last refresh failed: the numbers
   are the last good ones; use Retry.

## 2. A routing point

1. **Routing > New routing point**: a name, the router agent, the default agent and the default language. It starts with one
   question answered by the keypad so it is valid from the first save.
2. **Tree.** Open a question to set what the caller hears, how it decides (engines run in order; the first to answer at or above
   its confidence wins), its branches and its fallback chain. A branch either asks another question or sends the call to a pool,
   an agent, a person, a callback or the end of the call. The chain must finish with the default agent, a callback or ending
   the call; the editor says so before the server does.
   - **Rules** need no model: keypad digits, caller number prefixes, time of day, a call variable, keywords, exact phrases, the
     reply's script. A question made only of caller number, time and variable rules decides without asking.
   - **Decision** and **Language model** read the branch descriptions (never where they lead) and answer at a confidence. Treat
     the model's confidence as its own, not calibrated.
   - **External service** needs an https endpoint and a signing secret; it is called once per question.
3. **Lines & languages.** Every line the router speaks needs text in the default language; the table lists each line and what it
   covers. Set the router's limits and the two agents here.
4. **Hold & transfer.** Upload hold clips (WAV, 10 MiB at most; a clip a point still uses cannot be deleted), design the hold
   (steps, repeat, longest wait, what happens when it runs out), and list the transfer targets an agent may choose. Transfers are
   inert while `OVO_ROUTING_TRANSFER_ENABLED` is off, and a number bound directly to an agent never transfers.
5. **Human queues.** Bind queues by key; branches, fallback steps and transfer targets name the key. Readiness says whether the
   queue can take callers now.
6. Problems appear as you type on the row they concern, with counts on the tab titles and in the header. **Save** stores the
   draft; if a teammate saved first you see what changed and choose.

## 3. Test it

**Simulate** (tab, or **Routing > Simulate a call**): pick the draft (unsaved edits included) or a release, script the caller, and run.
Model and external engines are scripted, so the run tests the tree, rules and pools; add an answer per engine in the form, or use
"Answer as..." on a trace row that had none. Read the route taken, the pools considered and the warnings. **Save as an eval case**
to keep a run as a regression case.

## 4. Publish and bind

1. **Publish...** shows what would be released: blockers (fix them), warnings, the digest, what changed since the last release
   and which agent releases are pinned. Publish is disabled when nothing changed.
2. Publishing changes nothing for callers. On the **Numbers** tab an admin binds a number to the new release (**Bind to latest**),
   or to an earlier one to roll back. A direct number switched to a routing point asks you to confirm: its callers reach the
   router first.
3. Roll back by binding the previous release; the kill switch is `OVO_ROUTING_ENABLED=false`.

## Reading a call

The call inspector's route view and the routing overview's KPIs come from the stored call outcomes; without them the KPIs show a
dash and say "Call outcomes are not stored here".
