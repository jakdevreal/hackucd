# CLAUDE.md

## Project

A web app that helps social media creators become better speakers. A creator records or uploads themselves talking, the app analyzes the speech with AI, and it returns specific coaching they can act on before their next video.

This is a hackathon project built by a team of 4. A working end-to-end demo matters more than completeness or polish.

## What the analysis should catch

The feedback should be concrete and tied to what the speaker actually said, not generic public-speaking advice. Target areas:

- **Repetitive vocabulary**: overused words and phrases, with suggested alternatives
- **Filler words and verbal habits**: "um", "like", "you know", repeated sentence openers, trailing off
- **Clarity and structure**: rambling, weak openings, points that never land
- **Progress over time**: how a user's later recordings compare with their earlier ones

Each piece of feedback should quote or point to the moment in the transcript it refers to, and say what to do instead.

## Our scope

We own the **backend and storage**. Another part of the team owns the frontend.

- Work in the backend code. Do not edit frontend code unless asked.
- The API is the contract with the frontend team. Keep request and response shapes stable, and call out any change to them explicitly so we can tell the frontend team.
- When an endpoint is added or changed, update the API notes in `docs/api.md` (create it if missing).

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | Vue.js with Tailwind CSS (not ours) |
| Backend | Node.js with Express |
| AI | OpenRouter API |
| Hosting | Google Cloud Run |
| Storage | Google Cloud |

## Rules

- The OpenRouter key stays server-side. The frontend never calls OpenRouter directly.
- Prefer the simplest thing that works. No new dependencies, abstractions or infrastructure unless the task needs them.
- Handle the failures a live demo will hit: oversized uploads, unsupported audio formats, model timeouts and malformed model output. Return a clear error the frontend can show.
- If a requirement is unclear or a decision below is still open, ask rather than guess.

## Repository

- GitHub repo: `jakdevreal/hackucd`
- We work as GitHub user `mrcheesechase`, which has access to this repo. Use this account for commits, pushes and pull requests.
