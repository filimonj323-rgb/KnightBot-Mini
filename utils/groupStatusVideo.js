/**
 * Group Status Video Splitter
 * Video ikizidi urefu unaoruhusiwa kwenye status, inakatwa automatically
 * kuwa vipande (kila kimoja <= GROUPSTATUS_MAX_SECONDS) na vipande vyote
 * vinatumwa kwa mfuatano kwenye group moja (Sehemu 1/3, 2/3, 3/3).
 *
 * Inatumika na:
 *  - commands/admin/groupstatus.js   (.groupstatus)
 *  - commands/owner/groupmanager.js  (.gm groupstatus)
 *  - pairing/instanceManager.js      (dashboard ya mteja + admin dashboard)
 *
 * Env vars (hiari):
 *  GROUPSTATUS_MAX_SECONDS  urefu wa kila kipande, default 60
 *  GROUPSTATUS_MAX_PARTS    idadi ya juu ya vipande, default 20 (kinga ya spam)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
if (!process.env.FFMPEG_PATH) {
  try {
    const p = require('ffmpeg-static');
    if (p) ffmpegBin = p;
  } catch { /* tumia ffmpeg ya system */ }
}

const MAX_SECONDS = Math.max(5, Number(process.env.GROUPSTATUS_MAX_SECONDS) || 90);
const MAX_PARTS = Math.max(1, Number(process.env.GROUPSTATUS_MAX_PARTS) || 20);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// buffer -> Map<maxSeconds, Promise<Buffer[]>>
// Buffer ile ile ikitumwa kwa groups nyingi, ffmpeg inaendeshwa MARA MOJA tu.
const cache = new WeakMap();

function getDurationSeconds(file) {
  return new Promise((resolve) => {
    execFile(ffmpegBin, ['-hide_banner', '-i', file], { timeout: 60000 }, (_err, _out, stderr) => {
      // ffmpeg inatoka na error code 1 kwa kuwa hakuna output file — ni kawaida.
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''));
      if (!m) return resolve(0);
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

async function doSplit(buffer, maxSeconds) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-gsplit-'));
  try {
    const inPath = path.join(tmpDir, 'in.vid');
    fs.writeFileSync(inPath, buffer);

    const duration = await getDurationSeconds(inPath);
    // Haijulikani urefu, au ni ndani ya kikomo -> tuma kama ilivyo (hakuna re-encode)
    if (!duration || duration <= maxSeconds + 1) return [buffer];

    const total = Math.ceil(duration / maxSeconds);
    if (total > MAX_PARTS) {
      throw new Error(
        `Video ni ndefu mno (sekunde ${Math.round(duration)} = vipande ${total}). ` +
        `Kiwango cha juu ni vipande ${MAX_PARTS} (sekunde ${MAX_PARTS * maxSeconds}).`
      );
    }

    const pattern = path.join(tmpDir, 'part_%03d.mp4');
    // Hakuna maandishi ya stderr kwenye kosa la awali => ffmpeg iliuawa (SIGKILL/OOM),
    // kwa kawaida kwa sababu ilitumia threads nyingi (default = cores zote za host ya
    // Railway) na kuzidi kikomo cha memory ya container. Hapa tunazuia threads/lookahead,
    // na tukishindwa tunajaribu mara ya pili kwa mipangilio myepesi zaidi.
    const makeArgs = (o) => [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-threads', String(o.threads),
      '-i', inPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      // Punguza ukubwa: upande mrefu zaidi usizidi o.maxSide px
      '-vf', `scale='if(gt(iw,ih),min(${o.maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${o.maxSide},ih))'`,
      '-threads', String(o.threads),
      '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p',
      '-x264-params', `threads=${o.threads}:lookahead-threads=1:rc-lookahead=${o.lookahead}`,
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      // Keyframe kila mwanzo wa kipande ili kukata kuwe sahihi
      '-force_key_frames', `expr:gte(t,n_forced*${maxSeconds})`,
      '-f', 'segment', '-segment_time', String(maxSeconds),
      '-reset_timestamps', '1',
      '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+faststart',
      pattern,
    ];

    const runFfmpeg = (args) => new Promise((resolve, reject) => {
      execFile(ffmpegBin, args, { timeout: 15 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, _o, stderr) => {
        if (!err) return resolve();
        const detail = String(stderr || '').trim().slice(-300);
        const sig = err.signal ? ` [signal: ${err.signal}${err.signal === 'SIGKILL' ? ' — inaonekana memory ya server haitoshi' : ''}]` : '';
        reject(new Error('ffmpeg imeshindwa kukata video: ' + (detail || String(err.message).split('\n')[0].slice(0, 120)) + sig));
      });
    });

    const attempts = [
      { threads: 2, preset: 'veryfast',  crf: 27, maxSide: 1280, lookahead: 10 },
      { threads: 1, preset: 'ultrafast', crf: 30, maxSide: 720,  lookahead: 0  },
    ];
    let lastErr = null;
    for (const o of attempts) {
      // Futa vipande vya jaribio lililopita
      for (const f of fs.readdirSync(tmpDir)) {
        if (/^part_/.test(f)) fs.rmSync(path.join(tmpDir, f), { force: true });
      }
      try {
        await runFfmpeg(makeArgs(o));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.error('[groupStatusVideo]', e.message, '| mipangilio:', JSON.stringify(o));
      }
    }
    if (lastErr) throw lastErr;

    const files = fs.readdirSync(tmpDir).filter((f) => /^part_\d+\.mp4$/.test(f)).sort();
    const parts = files.map((f) => fs.readFileSync(path.join(tmpDir, f))).filter((b) => b.length > 0);
    if (!parts.length) throw new Error('Kukata video kumeshindwa (hakuna vipande vilivyotoka).');
    return parts;
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

/**
 * Rudisha vipande vya video (Buffer[]). Kama video haizidi kikomo,
 * inarudisha [buffer] ileile bila kuibadilisha.
 */
function splitVideoForStatus(buffer, maxSeconds = MAX_SECONDS) {
  let byLen = cache.get(buffer);
  if (!byLen) {
    byLen = new Map();
    cache.set(buffer, byLen);
  }
  if (!byLen.has(maxSeconds)) {
    const p = doSplit(buffer, maxSeconds);
    byLen.set(maxSeconds, p);
    p.catch(() => byLen.delete(maxSeconds)); // usihifadhi failure
  }
  return byLen.get(maxSeconds);
}

function withPartLabel(caption, i, n) {
  const label = `📹 Sehemu ${i}/${n}`;
  return caption ? `${caption}\n\n${label}` : label;
}

/**
 * Tuma group status kwenye group MOJA. Kama payload ina `video` (Buffer)
 * inayozidi kikomo, inakatwa na vipande vinatumwa kwa mfuatano.
 * Payload nyingine (text/image/audio) zinatumwa kama kawaida.
 * Payload iwe na groupStatus:true.
 * @returns {Promise<{parts:number}>}
 */
async function sendGroupStatus(sock, jid, payload, { maxSeconds = MAX_SECONDS, gapMs = 2500 } = {}) {
  if (!Buffer.isBuffer(payload.video)) {
    await sock.sendMessage(jid, { ...payload });
    return { parts: 1 };
  }

  const parts = await splitVideoForStatus(payload.video, maxSeconds);
  for (let i = 0; i < parts.length; i++) {
    // Nakala MPYA kwa kila send — Baileys inabadilisha content object.
    const p = { ...payload, video: parts[i] };
    if (parts.length > 1) p.caption = withPartLabel(payload.caption, i + 1, parts.length);
    await sock.sendMessage(jid, p);
    if (i < parts.length - 1) await sleep(gapMs);
  }
  return { parts: parts.length };
}

module.exports = { sendGroupStatus, splitVideoForStatus, MAX_SECONDS, MAX_PARTS };
