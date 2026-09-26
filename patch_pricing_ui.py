import re

file_path = '/Users/qtee/Documents/Tramiune/tool_video/veo3-web-app/src/App.jsx'
with open(file_path, 'r') as f:
    content = f.read()

# Find the start of the grid
grid_start_idx = content.find('{/* Pricing Grid */}')
if grid_start_idx == -1:
    print("Cannot find Pricing Grid")
    exit(1)

# Find the end of the grid (next </div></div> that closes the modal body)
# Look for QR Payment Modal to bound it
qr_modal_idx = content.find('{/* QR Payment Modal */}')
if qr_modal_idx == -1:
    print("Cannot find QR Payment Modal")
    exit(1)

grid_end_idx = content.rfind('</div>\n          </div>\n        </div>\n      )}', 0, qr_modal_idx)

if grid_end_idx == -1:
    print("Cannot find end of grid")
    exit(1)

new_grid_content = """{/* Pricing Grid */}
            <div style={{ padding: '24px', overflowY: 'auto', flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', alignContent: 'start' }}>
              
              {/* Basic Plan */}
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                border: userTier === 'basic_69k' ? '2px solid #3b82f6' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '16px',
                padding: '24px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                position: 'relative'
              }}>
                {userTier === 'basic_69k' && <span style={{ position: 'absolute', top: '12px', right: '12px', fontSize: '0.6rem', padding: '2px 6px', background: '#3b82f6', color: '#fff', borderRadius: '4px', fontWeight: 'bold' }}>Đang dùng</span>}
                <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#fff' }}>Gói Cơ Bản</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#3b82f6' }}>69k</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>/ tháng</span>
                </div>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} />
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 5 Video / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 10 Ảnh / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 5 giọng nói / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Hỗ trợ chọn ảnh thư viện</li>
                </ul>
                <button
                  onClick={() => handleSelectTierForPay('basic_69k')}
                  disabled={false}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: '#3b82f6',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  {userTier === 'basic_69k' ? 'Gói hiện tại' : 
                   (userTier === 'standard_99k' || userTier === 'premium_169k' || userTier === 'pro_299k' || userTier === 'master_499k') ? 'Gói thấp hơn' : `Nâng cấp ${getUpgradeCost('basic_69k') / 1000}k`}
                </button>
              </div>

              {/* Standard Plan */}
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                border: userTier === 'standard_99k' ? '2px solid #10b981' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '16px',
                padding: '24px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                position: 'relative'
              }}>
                {userTier === 'standard_99k' && <span style={{ position: 'absolute', top: '12px', right: '12px', fontSize: '0.6rem', padding: '2px 6px', background: '#10b981', color: '#fff', borderRadius: '4px', fontWeight: 'bold' }}>Đang dùng</span>}
                <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#fff' }}>Gói Tiêu Chuẩn</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#10b981' }}>99k</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>/ tháng</span>
                </div>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} />
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 7 Video / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 7 Ảnh / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 7 giọng nói / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Chọn ảnh thư viện</li>
                </ul>
                <button
                  onClick={() => handleSelectTierForPay('standard_99k')}
                  disabled={false}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: '#10b981',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  {userTier === 'standard_99k' ? 'Gói hiện tại' : 
                   (userTier === 'premium_169k' || userTier === 'pro_299k' || userTier === 'master_499k') ? 'Gói thấp hơn' : `Nâng cấp +${getUpgradeCost('standard_99k') / 1000}k`}
                </button>
              </div>

              {/* Premium Plan */}
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                border: userTier === 'premium_169k' ? '2px solid #fbbf24' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '16px',
                padding: '24px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                position: 'relative',
                boxShadow: '0 8px 30px rgba(251, 191, 36, 0.15)'
              }}>
                {userTier === 'premium_169k' && <span style={{ position: 'absolute', top: '12px', right: '12px', fontSize: '0.6rem', padding: '2px 6px', background: '#fbbf24', color: '#16161a', borderRadius: '4px', fontWeight: 'bold' }}>Đang dùng</span>}
                <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#fff' }}>Gói Premium</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#fbbf24' }}>199k</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>/ tháng</span>
                </div>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} />
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#fbbf24', fontWeight: '600' }}>✓ 30 Video / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#fbbf24', fontWeight: '600' }}>✓ 60 Ảnh / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 30 giọng nói / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Hỗ trợ ưu tiên</li>
                </ul>
                <button
                  onClick={() => handleSelectTierForPay('premium_169k')}
                  disabled={false}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#16161a',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  {userTier === 'premium_169k' ? 'Gói hiện tại' : 
                   (userTier === 'pro_299k' || userTier === 'master_499k') ? 'Gói thấp hơn' : `Nâng cấp +${getUpgradeCost('premium_169k') / 1000}k`}
                </button>
              </div>

              {/* Pro Plan */}
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                border: userTier === 'pro_299k' ? '2px solid #a855f7' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '16px',
                padding: '24px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                position: 'relative',
                boxShadow: '0 8px 30px rgba(168, 85, 247, 0.15)'
              }}>
                {userTier === 'pro_299k' && <span style={{ position: 'absolute', top: '12px', right: '12px', fontSize: '0.6rem', padding: '2px 6px', background: '#a855f7', color: '#fff', borderRadius: '4px', fontWeight: 'bold' }}>Đang dùng</span>}
                <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#fff' }}>Gói VIP (Pro)</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#a855f7' }}>299k</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>/ tháng</span>
                </div>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} />
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#a855f7', fontWeight: '600' }}>✓ Không giới hạn Video</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#a855f7', fontWeight: '600' }}>✓ Không giới hạn Ảnh</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#a855f7', fontWeight: '600' }}>✓ Không giới hạn Giọng nói</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Hỗ trợ kỹ thuật 24/7</li>
                </ul>
                <button
                  onClick={() => handleSelectTierForPay('pro_299k')}
                  disabled={false}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: 'linear-gradient(135deg, #a855f7 0%, #9333ea 100%)',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  {userTier === 'pro_299k' ? 'Gói hiện tại' : 
                   (userTier === 'master_499k') ? 'Gói thấp hơn' : `Nâng cấp +${getUpgradeCost('pro_299k') / 1000}k`}
                </button>
              </div>

              {/* Master Plan */}
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                border: userTier === 'master_499k' ? '2px solid #ef4444' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '16px',
                padding: '24px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                position: 'relative',
                boxShadow: '0 8px 30px rgba(239, 68, 68, 0.2)'
              }}>
                {userTier === 'master_499k' && <span style={{ position: 'absolute', top: '12px', right: '12px', fontSize: '0.6rem', padding: '2px 6px', background: '#ef4444', color: '#fff', borderRadius: '4px', fontWeight: 'bold' }}>Đang dùng</span>}
                <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#fff' }}>Gói Đặc Quyền</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#ef4444' }}>499k</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>/ tháng</span>
                </div>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} />
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#ef4444', fontWeight: '600' }}>✓ Vô cực Video / Ảnh</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#ef4444', fontWeight: '600' }}>✓ Vô cực Giọng nói</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#ef4444', fontWeight: '800' }}>✓ Mở khóa Full Kênh AI</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#ef4444', fontWeight: '800' }}>✓ Toàn quyền cao nhất</li>
                </ul>
                <button
                  onClick={() => handleSelectTierForPay('master_499k')}
                  disabled={false}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                >
                  {userTier === 'master_499k' ? 'Gói hiện tại' : `Nâng cấp +${getUpgradeCost('master_499k') / 1000}k`}
                </button>
              </div>"""

content = content[:grid_start_idx] + new_grid_content + '\n' + content[grid_end_idx:]

with open(file_path, 'w') as f:
    f.write(content)

print("Updated Pricing Modal UI.")
