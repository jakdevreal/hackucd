# OutSpoken: design handover

Handover for a design pass on the OutSpoken web app. The working prototype is `frontend/index.html` in the `jakdevreal/hackucd` repo: a single page built with Vue 3 and Tailwind CSS (both from a CDN, no build step). It talks to a live backend, so any redesign must keep the same flow and data (see "Constraints").

## Product

**OutSpoken** helps social media creators become better speakers. A creator records or uploads a short take of themselves talking. The app transcribes it with AI and returns specific coaching they can act on before their next video: filler words, overused words, weak openings, rambling sentences and long pauses, each tied to what they actually said.

- **Users:** creators who talk to camera (TikTok, YouTube, Instagram).
- **Context:** built for HackUCD 2026 by a team of 4. A working end-to-end demo matters more than completeness. Judges score user focus, craft, focus/scope, curiosity and AI use, plus a bonus for a working Stripe sandbox subscription.
- **Tone:** encouraging, practical, plain English. Feedback says what to do instead, never just what went wrong.

## Brand

| Role | Token | Hex | Used for |
| --- | --- | --- | --- |
| Primary | `primary` | `#10B981` (emerald) | Main buttons, active states, play button, brand mark |
| Accent | `accent` | `#06B6D4` (cyan) | Audio waveforms, secondary highlights, "Best value" badge |
| Secondary | `mint` | `#A7F3D0` | Positive feedback, subtle emphasis, Pro badge, info banners |
| Neutral | `warm` | `#EDE9E8` (warm grey) | Borders, dividers, subdued elements |
| Background | `paper` | `#FAFAF8` (soft off-white) | Page background |

- Text is Tailwind `stone` greys (`stone-800` body, `stone-500`/`600` secondary). Errors use Tailwind `red-50`/`red-800`.
- Typography is the system sans-serif stack, with a monospace font for timers and timestamps. No custom font yet; one is welcome if it stays light.
- Shapes: rounded cards (`rounded-2xl`), 1px warm-grey borders, white card surfaces on the off-white page, very light shadows on buttons only.
- Logo: an emerald rounded square with a white microphone icon, next to the word "OutSpoken" in bold.
- Light theme only for now.

## Page structure (top to bottom)

One scrolling page with anchor links. Max content width is about 1024px, with a 16px side gutter on phones.

### 1. Header (sticky)
- Logo on the left.
- Nav links "Record" and "Feedback" in the middle (hidden on phones).
- On the right:
  - **Free users:** the text "1 free analysis today" or "Free analysis used today" (hidden below tablet width), then an emerald **Go Pro** button.
  - **Subscribers:** a mint "Pro" pill, or "Pro · trial" during the free trial.

### 2. Hero
- Mint pill: "For creators who talk to camera".
- Headline: "Sound sharper in your **next video**" (the last two words in emerald).
- Subtext: "Record a take. We'll point to the exact moments where you ramble, repeat yourself or say "um", and tell you what to say instead."
- Buttons: **Record a take** (primary, jumps to Record) and **See a sample report** (white/outlined, fills Feedback with a sample).
- Small print: "One free full analysis every day. No sign-up."
- Three feature cards, each an emoji, a title and one line:
  - **Record or upload:** use your mic or drop in a voice memo.
  - **Specific feedback:** every note quotes what you said and shows a better way.
  - **Hear it back:** replay your take, then read one clear paragraph on what to change.

### 3. Record or upload ("1. Record or upload")
One card containing:
- **Live waveform:** a wide strip of cyan bars that move with the mic while recording, and sit faded and still when idle.
- **Timer:** `0:00` in large monospace, emerald while recording.
- **Main button:** "Start recording" (emerald pill with a white dot), which becomes "Stop" (dark pill with a white square) while recording, and "Record again" once there's a take.
- **Upload link:** "or upload an audio file" as an underlined text link that opens a file picker (audio only).
- **Once there's a take:**
  - A divider row with the file name and a native audio player for a quick listen.
  - The **Get feedback** button, whose label changes to "Uploading…" then "Transcribing…" while it works.
  - A hint under the button: "Uses today's free analysis", "Unlimited with Pro", "Free analysis used today" or "Usually 5–40 seconds".
- **Errors:** a red box in the card (mic blocked, upload failed, server unreachable) with a link "See a sample report instead".

### 4. Your feedback ("2. Your feedback")
- **Empty state:** a dashed-border box saying "Your feedback will appear here after you record a take."
- **Sample banner:** for the sample report, a mint banner first: "This is a sample report…"
- **Box 1, playback:** a large round emerald play/pause button on the left and the recording's waveform on the right, drawn from the real audio.
  - Bars already played are solid cyan; the rest are faded cyan.
  - Clicking the waveform jumps to that point.
  - Current time and total length sit below the waveform in small monospace.
  - For the sample report, the play button is disabled because there's no audio.
- **Box 2, written feedback:** the title "Feedback" and **one paragraph** of coaching.

  Example: *"You spoke at about 129 words per minute, a comfortable pace for viewers. You used 6 filler words, mostly "um" (2), "like" (1), "kind of" (1); try a short silent pause instead. You leaned on "really" 3 times, so swap in genuinely or truly now and then. Your opening ("Hey guys, um, so today I wanted to, like, kind…") warms up instead of making a point, so lead with your hook. At 0:08, "So basically, I wake up really early, and, um, I drink a…" would land better as "So I wake up really early, and I drink a glass of water.""*

  The paragraph runs from 1 to about 8 sentences, depending on the take. Very short takes open with a note asking for 30+ seconds.

The team's reference sketch for this section is two stacked grey boxes: a play chevron beside a waveform, and below it a single feedback paragraph.

### 5. Footer
"OutSpoken · HackUCD", centred and small.

### 6. Paywall popup (modal)
Opens when a free user tries a second analysis on the same day, or presses Go Pro.

- **Title and subtext:**
  - After the free use: "You've used today's free analysis" / "Come back tomorrow for another free one, or start a free trial for unlimited feedback now."
  - From Go Pro: "Go Pro with OutSpoken" / "Unlimited full analyses on every take."
- **Plan cards** (selectable, the selected one has an emerald border and a mint tint):
  - **Monthly:** €15/month. "Billed monthly after your trial".
  - **Yearly:** €150/year. "€12.50/month · save €30", with a cyan "Best value" badge. Selected by default.
- **Perks** with emerald ticks: "Unlimited full analyses, every day", "Written feedback on every take", "7 days free, cancel any time".
- **Main button:** **Start 7-day free trial**, which reads "Opening checkout…" while loading.
- **Small print:** "Then €150/year. Cancel any time before the trial ends and you won't be charged. Payments by Stripe."
- **Errors:** a red line under the button.
- **Closing:** an ✕ button, a click on the backdrop, or Esc. On phones it sits at the bottom of the screen; on larger screens it's centred.

### 7. Toast
A small dark rounded bar near the top with an "OK" link. It's used after checkout:
- "You're on OutSpoken Pro. Your free trial runs until 17/10/2026."
- "Checkout cancelled. You have not been charged."

## States to design

| Area | States |
| --- | --- |
| Recorder | idle, recording (live waveform + timer), take ready, uploading, transcribing, error |
| Feedback | empty, sample report (no audio), real report (paused / playing / seeking), very short take |
| Header | free with use left, free used, Pro trial, Pro active |
| Paywall | from limit vs from Go Pro, monthly / yearly selected, loading, error |
| Phone layout | everything at 375px wide with no sideways scrolling; popup as a bottom sheet |

## Constraints (please keep)

- **Flow:** record or upload → Get feedback → upload → transcribe → feedback. The backend supplies the transcript text and a timestamp for every word; everything in the feedback is derived from that in the browser.
- **Payments:** Stripe Checkout (sandbox), hosted by Stripe, so there's no card form to design on our side. The site only needs the plan choice and a return state.
- **Free use:** one free analysis per day, remembered in the browser. There are no accounts and no login.
- **Tech:** single-page Vue + Tailwind. Keep designs implementable with Tailwind classes and the palette tokens above.
- **Accessibility:** keep visible labels on icon buttons (play/pause, close), keyboard close for the popup, and readable contrast. Note that white text on `#10B981` is on the light side, so consider a darker emerald for small text on buttons.

## Open questions for design

1. A custom typeface, or stay with system fonts?
2. Should the feedback paragraph get light emphasis (e.g. bold quoted phrases), or stay plain prose as now?
3. Should the hero show a product preview (e.g. the two feedback boxes) instead of the three feature cards?
4. The paywall currently highlights Yearly. Is that the right default?
