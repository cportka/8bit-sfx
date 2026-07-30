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
    return render_tone(
        int(dur * SR),
        lambda t: f0 * (2.0 ** (sweep * t / dur)),
        duty,
        decay(rng.uniform(4.0, 9.0)),
    )


def gen_coin(rng):
    dur = rng.uniform(0.25, 0.5)
    n = int(dur * SR)
    root = rng.randint(76, 88)  # high register
    jump_iv = rng.choice([3, 4, 5, 7])
    split = rng.uniform(0.2, 0.35)
    duty = rng.choice([0.25, 0.5])
    env = decay(rng.uniform(5.0, 10.0))
    freq = lambda t: midi(root) if t < dur * split else midi(root + jump_iv)
    return render_tone(n, freq, duty, env)


def gen_laser(rng):
    dur = rng.uniform(0.15, 0.4)
    f0 = rng.uniform(midi(84), midi(96))
    f1 = rng.uniform(midi(48), midi(64))
    duty = rng.choice([0.125, 0.25, 0.5])
    vib = rng.uniform(0.0, 30.0)
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
    return render_tone(int(dur * SR), lambda t: f, duty, decay(rng.uniform(20.0, 40.0)))


def gen_alarm(rng):
    dur = rng.uniform(0.4, 1.0)
    n = int(dur * SR)
    fa = midi(rng.randint(69, 81))
    fb = fa * rng.choice([1.26, 1.33, 1.5])
    cycle = rng.uniform(0.06, 0.15)
    duty = rng.choice([0.25, 0.5])
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
        for _ in range(rng.randint(2, 3)):
            carrier = rng.uniform(2600.0, 4600.0)
            prate = rng.uniform(22.0, 42.0)
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
        for _ in range(rng.randint(2, 4)):
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
        return finish(out, 30.0, 120.0)

    if style == "thunder":
        # distant thunder: crunchy low LFSR through two one-pole lowpasses,
        # swell-then-decay envelope undulated by two slow sines + a low throb
        dur = rng.uniform(2.0, 3.0)
        n = int(SR * dur)
        noise = Lfsr(rng, rng.choice([3, 4, 6]))
        atk = rng.uniform(0.15, 0.5)
        u1f = rng.uniform(0.7, 2.0)
        u1p = rng.uniform(0.0, 6.283)
        u2f = rng.uniform(2.0, 5.0)
        u2p = rng.uniform(0.0, 6.283)
        subf = rng.uniform(28.0, 45.0)
        subamp = rng.uniform(0.15, 0.35)
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
    for _ in range(rng.randint(3, 8)):
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
    return finish(out, 100.0, 200.0)


def gen_ui(rng):
    rng.random()
    rng.random()  # warm-up draws: decorrelates style pick across nearby seeds
    style = rng.choice(
        ["click", "hover", "toggle", "ding", "error", "success", "type", "scroll"]
    )
    out = []

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
        out = tone(n, f0, f0 * rng.uniform(0.3, 0.65),
                   rng.choice([0.125, 0.25, 0.5]), rng.uniform(70.0, 130.0))
        if rng.random() < 0.5:
            lf = Lfsr(rng, 1)
            m = min(n, int(SR * 0.0015))
            for i in range(m):
                out[i] += 0.5 * lf.next() * (1.0 - i / m)

    elif style == "hover":
        # soft hover blip: triangle, slight upward glide, gentle decay
        n = int(SR * rng.uniform(0.04, 0.08))
        f0 = rng.uniform(550.0, 1400.0)
        out = tone(n, f0, f0 * rng.uniform(1.05, 1.35), 0.5,
                   rng.uniform(35.0, 60.0), "tri")

    elif style == "toggle":
        # switch on/off: two short notes, up = on, down = off, tiny gap between
        m = rng.randint(72, 86)
        step = rng.choice([3, 4, 5, 7])
        seq = [m, m + step] if rng.random() < 0.5 else [m + step, m]
        ndur = rng.uniform(0.028, 0.045)
        duty = rng.choice([0.25, 0.5])
        wav = rng.choice(["sq", "sq", "tri"])
        rate = rng.uniform(45.0, 80.0)
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
        for k, iv in enumerate(pat):
            f = midi(m + iv)
            last = k == len(pat) - 1
            nn = int(SR * ndur * (1.6 if last else 1.0))
            rate = rng.uniform(10.0, 18.0) if last else rng.uniform(20.0, 35.0)
            out.extend(tone(nn, f, f, duty, rate, wav))

    elif style == "type":
        # keyboard tick: bright LFSR burst with a fast decay, optional low thock
        n = int(SR * rng.uniform(0.032, 0.05))
        lf = Lfsr(rng, rng.choice([1, 1, 2, 3]))
        rate = rng.uniform(120.0, 260.0)
        thock = rng.random() < 0.6
        ft = rng.uniform(250.0, 700.0)
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
        if rng.random() < 0.5:
            ratio = 1.0 / ratio
        steplen = max(1, int(SR * rng.uniform(0.004, 0.008)))
        duty = rng.choice([0.25, 0.5])
        dc = 2.0 * duty - 1.0
        rate = rng.uniform(40.0, 80.0)
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

    elif style == "whimper":
        cnt = rng.randint(2, 4)
        fhi = rng.uniform(650, 1000)
        drop = rng.uniform(0.55, 0.75)
        for c in range(cnt):
            fh = fhi * rng.uniform(0.9, 1.05) * (1.0 - 0.06 * c)
            out.extend(whimper_syll(rng.uniform(0.08, 0.13), fh, fh * drop))
            if c < cnt - 1:
                out.extend([0.0] * int(rng.uniform(0.03, 0.07) * SR))

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
        for b in range(rng.randint(2, 5)):
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
        if rng.random() < 0.55:
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

    elif style == "small_splash":
        # bright short wash + low thunk + a couple of spray droplets
        d = rng.uniform(0.18, 0.32)
        mix_at(
            0,
            wash(
                d,
                rng.choice([1, 1, 2]),
                rng.uniform(0.25, 0.45),
                rng.uniform(14.0, 22.0),
                1.0,
            ),
        )
        mix_at(
            0,
            droplet(
                rng.uniform(0.05, 0.09),
                rng.uniform(180.0, 320.0),
                rng.uniform(90.0, 150.0),
                0.7,
            ),
        )
        for _ in range(rng.randint(1, 3)):
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

    elif style == "big_splash":
        # body thump + long churning wash + secondary slosh + rain-back drops
        d = rng.uniform(0.55, 1.0)
        mix_at(
            0,
            droplet(
                rng.uniform(0.08, 0.14),
                rng.uniform(110.0, 200.0),
                rng.uniform(45.0, 75.0),
                0.9,
            ),
        )
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
        if rng.random() < 0.7:
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
        for _ in range(rng.randint(2, 5)):
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
            t += rng.uniform(0.06, 0.2)

    elif style == "stream":
        # soft crunchy noise bed under many little rising (or sinking) bloops
        d = rng.uniform(1.2, 1.9)
        n = int(d * SR)
        noise = Lfsr(rng, rng.choice([2, 3, 4]))
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
        for _ in range(rng.randint(7, 14)):
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
        for _ in range(rng.randint(1, 3)):
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
        if rng.random() < 0.6:
            bed_d = t + 0.03
            mix_at(0, wash(bed_d, rng.randint(6, 10), 0.25, 1.5 / bed_d, 0.18, gurgle=0.6))
        pad_to(int((t + 0.05) * SR))

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
        for _ in range(rng.randint(int(dur * 3), int(dur * 9))):
            pos = rng.randint(0, n - int(0.03 * SR) - 1)
            add_pop(buf, pos, rng.uniform(0.35, 1.0))

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
        for _ in range(rng.randint(1, 4)):
            add_pop(buf, rng.randint(lo, hi), rng.uniform(0.25, 0.6))

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
        for _ in range(rng.randint(2, 6)):
            pos = rng.randint(0, n - int(0.03 * SR) - 1)
            add_pop(buf, pos, rng.uniform(0.2, 0.5))

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

    elif style == "ember":
        # glowing embers: very crunchy slow noise, gentle flicker, tiny ticks
        dur = rng.uniform(1.0, 2.3)
        n = int(SR * dur)
        buf = [0.0] * n
        lf = Lfsr(rng, rng.randint(6, 10))
        a = rng.uniform(0.05, 0.12)
        fl = flicker_env(n, int(0.06 * SR), int(0.18 * SR), 0.3, 1.0, 0.0012)
        y = 0.0
        for i in range(n):
            y += a * (lf.next() - y)
            buf[i] = y * fl[i]
        for _ in range(rng.randint(2, 6)):
            pos = rng.randint(0, n - int(0.03 * SR) - 1)
            add_pop(buf, pos, rng.uniform(0.15, 0.4))

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
        out = lp_burst(n, rng.randint(1, 2), rng.uniform(0.22, 0.4),
                       rng.uniform(0.004, 0.012), rng.uniform(25.0, 45.0), 1.0)
        if rng.random() < 0.5:
            off = int(rng.uniform(0.35, 0.6) * n)
            mix_into(out, lp_burst(n - off, 2, rng.uniform(0.15, 0.3), 0.006,
                                   rng.uniform(35.0, 60.0), rng.uniform(0.3, 0.55)), off)

    elif style == "gravel":
        # a low thud plus a scatter of tiny crunchy ticks
        dur = rng.uniform(0.1, 0.24)
        n = int(dur * SR)
        out = [0.0] * n
        mix_into(out, lp_burst(int(0.6 * n), 3, rng.uniform(0.06, 0.12), 0.002,
                               rng.uniform(30.0, 50.0), rng.uniform(0.5, 0.8)), 0)
        for k in range(rng.randint(4, 9)):
            off = 0 if k == 0 else int(rng.uniform(0.0, 0.75) * n)
            ln = int(SR * rng.uniform(0.006, 0.018))
            mix_into(out, lp_burst(ln, rng.randint(2, 6), rng.uniform(0.5, 0.85), 0.0005,
                                   rng.uniform(150.0, 350.0), rng.uniform(0.5, 1.0)), off)

    elif style == "stone":
        # hard bright clack with a short tonal tick on impact
        dur = rng.uniform(0.05, 0.11)
        n = int(dur * SR)
        out = lp_burst(n, rng.randint(1, 2), rng.uniform(0.55, 0.85), 0.0005,
                       rng.uniform(70.0, 130.0), 1.0)
        f = midi(rng.randint(70, 84))
        g = rng.uniform(0.3, 0.5)
        tick = render_tone(min(n, int(0.03 * SR)), lambda t: f,
                           rng.choice([0.125, 0.25]), decay(rng.uniform(120.0, 220.0)))
        mix_into(out, [s * g for s in tick], 0)

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
        if rng.random() < 0.6:
            mix_into(out, lp_burst(int(0.01 * SR), 1, rng.uniform(0.5, 0.8), 0.0003,
                                   300.0, rng.uniform(0.25, 0.45)),
                     int(rng.uniform(0.3, 0.55) * n))

    elif style == "snow":
        # crunch: crunchy LFSR gated into crackle clusters by a slower LFSR
        dur = rng.uniform(0.12, 0.28)
        n = int(dur * SR)
        crunch = Lfsr(rng, rng.randint(5, 9))
        gate = Lfsr(rng, rng.randint(60, 140))
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

    else:  # puddle
        # splash: bright wet noise plus a small rising triangle bloop
        dur = rng.uniform(0.1, 0.2)
        n = int(dur * SR)
        out = lp_burst(n, rng.randint(1, 2), rng.uniform(0.45, 0.75),
                       rng.uniform(0.001, 0.004), rng.uniform(25.0, 45.0), 1.0)
        f0 = midi(rng.randint(55, 65))
        riseoct = rng.uniform(0.6, 1.2)
        bl_dur = rng.uniform(0.04, 0.08)
        bn = int(bl_dur * SR)
        g = rng.uniform(0.45, 0.75)
        blip = render_tone(bn, lambda t: f0 * (2.0 ** (riseoct * t / bl_dur)), 0.5,
                           decay(rng.uniform(30.0, 55.0)), wave_fn="tri")
        off = min(int(rng.uniform(0.01, 0.05) * SR), max(0, n - bn))
        mix_into(out, [s * g for s in blip], off)

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
        sweep_t = dur * 0.6
        buf = render_tone(
            n,
            lambda t, f0=f0, f1=f1, st=sweep_t: f0 + (f1 - f0) * min(1.0, t / st),
            0.5, decay(rng.uniform(9.0, 16.0)), "tri")
        nb = noise_burst(int(n * rng.uniform(0.3, 0.6)), rng.randint(4, 9),
                         rng.uniform(30.0, 60.0), rng.uniform(0.5, 0.9))
        mix_at(buf, nb, 0)
        if rng.random() < 0.5:  # the frame shudders
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
        clunk = render_tone(cn,
                            lambda t, f0=f0: f0 * (1.0 - 0.4 * min(1.0, t * 12.0)),
                            0.5, decay(rng.uniform(18.0, 30.0)))
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
        mix_at(buf, tick(fr, 1.0), 0)
        if rng.random() < 0.6:
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
        if rng.random() < 0.6:
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
        for k in range(rng.randint(6, 14)):
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
}


# --- the pixel-rpg set ----------------------------------------------------
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


def generate_pixelrpg(out_root, only=None):
    """Render the ported pixel-rpg set; returns manifest entries.

    Each entry carries "gain": the sound's pre-normalization peak relative to
    the loudest sound in the set — playing wavs scaled by it restores the
    game's intended cross-sound loudness balance.
    """
    if only is not None:
        unknown = [l for l in only if l not in PIXELRPG_SOUNDS]
        if unknown:
            sys.exit("unknown effect: pixelrpg_%s" % unknown[0])
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
    cat_dir = os.path.join(out_root, "pixelrpg")
    for label, samples, peak in rendered:
        os.makedirs(cat_dir, exist_ok=True)
        frames = quantize(samples, levels=0)
        name = "pixelrpg_" + label
        write_wav(os.path.join(cat_dir, name + ".wav"), frames)
        entries.append({
            "file": "pixelrpg/%s.wav" % name,
            "category": "pixelrpg",
            "label": label,
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
    cat_dir = os.path.join(out_root, category)
    os.makedirs(cat_dir, exist_ok=True)
    path = os.path.join(cat_dir, name + ".wav")
    write_wav(path, frames)
    return {
        "file": "%s/%s.wav" % (category, name),
        "category": category,
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
            if name.startswith("pixelrpg_"):
                generate_pixelrpg(args.out, only=[name[len("pixelrpg_"):]])
                continue
            category, _, idx = name.rpartition("_")
            if category not in CATEGORIES or not idx.isdigit():
                sys.exit("unknown effect: %s" % name)
            generate_one(args.out, category, int(idx))
        return

    entries = []
    for category in CATEGORIES:
        for idx in range(VARIATIONS):
            entries.append(generate_one(args.out, category, idx))
        print("generated %s (%d)" % (category, VARIATIONS))
    entries.extend(generate_pixelrpg(args.out))
    print("generated pixelrpg (%d, ported from cportka/pixel-rpg)" % len(PIXELRPG_SOUNDS))
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
