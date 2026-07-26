import React, { useState, useEffect } from 'react';

// ── Example images for Static Input vs Result comparison ─────────────────────
// You can replace these placeholder image URLs with your real photos later.
const EXAMPLES = {
  tryon: [
    {
      input: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=500&q=80',
      output: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=500&q=80',
      description: 'Ảnh mẫu gốc & Ảnh kết quả mặc trang phục mới'
    },
    {
      input: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=500&q=80',
      output: 'https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=500&q=80',
      description: 'Ví dụ thay trang phục đầm phong cách mới'
    }
  ],
  clean_916: [{
    input: '/clean_before.png',
    output: '/clean_after.jpg',
    description: 'Xóa giao diện Tiktok, logo thừa và mở rộng sang ảnh dọc 9:16 nghệ thuật'
  }],
  swap_face: [{
    input: '/face_before.jpg',
    output: '/face_after.jpg',
    description: 'Thay đổi khuôn mặt của người mẫu sang gương mặt hotgirl mới tự nhiên'
  }],
  change_bg: [{
    input: '/bg_before.jpg',
    output: '/bg_after.jpg',
    description: 'Thay thế phông nền phòng thử đồ cũ bằng không gian phòng ngủ resort sang trọng'
  }],
  brighten_skin: [{
    input: 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=500&q=80',
    output: 'https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?w=500&q=80',
    description: 'Tự động làm sáng, mịn da mà không mất chi tiết tự nhiên'
  }]
};

export default function BeforeAfterPanel({ toolType }) {
  const list = EXAMPLES[toolType] || EXAMPLES.tryon;
  const [idx, setIdx] = useState(0);
  const [activeZoomUrl, setActiveZoomUrl] = useState(null);

  // Reset example index when switching tabs
  useEffect(() => {
    setIdx(0);
  }, [toolType]);

  const cur = list[Math.min(idx, list.length - 1)] || list[0];

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
      background: 'rgba(255, 255, 255, 0.03)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: '20px',
      padding: '24px',
      backdropFilter: 'blur(16px)',
      boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.3)',
      width: '100%',
      boxSizing: 'border-box'
    }}>
      {/* Header & Navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f1f5f9' }}>✨ Ví dụ minh họa</h3>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.75rem', color: '#8e8ea0' }}>Click vào ảnh để phóng to</p>
        </div>
        
        {list.length > 1 && (
          <div style={{ display: 'flex', gap: '6px' }}>
            {list.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  background: i === idx
                    ? 'linear-gradient(90deg, #7c3aed, #3b82f6)'
                    : 'rgba(255, 255, 255, 0.2)',
                  transition: 'background 0.3s ease'
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Comparison Grid (Side-by-side layout for portrait 9:16 aspect ratio) */}
      <div style={{
        display: 'flex',
        flexDirection: 'row',
        gap: '16px',
        width: '100%'
      }}>
        {/* Input box */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#8e8ea0', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              📸 Ảnh gốc
            </span>
          </div>
          <div 
            onClick={() => setActiveZoomUrl(cur.input)}
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '9/16',
              borderRadius: '12px',
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.05)',
              background: 'rgba(0,0,0,0.2)',
              cursor: 'zoom-in',
              transition: 'transform 0.2s ease'
            }}
            className="ba-zoom-box"
          >
            <img 
              src={cur.input} 
              alt="Ảnh đầu vào" 
              style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }} 
            />
          </div>
        </div>

        {/* Output box */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              🚀 Kết quả AI
            </span>
          </div>
          <div 
            onClick={() => setActiveZoomUrl(cur.output)}
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '9/16',
              borderRadius: '12px',
              overflow: 'hidden',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              background: 'rgba(0,0,0,0.2)',
              boxShadow: '0 0 15px rgba(59, 130, 246, 0.1)',
              cursor: 'zoom-in',
              transition: 'transform 0.2s ease'
            }}
            className="ba-zoom-box"
          >
            <img 
              src={cur.output} 
              alt="Kết quả AI" 
              style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }} 
            />
          </div>
        </div>
      </div>

      {/* Description Text */}
      {cur.description && (
        <div style={{
          fontSize: '0.75rem',
          color: '#8e8ea0',
          lineHeight: '1.4',
          textAlign: 'center',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          paddingTop: '12px',
          marginTop: '4px'
        }}>
          {cur.description}
        </div>
      )}

      {/* Lightbox / Zoom Portal */}
      {activeZoomUrl && (
        <div 
          onClick={() => setActiveZoomUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 999999,
            backgroundColor: 'rgba(0, 0, 0, 0.9)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'zoom-out'
          }}
        >
          {/* Close button */}
          <button 
            onClick={() => setActiveZoomUrl(null)}
            style={{
              position: 'absolute',
              top: '20px',
              right: '20px',
              background: 'rgba(255, 255, 255, 0.1)',
              border: 'none',
              borderRadius: '50%',
              width: '40px',
              height: '40px',
              color: '#fff',
              fontSize: '20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
            }}
          >
            ✕
          </button>
          
          <img 
            src={activeZoomUrl} 
            alt="Phóng to ảnh ví dụ" 
            style={{
              maxWidth: '90%',
              maxHeight: '90%',
              objectFit: 'contain',
              borderRadius: '8px',
              boxShadow: '0 20px 50px rgba(0,0,0,0.8)'
            }} 
          />
        </div>
      )}
    </div>
  );
}
