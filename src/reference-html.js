"use strict";

// 移植自 PelicanBench src/content/reference-html.ts
// 手写的高质量参考动画：多套配色、IK 两段式腿、counter-rotate 踏板、辐条车轮。
// 作为画廊中的「视觉基准」对照行，非模型成绩。

const palettes = [
  {
    id: "ref-coast",
    title: "海岸晨骑",
    model: "视觉基准 · 海岸",
    note: "非模型生成。用来对照喙、喉囊、车轮、车架和踩踏是否完整，不代表任何模型的成绩。",
    sky0: "#8ED4EA",
    sky1: "#F4FBF6",
    sun: "#FFE08A",
    hillFar: "#D7EFE4",
    hillNear: "#B7DCCB",
    ground: "#E7F6EE",
    road: "#D5E3DC",
    roadLine: "#FFFFFF",
    ink: "#1C3D3A",
    frame: "#1C3D3A",
    body: "#FFF8F1",
    wing: "#F3E4D0",
    beak: "#F09A3E",
    pouch: "#F6C48A",
    accent: "#F2C14E",
    night: false,
  },
  {
    id: "ref-dusk",
    title: "黄昏回程",
    model: "视觉基准 · 黄昏",
    note: "非模型生成的第二套配色基准。结构与海岸样本相同，用来看模型是否只会堆颜色、却画不清结构。",
    sky0: "#F6A57A",
    sky1: "#6D5A86",
    sun: "#FF7A59",
    hillFar: "#C98B9A",
    hillNear: "#8C6280",
    ground: "#E8C3B0",
    road: "#C9A090",
    roadLine: "#FFF1E4",
    ink: "#3A2344",
    frame: "#3A2344",
    body: "#FFF8F2",
    wing: "#F0D2C0",
    beak: "#E25B2A",
    pouch: "#F0A07A",
    accent: "#FFD27A",
    night: false,
  },
  {
    id: "ref-night",
    title: "夜路",
    model: "视觉基准 · 夜路",
    note: "非模型生成。深色背景仍应能分清主体层次。若模型把轮子融进身体，对照这里会很明显。",
    sky0: "#1A2744",
    sky1: "#0C1424",
    sun: "#F6F1D8",
    hillFar: "#24344F",
    hillNear: "#1A283C",
    ground: "#152033",
    road: "#2C3C52",
    roadLine: "#9EC3D4",
    ink: "#2A211C",
    frame: "#E7EEF4",
    body: "#F7F3EA",
    wing: "#E7D3BE",
    beak: "#F0A04A",
    pouch: "#E8B98A",
    accent: "#F2C14E",
    night: true,
  },
];

function wheel(cx, cy, frame, accent) {
  return `<g transform="translate(${cx},${cy})">
    <circle r="64" fill="none" stroke="${frame}" stroke-width="8"/>
    <circle r="50" fill="none" stroke="${frame}" stroke-width="2" opacity="0.4"/>
    <g>
      <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="0.9s" repeatCount="indefinite"/>
      <g stroke="${frame}" stroke-width="2.2" stroke-linecap="round">
        <line y1="-48" y2="48"/>
        <line x1="-48" x2="48"/>
        <line x1="-34" y1="-34" x2="34" y2="34"/>
        <line x1="-34" y1="34" x2="34" y2="-34"/>
      </g>
    </g>
    <circle r="8" fill="${accent}" stroke="${frame}" stroke-width="2"/>
  </g>`;
}

function cloud(x, y) {
  return `<g fill="#ffffff" opacity="0.88">
    <ellipse cx="${x}" cy="${y}" rx="48" ry="18"/>
    <ellipse cx="${x - 28}" cy="${y + 6}" rx="26" ry="15"/>
    <ellipse cx="${x + 30}" cy="${y + 5}" rx="30" ry="16"/>
  </g>`;
}

function buildReferenceHtml(p) {
  const bb = { x: 528, y: 498 };
  const radius = 30;
  const xs1 = [];
  const ys1 = [];
  const xs2 = [];
  const ys2 = [];
  for (let i = 0; i <= 8; i += 1) {
    const angle = ((i % 8) / 8) * Math.PI * 2;
    xs1.push(Math.round(bb.x + Math.cos(angle) * radius));
    ys1.push(Math.round(bb.y + Math.sin(angle) * radius));
    xs2.push(Math.round(bb.x + Math.cos(angle + Math.PI) * radius));
    ys2.push(Math.round(bb.y + Math.sin(angle + Math.PI) * radius));
  }
  const hip1 = { x: 486, y: 402 };
  const hip2 = { x: 524, y: 406 };
  const bend = (hip, xs, ys, sign) => {
    const kx = [];
    const ky = [];
    for (let i = 0; i < xs.length; i += 1) {
      const mx = (hip.x + xs[i]) / 2;
      const my = (hip.y + ys[i]) / 2;
      const dx = xs[i] - hip.x;
      const dy = ys[i] - hip.y;
      const len = Math.hypot(dx, dy) || 1;
      kx.push(Math.round(mx + (-dy / len) * 18 * sign));
      ky.push(Math.round(my + (dx / len) * 18 * sign));
    }
    return { kx, ky };
  };
  const k1 = bend(hip1, xs1, ys1, 1);
  const k2 = bend(hip2, xs2, ys2, 1);
  const points = (hip, kx, ky, xs, ys) =>
    xs.map((_, i) => `${hip.x},${hip.y} ${kx[i]},${ky[i]} ${xs[i]},${ys[i]}`).join(";");
  const sky = p.night
    ? `<circle cx="168" cy="104" r="34" fill="${p.sun}"/>
       <circle cx="156" cy="94" r="6" fill="#E6DDB8" opacity="0.8"/>
       <circle cx="182" cy="114" r="4" fill="#E6DDB8" opacity="0.75"/>
       <g fill="#F7F3E4">
         <circle cx="80" cy="70" r="1.5"><animate attributeName="opacity" values="0.2;1;0.2" dur="2.8s" repeatCount="indefinite"/></circle>
         <circle cx="240" cy="48" r="1.3"><animate attributeName="opacity" values="1;0.2;1" dur="3.4s" repeatCount="indefinite"/></circle>
         <circle cx="420" cy="86" r="1.6"><animate attributeName="opacity" values="0.3;1;0.3" dur="2.4s" repeatCount="indefinite"/></circle>
         <circle cx="860" cy="54" r="1.4"><animate attributeName="opacity" values="0.4;1;0.4" dur="3.1s" repeatCount="indefinite"/></circle>
         <circle cx="1040" cy="92" r="1.7"><animate attributeName="opacity" values="1;0.25;1" dur="2.6s" repeatCount="indefinite"/></circle>
         <circle cx="980" cy="40" r="1.2"><animate attributeName="opacity" values="0.2;0.9;0.2" dur="4s" repeatCount="indefinite"/></circle>
       </g>`
    : `<g>
         <circle cx="${p.id === "dusk" ? 210 : 1030}" cy="${p.id === "dusk" ? 210 : 108}" r="70" fill="${p.sun}" opacity="0.28">
           <animate attributeName="r" values="62;74;62" dur="6s" repeatCount="indefinite"/>
         </circle>
         <circle cx="${p.id === "dusk" ? 210 : 1030}" cy="${p.id === "dusk" ? 210 : 108}" r="40" fill="${p.sun}"/>
       </g>
       <g>
         <animateTransform attributeName="transform" type="translate" from="0 0" to="-1200 0" dur="42s" repeatCount="indefinite"/>
         ${cloud(180, 120)}${cloud(560, 78)}${cloud(900, 140)}
         ${cloud(1380, 120)}${cloud(1760, 78)}${cloud(2100, 140)}
       </g>`;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title}</title>
<style>html,body{margin:0;height:100%;background:${p.sky1}}svg{width:100%;height:100%;display:block}</style>
</head>
<body>
<svg viewBox="0 0 1200 680" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${p.title}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.sky0}"/>
      <stop offset="1" stop-color="${p.sky1}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="680" fill="url(#sky)"/>
  ${sky}
  <path d="M0 520 C 180 450, 340 500, 520 462 C 700 424, 860 490, 1040 446 C 1120 428, 1160 450, 1200 438 L 1200 572 L 0 572 Z" fill="${p.hillFar}"/>
  <path d="M0 572 C 160 528, 300 556, 470 538 C 660 516, 820 560, 980 532 C 1080 518, 1140 546, 1200 528 L 1200 590 L 0 590 Z" fill="${p.hillNear}"/>
  <rect y="560" width="1200" height="120" fill="${p.ground}"/>
  <rect y="560" width="1200" height="34" fill="${p.road}"/>
  <line x1="0" y1="577" x2="1200" y2="577" stroke="${p.roadLine}" stroke-width="3" stroke-dasharray="26 22" stroke-linecap="round" opacity="0.9">
    <animate attributeName="stroke-dashoffset" from="0" to="-96" dur="0.9s" repeatCount="indefinite"/>
  </line>
  <ellipse cx="555" cy="568" rx="168" ry="10" fill="#000" opacity="0.12">
    <animate attributeName="rx" values="168;154;168;176;168" dur="1.2s" repeatCount="indefinite"/>
  </ellipse>
  <g>
    <animateTransform attributeName="transform" type="translate" values="0 0; 0 -6; 0 0; 0 4; 0 0" dur="1.2s" repeatCount="indefinite"/>
    ${wheel(392, 498, p.frame, p.accent)}
    ${wheel(708, 498, p.frame, p.accent)}
    <g fill="none" stroke="${p.frame}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M392 498 L528 498"/>
      <path d="M392 498 L452 368"/>
      <path d="M528 498 L452 368"/>
      <path d="M528 498 L648 368"/>
      <path d="M452 368 L648 368"/>
      <path d="M648 368 L708 498"/>
    </g>
    <path d="M430 352 h58 a10 10 0 0 1 0 16 h-58 a8 8 0 0 1 0 -16z" fill="${p.frame}"/>
    <path d="M648 368 L676 332" stroke="${p.frame}" stroke-width="7" stroke-linecap="round"/>
    <path d="M664 324 Q684 308 706 322" fill="none" stroke="${p.frame}" stroke-width="7" stroke-linecap="round"/>
    <circle cx="706" cy="322" r="5" fill="${p.accent}"/>
    <circle cx="528" cy="498" r="18" fill="none" stroke="${p.frame}" stroke-width="4"/>
    <g fill="${p.body}" stroke="${p.ink}" stroke-width="3" stroke-linejoin="round">
      <path d="M408 334 L344 308 L398 348 Z"/>
      <path d="M410 350 L332 352 L400 370 Z"/>
      <path d="M412 368 L352 392 L404 388 Z"/>
    </g>
    <ellipse cx="500" cy="352" rx="104" ry="56" fill="${p.body}" stroke="${p.ink}" stroke-width="3"/>
    <g>
      <animateTransform attributeName="transform" type="rotate" values="-8 470 340; 16 470 340; -8 470 340" dur="1.35s" repeatCount="indefinite"/>
      <path d="M478 338 C 430 292, 360 308, 348 352 C 392 372, 452 366, 512 344 Z" fill="${p.wing}" stroke="${p.ink}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M430 328 C 404 342, 396 354, 418 360" fill="none" stroke="${p.ink}" stroke-width="1.6" opacity="0.45"/>
      <path d="M454 322 C 428 340, 420 354, 446 360" fill="none" stroke="${p.ink}" stroke-width="1.6" opacity="0.45"/>
    </g>
    <path d="M560 330 C 600 286, 628 230, 646 196 C 668 214, 656 262, 628 312 C 608 340, 578 352, 552 342 Z" fill="${p.body}" stroke="${p.ink}" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="668" cy="184" r="30" fill="${p.body}" stroke="${p.ink}" stroke-width="3"/>
    <circle cx="676" cy="176" r="6.5" fill="#fff" stroke="${p.ink}" stroke-width="1.5"/>
    <circle cx="678" cy="177" r="3" fill="${p.ink}"/>
    <circle cx="679.2" cy="175.6" r="1.1" fill="#fff"/>
    <path d="M690 172 C 748 160, 800 168, 832 186 C 798 194, 748 192, 688 186 Z" fill="${p.beak}" stroke="${p.ink}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M688 188 C 742 194, 786 214, 798 244 C 754 226, 724 230, 686 202 Z" fill="${p.pouch}" stroke="${p.ink}" stroke-width="2.5" stroke-linejoin="round">
      <animate attributeName="d" dur="1.6s" repeatCount="indefinite" values="M688 188 C 742 194, 786 214, 798 244 C 754 226, 724 230, 686 202 Z;M688 188 C 752 202, 804 232, 808 268 C 756 246, 720 246, 686 204 Z;M688 188 C 742 194, 786 214, 798 244 C 754 226, 724 230, 686 202 Z"/>
    </path>
    <ellipse cx="742" cy="170" rx="12" ry="6" fill="${p.beak}" opacity="0.85"/>
    <polyline points="${points(hip1, k1.kx, k1.ky, xs1, ys1).split(";")[0]}" fill="none" stroke="${p.ink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <animate attributeName="points" values="${points(hip1, k1.kx, k1.ky, xs1, ys1)}" dur="1.2s" repeatCount="indefinite" calcMode="linear"/>
    </polyline>
    <polyline points="${points(hip2, k2.kx, k2.ky, xs2, ys2).split(";")[0]}" fill="none" stroke="${p.ink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <animate attributeName="points" values="${points(hip2, k2.kx, k2.ky, xs2, ys2)}" dur="1.2s" repeatCount="indefinite" calcMode="linear"/>
    </polyline>
    <g transform="translate(${bb.x},${bb.y})">
      <g>
        <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1.2s" repeatCount="indefinite"/>
        <line x1="-30" y1="0" x2="30" y2="0" stroke="${p.frame}" stroke-width="6" stroke-linecap="round"/>
        <g transform="translate(30,0)">
          <animateTransform attributeName="transform" type="rotate" from="0" to="-360" dur="1.2s" repeatCount="indefinite"/>
          <rect x="-10" y="-4" width="20" height="8" rx="2" fill="${p.accent}" stroke="${p.ink}" stroke-width="1.5"/>
        </g>
        <g transform="translate(-30,0)">
          <animateTransform attributeName="transform" type="rotate" from="0" to="-360" dur="1.2s" repeatCount="indefinite"/>
          <rect x="-10" y="-4" width="20" height="8" rx="2" fill="${p.accent}" stroke="${p.ink}" stroke-width="1.5"/>
        </g>
      </g>
      <circle r="5" fill="${p.frame}"/>
    </g>
    <ellipse rx="12" ry="6" fill="${p.accent}" stroke="${p.ink}" stroke-width="1.5">
      <animate attributeName="cx" values="${xs1.join(";")}" dur="1.2s" repeatCount="indefinite" calcMode="linear"/>
      <animate attributeName="cy" values="${ys1.join(";")}" dur="1.2s" repeatCount="indefinite" calcMode="linear"/>
    </ellipse>
    <ellipse rx="12" ry="6" fill="${p.accent}" stroke="${p.ink}" stroke-width="1.5">
      <animate attributeName="cx" values="${xs2.join(";")}" dur="1.2s" repeatCount="indefinite" calcMode="linear"/>
      <animate attributeName="cy" values="${ys2.join(";")}" dur="1.2s" repeatCount="indefinite" calcMode="linear"/>
    </ellipse>
  </g>
</svg>
</body>
</html>`;
}

const REFERENCE_SAMPLES = palettes.map((palette) => ({
  id: palette.id,
  model: palette.model,
  note: palette.note,
  html: buildReferenceHtml(palette),
}));

// 人工判断检查清单（与 PelicanBench 一致）
const CHECKLIST = [
  { id: "beak", label: "喙与喉囊分开，朝向合理" },
  { id: "body", label: "头、颈、身、翅、尾可以分开辨认" },
  { id: "wheels", label: "两个车轮独立，并且在转动" },
  { id: "frame", label: "车架、车座、车把、脚踏都在" },
  { id: "pedal", label: "踩踏和曲柄是同步的" },
  { id: "loop", label: "动画循环衔接，没有明显跳帧" },
  { id: "self", label: "没有依赖外部图片、字体或脚本" },
  { id: "fit", label: "缩放到不同宽度时主体仍然完整" },
];

module.exports = { REFERENCE_SAMPLES, CHECKLIST };
