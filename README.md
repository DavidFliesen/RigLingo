# RigLingo v1.1.0

> **Live two-way voice translation for ham radio.** Hear other stations in your language and reply in theirs. Speech recognition, translation and neural voices all run on your own computer, and RigLingo keys your rig by CAT, RTS, DTR or VOX. Built for the Yaesu FT-991A. A desktop Chrome/Edge PWA with no API keys.

**Running app:** https://davidfliesen.github.io/RigLingo/

**Design conversation:** [How RigLingo was planned and built](SHARE_LINK_HERE)

---

Live two-way voice translation for ham radio. RigLingo listens to your radio, transcribes and translates the other station into your language, and speaks it to your headset. When you reply, it transcribes you, translates into their language, keys the radio and sends the translated speech over the air. Built around the **Yaesu FT-991A** over a single USB cable.

An ARTEZIQ app by ARTEZIQ and Kathryn Mullan.

---

## How it works

```
RECEIVE   radio USB audio ─► voice trigger ─► Whisper (speech-to-text) ─► on-device translator ─► voice ─► your headset
TRANSMIT  your mic (hold Talk) ─► Whisper ─► translator ─► review ─► neural voice ─► radio USB audio, PTT keyed by CAT/RTS/DTR/VOX
```

Everything runs on your computer:
- **Speech recognition:** OpenAI Whisper (tiny / base / small) via Transformers.js, on WebGPU when available, CPU otherwise.
- **Translation:** Chrome's built-in on-device Translator and Language Detector. No API keys, no cloud.
- **Voices sent to the radio:** Meta MMS neural voices via Transformers.js (English, French, Spanish, German, Italian, Portuguese, Dutch, Polish). Other languages fall back to a system voice.
- **Radio control:** Web Serial for CAT commands (`TX1;` / `TX0;`, frequency and mode readout) or RTS/DTR line keying.

Models download once on first use (Hugging Face / jsDelivr) and are cached, after which RigLingo works offline.

## Requirements

- **Desktop Chrome 138+ or Edge** on Windows, macOS or Linux. iPad and phones lack Web Serial and audio-output routing.
- WebGPU strongly recommended (any recent GPU) for fast recognition.
- FT-991A connected by USB, with the **Silicon Labs CP210x** driver installed (Windows shows two COM ports: *Enhanced* and *Standard*).
- A headset, so translated audio doesn't leak back into your microphone.

## Radio setup (FT-991A)

Menu numbers vary by firmware, so find these by name:

| Setting | Value | Why |
|---|---|---|
| CAT RATE | Match RigLingo (default 4800) | Serial speed for CAT |
| SSB MOD SOURCE (also FM / AM if used) | REAR | Transmit audio comes from the rear/USB input instead of the front mic |
| SSB PORT SELECT (and data port select) | USB | Use the USB sound card, not the DATA jack |
| SSB PTT SELECT | RTS or DTR | **Only** if you key by RTS/DTR line instead of CAT |

Set the USB transmit level low to start, then raise RigLingo's **TX audio level** while watching ALC. Too much drive splatters.

## Using it

The header always shows plain-language status: radio connection, models, listening, and a red **On air** label whenever RigLingo is transmitting. The app follows your system's light or dark setting.


1. **Connect radio** – choose the *Enhanced* COM port for CAT keying, or the *Standard* port for RTS/DTR keying. Click **Test key** with a dummy load or clear frequency to confirm.
2. **Allow audio** – RigLingo picks the *USB Audio CODEC* for radio in and out automatically. Choose your mic and headset.
3. **Languages** – pick the other station's language (or Auto-detect) and yours, then **Download & prepare** (first time per language pair).
4. **Station** – enter your callsign. RigLingo gives an **English station ID** automatically when 10 minutes have passed (or every transmission, or manually).
5. **Start listening.** Adjust **Voice trigger** so the dark marker sits just above the noise level on the meter.
6. Hold **Talk** (or the space bar) and speak. Release, check the translation, press **Transmit**. Or type a message and press **Translate**.

**Esc** or **Unkey now** stops any transmission instantly. A TX timeout (default 90 s) is a backstop.

## Languages

| Language | Recognition | Translation | Voice to radio |
|---|---|---|---|
| English, French, Spanish, German, Italian, Portuguese, Dutch, Polish | Whisper | On-device | Neural (routed to radio) |
| Russian, Ukrainian, Japanese, Chinese, Korean, Arabic, Hindi, Turkish | Whisper | On-device | System voice (Windows default output) |

System voices can't be routed to a chosen device by browsers. For those languages, set the Windows default playback device to the radio's USB Audio CODEC while operating, or use a neural-voice language.

Neural voices read numbers digit by digit, ham style ("5 9" → "five nine").

## Operating notes

- **FCC Part 97:** other languages are fine, but station identification must be in English. You remain the control operator for everything RigLingo transmits; keep **review before transmit** on until you trust it.
- **Weak signals hurt recognition.** Strong SSB, FM/VHF, and the radio's DNR help a lot. Whisper Small handles noise best but is slower.
- RigLingo ignores receive audio while it transmits, and filters common Whisper "noise hallucinations".
- Only one program can hold a COM port. Close WSJT-X or logging software, or use VOX keying.
- With RTS/DTR keying, opening the port can raise the line for a few milliseconds before RigLingo drops it.

## Troubleshooting

- **"No on-device translator"** – update Chrome; the Translator API ships in Chrome 138+ on desktop.
- **Translation pack blocked** – packs download only after a click; use **Download & prepare** for that pair.
- **Radio doesn't key** – check COM port (Enhanced for CAT), CAT RATE, and try stop bits 1 or hardware flow control.
- **Transmits silence** – mod source is not REAR/USB, or the radio output isn't the USB Audio CODEC.
- **Hears itself** – use a headset, or lower speaker volume.

## Files

```
index.html             App page
styles.css             Styles (hardcoded hex colors)
app.js                 App logic (ES5)
worker.js              Speech engine worker (Whisper + MMS voices; one ES-module import line)
sw.js                  Offline service worker
manifest.webmanifest   PWA manifest
icons/                 App icons (192, 512, maskable, Apple touch, favicon)
README.md              This file
```

## Changelog

**v1.1.0** – Redesigned for comfort and readability: calm light theme with a soft dark mode for night operating, larger text, conversation-style log (heard on the left, you on the right), plain-language status labels, a quieter unsupported-device notice, and a new app icon. Credits updated.

**v1.0.0** – First release: receive and transmit translation pipelines, CAT/RTS/DTR/VOX keying with frequency/mode readout, 16 languages with auto-detect, review-before-transmit, English auto-ID with phonetics, TX timeout and instant unkey, offline PWA.
