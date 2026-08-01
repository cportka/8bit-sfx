#!/usr/bin/env python3
"""Generate the 8bit-sfx library: 1000 deterministic 8-bit sound effects.

10 categories x 100 variations, synthesized NES-style (square/triangle waves,
15-bit LFSR noise, 16-level amplitude quantization) and written as 8-bit
unsigned mono WAV at 22050 Hz. Pure stdlib; a private xorshift PRNG seeded from
each effect's name keeps every file byte-for-byte reproducible on any platform.

Usage:
  scripts/generate_sfx.py [--out DIR] [--only NAME ...]

  --out DIR    output root (default: sfx/ next to the repo root)
  --only NAME  generate only the named effect(s), e.g. jump_007 coin_042;
               skips the manifest so spot-checks don't touch it
"""

import argparse
import json
import math
import os
import sys
import wave
import zlib

SR = 22050
VARIATIONS = 100
MASTER_GAIN = 0.8
QUANT_LEVELS = 15.0  # 16 amplitude steps, like a 4-bit chip DAC


class Rng:
    """xorshift32 — deterministic across Python versions and platforms."""

    def __init__(self, name):
        self.s = zlib.crc32(name.encode()) & 0xFFFFFFFF or 0x9E3779B9

    def _u32(self):
        x = self.s
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        self.s = x
        return x

    def random(self):
        return self._u32() / 4294967296.0

    def uniform(self, a, b):
        return a + (b - a) * self.random()

    def randint(self, a, b):
        return a + self._u32() % (b - a + 1)

    def choice(self, seq):
        return seq[self._u32() % len(seq)]


def midi(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


class Lfsr:
    """NES-style 15-bit noise, sample-and-hold clocked every `period` samples."""

    def __init__(self, rng, period):
        self.state = rng.randint(1, 32767)
        self.period = max(1, period)
        self.count = 0
        self.out = 1.0

    def next(self):
        if self.count == 0:
            bit = (self.state ^ (self.state >> 1)) & 1
            self.state = (self.state >> 1) | (bit << 14)
            self.out = 1.0 if self.state & 1 else -1.0
        self.count = (self.count + 1) % self.period
        return self.out


def square(phase, duty):
    return 1.0 if (phase % 1.0) < duty else -1.0


def triangle(phase):
    return 4.0 * abs((phase % 1.0) - 0.5) - 1.0


def render_tone(n, freq_fn, duty, env_fn, wave_fn=None):
    """Accumulate phase against a per-sample frequency; shape with env_fn."""
    out = []
    phase = 0.0
    for i in range(n):
        t = i / SR
        phase += freq_fn(t) / SR
        s = triangle(phase) if wave_fn == "tri" else square(phase, duty)
        out.append(s * env_fn(t))
    return out


def decay(rate):
    return lambda t: math.exp(-rate * t)


# --- categories -----------------------------------------------------------


def gen_jump(rng):
    dur = rng.uniform(0.15, 0.35)
    f0 = rng.uniform(midi(55), midi(67))
    sweep = rng.uniform(2.0, 4.0)  # octaves-ish upward glide
    duty = rng.choice([0.125, 0.25, 0.5])
    rate = rng.uniform(4.0, 9.0)
    rng.tags = {"style": "jump", "duty": duty, "f0": int(round(f0)),
                "sweep": round(sweep, 1), "snap": "snappy" if rate > 6.5 else "floaty"}
    return render_tone(
        int(dur * SR),
        lambda t: f0 * (2.0 ** (sweep * t / dur)),
        duty,
        decay(rate),
    )


def gen_coin(rng):
    dur = rng.uniform(0.25, 0.5)
    n = int(dur * SR)
    root = rng.randint(76, 88)  # high register
    jump_iv = rng.choice([3, 4, 5, 7])
    split = rng.uniform(0.2, 0.35)
    duty = rng.choice([0.25, 0.5])
    rate = rng.uniform(5.0, 10.0)
    env = decay(rate)
    rng.tags = {"style": "coin", "duty": duty, "root_hz": int(round(midi(root))),
                "interval": {3: "minor third", 4: "major third", 5: "fourth", 7: "fifth"}[jump_iv],
                "split_pct": int(round(split * 100)), "fade": round(rate, 1)}
    freq = lambda t: midi(root) if t < dur * split else midi(root + jump_iv)
    return render_tone(n, freq, duty, env)


def gen_laser(rng):
    dur = rng.uniform(0.15, 0.4)
    f0 = rng.uniform(midi(84), midi(96))
    f1 = rng.uniform(midi(48), midi(64))
    duty = rng.choice([0.125, 0.25, 0.5])
    vib = rng.uniform(0.0, 30.0)
    rng.tags = {"style": "laser", "duty": duty, "from_hz": int(round(f0)), "to_hz": int(round(f1)),
                "wobble": "warbled" if vib > 15 else "clean"}
    return render_tone(
        int(dur * SR),
        lambda t: f0 * (f1 / f0) ** (t / dur) + vib * math.sin(60.0 * t),
        duty,
        decay(rng.uniform(3.0, 8.0)),
    )


def gen_explosion(rng):
    dur = rng.uniform(0.5, 1.2)
    n = int(dur * SR)
    noise = Lfsr(rng, rng.randint(2, 8))
    rate = rng.uniform(2.5, 6.0)
    rumble = rng.uniform(0.0, 0.5)
    rng.tags = {"style": "explosion", "grit": noise.period, "fade": round(rate, 1),
                "tail": "long" if rate < 4.0 else "short",
                "rumble_pct": int(round(rumble * 100))}
    out = []
    prev = 0.0
    for i in range(n):
        t = i / SR
        # one-pole average tames the hiss into a boom
        prev = prev * 0.6 + noise.next() * 0.4
        s = prev + rumble * triangle(t * rng_freq_cache(rng, i))
        out.append(s * math.exp(-rate * t))
    return out


def rng_freq_cache(rng, i):
    # constant per-file rumble frequency, decided on first use
    if not hasattr(rng, "_rumble"):
        rng._rumble = rng.uniform(30.0, 60.0)
    return rng._rumble


def gen_powerup(rng):
    dur = rng.uniform(0.4, 0.8)
    n = int(dur * SR)
    steps = rng.randint(4, 8)
    root = rng.randint(60, 72)
    scale = rng.choice([[0, 2, 4, 7, 9], [0, 3, 5, 7, 10], [0, 4, 7]])
    duty = rng.choice([0.25, 0.5])
    rng.tags = {"style": "powerup", "duty": duty, "steps": steps, "root_hz": int(round(midi(root))),
                "flavor": {5: "major-pentatonic", 3: "major-triad"}.get(len(scale), "minor-pentatonic")}
    seq = [midi(root + scale[i % len(scale)] + 12 * (i // len(scale))) for i in range(steps)]
    freq = lambda t: seq[min(int(t / dur * steps), steps - 1)]
    env = lambda t: min(1.0, 8.0 * (dur - t) / dur)
    return render_tone(n, freq, duty, env)


def gen_hit(rng):
    dur = rng.uniform(0.08, 0.2)
    n = int(dur * SR)
    noise = Lfsr(rng, rng.randint(1, 4))
    f0 = rng.uniform(midi(50), midi(62))
    duty = rng.choice([0.25, 0.5])
    mix = rng.uniform(0.4, 0.7)
    env = decay(rng.uniform(15.0, 30.0))
    rng.tags = {"style": "hit", "duty": duty, "thud_hz": int(round(f0)),
                "balance": "noise-forward" if mix > 0.55 else "tone-forward"}
    out = []
    phase = 0.0
    for i in range(n):
        t = i / SR
        phase += (f0 * (0.5 ** (t / dur))) / SR
        s = mix * noise.next() + (1.0 - mix) * square(phase, duty)
        out.append(s * env(t))
    return out


def gen_blip(rng):
    dur = rng.uniform(0.04, 0.12)
    f = midi(rng.randint(72, 96))
    duty = rng.choice([0.125, 0.25, 0.5])
    rate = rng.uniform(20.0, 40.0)
    rng.tags = {"style": "blip", "duty": duty, "hz": int(round(f)), "fade": int(round(rate))}
    return render_tone(int(dur * SR), lambda t: f, duty, decay(rate))


def gen_alarm(rng):
    dur = rng.uniform(0.4, 1.0)
    n = int(dur * SR)
    fa = midi(rng.randint(69, 81))
    fb = fa * rng.choice([1.26, 1.33, 1.5])
    cycle = rng.uniform(0.06, 0.15)
    duty = rng.choice([0.25, 0.5])
    rng.tags = {"style": "alarm", "duty": duty, "low_hz": int(round(fa)), "high_hz": int(round(fb)),
                "cycle_ms": int(round(cycle * 1000)),
                "pace": "frantic" if cycle < 0.09 else "steady"}
    freq = lambda t: fa if int(t / cycle) % 2 == 0 else fb
    env = lambda t: 1.0 if t < dur * 0.8 else max(0.0, (dur - t) / (dur * 0.2))
    return render_tone(n, freq, duty, env)


def gen_drone(rng):
    dur = rng.uniform(0.6, 1.2)
    f0 = rng.uniform(midi(33), midi(45))
    wob_rate = rng.uniform(3.0, 9.0)
    wob_amt = rng.uniform(0.01, 0.06)
    duty = rng.choice([0.25, 0.5])
    wf = rng.choice([None, "tri"])
    rng.tags = {"style": "drone", "wave": "triangle" if wf == "tri" else "square",
                "hz": int(round(f0)), "wobble_hz": round(wob_rate, 1),
                "depth": "seasick" if wob_amt > 0.035 else "gentle"}
    freq = lambda t: f0 * (1.0 + wob_amt * math.sin(2 * math.pi * wob_rate * t))
    env = lambda t: min(1.0, 12.0 * t / dur, 6.0 * (dur - t) / dur)
    return render_tone(int(dur * SR), freq, duty, env, wave_fn=wf)


def gen_jingle(rng):
    dur = rng.uniform(0.5, 1.2)
    n = int(dur * SR)
    notes = rng.randint(3, 6)
    root = rng.randint(65, 77)
    scale = [0, 2, 4, 7, 9, 12]
    duty = rng.choice([0.25, 0.5])
    seq = [midi(root + rng.choice(scale)) for _ in range(notes - 1)]
    seq.append(midi(root + rng.choice([12, 16, 19])))  # end on a high resolve
    rng.tags = {"style": "jingle", "duty": duty, "notes": notes, "root_hz": int(round(midi(root))),
                "resolve_hz": int(round(seq[-1]))}
    step = dur / notes
    freq = lambda t: seq[min(int(t / step), notes - 1)]
    env = lambda t: math.exp(-3.0 * ((t % step) / step))
    return render_tone(n, freq, duty, env)




# --- expansion categories (designed per-category, see CHANGELOG 0.3.0) ---


def gen_ambient(rng):
    """Environmental beds: wind, crickets, cave drips, thunder, rain, eerie shimmer."""
    style = rng.choice(["wind", "crickets", "drips", "thunder", "rain", "shimmer"])

    def edge_fade(buf, ms_in, ms_out):
        n = len(buf)
        fi = min(n // 2, int(SR * ms_in / 1000.0))
        fo = min(n // 2, int(SR * ms_out / 1000.0))
        for i in range(fi):
            buf[i] *= 0.5 - 0.5 * math.cos(math.pi * i / fi)
        for i in range(fo):
            buf[n - 1 - i] *= 0.5 - 0.5 * math.cos(math.pi * i / fo)
        return buf

    def finish(buf, ms_in, ms_out):
        edge_fade(buf, ms_in, ms_out)
        peak = 0.0
        for v in buf:
            a = v if v >= 0.0 else -v
            if a > peak:
                peak = a
        if peak < 1e-9:
            return buf
        g = rng.uniform(0.6, 0.85) / peak
        return [max(-1.0, min(1.0, v * g)) for v in buf]

    if style == "wind":
        # gusting wind: white LFSR through a one-pole lowpass whose cutoff and
        # gain both ride a slow gust envelope (sum of gaussian swells)
        dur = rng.uniform(1.8, 3.0)
        n = int(SR * dur)
        noise = Lfsr(rng, 1)
        gusts = []
        for _ in range(rng.randint(2, 4)):
            gusts.append((rng.uniform(0.15, 0.85) * dur,
                          rng.uniform(0.25, 0.6),
                          rng.uniform(0.5, 1.0)))
        base = rng.uniform(0.15, 0.3)
        rng.tags = {
            "style": "wind",
            "gusts": len(gusts),
            "bed": "calm" if base < 0.22 else "steady",
            "swell": "towering" if max(a for (_, _, a) in gusts) >= 0.8 else "gentle",
        }
        lp = 0.0
        out = []
        for i in range(n):
            t = i / SR
            g = base
            for (c, w, a) in gusts:
                d = (t - c) / w
                g += a * math.exp(-d * d)
            if g > 1.0:
                g = 1.0
            alpha = 0.02 + 0.12 * g  # stronger gust = brighter hiss
            lp += alpha * (noise.next() - lp)
            out.append(lp * g)
        return finish(out, 120.0, 250.0)

    if style == "crickets":
        # 2-3 cricket voices: trains of short triangle pulses at a chirp rate,
        # grouped into chirps with silent gaps, each voice its own pitch/rhythm
        dur = rng.uniform(2.0, 3.0)
        n = int(SR * dur)
        out = [0.0] * n
        voices = rng.randint(2, 3)
        lead_hz = None
        lead_rate = None
        for _ in range(voices):
            carrier = rng.uniform(2600.0, 4600.0)
            prate = rng.uniform(22.0, 42.0)
            if lead_hz is None:
                lead_hz = carrier
                lead_rate = prate
            amp = rng.uniform(0.5, 1.0)
            t = rng.uniform(0.0, 0.5)
            while t < dur:
                clen = rng.uniform(0.25, 0.7)
                pt = t
                stop = t + clen
                if stop > dur:
                    stop = dur
                while pt < stop:
                    i0 = int(pt * SR)
                    m = int(0.55 / prate * SR)
                    ph = 0.0
                    for k in range(m):
                        idx = i0 + k
                        if idx >= n:
                            break
                        ph += carrier / SR
                        out[idx] += amp * math.sin(math.pi * k / m) * triangle(ph) * 0.5
                    pt += 1.0 / prate
                t += clen + rng.uniform(0.3, 0.9)
        rng.tags = {
            "style": "crickets",
            "voices": voices,
            "lead_hz": int(round(lead_hz)),
            "chirp": "rapid" if lead_rate >= 32.0 else "lazy",
        }
        return finish(out, 40.0, 120.0)

    if style == "drips":
        # cave: faint dark rumble bed + sparse falling-pitch triangle plinks,
        # each repeated as a decaying echo train at a fixed delay
        dur = rng.uniform(2.0, 3.0)
        n = int(SR * dur)
        rumble = Lfsr(rng, rng.choice([4, 6, 8]))
        lp = 0.0
        bed = rng.uniform(0.12, 0.25)
        out = []
        for i in range(n):
            lp += 0.01 * (rumble.next() - lp)
            out.append(lp * bed)
        delay = rng.uniform(0.16, 0.34)
        drops = rng.randint(2, 4)
        for _ in range(drops):
            t0 = rng.uniform(0.05, dur * 0.55)
            f0 = rng.uniform(900.0, 2000.0)
            f1 = f0 * rng.uniform(0.35, 0.6)
            m = int(rng.uniform(0.04, 0.09) * SR)
            e_amp = 1.0
            for e in range(rng.randint(2, 4) + 1):
                start = int((t0 + e * delay) * SR)
                ph = 0.0
                for k in range(m):
                    idx = start + k
                    if idx >= n:
                        break
                    u = k / m
                    ph += (f0 + (f1 - f0) * u) / SR
                    env = min(1.0, u * 12.0) * (1.0 - u) * math.exp(-4.0 * u)
                    out[idx] += e_amp * env * triangle(ph) * 0.8
                e_amp *= rng.uniform(0.45, 0.6)
        rng.tags = {
            "style": "drips",
            "drops": drops,
            "echo_ms": int(round(delay * 1000.0)),
            "bed": "faint" if bed < 0.185 else "heavy",
        }
        return finish(out, 30.0, 120.0)

    if style == "thunder":
        # distant thunder: crunchy low LFSR through two one-pole lowpasses,
        # swell-then-decay envelope undulated by two slow sines + a low throb
        dur = rng.uniform(2.0, 3.0)
        n = int(SR * dur)
        per = rng.choice([3, 4, 6])
        noise = Lfsr(rng, per)
        atk = rng.uniform(0.15, 0.5)
        u1f = rng.uniform(0.7, 2.0)
        u1p = rng.uniform(0.0, 6.283)
        u2f = rng.uniform(2.0, 5.0)
        u2p = rng.uniform(0.0, 6.283)
        subf = rng.uniform(28.0, 45.0)
        subamp = rng.uniform(0.15, 0.35)
        rng.tags = {
            "style": "thunder",
            "attack": "sudden" if atk < 0.3 else "rolling",
            "grain": "fine" if per == 3 else ("crunchy" if per == 4 else "coarse"),
            "throb_hz": int(round(subf)),
        }
        lp = 0.0
        lp2 = 0.0
        ph = 0.0
        out = []
        for i in range(n):
            t = i / SR
            a = min(1.0, t / atk) * math.exp(-2.5 * max(0.0, t - atk) / dur)
            und = 0.6 + 0.25 * math.sin(6.283185 * u1f * t + u1p) \
                      + 0.15 * math.sin(6.283185 * u2f * t + u2p)
            lp += 0.015 * (noise.next() - lp)
            lp2 += 0.03 * (lp - lp2)
            ph += subf / SR
            out.append((lp2 * 8.0 + subamp * triangle(ph)) * und * a)
        return finish(out, 60.0, 300.0)

    if style == "rain":
        # rain patter: random micro-drops feed an energy accumulator with a
        # millisecond decay; white LFSR rings it, one-pole sets brightness
        dur = rng.uniform(1.5, 3.0)
        n = int(SR * dur)
        noise = Lfsr(rng, 1)
        density = rng.uniform(0.004, 0.02)
        dcoef = math.exp(-1.0 / (SR * rng.uniform(0.002, 0.006)))
        bright = rng.uniform(0.25, 0.7)
        swf = rng.uniform(0.2, 0.7)
        swp = rng.uniform(0.0, 6.283)
        rng.tags = {
            "style": "rain",
            "patter": "dense" if density >= 0.012 else "sparse",
            "drops_sec": int(round(density * SR)),
            "tone": "bright" if bright > 0.45 else "muffled",
        }
        e = 0.0
        lp = 0.0
        out = []
        for i in range(n):
            t = i / SR
            sway = 0.75 + 0.25 * math.sin(6.283185 * swf * t + swp)
            if rng.random() < density * sway:
                e += rng.uniform(0.3, 1.0)
            e *= dcoef
            lp += bright * (noise.next() * e - lp)
            out.append(lp)
        return finish(out, 80.0, 150.0)

    # shimmer: two detuned triangles beating slowly under a tremolo LFO with
    # gentle vibrato, plus sparse high 12.5%-duty square sparkle blips
    dur = rng.uniform(2.0, 3.0)
    n = int(SR * dur)
    root = midi(rng.randint(62, 74))
    det = rng.uniform(0.3, 1.2)
    trem_f = rng.uniform(0.4, 1.6)
    vib_f = rng.uniform(3.0, 6.0)
    vib_d = rng.uniform(0.002, 0.008)
    ph1 = 0.0
    ph2 = 0.0
    out = []
    for i in range(n):
        t = i / SR
        ph1 += root * (1.0 + vib_d * math.sin(6.283185 * vib_f * t)) / SR
        ph2 += (root + det) / SR
        trem = 0.6 + 0.4 * math.sin(6.283185 * trem_f * t)
        out.append((triangle(ph1) + triangle(ph2)) * 0.4 * trem)
    steps = [0, 3, 5, 7, 10, 12, 15]
    sparkles = rng.randint(3, 8)
    for _ in range(sparkles):
        t0 = rng.uniform(0.1, dur - 0.3)
        f = root * 4.0 * math.pow(2.0, rng.choice(steps) / 12.0)
        m = int(rng.uniform(0.06, 0.15) * SR)
        i0 = int(t0 * SR)
        a = rng.uniform(0.2, 0.45)
        ph = 0.0
        for k in range(m):
            idx = i0 + k
            if idx >= n:
                break
            u = k / m
            ph += f / SR
            out[idx] += a * min(1.0, u * 10.0) * (1.0 - u) * square(ph, 0.125) * 0.5
    rng.tags = {
        "style": "shimmer",
        "root_hz": int(round(root)),
        "beat": "slow" if det < 0.7 else "quick",
        "sparkles": sparkles,
    }
    return finish(out, 100.0, 200.0)


def gen_ui(rng):
    rng.random()
    rng.random()  # warm-up draws: decorrelates style pick across nearby seeds
    style = rng.choice(
        ["click", "hover", "toggle", "ding", "error", "success", "type", "scroll"]
    )
    out = []
    duty_word = {0.125: "reedy", 0.25: "nasal", 0.5: "hollow"}

    def tone(n, f0, f1, duty, rate, wav="sq"):
        # square/triangle tone, exponential pitch glide f0 -> f1, exp decay envelope
        buf = []
        ph = 0.0
        dc = 2.0 * duty - 1.0  # remove pulse-wave DC so thin duties stay centered
        ratio = f1 / f0
        for i in range(n):
            t = i / SR
            u = i / max(1, n - 1)
            ph += (f0 * (ratio ** u)) / SR
            s = triangle(ph) if wav == "tri" else (square(ph, duty) - dc)
            buf.append(s * math.exp(-rate * t))
        return buf

    if style == "click":
        # mouse click: fast falling square chirp, optional 1.5 ms noise transient
        n = int(SR * rng.uniform(0.032, 0.055))
        f0 = rng.uniform(1100.0, 3200.0)
        fall = rng.uniform(0.3, 0.65)
        duty = rng.choice([0.125, 0.25, 0.5])
        rate = rng.uniform(70.0, 130.0)
        out = tone(n, f0, f0 * fall, duty, rate)
        noisy = rng.random() < 0.5
        rng.tags = {"style": "click", "pitch_hz": round(f0),
                    "tone": duty_word[duty],
                    "attack": "noisy" if noisy else "clean"}
        if noisy:
            lf = Lfsr(rng, 1)
            m = min(n, int(SR * 0.0015))
            for i in range(m):
                out[i] += 0.5 * lf.next() * (1.0 - i / m)

    elif style == "hover":
        # soft hover blip: triangle, slight upward glide, gentle decay
        n = int(SR * rng.uniform(0.04, 0.08))
        f0 = rng.uniform(550.0, 1400.0)
        rise = rng.uniform(1.05, 1.35)
        rate = rng.uniform(35.0, 60.0)
        out = tone(n, f0, f0 * rise, 0.5, rate, "tri")
        rng.tags = {"style": "hover", "pitch_hz": round(f0),
                    "glide": "wide" if rise > 1.2 else "slight",
                    "fade": "lingering" if rate < 47.5 else "quick"}

    elif style == "toggle":
        # switch on/off: two short notes, up = on, down = off, tiny gap between
        m = rng.randint(72, 86)
        step = rng.choice([3, 4, 5, 7])
        up = rng.random() < 0.5
        seq = [m, m + step] if up else [m + step, m]
        ndur = rng.uniform(0.028, 0.045)
        duty = rng.choice([0.25, 0.5])
        wav = rng.choice(["sq", "sq", "tri"])
        rate = rng.uniform(45.0, 80.0)
        rng.tags = {"style": "toggle",
                    "direction": "up" if up else "down",
                    "interval": step,
                    "note_hz": round(midi(m)),
                    "timbre": "triangle" if wav == "tri" else duty_word[duty] + " pulse"}
        for k, note in enumerate(seq):
            f = midi(note)
            out.extend(tone(int(SR * ndur), f, f, duty, rate, wav))
            if k == 0:
                out.extend([0.0] * int(SR * rng.uniform(0.004, 0.01)))

    elif style == "ding":
        # notification ding: two detuned voices beating, optional octave sparkle
        n = int(SR * rng.uniform(0.16, 0.28))
        f = midi(rng.randint(86, 98))
        det = rng.uniform(0.5, 3.5)
        rate = rng.uniform(9.0, 16.0)
        wav = rng.choice(["tri", "sq", "sq"])
        duty = rng.choice([0.25, 0.5])
        dc = 2.0 * duty - 1.0
        sparkle = rng.random() < 0.5
        rng.tags = {"style": "ding", "pitch_hz": round(f),
                    "beat_hz": round(det, 1),
                    "timbre": "triangle" if wav == "tri" else duty_word[duty] + " pulse",
                    "finish": "octave-sparkle" if sparkle else "pure"}
        ph1 = 0.0
        ph2 = 0.0
        for i in range(n):
            t = i / SR
            ph1 += f / SR
            ph2 += (f + det) / SR
            if wav == "tri":
                s = 0.5 * (triangle(ph1) + triangle(ph2))
            else:
                s = 0.5 * (square(ph1, duty) + square(ph2, duty)) - dc
            if sparkle and t < 0.03:
                s += 0.5 * square(ph1 * 2.0, 0.5) * (1.0 - t / 0.03)
            out.append(s * math.exp(-rate * t))

    elif style == "error":
        # error buzz: low thin-duty square, hard amplitude gating, pitch droop
        dur = rng.uniform(0.14, 0.26)
        f = rng.uniform(85.0, 190.0)
        duty = rng.choice([0.125, 0.25, 0.5])
        dc = 2.0 * duty - 1.0
        gate = rng.uniform(18.0, 45.0)
        nb = rng.choice([1, 1, 2])
        rate = rng.uniform(4.0, 9.0)
        drop = rng.uniform(0.75, 1.0)
        rng.tags = {"style": "error", "buzz_hz": round(f),
                    "bursts": nb,
                    "tone": duty_word[duty],
                    "droop": "sagging" if drop < 0.875 else "steady"}
        for b in range(nb):
            n = int(SR * (dur / nb) * (0.8 if nb == 2 else 1.0))
            ph = 0.0
            for i in range(n):
                t = i / SR
                u = i / max(1, n - 1)
                ph += (f * (1.0 - (1.0 - drop) * u)) / SR
                g8 = 1.0 if (t * gate) % 1.0 < 0.6 else 0.25
                s = square(ph, duty) - dc
                out.append(s * g8 * math.exp(-rate * t))
            if nb == 2 and b == 0:
                out.extend([0.0] * int(SR * 0.03))

    elif style == "success":
        # success chime: rising arpeggio, last note rings out longer
        m = rng.randint(72, 84)
        pat = rng.choice(
            [[0, 4, 7], [0, 4, 7, 12], [0, 3, 7, 12], [0, 5, 9], [0, 7, 12]]
        )
        ndur = min(rng.uniform(0.045, 0.07), 0.25 / len(pat))
        duty = rng.choice([0.125, 0.25, 0.5])
        wav = rng.choice(["sq", "sq", "tri"])
        flavor = {4: "major", 3: "minor", 5: "quartal", 7: "open-fifth"}[pat[1]]
        rng.tags = {"style": "success", "flavor": flavor,
                    "notes": len(pat), "root_hz": round(midi(m)),
                    "timbre": "triangle" if wav == "tri" else duty_word[duty] + " pulse"}
        for k, iv in enumerate(pat):
            f = midi(m + iv)
            last = k == len(pat) - 1
            nn = int(SR * ndur * (1.6 if last else 1.0))
            rate = rng.uniform(10.0, 18.0) if last else rng.uniform(20.0, 35.0)
            out.extend(tone(nn, f, f, duty, rate, wav))

    elif style == "type":
        # keyboard tick: bright LFSR burst with a fast decay, optional low thock
        n = int(SR * rng.uniform(0.032, 0.05))
        period = rng.choice([1, 1, 2, 3])
        lf = Lfsr(rng, period)
        rate = rng.uniform(120.0, 260.0)
        thock = rng.random() < 0.6
        ft = rng.uniform(250.0, 700.0)
        tags = {"style": "type",
                "texture": {1: "bright", 2: "gritty", 3: "metallic"}[period],
                "body": "thocky" if thock else "dry",
                "decay_rate": round(rate)}
        if thock:
            tags["thock_hz"] = round(ft)
        rng.tags = tags
        ph = 0.0
        for i in range(n):
            t = i / SR
            s = lf.next() * math.exp(-rate * t)
            if thock:
                ph += ft / SR
                s += 0.7 * triangle(ph) * math.exp(-rate * 1.6 * t)
            out.append(s)

    else:  # scroll
        # scroll blip: sample-and-hold pitch staircase, up or down
        n = int(SR * rng.uniform(0.032, 0.06))
        cf = rng.uniform(900.0, 2200.0)
        ratio = rng.uniform(1.1, 1.35)
        falling = rng.random() < 0.5
        if falling:
            ratio = 1.0 / ratio
        steplen = max(1, int(SR * rng.uniform(0.004, 0.008)))
        duty = rng.choice([0.25, 0.5])
        dc = 2.0 * duty - 1.0
        rate = rng.uniform(40.0, 80.0)
        rng.tags = {"style": "scroll",
                    "direction": "falling" if falling else "rising",
                    "start_hz": round(cf),
                    "steps": n // steplen,
                    "tone": duty_word[duty]}
        ph = 0.0
        for i in range(n):
            t = i / SR
            if i > 0 and i % steplen == 0:
                cf *= ratio
            ph += cf / SR
            out.append((square(ph, duty) - dc) * math.exp(-rate * t))

    # de-click edges: ~0.4 ms fade-in, 2 ms fade-out to exactly zero
    n = len(out)
    fi = min(n, 8)
    for i in range(fi):
        out[i] *= i / fi
    fo = min(n, int(SR * 0.002))
    for i in range(fo):
        out[n - 1 - i] *= i / fo

    # normalize so the quantizer downstream always gets a healthy signal
    peak = max(abs(s) for s in out)
    if peak > 1e-9:
        g = 0.85 / peak
        out = [s * g for s in out]
    return out


def gen_voice(rng):
    """Chip-imitated people sounds: babble blips, grunts, hums, laughs, gasps, sighs, 'hey!' calls."""
    out = []

    def two_tone(n, freq_fn, duty, env_fn, det, wave, amp=0.42):
        # Formant-ish voice body: two detuned chip oscillators beating against each other.
        buf = []
        p1 = 0.0
        p2 = 0.0
        for i in range(n):
            t = i / SR
            f = freq_fn(t)
            p1 += f / SR
            p2 += (f * det) / SR
            if wave == "tri":
                s = triangle(p1) + triangle(p2)
            else:
                s = square(p1, duty) + square(p2, duty)
            buf.append(s * amp * env_fn(t))
        return buf

    def add(buf, at):
        need = at + len(buf)
        while len(out) < need:
            out.append(0.0)
        for i, v in enumerate(buf):
            out[at + i] += v

    style = rng.choice(["babble", "grunt", "hum", "laugh", "gasp", "sigh", "hey"])

    if style == "babble":
        # Animalese-style dialog: a run of quick pitch-stepped syllable blips.
        base = midi(rng.randint(60, 76))
        det = rng.uniform(1.008, 1.02)
        n_syll = rng.randint(3, 8)
        gap = int(SR * rng.uniform(0.008, 0.02))
        pos = 0
        for _ in range(n_syll):
            dur = rng.uniform(0.035, 0.075)
            n = int(SR * dur)
            f0 = base * (2.0 ** (rng.uniform(-4.0, 5.0) / 12.0))
            glide = rng.uniform(-0.25, 0.35)  # octaves across the syllable
            duty = rng.choice([0.125, 0.25, 0.5])
            wave = rng.choice(["sq", "sq", "tri"])
            fr = lambda t, f0=f0, glide=glide, dur=dur: f0 * (2.0 ** (glide * t / dur))
            env = lambda t, dur=dur: math.exp(-6.0 * t / dur) * min(1.0, t / 0.004)
            add(two_tone(n, fr, duty, env, det, wave), pos)
            pos += n + gap
        rng.tags = {
            "style": "babble",
            "register": "high" if base >= 380.0 else "mid",
            "pace": "rapid" if gap < 308 else "measured",
            "syllables": n_syll,
            "pitch_hz": round(base),
        }

    elif style == "grunt":
        # Low pitch-drop with rough beating and a crunchy throat rasp.
        f0 = midi(rng.randint(38, 50))
        drop = rng.uniform(0.3, 0.55)
        dur = rng.uniform(0.12, 0.26)
        n = int(SR * dur)
        det = rng.uniform(1.02, 1.05)
        duty = rng.choice([0.25, 0.5])
        vib = rng.uniform(20.0, 45.0)
        vdep = rng.uniform(0.01, 0.04)
        fr = lambda t: f0 * (1.0 - drop * t / dur) * (1.0 + vdep * math.sin(2 * math.pi * vib * t))
        env = lambda t: math.exp(-9.0 * t / dur) * min(1.0, t / 0.006)
        add(two_tone(n, fr, duty, env, det, "sq"), 0)
        lf = Lfsr(rng, rng.randint(6, 12))
        rn = int(n * rng.uniform(0.3, 0.6))
        rasp = []
        for i in range(rn):
            t = i / SR
            rasp.append(lf.next() * 0.18 * math.exp(-14.0 * t / dur))
        add(rasp, 0)
        rng.tags = {
            "style": "grunt",
            "register": "deep" if f0 < 104.0 else "low",
            "texture": "rough" if det >= 1.035 else "gravelly",
            "pitch_hz": round(f0),
        }

    elif style == "hum":
        # Soft melodic hum: 1-3 held notes on beating triangles with slow vibrato.
        root = rng.randint(50, 62)
        steps = [0, rng.choice([2, 3, 4]), rng.choice([5, 7, 9])]
        n_notes = rng.randint(1, 3)
        dur = rng.uniform(0.4, 0.85)
        n = int(SR * dur)
        det = rng.uniform(1.004, 1.012)
        vib = rng.uniform(4.5, 7.0)
        vdep = rng.uniform(0.006, 0.02)
        seg = dur / n_notes
        notes = [midi(root + rng.choice(steps)) for _ in range(n_notes)]

        def fr(t):
            k = min(n_notes - 1, int(t / seg))
            return notes[k] * (1.0 + vdep * math.sin(2 * math.pi * vib * t))

        atk = rng.uniform(0.03, 0.08)
        env = lambda t: min(1.0, t / atk) * min(1.0, max(0.0, dur - t) / 0.09)
        add(two_tone(n, fr, 0.5, env, det, "tri", amp=0.5), 0)
        rng.tags = {
            "style": "hum",
            "register": "low" if notes[0] < 196.0 else ("mid" if notes[0] < 311.0 else "high"),
            "vibrato": "subtle" if vdep < 0.012 else "wavering",
            "notes": n_notes,
            "pitch_hz": round(notes[0]),
        }

    elif style == "laugh":
        # "Ha-ha-ha": descending run of pitch-drooping bursts, each with a breathy 'h' onset.
        base = midi(rng.randint(55, 70))
        det = rng.uniform(1.01, 1.03)
        n_ha = rng.randint(3, 6)
        duty = rng.choice([0.25, 0.5])
        step = rng.uniform(0.94, 0.985)
        lf = Lfsr(rng, rng.randint(2, 5))
        pos = 0
        f = base
        for _ in range(n_ha):
            dur = rng.uniform(0.06, 0.1)
            n = int(SR * dur)
            fr = lambda t, f=f, dur=dur: f * (1.0 - 0.12 * t / dur)
            env = lambda t, dur=dur: math.exp(-7.0 * t / dur) * min(1.0, t / 0.003)
            add(two_tone(n, fr, duty, env, det, "sq"), pos)
            bn = int(SR * 0.012)
            br = [lf.next() * 0.22 * (1.0 - i / bn) for i in range(bn)]
            add(br, pos)
            pos += n + int(SR * rng.uniform(0.02, 0.05))
            f *= step
        rng.tags = {
            "style": "laugh",
            "timbre": "reedy" if duty == 0.25 else "round",
            "descent": "tumbling" if step < 0.962 else "even",
            "bursts": n_ha,
            "pitch_hz": round(base),
        }

    elif style == "gasp":
        # Sharp inhale: noise whose sample-and-hold rate sweeps crunchy->bright, plus a rising airy tone.
        dur = rng.uniform(0.12, 0.3)
        n = int(SR * dur)
        lf = Lfsr(rng, 1)
        hold = 0
        val = 0.0
        noise = []
        for i in range(n):
            frac = (i / SR) / dur
            if hold <= 0:
                val = lf.next()
                hold = max(1, int(9.0 - 8.0 * frac))
            hold -= 1
            noise.append(val * 0.5 * (math.sin(math.pi * min(1.0, frac)) ** 0.7))
        add(noise, 0)
        f0 = midi(rng.randint(62, 74))
        rise = rng.uniform(0.6, 1.2)  # octaves swept upward
        det = rng.uniform(1.01, 1.03)
        fr = lambda t: f0 * (2.0 ** (rise * t / dur))
        env = lambda t: 0.6 * math.sin(math.pi * min(1.0, t / dur))
        add(two_tone(n, fr, 0.5, env, det, "tri", amp=0.35), 0)
        rng.tags = {
            "style": "gasp",
            "attack": "quick" if dur < 0.2 else "drawn",
            "register": "high" if f0 >= 415.0 else "mid",
            "rise_oct": round(rise, 1),
            "pitch_hz": round(f0),
        }

    elif style == "sigh":
        # Long falling glide on beating triangles with slow vibrato and a breath layer.
        dur = rng.uniform(0.45, 0.88)
        n = int(SR * dur)
        f0 = midi(rng.randint(57, 69))
        fall = rng.uniform(0.5, 0.9)  # octaves down
        det = rng.uniform(1.005, 1.015)
        vib = rng.uniform(4.0, 6.5)
        vdep = rng.uniform(0.008, 0.02)
        fr = lambda t: f0 * (2.0 ** (-fall * t / dur)) * (1.0 + vdep * math.sin(2 * math.pi * vib * t))
        atk = rng.uniform(0.04, 0.1)
        env = lambda t: min(1.0, t / atk) * (max(0.0, 1.0 - t / dur) ** 1.3)
        add(two_tone(n, fr, 0.5, env, det, "tri", amp=0.5), 0)
        lf = Lfsr(rng, rng.randint(1, 3))
        br = []
        for i in range(n):
            t = i / SR
            br.append(lf.next() * 0.12 * min(1.0, t / atk) * (max(0.0, 1.0 - t / dur) ** 2))
        add(br, 0)
        rng.tags = {
            "style": "sigh",
            "register": "low" if f0 < 311.0 else "high",
            "vibrato": "steady" if vdep < 0.013 else "quavering",
            "fall_oct": round(fall, 1),
            "pitch_hz": round(f0),
        }

    else:  # "hey" call
        # "he-EY!": fast pitch jump up, held with a droop, bright duty and strong beating.
        dur = rng.uniform(0.15, 0.35)
        n = int(SR * dur)
        f0 = midi(rng.randint(57, 70))
        jump = 2.0 ** (rng.randint(3, 8) / 12.0)
        det = rng.uniform(1.015, 1.035)
        duty = rng.choice([0.125, 0.25])
        t1 = dur * rng.uniform(0.25, 0.4)

        def fr(t):
            if t < t1:
                return f0 * (1.0 + (jump - 1.0) * (t / t1) ** 2)
            u = (t - t1) / (dur - t1)
            return f0 * jump * (1.0 - 0.18 * u * u)

        env = lambda t: min(1.0, t / 0.005) * (1.0 if t < dur * 0.7 else max(0.0, 1.0 - (t - dur * 0.7) / (dur * 0.3)))
        add(two_tone(n, fr, duty, env, det, "sq", amp=0.45), 0)
        rng.tags = {
            "style": "hey",
            "register": "low" if f0 < 311.0 else "high",
            "timbre": "piercing" if duty == 0.125 else "brassy",
            "jump_semi": round(12.0 * math.log2(jump)),
            "pitch_hz": round(f0),
        }

    # Declick tail, then normalize so the 16-level quantizer downstream gets a healthy signal.
    if not out:
        out = [0.0] * int(SR * 0.1)
    # Hand-rolled one-pole DC blocker: keeps low-duty squares centered (no constant offset).
    r = 0.995
    px = 0.0
    py = 0.0
    for i in range(len(out)):
        x = out[i]
        py = x - px + r * py
        px = x
        out[i] = py
    fade = min(len(out), 96)
    for i in range(fade):
        out[-1 - i] *= i / fade
    peak = 0.0
    for v in out:
        a = abs(v)
        if a > peak:
            peak = a
    if peak > 1e-9:
        g = rng.uniform(0.7, 0.9) / peak
        out = [v * g for v in out]
    return out


def gen_dog(rng):
    """Chip-dog: barks (small/big), yips, whines, whimpers, growls, pants, howls."""

    def endfade(buf, ms=5.0):
        n = len(buf)
        k = min(n, max(8, int(SR * ms / 1000.0)))
        for i in range(k):
            buf[n - k + i] *= 1.0 - (i + 1.0) / k
        return buf

    def norm(buf, target):
        peak = max(abs(s) for s in buf)
        if peak < 1e-9:
            return buf
        g = target / peak
        return [s * g for s in buf]

    def pulse(ph, duty):
        # DC-centered pulse: narrow duties otherwise ride on a big offset
        return square(ph, duty) - (2.0 * duty - 1.0)

    def bark_syll(dur, f0, peak_mult, duty, rough, noise_amt, nper, drate):
        # one "wuf": pitch snaps up then falls, gravel jitter, noisy attack
        n = int(dur * SR)
        out = [0.0] * n
        lf = Lfsr(rng, nper)
        jit = 0.0
        hold = max(12, int(SR / (f0 * 2.0)))
        ph = 0.0
        for i in range(n):
            tn = i / n
            if tn < 0.18:
                f = f0 * (1.0 + (peak_mult - 1.0) * (tn / 0.18))
            else:
                u = (tn - 0.18) / 0.82
                f = f0 * (peak_mult - (peak_mult - 0.6) * u)
            if i % hold == 0:
                jit = rng.uniform(-rough, rough)
            ph += f * (1.0 + jit) / SR
            a = tn / 0.05 if tn < 0.05 else math.exp(-drate * (tn - 0.05) * 4.0)
            nz = lf.next() * noise_amt * math.exp(-10.0 * tn)
            out[i] = (pulse(ph, duty) * 0.9 + nz) * a
        return endfade(out)

    def yip_syll(dur, flo, fhi, duty, pk):
        # tiny chirp: fast up to fhi at tn=pk, then down past the start
        n = int(dur * SR)
        out = [0.0] * n
        ph = 0.0
        for i in range(n):
            tn = i / n
            if tn < pk:
                f = flo + (fhi - flo) * (tn / pk)
            else:
                f = fhi - (fhi - flo * 0.8) * ((tn - pk) / (1.0 - pk))
            ph += f / SR
            a = min(1.0, tn / 0.03) * math.exp(-6.0 * max(0.0, tn - 0.03))
            out[i] = pulse(ph, duty) * a
        return endfade(out)

    def whimper_syll(dur, fhi, flo):
        # short sad falling triangle hump
        n = int(dur * SR)
        out = [0.0] * n
        ph = 0.0
        for i in range(n):
            tn = i / n
            ph += (fhi + (flo - fhi) * tn) / SR
            out[i] = triangle(ph) * math.sin(math.pi * min(1.0, tn * 1.02))
        return out

    style = rng.choice(["bark_small", "bark_big", "yip", "whine",
                        "whimper", "growl", "pant", "howl"])
    target = rng.uniform(0.7, 0.95)
    out = []

    if style == "bark_small":
        cnt = rng.choice([1, 1, 2])
        f0 = rng.uniform(480, 820)
        duty = rng.choice([0.25, 0.125])
        for c in range(cnt):
            out.extend(bark_syll(rng.uniform(0.1, 0.16), f0 * rng.uniform(0.95, 1.05),
                                 rng.uniform(1.5, 2.0), duty, 0.05,
                                 rng.uniform(0.2, 0.35), rng.randint(2, 3),
                                 rng.uniform(0.9, 1.3)))
            if c < cnt - 1:
                out.extend([0.0] * int(rng.uniform(0.06, 0.1) * SR))
        tags = {"style": "bark_small", "pitch_hz": int(round(f0)), "barks": cnt,
                "timbre": "reedy" if duty == 0.125 else "nasal"}

    elif style == "bark_big":
        cnt = rng.choice([1, 1, 1, 2])
        f0 = rng.uniform(130, 230)
        for c in range(cnt):
            out.extend(bark_syll(rng.uniform(0.16, 0.28), f0 * rng.uniform(0.94, 1.06),
                                 rng.uniform(1.4, 1.7), 0.5, rng.uniform(0.08, 0.16),
                                 rng.uniform(0.3, 0.45), rng.randint(6, 11),
                                 rng.uniform(0.75, 1.05)))
            if c < cnt - 1:
                out.extend([0.0] * int(rng.uniform(0.08, 0.13) * SR))
        tags = {"style": "bark_big", "pitch_hz": int(round(f0)), "barks": cnt,
                "register": "cavernous" if f0 < 180 else "gruff"}

    elif style == "yip":
        cnt = rng.choice([1, 1, 2, 3])
        flo = rng.uniform(700, 950)
        ratio = rng.uniform(1.4, 1.9)
        duty = rng.choice([0.25, 0.125])
        for c in range(cnt):
            fl = flo * rng.uniform(0.95, 1.08)
            out.extend(yip_syll(rng.uniform(0.08, 0.12), fl, fl * ratio, duty,
                                rng.uniform(0.25, 0.4)))
            if c < cnt - 1:
                out.extend([0.0] * int(rng.uniform(0.04, 0.07) * SR))
        tags = {"style": "yip", "pitch_hz": int(round(flo)), "yips": cnt,
                "sweep": "wide" if ratio > 1.65 else "narrow",
                "timbre": "reedy" if duty == 0.125 else "nasal"}

    elif style == "whine":
        dur = rng.uniform(0.35, 0.75)
        f0 = rng.uniform(600, 1100)
        bend = rng.uniform(0.15, 0.45)
        vhz = rng.uniform(4.5, 7.5)
        vd = rng.uniform(0.015, 0.05)
        wav = rng.choice(["tri", "tri", "sq"])
        n = int(dur * SR)
        out = [0.0] * n
        ph = 0.0
        for i in range(n):
            tn = i / n
            t = i / SR
            f = f0 * (1.0 + bend * math.sin(math.pi * tn))
            f *= 1.0 + vd * min(1.0, tn / 0.4) * math.sin(2.0 * math.pi * vhz * t)
            ph += f / SR
            a = min(1.0, tn / 0.18) * min(1.0, (1.0 - tn) / 0.35)
            out[i] = (triangle(ph) if wav == "tri" else pulse(ph, 0.25)) * a
        tags = {"style": "whine", "pitch_hz": int(round(f0)),
                "voice": "smooth" if wav == "tri" else "buzzy",
                "arc": "steep" if bend > 0.3 else "gentle",
                "vibrato": "fluttery" if vd > 0.03 else "subtle"}

    elif style == "whimper":
        cnt = rng.randint(2, 4)
        fhi = rng.uniform(650, 1000)
        drop = rng.uniform(0.55, 0.75)
        for c in range(cnt):
            fh = fhi * rng.uniform(0.9, 1.05) * (1.0 - 0.06 * c)
            out.extend(whimper_syll(rng.uniform(0.08, 0.13), fh, fh * drop))
            if c < cnt - 1:
                out.extend([0.0] * int(rng.uniform(0.03, 0.07) * SR))
        tags = {"style": "whimper", "pitch_hz": int(round(fhi)), "sobs": cnt,
                "fall": "steep" if drop < 0.65 else "shallow"}

    elif style == "growl":
        dur = rng.uniform(0.4, 0.85)
        f0 = rng.uniform(55, 110)
        rough = rng.uniform(0.15, 0.35)
        thz = rng.uniform(11.0, 22.0)
        td = rng.uniform(0.35, 0.6)
        namp = rng.uniform(0.15, 0.3)
        duty = rng.choice([0.5, 0.5, 0.25])
        hold = rng.randint(30, 70)
        lf = Lfsr(rng, rng.randint(8, 14))
        n = int(dur * SR)
        out = [0.0] * n
        ph = 0.0
        jit = 0.0
        for i in range(n):
            tn = i / n
            t = i / SR
            if i % hold == 0:
                jit = rng.uniform(-rough, rough)
            ph += f0 * (1.0 + jit) / SR
            trem = 1.0 - td * (0.5 + 0.5 * math.sin(2.0 * math.pi * thz * t))
            a = min(1.0, tn / 0.12) * min(1.0, (1.0 - tn) / 0.18)
            out[i] = (pulse(ph, duty) * 0.85 + lf.next() * namp) * trem * a
        tags = {"style": "growl", "pitch_hz": int(round(f0)),
                "texture": "ragged" if rough > 0.25 else "coarse",
                "tremolo": "fast" if thz > 16.0 else "slow"}

    elif style == "pant":
        nb = rng.randint(3, 5)
        k_in = rng.uniform(0.2, 0.45)
        for b in range(nb):
            bn = int(rng.uniform(0.05, 0.08) * SR)
            lf = Lfsr(rng, rng.choice([1, 1, 2]))
            k = k_in if b % 2 == 0 else k_in * 0.45  # out-breath duller
            amp = 1.0 if b % 2 == 0 else 0.75
            y = 0.0
            for i in range(bn):
                y += k * (lf.next() - y)  # one-pole lowpass by hand
                out.append(y * amp * math.sin(math.pi * (i + 1.0) / bn))
            if b < nb - 1:
                out.extend([0.0] * int(rng.uniform(0.04, 0.07) * SR))
        tags = {"style": "pant", "breaths": nb,
                "tone": "airy" if k_in > 0.32 else "muffled"}

    else:  # howl
        dur = rng.uniform(0.55, 0.88)
        f0 = rng.uniform(220, 420)
        ratio = rng.uniform(1.35, 1.8)
        rise = rng.uniform(0.22, 0.4)
        vhz = rng.uniform(4.5, 6.5)
        vd = rng.uniform(0.02, 0.05)
        wav = rng.choice(["tri", "tri", "sq"])
        det = rng.choice([0.0, 1.0, 1.0]) * rng.uniform(0.004, 0.009)
        n = int(dur * SR)
        out = [0.0] * n
        ph1 = 0.0
        ph2 = 0.0
        for i in range(n):
            tn = i / n
            t = i / SR
            if tn < rise:
                f = f0 * ratio ** (tn / rise)
            else:
                f = f0 * ratio
                if tn > 0.85:
                    f *= 1.0 - 0.2 * (tn - 0.85) / 0.15
            f *= 1.0 + vd * min(1.0, tn / 0.5) * math.sin(2.0 * math.pi * vhz * t)
            ph1 += f / SR
            ph2 += f * (1.0 + det) / SR
            a = min(1.0, tn / 0.08) * min(1.0, (1.0 - tn) / 0.15)
            if wav == "tri":
                s = triangle(ph1) + (triangle(ph2) * 0.6 if det else 0.0)
            else:
                s = square(ph1, 0.5) + (square(ph2, 0.5) * 0.6 if det else 0.0)
            out[i] = s * a * (0.62 if det else 1.0)
        tags = {"style": "howl", "start_hz": int(round(f0)),
                "sweep_oct": round(math.log2(ratio), 1),
                "voice": "mellow" if wav == "tri" else "brassy",
                "chorus": "detuned" if det else "single"}

    rng.tags = tags
    return norm(endfade(out), target)


def gen_zombie(rng):
    TWO_PI = 2.0 * math.pi

    def zsq(ph, duty):
        # duty-corrected square: subtract the pulse's mean so no DC rides the envelope
        return square(ph, duty) - (2.0 * duty - 1.0)

    def finish(buf, target):
        n = len(buf)
        fi = max(1, int(0.004 * SR))
        fo = max(1, int(0.020 * SR))
        for i in range(min(fi, n)):
            buf[i] *= i / fi
        for i in range(min(fo, n)):
            buf[n - 1 - i] *= i / fo
        peak = 0.0
        for v in buf:
            av = -v if v < 0.0 else v
            if av > peak:
                peak = av
        g = target / peak if peak > 1e-6 else 0.0
        return [v * g for v in buf]

    style = rng.choice(("groan", "moan", "hiss", "gurgle", "rattle", "duet", "snarl"))

    if style == "groan":
        # low sagging drone, slow vibrato, breathy noise on top
        dur = rng.uniform(0.7, 1.4)
        n = int(dur * SR)
        base = midi(rng.randint(26, 34))
        sag = rng.uniform(0.15, 0.4)
        vib_r = rng.uniform(3.5, 6.5)
        vib_d = rng.uniform(0.02, 0.06)
        duty = rng.choice((0.25, 0.5, 0.5))
        trem_r = rng.uniform(5.0, 9.0)
        atk = rng.uniform(0.08, 0.2) * dur
        noise = Lfsr(rng, 1)
        ngain = rng.uniform(0.05, 0.12)
        drift = 0.0
        drift_t = 0.0
        ph = 0.0
        nz = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            x = t / dur
            if i % 480 == 0:
                drift_t = rng.uniform(-0.03, 0.03)
            drift += (drift_t - drift) * 0.001
            f = base * (1.0 + sag * (1.0 - x) + vib_d * math.sin(TWO_PI * vib_r * t) + drift)
            ph += f / SR
            env = (t / atk) if t < atk else math.exp(-2.2 * (t - atk) / dur)
            env *= 1.0 - 0.25 * (0.5 + 0.5 * math.sin(TWO_PI * trem_r * t))
            nz += (noise.next() - nz) * 0.25
            buf.append(env * (zsq(ph, duty) + ngain * nz))
        rng.tags = {
            'style': 'groan',
            'voice': 'nasal' if duty == 0.25 else 'hollow',
            'breathiness': 'breathy' if ngain >= 0.085 else 'dry',
            'pitch_hz': round(base),
            'sag_pct': round(sag * 100),
        }
        return finish(buf, rng.uniform(0.55, 0.85))

    if style == "moan":
        # pitch arcs up then back down; soft triangle voice with vibrato
        dur = rng.uniform(0.6, 1.3)
        n = int(dur * SR)
        base = midi(rng.randint(33, 45))
        arc = rng.uniform(0.3, 0.9)
        bend = rng.uniform(0.6, 1.6)
        vib_r = rng.uniform(4.0, 7.5)
        vib_d = rng.uniform(0.015, 0.05)
        use_tri = rng.random() < 0.7
        duty = rng.choice((0.25, 0.5))
        noise = Lfsr(rng, 1)
        ngain = rng.uniform(0.03, 0.09)
        ph = 0.0
        nz = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            x = t / dur
            a = math.sin(math.pi * (x ** bend))
            f = base * (1.0 + arc * a + vib_d * math.sin(TWO_PI * vib_r * t))
            ph += f / SR
            env = a ** 0.7
            nz += (noise.next() - nz) * 0.3
            v = triangle(ph) if use_tri else zsq(ph, duty)
            buf.append(env * (v + ngain * nz))
        rng.tags = {
            'style': 'moan',
            'voice': 'soft triangle' if use_tri else 'buzzy pulse',
            'rise': 'wide' if arc >= 0.6 else 'gentle',
            'vibrato': 'quick' if vib_r >= 5.75 else 'slow',
            'pitch_hz': round(base),
        }
        return finish(buf, rng.uniform(0.55, 0.85))

    if style == "hiss":
        # dry throat hiss: bright LFSR through a hand-rolled lowpass, fluttering decay
        dur = rng.uniform(0.3, 0.8)
        n = int(dur * SR)
        noise = Lfsr(rng, rng.choice((1, 1, 2)))
        lp = rng.uniform(0.35, 0.95)
        flut_r = rng.uniform(7.0, 16.0)
        flut_d = rng.uniform(0.2, 0.5)
        dk = rng.uniform(2.5, 5.0)
        atk = rng.uniform(0.01, 0.05)
        puff2 = rng.random() < 0.5
        t2 = dur * rng.uniform(0.45, 0.65)
        y = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            y += (noise.next() - y) * lp
            env = (t / atk) if t < atk else math.exp(-dk * (t - atk))
            if puff2 and t >= t2:
                e2 = min((t - t2) / 0.02, 1.0) * math.exp(-dk * (t - t2))
                if e2 > env:
                    env = e2
            env *= 1.0 - flut_d * (0.5 + 0.5 * math.sin(TWO_PI * flut_r * t + 1.7))
            buf.append(env * y)
        rng.tags = {
            'style': 'hiss',
            'tone': 'bright' if lp >= 0.65 else 'muffled',
            'attack': 'sharp' if atk < 0.03 else 'soft',
            'puffs': 2 if puff2 else 1,
            'flutter_hz': round(flut_r),
        }
        return finish(buf, rng.uniform(0.5, 0.75))

    if style == "gurgle":
        # wet throat: random down-chirping triangle bubbles over crunchy slow LFSR
        dur = rng.uniform(0.5, 1.2)
        n = int(dur * SR)
        crunch = Lfsr(rng, rng.randint(6, 12))
        cgain = rng.uniform(0.25, 0.45)
        wr = rng.uniform(3.0, 7.0)
        gap = int(SR * rng.uniform(0.04, 0.10))
        timer = rng.randint(1, gap)
        drone_g = rng.uniform(0.0, 0.35)
        drone_f = rng.uniform(45.0, 75.0)
        bf = 0.0
        blen = 1.0
        bage = 1.0
        bph = 0.0
        dph = 0.0
        y = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            x = t / dur
            timer -= 1
            if timer <= 0:
                timer = int(gap * rng.uniform(0.5, 1.6))
                bf = rng.uniform(90.0, 240.0)
                blen = SR * rng.uniform(0.03, 0.07)
                bage = 0.0
                bph = 0.0
            tone = 0.0
            if bage < blen:
                bx = bage / blen
                bph += (bf * (1.0 - 0.5 * bx)) / SR
                tone = triangle(bph) * (1.0 - bx) * (1.0 - bx)
                bage += 1.0
            y += (crunch.next() - y) * 0.5
            dph += drone_f / SR
            env = math.sin(math.pi * x) ** 0.6
            wob = 1.0 + 0.3 * math.sin(TWO_PI * wr * t)
            buf.append(env * (tone + cgain * y * wob + drone_g * triangle(dph)))
        rng.tags = {
            'style': 'gurgle',
            'texture': 'thick' if cgain >= 0.35 else 'light',
            'underlay': 'droning' if drone_g >= 0.15 else 'dry',
            'wobble_hz': round(wr),
        }
        return finish(buf, rng.uniform(0.55, 0.8))

    if style == "rattle":
        # rattling breath: crunchy noise chopped by a slow soft gate, inhale/exhale shape
        dur = rng.uniform(0.6, 1.4)
        n = int(dur * SR)
        noise = Lfsr(rng, rng.randint(3, 8))
        rate0 = rng.uniform(11.0, 22.0)
        rate1 = rate0 * rng.uniform(0.5, 1.1)
        gduty = rng.uniform(0.25, 0.55)
        breath = rng.uniform(0.35, 0.65)
        tone_g = rng.uniform(0.0, 0.25)
        tone_f = rng.uniform(50.0, 85.0)
        gph = 0.0
        tph = 0.0
        y = 0.0
        g = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            x = t / dur
            rate = rate0 + (rate1 - rate0) * x
            gph += rate / SR
            gate = 1.0 if (gph - int(gph)) < gduty else 0.15
            g += (gate - g) * 0.02
            env = (x / breath) ** 1.5 if x < breath else math.exp(-3.5 * (x - breath))
            y += (noise.next() - y) * 0.6
            tph += tone_f / SR
            buf.append(env * g * (y + tone_g * triangle(tph)))
        rng.tags = {
            'style': 'rattle',
            'gate': 'choppy' if gduty < 0.4 else 'loose',
            'pace': 'slowing' if rate1 < rate0 else 'steady',
            'undertone': 'humming' if tone_g >= 0.12 else 'plain',
            'rattle_hz': round(rate0),
        }
        return finish(buf, rng.uniform(0.5, 0.8))

    if style == "duet":
        # two detuned pulse groans beating against each other
        dur = rng.uniform(0.7, 1.4)
        n = int(dur * SR)
        base = midi(rng.randint(29, 38))
        det = rng.uniform(1.008, 1.035)
        glide = rng.uniform(0.05, 0.25)
        duty1 = rng.choice((0.5, 0.25))
        duty2 = rng.choice((0.25, 0.125))
        trem_r = rng.uniform(4.0, 8.0)
        atk = rng.uniform(0.05, 0.15) * dur
        ph1 = 0.0
        ph2 = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            x = t / dur
            f = base * (1.0 + glide * (1.0 - x))
            ph1 += f / SR
            ph2 += f * det / SR
            env = (t / atk) if t < atk else math.exp(-1.8 * (t - atk) / dur)
            env *= 1.0 - 0.2 * (0.5 + 0.5 * math.sin(TWO_PI * trem_r * t))
            buf.append(env * (0.6 * zsq(ph1, duty1) + 0.5 * zsq(ph2, duty2)))
        rng.tags = {
            'style': 'duet',
            'timbre': 'thin' if duty2 == 0.125 else 'full',
            'glide': 'sliding' if glide >= 0.15 else 'steady',
            'detune_cents': round(1200.0 * math.log2(det)),
            'pitch_hz': round(base),
        }
        return finish(buf, rng.uniform(0.55, 0.85))

    # snarl: short aggressive bark, fast throat-rate FM rasp plus noise, pitch drops
    dur = rng.uniform(0.3, 0.7)
    n = int(dur * SR)
    base = rng.uniform(55.0, 110.0)
    rasp_r = rng.uniform(22.0, 40.0)
    rasp_d = rng.uniform(0.2, 0.45)
    drop = rng.uniform(0.2, 0.5)
    duty = rng.choice((0.25, 0.125, 0.5))
    noise = Lfsr(rng, rng.choice((1, 2, 3)))
    ngain = rng.uniform(0.15, 0.35)
    atk = rng.uniform(0.008, 0.03)
    ph = 0.0
    y = 0.0
    buf = []
    for i in range(n):
        t = i / SR
        x = t / dur
        f = base * (1.0 - drop * x * x) * (1.0 + rasp_d * math.sin(TWO_PI * rasp_r * t))
        ph += f / SR
        env = (t / atk) if t < atk else math.exp(-3.0 * (t - atk) / dur)
        y += (noise.next() - y) * 0.5
        buf.append(env * (zsq(ph, duty) + ngain * y * env))
    rng.tags = {
        'style': 'snarl',
        'bite': 'gritty' if ngain >= 0.25 else 'clean',
        'drop': 'plunging' if drop >= 0.35 else 'slight',
        'rasp_hz': round(rasp_r),
        'pitch_hz': round(base),
    }
    return finish(buf, rng.uniform(0.6, 0.85))


def gen_monster(rng):
    """Monster foley & vocals: roar, screech, snarl, chitter, stomp, flap, squelch."""
    style = rng.choice(["roar", "screech", "snarl", "chitter", "stomp", "flap", "squelch"])
    two_pi = 2.0 * math.pi

    def sec(x):
        return int(x * SR)

    def pulse(ph, duty):
        # square() minus its duty-cycle DC so narrow pulses stay zero-mean
        return square(ph, duty) - (2.0 * duty - 1.0)

    def mix_into(dst, src, start, gain=1.0):
        need = start + len(src) - len(dst)
        if need > 0:
            dst.extend([0.0] * need)
        for i in range(len(src)):
            dst[start + i] += src[i] * gain

    buf = []

    if style == "roar":
        # deep chest roar: two beating detuned squares under slow vibrato, LFSR
        # growl-tremolo chewing the level, pitch sagging as the breath runs out
        dur = rng.uniform(0.9, 1.7)
        n = sec(dur)
        base = midi(rng.randint(26, 38))
        duty = rng.choice([0.25, 0.5])
        det = rng.uniform(1.006, 1.02)
        vib_hz = rng.uniform(4.5, 9.0)
        vib_amt = rng.uniform(0.05, 0.14)
        growl_hz = rng.uniform(16.0, 34.0)
        growl_amt = rng.uniform(0.25, 0.5)
        sag = rng.uniform(0.2, 0.45)
        breath = Lfsr(rng, rng.randint(6, 12))
        bamt = rng.uniform(0.15, 0.3)
        atk = max(1, sec(rng.uniform(0.03, 0.09)))
        rel = max(1, sec(rng.uniform(0.18, 0.35)))
        rng.tags = {"style": "roar", "base_hz": int(round(base)),
                    "growl_hz": int(round(growl_hz)),
                    "growl": "heavy" if growl_amt > 0.38 else "light",
                    "sag": "winded" if sag > 0.32 else "steady"}
        p1 = p2 = 0.0
        for i in range(n):
            t = i / SR
            u = i / n
            f = base * (1.0 - sag * u * u) * (1.0 + vib_amt * math.sin(two_pi * vib_hz * t))
            p1 += f / SR
            p2 += f * det / SR
            v = 0.6 * pulse(p1, duty) + 0.4 * pulse(p2, duty) + bamt * breath.next()
            trem = 1.0 - growl_amt * (0.5 + 0.5 * math.sin(two_pi * growl_hz * t))
            buf.append(v * trem * min(1.0, i / atk, (n - i) / rel))

    elif style == "screech":
        # piercing screech: thin square arcing up then down with a fast wobble,
        # sometimes breaking between two notes, bright hiss riding on top
        dur = rng.uniform(0.45, 1.0)
        n = sec(dur)
        base = midi(rng.randint(76, 92))
        duty = rng.choice([0.125, 0.25])
        arc = rng.uniform(0.2, 0.6)
        wob_hz = rng.uniform(14.0, 32.0)
        wob_amt = rng.uniform(0.1, 0.28)
        breaks = rng.random() < 0.5
        alt = midi(rng.randint(84, 99))
        brk_hz = rng.uniform(7.0, 15.0)
        hiss = Lfsr(rng, rng.randint(1, 2))
        hamt = rng.uniform(0.08, 0.22)
        atk = max(1, sec(0.012))
        rel = max(1, sec(rng.uniform(0.08, 0.2)))
        rng.tags = {"style": "screech", "base_hz": int(round(base)),
                    "wobble": "wild" if wob_amt > 0.19 else "tight",
                    "contour": "breaking" if breaks else "unbroken",
                    **({"alt_hz": int(round(alt))} if breaks else {})}
        ph = 0.0
        for i in range(n):
            t = i / SR
            u = i / n
            f0 = alt if breaks and int(t * brk_hz) % 2 else base
            f = f0 * (1.0 + arc * math.sin(math.pi * u)) * (1.0 + wob_amt * math.sin(two_pi * wob_hz * t))
            ph += f / SR
            v = pulse(ph, duty) + hamt * hiss.next()
            buf.append(v * min(1.0, i / atk, (n - i) / rel))

    elif style == "snarl":
        # low ragged snarl: sample-and-hold pitch flutter, level chewed by a slow
        # LFSR gate; about a third of them tense upward like a warning
        dur = rng.uniform(0.45, 1.0)
        n = sec(dur)
        base = midi(rng.randint(31, 43))
        duty = rng.choice([0.25, 0.5])
        step = max(1, sec(rng.uniform(0.018, 0.045)))
        spread = rng.uniform(0.12, 0.35)
        chew = Lfsr(rng, rng.randint(8, 20))
        camt = rng.uniform(0.3, 0.55)
        rise = 0.5 if rng.random() < 0.35 else 0.0
        atk = max(1, sec(rng.uniform(0.015, 0.05)))
        rel = max(1, sec(rng.uniform(0.08, 0.22)))
        rng.tags = {"style": "snarl", "base_hz": int(round(base)),
                    "flutter": "wide" if spread > 0.23 else "narrow",
                    "gate": "heavy" if camt > 0.42 else "light",
                    "contour": "rising" if rise else "flat"}
        ph = 0.0
        f = base
        for i in range(n):
            u = i / n
            if i % step == 0:
                f = base * (1.0 + rise * u + rng.uniform(-spread, spread))
            ph += f / SR
            v = pulse(ph, duty) * (1.0 - camt + camt * (0.5 + 0.5 * chew.next()))
            buf.append(v * min(1.0, i / atk, (n - i) / rel))

    elif style == "chitter":
        # insectoid chitter: a run of tiny high blips, each with its own chirp
        # bend and level, the phrase drifting flat, down, or up
        dur = rng.uniform(0.45, 1.1)
        nb = rng.randint(6, 14)
        period = dur / nb
        wv = rng.choice(["sq", "tri"])
        base_m = rng.randint(76, 95)
        drift = rng.choice([-4, -2, 0, 0, 2])
        rng.tags = {"style": "chitter", "blips": nb,
                    "base_hz": int(round(midi(base_m))),
                    "wave": "triangle" if wv == "tri" else "thin square",
                    "drift": {-4: "diving", -2: "sagging", 0: "level", 2: "rising"}[drift]}
        pos = 0
        for b in range(nb):
            bl = max(8, int(sec(period) * rng.uniform(0.3, 0.55)))
            f0 = midi(base_m + drift * b / nb + rng.uniform(-2.0, 2.0))
            bend = rng.uniform(-0.35, 0.5)
            ph = 0.0
            blip = []
            for i in range(bl):
                uu = i / bl
                ph += f0 * (1.0 + bend * uu) / SR
                v = triangle(ph) if wv == "tri" else pulse(ph, 0.125)
                blip.append(v * math.sin(math.pi * uu))
            mix_into(buf, blip, pos, rng.uniform(0.7, 1.0))
            pos += sec(period * rng.uniform(0.8, 1.2))
        buf.extend([0.0] * sec(0.03))  # let the last blip breathe before the edge

    elif style == "stomp":
        # heavy footfall (sometimes two): triangle thud swept hard downward with
        # a fast-dying crunch of debris on the impact
        double = rng.random() < 0.45
        gap = rng.uniform(0.18, 0.4)
        pos = 0
        for s in range(2 if double else 1):
            d = rng.uniform(0.3, 0.5) if double else rng.uniform(0.4, 0.7)
            m = sec(d)
            f_hi = rng.uniform(85.0, 150.0)
            f_lo = rng.uniform(28.0, 48.0)
            k = rng.uniform(6.0, 14.0)
            body = rng.uniform(5.0, 10.0)
            crunch = Lfsr(rng, rng.randint(10, 22))
            cramt = rng.uniform(0.3, 0.6)
            cdec = rng.uniform(25.0, 60.0)
            if s == 0:
                rng.tags = {"style": "stomp", "hits": 2 if double else 1,
                            "from_hz": int(round(f_hi)), "to_hz": int(round(f_lo)),
                            "debris": "gravelly" if cramt > 0.45 else "dusty"}
            ph = 0.0
            st = []
            for i in range(m):
                t = i / SR
                ph += (f_lo + (f_hi - f_lo) * math.exp(-k * t)) / SR
                v = triangle(ph) * math.exp(-body * t) + cramt * crunch.next() * math.exp(-cdec * t)
                st.append(v * min(1.0, (m - i) / (0.02 * SR)))
            mix_into(buf, st, pos, 1.0 if s == 0 else rng.uniform(0.6, 0.95))
            pos += sec(gap)

    elif style == "flap":
        # wing beats: repeated noise whooshes that swell and die, a soft low
        # triangle undertone flapping along underneath
        nf = rng.randint(2, 5)
        rate = rng.uniform(0.16, 0.3)
        while nf * rate < 0.45:
            nf += 1
        sub_amt = rng.uniform(0.15, 0.35)
        sub_f0 = rng.uniform(45.0, 75.0)
        rng.tags = {"style": "flap", "beats": nf,
                    "pace": "frantic" if rate < 0.22 else "lumbering",
                    "thrum_hz": int(round(sub_f0)),
                    "undertone": "strong" if sub_amt > 0.25 else "faint"}
        pos = 0
        for w in range(nf):
            flen = max(1, sec(rate * rng.uniform(0.85, 1.08)))
            whoosh = Lfsr(rng, rng.randint(2, 6))
            swell = rng.uniform(0.2, 0.4)
            gain = rng.uniform(0.7, 1.0) * (1.0 if w < nf - 1 else 0.85)
            sf = sub_f0 * rng.uniform(0.9, 1.15)
            ph = 0.0
            st = []
            for i in range(flen):
                uu = i / flen
                e = uu / swell if uu < swell else max(0.0, 1.0 - (uu - swell) / (1.0 - swell))
                e *= e
                ph += sf / SR
                st.append((whoosh.next() + sub_amt * triangle(ph)) * e * gain)
            mix_into(buf, st, pos)
            pos += sec(rate)

    else:  # squelch
        # slime: wobbling triangle glissando falling away, a wet splat up front,
        # hand-rolled one-pole gurgle underneath, and a few rising bubble blips
        dur = rng.uniform(0.5, 1.1)
        n = sec(dur)
        base = rng.uniform(70.0, 150.0)
        fall = rng.uniform(0.35, 0.6)
        wob_hz = rng.uniform(5.0, 12.0)
        wob_amt = rng.uniform(0.2, 0.45)
        goo = Lfsr(rng, rng.randint(12, 24))
        coef = rng.uniform(0.02, 0.08)
        gamt = rng.uniform(0.5, 1.0)
        splat = Lfsr(rng, rng.randint(2, 4))
        sdec = rng.uniform(35.0, 80.0)
        samt = rng.uniform(0.4, 0.8)
        atk = max(1, sec(0.008))
        rel = max(1, sec(rng.uniform(0.1, 0.25)))
        ph = 0.0
        low = 0.0
        for i in range(n):
            t = i / SR
            u = i / n
            f = base * (1.0 - fall * u) * (1.0 + wob_amt * math.sin(two_pi * wob_hz * t + 3.0 * u))
            ph += f / SR
            low += coef * (goo.next() - low)
            v = triangle(ph) * (1.0 - 0.4 * u) + gamt * low + samt * splat.next() * math.exp(-sdec * t)
            buf.append(v * min(1.0, i / atk, (n - i) / rel))
        nbub = rng.randint(2, 5)
        rng.tags = {"style": "squelch", "base_hz": int(round(base)),
                    "wobble": "seasick" if wob_amt > 0.32 else "gentle",
                    "splat": "wet" if samt > 0.6 else "soft",
                    "bubbles": nbub}
        for b in range(nbub):
            bl = max(8, sec(rng.uniform(0.03, 0.07)))
            start = rng.randint(sec(0.05), max(sec(0.05) + 1, n - bl - 1))
            bf = rng.uniform(180.0, 480.0)
            bend = rng.uniform(1.2, 2.5)
            bph = 0.0
            blip = []
            for i in range(bl):
                uu = i / bl
                bph += bf * (1.0 + bend * uu) / SR
                blip.append(triangle(bph) * math.sin(math.pi * uu) * 0.5)
            mix_into(buf, blip, start)

    # duration guards, edge de-click, then normalize so the peak always clears
    # the 16-level quantizer downstream
    floor_n = sec(0.42)
    if len(buf) < floor_n:
        buf.extend([0.0] * (floor_n - len(buf)))
    cap_n = sec(1.78)
    if len(buf) > cap_n:
        del buf[cap_n:]
    edge = max(1, sec(0.006))
    for i in range(min(edge, len(buf))):
        w = i / edge
        buf[i] *= w
        buf[-1 - i] *= w
    peak = max(abs(v) for v in buf)
    g = (rng.uniform(0.78, 0.95) / peak) if peak > 1e-6 else 0.0
    for i in range(len(buf)):
        v = buf[i] * g
        buf[i] = 1.0 if v > 1.0 else (-1.0 if v < -1.0 else v)
    return buf


def gen_water(rng):
    """Chip-imitation water: drips, splashes, pours, streams, dives, blubs."""
    style = rng.choice(
        ["drip", "small_splash", "big_splash", "pour", "stream", "dive", "blub"]
    )

    buf = []

    def mix_at(pos, samples, gain=1.0):
        end = pos + len(samples)
        if end > len(buf):
            buf.extend([0.0] * (end - len(buf)))
        for i in range(len(samples)):
            buf[pos + i] += samples[i] * gain

    def pad_to(n):
        if len(buf) < n:
            buf.extend([0.0] * (n - len(buf)))

    def droplet(dur, f0, f1, amp, wob=0.0):
        # tri "plip": pitch glides f0 -> f1, fast attack, power-decay to zero
        n = max(8, int(dur * SR))
        out = []
        ph = 0.0
        for i in range(n):
            u = i / n
            f = f0 * (f1 / f0) ** u
            if wob:
                f *= 1.0 + wob * math.sin(2.0 * math.pi * 27.0 * i / SR)
            ph += f / SR
            env = min(1.0, i / (0.004 * SR)) * (1.0 - u) ** 1.7
            out.append(triangle(ph) * env * amp)
        return out

    def wash(dur, period, lp, rate, amp, gurgle=0.0):
        # one-pole lowpassed LFSR burst with exp decay; optional s&h "gurgle"
        # level-wobble (smoothed by hand) so bigger washes churn instead of hiss
        n = max(8, int(dur * SR))
        noise = Lfsr(rng, period)
        step = max(1, int(rng.uniform(0.02, 0.05) * SR))
        out = []
        y = 0.0
        g = 1.0
        gt = 1.0
        for i in range(n):
            t = i / SR
            y += lp * (noise.next() - y)
            if gurgle:
                if i % step == 0:
                    gt = 1.0 - gurgle * rng.random()
                g += 0.002 * (gt - g)
            env = min(1.0, i / (0.003 * SR)) * math.exp(-rate * t)
            out.append(y * env * amp * g)
        return out

    if style == "drip":
        # tiny noise tick + upward tri plip, sometimes with a fainter echo drip
        f0 = rng.uniform(300.0, 700.0)
        f1 = f0 * rng.uniform(1.9, 3.4)
        d = rng.uniform(0.06, 0.11)
        mix_at(0, wash(rng.uniform(0.008, 0.02), 1, 0.6, 90.0, 0.5))
        mix_at(int(0.004 * SR), droplet(d, f0, f1, 1.0))
        echo = rng.random() < 0.55
        if echo:
            gap = rng.uniform(0.07, 0.16)
            mix_at(
                int((0.004 + d + gap) * SR),
                droplet(
                    d * rng.uniform(0.6, 0.9),
                    f0 * rng.uniform(1.05, 1.3),
                    f1 * rng.uniform(1.05, 1.3),
                    rng.uniform(0.3, 0.55),
                ),
            )
        pad_to(int(rng.uniform(0.18, 0.4) * SR))
        tags = {"style": "drip", "plip_hz": int(round(f0)),
                "rise": round(f1 / f0, 1),
                "echo": "echoing" if echo else "single"}

    elif style == "small_splash":
        # bright short wash + low thunk + a couple of spray droplets
        d = rng.uniform(0.18, 0.32)
        wper = rng.choice([1, 1, 2])
        wlp = rng.uniform(0.25, 0.45)
        wrate = rng.uniform(14.0, 22.0)
        mix_at(0, wash(d, wper, wlp, wrate, 1.0))
        td = rng.uniform(0.05, 0.09)
        tf0 = rng.uniform(180.0, 320.0)
        tf1 = rng.uniform(90.0, 150.0)
        mix_at(0, droplet(td, tf0, tf1, 0.7))
        sprays = rng.randint(1, 3)
        for _ in range(sprays):
            pos = int(rng.uniform(0.35, 0.9) * d * SR)
            fd = rng.uniform(500.0, 1100.0)
            mix_at(
                pos,
                droplet(
                    rng.uniform(0.03, 0.06),
                    fd,
                    fd * rng.uniform(1.6, 2.6),
                    rng.uniform(0.2, 0.45),
                ),
            )
        pad_to(int((d + 0.05) * SR))
        tags = {"style": "small_splash", "thunk_hz": int(round(tf0)),
                "sprays": sprays,
                "texture": "bright" if wlp > 0.35 else "soft"}

    elif style == "big_splash":
        # body thump + long churning wash + secondary slosh + rain-back drops
        d = rng.uniform(0.55, 1.0)
        td = rng.uniform(0.08, 0.14)
        tf0 = rng.uniform(110.0, 200.0)
        tf1 = rng.uniform(45.0, 75.0)
        mix_at(0, droplet(td, tf0, tf1, 0.9))
        mix_at(
            0,
            wash(
                d,
                rng.choice([1, 2, 3]),
                rng.uniform(0.12, 0.3),
                rng.uniform(4.5, 8.0),
                1.0,
                gurgle=0.5,
            ),
        )
        slosh = rng.random() < 0.7
        if slosh:
            mix_at(
                int(rng.uniform(0.3, 0.5) * d * SR),
                wash(
                    d * 0.5,
                    rng.choice([1, 2]),
                    rng.uniform(0.2, 0.4),
                    rng.uniform(8.0, 14.0),
                    0.5,
                ),
            )
        drops = rng.randint(2, 5)
        for _ in range(drops):
            pos = int(rng.uniform(0.25, 0.85) * d * SR)
            fd = rng.uniform(400.0, 1000.0)
            mix_at(
                pos,
                droplet(
                    rng.uniform(0.04, 0.08),
                    fd,
                    fd * rng.uniform(1.7, 2.8),
                    rng.uniform(0.15, 0.4),
                ),
            )
        pad_to(int((d + 0.08) * SR))
        tags = {"style": "big_splash", "thump_hz": int(round(tf0)),
                "drops": drops,
                "slosh": "double slosh" if slosh else "single hit"}

    elif style == "pour":
        # sustained gurgling noise column with glug-bubbles riding on top
        d = rng.uniform(1.1, 1.9)
        n = int(d * SR)
        noise = Lfsr(rng, rng.choice([1, 1, 2]))
        lp = rng.uniform(0.12, 0.25)
        atk = rng.uniform(0.06, 0.15)
        rel = rng.uniform(0.12, 0.3)
        wobf = rng.uniform(4.0, 8.0)
        step = max(1, int(rng.uniform(0.025, 0.06) * SR))
        y = 0.0
        g = 1.0
        gt = 1.0
        body = []
        for i in range(n):
            t = i / SR
            y += lp * (noise.next() - y)
            if i % step == 0:
                gt = rng.uniform(0.55, 1.0)
            g += 0.0015 * (gt - g)
            env = min(1.0, t / atk) * min(1.0, (d - t) / rel)
            env *= 0.8 + 0.2 * math.sin(2.0 * math.pi * wobf * t)
            body.append(y * env * g)
        mix_at(0, body)
        glugs = 0
        t = rng.uniform(0.1, 0.3)
        while t < d - 0.15:
            fb = rng.uniform(350.0, 900.0)
            mix_at(
                int(t * SR),
                droplet(
                    rng.uniform(0.03, 0.07),
                    fb,
                    fb * rng.uniform(1.5, 2.4),
                    rng.uniform(0.2, 0.5),
                ),
            )
            glugs += 1
            t += rng.uniform(0.06, 0.2)
        tags = {"style": "pour", "glugs": glugs,
                "body": "hissy" if lp > 0.18 else "muffled",
                "wobble_hz": round(wobf, 1)}

    elif style == "stream":
        # soft crunchy noise bed under many little rising (or sinking) bloops
        d = rng.uniform(1.2, 1.9)
        n = int(d * SR)
        per = rng.choice([2, 3, 4])
        noise = Lfsr(rng, per)
        lp = rng.uniform(0.08, 0.16)
        wobf = rng.uniform(0.7, 1.8)
        y = 0.0
        bed = []
        for i in range(n):
            t = i / SR
            y += lp * (noise.next() - y)
            env = min(1.0, t / 0.2) * min(1.0, (d - t) / 0.25)
            env *= 0.8 + 0.2 * math.sin(2.0 * math.pi * wobf * t + 1.0)
            bed.append(y * env * 0.5)
        mix_at(0, bed)
        bloops = rng.randint(7, 14)
        for _ in range(bloops):
            pos = rng.uniform(0.05, d - 0.15)
            fb = rng.uniform(220.0, 850.0)
            if rng.random() < 0.75:
                ratio = rng.uniform(1.4, 2.6)
            else:
                ratio = rng.uniform(0.45, 0.7)
            mix_at(
                int(pos * SR),
                droplet(
                    rng.uniform(0.04, 0.1),
                    fb,
                    fb * ratio,
                    rng.uniform(0.3, 0.7),
                    wob=rng.uniform(0.0, 0.05),
                ),
            )
        tags = {"style": "stream", "bloops": bloops,
                "bed": {2: "fine", 3: "grainy", 4: "crunchy"}[per],
                "sway_hz": round(wobf, 1)}

    elif style == "dive":
        # falling whistle (DC-compensated square) into a churning impact wash
        fall = rng.uniform(0.2, 0.45)
        f0 = rng.uniform(900.0, 1600.0)
        f1 = rng.uniform(150.0, 300.0)
        duty = rng.choice([0.5, 0.5, 0.25])
        dc = 2.0 * duty - 1.0
        nf = int(fall * SR)
        whis = []
        ph = 0.0
        for i in range(nf):
            u = i / nf
            ph += f0 * (f1 / f0) ** u / SR
            env = min(1.0, i / (0.01 * SR)) * (1.0 - 0.35 * u)
            env *= min(1.0, (nf - 1 - i) / (0.02 * SR))
            whis.append((square(ph, duty) - dc) * env * 0.5)
        mix_at(0, whis)
        splash_at = max(0, nf - int(0.02 * SR))
        sd = rng.uniform(0.35, 0.6)
        mix_at(
            splash_at,
            wash(
                sd,
                rng.choice([1, 2]),
                rng.uniform(0.15, 0.35),
                rng.uniform(6.0, 11.0),
                1.0,
                gurgle=0.4,
            ),
        )
        mix_at(
            splash_at,
            droplet(
                rng.uniform(0.06, 0.1),
                rng.uniform(130.0, 220.0),
                rng.uniform(50.0, 80.0),
                0.8,
            ),
        )
        drops = rng.randint(1, 3)
        for _ in range(drops):
            pos = splash_at + int(rng.uniform(0.2, 0.7) * sd * SR)
            fd = rng.uniform(450.0, 1000.0)
            mix_at(
                pos,
                droplet(
                    rng.uniform(0.04, 0.07),
                    fd,
                    fd * rng.uniform(1.6, 2.5),
                    rng.uniform(0.2, 0.4),
                ),
            )
        pad_to(len(buf) + int(0.04 * SR))
        tags = {"style": "dive", "whistle_hz": int(round(f0)),
                "duty": "thin" if duty == 0.25 else "full",
                "drops": drops}

    else:  # blub — slow wobbly low glubs, optionally over a muffled deep bed
        nblubs = rng.randint(3, 6)
        base = rng.uniform(70.0, 130.0)
        t = 0.02
        for _ in range(nblubs):
            fb = base * rng.uniform(0.85, 1.2)
            bd = rng.uniform(0.07, 0.13)
            mix_at(
                int(t * SR),
                droplet(
                    bd,
                    fb,
                    fb * rng.uniform(1.6, 2.3),
                    rng.uniform(0.6, 1.0),
                    wob=rng.uniform(0.04, 0.12),
                ),
            )
            t += bd + rng.uniform(0.06, 0.18)
        bedded = rng.random() < 0.6
        if bedded:
            bed_d = t + 0.03
            mix_at(0, wash(bed_d, rng.randint(6, 10), 0.25, 1.5 / bed_d, 0.18, gurgle=0.6))
        pad_to(int((t + 0.05) * SR))
        tags = {"style": "blub", "blubs": nblubs, "base_hz": int(round(base)),
                "bed": "bedded" if bedded else "dry"}

    rng.tags = tags

    # --- post: hand-rolled DC blocker, edge fades, peak normalize ---------
    n = len(buf)
    out = []
    px = 0.0
    py = 0.0
    for s in buf:
        py = s - px + 0.9985 * py
        px = s
        out.append(py)
    hf = max(1, int(0.002 * SR))
    tf = max(1, int(0.012 * SR))
    for i in range(min(hf, n)):
        out[i] *= i / hf
    for i in range(min(tf, n)):
        out[n - 1 - i] *= i / tf
    peak = 0.0
    for s in out:
        a = abs(s)
        if a > peak:
            peak = a
    gain = rng.uniform(0.7, 0.95) / peak if peak > 1e-9 else 0.0
    return [s * gain for s in out]


def gen_fire(rng):
    def flicker_env(n, hold_lo, hold_hi, lo, hi, smooth):
        # sample-and-hold random target, one-pole smoothed: slow fire flicker
        env = []
        y = rng.uniform(lo, hi)
        target = y
        countdown = 0
        for _ in range(n):
            if countdown <= 0:
                target = rng.uniform(lo, hi)
                countdown = rng.randint(hold_lo, hold_hi)
            countdown -= 1
            y += smooth * (target - y)
            env.append(y)
        return env

    def add_pop(buf, pos, amp):
        # bright noise click, sometimes with a low pitch-dropping thump
        nlen = int(SR * rng.uniform(0.005, 0.022))
        lf = Lfsr(rng, rng.randint(1, 2))
        rate = rng.uniform(250.0, 700.0)
        for i in range(nlen):
            j = pos + i
            if j >= len(buf):
                break
            buf[j] += amp * lf.next() * math.exp(-rate * i / SR)
        if rng.random() < 0.6:
            f0 = rng.uniform(110.0, 420.0)
            plen = int(SR * rng.uniform(0.012, 0.035))
            ph = 0.0
            for i in range(plen):
                j = pos + i
                if j >= len(buf):
                    break
                t = i / SR
                ph += (f0 * math.exp(-16.0 * t)) / SR
                buf[j] += 0.9 * amp * triangle(ph) * math.exp(-90.0 * t)

    # a few warm-up draws so poorly-mixed small seeds still spread the style pick
    for _ in range(3):
        rng.random()
    style = rng.choice(
        ["campfire", "ignition", "torch", "sizzle", "pops", "ember", "flare"])

    if style == "campfire":
        # steady crackle bed, medium crunch, scattered small pops
        dur = rng.uniform(1.3, 2.5)
        n = int(SR * dur)
        buf = [0.0] * n
        lf = Lfsr(rng, rng.randint(3, 6))
        a = rng.uniform(0.12, 0.3)
        fl = flicker_env(n, int(0.03 * SR), int(0.09 * SR), 0.2, 1.0, 0.002)
        y = 0.0
        for i in range(n):
            y += a * (lf.next() - y)
            buf[i] = y * fl[i] * 0.9
        npops = rng.randint(int(dur * 3), int(dur * 9))
        for _ in range(npops):
            pos = rng.randint(0, n - int(0.03 * SR) - 1)
            add_pop(buf, pos, rng.uniform(0.35, 1.0))
        tags = {
            'style': 'campfire',
            'texture': 'muffled' if a < 0.21 else 'crisp',
            'density': 'scattered' if npops / dur < 6.0 else 'busy',
            'pops': npops,
        }

    elif style == "ignition":
        # whoosh: noise brightening as it swells, plus a rising triangle rumble
        dur = rng.uniform(0.5, 1.2)
        n = int(SR * dur)
        buf = [0.0] * n
        lf = Lfsr(rng, 1)
        rise = rng.uniform(0.15, 0.4) * dur
        drate = rng.uniform(2.5, 5.0) / dur
        a0 = 0.04
        a1 = rng.uniform(0.5, 0.9)
        y = 0.0
        for i in range(n):
            t = i / SR
            u = min(1.0, t / rise)
            y += (a0 + (a1 - a0) * u * u) * (lf.next() - y)
            env = u if t < rise else math.exp(-drate * (t - rise))
            buf[i] = y * env
        f0 = rng.uniform(50.0, 110.0)
        mult = rng.uniform(2.0, 5.0)
        rumb = rng.uniform(0.25, 0.45)
        ph = 0.0
        for i in range(n):
            t = i / SR
            ph += (f0 * (1.0 + mult * min(1.0, t / (dur * 0.7)))) / SR
            env = min(1.0, t / rise) * math.exp(-drate * max(0.0, t - rise))
            buf[i] += rumb * triangle(ph) * env
        lo = int(n * 0.55)
        hi = max(lo + 1, n - int(0.03 * SR) - 1)
        npops = rng.randint(1, 4)
        for _ in range(npops):
            add_pop(buf, rng.randint(lo, hi), rng.uniform(0.25, 0.6))
        tags = {
            'style': 'ignition',
            'attack': 'fast' if rise / dur < 0.28 else 'slow',
            'rumble_hz': round(f0),
            'pops': npops,
        }

    elif style == "torch":
        # sustained flutter: noise pumped by an irregular 8-16 Hz wobble + soft drone
        dur = rng.uniform(0.8, 2.0)
        n = int(SR * dur)
        buf = [0.0] * n
        lf = Lfsr(rng, rng.randint(2, 4))
        a = rng.uniform(0.2, 0.45)
        rate = rng.uniform(8.0, 16.0)
        depth = rng.uniform(0.3, 0.5)
        jit = flicker_env(n, int(0.05 * SR), int(0.15 * SR), -1.0, 1.0, 0.001)
        f0 = rng.uniform(50.0, 90.0)
        vib = rng.uniform(3.0, 6.0)
        y = 0.0
        dph = 0.0
        for i in range(n):
            t = i / SR
            flut = 1.0 - depth + depth * math.sin(
                2.0 * math.pi * rate * t + 2.0 * jit[i])
            y += a * (lf.next() - y)
            dph += (f0 * (1.0 + 0.02 * math.sin(2.0 * math.pi * vib * t))) / SR
            buf[i] = y * flut * 0.85 + 0.18 * triangle(dph) * flut
        for _ in range(rng.randint(0, 3)):
            pos = rng.randint(0, n - int(0.03 * SR) - 1)
            add_pop(buf, pos, rng.uniform(0.15, 0.35))
        tags = {
            'style': 'torch',
            'flutter_hz': round(rate),
            'wobble': 'gentle' if depth < 0.4 else 'deep',
            'drone_hz': round(f0),
        }

    elif style == "sizzle":
        # frying hiss: brightest noise chopped by dense random micro-gates
        dur = rng.uniform(0.6, 1.7)
        n = int(SR * dur)
        buf = [0.0] * n
        lf = Lfsr(rng, 1)
        drate = rng.uniform(0.5, 1.4)
        dense = rng.uniform(0.45, 0.8)
        gate = 0.0
        gtarget = 0.0
        hold = 0
        for i in range(n):
            if hold <= 0:
                hold = rng.randint(int(0.002 * SR), int(0.009 * SR))
                if rng.random() < dense:
                    gtarget = rng.uniform(0.5, 1.0)
                else:
                    gtarget = rng.uniform(0.0, 0.12)
            hold -= 1
            gate += 0.01 * (gtarget - gate)
            buf[i] = lf.next() * gate * math.exp(-drate * i / SR) * 0.9
        npops = rng.randint(2, 6)
        for _ in range(npops):
            pos = rng.randint(0, n - int(0.03 * SR) - 1)
            add_pop(buf, pos, rng.uniform(0.2, 0.5))
        tags = {
            'style': 'sizzle',
            'gating': 'patchy' if dense < 0.62 else 'relentless',
            'heat': 'steady' if drate < 0.95 else 'dying',
            'pops': npops,
        }

    elif style == "pops":
        # sparse big explosive pops over a quiet, dark crackle bed
        dur = rng.uniform(0.6, 1.5)
        n = int(SR * dur)
        buf = [0.0] * n
        lf = Lfsr(rng, rng.randint(4, 7))
        a = rng.uniform(0.1, 0.25)
        fl = flicker_env(n, int(0.02 * SR), int(0.07 * SR), 0.1, 0.5, 0.003)
        y = 0.0
        for i in range(n):
            y += a * (lf.next() - y)
            buf[i] = y * fl[i]
        k = rng.randint(2, 5)
        for j in range(k):
            frac = (j + rng.uniform(0.05, 0.9)) / k
            pos = min(n - int(0.04 * SR) - 1, int(n * frac))
            add_pop(buf, max(0, pos), rng.uniform(0.8, 1.4))
        tags = {
            'style': 'pops',
            'bursts': k,
            'bed': 'faint' if a < 0.175 else 'grainy',
        }

    elif style == "ember":
        # glowing embers: very crunchy slow noise, gentle flicker, tiny ticks
        dur = rng.uniform(1.0, 2.3)
        n = int(SR * dur)
        buf = [0.0] * n
        per = rng.randint(6, 10)
        lf = Lfsr(rng, per)
        a = rng.uniform(0.05, 0.12)
        fl = flicker_env(n, int(0.06 * SR), int(0.18 * SR), 0.3, 1.0, 0.0012)
        y = 0.0
        for i in range(n):
            y += a * (lf.next() - y)
            buf[i] = y * fl[i]
        npops = rng.randint(2, 6)
        for _ in range(npops):
            pos = rng.randint(0, n - int(0.03 * SR) - 1)
            add_pop(buf, pos, rng.uniform(0.15, 0.4))
        tags = {
            'style': 'ember',
            'texture': 'gritty' if per < 8 else 'coarse',
            'glow': 'dim' if a < 0.085 else 'lively',
            'ticks': npops,
        }

    else:  # flare: crackle swells to a burst with a down-swept square growl
        dur = rng.uniform(0.8, 1.8)
        n = int(SR * dur)
        buf = [0.0] * n
        lf = Lfsr(rng, rng.randint(2, 5))
        a = rng.uniform(0.15, 0.35)
        peak_at = rng.uniform(0.35, 0.6)
        krel = rng.uniform(3.0, 6.0) / (1.0 - peak_at)
        fl = flicker_env(n, int(0.02 * SR), int(0.06 * SR), 0.4, 1.0, 0.003)
        y = 0.0
        for i in range(n):
            u = i / (n - 1)
            if u < peak_at:
                env = 0.2 + 0.8 * (u / peak_at) ** 2
            else:
                env = math.exp(-krel * (u - peak_at))
            y += a * (lf.next() - y)
            buf[i] = y * fl[i] * env
        ppos = int(n * peak_at)
        add_pop(buf, ppos, rng.uniform(0.9, 1.3))
        f0 = rng.uniform(200.0, 500.0)
        duty = rng.choice([0.125, 0.25])
        glen = int(SR * rng.uniform(0.08, 0.2))
        ph = 0.0
        for i in range(glen):
            j = ppos + i
            if j >= n:
                break
            t = i / SR
            ph += (f0 * math.exp(-8.0 * t)) / SR
            buf[j] += 0.6 * square(ph, duty) * math.exp(-25.0 * t)
        hi = n - int(0.03 * SR) - 1
        for _ in range(rng.randint(1, 3)):
            add_pop(buf, rng.randint(min(ppos, hi - 1), hi), rng.uniform(0.3, 0.7))
        tags = {
            'style': 'flare',
            'peak': 'early' if peak_at < 0.48 else 'late',
            'growl': 'reedy' if duty == 0.125 else 'hollow',
            'growl_hz': round(f0),
        }

    rng.tags = tags

    # master: short fade-in, click-free fade-out, then normalize and clamp
    n = len(buf)
    fin = min(int(0.004 * SR), n // 4)
    fout = min(int(0.03 * SR), n // 4)
    for i in range(fin):
        buf[i] *= i / max(1, fin)
    for i in range(fout):
        buf[n - 1 - i] *= i / max(1, fout)
    peak = 0.0
    for v in buf:
        av = abs(v)
        if av > peak:
            peak = av
    if peak < 1e-6:
        peak = 1.0
    g = rng.uniform(0.75, 0.92) / peak
    out = []
    for v in buf:
        v *= g
        if v > 1.0:
            v = 1.0
        elif v < -1.0:
            v = -1.0
        out.append(v)
    return out


def gen_footstep(rng):
    style = rng.choice(["grass", "gravel", "stone", "wood", "snow", "mud", "puddle"])

    def lp_burst(n, period, alpha, atk, rate, gain):
        # one-pole lowpassed LFSR noise shaped by an attack/decay envelope
        noise = Lfsr(rng, period)
        out = []
        prev = 0.0
        inv_atk = 1.0 / max(atk, 1e-4)
        for i in range(n):
            t = i / SR
            prev += alpha * (noise.next() - prev)
            env = min(1.0, t * inv_atk) * math.exp(-rate * t)
            out.append(prev * env * gain)
        return out

    def mix_into(dst, src, offset):
        need = offset + len(src)
        if need > len(dst):
            dst.extend([0.0] * (need - len(dst)))
        for i in range(len(src)):
            dst[offset + i] += src[i]

    if style == "grass":
        # soft swish: dark filtered hiss, sometimes a fainter toe-drag behind it
        dur = rng.uniform(0.08, 0.18)
        n = int(dur * SR)
        period = rng.randint(1, 2)
        alpha = rng.uniform(0.22, 0.4)
        atk = rng.uniform(0.004, 0.012)
        rate = rng.uniform(25.0, 45.0)
        out = lp_burst(n, period, alpha, atk, rate, 1.0)
        has_drag = rng.random() < 0.5
        if has_drag:
            off = int(rng.uniform(0.35, 0.6) * n)
            mix_into(out, lp_burst(n - off, 2, rng.uniform(0.15, 0.3), 0.006,
                                   rng.uniform(35.0, 60.0), rng.uniform(0.3, 0.55)), off)
        tags = {
            'style': 'grass',
            'texture': 'rustling' if alpha > 0.31 else 'hushed',
            'drag': 'toe-drag behind' if has_drag else 'clean single swish',
            'attack_ms': round(atk * 1000),
        }

    elif style == "gravel":
        # a low thud plus a scatter of tiny crunchy ticks
        dur = rng.uniform(0.1, 0.24)
        n = int(dur * SR)
        out = [0.0] * n
        thud_alpha = rng.uniform(0.06, 0.12)
        thud_rate = rng.uniform(30.0, 50.0)
        thud_gain = rng.uniform(0.5, 0.8)
        mix_into(out, lp_burst(int(0.6 * n), 3, thud_alpha, 0.002,
                               thud_rate, thud_gain), 0)
        n_ticks = rng.randint(4, 9)
        for k in range(n_ticks):
            off = 0 if k == 0 else int(rng.uniform(0.0, 0.75) * n)
            ln = int(SR * rng.uniform(0.006, 0.018))
            mix_into(out, lp_burst(ln, rng.randint(2, 6), rng.uniform(0.5, 0.85), 0.0005,
                                   rng.uniform(150.0, 350.0), rng.uniform(0.5, 1.0)), off)
        tags = {
            'style': 'gravel',
            'thud': 'heavy' if thud_gain > 0.65 else 'light',
            'body': 'tight' if thud_rate > 40.0 else 'boomy',
            'ticks': n_ticks,
        }

    elif style == "stone":
        # hard bright clack with a short tonal tick on impact
        dur = rng.uniform(0.05, 0.11)
        n = int(dur * SR)
        period = rng.randint(1, 2)
        alpha = rng.uniform(0.55, 0.85)
        rate = rng.uniform(70.0, 130.0)
        out = lp_burst(n, period, alpha, 0.0005, rate, 1.0)
        f = midi(rng.randint(70, 84))
        g = rng.uniform(0.3, 0.5)
        tick = render_tone(min(n, int(0.03 * SR)), lambda t: f,
                           rng.choice([0.125, 0.25]), decay(rng.uniform(120.0, 220.0)))
        mix_into(out, [s * g for s in tick], 0)
        tags = {
            'style': 'stone',
            'clack': 'glassy' if alpha > 0.7 else 'bright',
            'tick': 'clear' if g > 0.4 else 'faint',
            'tick_hz': round(f),
        }

    elif style == "wood":
        # plank knock: pitched triangle resonance under a bright tap, heel-toe clack
        dur = rng.uniform(0.14, 0.3)
        n = int(dur * SR)
        f0 = midi(rng.randint(43, 57))
        drift = rng.uniform(0.05, 0.2)
        out = render_tone(n, lambda t: f0 * (1.0 - drift * t / dur), 0.5,
                          decay(rng.uniform(16.0, 30.0)), wave_fn="tri")
        ratio = rng.uniform(2.7, 3.4)
        g = rng.uniform(0.25, 0.45)
        ovt = render_tone(n, lambda t: f0 * ratio * (1.0 - drift * t / dur),
                          rng.choice([0.125, 0.25]), decay(rng.uniform(50.0, 90.0)))
        mix_into(out, [s * g for s in ovt], 0)
        mix_into(out, lp_burst(int(0.012 * SR), 1, rng.uniform(0.5, 0.8), 0.0003,
                               rng.uniform(200.0, 320.0), rng.uniform(0.4, 0.6)), 0)
        heel_toe = rng.random() < 0.6
        if heel_toe:
            mix_into(out, lp_burst(int(0.01 * SR), 1, rng.uniform(0.5, 0.8), 0.0003,
                                   300.0, rng.uniform(0.25, 0.45)),
                     int(rng.uniform(0.3, 0.55) * n))
        tags = {
            'style': 'wood',
            'register': 'low' if f0 < 147.0 else 'mid',
            'overtone': 'ringing' if g > 0.35 else 'subtle',
            'taps': 'heel-toe double tap' if heel_toe else 'single tap',
            'knock_hz': round(f0),
        }

    elif style == "snow":
        # crunch: crunchy LFSR gated into crackle clusters by a slower LFSR
        dur = rng.uniform(0.12, 0.28)
        n = int(dur * SR)
        crunch = Lfsr(rng, rng.randint(5, 9))
        gate_period = rng.randint(60, 140)
        gate = Lfsr(rng, gate_period)
        alpha = rng.uniform(0.35, 0.6)
        atk = rng.uniform(0.015, 0.045)
        rate = rng.uniform(11.0, 20.0)
        floor = rng.uniform(0.15, 0.35)
        out = []
        prev = 0.0
        for i in range(n):
            t = i / SR
            prev += alpha * (crunch.next() - prev)
            g = 1.0 if gate.next() > 0.0 else floor
            out.append(prev * g * min(1.0, t / atk) * math.exp(-rate * t))
        tags = {
            'style': 'snow',
            'texture': 'brittle' if alpha > 0.47 else 'packed',
            'contrast': 'stark' if floor < 0.25 else 'soft',
            'crackle_hz': round(SR / gate_period),
        }

    elif style == "mud":
        # squish: very dark noise plus a wobbling low triangle sinking in pitch
        dur = rng.uniform(0.16, 0.3)
        n = int(dur * SR)
        out = lp_burst(n, rng.randint(2, 4), rng.uniform(0.06, 0.13),
                       rng.uniform(0.02, 0.045), rng.uniform(9.0, 16.0), 1.0)
        f0 = rng.uniform(midi(38), midi(46))
        wob = rng.uniform(40.0, 90.0)
        depth = rng.uniform(0.1, 0.25)
        rate = rng.uniform(8.0, 14.0)
        g = rng.uniform(0.4, 0.7)
        sw = render_tone(n, lambda t: f0 * (1.0 - 0.4 * t / dur)
                         * (1.0 + depth * math.sin(wob * t)), 0.5,
                         lambda t: min(1.0, t / 0.03) * math.exp(-rate * t), wave_fn="tri")
        mix_into(out, [s * g for s in sw], 0)
        tags = {
            'style': 'mud',
            'wobble': 'queasy' if depth > 0.175 else 'gentle',
            'weight': 'thick' if g > 0.55 else 'watery',
            'tone_hz': round(f0),
        }

    else:  # puddle
        # splash: bright wet noise plus a small rising triangle bloop
        dur = rng.uniform(0.1, 0.2)
        n = int(dur * SR)
        period = rng.randint(1, 2)
        alpha = rng.uniform(0.45, 0.75)
        atk = rng.uniform(0.001, 0.004)
        rate = rng.uniform(25.0, 45.0)
        out = lp_burst(n, period, alpha, atk, rate, 1.0)
        f0 = midi(rng.randint(55, 65))
        riseoct = rng.uniform(0.6, 1.2)
        bl_dur = rng.uniform(0.04, 0.08)
        bn = int(bl_dur * SR)
        g = rng.uniform(0.45, 0.75)
        blip = render_tone(bn, lambda t: f0 * (2.0 ** (riseoct * t / bl_dur)), 0.5,
                           decay(rng.uniform(30.0, 55.0)), wave_fn="tri")
        off = min(int(rng.uniform(0.01, 0.05) * SR), max(0, n - bn))
        mix_into(out, [s * g for s in blip], off)
        tags = {
            'style': 'puddle',
            'splash': 'fizzy' if alpha > 0.6 else 'wet',
            'bloop': 'plopping' if g > 0.6 else 'soft',
            'bloop_hz': round(f0),
            'rise_oct': round(riseoct, 1),
        }

    rng.tags = tags

    # normalize to a healthy chip level, clamp, and fade the tail to zero
    peak = 0.0
    for s in out:
        a = abs(s)
        if a > peak:
            peak = a
    scale = rng.uniform(0.8, 0.95) / peak if peak > 1e-6 else 1.0
    total = len(out)
    fade = max(1, min(total // 8, int(0.004 * SR)))
    for i in range(total):
        s = out[i] * scale
        if s > 1.0:
            s = 1.0
        elif s < -1.0:
            s = -1.0
        rem = total - i
        if rem <= fade:
            s *= rem / fade
        out[i] = s
    return out


def gen_mech(rng):
    # Objects & mechanisms: creaks, slams, latches, levers, switches,
    # rattles, ratchets, jangling keys. Chip-style: squares, tris, LFSR.

    def mix_at(dst, src, offset, gain=1.0):
        need = offset + len(src)
        if need > len(dst):
            dst.extend([0.0] * (need - len(dst)))
        for i in range(len(src)):
            dst[offset + i] += src[i] * gain

    def noise_burst(n, period, rate, gain=1.0):
        lf = Lfsr(rng, period)
        out = []
        for i in range(n):
            out.append(lf.next() * math.exp(-rate * (i / SR)) * gain)
        return out

    def creak():
        # slow stick-slip hinge squeak: sample-and-hold pitch jitter on a square
        dur = rng.uniform(0.45, 1.1)
        n = int(SR * dur)
        base = rng.uniform(250.0, 750.0)
        drift = rng.uniform(-0.4, 0.7)  # octaves of overall pitch drift
        duty = rng.choice([0.25, 0.5])
        step_len = max(1, int(SR * rng.uniform(0.012, 0.035)))
        tags["pitch_hz"] = int(round(base))
        tags["motion"] = "rising" if drift >= 0.0 else "settling"
        tags["texture"] = "reedy" if duty == 0.25 else "hollow"
        tags["drift_oct"] = round(drift, 1)
        buf = []
        phase = 0.0
        f = base
        amp = 0.0
        target_amp = 0.0
        seg = 0
        for i in range(n):
            if seg <= 0:
                seg = step_len + rng.randint(0, step_len)
                f = base * (2.0 ** (drift * (i / n))) * rng.uniform(0.82, 1.22)
                target_amp = 0.0 if rng.random() < 0.18 else rng.uniform(0.5, 1.0)
            seg -= 1
            amp += (target_amp - amp) * 0.01  # one-pole smoothing by hand
            phase += f / SR
            t = i / n
            env = min(1.0, t * 6.0) * min(1.0, (1.0 - t) * 4.0)
            buf.append(square(phase, duty) * amp * env * 0.8)
        return buf

    def slam():
        # heavy door slam: falling triangle thud + crunchy noise, optional after-shake
        dur = rng.uniform(0.18, 0.42)
        n = int(SR * dur)
        f0 = rng.uniform(90.0, 160.0)
        f1 = rng.uniform(30.0, 55.0)
        tags["thud_hz"] = int(round(f0))
        tags["weight"] = "deep" if f0 < 125.0 else "boxy"
        sweep_t = dur * 0.6
        buf = render_tone(
            n,
            lambda t, f0=f0, f1=f1, st=sweep_t: f0 + (f1 - f0) * min(1.0, t / st),
            0.5, decay(rng.uniform(9.0, 16.0)), "tri")
        nb = noise_burst(int(n * rng.uniform(0.3, 0.6)), rng.randint(4, 9),
                         rng.uniform(30.0, 60.0), rng.uniform(0.5, 0.9))
        mix_at(buf, nb, 0)
        shudder = rng.random() < 0.5  # the frame shudders
        tags["frame"] = "shuddering" if shudder else "clean"
        if shudder:
            for k in range(rng.randint(1, 3)):
                off = int(n * rng.uniform(0.35, 0.9))
                nb2 = noise_burst(int(SR * 0.03), rng.randint(3, 6), 80.0,
                                  0.3 * (0.6 ** k))
                mix_at(buf, nb2, off)
        return buf

    def latch():
        # chest opening: two metal clicks then a short hinge squeak with vibrato
        def click(gain, fr):
            out = noise_burst(int(SR * rng.uniform(0.008, 0.018)),
                              rng.randint(1, 2), 250.0, gain)
            blip = render_tone(int(SR * 0.02), lambda t, fr=fr: fr,
                               0.125, decay(180.0))
            mix_at(out, blip, 0, 0.6 * gain)
            return out
        buf = []
        mix_at(buf, click(0.9, rng.uniform(1400.0, 2600.0)), 0)
        gap = int(SR * rng.uniform(0.04, 0.12))
        mix_at(buf, click(0.7, rng.uniform(900.0, 1800.0)), gap)
        sq_off = gap + int(SR * rng.uniform(0.05, 0.1))
        sdur = rng.uniform(0.12, 0.3)
        sn = int(SR * sdur)
        fb = rng.uniform(400.0, 900.0)
        sw = rng.uniform(0.1, 0.6)  # octaves up over the squeak
        vib = rng.uniform(18.0, 40.0)
        tags["squeak_hz"] = int(round(fb))
        tags["gap_ms"] = int(round(gap * 1000.0 / SR))
        tags["vibrato"] = "fast" if vib >= 29.0 else "slow"
        tags["rise"] = "climbing" if sw >= 0.35 else "gentle"
        sq = render_tone(
            sn,
            lambda t, fb=fb, sw=sw, sd=sdur, vib=vib:
                fb * (2.0 ** (sw * t / sd))
                * (1.0 + 0.05 * math.sin(2.0 * math.pi * vib * t)),
            0.5,
            lambda t: min(1.0, t * 40.0) * math.exp(-4.0 * t))
        mix_at(buf, sq, sq_off, 0.55)
        return buf

    def lever():
        # lever throw: rising scrape into a heavy clunk
        trav = rng.uniform(0.05, 0.15)
        sc = noise_burst(int(SR * trav), rng.randint(2, 4), 6.0, 0.35)
        m = len(sc)
        for i in range(m):
            sc[i] *= (i + 1) / m  # ramp the scrape in
        buf = []
        mix_at(buf, sc, 0)
        off = m
        f0 = rng.uniform(70.0, 130.0)
        cn = int(SR * rng.uniform(0.12, 0.22))
        crate = rng.uniform(18.0, 30.0)
        tags["clunk_hz"] = int(round(f0))
        tags["throw"] = "long" if trav >= 0.1 else "short"
        tags["stop"] = "damped" if crate >= 24.0 else "ringing"
        clunk = render_tone(cn,
                            lambda t, f0=f0: f0 * (1.0 - 0.4 * min(1.0, t * 12.0)),
                            0.5, decay(crate))
        mix_at(buf, clunk, off, 1.0)
        nb = noise_burst(int(SR * 0.03), rng.randint(5, 9), 90.0, 0.8)
        mix_at(buf, nb, off)
        return buf

    def switch():
        # tiny toggle click, sometimes a click-clack pair
        def tick(fr, gain):
            out = noise_burst(int(SR * rng.uniform(0.004, 0.009)), 1, 400.0, gain)
            blip = render_tone(int(SR * 0.015), lambda t, fr=fr: fr,
                               0.125, decay(250.0))
            mix_at(out, blip, 0, 0.7 * gain)
            return out
        buf = []
        fr = rng.uniform(1800.0, 3200.0)
        tags["click_hz"] = int(round(fr))
        tags["brightness"] = "piercing" if fr >= 2500.0 else "crisp"
        mix_at(buf, tick(fr, 1.0), 0)
        pair = rng.random() < 0.6
        tags["action"] = "click-clack pair" if pair else "single click"
        if pair:
            mix_at(buf, tick(fr * rng.uniform(1.1, 1.4), 0.8),
                   int(SR * rng.uniform(0.03, 0.09)))
        buf.extend([0.0] * int(SR * 0.03))
        return buf

    def rattle():
        # gate shaken: irregular clatters, each a crunch + detuned metal ping pair
        buf = []
        hits = rng.randint(4, 9)
        spacing = rng.uniform(0.045, 0.09)
        fr = rng.uniform(500.0, 1100.0)
        tags["hits"] = hits
        tags["ping_hz"] = int(round(fr))
        tags["pace"] = "frantic" if spacing < 0.065 else "loose"
        tags["register"] = "bright" if fr >= 800.0 else "mid"
        t0 = 0.0
        for k in range(hits):
            off = int(SR * t0)
            g = 0.9 * (0.82 ** k) * rng.uniform(0.7, 1.0)
            nb = noise_burst(int(SR * rng.uniform(0.015, 0.03)),
                             rng.randint(2, 5), 120.0, g)
            mix_at(buf, nb, off)
            pn = int(SR * 0.04)
            fh = fr * rng.uniform(0.9, 1.1)
            fh2 = fh * 1.02
            mix_at(buf, render_tone(pn, lambda t, f=fh: f, 0.25, decay(70.0)),
                   off, 0.5 * g)
            mix_at(buf, render_tone(pn, lambda t, f=fh2: f, 0.25, decay(70.0)),
                   off, 0.4 * g)
            t0 += spacing * rng.uniform(0.6, 1.4)
        buf.extend([0.0] * int(SR * 0.02))
        return buf

    def ratchet():
        # winch: evenly ticking pawl, slightly accelerating, faint strain drone
        clicks = rng.randint(5, 12)
        spacing = rng.uniform(0.05, 0.11)
        accel = rng.uniform(0.94, 1.02)
        fr = rng.uniform(180.0, 380.0)
        tags["clicks"] = clicks
        tags["tick_hz"] = int(round(fr))
        tags["motion"] = "accelerating" if accel < 1.0 else "steady"
        buf = []
        t0 = 0.02
        for k in range(clicks):
            off = int(SR * t0)
            mix_at(buf, noise_burst(int(SR * 0.012), rng.randint(3, 6),
                                    200.0, 0.85), off)
            blip = render_tone(int(SR * 0.03), lambda t, f=fr * 2.0: f,
                               0.5, decay(120.0))
            mix_at(buf, blip, off, 0.6)
            t0 += spacing
            spacing *= accel
        droned = rng.random() < 0.6
        tags["undertone"] = "droning" if droned else "dry"
        if droned:
            n = len(buf)
            fd = fr * 0.35
            drone = render_tone(n, lambda t, f=fd: f, 0.5,
                                lambda t: 1.0, "tri")
            for i in range(n):
                tt = i / n
                drone[i] *= 0.25 * min(1.0, tt * 8.0) * min(1.0, (1.0 - tt) * 6.0)
            mix_at(buf, drone, 0)
        buf.extend([0.0] * int(SR * 0.02))
        return buf

    def keys():
        # key ring jangle: scattered detuned high ping pairs with click transients
        dur = rng.uniform(0.3, 0.8)
        buf = [0.0] * int(SR * (dur + 0.08))
        jingles = rng.randint(6, 14)
        tags["pings"] = jingles
        tags["density"] = "busy" if jingles >= 10 else "sparse"
        tags["shake"] = "sustained" if dur >= 0.55 else "quick"
        for k in range(jingles):
            off = int(SR * rng.uniform(0.0, dur))
            f = rng.uniform(1200.0, 3400.0)
            f2 = f * rng.uniform(1.01, 1.06)
            pn = int(SR * rng.uniform(0.03, 0.08))
            g = rng.uniform(0.35, 0.8)
            mix_at(buf, render_tone(pn, lambda t, f=f: f, 0.125,
                                    decay(rng.uniform(40.0, 90.0))), off, g)
            mix_at(buf, render_tone(pn, lambda t, f=f2: f, 0.125,
                                    decay(rng.uniform(40.0, 90.0))), off, g * 0.8)
            mix_at(buf, noise_burst(int(SR * 0.006), 1, 300.0, g * 0.7), off)
        return buf

    style = rng.choice(["creak", "slam", "latch", "lever",
                        "switch", "rattle", "ratchet", "keys"])
    tags = {"style": style}
    if style == "creak":
        buf = creak()
    elif style == "slam":
        buf = slam()
    elif style == "latch":
        buf = latch()
    elif style == "lever":
        buf = lever()
    elif style == "switch":
        buf = switch()
    elif style == "rattle":
        buf = rattle()
    elif style == "ratchet":
        buf = ratchet()
    else:
        buf = keys()

    rng.tags = tags

    # clamp duration to 0.1 - 1.2 s
    n_min = int(SR * 0.1)
    n_max = int(SR * 1.2)
    if len(buf) < n_min:
        buf.extend([0.0] * (n_min - len(buf)))
    elif len(buf) > n_max:
        del buf[n_max:]

    # hand-rolled one-pole DC blocker (narrow-duty squares carry a DC bias)
    prev_x = 0.0
    prev_y = 0.0
    for i in range(len(buf)):
        x = buf[i]
        y = x - prev_x + 0.995 * prev_y
        prev_x = x
        prev_y = y
        buf[i] = y

    # de-click edges, then normalize so the peak clears the quantizer floor
    k = min(int(SR * 0.004), len(buf) // 2)
    for i in range(k):
        g = i / k
        buf[i] *= g
        buf[len(buf) - 1 - i] *= g
    peak = 0.0
    for v in buf:
        a = -v if v < 0.0 else v
        if a > peak:
            peak = a
    if peak > 1e-9:
        g = rng.uniform(0.75, 0.95) / peak
        for i in range(len(buf)):
            buf[i] *= g
    return buf

def gen_person(rng):
    """Human body foley, chip-imitated: heartbeats, breathing, sneezes, coughs,
    snores, yawns, gulps, chewing, claps, applause, snaps, shivers, gut growls.
    Deliberately non-vocal (dialog/grunts/laughs live in gen_voice): everything
    here is air, impact, and gut — LFSR noise pushed through hand-rolled
    one-pole filters, plus low triangle thumps for the body resonance."""
    rng.random()
    rng.random()
    rng.random()
    rng.random()  # warm-up draws: decorrelates style pick across nearby seeds
    out = []

    def add(buf, at):
        need = at + len(buf)
        while len(out) < need:
            out.append(0.0)
        for i, v in enumerate(buf):
            out[at + i] += v

    def one_pole_hz(alpha):
        # readable cutoff of the hand-rolled one-pole lowpass, for the tags
        return int(round(-SR * math.log(1.0 - alpha) / (2.0 * math.pi) / 10.0) * 10)

    def thump(dur, f0, drop, rate, amp=1.0):
        # low triangle knock, pitch sagging to drop*f0 — heart / chest / jaw body
        n = int(SR * dur)
        ph = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            u = i / n
            ph += f0 * (drop ** u) / SR
            buf.append(triangle(ph) * min(1.0, t / 0.004) * math.exp(-rate * u) * amp)
        return buf

    def gust(dur, a0, a1, amp, lf, shape=1.0, gate_hz=0.0, gate_depth=0.0):
        # shaped air: LFSR noise through a one-pole lowpass whose alpha glides
        # a0 -> a1; sine-window envelope; optional soft-palate gate (snores)
        n = int(SR * dur)
        y = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            u = i / n
            y += (a0 + (a1 - a0) * u) * (lf.next() - y)
            env = math.sin(math.pi * u) ** shape
            if gate_hz > 0.0:
                env *= 1.0 - gate_depth * (0.5 + 0.5 * square(t * gate_hz, 0.5))
            buf.append(y * env * amp)
        return buf

    def bark(dur, a0, a1, amp, dk, lf, gate_hz=0.0, gate_depth=0.0):
        # percussive air burst: instant attack, exponential decay (coughs, claps)
        n = int(SR * dur)
        y = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            u = i / n
            y += (a0 + (a1 - a0) * u) * (lf.next() - y)
            env = min(1.0, t / 0.003) * math.exp(-dk * u)
            if gate_hz > 0.0:
                env *= 1.0 - gate_depth * (0.5 + 0.5 * square(t * gate_hz, 0.5))
            buf.append(y * env * amp)
        return buf

    def glug(dur, fa, fb, amp):
        # falling triangle blip — the liquid knock of a swallow
        n = int(SR * dur)
        ph = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            u = i / n
            ph += (fa + (fb - fa) * u) / SR
            buf.append(triangle(ph) * min(1.0, t / 0.004) * ((1.0 - u) ** 1.2) * amp)
        return buf

    style = rng.choice(["heartbeat", "breath", "sneeze", "cough", "snore", "yawn",
                        "gulp", "chew", "clap", "applause", "snap", "shiver", "growl"])

    if style == "heartbeat":
        # lub-dub pairs on a falling triangle thump, dub softer and lower
        bpm = rng.randint(52, 96)
        pairs = rng.choice([1, 2, 2, 3])
        f0 = rng.uniform(46.0, 72.0)
        gap = rng.uniform(0.13, 0.2)
        rate = rng.uniform(4.5, 7.0)
        beat = 60.0 / bpm
        while pairs > 1 and (pairs - 1) * beat + 0.4 > 2.0:
            pairs -= 1
        rng.tags = {"style": "heartbeat", "bpm": bpm, "beats": pairs,
                    "thump_hz": int(round(f0)),
                    "depth": "deep" if f0 < 58.0 else "light"}
        for k in range(pairs):
            t0 = k * beat
            add(thump(0.16, f0 * 1.15, 0.45, rate), int(t0 * SR))
            add(thump(0.14, f0, 0.5, rate * 1.15, amp=0.8), int((t0 + gap) * SR))

    elif style == "breath":
        # in/out air cycles; the one-pole cutoff sets how open the mouth sounds
        mode = rng.choice(["calm", "heavy", "winded"])
        lf = Lfsr(rng, 1)
        if mode == "calm":
            gusts = 2
            a = rng.uniform(0.03, 0.055)
            inh = rng.uniform(0.5, 0.75)
            pause = rng.uniform(0.08, 0.16)
            add(gust(inh, a * 0.6, a, 0.9, lf, shape=1.3), 0)
            add(gust(rng.uniform(0.65, 0.95), a, a * 0.4, 0.7, lf, shape=1.5),
                int((inh + pause) * SR))
        elif mode == "heavy":
            gusts = 2
            a = rng.uniform(0.07, 0.13)
            inh = rng.uniform(0.35, 0.5)
            pause = rng.uniform(0.05, 0.1)
            add(gust(inh, a * 0.5, a * 1.2, 1.0, lf, shape=0.8), 0)
            add(gust(rng.uniform(0.45, 0.65), a, a * 0.35, 0.85, lf, shape=1.0),
                int((inh + pause) * SR))
        else:  # winded: quick alternating puffs, in bright, out duller
            gusts = rng.randint(3, 5)
            a = rng.uniform(0.12, 0.22)
            puff = rng.uniform(0.15, 0.22)
            gap = rng.uniform(0.05, 0.11)
            pos = 0
            for k in range(gusts):
                inhale = k % 2 == 0
                add(gust(puff, a * (1.1 if inhale else 0.6),
                         a * (0.5 if inhale else 0.3),
                         1.0 if inhale else 0.75, lf, shape=0.7), pos)
                pos += int((puff + gap) * SR)
        air_hz = one_pole_hz(a)
        rng.tags = {"style": "breath", "mode": mode, "gusts": gusts,
                    "air_hz": air_hz, "tone": "bright" if air_hz >= 400 else "dark"}

    elif style == "sneeze":
        # soft rising wind-up, then an explosive bright burst over a chest thump
        lf = Lfsr(rng, 1)
        wind = rng.uniform(0.12, 0.3)
        burst = rng.uniform(0.16, 0.3)
        ab = rng.uniform(0.18, 0.34)
        dk = rng.uniform(7.0, 11.0)
        kick = rng.uniform(0.3, 0.7)
        rng.tags = {"style": "sneeze",
                    "buildup": "long" if wind > 0.21 else "short",
                    "burst_hz": one_pole_hz(ab),
                    "kick": "chesty" if kick > 0.5 else "airy"}
        add(gust(wind, 0.02, 0.1, 0.4, lf, shape=1.2), 0)
        p = int(wind * SR)
        add(thump(0.09, rng.uniform(70.0, 110.0), 0.4, 9.0, amp=kick), p)
        add(bark(burst, ab, ab * 0.25, 1.0, dk, lf), p)

    elif style == "cough":
        # noise barks over a chest thud; chesty adds a slow amplitude rattle
        kind = rng.choice(["dry", "dry", "chesty"])
        barks = rng.choice([1, 2, 2, 3])
        lf = Lfsr(rng, rng.choice([1, 2]))
        grit = "coarse" if lf.period == 2 else "fine"
        pos = 0
        if kind == "dry":
            fthud = rng.uniform(85.0, 130.0)
            rng.tags = {"style": "cough", "kind": kind, "barks": barks,
                        "thud_hz": int(round(fthud)), "grit": grit}
            for _ in range(barks):
                d = rng.uniform(0.09, 0.16)
                add(thump(0.07, fthud, 0.5, 10.0, amp=0.55), pos)
                add(bark(d, rng.uniform(0.16, 0.28), 0.05, 1.0,
                         rng.uniform(7.0, 10.0), lf), pos)
                pos += int((d + rng.uniform(0.09, 0.18)) * SR)
        else:
            rat = rng.uniform(24.0, 44.0)
            rng.tags = {"style": "cough", "kind": kind, "barks": barks,
                        "rattle_hz": int(round(rat)), "grit": grit}
            for _ in range(barks):
                d = rng.uniform(0.16, 0.28)
                add(thump(0.09, rng.uniform(65.0, 100.0), 0.45, 8.0, amp=0.7), pos)
                add(bark(d, rng.uniform(0.07, 0.12), 0.03, 1.0,
                         rng.uniform(4.5, 6.5), lf, gate_hz=rat, gate_depth=0.7), pos)
                pos += int((d + rng.uniform(0.1, 0.2)) * SR)

    elif style == "snore":
        # one cycle: long rattly drag in (gated dark noise), soft puff out
        rat = rng.uniform(15.0, 27.0)
        inh = rng.uniform(0.7, 1.05)
        pause = rng.uniform(0.1, 0.2)
        a = rng.uniform(0.035, 0.08)
        lf = Lfsr(rng, rng.choice([1, 2, 3]))
        puffed = rng.random() < 0.75
        rng.tags = {"style": "snore", "rattle_hz": int(round(rat)),
                    "air_hz": one_pole_hz(a),
                    "depth": "deep" if rat < 20.0 else "light",
                    "exhale": "puffed" if puffed else "held"}
        add(gust(inh, a * 0.7, a * 1.3, 1.0, lf, shape=0.9,
                 gate_hz=rat, gate_depth=0.85), 0)
        if puffed:
            add(gust(rng.uniform(0.35, 0.6), a * 1.2, a * 0.5, 0.45, lf, shape=1.4),
                int((inh + pause) * SR))

    elif style == "yawn":
        # airflow swells to a crest then relaxes; a faint undertone sags with it
        dur = rng.uniform(1.0, 1.7)
        crest = rng.uniform(0.35, 0.6)
        peak_a = rng.uniform(0.05, 0.12)
        fall = rng.uniform(0.5, 1.2)
        f0 = rng.uniform(150.0, 240.0)
        under = rng.uniform(0.1, 0.22)
        lf = Lfsr(rng, 1)
        rng.tags = {"style": "yawn", "fall_oct": round(fall, 1),
                    "sag_hz": int(round(f0)),
                    "air": "breathy" if peak_a > 0.085 else "hollow",
                    "crest": "early" if crest < 0.47 else "late"}
        n = int(SR * dur)
        y = 0.0
        ph = 0.0
        buf = []
        for i in range(n):
            u = i / n
            w = u / crest if u < crest else (1.0 - u) / (1.0 - crest)
            y += (0.015 + peak_a * w * w) * (lf.next() - y)
            ph += f0 * (2.0 ** (-fall * u)) / SR
            buf.append((y + triangle(ph) * under * w) * (w ** 0.7))
        add(buf, 0)

    elif style == "gulp":
        # two falling glugs and a throat thump; optional dry tick up front
        f0 = rng.uniform(210.0, 340.0)
        ticked = rng.random() < 0.6
        lf = Lfsr(rng, 1)
        rng.tags = {"style": "gulp", "start_hz": int(round(f0)),
                    "size": "big" if f0 < 270.0 else "small",
                    "onset": "ticked" if ticked else "clean"}
        if ticked:
            add(bark(0.02, 0.5, 0.2, 0.5, 6.0, lf), 0)
        pos = int(rng.uniform(0.015, 0.04) * SR)
        add(glug(rng.uniform(0.05, 0.08), f0, f0 * 0.45, 0.9), pos)
        pos += int(rng.uniform(0.07, 0.12) * SR)
        add(glug(rng.uniform(0.07, 0.11), f0 * 0.7, f0 * 0.28, 1.0), pos)
        add(thump(0.08, rng.uniform(60.0, 90.0), 0.5, 8.0, amp=0.5),
            pos + int(0.02 * SR))

    elif style == "chew":
        # jaw thud + crunch per bite; slow sample-and-hold noise = crunchier
        bites = rng.randint(2, 5)
        period = rng.choice([4, 6, 10, 14])
        lf = Lfsr(rng, period)
        step = rng.uniform(0.16, 0.28)
        rng.tags = {"style": "chew", "bites": bites,
                    "gap_ms": int(round(step * 1000)),
                    "texture": "crunchy" if period <= 6 else "soft",
                    "pace": "brisk" if step < 0.21 else "lazy"}
        pos = 0
        for _ in range(bites):
            add(thump(0.05, rng.uniform(90.0, 140.0), 0.5, 9.0, amp=0.6), pos)
            add(bark(rng.uniform(0.05, 0.09), 0.3, 0.08,
                     rng.uniform(0.75, 1.0), 5.0, lf), pos)
            pos += int(step * rng.uniform(0.85, 1.15) * SR)

    elif style == "clap":
        # one tight bright burst, optionally answered by a small slapback
        d = rng.uniform(0.03, 0.06)
        lf = Lfsr(rng, rng.choice([1, 1, 2]))
        a0 = rng.uniform(0.3, 0.55)
        echo = rng.random() < 0.5
        rng.tags = {"style": "clap", "burst_ms": int(round(d * 1000)),
                    "grit": "tight" if lf.period == 1 else "gritty",
                    "room": "slapback" if echo else "dry"}
        add(bark(d, a0, a0 * 0.4, 1.0, 6.0, lf), 0)
        if echo:
            add(bark(d * 0.9, a0 * 0.7, a0 * 0.3, 0.35, 6.0, lf),
                int(rng.uniform(0.055, 0.09) * SR))

    elif style == "applause":
        # many tiny claps scattered over the window, density shaping the arc
        dur = rng.uniform(1.2, 1.9)
        claps = rng.randint(14, 34)
        arc = rng.choice(["building", "fading", "steady"])
        lf = Lfsr(rng, 1)
        rng.tags = {"style": "applause", "claps": claps, "arc": arc,
                    "crowd": "thick" if claps >= 24 else "sparse"}
        for _ in range(claps):
            r = rng.random()
            if arc == "building":
                r = r ** 0.55
            elif arc == "fading":
                r = r ** 1.8
            a0 = rng.uniform(0.25, 0.5)
            add(bark(rng.uniform(0.018, 0.035), a0, a0 * 0.5,
                     rng.uniform(0.4, 1.0), 5.0, lf), int(r * (dur - 0.06) * SR))

    elif style == "snap":
        # skin click then a narrow triangle ping — the knuckle resonance
        fp = rng.uniform(1500.0, 3200.0)
        pd = rng.uniform(0.04, 0.08)
        lf = Lfsr(rng, 1)
        rng.tags = {"style": "snap", "ping_hz": int(round(fp)),
                    "tone": "glassy" if fp > 2300.0 else "woody",
                    "tail": "ringing" if pd > 0.06 else "tight"}
        add(bark(0.012, 0.6, 0.3, 0.8, 4.0, lf), 0)
        n = int(SR * pd)
        ph = 0.0
        buf = []
        for i in range(n):
            t = i / SR
            u = i / n
            ph += fp / SR
            buf.append(triangle(ph) * min(1.0, t / 0.001) * math.exp(-7.0 * u) * 0.9)
        add(buf, int(0.004 * SR))

    elif style == "shiver":
        # teeth chatter: jittered tick train, upper/lower teeth alternating
        rate = rng.uniform(13.0, 24.0)
        dur = rng.uniform(0.5, 1.1)
        lf = Lfsr(rng, rng.choice([1, 2]))
        t0 = 0.0
        k = 0
        while t0 < dur:
            a0 = 0.5 if k % 2 == 0 else 0.28
            amp = (0.55 + 0.45 * math.sin(math.pi * t0 / dur)) * rng.uniform(0.7, 1.0)
            add(bark(rng.uniform(0.006, 0.012), a0, a0 * 0.6, amp, 3.0, lf),
                int(t0 * SR))
            t0 += rng.uniform(0.85, 1.15) / rate
            k += 1
        rng.tags = {"style": "shiver", "rate_hz": int(round(rate)), "ticks": k,
                    "tremble": "violent" if rate > 18.5 else "mild",
                    "grit": "icy" if lf.period == 1 else "bony"}

    else:  # stomach growl
        # wandering low triangle with sample-and-hold pitch wobble, crackle
        # bed, and a few rising glug bubbles working their way up
        dur = rng.uniform(0.9, 1.7)
        f0 = rng.uniform(42.0, 88.0)
        bubbles = rng.randint(2, 5)
        crackle = Lfsr(rng, rng.randint(10, 16))
        hold = int(SR * rng.uniform(0.05, 0.12))
        rng.tags = {"style": "growl", "base_hz": int(round(f0)),
                    "bubbles": bubbles,
                    "mood": "hungry" if f0 >= 62.0 else "queasy"}
        n = int(SR * dur)
        ph = 0.0
        w = 0.0
        wt = 0.0
        buf = []
        for i in range(n):
            u = i / n
            if i % hold == 0:
                wt = rng.uniform(-1.0, 1.0)
            w += (wt - w) * 0.0015
            ph += f0 * (1.0 + 0.3 * w) / SR
            env = min(1.0, u / 0.12) * min(1.0, (1.0 - u) / 0.18)
            buf.append((triangle(ph) * 0.85 + crackle.next() * 0.2) * env)
        add(buf, 0)
        for _ in range(bubbles):
            t0 = rng.uniform(0.1, dur - 0.15)
            fb = rng.uniform(120.0, 260.0)
            m = int(SR * rng.uniform(0.04, 0.07))
            ph2 = 0.0
            bb = []
            for i in range(m):
                uu = i / m
                ph2 += (fb * (1.0 + 0.9 * uu)) / SR
                bb.append(triangle(ph2) * math.sin(math.pi * uu) * 0.5)
            add(bb, int(t0 * SR))

    # shared finish: pad/clamp to 0.12-2.0 s, DC-block, de-click, normalize
    if not out:
        out.append(0.0)
    n_min = int(SR * 0.12)
    n_max = int(SR * 2.0)
    if len(out) < n_min:
        out.extend([0.0] * (n_min - len(out)))
    elif len(out) > n_max:
        del out[n_max:]
    px = 0.0
    py = 0.0
    for i in range(len(out)):  # hand-rolled one-pole DC blocker (~10 Hz corner)
        x = out[i]
        py = x - px + 0.997 * py
        px = x
        out[i] = py
    fi = min(len(out) // 2, int(SR * 0.002))
    for i in range(fi):
        out[i] *= i / fi
    fo = min(len(out) // 2, int(SR * 0.012))
    for i in range(fo):
        out[len(out) - 1 - i] *= i / fo
    peak = 0.0
    for v in out:
        a = -v if v < 0.0 else v
        if a > peak:
            peak = a
    if peak > 1e-9:
        g = rng.uniform(0.7, 0.92) / peak
        for i in range(len(out)):
            out[i] *= g
    return out


def gen_rpg(rng):
    # RPG-mechanics staples: melee, ranged, magic, loot, and progress jingles.
    # Complements the ported pixel-rpg event set (which already covers steps,
    # dialog blips, menus, dice, damage/heal, fetch, and story fanfares).

    def mix_at(dst, src, offset, gain=1.0):
        need = offset + len(src)
        if need > len(dst):
            dst.extend([0.0] * (need - len(dst)))
        for i in range(len(src)):
            dst[offset + i] += src[i] * gain

    def noise_burst(n, period, rate, gain=1.0):
        lf = Lfsr(rng, period)
        return [lf.next() * math.exp(-rate * (i / SR)) * gain for i in range(n)]

    def lp_sweep(n, period, a0, a1, rate, gain=1.0, atk=0.0):
        # one-pole lowpassed LFSR noise; cutoff coefficient glides a0 -> a1
        lf = Lfsr(rng, period)
        out = []
        prev = 0.0
        inv = 1.0 / max(atk, 1e-4)
        for i in range(n):
            t = i / SR
            prev += (a0 + (a1 - a0) * (i / n)) * (lf.next() - prev)
            a = t * inv
            if a > 1.0:
                a = 1.0
            out.append(prev * a * math.exp(-rate * t) * gain)
        return out

    def fade_tail(seq, ms=25.0):
        # ramp a buffer's last few ms to zero so a mid-effect voice can stop
        # while other voices keep sounding, without a step click
        r = min(len(seq), int(SR * ms * 0.001))
        for i in range(r):
            seq[len(seq) - 1 - i] *= i / r
        return seq

    style = rng.choice([
        "sword_swing", "metal_clash", "bow_shot", "spell_fire", "spell_ice",
        "spell_zap", "buff_shimmer", "potion_glug", "level_up", "quest_done",
        "loot_jingle", "chest_open", "shield_block", "trap_spring",
        "teleport", "game_over", "save_chime",
    ])

    if style == "sword_swing":
        # air-cutting whoosh: bright->dark filtered noise under a falling whistle
        swipes = 2 if rng.random() < 0.3 else 1
        dur = rng.uniform(0.14, 0.24)
        f_wh = rng.uniform(900.0, 2000.0)
        drop = rng.uniform(1.0, 2.2)
        rate = rng.uniform(13.0, 22.0)
        n = int(SR * dur)
        buf = []
        off = 0
        for k in range(swipes):
            sw = fade_tail(lp_sweep(n, rng.randint(1, 2), rng.uniform(0.5, 0.8),
                                    rng.uniform(0.06, 0.16), rate, 1.0,
                                    atk=rng.uniform(0.012, 0.035)))
            mix_at(buf, sw, off, 0.8 ** k)
            wh = fade_tail(render_tone(
                n, lambda t, f=f_wh, d=dur, dr=drop: f * 2.0 ** (-dr * t / d),
                0.5, lambda t, r=rate: min(1.0, t / 0.02) * math.exp(-r * t),
                "tri"))
            mix_at(buf, wh, off, rng.uniform(0.3, 0.5))
            off += int(n * rng.uniform(0.7, 0.9))
        tags = {"style": "sword swing",
                "arc": "cutting" if rate > 17.5 else "broad",
                "swipes": swipes, "whistle_hz": int(round(f_wh))}

    elif style == "metal_clash":
        # blade on blade: three inharmonic square partials over a spark of noise
        f = rng.uniform(420.0, 900.0)
        dur = rng.uniform(0.28, 0.55)
        n = int(SR * dur)
        ring = rng.uniform(8.0, 18.0)
        ratios = [1.0, rng.uniform(1.48, 1.72), rng.uniform(2.28, 2.78)]
        gains = [1.0, rng.uniform(0.5, 0.75), rng.uniform(0.3, 0.55)]
        buf = []
        for j in range(3):
            pt = render_tone(n, lambda t, fr=f * ratios[j]: fr,
                             0.5 if j == 0 else 0.25, decay(ring + 5.0 * j))
            mix_at(buf, pt, 0, gains[j])
        spark = rng.uniform(0.5, 1.1)
        mix_at(buf, noise_burst(int(SR * 0.02), 1, 240.0), 0, spark)
        tags = {"style": "metal clash", "clang_hz": int(round(f)),
                "ring": "long" if ring < 12.0 else "short",
                "attack": "sparking" if spark > 0.8 else "clean"}

    elif style == "bow_shot":
        # string twang settling sharp-to-true, then the arrow zips off
        f0 = rng.uniform(140.0, 300.0)
        vib = rng.uniform(40.0, 85.0)
        tw_dur = rng.uniform(0.09, 0.16)
        tn = int(SR * tw_dur)
        buf = fade_tail(render_tone(
            tn,
            lambda t, f=f0, v=vib: f * (1.0 + 0.22 * math.exp(-34.0 * t))
            * (1.0 + 0.05 * math.exp(-11.0 * t) * math.sin(2.0 * math.pi * v * t)),
            0.25, decay(rng.uniform(20.0, 30.0))))
        zn = int(SR * rng.uniform(0.08, 0.16))
        zip_ = fade_tail(lp_sweep(zn, 1, rng.uniform(0.15, 0.25),
                                  rng.uniform(0.6, 0.85), rng.uniform(11.0, 18.0),
                                  1.0, atk=0.01))
        z_off = int(tn * rng.uniform(0.3, 0.55))
        mix_at(buf, zip_, z_off, rng.uniform(0.35, 0.6))
        hit = rng.random() < 0.5
        if hit:
            fk = rng.uniform(80.0, 130.0)
            kn = int(SR * rng.uniform(0.06, 0.1))
            knock = render_tone(kn, lambda t, fr=fk: fr, 0.5,
                                decay(rng.uniform(35.0, 55.0)), "tri")
            h_off = z_off + zn
            mix_at(buf, knock, h_off, rng.uniform(0.7, 1.0))
            mix_at(buf, noise_burst(int(SR * 0.012), 1, 300.0), h_off, 0.5)
        tags = {"style": "bow shot", "twang_hz": int(round(f0)),
                "string": "tight" if vib > 62.0 else "slack",
                "arrow": "thunk" if hit else "zip"}

    elif style == "spell_fire":
        # fire spell: a blooming dark-noise whoosh with crackles and a low roar
        dur = rng.uniform(0.4, 0.8)
        n = int(SR * dur)
        atk = rng.uniform(0.04, 0.14)
        rate = rng.uniform(5.0, 9.0)
        buf = lp_sweep(n, rng.randint(2, 4), rng.uniform(0.08, 0.16),
                       rng.uniform(0.3, 0.5), rate, 1.0, atk=atk)
        crackles = rng.randint(3, 8)
        for k in range(crackles):
            off = int(n * rng.uniform(0.15, 0.85))
            cl = noise_burst(int(SR * rng.uniform(0.006, 0.014)),
                             rng.randint(1, 2), rng.uniform(180.0, 320.0),
                             rng.uniform(0.4, 0.8))
            mix_at(buf, cl, off)
        fr = rng.uniform(55.0, 90.0)
        roar = render_tone(
            n, lambda t, f=fr: f * (1.0 + 0.12 * math.sin(23.0 * t)), 0.5,
            lambda t, a=atk, r=rate: min(1.0, t / a) * math.exp(-r * t), "tri")
        rg = rng.uniform(0.4, 0.7)
        mix_at(buf, roar, 0, rg)
        tags = {"style": "fire spell", "crackles": crackles,
                "roar_hz": int(round(fr)),
                "body": "throaty" if rg > 0.55 else "airy",
                "surge": "slow bloom" if atk > 0.08 else "fast burst"}

    elif style == "spell_ice":
        # ice spell: glassy narrow-duty shards scattered under a frosty hiss
        shards = rng.randint(4, 8)
        top = rng.uniform(1800.0, 3200.0)
        span = rng.uniform(0.25, 0.5)
        buf = []
        for k in range(shards):
            fs = top * (2.0 ** (-rng.uniform(0.0, 1.2)))
            ln = int(SR * rng.uniform(0.03, 0.06))
            off = int(SR * (span * k / shards + rng.uniform(0.0, 0.02)))
            sh = fade_tail(render_tone(ln, lambda t, fr=fs: fr, 0.125,
                                       decay(rng.uniform(80.0, 130.0))), 10.0)
            mix_at(buf, sh, off, rng.uniform(0.5, 0.9))
        hiss_g = rng.uniform(0.1, 0.3)
        mix_at(buf, lp_sweep(len(buf), 1, 0.8, 0.5, rng.uniform(6.0, 10.0),
                             hiss_g, atk=0.03), 0)
        tags = {"style": "ice spell", "shards": shards, "top_hz": int(round(top)),
                "glint": "glassy" if hiss_g < 0.2 else "frosty"}

    elif style == "spell_zap":
        # arcane zap: a diving square carrying a hard LFO buzz
        f0 = rng.uniform(1100.0, 2000.0)
        fall = rng.uniform(1.4, 2.6)
        dur = rng.uniform(0.16, 0.3)
        n = int(SR * dur)
        bz = rng.uniform(28.0, 70.0)
        depth = rng.uniform(0.2, 0.45)
        duty = rng.choice([0.125, 0.25])
        rr = rng.uniform(9.0, 14.0)
        buf = render_tone(
            n,
            lambda t, f=f0, fa=fall, d=dur, b=bz, dp=depth:
                f * 2.0 ** (-fa * t / d) * (1.0 + dp * square(b * t, 0.5)),
            duty,
            lambda t, r=rr, d=dur:
                math.exp(-r * t) * min(1.0, max(0.0, (d - t) / (0.15 * d))))
        tags = {"style": "arcane zap", "from_hz": int(round(f0)),
                "fall_oct": round(fall, 1),
                "buzz": "coarse" if bz < 48.0 else "fine"}

    elif style == "buff_shimmer":
        # heal/buff shimmer: two detuned triangles gliding up under a tremolo
        f0 = rng.uniform(midi(69), midi(81))
        rise = rng.uniform(0.5, 1.0)
        dur = rng.uniform(0.5, 0.9)
        n = int(SR * dur)
        trem = rng.uniform(5.0, 10.0)
        tdep = rng.uniform(0.25, 0.5)
        det = rng.uniform(1.003, 1.009)

        def env(t, d=dur, tr=trem, dp=tdep):
            a = min(1.0, t / 0.06)
            rel = min(1.0, max(0.0, (d - t) / (0.25 * d)))
            return a * rel * (1.0 - dp * 0.5 * (1.0 + math.sin(2.0 * math.pi * tr * t)))

        buf = render_tone(n, lambda t, f=f0, r=rise, d=dur: f * 2.0 ** (r * t / d),
                          0.5, env, "tri")
        hi = render_tone(n, lambda t, f=f0 * 2.0 * det, r=rise, d=dur:
                         f * 2.0 ** (r * t / d), 0.5, env, "tri")
        mix_at(buf, hi, 0, rng.uniform(0.35, 0.55))
        tags = {"style": "buff shimmer", "base_hz": int(round(f0)),
                "rise_oct": round(rise, 1),
                "tremolo": "fluttery" if trem > 7.5 else "gentle"}

    elif style == "potion_glug":
        # bottle glugs: pitch-dipping triangle blubs stepping up as it empties
        glugs = rng.randint(2, 4)
        f0 = rng.uniform(160.0, 260.0)
        step = rng.uniform(1.1, 1.25)
        gl = rng.uniform(0.07, 0.11)
        buf = []
        off = 0
        for k in range(glugs):
            fk = f0 * (step ** k)
            gn = int(SR * gl)
            g = render_tone(
                gn,
                lambda t, f=fk, d=gl: f * (1.0 - 0.45 * math.sin(math.pi * min(1.0, t / d))),
                0.5, lambda t, d=gl: math.sin(math.pi * min(1.0, t / d)) ** 2, "tri")
            mix_at(buf, g, off)
            mix_at(buf, noise_burst(int(SR * 0.015), rng.randint(2, 3),
                                    rng.uniform(120.0, 200.0)), off,
                   rng.uniform(0.15, 0.3))
            off += gn + int(SR * rng.uniform(0.02, 0.05))
        tags = {"style": "potion glug", "glugs": glugs, "start_hz": int(round(f0)),
                "pour": "thick" if f0 < 205.0 else "thin"}

    elif style == "level_up":
        # level-up fanfare: a quick major climb into a held (maybe vibrato) top
        root = rng.randint(55, 69)
        pat = rng.choice([[0, 4, 7, 12], [0, 4, 7, 12, 16], [0, 7, 12, 16],
                          [0, 5, 9, 12]])
        duty = rng.choice([0.25, 0.5])
        nl = rng.uniform(0.055, 0.085)
        buf = []
        off = 0
        vib_on = False
        for k, iv in enumerate(pat):
            fq = midi(root + iv)
            last = k == len(pat) - 1
            if last:
                dn = int(SR * rng.uniform(0.28, 0.4))
                vib_on = rng.random() < 0.6
                vr = rng.uniform(5.5, 8.0)
                nt = render_tone(
                    dn,
                    lambda t, fr=fq, v=vr, on=vib_on:
                        fr * (1.0 + (0.012 * math.sin(2.0 * math.pi * v * t) if on else 0.0)),
                    duty, decay(rng.uniform(8.0, 11.0)))
            else:
                nt = render_tone(int(SR * nl), lambda t, fr=fq: fr, duty, decay(14.0))
            mix_at(buf, nt, off)
            off += int(SR * nl)
        tags = {"style": "level-up fanfare", "notes": len(pat),
                "root_hz": int(round(midi(root))),
                "finish": "vibrato hold" if vib_on else "clean hold"}

    elif style == "quest_done":
        # quest-complete stinger: a pickup note into a rolled, hanging chord
        root = rng.randint(58, 74)
        duty = rng.choice([0.25, 0.5])
        pk = midi(root - 5)
        buf = fade_tail(render_tone(int(SR * 0.07), lambda t, f=pk: f, duty,
                                    decay(16.0)))
        chord = [0, 4, 7, 12][:rng.choice([3, 4])]
        off = int(SR * rng.uniform(0.08, 0.11))
        roll = int(SR * rng.uniform(0.015, 0.03))
        hold = rng.uniform(0.3, 0.45)
        for k, iv in enumerate(chord):
            fq = midi(root + iv)
            nt = render_tone(int(SR * hold), lambda t, fr=fq: fr, duty,
                             decay(rng.uniform(7.0, 10.0)))
            mix_at(buf, nt, off + k * roll, 0.8 / (1.0 + 0.15 * k))
        tags = {"style": "quest stinger", "chord": len(chord),
                "root_hz": int(round(midi(root))),
                "voice": "bright" if duty == 0.25 else "warm"}

    elif style == "loot_jingle":
        # gold spill: a handful of tiny narrow-duty coin tinks
        coins = rng.randint(3, 6)
        top = rng.randint(91, 102)
        span = rng.uniform(0.12, 0.3)
        buf = []
        for k in range(coins):
            fq = midi(top - rng.randint(0, 7))
            ln = int(SR * rng.uniform(0.05, 0.08))
            off = int(SR * (span * k / coins + rng.uniform(0.0, 0.03)))
            tw = fade_tail(render_tone(
                ln, lambda t, fr=fq: fr * (1.0 + 0.03 * math.exp(-90.0 * t)),
                0.125, decay(rng.uniform(60.0, 90.0))), 12.0)
            mix_at(buf, tw, off, rng.uniform(0.5, 0.9))
        tags = {"style": "loot jingle", "coins": coins,
                "top_hz": int(round(midi(top))),
                "spill": "tight" if span < 0.2 else "scattered"}

    elif style == "chest_open":
        # unlock clicks with metal pings, then a rising reveal swell + sparkles
        clicks = rng.randint(2, 3)
        buf = []
        off = 0
        ping = rng.uniform(1400.0, 2600.0)
        for k in range(clicks):
            mix_at(buf, noise_burst(int(SR * rng.uniform(0.008, 0.014)), 1, 260.0),
                   off, 0.9 - 0.15 * k)
            pg = render_tone(int(SR * 0.02), lambda t, f=ping * (0.85 ** k): f,
                             0.125, decay(170.0))
            mix_at(buf, pg, off, 0.5)
            off += int(SR * rng.uniform(0.05, 0.09))
        sw_dur = rng.uniform(0.2, 0.32)
        sn = int(SR * sw_dur)
        f0 = midi(rng.randint(64, 72))
        sw = render_tone(
            sn, lambda t, f=f0, d=sw_dur: f * 2.0 ** (t / d), 0.5,
            lambda t, d=sw_dur: min(1.0, t / 0.04)
            * min(1.0, max(0.0, (d - t) / (0.3 * d))), "tri")
        mix_at(buf, sw, off, 0.7)
        sparkles = rng.randint(2, 4)
        for k in range(sparkles):
            fq = midi(rng.randint(88, 97))
            sp = fade_tail(render_tone(int(SR * 0.05), lambda t, fr=fq: fr, 0.125,
                                       decay(55.0)), 10.0)
            mix_at(buf, sp, off + int(sn * rng.uniform(0.4, 1.0)),
                   rng.uniform(0.4, 0.7))
        tags = {"style": "chest open", "clicks": clicks,
                "ping_hz": int(round(ping)), "sparkles": sparkles,
                "lock": "heavy" if ping < 1900.0 else "bright"}

    elif style == "shield_block":
        # a hit taken on the shield: ringing parry ting or a dull flat block
        parry = rng.random() < 0.5
        if parry:
            fq = rng.uniform(1600.0, 2600.0)
            rr = rng.uniform(14.0, 20.0)
            n = int(SR * rng.uniform(0.18, 0.3))
            buf = render_tone(
                n, lambda t, fr=fq: fr * (1.0 + 0.04 * (1.0 - math.exp(-25.0 * t))),
                0.125, decay(rr))
            mix_at(buf, noise_burst(int(SR * 0.012), 1, 300.0), 0, 0.7)
            sustain = "long ring" if rr < 17.0 else "quick mute"
        else:
            fq = rng.uniform(220.0, 380.0)
            rr = rng.uniform(20.0, 30.0)
            n = int(SR * rng.uniform(0.14, 0.22))
            buf = render_tone(n, lambda t, fr=fq: fr, 0.5, decay(rr), "tri")
            mix_at(buf, noise_burst(int(SR * 0.025), rng.randint(2, 4), 140.0), 0,
                   rng.uniform(0.6, 0.9))
            sustain = "long ring" if rr < 25.0 else "quick mute"
        tags = {"style": "shield block",
                "response": "parry ting" if parry else "flat block",
                "hz": int(round(fq)), "sustain": sustain}

    elif style == "trap_spring":
        # the arming click, a beat of quiet, then the spring lets go
        buf = noise_burst(int(SR * 0.01), 1, 280.0, rng.uniform(0.6, 0.9))
        gap = int(SR * rng.uniform(0.05, 0.12))
        f0 = rng.uniform(260.0, 480.0)
        wob = rng.uniform(20.0, 42.0)
        bn = int(SR * rng.uniform(0.25, 0.45))
        boing = render_tone(
            bn,
            lambda t, f=f0, w=wob: f * (1.0 + 0.35 * math.exp(-6.0 * t)
                                        * math.sin(2.0 * math.pi * w * t)),
            0.25, decay(rng.uniform(8.0, 12.0)))
        mix_at(buf, boing, gap)
        snap_g = rng.uniform(0.4, 0.9)
        mix_at(buf, noise_burst(int(SR * 0.02), rng.randint(1, 2), 200.0), gap,
               snap_g)
        tags = {"style": "trap spring", "boing_hz": int(round(f0)),
                "wobble_hz": int(round(wob)),
                "snap": "sharp" if snap_g > 0.65 else "soft"}

    elif style == "teleport":
        # warp: a sample-and-hold stepped gliss with a shimmering amp wobble
        up = rng.random() < 0.6
        f0 = rng.uniform(300.0, 600.0) if up else rng.uniform(1400.0, 2400.0)
        span = rng.uniform(1.6, 2.8)
        dur = rng.uniform(0.35, 0.6)
        n = int(SR * dur)
        st = rng.uniform(0.014, 0.025)
        trem = rng.uniform(20.0, 45.0)
        sgn = span if up else -span
        buf = render_tone(
            n,
            lambda t, f=f0, s=sgn, d=dur, q=st:
                f * 2.0 ** (s * (math.floor(t / q) * q) / d),
            0.25,
            lambda t, d=dur, tr=trem:
                min(1.0, t / 0.03) * min(1.0, max(0.0, (d - t) / (0.2 * d)))
                * (0.7 + 0.3 * math.sin(2.0 * math.pi * tr * t)))
        tags = {"style": "teleport warp",
                "direction": "rising" if up else "sinking",
                "span_oct": round(span, 1), "start_hz": int(round(f0))}

    elif style == "game_over":
        # somber sting: a short fall of notes onto a low held tone
        root = rng.randint(57, 64)
        pat = rng.choice([[0, -1, -3, -8], [0, -3, -5, -12], [0, -2, -7],
                          [0, -4, -7, -12], [0, -5, -11]])
        wave = rng.choice(["tri", "sq"])
        nl = rng.uniform(0.1, 0.16)
        buf = []
        off = 0
        for k, iv in enumerate(pat):
            fq = midi(root + iv)
            last = k == len(pat) - 1
            if last:
                dn = int(SR * rng.uniform(0.3, 0.45))
                vr = rng.uniform(4.0, 6.0)
                nt = render_tone(
                    dn,
                    lambda t, fr=fq, v=vr:
                        fr * (1.0 + 0.015 * math.sin(2.0 * math.pi * v * t)),
                    0.5, decay(rng.uniform(7.0, 9.0)),
                    "tri" if wave == "tri" else None)
            else:
                nt = render_tone(int(SR * nl), lambda t, fr=fq: fr, 0.5,
                                 decay(9.0), "tri" if wave == "tri" else None)
            mix_at(buf, nt, off)
            off += int(SR * nl)
        tags = {"style": "game-over sting", "notes": len(pat),
                "end_hz": int(round(midi(root + pat[-1]))),
                "wave": "triangle" if wave == "tri" else "square"}

    else:  # save_chime
        # gentle two-note triangle chime, sometimes with a soft echo repeat
        m = rng.randint(82, 93)
        iv = rng.choice([5, 7])
        nl = rng.uniform(0.07, 0.1)
        echo = rng.random() < 0.6
        buf = []

        def pair(gain, off):
            a = render_tone(int(SR * nl), lambda t, f=midi(m): f, 0.5,
                            decay(18.0), "tri")
            b = fade_tail(render_tone(int(SR * rng.uniform(0.18, 0.26)),
                                      lambda t, f=midi(m + iv): f, 0.5,
                                      decay(rng.uniform(12.0, 18.0)), "tri"))
            mix_at(buf, a, off, gain)
            mix_at(buf, b, off + int(SR * nl), gain)

        pair(1.0, 0)
        if echo:
            pair(rng.uniform(0.25, 0.45), int(SR * rng.uniform(0.16, 0.22)))
        tags = {"style": "save chime", "hz": int(round(midi(m))),
                "interval": "fifth" if iv == 7 else "fourth",
                "echo": "soft echo" if echo else "dry"}

    # clamp into the set's 0.1 - 1.5 s window
    n_min = int(SR * 0.1)
    n_max = int(SR * 1.5)
    if len(buf) < n_min:
        buf.extend([0.0] * (n_min - len(buf)))
    elif len(buf) > n_max:
        del buf[n_max:]

    # hand-rolled one-pole DC blocker (narrow duties and long sweeps drift)
    px = 0.0
    py = 0.0
    for i in range(len(buf)):
        x = buf[i]
        y = x - px + 0.995 * py
        px = x
        py = y
        buf[i] = y

    # de-click the head, fade the tail, normalize above the quantizer floor
    hk = min(int(SR * 0.002), len(buf) // 2)
    for i in range(hk):
        buf[i] *= i / hk
    tk = min(int(SR * 0.018), len(buf) // 2)
    for i in range(tk):
        buf[len(buf) - 1 - i] *= i / tk
    peak = 0.0
    for v in buf:
        a = -v if v < 0.0 else v
        if a > peak:
            peak = a
    if peak > 1e-9:
        g = rng.uniform(0.75, 0.95) / peak
        for i in range(len(buf)):
            buf[i] *= g
    rng.tags = tags
    return buf


CATEGORIES = {
    "jump": gen_jump,
    "coin": gen_coin,
    "laser": gen_laser,
    "explosion": gen_explosion,
    "powerup": gen_powerup,
    "hit": gen_hit,
    "blip": gen_blip,
    "alarm": gen_alarm,
    "drone": gen_drone,
    "jingle": gen_jingle,
    "ambient": gen_ambient,
    "ui": gen_ui,
    "voice": gen_voice,
    "dog": gen_dog,
    "zombie": gen_zombie,
    "monster": gen_monster,
    "water": gen_water,
    "fire": gen_fire,
    "footstep": gen_footstep,
    "mech": gen_mech,
    "person": gen_person,
    "rpg": gen_rpg,
}

# rpg mixes 76 generated staples with the 24 ported game sounds below, totalling 100
COUNTS = {"rpg": 76}


# --- descriptions ---------------------------------------------------------
#
# Every generator records its synthesis decisions in rng.tags; the describers
# below turn those into short catalog blurbs so the manifest can say how each
# effect differs from its neighbors without anyone having to audition all of
# them. Descriptions are derived from the actual parameters — never invented.


def _duty(d):
    return {0.125: "12.5%", 0.25: "25%", 0.5: "50%"}.get(d, str(d))


def describe_jump(tags):
    return "upward square sweep — %s duty, %d Hz climbing %.1f octaves, %s tail" % (
        _duty(tags["duty"]), tags["f0"], tags["sweep"], tags["snap"])


def describe_coin(tags):
    return "two-note pickup blip — %d Hz hopping up a %s at %d%%, %s duty, %.1f/s fade" % (
        tags["root_hz"], tags["interval"], tags["split_pct"], _duty(tags["duty"]), tags["fade"])


def describe_laser(tags):
    return "%s falling zap — %d down to %d Hz, %s duty" % (
        tags["wobble"], tags["from_hz"], tags["to_hz"], _duty(tags["duty"]))


def describe_explosion(tags):
    body = "dry" if tags["rumble_pct"] <= 25 else "%d%% sub-rumble" % tags["rumble_pct"]
    return "noise boom — grit %d, %s %.1f/s fade, %s" % (
        tags["grit"], tags["tail"], tags["fade"], body)


def describe_powerup(tags):
    return "rising %s arpeggio — %d steps from %d Hz, %s duty" % (
        tags["flavor"], tags["steps"], tags["root_hz"], _duty(tags["duty"]))


def describe_hit(tags):
    return "%s impact — %d Hz thud under the burst, %s duty" % (
        tags["balance"], tags["thud_hz"], _duty(tags["duty"]))


def describe_blip(tags):
    return "single UI tick at %d Hz, %s duty square, %d/s fade" % (
        tags["hz"], _duty(tags["duty"]), tags["fade"])


def describe_alarm(tags):
    return "%s two-tone siren — %d and %d Hz every %d ms, %s duty" % (
        tags["pace"], tags["low_hz"], tags["high_hz"], tags["cycle_ms"], _duty(tags["duty"]))


def describe_drone(tags):
    return "low %s hum at %d Hz — %s %.1f Hz wobble" % (
        tags["wave"], tags["hz"], tags["depth"], tags["wobble_hz"])


def describe_jingle(tags):
    return "%d-note stinger from %d Hz resolving up at %d Hz, %s duty" % (
        tags["notes"], tags["root_hz"], tags["resolve_hz"], _duty(tags["duty"]))


def describe_ambient(tags):
    style = tags.get("style", "ambient")
    if style == "wind":
        return "gusting wind bed — %d %s swells over a %s hiss" % (
            tags.get("gusts", 2), tags.get("swell", "gentle"), tags.get("bed", "calm"))
    if style == "crickets":
        return "night cricket chorus — %d voices, %s chirps, lead near %d Hz" % (
            tags.get("voices", 2), tags.get("chirp", "lazy"), tags.get("lead_hz", 3000))
    if style == "drips":
        return "cave drip echoes — %d plinks on a %s rumble, %d ms echo tail" % (
            tags.get("drops", 2), tags.get("bed", "faint"), tags.get("echo_ms", 200))
    if style == "thunder":
        return "distant thunder roll — %s attack, %s rumble, %d Hz throb" % (
            tags.get("attack", "rolling"), tags.get("grain", "crunchy"),
            tags.get("throb_hz", 35))
    if style == "rain":
        return "steady rain patter — %s drops near %d per second, %s hiss" % (
            tags.get("patter", "sparse"), tags.get("drops_sec", 100),
            tags.get("tone", "muffled"))
    if style == "shimmer":
        return "eerie shimmer pad — triangles beating at %d Hz, %s beat, %d sparkle blips" % (
            tags.get("root_hz", 440), tags.get("beat", "slow"), tags.get("sparkles", 4))
    return "ambient environmental bed — %s texture" % style


def describe_ui(tags):
    style = tags.get("style", "ui")
    if style == "click":
        return ("mouse click — %s pulse chirp falling from %d Hz, %s attack"
                % (tags["tone"], tags["pitch_hz"], tags["attack"]))
    if style == "hover":
        return ("soft hover blip — triangle at %d Hz, %s upward glide, %s fade"
                % (tags["pitch_hz"], tags["glide"], tags["fade"]))
    if style == "toggle":
        return ("toggle switch — %s %d-semitone flick at %d Hz, %s voice"
                % (tags["direction"], tags["interval"], tags["note_hz"],
                   tags["timbre"]))
    if style == "ding":
        return ("notification ding — %s pair at %d Hz beating %.1f Hz, %s tail"
                % (tags["timbre"], tags["pitch_hz"], tags["beat_hz"],
                   tags["finish"]))
    if style == "error":
        burst = "double burst" if tags["bursts"] == 2 else "single burst"
        return ("error buzz — %s pulse at %d Hz, %s, %s pitch"
                % (tags["tone"], tags["buzz_hz"], burst, tags["droop"]))
    if style == "success":
        return ("success chime — %s arpeggio, %d rising notes from %d Hz, %s voice"
                % (tags["flavor"], tags["notes"], tags["root_hz"], tags["timbre"]))
    if style == "type":
        if "thock_hz" in tags:
            return ("keyboard tick — %s noise snap at %d/s with a %d Hz thock"
                    % (tags["texture"], tags["decay_rate"], tags["thock_hz"]))
        return ("keyboard tick — %s noise snap at %d/s, dry body"
                % (tags["texture"], tags["decay_rate"]))
    if style == "scroll":
        return ("scroll blip — %s %d-step pitch staircase from %d Hz, %s pulse"
                % (tags["direction"], tags["steps"], tags["start_hz"],
                   tags["tone"]))
    # unknown style: still deterministic, never raises
    extras = ", ".join(str(tags[k]) for k in sorted(tags) if k != "style")
    text = ("%s ui cue — %s" % (style, extras)) if extras else ("%s ui cue" % style)
    return (text + " (chip ui one-shot)")[:95] if len(text) < 30 else text[:95]


def describe_voice(tags):
    style = tags.get("style")
    hz = tags.get("pitch_hz")
    if style == "babble":
        return "chip-speech babble — {} {} Hz voice, {} delivery, {}-syllable run".format(
            tags.get("register"), hz, tags.get("pace"), tags.get("syllables"))
    if style == "grunt":
        return "throaty grunt — {} {} Hz pitch-drop, {} beating rasp".format(
            tags.get("register"), hz, tags.get("texture"))
    if style == "hum":
        return "melodic hum — {} {} Hz triangle drone, {} vibrato, {}-note phrase".format(
            tags.get("register"), hz, tags.get("vibrato"), tags.get("notes"))
    if style == "laugh":
        return "chiptune laugh — {}x {} ha-bursts from {} Hz in a {} descent".format(
            tags.get("bursts"), tags.get("timbre"), hz, tags.get("descent"))
    if style == "gasp":
        return "sharp gasp — {} inhale with an airy {}-register rise of {} oct from {} Hz".format(
            tags.get("attack"), tags.get("register"), tags.get("rise_oct"), hz)
    if style == "sigh":
        return "weary sigh — {} {} Hz glide falling {} oct, {} vibrato and breath".format(
            tags.get("register"), hz, tags.get("fall_oct"), tags.get("vibrato"))
    if style == "hey":
        return "chip 'hey!' shout — {} {} register at {} Hz, {}-semitone leap".format(
            tags.get("timbre"), tags.get("register"), hz, tags.get("jump_semi"))
    return "chip voice effect — {} style around {} Hz".format(style, hz)


def describe_dog(tags):
    def cw(n):
        return {1: "single", 2: "double", 3: "triple", 4: "quadruple"}.get(n, "%dx" % n)

    style = tags.get("style", "unknown")
    if style == "bark_small":
        return "small-dog bark — %s %s Hz snap, %s wuf" % (
            tags.get("timbre", "nasal"), tags.get("pitch_hz", 0), cw(tags.get("barks", 1)))
    if style == "bark_big":
        return "big-dog bark — %s %s Hz chest woof, %s blast" % (
            tags.get("register", "gruff"), tags.get("pitch_hz", 0), cw(tags.get("barks", 1)))
    if style == "yip":
        return "puppy yip — %s chirp from %s Hz, %s sweep, %s yap" % (
            tags.get("timbre", "nasal"), tags.get("pitch_hz", 0),
            tags.get("sweep", "narrow"), cw(tags.get("yips", 1)))
    if style == "whine":
        return "pleading whine — %s %s Hz tone, %s pitch arc, %s vibrato" % (
            tags.get("voice", "smooth"), tags.get("pitch_hz", 0),
            tags.get("arc", "gentle"), tags.get("vibrato", "subtle"))
    if style == "whimper":
        return "sad whimper — %s falling sobs near %s Hz, %s drop" % (
            cw(tags.get("sobs", 2)), tags.get("pitch_hz", 0), tags.get("fall", "shallow"))
    if style == "growl":
        return "menacing growl — %s %s Hz rumble, %s throat tremolo" % (
            tags.get("texture", "coarse"), tags.get("pitch_hz", 0), tags.get("tremolo", "slow"))
    if style == "pant":
        return "happy pant — %s huff-puff rhythm, %s breaths" % (
            tags.get("tone", "airy"), tags.get("breaths", 3))
    if style == "howl":
        return "moonlit howl — %s rise of %s oct from %s Hz, %s voice" % (
            tags.get("voice", "mellow"), tags.get("sweep_oct", 0.5),
            tags.get("start_hz", 0), tags.get("chorus", "single"))
    return "%s chip-dog vocalization, seed-varied 8-bit character" % style


def describe_zombie(tags):
    style = tags['style']
    if style == 'groan':
        return (f"low zombie groan — {tags['voice']} pulse, {tags['breathiness']}, "
                f"{tags['pitch_hz']} Hz sagging {tags['sag_pct']}%")
    if style == 'moan':
        return (f"arcing zombie moan — {tags['voice']} voice, {tags['rise']} rise, "
                f"{tags['vibrato']} vibrato, {tags['pitch_hz']} Hz base")
    if style == 'hiss':
        puffs = 'double puff' if tags['puffs'] == 2 else 'single puff'
        return (f"dry throat hiss — {tags['tone']} noise, {tags['attack']} attack, "
                f"{puffs}, fluttering at {tags['flutter_hz']} Hz")
    if style == 'gurgle':
        return (f"wet throat gurgle — {tags['texture']} crunch, {tags['underlay']} bed, "
                f"wobbling at {tags['wobble_hz']} Hz")
    if style == 'rattle':
        return (f"rattling zombie breath — {tags['gate']} {tags['pace']} gate, "
                f"{tags['undertone']} undertone, {tags['rattle_hz']} Hz chop")
    if style == 'duet':
        return (f"detuned groan duet — {tags['timbre']} pulses, {tags['glide']} pitch, "
                f"{tags['detune_cents']} cents apart at {tags['pitch_hz']} Hz")
    return (f"aggressive snarl bark — {tags['bite']}, {tags['drop']} pitch drop, "
            f"{tags['rasp_hz']} Hz rasp on {tags['pitch_hz']} Hz")


def describe_monster(tags):
    style = tags.get("style")
    if style == "roar":
        return "deep chest roar — %d Hz under %d Hz %s growl, %s pitch" % (
            tags["base_hz"], tags["growl_hz"], tags["growl"], tags["sag"])
    if style == "screech":
        if tags["contour"] == "breaking":
            return "piercing screech — %d Hz breaking against %d Hz, %s wobble" % (
                tags["base_hz"], tags["alt_hz"], tags["wobble"])
        return "piercing screech — unbroken %d Hz arc, %s wobble" % (
            tags["base_hz"], tags["wobble"])
    if style == "snarl":
        return "low ragged snarl — %d Hz %s flutter, %s gate chew, %s contour" % (
            tags["base_hz"], tags["flutter"], tags["gate"], tags["contour"])
    if style == "chitter":
        return "insectoid chitter — %d %s blips around %d Hz, %s phrase" % (
            tags["blips"], tags["wave"], tags["base_hz"], tags["drift"])
    if style == "stomp":
        return "heavy footfall — %s stomp, thud swept %d down to %d Hz, %s debris" % (
            "double" if tags["hits"] == 2 else "single",
            tags["from_hz"], tags["to_hz"], tags["debris"])
    if style == "flap":
        return "wing-beat flapping — %d %s whooshes, %s %d Hz thrum underneath" % (
            tags["beats"], tags["pace"], tags["undertone"], tags["thrum_hz"])
    # squelch
    return "slime squelch — %d Hz falling gliss, %s wobble, %s splat, %d bubbles" % (
        tags["base_hz"], tags["wobble"], tags["splat"], tags["bubbles"])


def describe_water(tags):
    style = tags.get("style", "")
    if style == "drip":
        tail = ("faint echoing double" if tags.get("echo") == "echoing"
                else "lone single drop")
        return (f"cave drip — {tags.get('plip_hz', 0)} Hz plip rising "
                f"{tags.get('rise', 0)}x, {tail}")
    if style == "small_splash":
        s = tags.get("sprays", 0)
        spray = f"{s} spray droplet" + ("" if s == 1 else "s")
        return (f"small splash — {tags.get('texture', 'soft')} wash, "
                f"{tags.get('thunk_hz', 0)} Hz thunk, {spray}")
    if style == "big_splash":
        return (f"big splash — {tags.get('thump_hz', 0)} Hz body thump, "
                f"{tags.get('slosh', 'single hit')}, "
                f"{tags.get('drops', 0)} rain-back drops")
    if style == "pour":
        g = tags.get("glugs", 0)
        glug = f"{g} glug" + ("" if g == 1 else "s")
        return (f"steady pour — {tags.get('body', 'muffled')} gurgling column, "
                f"{tags.get('wobble_hz', 0)} Hz sway, {glug}")
    if style == "stream":
        return (f"babbling stream — {tags.get('bed', 'fine')} noise bed, "
                f"{tags.get('sway_hz', 0)} Hz sway, {tags.get('bloops', 0)} bloops")
    if style == "dive":
        d = tags.get("drops", 0)
        drop = f"{d} after-drop" + ("" if d == 1 else "s")
        return (f"dive splashdown — {tags.get('whistle_hz', 0)} Hz falling "
                f"whistle, {tags.get('duty', 'full')} duty, {drop}")
    if style == "blub":
        bed = ("over a muffled deep bed" if tags.get("bed") == "bedded"
               else "with no bed underneath")
        return (f"underwater blubs — {tags.get('blubs', 0)} wobbly glubs near "
                f"{tags.get('base_hz', 0)} Hz, {bed}")
    return "chip-tone water texture — unspecified splash variant"


def describe_fire(tags):
    def cnt(n, word):
        return f"{n} {word}" if n == 1 else f"{n} {word}s"

    style = tags.get('style', 'fire')
    if style == 'campfire':
        return (f"campfire crackle bed — {tags.get('texture', 'crisp')} grain, "
                f"{tags.get('density', 'scattered')} spread, "
                f"{cnt(tags.get('pops', 4), 'stray pop')}")
    if style == 'ignition':
        return (f"ignition whoosh — {tags.get('attack', 'fast')} swell, "
                f"{tags.get('rumble_hz', 80)} Hz rising rumble, "
                f"{cnt(tags.get('pops', 2), 'late pop')}")
    if style == 'torch':
        return (f"torch flame flutter — {tags.get('wobble', 'gentle')} "
                f"{tags.get('flutter_hz', 12)} Hz wobble over a "
                f"{tags.get('drone_hz', 70)} Hz drone")
    if style == 'sizzle':
        return (f"frying sizzle — {tags.get('gating', 'patchy')} micro-gate hiss, "
                f"{tags.get('heat', 'steady')} heat, "
                f"{cnt(tags.get('pops', 3), 'oil spit')}")
    if style == 'pops':
        return (f"explosive fire pops — {cnt(tags.get('bursts', 3), 'heavy burst')} "
                f"over a {tags.get('bed', 'faint')} crackle bed")
    if style == 'ember':
        return (f"glowing ember bed — {tags.get('texture', 'gritty')} grain, "
                f"{tags.get('glow', 'dim')} flicker, "
                f"{cnt(tags.get('ticks', 3), 'tiny tick')}")
    if style == 'flare':
        return (f"flare-up burst — {tags.get('peak', 'late')} peak, "
                f"{tags.get('growl', 'hollow')} {tags.get('growl_hz', 300)} Hz "
                f"down-swept growl")
    return f"{style} fire effect — unclassified crackle-and-hiss variant"


def describe_footstep(tags):
    style = tags['style']
    if style == 'grass':
        return ("grass-swish step — %s hiss, %s, %d ms attack"
                % (tags['texture'], tags['drag'], tags['attack_ms']))
    if style == 'gravel':
        return ("gravel-crunch step — %s thud, %s body, %d scattered ticks"
                % (tags['thud'], tags['body'], tags['ticks']))
    if style == 'stone':
        return ("stone-clack step — %s attack, %s %d Hz impact tick"
                % (tags['clack'], tags['tick'], tags['tick_hz']))
    if style == 'wood':
        return ("wood-plank step — %s %d Hz knock, %s overtone, %s"
                % (tags['register'], tags['knock_hz'], tags['overtone'], tags['taps']))
    if style == 'snow':
        return ("snow-crunch step — %s grain, %s crackle clusters near %d Hz"
                % (tags['texture'], tags['contrast'], tags['crackle_hz']))
    if style == 'mud':
        return ("mud-squish step — %s squelch, %s wobble on a sinking %d Hz tone"
                % (tags['weight'], tags['wobble'], tags['tone_hz']))
    return ("puddle-splash step — %s spray, %s %d Hz bloop rising %.1f oct"
            % (tags['splash'], tags['bloop'], tags['bloop_hz'], tags['rise_oct']))


def describe_mech(tags):
    style = tags.get("style", "mech")
    if style == "creak":
        return (f"hinge creak — {tags.get('motion', 'wavering')} squeal around "
                f"{tags.get('pitch_hz', 0)} Hz, {tags.get('texture', 'hollow')} tone, "
                f"{tags.get('drift_oct', 0.0)} oct drift")
    if style == "slam":
        return (f"door slam — {tags.get('weight', 'heavy')} {tags.get('thud_hz', 0)} Hz "
                f"thud into crunch, {tags.get('frame', 'clean')} frame")
    if style == "latch":
        return (f"chest latch — double click {tags.get('gap_ms', 0)} ms apart, "
                f"{tags.get('rise', 'gentle')} {tags.get('squeak_hz', 0)} Hz squeak, "
                f"{tags.get('vibrato', 'slow')} vibrato")
    if style == "lever":
        return (f"lever throw — {tags.get('throw', 'short')} scrape into "
                f"{tags.get('stop', 'ringing')} {tags.get('clunk_hz', 0)} Hz clunk")
    if style == "switch":
        return (f"toggle switch — {tags.get('action', 'single click')} at "
                f"{tags.get('click_hz', 0)} Hz, {tags.get('brightness', 'crisp')} tick")
    if style == "rattle":
        return (f"gate rattle — {tags.get('hits', 0)} {tags.get('register', 'mid')} "
                f"clatters near {tags.get('ping_hz', 0)} Hz, "
                f"{tags.get('pace', 'loose')} shaking")
    if style == "ratchet":
        tail = ("over a faint strain drone"
                if tags.get("undertone") == "droning" else "dry mechanism")
        return (f"winch ratchet — {tags.get('clicks', 0)} "
                f"{tags.get('motion', 'steady')} pawl ticks at "
                f"{tags.get('tick_hz', 0)} Hz, {tail}")
    if style == "keys":
        return (f"key-ring jangle — {tags.get('pings', 0)} detuned pings in a "
                f"{tags.get('density', 'sparse')} {tags.get('shake', 'quick')} shake")
    return f"{style} mechanism — chip-style object sfx with mixed clicks and tones"


def describe_person(tags):
    s = tags["style"]
    if s == "heartbeat":
        return "heartbeat lub-dub — %s %d Hz thump, %d beat%s at %d bpm" % (
            tags["depth"], tags["thump_hz"], tags["beats"],
            "" if tags["beats"] == 1 else "s", tags["bpm"])
    if s == "breath":
        return "%s breathing — %d gusts of %s %d Hz chip air" % (
            tags["mode"], tags["gusts"], tags["tone"], tags["air_hz"])
    if s == "sneeze":
        return "chip sneeze — %s wind-up into a %d Hz noise burst, %s kick" % (
            tags["buildup"], tags["burst_hz"], tags["kick"])
    if s == "cough":
        if tags["kind"] == "chesty":
            return "chesty cough — %d bark%s rattling at %d Hz, %s phlegmy grit" % (
                tags["barks"], "" if tags["barks"] == 1 else "s",
                tags["rattle_hz"], tags["grit"])
        return "dry cough — %d sharp bark%s over a %d Hz chest thud, %s grit" % (
            tags["barks"], "" if tags["barks"] == 1 else "s",
            tags["thud_hz"], tags["grit"])
    if s == "snore":
        return "snore cycle — %s %d Hz rattle over %d Hz air, %s exhale" % (
            tags["depth"], tags["rattle_hz"], tags["air_hz"], tags["exhale"])
    if s == "yawn":
        return "stretching yawn — %s swell cresting %s, %d Hz airflow falling %.1f octaves" % (
            tags["air"], tags["crest"], tags["sag_hz"], tags["fall_oct"])
    if s == "gulp":
        return "gulp swallow — %s glug dropping from %d Hz, %s onset" % (
            tags["size"], tags["start_hz"], tags["onset"])
    if s == "chew":
        return "chewing — %d %s bite%s at a %s %d ms munch" % (
            tags["bites"], tags["texture"],
            "" if tags["bites"] == 1 else "s", tags["pace"], tags["gap_ms"])
    if s == "clap":
        return "single clap — %d ms %s burst, %s room" % (
            tags["burst_ms"], tags["grit"], tags["room"])
    if s == "applause":
        return "applause patter — %d scattered claps, %s arc, %s crowd" % (
            tags["claps"], tags["arc"], tags["crowd"])
    if s == "snap":
        return "finger snap — %s %d Hz ping over a dry click, %s tail" % (
            tags["tone"], tags["ping_hz"], tags["tail"])
    if s == "shiver":
        return "teeth-chatter shiver — %d Hz train of %d %s ticks, %s tremble" % (
            tags["rate_hz"], tags["ticks"], tags["grit"], tags["tremble"])
    return "stomach growl — %s %d Hz rumble with %d bubble%s rising" % (
        tags["mood"], tags["base_hz"], tags["bubbles"],
        "" if tags["bubbles"] == 1 else "s")


def describe_rpg(tags):
    s = tags.get("style", "rpg effect")
    if s == "sword swing":
        swipe = "double swipe" if tags["swipes"] == 2 else "single swipe"
        return "sword swing — %s arc, %s, blade whistle off %d Hz" % (
            tags["arc"], swipe, tags["whistle_hz"])
    if s == "metal clash":
        return "metal clash — %d Hz clang, %s ring, %s attack" % (
            tags["clang_hz"], tags["ring"], tags["attack"])
    if s == "bow shot":
        flight = "thuds home" if tags["arrow"] == "thunk" else "zips past"
        return "bow shot — %s string twang at %d Hz, arrow %s" % (
            tags["string"], tags["twang_hz"], flight)
    if s == "fire spell":
        return "fire spell — %s %s, %d crackles, %d Hz roar under it" % (
            tags["body"], tags["surge"], tags["crackles"], tags["roar_hz"])
    if s == "ice spell":
        return "ice spell — %d %s shards chiming down from %d Hz" % (
            tags["shards"], tags["glint"], tags["top_hz"])
    if s == "arcane zap":
        return "arcane zap — %s buzz diving %.1f octaves from %d Hz" % (
            tags["buzz"], tags["fall_oct"], tags["from_hz"])
    if s == "buff shimmer":
        return "buff shimmer — %s tremolo lifting %.1f octaves from %d Hz" % (
            tags["tremolo"], tags["rise_oct"], tags["base_hz"])
    if s == "potion glug":
        return "potion glug — %d %s gulps stepping up from %d Hz" % (
            tags["glugs"], tags["pour"], tags["start_hz"])
    if s == "level-up fanfare":
        return "level-up fanfare — %d-note major climb from %d Hz, %s" % (
            tags["notes"], tags["root_hz"], tags["finish"])
    if s == "quest stinger":
        return "quest stinger — %s pickup into a %d-note chord roll on %d Hz" % (
            tags["voice"], tags["chord"], tags["root_hz"])
    if s == "loot jingle":
        return "loot jingle — %d coins, %s spill, tinkling up to %d Hz" % (
            tags["coins"], tags["spill"], tags["top_hz"])
    if s == "chest open":
        return "chest open — %d-click %s unlock, %d Hz ping, %d-sparkle reveal" % (
            tags["clicks"], tags["lock"], tags["ping_hz"], tags["sparkles"])
    if s == "shield block":
        return "shield block — %s at %d Hz, %s" % (
            tags["response"], tags["hz"], tags["sustain"])
    if s == "trap spring":
        return "trap spring — %s trigger click, %d Hz boing wobbling at %d Hz" % (
            tags["snap"], tags["boing_hz"], tags["wobble_hz"])
    if s == "teleport warp":
        return "teleport warp — %s stepped gliss, %.1f octaves from %d Hz" % (
            tags["direction"], tags["span_oct"], tags["start_hz"])
    if s == "game-over sting":
        return "game-over sting — %d %s notes sinking to %d Hz" % (
            tags["notes"], tags["wave"], tags["end_hz"])
    if s == "save chime":
        return "save chime — %s up from %d Hz, %s" % (
            tags["interval"], tags["hz"], tags["echo"])
    extra = ", ".join("%s %s" % (k, tags[k]) for k in sorted(tags) if k != "style")
    return "%s — %s" % (s, extra) if extra else "%s effect" % s


DESCRIBERS = {name: globals()["describe_" + name] for name in CATEGORIES}


# --- the ported pixel-rpg set (the labeled half of the "rpg" category) ----
#
# An exact port of pixel-rpg's src/audio/sfx.js SOUNDS table and its Web Audio
# engine semantics (src/audio/engine.js): tone segments are square/triangle/
# sawtooth oscillators with a LINEAR f0->f1 sweep and an EXPONENTIAL gain ramp
# from v down to 0.001 over d; noise segments run the engine's LCG
# (s = s*1103515245 + 12345, seeded 1234567) — evaluated in float64 exactly as
# JS does, where the product exceeds 2^53 and rounds, so the stream matches the
# browser bit-for-bit — through an RBJ bandpass with Q=1 whose center frequency
# ramps linearly f0->f1. Rendered at full 8-bit resolution (no 16-level crush).
# Loudness: each sound is peak-normalized to fill 8 bits (the game's soft mix,
# v*master=0.4, would leave quiet steps at ~2 quantization levels); the game's
# intended relative loudness is preserved in each manifest entry's "gain" —
# multiply by it at playback to restore the original mix.

PIXELRPG_SOUNDS = {
    "step-person": [{"type": "noise", "f0": 750, "f1": 420, "d": 0.045, "v": 0.05}],
    "step-dog": [{"type": "noise", "f0": 1400, "f1": 900, "d": 0.03, "v": 0.035}],
    "caption": [
        {"type": "tone", "wave": "square", "f0": 660, "d": 0.04, "v": 0.05},
        {"type": "tone", "wave": "square", "f0": 880, "d": 0.055, "v": 0.05, "t": 0.05},
    ],
    "whimper": [
        {"type": "tone", "wave": "triangle", "f0": 1150, "f1": 920, "d": 0.12, "v": 0.07},
        {"type": "tone", "wave": "triangle", "f0": 1000, "f1": 700, "d": 0.18, "v": 0.06, "t": 0.16},
    ],
    "menu-open": [
        {"type": "tone", "wave": "triangle", "f0": 440, "d": 0.06, "v": 0.09},
        {"type": "tone", "wave": "triangle", "f0": 554, "d": 0.06, "v": 0.09, "t": 0.06},
        {"type": "tone", "wave": "triangle", "f0": 659, "d": 0.09, "v": 0.09, "t": 0.12},
    ],
    "menu-move": [{"type": "tone", "wave": "square", "f0": 880, "d": 0.03, "v": 0.05}],
    "menu-confirm": [
        {"type": "tone", "wave": "square", "f0": 660, "d": 0.05, "v": 0.08},
        {"type": "tone", "wave": "square", "f0": 990, "d": 0.07, "v": 0.08, "t": 0.055},
    ],
    "roll": [
        {"type": "noise", "f0": 2600, "f1": 2200, "d": 0.03, "v": 0.06},
        {"type": "noise", "f0": 2200, "f1": 1800, "d": 0.03, "v": 0.06, "t": 0.05},
        {"type": "noise", "f0": 1800, "f1": 1500, "d": 0.03, "v": 0.06, "t": 0.1},
        {"type": "tone", "wave": "square", "f0": 1320, "d": 0.08, "v": 0.07, "t": 0.16},
    ],
    "damage": [{"type": "tone", "wave": "square", "f0": 220, "f1": 96, "d": 0.2, "v": 0.11}],
    "heal": [
        {"type": "tone", "wave": "triangle", "f0": 523, "d": 0.07, "v": 0.09},
        {"type": "tone", "wave": "triangle", "f0": 659, "d": 0.07, "v": 0.09, "t": 0.07},
        {"type": "tone", "wave": "triangle", "f0": 784, "d": 0.11, "v": 0.09, "t": 0.14},
    ],
    "collapse": [
        {"type": "tone", "wave": "sawtooth", "f0": 440, "f1": 52, "d": 0.65, "v": 0.13},
        {"type": "noise", "f0": 900, "f1": 150, "d": 0.5, "v": 0.06, "t": 0.12},
    ],
    "swap": [
        {"type": "tone", "wave": "square", "f0": 440, "f1": 233, "d": 0.07, "v": 0.08},
        {"type": "tone", "wave": "square", "f0": 233, "f1": 466, "d": 0.09, "v": 0.08, "t": 0.08},
    ],
    "throw": [{"type": "noise", "f0": 400, "f1": 1900, "d": 0.18, "v": 0.08}],
    "pickup": [{"type": "tone", "wave": "square", "f0": 988, "f1": 1175, "d": 0.06, "v": 0.08}],
    "deliver": [
        {"type": "tone", "wave": "square", "f0": 523, "d": 0.06, "v": 0.09},
        {"type": "tone", "wave": "square", "f0": 659, "d": 0.06, "v": 0.09, "t": 0.06},
        {"type": "tone", "wave": "square", "f0": 784, "d": 0.06, "v": 0.09, "t": 0.12},
        {"type": "tone", "wave": "square", "f0": 1047, "d": 0.1, "v": 0.09, "t": 0.18},
    ],
    "meet": [
        {"type": "tone", "wave": "triangle", "f0": 392, "d": 0.11, "v": 0.13},
        {"type": "tone", "wave": "triangle", "f0": 523, "d": 0.11, "v": 0.13, "t": 0.11},
        {"type": "tone", "wave": "triangle", "f0": 659, "d": 0.11, "v": 0.13, "t": 0.22},
        {"type": "tone", "wave": "triangle", "f0": 784, "d": 0.2, "v": 0.13, "t": 0.33},
    ],
    "inflatables": [
        {"type": "tone", "wave": "triangle", "f0": 330, "f1": 415, "d": 0.12, "v": 0.09},
        {"type": "tone", "wave": "triangle", "f0": 415, "f1": 330, "d": 0.12, "v": 0.09, "t": 0.12},
        {"type": "tone", "wave": "triangle", "f0": 330, "f1": 494, "d": 0.16, "v": 0.09, "t": 0.24},
    ],
    "genie": [
        {"type": "tone", "wave": "triangle", "f0": 330, "d": 0.09, "v": 0.1},
        {"type": "tone", "wave": "triangle", "f0": 415, "d": 0.09, "v": 0.1, "t": 0.09},
        {"type": "tone", "wave": "triangle", "f0": 494, "d": 0.09, "v": 0.1, "t": 0.18},
        {"type": "tone", "wave": "triangle", "f0": 659, "f1": 880, "d": 0.22, "v": 0.1, "t": 0.27},
    ],
    "vision": [
        {"type": "tone", "wave": "triangle", "f0": 523, "f1": 554, "d": 0.25, "v": 0.08},
        {"type": "tone", "wave": "triangle", "f0": 622, "f1": 659, "d": 0.25, "v": 0.08, "t": 0.22},
        {"type": "tone", "wave": "triangle", "f0": 740, "f1": 784, "d": 0.35, "v": 0.08, "t": 0.44},
    ],
    "vanish": [
        {"type": "tone", "wave": "square", "f0": 1200, "f1": 2400, "d": 0.07, "v": 0.07},
        {"type": "tone", "wave": "square", "f0": 800, "f1": 1600, "d": 0.07, "v": 0.06, "t": 0.05},
    ],
    "zombie": [
        {"type": "tone", "wave": "sawtooth", "f0": 95, "f1": 62, "d": 0.45, "v": 0.1},
        {"type": "noise", "f0": 300, "f1": 180, "d": 0.3, "v": 0.04, "t": 0.1},
    ],
    "bonk": [
        {"type": "noise", "f0": 320, "f1": 130, "d": 0.09, "v": 0.12},
        {"type": "tone", "wave": "triangle", "f0": 150, "f1": 110, "d": 0.08, "v": 0.1, "t": 0.02},
    ],
    "eat": [
        {"type": "noise", "f0": 700, "f1": 400, "d": 0.06, "v": 0.08},
        {"type": "noise", "f0": 600, "f1": 350, "d": 0.07, "v": 0.08, "t": 0.12},
        {"type": "tone", "wave": "triangle", "f0": 523, "f1": 659, "d": 0.09, "v": 0.07, "t": 0.24},
    ],
    "drunk": [
        {"type": "tone", "wave": "triangle", "f0": 440, "f1": 392, "d": 0.2, "v": 0.09},
        {"type": "tone", "wave": "triangle", "f0": 392, "f1": 466, "d": 0.3, "v": 0.09, "t": 0.2},
        {"type": "tone", "wave": "triangle", "f0": 466, "f1": 415, "d": 0.35, "v": 0.08, "t": 0.5},
    ],
}


PIXELRPG_DESCRIPTIONS = {
    "step-person": "the person's footstep — a soft noise tick swept 750 down to 420 Hz",
    "step-dog": "the dog's lighter, brighter step tick, 1400 down to 900 Hz",
    "caption": "two-note square dialog blip, 660 then 880 Hz",
    "whimper": "drooping two-bend triangle whimper — the dog's hint call",
    "menu-open": "rising three-note triangle chime for opening a menu",
    "menu-move": "single 880 Hz square tick for cursor movement",
    "menu-confirm": "two-note square confirm, 660 into 990 Hz",
    "roll": "dice rattle — three falling noise chits and a 1320 Hz landing ping",
    "damage": "square hurt drop, 220 falling to 96 Hz",
    "heal": "gentle rising triangle triad, C5 E5 G5",
    "collapse": "long sawtooth fall 440 to 52 Hz over sinking noise — going down",
    "swap": "square down-up flip, 440-233 then 233-466 Hz — trading bodies",
    "throw": "rising noise whoosh 400 to 1900 Hz — the ball leaves the hand",
    "pickup": "quick square up-blip 988 to 1175 Hz — the ball is caught",
    "deliver": "four-note square arpeggio C E G C — GOOD DOG",
    "meet": "the meeting fanfare — four rising triangle notes G C E G",
    "inflatables": "wobbling triangle down-up-down bends around 330-494 Hz",
    "genie": "stepped triangle rise into a 659-880 Hz swell — smoke billows",
    "vision": "three slow up-bending triangle pairs — the psychedelic vision",
    "vanish": "two upward square zips, 1200-2400 and 800-1600 Hz — static out",
    "zombie": "low sawtooth groan 95 to 62 Hz over a dark noise rasp",
    "bonk": "blunt noise thump with a 150-110 Hz triangle knock — the bone lands",
    "eat": "two noise chomps and a happy 523-659 Hz triangle uptick",
    "drunk": "three woozy triangle bends drifting around 440 Hz — the room sways",
}


def render_segments(segments):
    """Render one pixel-rpg sound (a list of tone/noise segments) to samples."""
    total = max(seg.get("t", 0.0) + seg["d"] for seg in segments) + 0.05
    out = [0.0] * int(total * SR)
    for seg in segments:
        start = int(seg.get("t", 0.0) * SR)
        d = seg["d"]
        dn = int(d * SR)
        v = seg["v"]
        f0 = float(seg["f0"])
        f1 = float(seg.get("f1", seg["f0"]))
        if seg["type"] == "noise":
            # engine.js noiseBuffer(): exact LCG, then RBJ bandpass Q=1, swept center
            lcg = 1234567
            x1 = x2 = y1 = y2 = 0.0
            for i in range(dn):
                # float64 like JS: the product rounds above 2^53 before the mask
                lcg = int(float(lcg) * 1103515245.0 + 12345.0) & 0x7FFFFFFF
                x0 = lcg / 0x3FFFFFFF - 1.0
                f = f0 + (f1 - f0) * (i / dn)
                w0 = 2.0 * math.pi * min(f, SR * 0.45) / SR
                alpha = math.sin(w0) / 2.0  # Q = 1
                a0 = 1.0 + alpha
                y0 = (alpha / a0) * (x0 - x2) + (2.0 * math.cos(w0) / a0) * y1 - ((1.0 - alpha) / a0) * y2
                x2, x1 = x1, x0
                y2, y1 = y1, y0
                env = v * (0.001 / v) ** (i / dn)
                out[start + i] += y0 * env
        else:
            phase = 0.0
            for i in range(dn):
                f = f0 + (f1 - f0) * (i / dn)
                phase += f / SR
                if seg["wave"] == "triangle":
                    s = triangle(phase)
                elif seg["wave"] == "sawtooth":
                    s = 2.0 * (phase % 1.0) - 1.0
                else:
                    s = square(phase, 0.5)
                env = v * (0.001 / v) ** (i / dn)
                out[start + i] += s * env
    peak = max(abs(s) for s in out) or 1.0
    return [s * 0.9 / peak for s in out], peak


# --- output ---------------------------------------------------------------


def quantize(samples, levels=QUANT_LEVELS):
    out = bytearray()
    for s in samples:
        s = max(-1.0, min(1.0, s * MASTER_GAIN))
        if levels:
            s = round(s * (levels / 2)) / (levels / 2)  # 16-level chip DAC
        out.append(max(0, min(255, int(round((s + 1.0) / 2.0 * 255.0)))))
    return bytes(out)


def write_wav(path, frames):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(SR)
        w.writeframes(frames)


def effect_name(category, idx):
    return "%s_%03d" % (category, idx)


def generate_rpg_ported(out_root, only=None):
    """Render the ported pixel-rpg sounds into the rpg category.

    Each entry carries "gain": the sound's pre-normalization peak relative to
    the loudest sound in the set — playing wavs scaled by it restores the
    game's intended cross-sound loudness balance.
    """
    if only is not None:
        unknown = [l for l in only if l not in PIXELRPG_SOUNDS]
        if unknown:
            sys.exit("unknown effect: rpg_%s" % unknown[0])
    rendered = []
    for label, segments in PIXELRPG_SOUNDS.items():
        if only is not None and label not in only:
            continue
        samples, peak = render_segments(segments)
        rendered.append((label, samples, peak))
    # relative gains are always computed over the FULL set so a --only
    # spot-check writes the same bytes/metadata as a full run
    set_peak = max(render_segments(s)[1] for s in PIXELRPG_SOUNDS.values())
    entries = []
    cat_dir = os.path.join(out_root, "rpg")
    for label, samples, peak in rendered:
        os.makedirs(cat_dir, exist_ok=True)
        frames = quantize(samples, levels=0)
        name = "rpg_" + label
        write_wav(os.path.join(cat_dir, name + ".wav"), frames)
        entries.append({
            "file": "rpg/%s.wav" % name,
            "category": "rpg",
            "label": label,
            "description": PIXELRPG_DESCRIPTIONS[label],
            "gain": round(peak / set_peak, 3),
            "duration_s": round(len(frames) / SR, 3),
            "sample_rate": SR,
            "bits": 8,
            "channels": 1,
        })
    return entries


def generate_one(out_root, category, idx):
    name = effect_name(category, idx)
    rng = Rng(name)
    frames = quantize(CATEGORIES[category](rng))
    description = DESCRIBERS[category](rng.tags)  # every generator must set rng.tags
    cat_dir = os.path.join(out_root, category)
    os.makedirs(cat_dir, exist_ok=True)
    path = os.path.join(cat_dir, name + ".wav")
    write_wav(path, frames)
    return {
        "file": "%s/%s.wav" % (category, name),
        "category": category,
        "description": description,
        "duration_s": round(len(frames) / SR, 3),
        "sample_rate": SR,
        "bits": 8,
        "channels": 1,
    }


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    default_out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sfx")
    ap.add_argument("--out", default=default_out)
    ap.add_argument("--only", nargs="+", metavar="NAME")
    args = ap.parse_args(argv)

    if args.only:
        for name in args.only:
            category, _, idx = name.rpartition("_")
            if category == "rpg" and not idx.isdigit():
                generate_rpg_ported(args.out, only=[idx])
                continue
            count = COUNTS.get(category, VARIATIONS)
            if category not in CATEGORIES or not idx.isdigit() or int(idx) >= count:
                sys.exit("unknown effect: %s" % name)
            generate_one(args.out, category, int(idx))
        return

    entries = []
    for category in CATEGORIES:
        count = COUNTS.get(category, VARIATIONS)
        for idx in range(count):
            entries.append(generate_one(args.out, category, idx))
        print("generated %s (%d)" % (category, count))
    entries.extend(generate_rpg_ported(args.out))
    print("generated rpg ported set (%d, from cportka/pixel-rpg)" % len(PIXELRPG_SOUNDS))
    pkg = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "package.json")
    try:
        with open(pkg) as f:
            version = json.load(f).get("version", "")
    except OSError:
        version = ""
    manifest = {
        "name": "8bit-sfx",
        "version": version,
        "count": len(entries),
        "sample_rate": SR,
        "format": "8-bit unsigned PCM mono WAV",
        "generator": "scripts/generate_sfx.py",
        "effects": entries,
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    print("wrote manifest.json (%d effects)" % len(entries))


if __name__ == "__main__":
    main(sys.argv[1:])
