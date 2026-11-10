// Local dictation: whisper.cpp runs on this machine, and its binary and model download on first use (Test 8).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);
// Pinned to the build Test 8 measured; each file is checked against its size and SHA-256 before use.
const RELEASE = { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip', size: 8928640, sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' };
const MODELS = {
  small: { size: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
  medium: { size: 1533763059, sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208' },
  'large-v3': { size: 3095033483, sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2' },
};
const modelUrl = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
const LANGUAGES = new Set(['es', 'en', 'auto']);
// Ten minutes of 16 kHz mono 16-bit audio plus its header.
const MAX_AUDIO = 16000 * 2 * 600 + 44;
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
// More threads barely helped past 12 in Test 8.
const THREADS = Math.min(12, os.availableParallelism());

async function download(url, file, { size, sha256 }, onBytes) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`The download failed (${response.status}).`);
  const part = `${file}.part`;
  const out = fs.createWriteStream(part);
  const hash = crypto.createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      onBytes(chunk.length);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw error;
  }
  if (received !== size || hash.digest('hex') !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error('The download did not match its checksum.');
  }
  fs.renameSync(part, file);
}

function createVoice(dir) {
  const binDir = path.join(dir, 'bin');
  const cli = path.join(binDir, 'Release', 'whisper-cli.exe');
  const modelFile = (name) => path.join(dir, `ggml-${name}.bin`);
  let preparing = null;

  function status(model) {
    if (!MODELS[model]) return { error: 'Unknown voice model.' };
    const hasCli = fs.existsSync(cli);
    const hasModel = fs.existsSync(modelFile(model));
    return { needs: (hasCli ? 0 : RELEASE.size) + (hasModel ? 0 : MODELS[model].size), cli: hasCli, model: hasModel };
  }

  // One download at a time: a second click waits on the first.
  function prepare(model, onProgress) {
    if (preparing) return preparing;
    const { needs, error } = status(model);
    if (error) return Promise.reject(new Error(error));
    let received = 0;
    const onBytes = (bytes) => onProgress((received += bytes), needs);
    preparing = (async () => {
      fs.mkdirSync(binDir, { recursive: true });
      if (!fs.existsSync(cli)) {
        const zip = path.join(dir, 'whisper-bin-x64.zip');
        await download(RELEASE.url, zip, RELEASE, onBytes);
        try {
          await run(TAR, ['-xf', zip, '-C', binDir], { windowsHide: true });
        } finally {
          fs.rmSync(zip, { force: true });
        }
        if (!fs.existsSync(cli)) throw new Error('whisper-cli.exe was not in the download.');
      }
      if (!fs.existsSync(modelFile(model))) await download(modelUrl(model), modelFile(model), MODELS[model], onBytes);
    })().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function transcribe(audio, model, language) {
    const wav = Buffer.from(audio);
    if (wav.length <= 44 || wav.length > MAX_AUDIO || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') throw new Error('The recording is not valid audio.');
    if (!MODELS[model] || !LANGUAGES.has(language)) throw new Error('Unknown voice model or language.');
    if (!fs.existsSync(cli) || !fs.existsSync(modelFile(model))) throw new Error('The voice model is not downloaded.');
    const file = path.join(os.tmpdir(), `frugal-deck-${crypto.randomUUID()}.wav`);
    fs.writeFileSync(file, wav);
    try {
      // -nt and -np leave only the text on stdout.
      const { stdout } = await run(cli, ['-m', modelFile(model), '-f', file, '-l', language, '-t', String(THREADS), '-nt', '-np'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
      return stdout.replace(/\s+/g, ' ').trim();
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  return { status, prepare, transcribe };
}

module.exports = { createVoice };
