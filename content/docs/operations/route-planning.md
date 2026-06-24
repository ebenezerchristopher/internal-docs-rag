---
title: "Route Planning"
category: operations
last_updated: 2026-05-12
owner: "Hugo Marin (Ops Director)"
---

# Route Planning

## Inputs
- Origin, destination, pickup and delivery windows.
- Commodity, weight, dimensions, hazmat class.
- Mode: parcel, LTL, partial truckload, full truckload, intermodal, ocean,
  air.
- Service tier and any client-specific SLAs.

## Mode selection
- Under 150 lb and 4 packages or fewer: parcel.
- 150-20,000 lb and palletized: LTL.
- Over 20,000 lb or full trailer: full truckload.
- Long-haul (> 1,500 miles) and not time-sensitive: intermodal.
- International surface: ocean unless the client has paid for air.

## Optimization
- For multi-stop routes, sequence by delivery window first, then by geography
  to minimize deadhead.
- Respect driver hours-of-service limits; do not schedule a second pickup
  that would force a HOS violation.
- For hazmat, do not combine incompatible classes on the same trailer.
