# Changelog

All notable changes to the LiveLocks by PropPulse project are documented here. Entries are listed in reverse chronological order by task number.

---

## Task #21 — MLB Phase A: Automation Infrastructure
**Status**: Planned
**Date**: —

Build the infrastructure for live MLB game discovery, continuous data polling, and automatic engine triggering so the MLB prop engine runs without manual intervention.

## Task #20 — NCAAB Top Plays Layout Swap
**Status**: Merged
**Date**: March 2026

Reordered the NCAAB Live sub-tab to display the Top Plays feed above the Today's Games strip, giving high-confidence plays better visibility and prominence.

## Task #19 — MLB Phase A: Admin Tab & Roster Service
**Status**: Planned
**Date**: —

Unlock the MLB Live tab for admin users and implement the roster service infrastructure needed for the MLB prop engine, including 7 live prop markets and a contact-quality signal pipeline.

## Task #18 — SEO Metadata & Head Tags
**Status**: Planned
**Date**: —

Add complete SEO, OpenGraph, and Twitter Card metadata across all public-facing pages to improve search engine visibility and social media sharing appearance.

## Task #17 — NCAAB Engine Hardening
**Status**: Merged
**Date**: March 2026

Added runtime contract validation, richer debug diagnostics, and a shared Top Plays helper to ensure the stability and reliability of the NCAAB probability pipeline.

## Task #16 — NCAAB Canonical Market Object Rebuild
**Status**: Merged
**Date**: March 2026

Rebuilt the NCAAB engine/UI contract around a canonical `markets` object with Full Game, H1, and H2 sub-objects, ensuring consistent behavior and eliminating asymmetric fallbacks across tabs.

## Task #15 — Projected Minutes Ingestion
**Status**: Planned
**Date**: —

Integration of daily projected minutes from free public sources and RotoWire API to refine player role modeling and improve the accuracy of the rotation-based minutes model.

## Task #14 — Signal Stability Filters
**Status**: Merged
**Date**: March 2026

Added three post-calibration filters to reduce noise: a low-minute bench volatility dampener (×0.92), a high-usage UNDER collapse guard (−3 points), and a combo-stat variance dampener (×0.97).

## Task #13 — Proof of Edges Landing Section
**Status**: Planned
**Date**: —

A planned static section for the landing page to showcase real-world edge outputs and create urgency for upgrading to a paid tier.

## Task #12 — SMS Asset Replacement
**Status**: Merged
**Date**: March 2026

Replaced the `sms-alerts.png` asset on the landing page with an updated version matching the required design specifications.

## Task #11 — Landing Page Screenshot Swap
**Status**: Merged
**Date**: March 2026

Replaced simulated UI mockups on the landing page with real product screenshots (dashboard preview and SMS alerts) to improve credibility and conversion.

## Task #10 — NCAAB UI Contract Rewire
**Status**: Merged
**Date**: March 2026

Standardized the data flow between the NCAAB engine and UI to fix incorrect probability displays and asymmetric fallbacks across the Live and 2H Plays tabs.

## Task #9 — Documentation Refresh & Changelog
**Status**: Merged
**Date**: March 2026

Updated README.md and PRD.md (to v4.0) to reflect the full current state of the product. Created this CHANGELOG.md covering all 21 tasks.

## Task #8 — NCAAB UI Audit Fixes
**Status**: Merged
**Date**: March 2026

Applied critical fixes to NCAAB game cards including layout adjustments, horizontal scroll behavior for the game strip, and admin tier synchronization fixes.

## Task #7 — Conversion Optimization Layer
**Status**: Merged
**Date**: March 2026

Added psychological conversion triggers on top of the edge-locking system: slate-wide edge counters, teaser values on blurred plays, and a sticky upgrade banner for free users.

## Task #6 — Frontend Edge Locking
**Status**: Merged
**Date**: March 2026

Implemented visual locking of NBA 2H Play edges for free users — the first 5 edges are visible, remaining plays are blurred with teaser values and an upgrade prompt overlay to drive subscription conversion.

## Task #5 — Landing Page Integration
**Status**: Merged
**Date**: March 2026

Converted the Next.js landing page design into a native React page within the Vite/Wouter app, creating a public entry point at `/` with feature highlights, pricing cards, real screenshots, and CTA buttons. Authenticated users redirect to `/dashboard`.

## Task #4 — NCAAB UI/UX Improvements
**Status**: Merged
**Date**: March 2026

Added Top Plays feed, sportsbook filter pills (All / DK / FD / HR / ESPN Bet), probability tier badges, and pre-game ELV/CLV enrichment labels to the NCAAB tab for feature parity with the NBA tab.

## Task #3 — NCAAB Engine Rebuild
**Status**: Merged
**Date**: March 2026

Rebuilt the NCAAB engine from the ground up to use the same modular probability pipeline as the NBA engine, establishing a stable foundation for college basketball signals.

## Task #2 — Predictive Minutes Model
**Status**: Merged
**Date**: March 2026

Replaced the old scaling formulas with a dedicated rotation-based minutes model module covering foul reduction curves, rotation patterns, and blowout adjustments.

## Task #1 — Probability Calibration Refactor
**Status**: Merged
**Date**: March 2026

Refactored `calculateProbability()` to fix probability inflation, eliminate modifier stacking, and add game-state intelligence including game script divergence and OT probability handling.
