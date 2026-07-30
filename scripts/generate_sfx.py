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
}


# --- output ---------------------------------------------------------------


def quantize(samples):
    out = bytearray()
    for s in samples:
        s = max(-1.0, min(1.0, s * MASTER_GAIN))
        s = round(s * (QUANT_LEVELS / 2)) / (QUANT_LEVELS / 2)  # 16-level chip DAC
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
            category, _, idx = name.rpartition("_")
            if category not in CATEGORIES:
                sys.exit("unknown effect: %s" % name)
            generate_one(args.out, category, int(idx))
        return

    entries = []
    for category in CATEGORIES:
        for idx in range(VARIATIONS):
            entries.append(generate_one(args.out, category, idx))
        print("generated %s (%d)" % (category, VARIATIONS))
    manifest = {
        "name": "8bit-sfx",
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
