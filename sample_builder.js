// Turns one recorded note into a User instrument file (user1.dat..user4.dat)
// for the Pod's SD card -- the browser version of tools/prep_ensoniq.py plus
// tools/gen_sd_instrument.py. Pure functions, no DOM, so they can be tested
// in Node against the Python pipeline (see tools/hwtest/test_sample_builder.js).
//
// What it does to the recording, and why:
//   - Pitch is measured, not assumed, with an octave check: a sax whose 2nd
//     harmonic is its loudest partial reads an octave high to a plain
//     autocorrelation (the EPS "Coltrane" sample did exactly that).
//   - The same recording is rendered at a root every 6 semitones with a
//     band-limited resampler, so the player never shifts more than 3
//     semitones -- stretching one recording across the keyboard with the
//     player's own interpolation aliases audibly going up. Still a pure
//     tape-speed transposition, the way the EPS did it.
//   - Lead-in silence is trimmed, an ending cut off at full level gets a
//     fade (it would otherwise click on every note), and every root shares
//     one gain so relative levels are untouched.
(function (root) {
  'use strict';

  const OUT_RATE = 48000;
  const ROOTS = [30, 36, 42, 48, 54, 60, 66, 72, 78, 84, 90];
  const MAGIC = 0x53444732;              // 'SDG2', see sd_instrument_loader.cpp
  const VERSION = 2;
  const BANK_BYTES = 30 * 1024 * 1024;   // kSdBankBytes -- the per-bank ceiling
  const TARGET_PEAK = 0.35;              // every other SD instrument's level
  const PREROLL_SEC = 0.003;

  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const noteName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

  // --- FFT (radix 2, in place) ------------------------------------------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  // --- Pitch ------------------------------------------------------------
  // One window's fundamental by autocorrelation: the SHORTEST lag whose
  // correlation is within 85% of the best. That rule never picks a
  // sub-octave, but it can pick the octave above when the 2nd harmonic
  // dominates -- which detectPitch() then checks for.
  function windowPitch(x, sr) {
    const n = x.length, N = nextPow2(2 * n);
    const re = new Float64Array(N), im = new Float64Array(N);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    for (let i = 0; i < n; i++) re[i] = x[i] - mean;
    fft(re, im);
    for (let i = 0; i < N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    fft(re, im); // power spectrum -> autocorrelation (real part, scaled by N)
    const c0 = re[0];
    if (c0 <= 0) return null;
    // Up to 4kHz: at a 1.5kHz ceiling an F#6 sat right on the edge of the
    // search and read an octave low.
    const lo = Math.max(2, Math.floor(sr / 4000)), hi = Math.min(Math.floor(sr / 40), n - 2);
    let best = lo;
    for (let l = lo; l <= hi; l++) if (re[l] > re[best]) best = l;
    const thr = 0.85 * re[best];
    let pk = best;
    for (let l = lo + 1; l < hi; l++)
      if (re[l] >= thr && re[l] > re[l - 1] && re[l] >= re[l + 1]) { pk = l; break; }
    const a = re[pk - 1], b = re[pk], c = re[pk + 1];
    const den = a - 2 * b + c;
    const frac = den !== 0 ? 0.5 * (a - c) / den : 0;
    return { freq: sr / (pk + frac), confidence: b / c0 };
  }

  // Level of the strongest spectral peak within +-3% of f, relative to the
  // loudest peak between 60Hz and 5kHz, in dB.
  function spectrumLevels(x, sr, freqs) {
    const N = Math.min(nextPow2(x.length), 65536);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < Math.min(N, x.length); i++)
      re[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    const mag = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    const bin = (f) => Math.round(f * N / sr);
    let top = 1e-12;
    for (let i = bin(60); i < Math.min(bin(5000), N / 2); i++) top = Math.max(top, mag[i]);
    return freqs.map((f) => {
      let m = 1e-12;
      for (let i = bin(f * 0.97); i <= Math.min(bin(f * 1.03), N / 2 - 1); i++) m = Math.max(m, mag[i]);
      return 20 * Math.log10(m / top);
    });
  }

  function onsetIndex(x, frac) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    const t = frac * peak;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > t) return i;
    return 0;
  }

  // Median pitch over the whole sustain, then the octave check: if there is
  // real energy both at half the frequency and at one and a half times it,
  // the fundamental is the half -- no single harmonic series on f can put
  // energy at 1.5f.
  function detectPitch(mono, sr) {
    const on = onsetIndex(mono, 0.02);
    // 0.25s windows: long enough for a steady estimate down at 65Hz.
    const win = Math.round(0.25 * sr), step = Math.round(0.25 * sr);
    const start = on + Math.round(0.3 * sr), end = mono.length - Math.round(0.4 * sr);
    let peak = 0;
    for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
    const midis = [];
    for (let s = start; s + win <= Math.max(end, start + win); s += step) {
      if (s + win > mono.length) break;
      const w = mono.subarray(s, s + win);
      // Skip windows 30dB or more under the note's peak. A silent tail --
      // a short note in a long file -- still correlates confidently with
      // itself, and enough of those outvote the note in the median.
      let e = 0;
      for (let i = 0; i < w.length; i++) e += w[i] * w[i];
      if (Math.sqrt(e / w.length) < 0.0316 * peak) { if (end <= start) break; continue; }
      const r = windowPitch(w, sr);
      if (r && r.confidence > 0.8) midis.push(hzToMidi(r.freq));
      if (end <= start) break;
    }
    if (!midis.length) {
      const s = Math.min(on + Math.round(0.05 * sr), Math.max(0, mono.length - win));
      const r = windowPitch(mono.subarray(s, Math.min(mono.length, s + win)), sr);
      if (!r) return null;
      midis.push(hzToMidi(r.freq));
    }
    midis.sort((a, b) => a - b);
    let midi = midis[Math.floor(midis.length / 2)];
    // Judged on the note itself: 0.3s in, or a fifth of the way in for a
    // note shorter than that -- a fixed 0.3s once landed past the end of a
    // short blip and compared silence with silence. Too little to judge,
    // and the estimate stands.
    const noteLen = mono.length - on;
    const segStart = on + Math.min(Math.round(0.3 * sr), Math.floor(noteLen * 0.2));
    const segLen = Math.min(Math.round(1.5 * sr), mono.length - segStart);
    const f = midiToHz(midi);
    let octaveDown = false;
    if (segLen >= Math.round(0.08 * sr)) {
      const [half, oneHalf] = spectrumLevels(mono.subarray(segStart, segStart + segLen), sr, [f / 2, f * 1.5]);
      octaveDown = half > -30 && oneHalf > -30;
    }
    if (octaveDown) midi -= 12;
    return { midi, octaveCorrected: octaveDown, windows: midis.length };
  }

  // --- Resampler --------------------------------------------------------
  // Kaiser-windowed sinc, tabulated. Reading input at step `ratio` per
  // output sample; above 1 (transposing up) the cutoff drops to 1/ratio so
  // nothing folds back as aliasing.
  const ZC = 16, PHASES = 512, BETA = 8.6;
  function besselI0(x) {
    let s = 1, t = 1;
    for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-12 * s) break; }
    return s;
  }
  const KERNEL = (() => {
    const n = ZC * PHASES + 2, k = new Float64Array(n), i0b = besselI0(BETA);
    for (let i = 0; i < n; i++) {
      const t = i / PHASES;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = t >= ZC ? 0 : besselI0(BETA * Math.sqrt(1 - (t / ZC) * (t / ZC))) / i0b;
      k[i] = sinc * w;
    }
    return k;
  })();
  function kernelAt(t) { // t >= 0, in zero crossings
    const p = t * PHASES, i = Math.floor(p);
    if (i >= ZC * PHASES) return 0;
    return KERNEL[i] + (KERNEL[i + 1] - KERNEL[i]) * (p - i);
  }
  function resample(input, ratio, outLen) {
    const out = new Float32Array(outLen);
    const fc = ratio > 1 ? 1 / ratio : 1;       // cutoff, as a fraction of input Nyquist
    const halfWidth = ZC / fc;                   // input samples either side
    const n = input.length;
    for (let o = 0; o < outLen; o++) {
      const centre = o * ratio;
      if (centre - halfWidth >= n) break;        // past the end: silence
      const k0 = Math.max(0, Math.ceil(centre - halfWidth));
      const k1 = Math.min(n - 1, Math.floor(centre + halfWidth));
      let acc = 0;
      for (let k = k0; k <= k1; k++) acc += input[k] * kernelAt(Math.abs(centre - k) * fc);
      out[o] = acc * fc;
    }
    return out;
  }

  // --- Analysis a user sees before building ----------------------------
  function analyse(channels, sr) {
    const n = channels[0].length;
    const mono = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
    const pitch = detectPitch(mono, sr);
    let corr = 1;
    if (channels.length > 1) {
      let sl = 0, sr2 = 0, slr = 0;
      const L = channels[0], R = channels[1];
      for (let i = 0; i < n; i++) { sl += L[i] * L[i]; sr2 += R[i] * R[i]; slr += L[i] * R[i]; }
      corr = slr / Math.sqrt(sl * sr2 + 1e-20);
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
    const tail = Math.round(0.02 * sr);
    let tailRms = 0;
    for (let i = n - tail; i < n; i++) tailRms += mono[i] * mono[i];
    tailRms = Math.sqrt(tailRms / tail);
    return {
      pitch,                                       // {midi, octaveCorrected} or null
      seconds: n / sr,
      stereoCorrelation: corr,
      // Near-identical channels (the EPS sources ran 0.976-0.996) are mono
      // with a little room on them; summing halves the file and doubles how
      // long a held note lasts. A real stereo chorus sits far lower (0.2).
      suggestMono: channels.length === 1 || corr > 0.95,
      endsAbruptly: 20 * Math.log10(tailRms / (peak + 1e-12) + 1e-12) > -40,
    };
  }

  // --- Build ------------------------------------------------------------
  // channels: Float32Arrays at `sr`. opts: {sourceMidi (fractional, the
  // note as it actually sounds), stereo}. Returns {buffer, info}.
  function build(channels, sr, opts) {
    const srcMidi = opts.sourceMidi;
    let chs = channels;
    if (!opts.stereo || channels.length === 1) {
      const n = channels[0].length, m = new Float32Array(n);
      for (const ch of channels) for (let i = 0; i < n; i++) m[i] += ch[i] / channels.length;
      chs = [m];
    } else {
      chs = channels.slice(0, 2);
    }
    const nch = chs.length;

    // Trim the lead-in, keeping a sliver so the attack isn't clipped.
    let on = Infinity;
    for (const ch of chs) on = Math.min(on, onsetIndex(ch, 0.02));
    const start = Math.max(0, on - Math.round(PREROLL_SEC * sr));
    chs = chs.map((ch) => ch.slice(start));
    const len = chs[0].length;

    // Fade the end: long if it was cut off at level, a token one otherwise.
    const info0 = analyse(chs, sr);
    const fadeSec = info0.endsAbruptly ? 0.4 : 0.05;
    const fadeN = Math.min(len, Math.round(fadeSec * sr));
    for (const ch of chs)
      for (let i = 0; i < fadeN; i++)
        ch[len - fadeN + i] *= 0.5 + 0.5 * Math.cos(Math.PI * i / fadeN);

    // Every root is padded or trimmed to one length: what fits 11 roots in
    // the bank, and no more than twice the source (two octaves down it runs
    // four times as long; that far down isn't worth the card space).
    const headerBytes = 28 + 4 * ROOTS.length;
    const budgetSec = Math.floor(((BANK_BYTES - headerBytes) / (ROOTS.length * OUT_RATE * 4 * nch)) * 100) / 100;
    const sourceSec = len / sr;
    const groupSec = Math.min(budgetSec, Math.max(1, 2 * sourceSec));
    const groupLength = Math.round(groupSec * OUT_RATE);

    const renders = ROOTS.map((r) => {
      const ratio = Math.pow(2, (r - srcMidi) / 12) * (sr / OUT_RATE);
      return chs.map((ch) => resample(ch, ratio, groupLength));
    });

    let peak = 1e-12;
    for (const g of renders) for (const ch of g) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    const gain = TARGET_PEAK / peak;

    const total = headerBytes + ROOTS.length * groupLength * nch * 4;
    const buf = new ArrayBuffer(total), dv = new DataView(buf);
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, VERSION, true);
    dv.setUint32(8, OUT_RATE, true); dv.setUint32(12, nch, true);
    dv.setInt32(16, ROOTS.length, true); dv.setInt32(20, 1, true);
    dv.setInt32(24, groupLength, true);
    ROOTS.forEach((r, i) => dv.setInt32(28 + 4 * i, r, true));
    const pcm = new Float32Array(buf, headerBytes);
    let w = 0;
    for (const g of renders)                      // group-major, frames interleaved
      for (let i = 0; i < groupLength; i++)
        for (let c = 0; c < nch; c++) pcm[w++] = g[c][i] * gain;

    return {
      buffer: buf,
      info: { channels: nch, groupSeconds: groupSec, sourceSeconds: sourceSec,
              bytes: total, fadeSeconds: fadeSec, gain, roots: ROOTS.slice() },
    };
  }

  // One root's audio back out of a built file: [Float32Array per channel].
  function extractGroup(buffer, groupIndex) {
    const dv = new DataView(buffer);
    const nch = dv.getUint32(12, true), groups = dv.getInt32(16, true);
    const glen = dv.getInt32(24, true);
    const pcm = new Float32Array(buffer, 28 + 4 * groups);
    const out = [];
    for (let c = 0; c < nch; c++) {
      const ch = new Float32Array(glen);
      for (let i = 0; i < glen; i++) ch[i] = pcm[(groupIndex * glen + i) * nch + c];
      out.push(ch);
    }
    return out;
  }

  const api = { build, analyse, detectPitch, resample, extractGroup, noteName, midiToHz, hzToMidi,
                ROOTS, OUT_RATE, BANK_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SampleBuilder = api;
})(typeof window !== 'undefined' ? window : this);
