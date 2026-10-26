# Samvaad

Two people who don't share a single language, having a real argument: interrupting, getting heated, changing their minds.

**Live:** https://samvaad-i85f.onrender.com · Open it, pick your language, send the link (or QR) to the other person.

## Why an argument is different from a conversation

Translation apps assume turns: hold a button, finish, wait, the other person answers. An argument breaks every one of those assumptions, so:

1. **No push-to-talk.** Both mics are always open. Both people can talk at once; overlapping speech shows side by side and the top bar says "Both talking".
2. **You see them before they finish.** Their words stream to your screen while they're still speaking: raw text first, then a live translation that updates every few words, replaced by the final one when they pause.
3. **Interrupting works.** Start talking while your phone is reading their line aloud and it stops immediately. Their screen then shows "cut off before they heard the end", which is true, and is exactly what people argue about.
4. **No softening.** The interpreter prompt keeps insults, sarcasm and swearing at the same strength. A translator that politely mediates is lying to both people.
5. **Heat travels.** Each line gets an intensity (0–3) and a tone (angry, sarcastic, hurt, pleading, joking, dismissive). It changes the type weight on screen and the rate and pitch of the voice. Sarcasm gets a label because it rarely survives translation.
6. **Changing your mind is visible.** The model flags lines that concede a point, reverse an earlier position, or take something back. "Take it back" on your own line strikes it through on every screen.
7. **You can check how you landed.** Under your own line: a back-translation of what the other person actually received. If it came out wrong, you find out before the fight escalates over a mistranslation.
8. **"Didn't get it"** on every line you receive. It tells the speaker, in their language and out loud, to say it another way.
9. **Context.** The last 8 lines go with every translation, so "he", "that" and "you always" resolve correctly.
10. **Latency over completeness.** If lines arrive faster than the voice can read them, older queued ones are skipped (they stay on screen). Hearing a line 20 seconds late in a fight is worse than reading it.
11. **The UI speaks your language.** The language picker shows native names, and the interface is translated for each language on first load, so someone who reads no English can join from a link.

## How it works

```
Phone A (speaks Hindi)                     Server (Node + ws)                    Phone B (speaks Tamil)
browser speech-to-text (hi-IN) ──partial──▶ relay raw text instantly ───────────▶ live caption
                               ──partial──▶ every ~3 new words: LLM fragment ───▶ live translation
                               ──final────▶ LLM with last 8 lines → JSON ───────▶ final caption + voice (ta-IN)
                                            {translation, back, intensity,         rate/pitch from intensity
◀──────── "landed": back-translation ─────  tone, shift}
◀──────── "cutoff" / "huh" ───────────────────────────────────────────────────── B interrupts / didn't get it
```

Speech recognition and speech synthesis run in the browser. The server only moves text and calls the translation model, so it's cheap and runs on a free host.

## Run locally

```bash
npm install
cp .env.example .env   # add an API key (Groq free tier works)
npm run dev            # http://localhost:3000
```

To test alone, open the room link in a second Chrome profile or window and use the type box in one of them (one mic per machine). To use a phone, you need HTTPS for the mic, so use the deployed link or a tunnel (ngrok or cloudflared).

## Deploy (Render, free)

Push to GitHub, then in Render choose New → Blueprint and pick the repo; it reads `render.yaml`. Set `LLM_API_KEY`. Free instances sleep after inactivity, so open the link a minute before anyone tests it. Railway and Fly work too. Vercel won't work, because it doesn't support long-lived WebSockets.

## Translation backends

| `LLM_PROVIDER` | What you get |
|---|---|
| `openai` (any OpenAI-compatible API, Groq by default) | Everything. Groq is chosen for speed. |
| `anthropic` | Everything. |
| none / no key | Free MyMemory fallback: final translations only, no tone, no back-translation, no live partials. |

## Known limits

- Speech recognition is the browser's. Chrome and Edge on desktop and Android are good. Safari on iOS works less reliably. Firefox has none, so it falls back to the type box.
- In the same room with both phones on speaker, the phones hear each other. There's an echo filter (it drops recognised text that matches what your own phone just said), but headphones, or voice off with captions only, work better.
- Chrome's recogniser splits lines on pauses, so very fast back-and-forth can merge two thoughts into one line.
- Rooms live in memory. A restart clears them. That's fine for this, not for production.
- The QR code image comes from api.qrserver.com.

## What I'd do next

- Move speech-to-text to the server, using a streaming model that's strong on Indian languages and code-mixed speech, so it behaves the same in every browser and gets proper turn detection.
- Stream translation tokens instead of waiting for the full JSON.
- One-phone mode: a single device on the table, with language ID deciding who's speaking.
- Speak in each person's own voice, so the heat is theirs and not a robot's.
- Measure the one number that matters: time from the speaker stopping to the listener hearing the translation.
