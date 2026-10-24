# Demo microphone picks (under $30, same-day in San Francisco)

> Desk research, Oct 24, 2026, for the Cal Hacks demo at the Palace of Fine Arts. Prices and stock were not checked live. Not yet measured on our setup. See also `Microphone_Hardware_Research.md`.

**What matters for live F1/F2 tracking in a noisy hall.** The app turns off the browser's echo cancellation, noise suppression and auto gain, because they distort the spectral envelope. So:

1. **Distance first.** A mic a few cm from the mouth rejects crowd babble far better than any laptop or desk mic.
2. **No built-in "AI / ENC noise cancelling".** It reshapes the spectrum the same way browser noise suppression does. Plain analog capsules or simple USB audio are best.
3. **Flat response from 100 Hz to at least 4 kHz.** F2 reaches about 3 kHz.
4. **Plug-and-play on a MacBook.** USB-C, or a 3.5 mm 4-pole **TRRS** plug. A 3-pole TRS plug doesn't register as a mic on a Mac.

**Picks:**

| Rank | Mic | Price | Why | Caveat |
|---|---|---|---|---|
| 1 | Logitech H390 USB-C headset (Best Buy SKU 6634713) | ≈ $22–25 | Boom a few cm from the mouth; bi-directional capsule cancels distant sound; no dongle | Logitech names no noise-cancelling processing, but doesn't confirm there is none |
| 2 | Saramonic LavMicro U3A (USB-C lavalier) | ≈ $30 | Direct USB-C, no driver, no noise processing listed, 50 Hz–20 kHz | Omni: tape it 3–5 cm from the corner of the mouth; clipped to a collar it lets in much more crowd |
| 3 | Turtle Beach Recon 50P (3.5 mm TRRS headset) | ≈ $28 | Plain analog, plugs into the Mac's headphone jack | Omni boom |

Avoid generic wireless lavs advertising "AI noise reduction" (for example, unbranded clip-ons sold under accessory brands).

**Setup:**
- Put the mic 2–3 cm off the corner of the mouth, out of the breath stream.
- Select it in macOS Sound → Input, and in Chrome's mic setting for the site.
- Record the model voice with the same mic, in the same position, as the demo.
- Before relying on it, save one 3 s clip on `?check` with each mic and compare them offline (`scripts/eval/inspect-clip.ts`).
