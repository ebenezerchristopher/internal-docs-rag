---
title: "Dispatch Runbook"
category: operations
last_updated: 2026-05-12
owner: "Hugo Marin (Ops Director)"
---

# Dispatch Runbook

## Daily cadence
- 06:00: night-shift handover. Review all open shipments and any exceptions.
- 07:00: morning standup. Surface late pickups, customs holds, capacity
  issues.
- 12:00: midday check. Re-prioritize late shipments, rebook equipment as
  needed.
- 16:00: pre-close check. Confirm all pickups dispatched; brief evening
  on-call.

## Exception handling
- Late pickup: call the carrier, get a revised pickup window, notify the
  client within 30 minutes.
- Missed delivery: open a trace, escalate to carrier dispatch.
- Mechanical failure: rebook the freight on the next available carrier; do
  not wait for repair.
- Driver no-show: dispatch a backup; document the incident for HR.

## Handover
The off-going shift writes a short handover note covering: open exceptions,
pending ETAs, any client-specific watch items. The on-coming shift reads it
before picking up the queue.
