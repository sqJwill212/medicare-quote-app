# Product Overview

Medicare Quote Engine (CQE) is a full-stack web application for comparing and recommending Medicare insurance plans. It serves Medicare-eligible consumers (primarily seniors) via a SelectQuote-branded experience.

## Core Capabilities

- **Plan Search & Comparison**: Look up Medicare Advantage, Supplement, and Part D plans by ZIP code; compare plans side-by-side with AI-powered analysis.
- **AI Plan Recommender**: Streaming LLM-based recommendations tailored to user health profiles and preferences.
- **Coverage Verification**: Integration with pVerify for real-time insurance eligibility checks.
- **Blue Button 2.0**: CMS Blue Button OAuth integration to import beneficiary claims data.
- **Provider Network Lookup**: Search for in-network doctors and verify provider coverage.
- **Drug Formulary Search**: Check medication coverage and tier pricing across plans.
- **Voice AI**: Vapi-powered voice assistant for conversational plan guidance.
- **Chat Widget**: Persistent AI chat assistant available on all pages.
- **Admin Dashboard**: Internal panel for managing AI model configuration and system settings.

## Domain Context

- Users are Medicare beneficiaries or those approaching eligibility (65+).
- Plans come from CMS Marketplace data, synced via a daily cron pipeline.
- Authentication is handled via an external OAuth provider (SelectQuote SSO).
- The app is deployed on Vercel with serverless API routes alongside the Express server.
