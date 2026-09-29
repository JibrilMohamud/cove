# Cove AI & Automated Content Policy — `fore-ai-content-v1`

Effective: 2026-09-24

Cove permits responsible use of generative AI, but does not permit AI to become a shortcut around authorship rights, product quality, truthful metadata, or anti-spam rules. The policy is versioned in `publishing_policy_versions`; a signed edition revision and its immutable publication version retain the exact policy/disclosure version that governed publication.

## Required disclosure

Every publisher revision must sign an immutable AI-content disclosure, including a fully human-created work. Cove records provenance separately for:

- primary text;
- translation;
- cover/artwork;
- narration.

Each component is classified as `human`, `ai_assisted`, `ai_generated`, `mixed`, or (where appropriate) `not_applicable`.

**AI-assisted** means a human created the underlying expressive work and used AI for assistance such as brainstorming, editing, cleanup, research organization, or similar support without the AI supplying material portions of the final expressive content.

**AI-generated** means an AI system generated material that appears as substantive final content. **Mixed** means substantive final content contains both human-created and AI-generated material.

Publishers remain responsible for the rights, accuracy, quality, and lawfulness of all content regardless of tool choice.

## Text and translation

AI-assisted text is allowed and, by itself, does not increase Cove's automated risk score.

AI-generated or mixed final text/translation is allowed only when accurately disclosed and when the publisher attests that a human performed editorial review. Disclosure routes the title to human review; AI generation alone is not treated as infringement or automatic rejection.

Cove can reject or remove generated content that is unreadable, incoherent, materially misleading, copied without permission, or produced as low-value catalog flooding.

## Cover art and images

AI-assisted/generated cover art is allowed when disclosed. The publisher must possess all necessary rights and must not use generated imagery to impersonate a person/publisher, falsely imply an endorsement, copy protected artwork, or create misleading product metadata.

Cove publication versions expose an `ai_generated_cover` customer-facing badge for generated/mixed cover art under this policy version.

## Narration

AI-assisted audio production is allowed. AI-generated or mixed narration must be disclosed and must include a customer-facing synthetic-voice label before an audiobook is submission-ready.

The exact synthetic-voice label is frozen into the publication-version disclosure and exposed in catalog metadata for the current version.

## Public disclosure under v1

Cove v1 exposes customer-facing disclosure badges for:

- generated/mixed primary text;
- generated/mixed cover art;
- generated/mixed translation;
- generated/mixed narration (using the publisher's synthetic-voice label).

AI-assisted-only use is retained in Cove's immutable compliance evidence but is not publicly badged under v1.

## Prohibited behavior

Cove prohibits, regardless of whether AI was used:

- content the publisher lacks rights to distribute;
- undisclosed generated/mixed content required by this policy;
- deceptive or keyword-stuffed metadata;
- false authorship, publisher, brand, or person impersonation;
- spammy mass-production intended to flood search/storefront surfaces;
- trivial near-duplicate variants or low-value derivative books intended primarily to multiply listings;
- unreadable, broken, incoherent, or materially unusable books;
- automated translations/narration presented misleadingly as a different human creator;
- attempts to evade fingerprinting, similarity review, account linkage, or prior enforcement;
- generated content that otherwise violates Cove's content/moderation rules.

## Automated review

`fore-trust-v2` combines the AI policy assessment with rights and trust signals. The AI-specific assessment (`fore-ai-content-v1`) currently considers:

- disclosed generated/mixed text or translation;
- disclosed generated/mixed cover/narration;
- high-confidence cross-publisher content similarity;
- same-publisher near-duplicate variants;
- submission velocity consistent with mass production.

Outcomes are `pass`, `review`, or `block`. Signals are evidence for review, not final legal or authorship conclusions. Disclosed AI use by itself does not create an infringement finding.

## Human review and enforcement

Reviewers can consider quality, rights evidence, misleading presentation, similarity context, publisher history, and whether a title appears to be mass-produced/derivative. Available actions include requesting changes, rejecting the submission, restricting publication, suppressing/taking down a live title, and applying sanctions. Publishers retain the existing appeal path where the underlying action is appealable.

Repeated copyright findings are handled by the separate versioned repeat-infringer policy; AI usage does not substitute for infringement evidence.

## Immutable publication disclosure

When an approved revision materializes, Cove writes `publishing_publication_disclosures` against the immutable `publishing_publication_versions` row. That freezes:

- AI policy version;
- component origins;
- synthetic narration label;
- public badges.

A later publisher update creates a new publication version and new disclosure. It does not rewrite what customers/auditors were shown for an older edition version.

## Policy changes

Published policy text/rules are immutable. Cove may change the lifecycle status of an old version from active to retired and publish a new version; it may not rewrite `fore-ai-content-v1` in place. New signatures fail closed if the application policy constant does not match an active policy record, preventing silent drift between code and legal/product policy.
