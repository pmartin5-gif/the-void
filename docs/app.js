// ── Backend URL ────────────────────────────────────────────
// After deploying on Render, paste your Render URL here, e.g.:
//   const BACKEND_URL = 'https://the-void.onrender.com';
// Leave as empty string to auto-connect (works for local dev).
const BACKEND_URL = '';

// Virtual canvas dimensions — all coordinates stored in this space
// so strokes look consistent across different screen sizes
const VIRT_W = 1920;
const VIRT_H = 1080;

// Line width in virtual pixels per tool/size combo
const LINE_WIDTHS = {
  marker: { S: 2,  M: 5,  L: 11 },
  thick:  { S: 10, M: 18, L: 30 },
  spray:  { S: 22, M: 42, L: 72 },  // spray radius
  eraser: { S: 18, M: 35, L: 60 },
};

// Dots per spray "puff"
const SPRAY_DOTS = { S: 18, M: 32, L: 52 };

// Sticker font sizes in virtual pixels
const STICKER_SIZES = { S: 26, M: 44, L: 68 };

// ── Canvas & context refs ──────────────────────────────────
let bgCanvas, bgCtx, drawCanvas, drawCtx;
let canvasW = 0, canvasH = 0;

// ── App state ──────────────────────────────────────────────
let currentTool  = 'marker';
let currentColor = '#111111';
let currentSize  = 'M';

let drawing      = false;
let activeStroke = null;
let lastPoint    = null;
let sprayIdx     = 0;

let stickerText  = '';
let stickerStyle = 'tag';
let cursorVirt   = null;

// All marks received from server
const allStrokes  = [];
const allStickers = [];

// ── Socket ─────────────────────────────────────────────────
let socket;
let connected = false;

// ── Coordinate helpers ─────────────────────────────────────
function tx(vx) { return vx * canvasW / VIRT_W; }
function ty(vy) { return vy * canvasH / VIRT_H; }
function ivx(sx) { return sx * VIRT_W / canvasW; }
function ivy(sy) { return sy * VIRT_H / canvasH; }

function getPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: ivx(cx - rect.left), y: ivy(cy - rect.top) };
}

// ── Seeded random (LCG) for deterministic spray replay ─────
function lcg(seed) {
  let s = (seed ^ 0x5ca1ab1e) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ── Rendering ──────────────────────────────────────────────

function renderStroke(ctx, stroke) {
  const { points, color, sizeKey, tool } = stroke;
  if (!points || points.length === 0) return;

  if (tool === 'spray') {
    points.forEach((p, i) => renderSprayPuff(ctx, p, sizeKey, color, i));
    return;
  }

  const lw = (LINE_WIDTHS[tool]?.[sizeKey] ?? 5) * (canvasW / VIRT_W);

  ctx.save();
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;

  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.92;
  }

  ctx.beginPath();
  if (points.length === 1) {
    ctx.arc(tx(points[0].x), ty(points[0].y), lw / 2, 0, Math.PI * 2);
    if (tool !== 'eraser') ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.moveTo(tx(points[0].x), ty(points[0].y));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(tx(points[i].x), ty(points[i].y));
    }
    ctx.stroke();
  }
  ctx.restore();
}

function renderSprayPuff(ctx, vpos, sizeKey, color, idx) {
  const rand   = lcg(idx * 7919 + 1);
  const radius = (LINE_WIDTHS.spray[sizeKey] ?? 42) * (canvasW / VIRT_W);
  const dots   = SPRAY_DOTS[sizeKey] ?? 32;
  const cx     = tx(vpos.x);
  const cy     = ty(vpos.y);

  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < dots; i++) {
    const angle = rand() * Math.PI * 2;
    const dist  = Math.sqrt(rand()) * radius;
    const alpha = 0.15 + rand() * 0.55;
    ctx.globalAlpha = alpha;
    ctx.fillRect(cx + Math.cos(angle) * dist - 1, cy + Math.sin(angle) * dist - 1, 2, 2);
  }
  ctx.restore();
}

function renderSticker(ctx, sticker) {
  const { text, style, color, sizeKey, x, y, rotation } = sticker;
  const fontSize = (STICKER_SIZES[sizeKey] ?? 44) * (canvasW / VIRT_W);
  const sx = tx(x);
  const sy = ty(y);

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  if (style === 'tag') {
    ctx.font = `bold ${fontSize}px 'Permanent Marker', cursive`;
    ctx.globalAlpha = 0.92;
    ctx.shadowColor   = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur    = 4;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
  } else {
    const f = `bold ${fontSize * 0.78}px 'Arial Black', Impact, sans-serif`;
    ctx.font = f;
    const tw  = ctx.measureText(text).width;
    const th  = fontSize * 0.85;
    const pad = fontSize * 0.28;

    ctx.globalAlpha = 0.95;
    ctx.fillStyle = '#f5eecc';
    roundRect(ctx, -tw / 2 - pad, -th / 2 - pad, tw + pad * 2, th + pad * 2, 3);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.shadowColor   = 'transparent';
    ctx.shadowBlur    = 0;
    ctx.fillText(text, 0, 0);
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function rerenderAll() {
  bgCtx.clearRect(0, 0, canvasW, canvasH);
  allStrokes.forEach(s  => renderStroke(bgCtx, s));
  allStickers.forEach(s => renderSticker(bgCtx, s));
}

// ── Sticker preview on drawCanvas ──────────────────────────

function updateStickerPreview() {
  drawCtx.clearRect(0, 0, canvasW, canvasH);
  if (!stickerText.trim() || !cursorVirt) return;

  const tmp = document.createElement('canvas');
  tmp.width  = canvasW;
  tmp.height = canvasH;
  renderSticker(tmp.getContext('2d'), {
    text:     stickerText,
    style:    stickerStyle,
    color:    currentColor,
    sizeKey:  currentSize,
    x:        cursorVirt.x,
    y:        cursorVirt.y,
    rotation: 0,
  });
  drawCtx.globalAlpha = 0.6;
  drawCtx.drawImage(tmp, 0, 0);
  drawCtx.globalAlpha = 1;
}

// ── Drawing events ─────────────────────────────────────────

function onDown(e) {
  const pos = getPos(e);
  cursorVirt = pos;

  if (currentTool === 'sticker') {
    if (!stickerText.trim()) return;
    placeSticker(pos);
    return;
  }

  drawing     = true;
  sprayIdx    = 0;
  activeStroke = {
    id:      genId(),
    tool:    currentTool,
    color:   currentColor,
    sizeKey: currentSize,
    points:  [pos],
  };
  lastPoint = pos;

  if (currentTool === 'spray') {
    renderSprayPuff(drawCtx, pos, currentSize, currentColor, sprayIdx++);
  }
}

function onMove(e) {
  const pos = getPos(e);
  cursorVirt = pos;

  if (currentTool === 'sticker') {
    updateStickerPreview();
    return;
  }

  if (!drawing || !activeStroke) return;

  const minDist = currentTool === 'spray' ? 4 : 3;
  const dx = pos.x - lastPoint.x;
  const dy = pos.y - lastPoint.y;
  if (Math.sqrt(dx * dx + dy * dy) < minDist) return;

  activeStroke.points.push(pos);
  lastPoint = pos;

  if (currentTool === 'spray') {
    renderSprayPuff(drawCtx, pos, currentSize, currentColor, sprayIdx++);
  } else {
    const pts = activeStroke.points;
    drawSegment(drawCtx, activeStroke, pts.length - 2);
  }
}

function onUp() {
  if (!drawing || !activeStroke) return;
  drawing = false;

  renderStroke(bgCtx, activeStroke);
  allStrokes.push(activeStroke);
  if (connected) socket.emit('stroke', activeStroke);

  drawCtx.clearRect(0, 0, canvasW, canvasH);
  activeStroke = null;
}

function drawSegment(ctx, stroke, fromIdx) {
  const { points, color, sizeKey, tool } = stroke;
  if (fromIdx >= points.length - 1) return;

  const lw = (LINE_WIDTHS[tool]?.[sizeKey] ?? 5) * (canvasW / VIRT_W);

  ctx.save();
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;

  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.92;
  }

  ctx.beginPath();
  ctx.moveTo(tx(points[fromIdx].x),     ty(points[fromIdx].y));
  ctx.lineTo(tx(points[fromIdx + 1].x), ty(points[fromIdx + 1].y));
  ctx.stroke();
  ctx.restore();
}

// ── Sticker placement ──────────────────────────────────────

function placeSticker(vpos) {
  const sticker = {
    id:       genId(),
    text:     stickerText,
    style:    stickerStyle,
    color:    currentColor,
    sizeKey:  currentSize,
    x:        vpos.x,
    y:        vpos.y,
    rotation: (Math.random() - 0.5) * 36,
  };

  renderSticker(bgCtx, sticker);
  allStickers.push(sticker);
  if (connected) socket.emit('sticker', sticker);
  drawCtx.clearRect(0, 0, canvasW, canvasH);
}

// ── Canvas resize ──────────────────────────────────────────

function resizeCanvases() {
  const tbH  = document.getElementById('toolbar').offsetHeight || 68;
  canvasW    = window.innerWidth;
  canvasH    = window.innerHeight - tbH;

  bgCanvas.width    = canvasW;
  bgCanvas.height   = canvasH;
  drawCanvas.width  = canvasW;
  drawCanvas.height = canvasH;

  rerenderAll();
}

// ── Socket setup ───────────────────────────────────────────

function setupSocket() {
  const url = BACKEND_URL || window.location.origin;

  try {
    socket = io(url, { reconnectionAttempts: 5, timeout: 5000 });
  } catch (err) {
    setOffline();
    return;
  }

  socket.on('connect', () => {
    connected = true;
  });

  socket.on('connect_error', () => {
    connected = false;
    setOffline();
  });

  socket.on('init', ({ strokes, stickers }) => {
    allStrokes.push(...(strokes || []));
    allStickers.push(...(stickers || []));
    rerenderAll();
  });

  socket.on('stroke', (stroke) => {
    allStrokes.push(stroke);
    renderStroke(bgCtx, stroke);
  });

  socket.on('sticker', (sticker) => {
    allStickers.push(sticker);
    renderSticker(bgCtx, sticker);
  });

  socket.on('visitors', (count) => {
    document.getElementById('count').textContent = count;
    document.getElementById('plural').textContent = count === 1 ? '' : 'S';
  });
}

function setOffline() {
  document.getElementById('count').textContent = '?';
  document.getElementById('visitor-label').innerHTML = 'OFFLINE<br>MODE';
}

// ── Toolbar setup ──────────────────────────────────────────

function setupToolbar() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
      document.getElementById('sticker-panel').style.display =
        currentTool === 'sticker' ? 'flex' : 'none';
      updateCursor();
      if (currentTool !== 'sticker') {
        drawCtx.clearRect(0, 0, canvasW, canvasH);
      }
    });
  });

  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      currentColor = sw.dataset.color;
      if (currentTool === 'sticker') updateStickerPreview();
    });
  });

  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSize = btn.dataset.size;
      if (currentTool === 'sticker') updateStickerPreview();
    });
  });

  const stickerInput = document.getElementById('sticker-text');
  stickerInput.addEventListener('input', () => {
    stickerText = stickerInput.value;
    updateStickerPreview();
  });

  document.getElementById('sticker-style').addEventListener('change', (e) => {
    stickerStyle = e.target.value;
    updateStickerPreview();
  });

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      stickerInput.value = btn.dataset.text;
      stickerText = btn.dataset.text;
      if (currentTool !== 'sticker') {
        document.querySelectorAll('.tool-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.tool === 'sticker');
        });
        currentTool = 'sticker';
        document.getElementById('sticker-panel').style.display = 'flex';
        updateCursor();
      }
      updateStickerPreview();
    });
  });
}

function updateCursor() {
  const cursors = {
    marker:  'crosshair',
    thick:   'crosshair',
    spray:   'crosshair',
    eraser:  'cell',
    sticker: 'copy',
  };
  drawCanvas.style.cursor = cursors[currentTool] || 'crosshair';
}

// ── Init ───────────────────────────────────────────────────

function init() {
  bgCanvas   = document.getElementById('bg-canvas');
  bgCtx      = bgCanvas.getContext('2d');
  drawCanvas = document.getElementById('draw-canvas');
  drawCtx    = drawCanvas.getContext('2d');

  resizeCanvases();
  window.addEventListener('resize', resizeCanvases);

  drawCanvas.addEventListener('mousedown', onDown);
  drawCanvas.addEventListener('mousemove', onMove);
  drawCanvas.addEventListener('mouseup',   onUp);
  drawCanvas.addEventListener('mouseleave', onUp);

  drawCanvas.addEventListener('touchstart', e => { e.preventDefault(); onDown(e); }, { passive: false });
  drawCanvas.addEventListener('touchmove',  e => { e.preventDefault(); onMove(e); }, { passive: false });
  drawCanvas.addEventListener('touchend',   e => { e.preventDefault(); onUp();    });

  setupToolbar();
  setupSocket();
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

window.addEventListener('DOMContentLoaded', init);
