// Live opponent cursor: we broadcast our pointer position and render
// the opponent's as a wobbly clay arrow that glides toward its latest
// known position.
//
// Positions are normalized to the QUESTION ZONE's bounding box (not the
// viewport) so phone and desktop players — whose layouts differ — still
// see the opponent's cursor over the same part of the game. Touch
// players emit on taps and drags.

const SEND_INTERVAL_MS = 125; // ~8 msg/s — the receiver lerps between
// updates so it still looks smooth, and it stretches the free-tier
// realtime message quota about twice as far.

export class CursorShare {
  constructor(sendFn) {
    this.sendFn = sendFn;
    this.lastSent = 0;
    this.el = document.getElementById('cursor-them');
    this.tagEl = document.getElementById('cursor-them-tag');
    this.stage = document.querySelector('.question-zone');
    this.target = null;   // latest received, normalized {x, y}
    this.pos = null;      // rendered position in px
    this.raf = null;
    this.hideTimer = null;
    this._onMove = this._onMove.bind(this);
    this._frame = this._frame.bind(this);
  }

  start(opponentName) {
    this.tagEl.textContent = (opponentName || 'THEM').toUpperCase();
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerdown', this._onMove);
    this.raf = requestAnimationFrame(this._frame);
  }

  stop() {
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerdown', this._onMove);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hideTimer);
    this.el.classList.remove('visible');
    this.target = null;
    this.pos = null;
  }

  _stageRect() {
    return this.stage.getBoundingClientRect();
  }

  _onMove(ev) {
    const now = performance.now();
    if (ev.type === 'pointermove' && now - this.lastSent < SEND_INTERVAL_MS) return;
    this.lastSent = now;
    const r = this._stageRect();
    if (!r.width || !r.height) return;
    this.sendFn({
      x: +((ev.clientX - r.left) / r.width).toFixed(4),
      y: +((ev.clientY - r.top) / r.height).toFixed(4),
    });
  }

  // Called by the game when a 'cursor' event arrives from the opponent.
  receive({ x, y }) {
    this.target = { x, y };
    this.el.classList.add('visible');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.el.classList.remove('visible'), 4000);
  }

  _frame() {
    if (this.target) {
      const r = this._stageRect();
      const tx = r.left + this.target.x * r.width;
      const ty = r.top + this.target.y * r.height;
      if (!this.pos) this.pos = { x: tx, y: ty };
      // Ease toward the target — smooths out the 45ms send interval.
      this.pos.x += (tx - this.pos.x) * 0.35;
      this.pos.y += (ty - this.pos.y) * 0.35;
      this.el.style.transform = `translate(${this.pos.x}px, ${this.pos.y}px)`;
    }
    this.raf = requestAnimationFrame(this._frame);
  }
}
