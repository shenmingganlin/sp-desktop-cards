// chime.js — 番茄钟的提示音，用 WebAudio 现场合成，不带音频文件。卡片和设置窗口（试听）共用。
// work：专注结束，三个音往上走；break：休息结束，两个音往下落，听着就知道是哪种。
"use strict";

const Chime = (() => {
  const NOTES = {
    work: [[659.25, 0], [783.99, 0.16], [1046.5, 0.32]], // E5 G5 C6
    break: [[880, 0], [659.25, 0.2]], // A5 E5
  };
  let ctx = null;

  /** 一个带自然衰减的音：正弦波加一点高八度，听起来像小钟。 */
  function bell(at, freq, gain) {
    for (const [mult, level] of [[1, 1], [2, 0.18]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq * mult;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain * level, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
      osc.connect(g).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 1.15);
    }
  }

  async function play(kind = "work") {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    const t = ctx.currentTime + 0.05;
    // 响两遍，第一遍没注意到还有第二遍
    for (const round of [0, 1.4]) {
      for (const [freq, offset] of NOTES[kind] || NOTES.work) bell(t + round + offset, freq, 0.22);
    }
  }

  return { play };
})();
