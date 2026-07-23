import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── Example images per tool tab ──────────────────────────────────────────────
// Replace URLs with real photos when ready
const EXAMPLES = {
  tryon: [
    {
      before: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=600&q=80',
      after:  'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=600&q=80',
    },
    {
      before: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=600&q=80',
      after:  'https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=600&q=80',
    },
  ],
  clean_916: [{
    before: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=80',
    after:  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=450&h=800&fit=crop&q=80',
  }],
  swap_face: [{
    before: 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=600&q=80',
    after:  'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=600&q=80',
  }],
  change_bg: [{
    before: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=600&q=80',
    after:  'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=80',
  }],
  brighten_skin: [{
    before: 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=600&q=80',
    after:  'https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?w=600&q=80',
  }],
};

// ── Slider ───────────────────────────────────────────────────────────────────
function Slider({ beforeSrc, afterSrc }) {
  const [pos, setPos]         = useState(50);
  const [active, setActive]   = useState(false);
  const boxRef                = useRef(null);

  const calcPos = useCallback((clientX) => {
    if (!boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  }, []);

  useEffect(() => {
    if (!active) return;
    const onMove  = (e) => calcPos(e.clientX);
    const onTouch = (e) => calcPos(e.touches[0].clientX);
    const onUp    = ()  => setActive(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    window.addEventListener('touchmove', onTouch, { passive: true });
    window.addEventListener('touchend',  onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      window.removeEventListener('touchmove', onTouch);
      window.removeEventListener('touchend',  onUp);
    };
  }, [active, calcPos]);

  return (
    <div
      ref={boxRef}
      onMouseDown={(e) => { e.preventDefault(); setActive(true); calcPos(e.clientX); }}
      onTouchStart={(e) => { setActive(true); calcPos(e.touches[0].clientX); }}
      style={{
        position: 'relative', width: '100%', aspectRatio: '3/4',
        borderRadius: '14px', overflow: 'hidden',
        cursor: active ? 'grabbing' : 'ew-resize',
        userSelect: 'none', flexShrink: 0,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}
    >
      {/* AFTER – full background */}
      <img src={afterSrc} alt="sau"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }} />

      {/* BEFORE – clipped left */}
      <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={beforeSrc} alt="truoc"
          style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }} />
      </div>

      {/* Divider line */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: `${pos}%`,
        width: '2px', transform: 'translateX(-50%)',
        background: 'rgba(255,255,255,0.95)',
        boxShadow: '0 0 10px rgba(255,255,255,0.6)', pointerEvents: 'none',
      }} />

      {/* Handle */}
      <div style={{
        position: 'absolute', top: '50%', left: `${pos}%`,
        transform: 'translate(-50%,-50%)',
        width: '38px', height: '38px', borderRadius: '50%',
        background: 'white', boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '13px', color: '#1a1a2e', fontWeight: 800, pointerEvents: 'none',
      }}>◀▶</div>

      {/* Labels */}
      <span style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: '10px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', pointerEvents: 'none' }}>TRƯỚC</span>
      <span style={{ position: 'absolute', top: 10, right: 10, background: 'linear-gradient(90deg,#7c3aed,#3b82f6)', color: '#fff', fontSize: '10px', fontWeight: 700, padding: '3px 9px', borderRadius: '20px', pointerEvents: 'none' }}>SAU</span>
    </div>
  );
}

// ── Panel (exported) ─────────────────────────────────────────────────────────
export default function BeforeAfterPanel({ toolType }) {
  const list = EXAMPLES[toolType] || EXAMPLES.tryon;
  const [idx, setIdx] = useState(0);

  useEffect(() => { setIdx(0); }, [toolType]);

  const cur = list[Math.min(idx, list.length - 1)];

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '14px',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '18px', padding: '22px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f1f5f9' }}>✨ Ví dụ kết quả</div>
          <div style={{ fontSize: '0.72rem', color: '#8e8ea0', marginTop: '3px' }}>Kéo thanh để so sánh Trước / Sau</div>
        </div>
        {list.length > 1 && (
          <div style={{ display: 'flex', gap: '6px' }}>
            {list.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  border: 'none', cursor: 'pointer', padding: 0,
                  background: i === idx
                    ? 'linear-gradient(90deg,#7c3aed,#3b82f6)'
                    : 'rgba(255,255,255,0.2)',
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Slider */}
      <Slider key={`${toolType}-${idx}`} beforeSrc={cur.before} afterSrc={cur.after} />

      <div style={{ textAlign: 'center', fontSize: '0.7rem', color: '#8e8ea0', opacity: 0.5 }}>
        Ảnh minh hoạ — kết quả thực tế có thể khác
      </div>
    </div>
  );
}
