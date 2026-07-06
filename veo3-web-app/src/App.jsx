import React, { useState, useEffect, useRef } from 'react';
import { Video, Image as ImageIcon, LogOut, Plus, ArrowRight, Play, X, Loader, Download, Trash2, Upload, AlertCircle, Users, DollarSign, Clock, ArrowLeft, ShieldCheck, ShieldAlert } from 'lucide-react';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, addDoc, query, where, onSnapshot, deleteDoc, doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, googleProvider, db, storage } from './lib/firebase';
import './index.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3456';

function App() {
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('activeTab') || 'video');
  const [prompt, setPrompt] = useState('');
  const [user, setUser] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [aspectRatio, setAspectRatio] = useState(() => localStorage.getItem('aspectRatio') || '9:16');
  const [startFile, setStartFile] = useState(null);
  const [endFile, setEndFile] = useState(null);
  const [refFiles, setRefFiles] = useState([]);
  const [selectedRefUrls, setSelectedRefUrls] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [startLibraryUrl, setStartLibraryUrl] = useState(null);
  const [endLibraryUrl, setEndLibraryUrl] = useState(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [addFileContext, setAddFileContext] = useState('ref'); // 'start' | 'end' | 'ref'
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [userTier, setUserTier] = useState('free');
  const [userExpiryDate, setUserExpiryDate] = useState(null);
  const [pendingPayment, setPendingPayment] = useState(null);
  const [currentUserIsAdmin, setCurrentUserIsAdmin] = useState(false);
  const [isAdminView, setIsAdminView] = useState(false);
  const [adminUsersList, setAdminUsersList] = useState([]);
  const [adminSearchQuery, setAdminSearchQuery] = useState('');
  const [simulateCode, setSimulateCode] = useState('');
  const [simulateAmount, setSimulateAmount] = useState('30000');
  const [simulateLoading, setSimulateLoading] = useState(false);
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [limitError, setLimitError] = useState(null);
  const [selectedTierForPay, setSelectedTierForPay] = useState(null);
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [userProfileLoaded, setUserProfileLoaded] = useState(false);

  // User Document / Subscription Listener
  useEffect(() => {
    if (!user) {
      setUserTier('free');
      setUserExpiryDate(null);
      setPendingPayment(null);
      setUserProfileLoaded(false);
      return;
    }
    const userDocRef = doc(db, 'users', user.uid);
    
    // Auto-create user doc if missing
    setDoc(userDocRef, { email: user.email }, { merge: true }).catch(err => {
      console.error("Auto-create user document failed:", err);
    });

    const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setUserTier(data.tier || 'free');
        setUserExpiryDate(data.expiryDate || null);
        setPendingPayment(data.pendingPayment || null);
        setCurrentUserIsAdmin(data.isAdmin || false);
      } else {
        setUserTier('free');
        setUserExpiryDate(null);
        setPendingPayment(null);
        setCurrentUserIsAdmin(false);
      }
      setUserProfileLoaded(true);
    });
    return () => unsubscribe();
  }, [user]);

  // Listen to hash change for Admin mode with security guard
  useEffect(() => {
    const handleHashChange = () => {
      const isHashAdmin = window.location.hash === '#admin';
      if (isHashAdmin) {
        if (!user) {
          window.location.hash = '';
          setIsAdminView(false);
          return;
        }
        if (userProfileLoaded && !currentUserIsAdmin) {
          window.location.hash = '';
          setIsAdminView(false);
          alert("Bạn không có quyền truy cập trang quản trị!");
          return;
        }
      }
      setIsAdminView(isHashAdmin);
    };
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [user, userProfileLoaded, currentUserIsAdmin]);

  // Fetch all users list in Admin mode
  useEffect(() => {
    if (!isAdminView) return;
    const unsubscribe = onSnapshot(collection(db, 'users'), (snapshot) => {
      const list = [];
      snapshot.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
      });
      setAdminUsersList(list);
    });
    return () => unsubscribe();
  }, [isAdminView]);

  // Real auto-redirect/success check
  useEffect(() => {
    if (selectedTierForPay && userTier === selectedTierForPay) {
      setSelectedTierForPay(null);
      alert("Thanh toán tự động thành công! Tài khoản của bạn đã được nâng cấp.");
    }
  }, [userTier]);

  const getUpgradeCost = (targetTier) => {
    const prices = {
      free: 0,
      basic_69k: 69000,
      standard_99k: 99000,
      premium_169k: 169000
    };

    const currentPrice = prices[userTier] || 0;
    const targetPrice = prices[targetTier] || 0;

    const isExpired = !userExpiryDate || userExpiryDate < Date.now();
    if (isExpired) {
      return targetPrice;
    }

    const diff = targetPrice - currentPrice;
    return diff > 0 ? diff : 0;
  };

  const getTodayUsage = () => {
    const startOfDay = new Date().setHours(0,0,0,0);
    const todayTasks = tasks.filter(t => t.createdAt >= startOfDay && t.status !== 'failed');
    const videos = todayTasks.filter(t => t.type === 'video').length;
    const images = todayTasks.filter(t => t.type === 'image').length;
    return { videos, images };
  };

  const handleUpgradeTier = async (newTier) => {
    if (!user) return;
    try {
      const userDocRef = doc(db, 'users', user.uid);
      
      let newExpiryDate = userExpiryDate;
      const isExpired = !userExpiryDate || userExpiryDate < Date.now();
      if (isExpired) {
        newExpiryDate = Date.now() + 30 * 24 * 60 * 60 * 1000;
      }

      await setDoc(userDocRef, { 
        tier: newTier,
        expiryDate: newExpiryDate,
        updatedAt: Date.now()
      }, { merge: true });
      
      setShowPricingModal(false);
    } catch (e) {
      console.error("Upgrade failed:", e);
      alert("Nâng cấp thất bại. Vui lòng thử lại!");
    }
  };

  const handleSelectTierForPay = async (tierKey) => {
    if (!user) return;
    // Generate code e.g. VE123456
    const code = `VE${Math.floor(100000 + Math.random() * 900000)}`;
    try {
      const userDocRef = doc(db, 'users', user.uid);
      await setDoc(userDocRef, {
        pendingPayment: {
          code,
          tier: tierKey,
          amount: getUpgradeCost(tierKey),
          createdAt: Date.now()
        }
      }, { merge: true });
      setSelectedTierForPay(tierKey);
    } catch (e) {
      console.error("Failed to generate payment intent:", e);
      alert("Không thể khởi tạo giao dịch: " + e.message);
    }
  };

  const handleCopyText = (text) => {
    navigator.clipboard.writeText(text);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  // Admin Action Handlers
  const handleAdminChangeTier = async (userId, targetTier) => {
    try {
      const userDocRef = doc(db, 'users', userId);
      let newExpiry = null;
      if (targetTier !== 'free') {
        const u = adminUsersList.find(usr => usr.id === userId);
        const currentExpiry = u?.expiryDate;
        const isExpired = !currentExpiry || currentExpiry < Date.now();
        newExpiry = isExpired ? Date.now() + 30 * 24 * 60 * 60 * 1000 : currentExpiry;
      }
      await setDoc(userDocRef, { 
        tier: targetTier, 
        expiryDate: newExpiry 
      }, { merge: true });
      alert(`Đã đổi gói thành công sang ${targetTier}!`);
    } catch (err) {
      console.error(err);
      alert("Lỗi đổi gói: " + err.message);
    }
  };

  const handleAdminExtendExpiry = async (userId) => {
    try {
      const userDocRef = doc(db, 'users', userId);
      const u = adminUsersList.find(usr => usr.id === userId);
      const currentExpiry = u?.expiryDate || Date.now();
      const newExpiry = Math.max(currentExpiry, Date.now()) + 30 * 24 * 60 * 60 * 1000;
      await setDoc(userDocRef, { expiryDate: newExpiry }, { merge: true });
      alert("Đã gia hạn thêm 30 ngày thành công!");
    } catch (err) {
      console.error(err);
      alert("Lỗi gia hạn: " + err.message);
    }
  };

  const handleAdminToggleAdmin = async (userId, currentStatus) => {
    try {
      const userDocRef = doc(db, 'users', userId);
      await setDoc(userDocRef, { isAdmin: !currentStatus }, { merge: true });
      alert(`Đã thay đổi quyền quản trị thành công!`);
    } catch (err) {
      console.error(err);
      alert("Lỗi phân quyền: " + err.message);
    }
  };

  const handleSimulateWebhook = async () => {
    if (!simulateCode.trim()) return alert("Vui lòng nhập mã giao dịch (VD: ME123456)!");
    setSimulateLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/payment-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          gateway: 'OCB',
          amount: Number(simulateAmount),
          content: `Simulate payment from Admin Panel matching code ${simulateCode.trim().toUpperCase()}`
        })
      });
      const data = await res.json();
      setSimulateLoading(false);
      if (data.success) {
        alert("Giả lập Webhook thành công! Hệ thống đã tự động nâng cấp user.");
        setSimulateCode('');
      } else {
        alert(`Giả lập thất bại: ${data.message}`);
      }
    } catch (err) {
      setSimulateLoading(false);
      console.error(err);
      alert(`Lỗi kết nối API Webhook: ${err.message}`);
    }
  };

  const renderAdminView = () => {
    const totalUsers = adminUsersList.length;
    const activePaidUsers = adminUsersList.filter(u => u.tier !== 'free' && u.expiryDate && u.expiryDate > Date.now()).length;
    const estimatedRev = adminUsersList.reduce((sum, u) => {
      if (u.tier === 'free' || (u.expiryDate && u.expiryDate < Date.now())) return sum;
      const prices = { basic_69k: 69000, standard_99k: 99000, premium_169k: 169000 };
      return sum + (prices[u.tier] || 0);
    }, 0);

    const filteredUsers = adminUsersList.filter(u => {
      const email = u.email || '';
      return email.toLowerCase().includes(adminSearchQuery.toLowerCase());
    });

    return (
      <div className="container" style={{ maxWidth: '1200px', padding: '40px 20px', display: 'flex', flexDirection: 'column', gap: '32px', minHeight: '100vh', color: '#fff' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ShieldCheck size={28} style={{ color: '#10b981' }} />
              <h1 style={{ fontSize: '2rem', fontWeight: '800', margin: 0 }}>meo3 Admin Dashboard</h1>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '6px' }}>
              Quản lý người dùng, phân quyền gói cước và giả lập giao dịch kiểm thử
            </p>
          </div>
          <button 
            onClick={() => {
              window.location.hash = '';
              setIsAdminView(false);
            }}
            className="glass-button" 
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 20px', fontSize: '0.85rem' }}
          >
            <ArrowLeft size={16} />
            Quay lại Workspace
          </button>
        </div>

        {/* Stats Row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          
          {/* Stat 1 */}
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '24px', display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ background: 'rgba(59,130,246,0.1)', color: '#3b82f6', borderRadius: '12px', padding: '12px' }}>
              <Users size={24} />
            </div>
            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Tổng người dùng</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 'bold', marginTop: '4px' }}>{totalUsers}</div>
            </div>
          </div>

          {/* Stat 2 */}
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '24px', display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981', borderRadius: '12px', padding: '12px' }}>
              <ShieldCheck size={24} />
            </div>
            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Gói trả phí active</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 'bold', marginTop: '4px' }}>{activePaidUsers}</div>
            </div>
          </div>

          {/* Stat 3 */}
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '24px', display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', borderRadius: '12px', padding: '12px' }}>
              <DollarSign size={24} />
            </div>
            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Ước tính doanh thu</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 'bold', marginTop: '4px', color: '#fbbf24' }}>
                {estimatedRev.toLocaleString('vi-VN')}đ
              </div>
            </div>
          </div>

        </div>

        {/* Dashboard Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '32px', alignItems: 'start' }}>
          
          {/* Left Column - Users Management */}
          <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: '20px', background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '20px', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', margin: 0 }}>Quản lý Tài khoản</h2>
              <input 
                type="text"
                placeholder="Tìm email khách..."
                value={adminSearchQuery}
                onChange={(e) => setAdminSearchQuery(e.target.value)}
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  color: '#fff',
                  fontSize: '0.8rem',
                  outline: 'none',
                  minWidth: '220px'
                }}
              />
            </div>

            {/* Users Table */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '12px 8px' }}>Email</th>
                    <th style={{ padding: '12px 8px' }}>Quyền</th>
                    <th style={{ padding: '12px 8px' }}>Gói cước</th>
                    <th style={{ padding: '12px 8px' }}>Hạn dùng</th>
                    <th style={{ padding: '12px 8px', textAlign: 'right' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan="5" style={{ padding: '40px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        Không có người dùng nào khớp từ khóa.
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map(usr => {
                      const isUserExpired = usr.tier !== 'free' && usr.expiryDate && usr.expiryDate < Date.now();
                      return (
                        <tr key={usr.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <td style={{ padding: '14px 8px', fontWeight: '500', color: usr.id === user.uid ? '#3b82f6' : '#fff' }}>
                            {usr.email}
                            {usr.id === user.uid && <span style={{ fontSize: '0.65rem', marginLeft: '6px', color: '#3b82f6', background: 'rgba(59,130,246,0.1)', padding: '2px 4px', borderRadius: '4px' }}>Tôi</span>}
                            {usr.pendingPayment && (
                              <div style={{ fontSize: '0.65rem', color: '#fbbf24', marginTop: '2px', fontWeight: 'bold' }}>
                                Đang chờ: {usr.pendingPayment.code} ({usr.pendingPayment.amount?.toLocaleString('vi-VN')}đ)
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '14px 8px' }}>
                            <button
                              onClick={() => handleAdminToggleAdmin(usr.id, usr.isAdmin)}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                padding: 0,
                                display: 'flex',
                                alignItems: 'center'
                              }}
                              title={usr.isAdmin ? "Thu hồi quyền Admin" : "Cấp quyền Admin"}
                            >
                              {usr.isAdmin ? (
                                <span style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981', padding: '2px 6px', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                  <ShieldCheck size={10} /> Admin
                                </span>
                              ) : (
                                <span style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', padding: '2px 6px', borderRadius: '4px', fontSize: '0.68rem' }}>
                                  User
                                </span>
                              )}
                            </button>
                          </td>
                          <td style={{ padding: '14px 8px' }}>
                            <select
                              value={usr.tier || 'free'}
                              onChange={(e) => handleAdminChangeTier(usr.id, e.target.value)}
                              style={{
                                background: '#16161a',
                                border: '1px solid rgba(255,255,255,0.08)',
                                borderRadius: '6px',
                                padding: '4px 6px',
                                color: '#fff',
                                fontSize: '0.75rem',
                                outline: 'none'
                              }}
                            >
                              <option value="free">Free</option>
                              <option value="basic_69k">Basic (69k)</option>
                              <option value="standard_99k">Standard (99k)</option>
                              <option value="premium_169k">Premium (169k)</option>
                            </select>
                          </td>
                          <td style={{ padding: '14px 8px', color: isUserExpired ? '#ef4444' : 'var(--text-secondary)' }}>
                            {usr.tier === 'free' ? 'N/A' : (
                              usr.expiryDate ? (
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span>{new Date(usr.expiryDate).toLocaleDateString('vi-VN')}</span>
                                  {isUserExpired && <span style={{ fontSize: '0.65rem', fontWeight: 'bold' }}>(Hết hạn)</span>}
                                </div>
                              ) : 'Không giới hạn'
                            )}
                          </td>
                          <td style={{ padding: '14px 8px', textAlign: 'right' }}>
                            {usr.tier !== 'free' && (
                              <button
                                onClick={() => handleAdminExtendExpiry(usr.id)}
                                style={{
                                  background: 'rgba(255,255,255,0.05)',
                                  border: '1px solid rgba(255,255,255,0.08)',
                                  borderRadius: '6px',
                                  padding: '4px 8px',
                                  fontSize: '0.7rem',
                                  color: '#3b82f6',
                                  cursor: 'pointer',
                                  fontWeight: 'bold',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px'
                                }}
                              >
                                <Clock size={10} /> +30 ngày
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right Column - Webhook Simulator */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '20px', padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle size={20} style={{ color: '#fbbf24' }} />
              <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', margin: 0 }}>Giả lập SePay Webhook</h2>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: '1.4' }}>
              Sao chép **Mã chuyển khoản đang chờ** (ví dụ: `ME123456`) của User bên bảng và dán vào đây để kiểm thử chức năng tự động nâng cấp qua Webhook ngân hàng.
            </p>

            <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', margin: '4px 0' }} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Mã chuyển khoản (Chứa prefix ME):</span>
                <input 
                  type="text"
                  placeholder="Ví dụ: ME692841"
                  value={simulateCode}
                  onChange={(e) => setSimulateCode(e.target.value)}
                  style={{
                    background: '#16161a',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    color: '#fff',
                    fontSize: '0.85rem',
                    outline: 'none',
                    fontWeight: 'bold',
                    fontFamily: 'monospace'
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Số tiền chuyển khoản (đ):</span>
                <select
                  value={simulateAmount}
                  onChange={(e) => setSimulateAmount(e.target.value)}
                  style={{
                    background: '#16161a',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    color: '#fff',
                    fontSize: '0.85rem',
                    outline: 'none'
                  }}
                >
                  <option value="30000">30,000đ (Bù Basic &rarr; Standard)</option>
                  <option value="69000">69,000đ (Gói Cơ bản)</option>
                  <option value="99000">99,000đ (Gói Tiêu chuẩn)</option>
                  <option value="169000">169,000đ (Gói Premium)</option>
                  <option value="100000">100,000đ (Bù Basic &rarr; Premium)</option>
                  <option value="70000">70,000đ (Bù Standard &rarr; Premium)</option>
                </select>
              </div>

              <button
                onClick={handleSimulateWebhook}
                disabled={simulateLoading}
                className="glass-button"
                style={{
                  width: '100%',
                  padding: '12px',
                  background: simulateLoading ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
                  color: simulateLoading ? 'var(--text-secondary)' : '#16161a',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '0.85rem',
                  fontWeight: 'bold',
                  cursor: simulateLoading ? 'default' : 'pointer',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: '8px',
                  marginTop: '6px'
                }}
              >
                {simulateLoading ? <Loader size={16} className="spin-loader" /> : <Play size={16} />}
                Gửi tín hiệu Webhook Giả lập
              </button>

            </div>
          </div>

        </div>

      </div>
    );
  };

  // Hidden file inputs
  const startInputRef = useRef(null);
  const endInputRef = useRef(null);
  const refInputRef = useRef(null);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // LocalStorage Persist Sync
  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem('aspectRatio', aspectRatio);
  }, [aspectRatio]);

  // Tasks Listener
  useEffect(() => {
    if (!user) {
      setTasks([]);
      return;
    }

    const q = query(
      collection(db, 'tasks'),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const tasksData = [];
      snapshot.forEach((doc) => {
        tasksData.push({ id: doc.id, ...doc.data() });
      });
      // Sort in descending order by createdAt manually to avoid composite index error
      tasksData.sort((a, b) => b.createdAt - a.createdAt);
      setTasks(tasksData);
    }, (error) => {
      console.error("Firestore error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
      alert("Đăng nhập thất bại. Vui lòng thử lại.");
    }
  };

  const handleLogout = () => {
    signOut(auth);
  };

  const handleDeleteTask = async (taskId) => {
    try {
      await deleteDoc(doc(db, 'tasks', taskId));
    } catch (e) {
      console.error("Error deleting task:", e);
    }
  };

  const handleDownload = async (url, filename) => {
    try {
      console.log("Fetching media blob for download...");
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.error("Error downloading file locally, opening in new tab instead", e);
      window.open(url, '_blank');
    }
  };

  const handleAddFileClick = () => {
    if (addFileContext === 'start') {
      startInputRef.current?.click();
    } else if (addFileContext === 'end') {
      endInputRef.current?.click();
    } else {
      refInputRef.current?.click();
    }
  };

  const handleRemoveRefFile = (index) => {
    setRefFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!prompt.trim() || !user || isSubmitting) return;

    // Limit checking
    const limits = {
      free: { videos: 0, images: 0 },
      basic_69k: { videos: 10, images: 20 },
      standard_99k: { videos: 20, images: 40 },
      premium_169k: { videos: Infinity, images: Infinity }
    };

    const isExpired = userTier !== 'free' && userExpiryDate && userExpiryDate < Date.now();
    const activeUserTier = isExpired ? 'free' : userTier;
    const currentLimits = limits[activeUserTier] || limits.free;
    const usage = getTodayUsage();

    if (activeTab === 'video' && usage.videos >= currentLimits.videos) {
      setLimitError({ type: 'video', limit: currentLimits.videos, current: usage.videos });
      return;
    }

    if (activeTab === 'image' && usage.images >= currentLimits.images) {
      setLimitError({ type: 'image', limit: currentLimits.images, current: usage.images });
      return;
    }
    
    setIsSubmitting(true);
    const currentPrompt = prompt;
    try {
      let startFrameUrl = startLibraryUrl || null;
      let endFrameUrl = endLibraryUrl || null;
      let referenceImagesUrls = [];
 
      // Helper function to upload files locally to the backend (bypasses Firebase Storage upload issues)
      const uploadFilesLocally = async (files) => {
        if (!files || files.length === 0) return [];
        const formData = new FormData();
        files.forEach(f => formData.append('files', f));
        
        console.log("Uploading files locally to backend...");
        const res = await fetch(`${API_BASE}/api/upload`, {
          method: 'POST',
          body: formData
        });
        if (!res.ok) throw new Error('Local upload failed: ' + res.statusText);
        const data = await res.json();
        console.log("Local upload success. Paths:", data.filePaths);
        return data.filePaths;
      };

      console.log("Submitting task. ActiveTab:", activeTab);

      // 1. Upload start file locally (video tab)
      if (startFile && activeTab === 'video') {
        const paths = await uploadFilesLocally([startFile]);
        startFrameUrl = paths[0] || null;
      }

      // 2. Upload end file locally (video tab)
      if (endFile && activeTab === 'video') {
        const paths = await uploadFilesLocally([endFile]);
        endFrameUrl = paths[0] || null;
      }

      // 3. Upload reference images locally (image tab)
      referenceImagesUrls = [...selectedRefUrls];
      if (refFiles.length > 0 && activeTab === 'image') {
        const uploaded = await uploadFilesLocally(refFiles);
        referenceImagesUrls = [...referenceImagesUrls, ...uploaded];
      }

      console.log("Writing task to Firestore...");
      const docRef = await addDoc(collection(db, 'tasks'), {
        userId: user.uid,
        userEmail: user.email,
        prompt: currentPrompt.trim(),
        type: activeTab,
        status: 'pending',
        mediaUrl: null,
        error: null,
        model: activeTab === 'video' ? 'veo_3_1_lite' : 'imagen_4',
        aspectRatio: aspectRatio,
        startImage: startFrameUrl,
        endImage: endFrameUrl,
        referenceImages: referenceImagesUrls,
        createdAt: Date.now()
      });
      console.log("Task successfully written to Firestore! Doc ID:", docRef.id);

      // Clear form
      setPrompt('');
      setStartFile(null);
      setEndFile(null);
      setStartLibraryUrl(null);
      setEndLibraryUrl(null);
      setRefFiles([]);
      setSelectedRefUrls([]);
      setShowOptions(false);
    } catch (error) {
      console.error("Error adding task: ", error);
      alert("Có lỗi xảy ra khi tạo yêu cầu. Chi tiết lỗi: " + error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return <div className="container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'var(--text-secondary)' }}>Đang tải...</div>;
  }

  if (!user) {
    return (
      <div className="container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80vh' }}>
        <img src="/logo.png" alt="meo3 logo" style={{ width: '100px', height: '100px', marginBottom: '24px', borderRadius: '20px', objectFit: 'contain', boxShadow: '0 8px 32px rgba(59, 130, 246, 0.2)' }} />
        <h1 className="logo-text" style={{ fontSize: '3.5rem', marginBottom: '24px', background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: 'bold' }}>meo3</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '40px', fontSize: '1.2rem' }}>
          Tạo ảnh và video AI chuyên nghiệp với nền tảng Cloud mạnh mẽ.
        </p>
        <button className="glass-button" onClick={handleLogin} style={{ padding: '16px 32px', fontSize: '1.2rem' }}>
          Đăng nhập bằng Google
        </button>
      </div>
    );
  }

  if (isAdminView) {
    return renderAdminView();
  }

  const RATIOS = [
    { value: '16:9', label: '16:9', width: 14, height: 8 },
    { value: '4:3', label: '4:3', width: 14, height: 10.5 },
    { value: '1:1', label: '1:1', width: 14, height: 14 },
    { value: '3:4', label: '3:4', width: 10.5, height: 14 },
    { value: '9:16', label: '9:16', width: 8, height: 14 },
  ];

  return (
    <div className="container">
      {/* Hidden File Inputs */}
      <input 
        type="file" 
        ref={startInputRef} 
        style={{ display: 'none' }} 
        accept="image/*" 
        onChange={(e) => setStartFile(e.target.files[0] || null)}
      />
      <input 
        type="file" 
        ref={endInputRef} 
        style={{ display: 'none' }} 
        accept="image/*" 
        onChange={(e) => setEndFile(e.target.files[0] || null)}
      />
      <input 
        type="file" 
        ref={refInputRef} 
        style={{ display: 'none' }} 
        multiple 
        accept="image/*" 
        onChange={(e) => setRefFiles(prev => [...prev, ...Array.from(e.target.files)])}
      />

      {/* Top Header Bar */}
      <header className="header-container">
        <div className="logo-container">
          <img src="/logo.png" alt="meo3 logo" className="logo-image" />
          <span className="logo-text">meo3</span>
        </div>
        
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {/* Dynamic Subscription Badge (Clickable to Upgrade) */}
          <div 
            onClick={() => setShowPricingModal(true)}
            style={{ 
              cursor: 'pointer', 
              transition: 'opacity 0.2s',
              userSelect: 'none'
            }}
            onMouseOver={(e) => e.currentTarget.style.opacity = 0.8}
            onMouseOut={(e) => e.currentTarget.style.opacity = 1}
            title="Bấm để nâng cấp / thay đổi gói"
          >
            {userTier === 'premium_169k' && (
              <span style={{ fontSize: '0.65rem', padding: '2px 6px', background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)', color: '#16161a', borderRadius: '4px', fontWeight: 'bold' }}>Premium</span>
            )}
            {userTier === 'standard_99k' && (
              <span style={{ fontSize: '0.65rem', padding: '2px 6px', background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6', borderRadius: '4px', fontWeight: 'bold' }}>Standard 99k</span>
            )}
            {userTier === 'basic_69k' && (
              <span style={{ fontSize: '0.65rem', padding: '2px 6px', background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', borderRadius: '4px', fontWeight: 'bold' }}>Basic 69k</span>
            )}
            {userTier === 'free' && (
              <span style={{ fontSize: '0.65rem', padding: '2px 6px', background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', borderRadius: '4px' }}>Free (Nâng cấp)</span>
            )}
          </div>
          
          {/* Avatar Dropdown Container */}
          <div style={{ position: 'relative' }}>
            <div 
              className="avatar-circle" 
              onClick={() => setShowUserDropdown(prev => !prev)}
              style={{ cursor: 'pointer', userSelect: 'none' }}
              title="Tài khoản"
            >
              {user.photoURL ? (
                <img src={user.photoURL} alt="User Avatar" />
              ) : (
                <span>{user.email[0].toUpperCase()}</span>
              )}
            </div>

            {showUserDropdown && (
              <div style={{
                position: 'absolute',
                top: '32px',
                right: '0',
                background: 'rgba(20, 20, 25, 0.95)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '10px',
                padding: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                zIndex: 1000,
                width: '180px'
              }}>
                <div style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                  padding: '6px 8px',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}>
                  {user.email}
                </div>
                
                {/* Subscription and usage summary */}
                <div style={{
                  fontSize: '0.7rem',
                  color: '#3b82f6',
                  fontWeight: 'bold',
                  padding: '4px 8px',
                  background: 'rgba(59,130,246,0.06)',
                  borderRadius: '6px',
                  margin: '4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px'
                }}>
                  <span>Gói: {
                    userTier === 'premium_169k' ? 'Premium' :
                    userTier === 'standard_99k' ? 'Standard' :
                    userTier === 'basic_69k' ? 'Basic' : 'Free'
                  }</span>
                  {userTier !== 'free' && userExpiryDate && (
                    <span style={{ fontSize: '0.62rem', color: 'var(--text-secondary)', fontWeight: 'normal' }}>
                      Hạn dùng: {new Date(userExpiryDate).toLocaleDateString('vi-VN')} {userExpiryDate < Date.now() ? '(Hết hạn)' : ''}
                    </span>
                  )}
                </div>

                <div style={{ padding: '4px 8px 8px 8px', fontSize: '0.68rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '3px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Video hôm nay:</span>
                    <span>{getTodayUsage().videos}/{userTier === 'free' ? 0 : userTier === 'basic_69k' ? 10 : userTier === 'standard_99k' ? 20 : '∞'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Ảnh hôm nay:</span>
                    <span>{getTodayUsage().images}/{userTier === 'free' ? 0 : userTier === 'basic_69k' ? 20 : userTier === 'standard_99k' ? 40 : '∞'}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setShowUserDropdown(false);
                    setShowPricingModal(true);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '8px 10px',
                    background: 'rgba(59,130,246,0.1)',
                    border: 'none',
                    borderRadius: '6px',
                    color: '#3b82f6',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    cursor: 'pointer',
                    textAlign: 'left',
                    marginTop: '4px'
                  }}
                >
                  Nâng cấp Gói dịch vụ
                </button>

                {currentUserIsAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowUserDropdown(false);
                      window.location.hash = '#admin';
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '8px 10px',
                      background: 'rgba(16,185,129,0.1)',
                      border: 'none',
                      borderRadius: '6px',
                      color: '#10b981',
                      fontSize: '0.75rem',
                      fontWeight: '600',
                      cursor: 'pointer',
                      textAlign: 'left',
                      marginTop: '4px'
                    }}
                  >
                    <ShieldCheck size={12} />
                    Trang quản trị (Admin)
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setShowUserDropdown(false);
                    handleLogout();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '8px 10px',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: '6px',
                    color: '#ef4444',
                    fontSize: '0.78rem',
                    fontWeight: '600',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.2s',
                    marginTop: '2px'
                  }}
                  onMouseOver={(e) => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}
                  onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <LogOut size={13} />
                  Đăng xuất
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Retention Notice Banner */}
      <div style={{
        margin: '16px 32px 0 32px',
        padding: '8px 16px',
        borderRadius: '10px',
        background: 'rgba(239, 68, 68, 0.08)',
        border: '1px solid rgba(239, 68, 68, 0.15)',
        color: '#fca5a5',
        fontSize: '0.78rem',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        overflow: 'hidden'
      }}>
        <AlertCircle size={14} style={{ color: '#ef4444', flexShrink: 0 }} />
        <marquee scrollamount="4" style={{ flex: 1, margin: 0, padding: 0 }}>
          <span style={{ fontWeight: '500' }}>
            <strong>Lưu ý quan trọng:</strong> Tất cả ảnh và video chỉ được lưu trữ trên hệ thống trong vòng <strong>24 giờ (1 ngày)</strong>. Vui lòng tải tác phẩm của bạn về thiết bị trước khi bị xóa tự động.
          </span>
        </marquee>
      </div>

      {/* Main Workspace (Full Width Gallery) */}
      <main className="gallery-layout">
        <div className="gallery-grid">
          
          {/* Active Tasks Feed (Generating or Failed Placeholders inside the Grid) */}
          {tasks.filter(t => t.status !== 'completed').map(task => {
            const ratioClass = `ratio-${(task.aspectRatio || '16:9').replace(':', '-')}`;
            return (
              <div key={task.id} className={`gallery-item ${task.type} ${ratioClass}`} style={{ borderStyle: task.status === 'failed' ? 'solid' : 'dashed', borderColor: task.status === 'failed' ? '#ef4444' : 'rgba(255, 255, 255, 0.15)', background: '#121215' }}>
                <div style={{ padding: '20px', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', gap: '12px' }}>
                  {task.status === 'failed' ? (
                    <>
                      <X size={32} color="#ef4444" />
                      <div style={{ fontSize: '0.8rem', color: '#ef4444', fontWeight: 'bold' }}>Tạo thất bại</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', maxHeight: '60px', overflowY: 'auto' }}>
                        {task.error || 'Unknown error'}
                      </div>
                      <button onClick={() => handleDeleteTask(task.id)} className="tab-btn" style={{ fontSize: '0.7rem', padding: '4px 10px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: '6px' }}>
                        Xóa
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="spinner" />
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: '500' }}>
                        {task.status === 'processing' ? 'Đang xử lý...' : 'Đang chờ...'}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        "{task.prompt}"
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {/* Completed Media Grid */}
          {tasks.filter(t => t.status === 'completed' && t.mediaUrl).map(task => {
            const ratioClass = `ratio-${(task.aspectRatio || '16:9').replace(':', '-')}`;
            return (
              <div key={task.id} className={`gallery-item ${task.type} ${ratioClass}`}>
                {task.type === 'video' ? (
                  <>
                    <video 
                      src={task.mediaUrl} 
                      loop 
                      muted 
                      playsInline
                      onMouseEnter={(e) => {
                        e.currentTarget.muted = false;
                        e.currentTarget.play().catch(() => {});
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.pause();
                        e.currentTarget.currentTime = 0;
                        e.currentTarget.muted = true;
                      }}
                      style={{ cursor: 'pointer' }}
                    />
                    <div className="video-play-overlay">
                      <Play size={16} fill="currentColor" style={{ marginLeft: '2px' }} />
                    </div>
                  </>
                ) : (
                  <img src={task.mediaUrl} alt={task.prompt} loading="lazy" />
                )}
                
                {/* Floating Actions in Top-Right Corner */}
                <div className="item-actions-overlay">
                  {/* Add to prompt (Only for Image) */}
                  {task.type === 'image' && (
                    <button 
                      type="button"
                      onClick={() => setSelectedRefUrls(prev => [...prev, task.mediaUrl])}
                      className="action-circle-btn" 
                      data-tooltip="Thêm vào prompt"
                    >
                      <Plus size={14} />
                    </button>
                  )}

                  {/* Download */}
                  <button 
                    type="button"
                    onClick={() => handleDownload(task.mediaUrl, `${task.type}_${task.id}${task.type === 'video' ? '.mp4' : '.jpg'}`)}
                    className="action-circle-btn" 
                    data-tooltip="Tải về máy"
                  >
                    <Download size={14} />
                  </button>

                  {/* Delete */}
                  <button 
                    type="button"
                    onClick={() => handleDeleteTask(task.id)} 
                    className="action-circle-btn delete" 
                    data-tooltip="Xóa tác phẩm"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Prompt Info Overlay at the bottom */}
                <div className="item-info-overlay">
                  <div className="item-prompt" title={task.prompt} style={{ fontSize: '0.75rem', fontWeight: '500' }}>{task.prompt}</div>
                </div>
              </div>
            );
          })}

          {/* Empty State */}
          {tasks.length === 0 && (
            <div style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              alignItems: 'center', 
              justifyContent: 'center', 
              width: '100%', 
              minHeight: '50vh', 
              padding: '40px 20px', 
              textAlign: 'center', 
              color: 'var(--text-secondary)' 
            }}>
              <ImageIcon size={48} style={{ opacity: 0.2, marginBottom: '16px' }} />
              <h3 style={{ margin: 0, fontSize: '1.25rem', color: '#fff' }}>Thư viện trống</h3>
              <p style={{ fontSize: '0.9rem', marginTop: '8px', opacity: 0.7 }}>Hãy nhập prompt ở dưới để tạo tác phẩm đầu tiên của bạn!</p>
            </div>
          )}

        </div>
      </main>

      {/* Floating Bottom Controls Wrapper */}
      <div className="bottom-controls-wrapper">
        
        {/* Floating Options Panel (Conditionally rendered when showOptions is true) */}
        {showOptions && (
          <div className="options-floating-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {/* Tab Selector */}
              <div className="tab-selector">
                <button 
                  type="button"
                  className={`tab-btn ${activeTab === 'video' ? 'active' : ''}`}
                  onClick={() => setActiveTab('video')}
                  disabled={isSubmitting}
                >
                  <Video size={14} /> Video
                </button>
                <button 
                  type="button"
                  className={`tab-btn ${activeTab === 'image' ? 'active' : ''}`}
                  onClick={() => setActiveTab('image')}
                  disabled={isSubmitting}
                >
                  <ImageIcon size={14} /> Image
                </button>
              </div>

              {/* Credits and Close button display */}
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <div className="credits-badge" style={{ margin: 0 }}>
                  Model: <span style={{ color: '#3b82f6', fontWeight: 'bold' }}>meo3</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowOptions(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '4px',
                    borderRadius: '50%',
                    transition: 'all 0.2s',
                  }}
                  title="Đóng bảng cài đặt"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Aspect Ratios Container */}
            <div className="aspect-ratios-container">
              {RATIOS.map(r => (
                <button
                  key={r.value}
                  type="button"
                  className={`ratio-chip ${aspectRatio === r.value ? 'active' : ''}`}
                  onClick={() => setAspectRatio(r.value)}
                  disabled={isSubmitting}
                >
                  <div className="ratio-box" style={{ width: `${r.width}px`, height: `${r.height}px` }} />
                  <span>{r.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input Bar Pill */}
        <form 
          onSubmit={handleSubmit} 
          className="prompt-pill-bar"
          style={{ 
            flexDirection: 'column', 
            alignItems: 'stretch', 
            borderRadius: '24px', 
            padding: '16px', 
            gap: '12px' 
          }}
        >
          {/* Row 1: Previews / Upload Placeholders */}
          {activeTab === 'video' ? (
            <div style={{ display: 'flex', gap: '8px', marginBottom: '4px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '8px' }}>
              {/* Start Image Box */}
              <div 
                onClick={() => {
                  if (!startFile && !startLibraryUrl) {
                    setAddFileContext('start');
                    setShowAddMenu(true);
                  }
                }}
                style={{ 
                  width: '36px', 
                  height: '36px', 
                  borderRadius: '8px', 
                  border: '1px dashed rgba(255, 255, 255, 0.2)',
                  background: (startFile || startLibraryUrl) ? 'none' : 'rgba(255, 255, 255, 0.02)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                  flexShrink: 0
                }}
                title="Ảnh bắt đầu (Start)"
              >
                {(startFile || startLibraryUrl) ? (
                  <>
                    <img src={startFile ? URL.createObjectURL(startFile) : startLibraryUrl} alt="Start Frame" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px' }} />
                    <button type="button" onClick={(e) => { e.stopPropagation(); setStartFile(null); setStartLibraryUrl(null); }} className="remove-preview-btn">×</button>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '7px', textAlign: 'center', padding: '1px 0', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' }}>Start</div>
                  </>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <Plus size={10} style={{ color: 'rgba(255,255,255,0.4)' }} />
                    <span style={{ fontSize: '7px', color: 'rgba(255,255,255,0.4)', fontWeight: 'bold' }}>Start</span>
                  </div>
                )}
              </div>

              {/* End Image Box */}
              <div 
                onClick={() => {
                  if (!endFile && !endLibraryUrl) {
                    setAddFileContext('end');
                    setShowAddMenu(true);
                  }
                }}
                style={{ 
                  width: '36px', 
                  height: '36px', 
                  borderRadius: '8px', 
                  border: '1px dashed rgba(255, 255, 255, 0.2)',
                  background: (endFile || endLibraryUrl) ? 'none' : 'rgba(255, 255, 255, 0.02)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                  flexShrink: 0
                }}
                title="Ảnh kết thúc (End)"
              >
                {(endFile || endLibraryUrl) ? (
                  <>
                    <img src={endFile ? URL.createObjectURL(endFile) : endLibraryUrl} alt="End Frame" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px' }} />
                    <button type="button" onClick={(e) => { e.stopPropagation(); setEndFile(null); setEndLibraryUrl(null); }} className="remove-preview-btn">×</button>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '7px', textAlign: 'center', padding: '1px 0', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' }}>End</div>
                  </>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <Plus size={10} style={{ color: 'rgba(255,255,255,0.4)' }} />
                    <span style={{ fontSize: '7px', color: 'rgba(255,255,255,0.4)', fontWeight: 'bold' }}>End</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            (refFiles.length > 0 || selectedRefUrls.length > 0) && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '4px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '8px' }}>
                {selectedRefUrls.map((url, idx) => (
                  <div key={`selected-url-${idx}`} className="preview-thumbnail" style={{ width: '42px', height: '42px', borderRadius: '8px' }}>
                    <img src={url} alt="Selected Ref" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <button type="button" onClick={() => setSelectedRefUrls(prev => prev.filter((_, i) => i !== idx))} className="remove-preview-btn">×</button>
                  </div>
                ))}
                {refFiles.map((file, idx) => (
                  <div key={idx} className="preview-thumbnail" style={{ width: '42px', height: '42px', borderRadius: '8px' }}>
                    <img src={URL.createObjectURL(file)} alt="Ref File" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <button type="button" onClick={() => handleRemoveRefFile(idx)} className="remove-preview-btn">×</button>
                  </div>
                ))}
              </div>
            )
          )}

          {/* Row 2: Prompt Text Input (Full Width) */}
          <input 
            type="text"
            className="prompt-textarea"
            placeholder={activeTab === 'video' ? "Describe the video you want to create..." : "Describe the image you want to create..."}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={isSubmitting}
            style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: '4px 0', fontSize: '0.95rem' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />

          {/* Row 3: Action Toolbar (Plus/Upload on left, Send and Mode Toggle on right) */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '8px' }}>
            <div style={{ position: 'relative' }}>
              <button 
                type="button" 
                className="add-file-btn" 
                onClick={() => {
                  if (activeTab === 'video') {
                    if (!startFile && !startLibraryUrl) {
                      setAddFileContext('start');
                    } else {
                      setAddFileContext('end');
                    }
                  } else {
                    setAddFileContext('ref');
                  }
                  setShowAddMenu(prev => !prev);
                }}
                disabled={isSubmitting}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(255,255,255,0.04)', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
                title={activeTab === 'video' ? "Thêm ảnh bắt đầu/ảnh kết thúc" : "Thêm ảnh mẫu/ảnh tham khảo"}
              >
                <Plus size={16} />
              </button>

              {showAddMenu && (
                <div style={{
                  position: 'absolute',
                  bottom: '44px',
                  left: '0',
                  background: 'rgba(20, 20, 25, 0.96)',
                  backdropFilter: 'blur(16px)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '16px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                  zIndex: 100,
                  width: '280px',
                  maxHeight: '360px'
                }}>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: '600', color: '#fff' }}>Thêm tệp đính kèm</span>
                    <button 
                      type="button" 
                      onClick={() => setShowAddMenu(false)}
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1rem', padding: 0 }}
                    >
                      ×
                    </button>
                  </div>

                  {/* Device Upload Button */}
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddMenu(false);
                      handleAddFileClick();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '10px 12px',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '10px',
                      color: '#fff',
                      fontSize: '0.8rem',
                      fontWeight: '600',
                      cursor: 'pointer',
                      transition: 'background 0.2s'
                    }}
                    onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                    onMouseOut={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
                  >
                    <Upload size={14} />
                    Tải lên từ thiết bị
                  </button>

                  {/* Divider */}
                  <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} />

                  {/* Library Section */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minHeight: 0 }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: '500', color: 'var(--text-secondary)' }}>Chọn ảnh đã tạo gần đây:</span>
                    
                    <div style={{ 
                      display: 'grid', 
                      gridTemplateColumns: 'repeat(3, 1fr)', 
                      gap: '8px', 
                      overflowY: 'auto', 
                      flex: 1,
                      paddingRight: '2px'
                    }}>
                      {tasks.filter(t => t.status === 'completed' && t.type === 'image' && t.mediaUrl).length === 0 ? (
                        <div style={{ gridColumn: 'span 3', color: 'var(--text-secondary)', textAlign: 'center', padding: '20px 0', fontSize: '0.75rem' }}>
                          Chưa có ảnh nào trong thư viện
                        </div>
                      ) : (
                        tasks.filter(t => t.status === 'completed' && t.type === 'image' && t.mediaUrl).map((taskTask, idx) => (
                          <div 
                            key={`pop-lib-${idx}`}
                            style={{
                              position: 'relative',
                              aspectRatio: '1/1',
                              borderRadius: '8px',
                              overflow: 'hidden',
                              cursor: 'pointer',
                              border: '1.5px solid rgba(255, 255, 255, 0.05)',
                              transition: 'border-color 0.2s'
                            }}
                            onMouseOver={(e) => e.currentTarget.style.borderColor = '#3b82f6'}
                            onMouseOut={(e) => e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)'}
                          >
                            <img src={taskTask.mediaUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            
                          <div 
                            onClick={() => {
                              if (addFileContext === 'start') {
                                setStartLibraryUrl(taskTask.mediaUrl);
                                setStartFile(null);
                              } else if (addFileContext === 'end') {
                                setEndLibraryUrl(taskTask.mediaUrl);
                                setEndFile(null);
                              } else {
                                setSelectedRefUrls(prev => [...prev, taskTask.mediaUrl]);
                              }
                              setShowAddMenu(false);
                            }}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              right: 0,
                              bottom: 0,
                              background: 'rgba(0,0,0,0.5)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              opacity: 0,
                              transition: 'opacity 0.2s',
                              color: '#fff',
                              fontSize: '0.65rem',
                              fontWeight: '600'
                            }}
                            onMouseOver={(e) => e.currentTarget.style.opacity = 1}
                            onMouseOut={(e) => e.currentTarget.style.opacity = 0}
                          >
                            Chọn
                          </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {/* Mode indicator/selector button */}
              <button
                type="button"
                onClick={() => setShowOptions(prev => !prev)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: showOptions ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  border: showOptions ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '16px',
                  padding: '6px 12px',
                  color: showOptions ? '#3b82f6' : 'var(--text-secondary)',
                  fontSize: '0.8rem',
                  fontWeight: '600',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                  transition: 'all 0.2s'
                }}
              >
                {activeTab === 'video' ? <Video size={12} /> : <ImageIcon size={12} />}
                <span>{activeTab}</span>
              </button>

              <button 
                type="submit" 
                className="submit-arrow-btn"
                disabled={!prompt.trim() || isSubmitting}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '50%', background: prompt.trim() ? '#3b82f6' : 'rgba(255,255,255,0.04)', border: 'none', color: prompt.trim() ? '#fff' : 'rgba(255,255,255,0.2)', cursor: prompt.trim() ? 'pointer' : 'default', transition: 'all 0.2s', padding: 0 }}
              >
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </form>

      </div>

      {/* Limit Error Alert Modal */}
      {limitError && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
          padding: '20px'
        }}>
          <div style={{
            background: '#16161a',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '400px',
            padding: '24px',
            textAlign: 'center',
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(239, 68, 68, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AlertCircle size={24} color="#ef4444" />
              </div>
            </div>
            <h3 style={{ margin: 0, fontSize: '1.2rem', color: '#fff', fontWeight: 'bold' }}>Hết lượt tạo {limitError.type === 'video' ? 'Video' : 'Ảnh'}</h3>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
              Bạn đã dùng hết {limitError.current}/{limitError.limit} lượt tạo {limitError.type === 'video' ? 'Video' : 'Ảnh'} hôm nay của gói <strong>{userTier === 'free' ? 'Free' : userTier === 'basic_69k' ? 'Basic' : 'Standard'}</strong>.
            </p>
            <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
              <button 
                onClick={() => {
                  setLimitError(null);
                  setShowPricingModal(true);
                }}
                style={{ flex: 1, padding: '10px 16px', background: '#3b82f6', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer' }}
              >
                Nâng cấp ngay
              </button>
              <button 
                onClick={() => setLimitError(null)}
                style={{ flex: 1, padding: '10px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', color: '#ececf1', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer' }}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pricing Modal */}
      {showPricingModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          padding: '20px'
        }}>
          <div style={{
            background: '#16161a',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '20px',
            width: '100%',
            maxWidth: '800px',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 25px 60px rgba(0, 0, 0, 0.7)'
          }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 'bold', color: '#fff' }}>Bảng Giá Dịch Vụ meo3</h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Nâng cấp ngay để mở khóa toàn bộ sức mạnh sáng tạo</span>
              </div>
              <button 
                type="button" 
                onClick={() => setShowPricingModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.6rem', padding: '0 5px' }}
              >
                ×
              </button>
            </div>

            {/* Pricing Grid */}
            <div style={{ padding: '24px', overflowY: 'auto', flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
              
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
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 10 Video / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 20 Ảnh / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Chất lượng cao HD</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Hỗ trợ chọn ảnh thư viện</li>
                </ul>
                <button
                  onClick={() => handleSelectTierForPay('basic_69k')}
                  disabled={userTier === 'basic_69k' || userTier === 'standard_99k' || userTier === 'premium_169k'}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: (userTier === 'basic_69k' || userTier === 'standard_99k' || userTier === 'premium_169k') ? 'rgba(255,255,255,0.05)' : '#3b82f6',
                    border: 'none',
                    borderRadius: '8px',
                    color: (userTier === 'basic_69k' || userTier === 'standard_99k' || userTier === 'premium_169k') ? 'var(--text-secondary)' : '#fff',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: (userTier === 'basic_69k' || userTier === 'standard_99k' || userTier === 'premium_169k') ? 'default' : 'pointer'
                  }}
                >
                  {userTier === 'basic_69k' ? 'Gói hiện tại' : 
                   (userTier === 'standard_99k' || userTier === 'premium_169k') ? 'Gói thấp hơn' : `Nâng cấp ${getUpgradeCost('basic_69k') / 1000}k`}
                </button>
              </div>

              {/* Standard Plan */}
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                border: userTier === 'standard_99k' ? '2px solid #8b5cf6' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '16px',
                padding: '24px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                position: 'relative',
                boxShadow: '0 8px 30px rgba(139, 92, 246, 0.15)'
              }}>
                <span style={{ position: 'absolute', top: '-10px', left: '50%', transform: 'translateX(-50%)', fontSize: '0.62rem', padding: '2px 8px', background: '#8b5cf6', color: '#fff', borderRadius: '10px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Phổ Biến Nhất</span>
                {userTier === 'standard_99k' && <span style={{ position: 'absolute', top: '12px', right: '12px', fontSize: '0.6rem', padding: '2px 6px', background: '#8b5cf6', color: '#fff', borderRadius: '4px', fontWeight: 'bold' }}>Đang dùng</span>}
                <div style={{ fontSize: '1rem', fontWeight: 'bold', color: '#fff' }}>Gói Tiêu Chuẩn</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#8b5cf6' }}>99k</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>/ tháng</span>
                </div>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} />
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 20 Video / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 40 Ảnh / ngày</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Chất lượng cao Full HD</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Ưu tiên xử lý nhanh hơn</li>
                </ul>
                <button
                  onClick={() => handleSelectTierForPay('standard_99k')}
                  disabled={userTier === 'standard_99k' || userTier === 'premium_169k'}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: (userTier === 'standard_99k' || userTier === 'premium_169k') ? 'rgba(255,255,255,0.05)' : '#8b5cf6',
                    border: 'none',
                    borderRadius: '8px',
                    color: (userTier === 'standard_99k' || userTier === 'premium_169k') ? 'var(--text-secondary)' : '#fff',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: (userTier === 'standard_99k' || userTier === 'premium_169k') ? 'default' : 'pointer'
                  }}
                >
                  {userTier === 'standard_99k' ? 'Gói hiện tại' : 
                   userTier === 'premium_169k' ? 'Gói thấp hơn' : `Nâng cấp +${getUpgradeCost('standard_99k') / 1000}k`}
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
                  <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#fbbf24' }}>169k</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>/ tháng</span>
                </div>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} />
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#fbbf24', fontWeight: '600' }}>✓ Không giới hạn Video</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#fbbf24', fontWeight: '600' }}>✓ Không giới hạn Ảnh</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Tốc độ xử lý siêu tốc VIP</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ Hỗ trợ kỹ thuật 24/7</li>
                </ul>
                <button
                  onClick={() => handleSelectTierForPay('premium_169k')}
                  disabled={userTier === 'premium_169k'}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: userTier === 'premium_169k' ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
                    border: 'none',
                    borderRadius: '8px',
                    color: userTier === 'premium_169k' ? 'var(--text-secondary)' : '#16161a',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: userTier === 'premium_169k' ? 'default' : 'pointer'
                  }}
                >
                  {userTier === 'premium_169k' ? 'Gói hiện tại' : `Nâng cấp +${getUpgradeCost('premium_169k') / 1000}k`}
                </button>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* QR Payment Modal */}
      {selectedTierForPay && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.85)',
          backdropFilter: 'blur(10px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10005,
          padding: '20px'
        }}>
          <div style={{
            background: '#16161a',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '20px',
            width: '100%',
            maxWidth: '580px',
            boxShadow: '0 25px 60px rgba(0, 0, 0, 0.7)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 'bold', color: '#fff' }}>Thanh toán quét mã QR VietQR</h3>
              <button 
                type="button" 
                onClick={() => setSelectedTierForPay(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.4rem', padding: 0 }}
              >
                ×
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', alignItems: 'center', justifyContent: 'center' }}>
                {/* VietQR Code Image */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                  <div style={{ padding: '12px', background: '#fff', borderRadius: '16px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)', width: '200px', height: '200px' }}>
                    <img 
                      src={`https://img.vietqr.io/image/OCB-CASS03121403-compact2.png?amount=${getUpgradeCost(selectedTierForPay)}&addInfo=${encodeURIComponent(pendingPayment ? pendingPayment.code : 'VE')}&accountName=CAO%20THI%20QUYNH%20TRAM`} 
                      alt="VietQR Payment Code" 
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }} 
                    />
                  </div>
                  <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>Mở App Ngân hàng để quét mã VietQR</span>
                </div>

                {/* Account details */}
                <div style={{ flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Ngân hàng thụ hưởng:</span>
                    <span style={{ color: '#fff', fontWeight: '600' }}>OCB (Ngân hàng Phương Đông)</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Số tài khoản:</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.95rem' }}>CASS03121403</span>
                      <button type="button" onClick={() => handleCopyText('CASS03121403')} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px', padding: '2px 6px', fontSize: '0.65rem', color: '#3b82f6', cursor: 'pointer', fontWeight: 'bold' }}>Copy</button>
                    </div>
                  </div>
                  <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Tên người thụ hưởng:</span>
                    <span style={{ color: '#fff', fontWeight: '600' }}>CAO THI QUYNH TRAM</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Số tiền chuyển khoản:</span>
                    <span style={{ color: '#3b82f6', fontWeight: '800', fontSize: '1.05rem' }}>{getUpgradeCost(selectedTierForPay).toLocaleString('vi-VN')}đ</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Nội dung chuyển khoản (Bắt buộc):</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ color: '#fbbf24', fontWeight: 'bold', fontFamily: 'monospace', fontSize: '0.85rem', background: 'rgba(251,191,36,0.06)', padding: '4px 6px', borderRadius: '4px', border: '1px dashed rgba(251,191,36,0.2)' }}>{pendingPayment ? pendingPayment.code : 'VE'}</span>
                      <button type="button" onClick={() => handleCopyText(pendingPayment ? pendingPayment.code : 'VE')} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px', padding: '2px 6px', fontSize: '0.65rem', color: '#fbbf24', cursor: 'pointer', fontWeight: 'bold' }}>Copy</button>
                    </div>
                  </div>
                </div>
              </div>

              {copiedText && (
                <div style={{ fontSize: '0.75rem', color: '#10b981', textAlign: 'center', fontWeight: '600', padding: '4px', background: 'rgba(16,185,129,0.06)', borderRadius: '6px' }}>Đã sao chép thành công vào khay nhớ tạm!</div>
              )}

              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', marginTop: '8px' }} />

              {/* Waiting status */}
              <div style={{ padding: '12px 20px', background: 'rgba(59,130,246,0.1)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', border: '1px solid rgba(59,130,246,0.2)' }}>
                <Loader size={20} className="spin-loader" style={{ color: '#3b82f6' }} />
                <span style={{ fontSize: '0.85rem', color: '#3b82f6', fontWeight: '600' }}>Hệ thống đang chờ nhận tiền. Vui lòng giữ nguyên màn hình này. Tự động duyệt trong 1-3 phút.</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button onClick={() => setSelectedTierForPay(null)} style={{ padding: '10px 20px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer', textDecoration: 'underline' }}>Đóng (Sẽ thanh toán sau)</button>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

export default App;
