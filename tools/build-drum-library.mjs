import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...parts) => path.join(repo, '.tooling', 'sample-sources', ...parts);

const samples = [
  ['tr808_kick', 'TR-808', '底鼓', 'Kick', source('0x808', 'samples', '808', '01.BD.808.wav'), '0x808', 'CC0 / royalty-free'],
  ['tr808_snare', 'TR-808', '军鼓', 'Snare', source('0x808', 'samples', '808', '01.SD5.808.wav'), '0x808', 'CC0 / royalty-free'],
  ['tr808_hat', 'TR-808', '踩镲', 'Hi-hat', source('0x808', 'samples', '808', '01.CH.808.wav'), '0x808', 'CC0 / royalty-free'],
  ['tr909_kick', 'TR-909', '底鼓', 'Kick', source('0x808', 'samples', '909', 'kick.wav'), '0x808 / Oramics', 'Public Domain'],
  ['tr909_snare', 'TR-909', '军鼓', 'Snare', source('0x808', 'samples', '909', 'snare-short.wav'), '0x808 / Oramics', 'Public Domain'],
  ['tr909_hat', 'TR-909', '踩镲', 'Hi-hat', source('0x808', 'samples', '909', 'hihat-closed-1.wav'), '0x808 / Oramics', 'Public Domain'],
  ['tr606_kick', 'TR-606 / RD-6', '底鼓', 'Kick', source('mck', 'RD6', 'BD', '001.wav'), 'MckSamplePacks', 'CC0-1.0'],
  ['tr606_snare', 'TR-606 / RD-6', '军鼓', 'Snare', source('mck', 'RD6', 'SD', '001.wav'), 'MckSamplePacks', 'CC0-1.0'],
  ['tr606_hat', 'TR-606 / RD-6', '踩镲', 'Hi-hat', source('mck', 'RD6', 'HATS', '001.wav'), 'MckSamplePacks', 'CC0-1.0'],
  ['acoustic_kick', '原声鼓', '底鼓', 'Kick', source('stargate', 'stargate-sample-pack', 'sgossner', 'VCSL', 'Membranophones', 'Bass Drum 1', 'BDrumNew_hit_v5_rr1_Sum.wav'), 'VCSL via Stargate', 'CC0-1.0'],
  ['acoustic_snare', '原声鼓', '军鼓', 'Snare', source('stargate', 'stargate-sample-pack', 'sgossner', 'VCSL', 'Membranophones', 'Snare Drum, Modern 3', 'Snare4_HitSN_v4_rr1_Mid.wav'), 'VCSL via Stargate', 'CC0-1.0'],
  ['acoustic_hat', '原声鼓', '踩镲', 'Hi-hat', source('stargate', 'stargate-sample-pack', 'stargate', 'hats', 'hat-1.wav'), 'Stargate Sample Pack', 'CC0-1.0'],
  ['trap_kick', 'Trap', '底鼓', 'Kick', source('free-drum-samples', 'drum-samples', '01-hard-trap', 'kicks', 'hard-kick-01.wav'), 'Free Drum Samples', 'CC0-1.0'],
  ['trap_snare', 'Trap', '军鼓', 'Snare', source('free-drum-samples', 'drum-samples', '01-hard-trap', 'snares', 'hard-snare-01.wav'), 'Free Drum Samples', 'CC0-1.0'],
  ['trap_hat', 'Trap', '踩镲', 'Hi-hat', source('free-drum-samples', 'drum-samples', '01-hard-trap', 'hi-hats', 'hi-hat-closed-01.wav'), 'Free Drum Samples', 'CC0-1.0'],
  ['boombap_kick', 'Boom-Bap', '底鼓', 'Kick', source('free-drum-samples', 'drum-samples', '03-soulful-vintage', 'kicks', 'vintage-kick-03.wav'), 'Free Drum Samples', 'CC0-1.0'],
  ['boombap_snare', 'Boom-Bap', '军鼓', 'Snare', source('free-drum-samples', 'drum-samples', '03-soulful-vintage', 'snares', 'vintage-snare-01.wav'), 'Free Drum Samples', 'CC0-1.0'],
  ['boombap_clap', 'Boom-Bap', '拍手', 'Clap', source('free-drum-samples', 'drum-samples', '03-soulful-vintage', 'claps', 'vintage-clap-01.wav'), 'Free Drum Samples', 'CC0-1.0'],
  ['lofi_kick', 'Lo-fi', '底鼓', 'Kick', source('free-drum-samples', 'drum-samples', '03-soulful-vintage', 'kicks', 'vintage-kick-02.wav'), 'Free Drum Samples', 'CC0-1.0'],
  ['lofi_snare', 'Lo-fi', '军鼓', 'Snare', source('free-drum-samples', 'drum-samples', '03-soulful-vintage', 'snares', 'vintage-snare-02.wav'), 'Free Drum Samples', 'CC0-1.0'],
  ['lofi_hat', 'Lo-fi', '踩镲', 'Hi-hat', source('free-drum-samples', 'drum-samples', '03-soulful-vintage', 'hi-hats', 'hi-hat-closed-01.wav'), 'Free Drum Samples', 'CC0-1.0'],
];

function readPcm(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let offset = 12;
  let fmt;
  let data;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') fmt = {
      format: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2),
      rate: buffer.readUInt32LE(start + 4), bits: buffer.readUInt16LE(start + 14),
    };
    if (id === 'data') data = buffer.subarray(start, Math.min(buffer.length, start + size));
    offset = start + size + (size & 1);
  }
  if (!fmt || !data || (fmt.format !== 1 && fmt.format !== 3)) throw new Error('Unsupported WAV encoding');
  const bytes = fmt.bits >> 3;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let value = 0;
    for (let channel = 0; channel < fmt.channels; channel++) {
      const at = (frame * fmt.channels + channel) * bytes;
      if (fmt.format === 3 && fmt.bits === 32) value += data.readFloatLE(at);
      else if (fmt.bits === 16) value += data.readInt16LE(at) / 32768;
      else if (fmt.bits === 24) value += data.readIntLE(at, 3) / 8388608;
      else if (fmt.bits === 32) value += data.readInt32LE(at) / 2147483648;
      else throw new Error(`Unsupported PCM depth: ${fmt.bits}`);
    }
    mono[frame] = value / fmt.channels;
  }
  return { mono, ...fmt };
}

function waveformOf(mono) {
  const points = [];
  let maximum = 0;
  for (let i = 0; i < 256; i++) {
    const from = Math.floor(i * mono.length / 256);
    const to = Math.max(from + 1, Math.floor((i + 1) * mono.length / 256));
    let peak = 0;
    for (let j = from; j < Math.min(to, mono.length); j++) if (Math.abs(mono[j]) > Math.abs(peak)) peak = mono[j];
    points.push(peak);
    maximum = Math.max(maximum, Math.abs(peak));
  }
  return points.map((value) => Number((maximum > 0 ? value / maximum : 0).toFixed(4)));
}

const assetDir = path.join(repo, 'native', 'engine', 'android', 'app', 'drum-assets', 'drums');
fs.mkdirSync(assetDir, { recursive: true });
const definitions = [];
const credits = [];
for (const [id, group, label, englishLabel, sourcePath, provider, license] of samples) {
  if (!fs.existsSync(sourcePath)) throw new Error(`Missing source sample: ${sourcePath}`);
  const target = path.join(assetDir, `${id}.wav`);
  fs.copyFileSync(sourcePath, target);
  const decoded = readPcm(fs.readFileSync(sourcePath));
  definitions.push({
    id, group, label: `${group} · ${label}`, englishLabel: `${group} · ${englishLabel}`,
    desc: `${group} ${label}单击采样；左轴调音量、下轴调速度，可继续串联该 RGB 通道的效果器。`,
    englishDesc: `${group} ${englishLabel} one-shot. Use the left axis for level, the bottom axis for speed, and the RGB effect slots for further shaping.`,
    waveform: waveformOf(decoded.mono),
  });
  credits.push(`| \`${id}\` | ${provider} | ${license} | \`${path.relative(repo, sourcePath).replaceAll('\\', '/')}\` |`);
}

const generated = `/** Generated by tools/build-drum-library.mjs. Do not edit by hand. */\n` +
`export interface DrumPresetDef { id: string; group: string; label: string; englishLabel: string; desc: string; englishDesc: string; waveform: number[]; }\n` +
`export const DRUM_NONE_ID = 'none';\nexport const DRUM_CUSTOM_ID = 'custom';\n` +
`export const DRUM_PRESETS: DrumPresetDef[] = ${JSON.stringify(definitions)};\n` +
`export function drumPresetOf(id: string): DrumPresetDef | undefined { return DRUM_PRESETS.find((item) => item.id === id); }\n`;
fs.writeFileSync(path.join(repo, 'assets', 'scripts', 'DrumLibrary.ts'), generated);

const notice = `# Third-Party Drum Samples\n\nAll WAV files bundled in \`native/engine/android/app/drum-assets/drums\` permit redistribution. Brand and model names describe the source or style only and do not imply endorsement.\n\n| Asset ID | Source | License | Original file |\n|---|---|---|---|\n${credits.join('\n')}\n\nSources:\n\n- https://github.com/averagenative/0x808\n- https://github.com/MckAudio/MckSamplePacks\n- https://github.com/stargatedaw/stargate-sample-pack\n- https://github.com/Boochi44/free-drum-samples\n`;
fs.writeFileSync(path.join(repo, 'THIRD_PARTY_DRUM_SAMPLES.md'), notice);
console.log(`Generated ${definitions.length} drum samples in ${assetDir}`);
