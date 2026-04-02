# Changelog

All notable changes to the LiveLocks by PropPulse project are documented here. Entries are grouped by date in reverse chronological order. Each entry includes: task number, title, and one-sentence summary.

---

## 2026-04-02

### Task #114 — Edge Feed Conversion Gate
Implemented conversion-optimized edge feed gating: free users see limited edges with upgrade prompts, paid users get full access to all engine signals.

## 2026-03-31

### Task #113 — Fix NBA Calculator minVar Scoping Bug
Fixed a variable scoping issue in the NBA calculator where `minVar` was not correctly scoped, causing intermittent probability computation errors.

## 2026-03-30

### Task #112 — MLB Distribution-First Architecture
Upgraded the MLB probability engine to a distribution-first architecture across 4 core markets (Hits, Total Bases, Strikeouts, Home Runs) using Negative Binomial, Binomial, and Normal CDF models.

### Task #111 — MLB Projection Integrity & Confidence Scoring
Added detailed projection integrity scoring and confidence metrics to MLB player stat outputs for better signal quality assessment.

## 2026-03-29

### Task #110 — MLB Production Fixes (6-Pack)
Six targeted production fixes for MLB live data display, admin forms, and rendering stability.

## 2026-03-28

### Task #109 — MLB Player Archetypes & Market Family Intelligence
Added batter archetype classification (8 types) and pitcher archetype classification (6 types) with Statcast-driven inputs, plus market-family-aware calibration shrinkage and safety ceilings.

### Task #108 — MLB Play Grading with Live Game Data
Implemented the ability to grade MLB plays using live game data, enabling track record evaluation of engine outputs.

### Task #107 — MLB Sharing & Stat Visualizations
Added sharing functionality and improved stat visualizations on MLB player signal cards.

## 2026-03-27

### Task #78 — Tweet Rotating Template System
Implemented a rotating template system for tweet generation with multiple pre-built templates and dynamic content insertion.

## 2026-03-26

### Task #106 — Admin-Gate Engine Track Record
Restricted the engine track record / calibration dashboard to admin-only visibility, removing it from the regular user dashboard.

### Task #105 — Box Score Badge Rotation + Engine Under-Skew Fix
Replaced static dot signals with rotating inline market badges in the NBA box score for faster scanning, and fixed an under-probability skew in the engine.

### Task #104 — Upgrade CTA & Empty State Conversion Fix
Improved upgrade call-to-action buttons and empty state messaging to drive subscription conversion.

### Task #103 — Email Verification Reminders
Added recurring email verification reminders for new users who haven't verified their email address.

### Task #102 — MLB Mobile Crash Hardening
Fixed multiple crash vectors in the MLB tab on mobile devices — null guards, safe rendering, and layout stability.

### Task #101 — NCAAB Fallback Exposure Layer
Surfaced derived/fallback market data in the NCAAB UI with clear labeling so users understand when lines are inferred vs. from sportsbooks.

### Task #97 — Engine Data Expansion & Hardening (All 3 Sports)
Major 17-phase engine upgrade across NBA, NCAAB, and MLB: unified engine input builder, signal output contracts, validation firewall, odds normalization, sportsbook meta tracking, line source provenance, timing gates, odds freshness guards, and observability stats.

## 2026-03-25

### Task #100 — Email Lifecycle Fixes
Prevented excessive and duplicate transactional emails by adding deduplication guards and lifecycle flags.

### Task #99 — Stripe Upgrade + MLB Gating Fix
Fixed Stripe checkout flow with correct price IDs, enforced tier normalization, and repaired MLB access gating for All Sports subscribers.

### Task #98 — MLB Live Dashboard + Premium UI
MLB production stabilization with preview monetization, premium UI polish, and signal card visual system rebuild.

### Task #96 — NBA Admin Simulation Mode
Added admin-only simulation mode for the NBA engine allowing admins to test probability calculations with synthetic inputs without affecting live data.

### Task #95 — MLB Schedule + Signal Layer Split
Separated MLB schedule display from signal generation into independent layers, enabling the schedule to render even when signal data is unavailable.

### Task #94 — Signal Evaluation Contract Hardening
Hardened the signal evaluation contract with strict validation of all engine output fields before signals reach the route layer.

### Task #93 — NBA Halftime Pipeline Restoration
Restored the NBA halftime 2H play pipeline with per-user verification scoping, corrected absence gates, and Quick View decoupling.

### Task #92 — NCAAB Derived Signal Calibration + Confidence Hardening
Added calibration dampening for derived (non-sportsbook) lines in NCAAB, capping derived signals at STRONG confidence tier.

### Task #91 — MLB Gold Master — Signal & Render Integrity
Comprehensive signal integrity and render validation pass for the MLB engine, ensuring all outputs pass the validation firewall.

### Task #90 — Quick View Edge Suppression Fix
Fixed a bug where the Quick View component was incorrectly suppressing valid edge signals.

### Task #89 — NCAAB Full Pipeline Repair (Gold Master Fix)
Full repair of the NCAAB engine pipeline restoring APIs, fallback paths, and Top Plays rendering.

### Task #50 — MLB Edge Cache TTL & Eviction
Implemented TTL-based cache eviction for MLB edge signals to prevent stale data from persisting.

## 2026-03-24

### Task #88 — NBA Engine Full Integrity Rollback
Rolled back NBA engine to a known-good state, reconstructed directional probability computation, and repaired box score signal rendering.

### Task #87 — NBA Player Archetype Layer
Introduced the 7-archetype classification system (stable_star, stable_starter, volatile_starter, bench_microwave, low_minute_big, lineup_impacted, role_uncertain) with variance multipliers, fragility scoring, correlation defaults, and safety ceilings per archetype.

### Task #86 — NBA Engine Audit + Safe Risk Filters
Audited the full NBA engine against a 28-requirement spec and added safe risk filters for edge cases.

### Task #85 — Production Crash Fix
Fixed production crash caused by missing `espn_athlete_id` column with inline migration and IIFE startup guard.

### Task #84 — NBA Engine Calibration Corrections
Applied addendum corrections to the NBA engine calibration upgrade, fixing rate blending weights and probability computation.

### Task #83 — Persisted Plays Grading + Calibration Dashboard
Added play persistence to the database and built a calibration dashboard showing engine track record, hit rates, and ROI metrics.

### Task #82 — Recent Wins Strip
Added a Recent Wins strip component displaying recent successful engine picks to build user confidence.

### Task #81 — LiveLocks Conversion Engine
Built the full conversion optimization layer: positioning, SMS teasers, loading state improvements, and upgrade flow polish.

### Task #79 — NCAAB Market Guard-Rails + Analytics Verification
Added strict market guard-rails (probability bounds, line validation, consensus checks) and an analytics verification endpoint for the NCAAB engine.

## 2026-03-23

### Task #80 — Wall Email Fix + Lifecycle Audit + Full Blast
Fixed email wall logic, audited the full lifecycle flow, and triggered a one-time email blast to existing users.

### Task #77 — Fix Email Logic
Fixed transactional email sending logic to prevent delivery failures and ensure correct template rendering.

### Task #76 — Email Lifecycle v2 — Flags, Cron, ROI Wall Email
Expanded email lifecycle with user flags, 15-minute cron job, ROI-focused wall email, and startup blast for activation.

### Task #75 — Resend Transactional Email Integration
Integrated Resend as the transactional email provider for verification emails, welcome sequences, and lifecycle messaging.

### Task #64 — NCAAB End-to-End Pipeline Recovery
Fixed NCAAB H1/H2 hydration issues ensuring all market data flows correctly from engine to UI.

### Task #59 — NBA Halftime Active Path Verification + Display Contract Audit
Verified the active path through the NBA halftime engine and audited the display contract for consistency.

### Task #57 — NBA Score-State Usage Compression
Added score-state-aware usage compression to prevent inflated projections during blowout scenarios.

### Task #49 — MLB Click-Through, Bet Slip, and Odds Wiring
Wired MLB signal cards to bet slip integration and odds display for click-through to sportsbooks.

### Task #48 — MLB Analytics Data Pipeline
Built the analytics data pipeline for MLB engine tracking, including signal persistence and performance metrics.

### Task #47 — MLB Premium UX + Data Wiring Repair
Repaired MLB premium user experience and data wiring to ensure All Sports subscribers see correct outputs.

## 2026-03-22

### Task #74 — Verification Auto-Login + Dashboard Toast
Added auto-login after email verification with a dashboard toast notification confirming successful verification.

### Task #73 — Signup Protection & Email Verification
Added email verification flow to the signup process with verification tokens, confirmation emails, and gate enforcement.

### Task #72 — LiveLocks Full System Audit + Repair
Comprehensive system audit covering all engines, alert pipelines, and data flows with targeted repairs.

### Task #46 — MLB Premium Experience Completion
Completed the MLB premium experience with polished UI, proper tier gating, and signal rendering.

### Task #45 — MLB Player + Pitcher Detail Rebuild
Rebuilt MLB player and pitcher detail views with enhanced stat displays and archetype indicators.

## 2026-03-21

### Task #71 — Full LiveLocks Engine & Alert Pipeline Audit
Audited the complete engine and alert pipeline for correctness, deduplication, and delivery reliability.

### Task #70 — LiveLocks CMO Growth Plan
Generated a CMO-level growth plan document for LiveLocks marketing strategy.

### Task #69 — Free Tier: Daily Play Reset & Conversion UX
Replaced the 15-play lifetime cap with a daily play reset (3 plays/day for free users), improving conversion funnel and retention.

## 2026-03-20

### Task #68 — NBA Season-Phase Volatility Adapter
Added a late-season/playoffs volatility adapter that adjusts engine sensitivity based on the current phase of the NBA season.

### Task #67 — NCAAB H1/H2 Market Repair
Repaired NCAAB first-half and second-half market rendering and data binding.

### Task #66 — NCAAB Detail Card vs Top Plays Reconciliation
Reconciled data discrepancies between NCAAB detail card views and the Top Plays feed.

### Task #65 — NCAAB Full System Recovery
End-to-end NCAAB pipeline recovery including trace logs, UI audit, and verification of all market outputs.

## 2026-03-19

### Task #63 — Email Lifecycle — Flags, 15-min Cron, ROI Wall Email, Startup Blast
Implemented email lifecycle infrastructure with user flags, scheduled sends, and ROI-focused conversion emails.

### Task #61 — NCAAB Engine → UI Data Flow & Binding Fix
Fixed data flow between the NCAAB engine output and the UI binding layer, resolving missing market data.

### Task #60 — NCAAB Fallback Surface Fix (4 Patches)
Applied four targeted patches to NCAAB fallback surface rendering when primary data sources are unavailable.

### Task #58 — NBA Halftime Engine Balance + UI Signal Fix
Balanced the NBA halftime engine probability outputs and fixed UI signal display issues.

### Task #56 — Grading & ROI Integrity Audit
Audited the play grading and ROI computation pipeline for accuracy and consistency.

## 2026-03-18

### Task #62 — Fix Stripe 500 Error
Fixed Stripe checkout 500 error by replacing hardcoded price IDs with correct live Stripe account IDs via environment variables.

## 2026-03-17

### Task #55 — Bump Service Worker Cache Version
Bumped PWA service worker cache version to push Task #54 changes to mobile users.

### Task #54 — Signup UX: Stale Copy + Email Verification Gate
Fixed stale "15 plays" copy in signup flow and added email verification gating.

### Task #53 — Enforce Engine Probability as Single Source of Truth
Ensured all probability values displayed in the UI originate from the engine computation, eliminating any client-side probability recalculation.

### Task #52 — Consolidate Hits Model Probability Path
Unified the hits probability computation into a single canonical path through the probability engine.

### Task #51 — Remove Route-Level Edge Filter
Removed the route-level edge filter that was incorrectly suppressing valid signals before they reached the UI.

### Task #44 — MLB Pitcher Deterioration + Live Recalculation
Added pitcher deterioration modeling based on pitch count and times through the order, with live recalculation of projections.

### Task #43 — MLB Game Cards + Mobile/Web Polish
Polished MLB game cards for both mobile and web with responsive layouts and visual consistency.

### Task #42 — MLB Master Rebuild: Signal Integrity + Monetization
Major MLB rebuild focusing on signal integrity, monetization gates, and premium UI presentation.

### Task #41 — MLB Engine Truth Layer Fix
Fixed the MLB engine truth layer ensuring projection outputs are canonical and consistent.

### Task #40 — MLB Integrity Firewall + Canonical Output
Added an integrity firewall layer validating all MLB engine outputs before they reach the API response.

### Task #39 — NBA Box Score: Inline Market Badges
Replaced dot signals with inline market badges in the NBA box score for faster 10-second quick scanning.

### Task #38 — Fix Alert System
Fixed SMS admin bypass, push notification guard cleanup, H2 deduplication, and probability threshold alignment.

### Task #36 — MLB Production Stabilization (Master)
Master stabilization pass for the MLB production environment addressing crashes, rendering issues, and data integrity.

### Task #35 — MLB Signal Integrity & Odds Decoupling
Decoupled MLB signal generation from odds fetching to prevent signal suppression during odds API failures.

## 2026-03-16

### Task #37 — MLB System Realignment
Realigned the MLB system architecture to correct data flow inconsistencies.

## 2026-03-15

### Task #34 — Fix NBA Lines Not Loading
Fixed auto-set opponent team when player is selected from a game tile, resolving the NBA lines loading issue.

## 2026-03-14

### Task #33 — Always Show Tweet/Copy Block
Removed the probability gate on the tweet/copy block so it appears on all calculation results.

### Task #32 — Fix Tweet Button Visibility After Calibration Upgrade
Restored tweet button visibility that was broken by the calibration engine upgrade.

### Task #31 — MLB Poisson-Gamma (Negative Binomial) Outcome Model
Implemented the Negative Binomial distribution model for MLB Hits and Total Bases markets, replacing the simple normal approximation.

### Task #30 — NCAAB H1 Market Hydration Fix
Fixed H1 market data hydration in the NCAAB engine ensuring first-half lines and probabilities render correctly.

### Task #29 — MLB Live UI Repair (Parity with NBA Live)
Repaired the MLB Live UI to achieve visual and functional parity with the NBA Live tab.

### Task #28 — MLB Live UI Architecture Repair
Fixed MLB Live UI state management and interaction parity with the established NBA Live patterns.

### Task #27 — MLB PA Distribution Model (Lineup Turnover)
Implemented the plate appearance distribution model accounting for lineup turnover and batting order position effects.

### Task #26 — NCAAB Market Intelligence Layer (CLV + Public Fade)
Added Closing Line Value (CLV) edge computation and public bet percentage fade intelligence to the NCAAB engine.

### Task #25 — MLB Engine: Binomial Threshold Fix
Fixed the binomial probability threshold calculation in the MLB engine that was producing incorrect OVER probabilities.

### Task #24 — NBA Engine Calibration & Analytics Upgrade
Major NBA engine upgrade: Z-score probability via Normal CDF, 3-rate blending (45% recent / 35% season / 20% role), archetype-aware calibration shrinkage, fragility scoring, combo stat covariance, and under-bias correction.

### Task #23 — MLB Live: Dual-Mode Calculator + Engine Upgrade
Added dual-mode calculator (quick calc + full analysis) to MLB Live tab with engine upgrade for live context integration.

### Task #21 — MLB Phase A: Automation Infrastructure
Built infrastructure for live MLB game discovery, continuous data polling, and automatic engine triggering.

### Task #18 — SEO Metadata & Head Tags
Added SEO, OpenGraph, and Twitter Card metadata across all public-facing pages.

## 2026-03-13

### Task #20 — NCAAB Top Plays Layout Swap
Reordered the NCAAB Live sub-tab to display the Top Plays feed above the Today's Games strip.

### Task #19 — MLB Phase A: Admin Tab + Roster Service
Unlocked MLB Live tab for admin users, implemented ESPN roster service, 7 live prop markets, and contact-quality signal pipeline.

### Task #17 — NCAAB Engine Hardening
Added runtime contract validation, richer debug diagnostics, and shared Top Plays helper for NCAAB pipeline stability.

### Task #16 — NCAAB Canonical Market Object Rebuild
Rebuilt the NCAAB engine/UI contract around a canonical `markets` object with Full Game, H1, and H2 sub-objects.

### Task #14 — Signal Stability Filters
Added three post-calibration filters: low-minute bench volatility dampener (×0.92), high-usage UNDER collapse guard (−3 pts), and combo-stat variance dampener (×0.97).

### Task #10 — NCAAB UI Contract Rewire
Standardized data flow between the NCAAB engine and UI to fix probability displays and asymmetric fallbacks.

### Task #9 — Documentation Refresh & Changelog
Updated README.md and PRD.md to v4.0 and created the initial CHANGELOG.md.

## 2026-03-12

### Task #12 — SMS Asset Replacement
Replaced `sms-alerts.png` asset on the landing page with updated design.

### Task #11 — Landing Page Screenshot Swap
Replaced simulated mockups with real product screenshots on the landing page.

### Task #8 — NCAAB UI Audit Fixes
Applied critical fixes to NCAAB game cards: layout, horizontal scroll, and admin tier sync.

### Task #7 — Conversion Optimization Layer
Added slate-wide edge counters, teaser values on blurred plays, and sticky upgrade banner for free users.

### Task #6 — Frontend Edge Locking
Implemented visual locking of NBA 2H Play edges for free users — first 5 visible, rest blurred with upgrade prompt.

### Task #5 — Landing Page Integration
Converted the landing page into a native React page at `/` with feature highlights, pricing cards, and CTAs.

### Task #4 — NCAAB UI/UX Improvements
Added Top Plays feed, sportsbook filter pills, probability tier badges, and ELV/CLV enrichment labels.

### Task #3 — NCAAB Engine Rebuild
Rebuilt the NCAAB engine from the ground up using a modular probability pipeline.

### Task #2 — Predictive Minutes Model
Replaced old scaling formulas with a rotation-based minutes model covering foul reduction, rotation patterns, and blowout adjustments.

### Task #1 — Probability Calibration Refactor
Refactored `calculateProbability()` to fix probability inflation, eliminate modifier stacking, and add game-state intelligence.
