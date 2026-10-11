# OutSpoken

**Sound sharper in your next video.**

OutSpoken is a speaking coach for creators who talk to camera. Record a take, and it points to the exact moments where you hedged, rambled, repeated yourself or said "um", with what to say instead.

## Why OutSpoken

Most creators never get feedback on *how* they speak, only on how a video performs. Views and watch time tell you something went wrong, but not that your opening hedged twice or that you started three sentences with "so". Generic speaking advice doesn't help much either, because it isn't tied to anything you actually said.

OutSpoken listens to your own words and coaches you on them, so every take leaves you with something specific to fix.

## Who it's for

- YouTubers and TikTok, Instagram and Shorts creators who talk to camera
- Podcasters and streamers
- Anyone building a channel who wants to sound clearer and more confident before they hit publish

## How it works

1. **Pick a prompt.** A short topic to talk about in your own words, for example "Pick one concept from your niche and explain it."
2. **Record.** Use your mic in the browser, or upload an audio file.
3. **Get it transcribed.** Every word is captured with its exact timing.
4. **Get it analysed.** Your pace, fillers, pauses and repeated words are measured, then an AI coach reviews what you said and how you said it.
5. **Get feedback.** Play your take back with the coaching moments highlighted, and work through the notes.

No account and no sign-up needed.

## Features

- **Prompted practice:** topics that give you something to talk about, plus a check on whether you answered the prompt and stayed on it.
- **Moment-by-moment coaching:** up to eight notes, most important first, covering openings, fillers, repetition, clarity, structure, pacing and endings.
- **Highlighted transcript:** coaching moments, filler words and long pauses are marked in your own words. Tap any highlight to hear that moment.
- **Measured habits:** words per minute, fillers by word, repeated words, repeated sentence starters and long pauses, so you can compare one take with the next.
- **Summary:** what worked, and the top things to change before your next video.

## Feedback you can trust

- **Grounded in your words:** every coaching note quotes your transcript exactly. If a quote can't be found in what you said, it's dropped, so the coaching never points at words you didn't say.
- **Exact numbers:** pace, filler counts and pauses are calculated directly from the word timings rather than estimated, so they're consistent from take to take.
- **Tested models:** we compared Claude Sonnet and Claude Haiku on the same takes. Both were accurate on the measured metrics, and Haiku gives fast, comparable coaching.
- **Clear errors:** oversized files, video uploads, silent recordings and slow analyses each get a plain message that tells you what to do next.

## Example

From a real 36-second take answering "Pick one concept from your niche and explain it." (85 words, 143 words per minute, 1 filler):

> **Summary:** You answered the prompt directly and stayed on topic. Your delivery is steady, with no long pauses. Tighten the opening, define your key terms and end on a clear sentence.

| Noticed | Should be |
| --- | --- |
| **Opening (0:04):** "sort of like". The first sentence hedges twice ("sort of like", "more or less") before getting to the point. | "The same origin policy stops one website from reading another website's data in your browser." |
| **Clarity (0:17):** "from other origins". "Origins" is used as if viewers already know what it means. | "...from other origins, meaning a different domain, protocol, or port." |
| **Filler (0:21):** "um". A hesitation right in the middle of the key rule. | Pause silently for a beat, then say the rule cleanly. |
| **Ending (0:35):** "to share them with." The take fizzles out with no takeaway. | "So it protects users and gives you control over who can read your site's content." |

## Built with

| | |
| --- | --- |
| App | JavaScript single-page app (Vue 3, Tailwind CSS) |
| Server | Node.js with Express |
| Transcription | ElevenLabs Scribe v2 via OpenRouter, with word-level timestamps |
| Coaching | Claude via OpenRouter |
## Roadmap

- **Progress over time:** see how each take compares with your earlier ones.
- **Prompts for your weak spots:** topics that target the area you struggle with most.
- **Video delivery:** eye contact, energy and on-screen presence, not just audio.
- **Creator profiles:** coaching tuned to your platform and format, from 30-second Shorts to long-form podcasts.
- **Accounts:** keep your reports and practice history across devices.
