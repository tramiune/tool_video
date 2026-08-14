import React, { useState, useEffect, useRef } from 'react';
import { Video, Image as ImageIcon, LogOut, Plus, ArrowRight, Play, X, Loader, Download, Trash2, Upload, AlertCircle, Users, DollarSign, Clock, ArrowLeft, ShieldCheck, ShieldAlert, Check, RotateCcw, Sparkles, Clapperboard, LayoutGrid, ArrowUp, ArrowDown } from 'lucide-react';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, addDoc, query, where, onSnapshot, deleteDoc, doc, setDoc, orderBy, limit } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, googleProvider, db, storage } from './lib/firebase';
import './index.css';
import BeforeAfterPanel from './BeforeAfterPanel';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3456';

const trackTikTokEvent = (eventName, metadata = {}) => {
  if (sessionStorage.getItem('is_from_tiktok') === 'true') {
    const authUser = auth.currentUser;
    fetch(`${API_BASE}/api/track/tiktok-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        eventName,
        uid: authUser ? authUser.uid : null,
        metadata
      })
    }).catch(err => console.error('[Tracking] Failed to track TikTok event:', err));
  }
};

const APP_VERSION = 'v2.5.1';
const TASK_RETRY_LIMIT = 3;

const SESSION_STORAGE_KEY = 'meo3_session_id';

function generateSessionId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getLocalSessionId() {
  let id = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = generateSessionId();
    localStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}

function clearLocalSessionId() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

async function initSessionOnServer(user) {
  try {
    const sessionId = getLocalSessionId();
    const token = await user.getIdToken();
    await fetch(`${API_BASE}/api/session/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ sessionId })
    });
  } catch (err) {
    console.warn('Session init failed:', err);
  }
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Session-Token': getLocalSessionId()
  };
}

async function authFetch(user, url, options = {}) {
  const token = await user.getIdToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...authHeaders(token)
    }
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body.error === 'SESSION_EXPIRED') {
      clearLocalSessionId();
      signOut(auth);
      window.location.reload();
      throw new Error('Tài khoản đang được đăng nhập ở thiết bị khác. Bạn đã bị đăng xuất.');
    }
  }
  return res;
}

const getTaskErrorText = (task) => {
  const raw = [task?.errorCode, task?.error].filter(Boolean).map(String).join(' | ');
  if (!raw) return 'Đã xảy ra sự cố không xác định.';
  if (/CHILD_DANGER|PUBLIC_ERROR_MINOR/i.test(raw)) return 'Nội dung có yếu tố người chưa thành niên không phù hợp. Hãy đổi ảnh hoặc nội dung.';
  if (/AUDIO_FILTER|AUDIO_GENERATION_FILTERED/i.test(raw)) return 'Âm thanh bị bộ lọc từ chối. Hãy chỉnh prompt rồi thử lại.';
  if (/IP_INPUT_IMAGE|IP_PROHIBITED/i.test(raw)) return 'Ảnh đầu vào có thể chứa nội dung được bảo hộ. Hãy đổi ảnh khác.';
  if (/PROMINENT/i.test(raw)) return 'Ảnh có thể giống người nổi tiếng. Hãy đổi ảnh khác.';
  if (/PUBLIC_ERROR_SEXUAL/i.test(raw)) return 'Nội dung có yếu tố nhạy cảm và bị bộ lọc từ chối. Hãy đổi ảnh hoặc prompt.';
  if (/DANGER_FILTER|UNSAFE|INAPPROPRIATE|SAFETY|MEDIA_GENERATION_STATUS_FILTERED/i.test(raw)) return 'Nội dung bị bộ lọc an toàn từ chối. Hãy đổi ảnh hoặc prompt.';
  if (/VIDEO_DOWNLOAD_FAILED|IMAGE_URL_CAPTURE_FAILED|IMAGE_UPLOAD_R2_FAILED|Could not capture URL|Upload R2 failed|No successful media generated/i.test(raw)) return 'Tác phẩm đã xử lý nhưng máy chủ không lưu được kết quả. Hãy bấm Thử lại.';
  if (/TIMED_OUT|TIMEOUT|timeout/i.test(raw)) return 'Hệ thống xử lý quá thời gian. Hãy bấm Thử lại.';
  if (/Generation job finished with state: FAILED/i.test(raw)) return 'Tiến trình tạo bị gián đoạn trên máy chủ. Hãy bấm Thử lại.';
  if (/UNUSUAL_ACTIVITY|reCAPTCHA|PERMISSION_DENIED/i.test(raw)) return 'Hệ thống tạm thời bị Google giới hạn. Hãy chờ khoảng 30 giây rồi thử lại.';
  if (/OAuth token|capture token|UNAUTHENTICATED|\b401\b/i.test(raw)) return 'Phiên kết nối của máy chủ tạm thời bị gián đoạn. Hãy thử lại sau.';
  if (/QUOTA|RESOURCE_EXHAUSTED|\b429\b/i.test(raw)) return 'Hạn mức của hệ thống đang tạm hết. Hãy thử lại sau.';
  if (/Requested entity was not found|\bNOT_FOUND\b|\b404\b/i.test(raw)) return 'Mẫu AI tạm thời không khả dụng. Hãy thử lại sau.';
  if (/\bINTERNAL\b|Internal error|INTERNAL_ERROR/i.test(raw)) return 'Hệ thống đang quá tải hoặc gặp sự cố nội bộ. Hãy bấm Thử lại.';
  return String(task.error || raw);
};

const canRetryTask = (task) => {
  if (task?.status !== 'failed' || (Number(task.retryCount) || 0) >= TASK_RETRY_LIMIT) return false;
  const raw = [task.errorCode, task.error].filter(Boolean).map(String).join(' | ');
  if (/CHILD_DANGER|PUBLIC_ERROR_MINOR|AUDIO_FILTER|AUDIO_GENERATION_FILTERED|IP_INPUT_IMAGE|IP_PROHIBITED|PROMINENT|PUBLIC_ERROR_SEXUAL|DANGER_FILTER|UNSAFE|INAPPROPRIATE|SAFETY|MEDIA_GENERATION_STATUS_FILTERED/i.test(raw)) return false;
  return /INTERNAL|TIMED_OUT|TIMEOUT|timeout|VIDEO_DOWNLOAD_FAILED|IMAGE_URL_CAPTURE_FAILED|IMAGE_UPLOAD_R2_FAILED|Generation job finished with state: FAILED|UNUSUAL_ACTIVITY|reCAPTCHA|PERMISSION_DENIED|OAuth token|capture token|UNAUTHENTICATED|\b401\b|QUOTA|RESOURCE_EXHAUSTED|\b429\b|Requested entity was not found|\bNOT_FOUND\b|\b404\b|Could not capture URL|Upload R2 failed|No successful media generated/i.test(raw);
};

const createEmptyAutoToolCharacter = () => ({
  name: '',
  age: '',
  description: '',
  imageUrl: '',
  file: null,
  previewUrl: ''
});

const createEmptyAutoToolScene = () => ({
  title: '',
  imagePrompt: '',
  videoPrompt: ''
});

const EMPTY_AUTO_TOOL_STYLE = {
  artStyle: '',
  colorPalette: '',
  mood: '',
  lighting: '',
  camera: ''
};

const createEmptyDramaCharacter = () => ({
  name: '',
  age: '',
  role: '',
  description: '',
  voiceIndex: 0
});

const createEmptyDramaScene = () => ({
  title: '',
  description: '',
  imagePrompt: '',
  videoPrompt: '',
  dialogue: [{ speaker: '', text: '' }]
});

const normalizeDramaScript = (script) => {
  if (!script) return null;
  return {
    ...script,
    id: script.id || null,
    topic: script.topic || '',
    title: script.title || '',
    channelType: script.channelType || 'drama',
    characters: Array.isArray(script.characters) ? script.characters.slice(0, 3).map((character, index) => ({
      name: character.name || '',
      age: character.age ?? '',
      role: character.role || '',
      description: character.description || '',
      voiceIndex: character.voiceIndex !== undefined && character.voiceIndex !== null ? Number(character.voiceIndex) : index
    })) : [],
    baseImagePrompt: script.baseImagePrompt || '',
    scenes: Array.isArray(script.scenes) ? script.scenes.map(scene => ({
      title: scene.title || '',
      description: scene.description || '',
      imagePrompt: scene.imagePrompt || '',
      videoPrompt: scene.videoPrompt || '',
      imageUrl: scene.imageUrl || '',
      videoUrl: scene.videoUrl || '',
      imageTaskId: scene.imageTaskId || '',
      videoTaskId: scene.videoTaskId || '',
      imageStatus: scene.imageStatus || '',
      videoStatus: scene.videoStatus || '',
      dialogue: Array.isArray(scene.dialogue) ? scene.dialogue.map(line => ({
        speaker: line.speaker || '',
        text: line.text || ''
      })) : []
    })) : [],
    episodes: Array.isArray(script.episodes) ? script.episodes : [],
    status: script.status || 'draft',
    updatedAt: script.updatedAt || 0
  };
};

const normalizeAutoToolProject = (project) => {
  if (!project) return null;
  const sourceCharacters = Array.isArray(project.characters) ? project.characters : [];
  const imageUrls = Array.isArray(project.characterImageUrls) ? project.characterImageUrls : [];
  return {
    ...project,
    id: project.id || null,
    name: project.name || '',
    overview: project.overview || '',
    mode: project.mode === 'standalone' ? 'standalone' : 'series',
    characters: sourceCharacters.slice(0, 3).map((character, index) => ({
      name: character.name || '',
      age: character.age ?? '',
      description: character.description || '',
      imageUrl: character.imageUrl || imageUrls[index] || '',
      file: null,
      previewUrl: ''
    })),
    characterImageUrls: sourceCharacters.slice(0, 3).map((character, index) => character.imageUrl || imageUrls[index] || ''),
    style: {
      artStyle: project.style?.artStyle || '',
      colorPalette: project.style?.colorPalette || '',
      mood: project.style?.mood || '',
      lighting: project.style?.lighting || '',
      camera: project.style?.camera || ''
    },
    scenes: Array.isArray(project.scenes) ? project.scenes.map(scene => ({
      title: scene.title || '',
      imagePrompt: scene.imagePrompt || '',
      videoPrompt: scene.videoPrompt || ''
    })) : [],
    episodeCount: Number(project.episodeCount) || 0,
    episodes: Array.isArray(project.episodes) ? project.episodes : []
  };
};

let meowPlayedOnce = false;

const playMeowOnce = () => {
  if (meowPlayedOnce) return;
  meowPlayedOnce = true;
  try {
    const audio = new Audio('/meo.mp3');
    audio.play().catch(e => console.log("Audio play blocked by browser:", e));
  } catch (e) {
    console.warn("Audio play failed:", e);
  }
};

const BG_PRESETS = [
  {
    name: 'Ví dụ 1: Phòng ngủ Hàn Quốc sang trọng',
    prompt: 'a luxurious modern Korean-style bedroom with a large floor-to-ceiling window, soft natural daylight, elegant beige and cream tones, minimalist furniture, marble and wood accents, warm LED ambient lighting, and a clean premium aesthetic.'
  },
  {
    name: 'Ví dụ 2: Studio Hàn Quốc sáng trắng',
    prompt: 'a bright minimalist Korean-style studio interior with soft white walls, light wood furniture, sheer curtains, clean styling, subtle decor, and soft daylight coming from a large window.'
  },
  {
    name: 'Ví dụ 3: Căn hộ luxury kiểu khách sạn',
    prompt: 'a luxury hotel-style bedroom with beige marble walls, a large upholstered bed, warm indirect LED lighting, elegant wood panels, floor-to-ceiling curtains, and a refined modern premium atmosphere.'
  },
  {
    name: 'Ví dụ 4: Phòng ngủ view thành phố (Phòng thay đồ luxury)',
    prompt: 'a high-end walk-in closet interior with warm lighting, wood cabinetry, soft beige walls, a large mirror, elegant shelving, and a clean luxury Korean aesthetic.'
  },
  {
    name: 'Ví dụ 5: Background khác hẳn nhưng vẫn sang',
    prompt: 'a high-end walk-in closet interior with warm lighting, wood cabinetry, soft beige walls, a large mirror, elegant shelving, and a clean luxury Korean aesthetic.'
  },
  {
    name: 'Ví dụ 6: Quán cafe ngoài trời kiểu Hàn Quốc',
    prompt: 'a stylish outdoor Korean-style cafe terrace with cream umbrellas, wooden tables, beige chairs, soft natural daylight, green plants, minimalist decor, and a cozy premium lifestyle aesthetic.'
  },
  {
    name: 'Ví dụ 7: Đường phố Seoul buổi chiều',
    prompt: 'a modern Seoul street during golden hour with warm sunlight, clean sidewalks, elegant buildings, neutral beige tones, subtle greenery, soft shadows, and a premium Korean fashion photography vibe.'
  },
  {
    name: 'Ví dụ 8: Ban công luxury view thành phố',
    prompt: 'a luxury apartment balcony with a wide city skyline view, glass railing, beige outdoor sofa, soft natural daylight, minimalist decor, warm wood accents, and a clean high-end Korean lifestyle aesthetic.'
  },
  {
    name: 'Ví dụ 9: Rooftop Hàn Quốc sang trọng',
    prompt: 'a modern Korean rooftop terrace with city view, warm LED ambient lighting, beige lounge seating, green plants, glass railing, soft evening sky, and a clean premium atmosphere.'
  },
  {
    name: 'Ví dụ 10: Sân vườn biệt thự',
    prompt: 'a luxurious villa garden with manicured greenery, stone pathway, beige outdoor furniture, warm natural sunlight, elegant landscaping, soft shadows, and a clean premium resort-like aesthetic.'
  },
  {
    name: 'Ví dụ 11: Lối vào khách sạn 5 sao',
    prompt: 'a luxury hotel entrance walkway with marble flooring, elegant glass doors, warm ambient lighting, beige and gold tones, green plants, clean architecture, and a high-end fashion editorial atmosphere.'
  },
  {
    name: 'Ví dụ 12: Công viên Hàn Quốc mùa xuân',
    prompt: 'a beautiful Korean park in spring with cherry blossom trees, a clean walking path, fresh greenery, soft pastel tones, gentle natural sunlight, and a romantic elegant outdoor atmosphere.'
  },
  {
    name: 'Ví dụ 13: Bãi biển resort sang nhẹ',
    prompt: 'a quiet luxury beachside resort setting with soft white sand, gentle ocean view, cream lounge chairs, beige umbrellas, warm natural sunlight, and a clean elegant premium vacation aesthetic.'
  },
  {
    name: 'Ví dụ 14: Khu phố cổ Hanok Hàn Quốc',
    prompt: 'a charming Korean hanok-style street with traditional wooden architecture, clean stone path, soft daylight, beige and natural wood tones, elegant cultural atmosphere, and a modern premium feel.'
  },
  {
    name: 'Ví dụ 15: Vườn hoa nhẹ nhàng',
    prompt: 'a soft outdoor flower garden with pastel flowers, green bushes, a clean stone pathway, natural daylight, gentle breeze atmosphere, romantic Korean photography style, and a fresh feminine aesthetic.'
  },
  {
    name: 'Ví dụ 16: Phố mua sắm luxury',
    prompt: 'a high-end shopping street with elegant storefronts, clean glass windows, beige stone pavement, soft natural daylight, minimalist luxury branding atmosphere, and a premium Korean street-style fashion vibe.'
  },
  {
    name: 'Ví dụ 17: Cầu thang ngoài trời sang trọng',
    prompt: 'an elegant outdoor staircase with beige stone steps, modern architecture, green plants, soft daylight, clean shadows, marble and wood accents, and a luxurious Korean editorial photography aesthetic.'
  },
  {
    name: 'Ví dụ 18: Khu nghỉ dưỡng trên núi',
    prompt: 'a peaceful luxury mountain resort terrace with wooden flooring, glass railing, soft natural daylight, distant mountain view, beige outdoor furniture, warm neutral tones, and a clean premium retreat atmosphere.'
  },
  {
    name: 'Ví dụ 19: Hồ bơi villa cao cấp',
    prompt: 'a luxury villa poolside setting with a clean blue swimming pool, beige lounge chairs, marble flooring, warm sunlight, minimalist architecture, green plants, and a premium resort-style aesthetic.'
  },
  {
    name: 'Ví dụ 20: Sân trước căn hộ hiện đại',
    prompt: 'a modern Korean apartment outdoor courtyard with clean stone pavement, beige building facade, minimalist landscaping, soft daylight, warm neutral tones, and a refined high-end residential atmosphere.'
  }
];

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
  const refFilesRef = useRef([]);
  useEffect(() => { refFilesRef.current = refFiles; }, [refFiles]);
  const [selectedRefUrls, setSelectedRefUrls] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [retryingTaskId, setRetryingTaskId] = useState(null);
  const [startLibraryUrl, setStartLibraryUrl] = useState(null);
  const [endLibraryUrl, setEndLibraryUrl] = useState(null);
  const [startUploadState, setStartUploadState] = useState(null); // null | 'uploading' | { url }
  const [endUploadState, setEndUploadState] = useState(null);
  const [refUploadStates, setRefUploadStates] = useState([]); // aligned with refFiles: null | 'uploading' | { url }
  const startUploadPromiseRef = useRef(null);
  const endUploadPromiseRef = useRef(null);
  const refUploadPromisesRef = useRef(new Map()); // file -> Promise<url>
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showRatioMenu, setShowRatioMenu] = useState(false);
  const [addFileContext, setAddFileContext] = useState('ref'); // 'start' | 'end' | 'ref'
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [userTier, setUserTier] = useState('free');
  const [userExpiryDate, setUserExpiryDate] = useState(null);
  const [pendingPayment, setPendingPayment] = useState(null);
  const [currentUserIsAdmin, setCurrentUserIsAdmin] = useState(false);
  const [currentUserHasDramaAccess, setCurrentUserHasDramaAccess] = useState(false);
  const [isAdminView, setIsAdminView] = useState(false);
  const [adminUsersList, setAdminUsersList] = useState([]);
  const [adminSearchQuery, setAdminSearchQuery] = useState('');
  const [adminTaskSearchQuery, setAdminTaskSearchQuery] = useState('');
  const [adminPaymentSearchQuery, setAdminPaymentSearchQuery] = useState('');
  const [adminTab, setAdminTab] = useState('users'); // 'users' | 'payments' | 'tasks'
  const [adminTasksList, setAdminTasksList] = useState([]);
  const [adminTaskFilter, setAdminTaskFilter] = useState('all');
  const [adminTasksLimit, setAdminTasksLimit] = useState(10);
  const [adminPaymentsList, setAdminPaymentsList] = useState([]);
  const [adminPaymentTab, setAdminPaymentTab] = useState('pending');
  const [adminPaymentFilter, setAdminPaymentFilter] = useState('all');
  const [adminPaymentsStats, setAdminPaymentsStats] = useState(null);
  const [adminPaymentsLimit, setAdminPaymentsLimit] = useState(10);
  const [adminUsersLimit, setAdminUsersLimit] = useState(10);
  const [simulateCode, setSimulateCode] = useState('');
  const [simulateAmount, setSimulateAmount] = useState('30000');
  const [simulateLoading, setSimulateLoading] = useState(false);
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [limitError, setLimitError] = useState(null);
  const [selectedTierForPay, setSelectedTierForPay] = useState(null);
  const [isAudioView, setIsAudioView] = useState(false);
  const [audioVoices, setAudioVoices] = useState([]);
  const [audioSelectedVoice, setAudioSelectedVoice] = useState(null);
  const [audioText, setAudioText] = useState('');
  const [audioJobs, setAudioJobs] = useState([]);
  const [audioUsage, setAudioUsage] = useState({ used: 0, limit: 1, tier: 'free' });
  const [audioGenerating, setAudioGenerating] = useState(false);
  const [audioLoadingVoices, setAudioLoadingVoices] = useState(false);
  const [audioMsg, setAudioMsg] = useState(null);
  const [audioPreviewVoice, setAudioPreviewVoice] = useState(null);
  const [copiedAudioJobId, setCopiedAudioJobId] = useState(null);
  const [expandedAudioJobId, setExpandedAudioJobId] = useState(null);
  const [qrLoading, setQrLoading] = useState(true);
  const [videoDuration, setVideoDuration] = useState(8);
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [userProfileLoaded, setUserProfileLoaded] = useState(false);
  const [activeLightboxMedia, setActiveLightboxMedia] = useState(null); // null or { type, mediaUrl, prompt }

  useEffect(() => {
    if (showPricingModal) {
      trackTikTokEvent('open_pricing');
      window.fbq?.('track', 'AddToCart', {
        content_name: 'Bảng Giá Dịch Vụ meo3',
        content_category: 'Pricing Plans'
      });
      window.ttq?.track('AddToCart', {
        content_name: 'Bảng Giá Dịch Vụ meo3',
        content_category: 'Pricing Plans',
        content_type: 'product'
      });
    }
  }, [showPricingModal]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref === 'tiktok_webview') {
      sessionStorage.setItem('is_from_tiktok', 'true');
      if (!sessionStorage.getItem('tracked_redirect')) {
        sessionStorage.setItem('tracked_redirect', 'true');
        fetch(`${API_BASE}/api/track/redirect?ref=tiktok_webview`)
          .catch(err => console.error('Failed to send tracking redirect:', err));
      }
    }
  }, []);
  
  const [isTryOnView, setIsTryOnView] = useState(false);
  const [tryonPersonFile, setTryonPersonFile] = useState(null);
  const [tryonGarmentFile, setTryonGarmentFile] = useState(null);
  const [tryonDescription, setTryonDescription] = useState('');
  const [tryonModel, setTryonModel] = useState('nano_banana_pro');
  const [tryonAspectRatio, setTryonAspectRatio] = useState('9:16');
  const [tryonIsSubmitting, setTryonIsSubmitting] = useState(false);
  const [tryonPreserveBody, setTryonPreserveBody] = useState(true);
  const [tryonToolType, setTryonToolType] = useState('tryon'); // 'tryon' | 'clean_916' | 'swap_face' | 'change_bg' | 'brighten_skin'
  const [tryonSelectedBgPreset, setTryonSelectedBgPreset] = useState(BG_PRESETS[0].prompt);
  const [tryonCustomBgDescription, setTryonCustomBgDescription] = useState('');
  const [isAutoToolView, setIsAutoToolView] = useState(false);
  const [autoToolProjects, setAutoToolProjects] = useState([]);
  const [autoToolProjectsLoading, setAutoToolProjectsLoading] = useState(false);
  const [autoToolProject, setAutoToolProject] = useState(null);
  const [autoToolProjectLoading, setAutoToolProjectLoading] = useState(false);
  const [autoToolStep, setAutoToolStep] = useState(1);
  const [autoToolTopic, setAutoToolTopic] = useState('');
  const [autoToolCharacters, setAutoToolCharacters] = useState([createEmptyAutoToolCharacter()]);
  const [autoToolStyle, setAutoToolStyle] = useState(EMPTY_AUTO_TOOL_STYLE);
  const [autoToolScenes, setAutoToolScenes] = useState([]);
  const [autoToolEpisodeTitle, setAutoToolEpisodeTitle] = useState('');
  const [autoToolSaving, setAutoToolSaving] = useState(false);
  const [autoToolAiLoading, setAutoToolAiLoading] = useState(null);
  const [autoToolCreating, setAutoToolCreating] = useState(false);
  const [autoToolJobId, setAutoToolJobId] = useState(null);
  const [autoToolJob, setAutoToolJob] = useState(null);
  const [autoToolError, setAutoToolError] = useState(null);
  const autoToolCharactersRef = useRef(autoToolCharacters);
  const previousPendingPaymentRef = useRef(undefined);

  const [isDramaView, setIsDramaView] = useState(false);
  const [isToolsView, setIsToolsView] = useState(false);
  const [isMergeVideoView, setIsMergeVideoView] = useState(false);
  const [mergeVideoFiles, setMergeVideoFiles] = useState([]); // Array of { id, file, name, previewUrl }
  const [isMergingVideo, setIsMergingVideo] = useState(false);
  const [mergedVideoUrl, setMergedVideoUrl] = useState(null);
  const [mergeError, setMergeError] = useState(null);
  const [isLibraryPopupOpen, setIsLibraryPopupOpen] = useState(false);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [toolsBtnPosition, setToolsBtnPosition] = useState({ x: window.innerWidth - 73, y: window.innerHeight - 330 });
  const isDraggingToolsBtn = useRef(false);
  const toolsBtnDragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const hasDraggedToolsBtn = useRef(false);
  const [dramaScripts, setDramaScripts] = useState([]);
  const [channelType, setChannelType] = useState('drama');
  const [dramaScriptsLoading, setDramaScriptsLoading] = useState(false);
  const [dramaScript, setDramaScript] = useState(null);
  const [dramaScriptSavedState, setDramaScriptSavedState] = useState(null);
  const [dramaScriptLoading, setDramaScriptLoading] = useState(false);
  const [dramaTopic, setDramaTopic] = useState('');
  const [dramaSaving, setDramaSaving] = useState(false);
  const [dramaAiLoading, setDramaAiLoading] = useState(false);
  const [dramaCreating, setDramaCreating] = useState(false);
  const [dramaJobId, setDramaJobId] = useState(null);
  const [dramaJob, setDramaJob] = useState(null);
  const [dramaError, setDramaError] = useState(null);
  const [dramaVoices, setDramaVoices] = useState([]);
  const [dramaSceneBusy, setDramaSceneBusy] = useState({});

  const releaseAutoToolPreviews = () => {
    autoToolCharactersRef.current.forEach(character => {
      if (character.previewUrl) URL.revokeObjectURL(character.previewUrl);
    });
  };

  const applyAutoToolDraft = (project) => {
    releaseAutoToolPreviews();
    const normalized = normalizeAutoToolProject(project);
    if (!normalized) {
      setAutoToolTopic('');
      setAutoToolCharacters([createEmptyAutoToolCharacter()]);
      setAutoToolStyle(EMPTY_AUTO_TOOL_STYLE);
      setAutoToolScenes([]);
      setAutoToolEpisodeTitle('');
      return;
    }
    setAutoToolTopic(normalized.overview || '');
    const characters = normalized.characters.length
      ? normalized.characters
      : [createEmptyAutoToolCharacter()];
    autoToolCharactersRef.current = characters;
    setAutoToolCharacters(characters);
    setAutoToolStyle(normalized.style);
    setAutoToolScenes(normalized.scenes.length ? normalized.scenes : []);
    setAutoToolEpisodeTitle('');
  };

  useEffect(() => {
    autoToolCharactersRef.current = autoToolCharacters;
  }, [autoToolCharacters]);

  useEffect(() => () => {
    autoToolCharactersRef.current.forEach(character => {
      if (character.previewUrl) URL.revokeObjectURL(character.previewUrl);
    });
  }, []);

  // Play cat meow sound once, only on the login screen (when not logged in)
  useEffect(() => {
    if (user) return;

    const handleFirstInteraction = () => {
      playMeowOnce();
      window.removeEventListener('click', handleFirstInteraction);
      window.removeEventListener('touchstart', handleFirstInteraction);
    };

    window.addEventListener('click', handleFirstInteraction);
    window.addEventListener('touchstart', handleFirstInteraction);

    return () => {
      window.removeEventListener('click', handleFirstInteraction);
      window.removeEventListener('touchstart', handleFirstInteraction);
    };
  }, [user]);

  // User Document / Subscription Listener
  useEffect(() => {
    if (!user) {
      setUserTier('free');
      setUserExpiryDate(null);
      setPendingPayment(null);
      setUserProfileLoaded(false);
      previousPendingPaymentRef.current = undefined;
      return;
    }
    previousPendingPaymentRef.current = undefined;
    const userDocRef = doc(db, 'users', user.uid);
    
    // Auto-create user doc if missing
    setDoc(userDocRef, { email: user.email, createdAt: Date.now() }, { merge: true }).catch(err => {
      console.error("Auto-create user document failed:", err);
    });

    const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
      const emailIsAdmin = user.email && user.email.toLowerCase().includes('traderfinn0312');
      if (docSnap.exists()) {
        const data = docSnap.data();
        const nextPendingPayment = data.pendingPayment || null;
        const previousPendingPayment = previousPendingPaymentRef.current;

        if (
          previousPendingPayment &&
          !nextPendingPayment &&
          data.tier === previousPendingPayment.tier &&
          Number(data.updatedAt || 0) >= Number(previousPendingPayment.createdAt || 0)
        ) {
          const transactionId = previousPendingPayment.code;
          const storageKey = `meta_purchase_${transactionId}`;
          if (transactionId && !localStorage.getItem(storageKey)) {
            window.fbq?.('track', 'Purchase', {
              value: Number(previousPendingPayment.amount || 0),
              currency: 'VND',
              content_name: previousPendingPayment.tier,
              order_id: transactionId
            });
            window.ttq?.track('CompletePayment', {
              value: Number(previousPendingPayment.amount || 0),
              currency: 'VND',
              content_name: previousPendingPayment.tier,
              content_type: 'product',
              contents: [
                {
                  content_id: previousPendingPayment.tier,
                  content_name: previousPendingPayment.tier,
                  quantity: 1,
                  price: Number(previousPendingPayment.amount || 0)
                }
              ]
            });
            localStorage.setItem(storageKey, '1');
          }
        }

        previousPendingPaymentRef.current = nextPendingPayment;
        setUserTier(data.tier || 'free');
        setUserExpiryDate(data.expiryDate || null);
        setPendingPayment(nextPendingPayment);
         setCurrentUserIsAdmin(data.isAdmin || emailIsAdmin || false);
        setCurrentUserHasDramaAccess(data.hasDramaAccess || data.isAdmin || emailIsAdmin || false);
      } else {
        previousPendingPaymentRef.current = null;
        setUserTier('free');
        setUserExpiryDate(null);
        setPendingPayment(null);
        setCurrentUserIsAdmin(emailIsAdmin || false);
        setCurrentUserHasDramaAccess(emailIsAdmin || false);
      }
      setUserProfileLoaded(true);
    });
    return () => unsubscribe();
  }, [user]);

  // Listen to hash changes and guard admin-only views.
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      const isHashAdmin = hash === '#admin';
      const isHashAutoTool = hash === '#autotool';
      const isHashTryOn = hash === '#tryon';
      const isHashAudio = hash === '#audio';
      const isHashDrama = hash === '#drama';
      const isHashSumo = hash === '#sumo';
      const isHashTools = hash === '#tools';
      const isHashMergeVideo = hash === '#merge-video';
      
      if (isHashAdmin || isHashAutoTool) {
        if (!user) {
          window.location.hash = '';
          setIsAdminView(false);
          setIsAutoToolView(false);
          return;
        }
        if (userProfileLoaded && !currentUserIsAdmin) {
          window.location.hash = '';
          setIsAdminView(false);
          setIsAutoToolView(false);
          alert("Bạn không có quyền truy cập trang quản trị!");
          return;
        }
      }

      if (isHashDrama || isHashSumo) {
        if (!user) {
          window.location.hash = '';
          setIsDramaView(false);
          return;
        }
        if (userProfileLoaded && !currentUserHasDramaAccess) {
          window.location.hash = '';
          setIsDramaView(false);
          alert("Tài khoản của bạn chưa được cấp quyền truy cập Công cụ AI này!");
          return;
        }
        const targetChannel = isHashSumo ? 'sumo' : 'drama';
        setChannelType(targetChannel);
        setDramaScript(current => {
          if (current) {
            const scriptChannel = current.channelType || 'drama';
            if (scriptChannel !== targetChannel) {
              return null;
            }
          }
          return current;
        });
      }

      if (isHashMergeVideo) {
        if (!user) {
          window.location.hash = '';
          setIsMergeVideoView(false);
          return;
        }
      }

      setIsAdminView(isHashAdmin);
      setIsAutoToolView(isHashAutoTool);
      setIsTryOnView(isHashTryOn);
      setIsAudioView(isHashAudio);
      setIsDramaView(isHashDrama || isHashSumo);
      setIsToolsView(isHashTools);
      setIsMergeVideoView(isHashMergeVideo);

      if (hash && hash !== '') {
        const viewName = isHashAdmin ? 'Quản trị' :
                         isHashAutoTool ? 'Tự động tạo video' :
                         isHashTryOn ? 'Thay đồ hàng loạt (Try-On)' :
                         isHashAudio ? 'Dựng Audio & Lồng tiếng' :
                         isHashDrama ? 'Kênh Mẹ Chồng Nàng Dâu' :
                         isHashSumo ? 'Kênh Gạc Hươu Sumo' :
                         isHashMergeVideo ? 'Ghép nối video' :
                         isHashTools ? 'Danh mục công cụ AI' : 'Trang chủ';
        window.fbq?.('track', 'ViewContent', {
          content_name: viewName,
          content_category: 'AI Tools Platform'
        });
        window.ttq?.track('ViewContent', {
          content_name: viewName,
          content_category: 'AI Tools Platform'
        });
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [user, userProfileLoaded, currentUserIsAdmin, currentUserHasDramaAccess]);

  // Handle dragging for the floating Tools button
  useEffect(() => {
    const handleMove = (clientX, clientY) => {
      if (!isDraggingToolsBtn.current) return;
      const deltaX = clientX - toolsBtnDragStart.current.x;
      const deltaY = clientY - toolsBtnDragStart.current.y;
      
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        hasDraggedToolsBtn.current = true;
      }
      
      // Calculate new position
      let newX = toolsBtnDragStart.current.posX + deltaX;
      let newY = toolsBtnDragStart.current.posY + deltaY;
      
      // Boundaries check (keep it inside viewport, above the bottom input area)
      const btnWidth = 58;
      const btnHeight = 108;
      const bottomLimit = window.innerHeight - 190 - btnHeight - 5; // Sit 5px above the bottom input area
      newX = Math.max(10, Math.min(window.innerWidth - btnWidth - 10, newX));
      newY = Math.max(10, Math.min(bottomLimit, newY));
      
      setToolsBtnPosition({ x: newX, y: newY });
    };

    const onMouseMove = (e) => handleMove(e.clientX, e.clientY);
    const onTouchMove = (e) => {
      if (e.touches && e.touches[0]) {
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    const onEnd = () => {
      isDraggingToolsBtn.current = false;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchend', onEnd);
    
    // Resize handler to keep button on-screen
    const handleResize = () => {
      setToolsBtnPosition(prev => {
        const btnWidth = 58;
        const btnHeight = 108;
        const bottomLimit = window.innerHeight - 190 - btnHeight - 5;
        const newX = Math.max(10, Math.min(window.innerWidth - btnWidth - 10, prev.x));
        const newY = Math.max(10, Math.min(bottomLimit, prev.y));
        return { x: newX, y: newY };
      });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (!isAutoToolView || !user || !userProfileLoaded || !currentUserIsAdmin) return;
    let cancelled = false;

    const fetchProjects = async () => {
      setAutoToolProjectsLoading(true);
      setAutoToolError(null);
      try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/autotool/projects`, {
          headers: authHeaders(token)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
        if (cancelled) return;
        setAutoToolProjects(Array.isArray(data.projects) ? data.projects.map(normalizeAutoToolProject) : []);
        setAutoToolProject(null);
        setAutoToolStep(1);
      } catch (error) {
        console.error('AutoTool projects loading failed:', error);
        if (!cancelled) {
          setAutoToolProjects([]);
          setAutoToolProject(null);
          setAutoToolError(error.message || 'Không thể tải danh sách project AutoTool.');
        }
      } finally {
        if (!cancelled) setAutoToolProjectsLoading(false);
      }
    };

    fetchProjects();
    return () => { cancelled = true; };
  }, [isAutoToolView, user, userProfileLoaded, currentUserIsAdmin]);

  useEffect(() => {
    if (!autoToolJobId || !user) return;
    let cancelled = false;
    let interval = null;

    const fetchJob = async () => {
      try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/autotool/jobs/${autoToolJobId}`, {
          headers: authHeaders(token)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Server returned code ${response.status}`);
        if (!cancelled) {
          setAutoToolJob(data);
          setAutoToolError(null);
          if ((data.status === 'completed' || data.status === 'failed') && interval) {
            clearInterval(interval);
            interval = null;
          }
        }
      } catch (error) {
        console.error('AutoTool job listener failed:', error);
        if (!cancelled) setAutoToolError(error.message || 'Không thể theo dõi tiến trình công việc.');
      }
    };

    fetchJob();
    interval = setInterval(fetchJob, 3000);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [autoToolJobId, user]);

  // Load drama scripts + voices when entering Drama view
  useEffect(() => {
    if (!isDramaView || !user) return;
    let cancelled = false;

    const loadVoices = async () => {
      try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/audio/voices`, {
          headers: authHeaders(token)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Server returned code ${response.status}`);
        if (!cancelled && Array.isArray(data.voices)) setDramaVoices(data.voices);
      } catch (error) {
        console.error('Drama voices load failed:', error);
      }
    };

    const loadScripts = async () => {
      setDramaScriptsLoading(true);
      try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/drama/scripts`, {
          headers: authHeaders(token)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Server returned code ${response.status}`);
        if (!cancelled && Array.isArray(data.scripts)) {
          setDramaScripts(data.scripts.map(script => normalizeDramaScript({ ...script, id: script.id })));
        }
      } catch (error) {
        console.error('Drama scripts load failed:', error);
        if (!cancelled) setDramaError(error.message || 'Không thể tải danh sách kịch bản.');
      } finally {
        if (!cancelled) setDramaScriptsLoading(false);
      }
    };

    loadVoices();
    loadScripts();
    return () => { cancelled = true; };
  }, [isDramaView, user]);

  // Poll drama job progress
  useEffect(() => {
    if (!dramaJobId || !user) return;
    let cancelled = false;
    let interval = null;

    const fetchJob = async () => {
      try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/drama/jobs/${dramaJobId}`, {
          headers: authHeaders(token)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Server returned code ${response.status}`);
        if (!cancelled) {
          setDramaJob(data);
          setDramaError(null);
          if ((data.status === 'completed' || data.status === 'failed') && interval) {
            clearInterval(interval);
            interval = null;
          }
        }
      } catch (error) {
        console.error('Drama job polling failed:', error);
        if (!cancelled) setDramaError(error.message || 'Không thể theo dõi tiến trình công việc.');
      }
    };

    fetchJob();
    interval = setInterval(fetchJob, 3000);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [dramaJobId, user]);

  // Fetch users list in Admin mode (paginated, or full when searching)
  useEffect(() => {
    if (!isAdminView) return;
    const q = adminSearchQuery.trim()
      ? query(collection(db, 'users'), orderBy('createdAt', 'desc'))
      : query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(adminUsersLimit));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list = [];
        snapshot.forEach(docSnap => {
          list.push({ id: docSnap.id, ...docSnap.data() });
        });
        setAdminUsersList(list);
      },
      (error) => {
        console.error("Admin users listener error:", error);
      }
    );
    return () => unsubscribe();
  }, [isAdminView, adminUsersLimit, adminSearchQuery]);

  // Fetch tasks list in Admin mode (paginated, or full when searching)
  useEffect(() => {
    if (!isAdminView) return;
    const q = adminTaskSearchQuery.trim()
      ? query(collection(db, 'tasks'), orderBy('createdAt', 'desc'))
      : query(collection(db, 'tasks'), orderBy('createdAt', 'desc'), limit(adminTasksLimit));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list = [];
        snapshot.forEach(docSnap => {
          list.push({ id: docSnap.id, ...docSnap.data() });
        });
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setAdminTasksList(list);
      }, (error) => {
        console.error("Admin tasks listener error:", error);
      });
    return () => unsubscribe();
  }, [isAdminView, adminTasksLimit, adminTaskSearchQuery]);

  // Fetch payments list in Admin mode (paginated, or full when searching)
  useEffect(() => {
    if (!isAdminView) return;
    const q = adminPaymentSearchQuery.trim()
      ? query(collection(db, 'payments'), orderBy('createdAt', 'desc'))
      : query(collection(db, 'payments'), orderBy('createdAt', 'desc'), limit(adminPaymentsLimit));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list = [];
        snapshot.forEach(docSnap => {
          list.push({ id: docSnap.id, ...docSnap.data() });
        });
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setAdminPaymentsList(list);
      }, (error) => {
        console.error("Admin payments listener error:", error);
      });
    return () => unsubscribe();
  }, [isAdminView, adminPaymentsLimit, adminPaymentSearchQuery]);

  // Fetch aggregate payment stats in Admin mode (single doc, cheap read)
  useEffect(() => {
    if (!isAdminView) return;
    const unsubscribe = onSnapshot(doc(db, 'stats', 'payments'), (docSnap) => {
      setAdminPaymentsStats(docSnap.exists ? docSnap.data() : null);
    }, (error) => {
      console.error("Admin payments stats listener error:", error);
    });
    return () => unsubscribe();
  }, [isAdminView]);

  // Real auto-redirect/success check
  useEffect(() => {
    if (selectedTierForPay && userTier === selectedTierForPay) {
      setSelectedTierForPay(null);
      alert("✨ Chúc mừng bạn! Giao dịch thanh toán đã hoàn tất và tài khoản của bạn đã được nâng cấp thành công. Bắt đầu sáng tạo thôi nào! 🎉");
    }
  }, [userTier]);

  // Close all dropdowns/popups when clicking outside them
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ratioMenuRef.current && ratioMenuRef.current.contains(e.target)) return;
      if (addMenuRef.current && addMenuRef.current.contains(e.target)) return;
      if (userDropdownRef.current && userDropdownRef.current.contains(e.target)) return;
      setShowRatioMenu(false);
      setShowAddMenu(false);
      setShowUserDropdown(false);
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, []);

  const getUpgradeCost = (targetTier) => {
    const prices = {
      free: 0,
      basic_69k: 69000,
      standard_99k: 99000,
      premium_169k: 199000
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

  const audioTierLabel = (tier) => {
    return tier === 'premium_169k' ? 'Premium' :
           tier === 'basic_69k' ? 'Basic' :
           tier === 'hocvien' ? 'Học viên' : 'Free';
  };

  const audioJobStatusLabel = (status) => {
    return status === 'COMPLETED' ? 'Hoàn tất' :
           status === 'FAILED' ? 'Thất bại' :
           'Đang xử lý';
  };

  // Đếm tổng số video đã tạo từ trước đến nay (all-time), dùng để giới hạn free tier
  const getAllTimeVideoCount = () => {
    return tasks.filter(t => t.type === 'video' && t.status !== 'failed').length;
  };

  // Đếm tổng số ảnh đã tạo từ trước đến nay (all-time), dùng để giới hạn free tier
  const getAllTimeImageCount = () => {
    return tasks.filter(t => t.type === 'image' && t.status !== 'failed').length;
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
      alert("Không thể hoàn tất nâng cấp lúc này. Bạn vui lòng thử lại hoặc liên hệ nhóm hỗ trợ Zalo nhé! 🥺");
    }
  };

  const handleSelectTierForPay = async (tierKey) => {
    if (!user) return;
    setQrLoading(true);
    trackTikTokEvent('select_tier', { tier: tierKey, cost: getUpgradeCost(tierKey) });
    
    // Nếu đã có giao dịch đang chờ trùng với gói đang chọn thì tái sử dụng, không sinh code mới
    if (pendingPayment && pendingPayment.tier === tierKey && pendingPayment.code) {
      trackTikTokEvent('open_payment_qr', { tier: tierKey, cost: getUpgradeCost(tierKey) });
      setSelectedTierForPay(tierKey);
      window.fbq?.('track', 'InitiateCheckout', {
        value: getUpgradeCost(tierKey),
        currency: 'VND',
        content_name: tierKey
      });
      window.ttq?.track('InitiateCheckout', {
        value: getUpgradeCost(tierKey),
        currency: 'VND',
        content_name: tierKey,
        content_type: 'product',
        contents: [
          {
            content_id: tierKey,
            content_name: tierKey,
            quantity: 1,
            price: getUpgradeCost(tierKey)
          }
        ]
      });
      return;
    }
    
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
      trackTikTokEvent('open_payment_qr', { tier: tierKey, cost: getUpgradeCost(tierKey) });
      window.fbq?.('track', 'InitiateCheckout', {
        value: getUpgradeCost(tierKey),
        currency: 'VND',
        content_name: tierKey
      });
      window.ttq?.track('InitiateCheckout', {
        value: getUpgradeCost(tierKey),
        currency: 'VND',
        content_name: tierKey,
        content_type: 'product',
        contents: [
          {
            content_id: tierKey,
            content_name: tierKey,
            quantity: 1,
            price: getUpgradeCost(tierKey)
          }
        ]
      });
    } catch (e) {
      console.error("Failed to generate payment intent:", e);
      alert("Hệ thống chưa thể khởi tạo mã giao dịch lúc này: " + e.message + ". Bạn vui lòng bấm thử lại nhé! 🥺");
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

  const handleAdminConfirmPayment = async (userId, payment) => {
    if (!payment || !payment.code) return alert("Không có mã giao dịch chờ!");
    setSimulateLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/payment-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gateway: 'OCB',
          amount: Number(payment.amount),
          source: 'admin',
          content: `Admin confirm matching code ${payment.code}`
        })
      });
      const data = await res.json();
      setSimulateLoading(false);
      if (data.success && data.processed > 0) {
        alert(`✅ Đã xác nhận nạp tiền cho ${userId} (${payment.amount?.toLocaleString('vi-VN')}đ) thành công!`);
      } else {
        alert(`Xác nhận thất bại: ${data.message || 'Không tìm thấy user đang chờ mã này'}`);
      }
    } catch (err) {
      setSimulateLoading(false);
      console.error(err);
      alert(`Lỗi kết nối API: ${err.message}`);
    }
  };

  const handleAdminCancelPayment = async (userId) => {
    try {
      const userDocRef = doc(db, 'users', userId);
      await setDoc(userDocRef, { pendingPayment: null }, { merge: true });
      alert("Đã hủy giao dịch chờ thành công!");
    } catch (err) {
      console.error(err);
      alert("Lỗi hủy giao dịch: " + err.message);
    }
  };

  const renderFloatingToolsButton = () => {
    // Only render if user is logged in and profile loaded
    if (!user || !userProfileLoaded) return null;

    const onMouseDown = (e) => {
      // Only handle left clicks
      if (e.button !== 0) return;
      isDraggingToolsBtn.current = true;
      toolsBtnDragStart.current = {
        x: e.clientX,
        y: e.clientY,
        posX: toolsBtnPosition.x,
        posY: toolsBtnPosition.y
      };
      hasDraggedToolsBtn.current = false;
      e.preventDefault();
    };

    const onTouchStart = (e) => {
      if (e.touches && e.touches[0]) {
        isDraggingToolsBtn.current = true;
        toolsBtnDragStart.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          posX: toolsBtnPosition.x,
          posY: toolsBtnPosition.y
        };
        hasDraggedToolsBtn.current = false;
      }
    };

    return (
      <div
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        style={{
          position: 'fixed',
          left: `${toolsBtnPosition.x}px`,
          top: `${toolsBtnPosition.y}px`,
          zIndex: 99999,
          cursor: 'grab',
          userSelect: 'none',
          touchAction: 'none', // Prevents scrolling while dragging on mobile
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '8px',
          background: 'rgba(20, 20, 25, 0.65)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '50%',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          transition: isDraggingToolsBtn.current ? 'none' : 'transform 0.2s'
        }}
        onMouseOver={(e) => {
          if (!isDraggingToolsBtn.current) {
            e.currentTarget.style.transform = 'scale(1.05)';
            e.currentTarget.style.boxShadow = '0 8px 32px rgba(0, 104, 255, 0.2), 0 8px 32px rgba(0, 0, 0, 0.4)';
          }
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
          e.currentTarget.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.4)';
        }}
      >
        {/* Zalo Floating Button */}
        <a
          href="https://zalo.me/g/2yqlehs4q8zwgvfvplyd"
          target="_blank"
          rel="noopener noreferrer"
          title="Tham gia nhóm Zalo hỗ trợ"
          onClick={(e) => {
            if (hasDraggedToolsBtn.current) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '42px',
            height: '42px',
            borderRadius: '50%',
            overflow: 'hidden',
            background: 'transparent',
            boxShadow: '0 4px 14px rgba(0, 104, 255, 0.4), 0 2px 5px rgba(0,0,0,0.3)',
            cursor: 'pointer',
            transition: 'transform 0.2s',
            zIndex: 99999
          }}
          onMouseOver={(e) => {
            if (!isDraggingToolsBtn.current) {
              e.currentTarget.style.transform = 'scale(1.1)';
              e.currentTarget.style.filter = 'drop-shadow(0 0 8px rgba(0, 104, 255, 0.5))';
            }
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.filter = 'none';
          }}
        >
          <img src="/zalo.svg" alt="Zalo" style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
        </a>
      </div>
    );
  };

  const renderAdminView = () => {
    const pendingPaymentsCount = adminUsersList.filter(u => u.pendingPayment && u.pendingPayment.code).length;

    const filteredUsers = adminUsersList.filter(u => {
      const q = adminSearchQuery.trim().toLowerCase();
      if (!q) return true;
      const email = (u.email || '').toLowerCase();
      const id = (u.id || '').toLowerCase();
      return email.includes(q) || id.includes(q);
    });

    const filteredTasks = adminTasksList.filter(t => {
      const q = adminTaskSearchQuery.trim().toLowerCase();
      if (!q) return true;
      const id = (t.id || '').toLowerCase();
      const uid = (t.userId || '').toLowerCase();
      const prompt = (t.prompt || '').toLowerCase();
      return id.includes(q) || uid.includes(q) || prompt.includes(q) || (t.status || '').toLowerCase().includes(q);
    });

    const filteredPayments = adminPaymentsList.filter(p => {
      const q = adminPaymentSearchQuery.trim().toLowerCase();
      if (!q) return true;
      const email = (p.email || '').toLowerCase();
      const code = (p.code || '').toLowerCase();
      const uid = (p.userId || '').toLowerCase();
      const tier = (p.tier || '').toLowerCase();
      return email.includes(q) || code.includes(q) || uid.includes(q) || tier.includes(q);
    });

    return (
      <div className="container admin-view" style={{ maxWidth: '1200px', padding: '40px 20px', display: 'flex', flexDirection: 'column', gap: '32px', minHeight: '100vh', color: '#fff' }}>
        
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

        {/* Admin Tabs */}
        <div className="admin-tabs" style={{ display: 'flex', gap: '8px' }}>
          {[
            { key: 'users', label: '👥 Người dùng', icon: Users },
            { key: 'payments', label: '💰 Nạp tiền', icon: DollarSign },
            { key: 'tasks', label: '🖼️ Tasks', icon: ImageIcon }
          ].map(tab => {
            const Icon = tab.icon;
            const isActive = adminTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setAdminTab(tab.key)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1,
                  gap: '8px',
                  padding: '10px 18px', borderRadius: '10px', cursor: 'pointer',
                  fontSize: '0.85rem', fontWeight: 'bold',
                  background: isActive ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' : 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: isActive ? '#fff' : 'var(--text-secondary)',
                  whiteSpace: 'nowrap'
                }}
              >
                <Icon size={16} />
                {tab.label}
                {tab.key === 'payments' && pendingPaymentsCount > 0 && (
                  <span style={{ background: '#ef4444', color: '#fff', borderRadius: '999px', fontSize: '0.65rem', padding: '2px 7px' }}>
                    {pendingPaymentsCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Users Tab */}
        {adminTab === 'users' && (
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
            <div className="admin-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="admin-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '12px 8px' }}>Email</th>
                    <th style={{ padding: '12px 8px' }}>Quyền</th>
                    <th style={{ padding: '12px 8px' }}>Quyền Drama</th>
                    <th style={{ padding: '12px 8px' }}>Gói cước</th>
                    <th style={{ padding: '12px 8px' }}>Hạn dùng</th>
                    <th style={{ padding: '12px 8px', textAlign: 'right' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan="6" style={{ padding: '40px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        Không có người dùng nào khớp từ khóa.
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map(usr => {
                      const isUserExpired = usr.tier !== 'free' && usr.expiryDate && usr.expiryDate < Date.now();
                      return (
                        <tr key={usr.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <td data-label="Email" style={{ padding: '14px 8px', fontWeight: '500', color: usr.id === user.uid ? '#3b82f6' : '#fff' }}>
                            {usr.email}
                            {usr.id === user.uid && <span style={{ fontSize: '0.65rem', marginLeft: '6px', color: '#3b82f6', background: 'rgba(59,130,246,0.1)', padding: '2px 4px', borderRadius: '4px' }}>Tôi</span>}
                            {usr.pendingPayment && (
                              <div style={{ fontSize: '0.65rem', color: '#fbbf24', marginTop: '2px', fontWeight: 'bold' }}>
                                Đang chờ: {usr.pendingPayment.code} ({usr.pendingPayment.amount?.toLocaleString('vi-VN')}đ)
                              </div>
                            )}
                          </td>
                          <td data-label="Quyền" style={{ padding: '14px 8px' }}>
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
                          <td data-label="Quyền Drama" style={{ padding: '14px 8px' }}>
                            <button
                              onClick={async () => {
                                try {
                                  await setDoc(doc(db, 'users', usr.id), { hasDramaAccess: !usr.hasDramaAccess }, { merge: true });
                                } catch (err) {
                                  console.error("Error toggling drama access:", err);
                                }
                              }}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                padding: 0,
                                display: 'flex',
                                alignItems: 'center'
                              }}
                              title={usr.hasDramaAccess ? "Thu hồi quyền Drama" : "Cấp quyền Drama"}
                            >
                              {usr.hasDramaAccess ? (
                                <span style={{ background: 'rgba(236,72,153,0.1)', color: '#ec4899', padding: '2px 6px', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                  <Check size={10} /> Có quyền
                                </span>
                              ) : (
                                <span style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', padding: '2px 6px', borderRadius: '4px', fontSize: '0.68rem' }}>
                                  Không có
                                </span>
                              )}
                            </button>
                          </td>
                          <td data-label="Gói cước" style={{ padding: '14px 8px' }}>
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
                              <option value="hocvien">Học viên (30 ảnh/ngày)</option>
                              <option value="basic_69k">Basic (69k)</option>
                              <option value="premium_169k">Premium (199k)</option>
                            </select>
                          </td>
                          <td data-label="Hạn dùng" style={{ padding: '14px 8px', color: isUserExpired ? '#ef4444' : 'var(--text-secondary)' }}>
                            {usr.tier === 'free' ? 'N/A' : (
                              usr.expiryDate ? (
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span>{new Date(usr.expiryDate).toLocaleDateString('vi-VN')}</span>
                                  {isUserExpired && <span style={{ fontSize: '0.65rem', fontWeight: 'bold' }}>(Hết hạn)</span>}
                                </div>
                              ) : 'Không giới hạn'
                            )}
                          </td>
                          <td data-label="Thao tác" data-actions style={{ padding: '14px 8px', textAlign: 'right' }}>
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
            {!adminSearchQuery.trim() && adminUsersList.length >= adminUsersLimit && (
              <div style={{ textAlign: 'center', marginTop: '8px' }}>
                <button
                  onClick={() => setAdminUsersLimit(l => l + 10)}
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#ececf1', borderRadius: '10px', padding: '10px 24px', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer' }}
                >
                  ⏬ Tải thêm người dùng (đang hiện {adminUsersList.length})
                </button>
              </div>
            )}
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
                  <option value="30000">30,000đ (Bù Basic)</option>
                  <option value="69000">69,000đ (Gói Cơ bản)</option>
                  <option value="199000">199,000đ (Gói Premium)</option>
                  <option value="100000">100,000đ (Bù Basic &rarr; Premium)</option>
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
        )}

        {/* Payments Tab */}
        {adminTab === 'payments' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '20px', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', margin: 0 }}>Quản lý Nạp tiền</h2>
              <input
                type="text"
                placeholder="🔍 Tìm email / mã GD / user / gói..."
                value={adminPaymentSearchQuery}
                onChange={(e) => setAdminPaymentSearchQuery(e.target.value)}
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

            {/* Sub-tabs: Pending / Success */}
            <div style={{ display: 'flex', gap: '8px' }}>
              {[
                { key: 'pending', label: `⏳ Đang chờ (${pendingPaymentsCount})` },
                { key: 'success', label: `✅ Thành công (${adminPaymentsList.length})` }
              ].map(t => (
                <button
                  key={t.key}
                  onClick={() => setAdminPaymentTab(t.key)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1,
                    padding: '10px 18px', borderRadius: '10px', cursor: 'pointer',
                    fontSize: '0.85rem', fontWeight: 'bold',
                    background: adminPaymentTab === t.key ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: adminPaymentTab === t.key ? '#fff' : 'var(--text-secondary)',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {adminPaymentTab === 'pending' && (<>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: '1.4', margin: 0 }}>
              Danh sách user đang có mã giao dịch chờ thanh toán. Khi user chuyển khoản xong, hệ thống tự nhận webhook từ ngân hàng — nếu chưa nhận, bạn có thể bấm <b>Xác nhận</b> để duyệt thủ công, hoặc <b>Hủy</b> nếu giao dịch không hợp lệ.
            </p>

            <h3 style={{ fontSize: '1rem', fontWeight: 'bold', margin: '8px 0 0' }}>⏳ Đang chờ thanh toán</h3>

            <div className="admin-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="admin-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '12px 8px' }}>User</th>
                    <th style={{ padding: '12px 8px' }}>Mã giao dịch</th>
                    <th style={{ padding: '12px 8px' }}>Gói nâng cấp</th>
                    <th style={{ padding: '12px 8px' }}>Số tiền</th>
                    <th style={{ padding: '12px 8px' }}>Thời gian chờ</th>
                    <th style={{ padding: '12px 8px', textAlign: 'right' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingPaymentsCount === 0 ? (
                    <tr>
                      <td colSpan="6" style={{ padding: '20px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        Không có giao dịch nào đang chờ. 🎉
                      </td>
                    </tr>
                  ) : (
                    adminUsersList
                      .filter(u => u.pendingPayment && u.pendingPayment.code)
                      .map(usr => {
                        const pp = usr.pendingPayment;
                        const waitMs = Date.now() - (pp.createdAt || Date.now());
                        const waitLabel = waitMs > 0 ? `${Math.floor(waitMs / 60000)}p ${Math.floor(waitMs % 60000 / 1000)}s` : 'Vừa mới';
                        return (
                          <tr key={usr.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                            <td data-label="User" style={{ padding: '14px 8px' }}>
                              <div style={{ fontWeight: '500', color: '#fff' }}>{usr.email || usr.id}</div>
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{usr.id}</div>
                            </td>
                            <td data-label="Mã GD" style={{ padding: '14px 8px', fontFamily: 'monospace', fontWeight: 'bold', color: '#fbbf24' }}>{pp.code}</td>
                            <td data-label="Gói" style={{ padding: '14px 8px' }}>{pp.tier}</td>
                            <td data-label="Số tiền" style={{ padding: '14px 8px', fontWeight: 'bold' }}>{Number(pp.amount || 0).toLocaleString('vi-VN')}đ</td>
                            <td data-label="Chờ" style={{ padding: '14px 8px', color: waitMs > 3600000 ? '#ef4444' : 'var(--text-secondary)' }}>{waitLabel}</td>
                            <td data-label="Thao tác" data-actions style={{ padding: '14px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <button
                                onClick={() => handleAdminConfirmPayment(usr.id, pp)}
                                disabled={simulateLoading}
                                style={{
                                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                                  border: 'none', borderRadius: '6px', padding: '6px 12px',
                                  fontSize: '0.72rem', fontWeight: 'bold', color: '#fff',
                                  cursor: 'pointer', marginRight: '6px', display: 'inline-flex', alignItems: 'center', gap: '4px'
                                }}
                              >
                                {simulateLoading ? <Loader size={10} className="spin-loader" /> : <Check size={10} />}
                                Xác nhận
                              </button>
                              <button
                                onClick={() => handleAdminCancelPayment(usr.id)}
                                style={{
                                  background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                                  borderRadius: '6px', padding: '6px 12px', fontSize: '0.72rem',
                                  fontWeight: 'bold', color: '#ef4444', cursor: 'pointer'
                                }}
                              >
                                Hủy
                              </button>
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
            </>)}

            {adminPaymentTab === 'success' && (<>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 'bold', margin: 0 }}>✅ Lịch sử nạp thành công</h3>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {[
                  { key: 'all', label: `Tất cả (${filteredPayments.length})` },
                  { key: 'webhook', label: `Webhook (${filteredPayments.filter(p => p.source === 'webhook').length})` },
                  { key: 'admin', label: `Thủ công (${filteredPayments.filter(p => p.source === 'admin').length})` }
                ].map(f => (
                  <button
                    key={f.key}
                    onClick={() => setAdminPaymentFilter(f.key)}
                    style={{
                      padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '0.72rem',
                      fontWeight: 'bold', border: '1px solid rgba(255,255,255,0.08)',
                      background: adminPaymentFilter === f.key ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.03)',
                      color: adminPaymentFilter === f.key ? '#10b981' : 'var(--text-secondary)'
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="admin-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="admin-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '10px 8px' }}>User</th>
                    <th style={{ padding: '10px 8px' }}>Mã giao dịch</th>
                    <th style={{ padding: '10px 8px' }}>Gói</th>
                    <th style={{ padding: '10px 8px' }}>Số tiền</th>
                    <th style={{ padding: '10px 8px' }}>Nguồn</th>
                    <th style={{ padding: '10px 8px' }}>Thời gian</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPayments.length === 0 ? (
                    <tr>
                      <td colSpan="6" style={{ padding: '30px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        {adminPaymentsList.length === 0 ? 'Chưa có giao dịch thành công nào. Các giao dịch webhook từ giờ sẽ được ghi lại ở đây.' : 'Không tìm thấy giao dịch phù hợp.'}
                      </td>
                    </tr>
                  ) : (
                    filteredPayments
                      .filter(p => adminPaymentFilter === 'all' || p.source === adminPaymentFilter)
                      .map(p => (
                      <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td data-label="User" style={{ padding: '10px 8px' }}>
                          <div style={{ fontWeight: '500', color: '#fff' }}>{p.email || '—'}</div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{p.userId}</div>
                        </td>
                        <td data-label="Mã GD" style={{ padding: '10px 8px', fontFamily: 'monospace', fontWeight: 'bold', color: '#10b981' }}>{p.code}</td>
                        <td data-label="Gói" style={{ padding: '10px 8px' }}>{p.tier}</td>
                        <td data-label="Số tiền" style={{ padding: '10px 8px', fontWeight: 'bold' }}>{Number(p.amount || 0).toLocaleString('vi-VN')}đ</td>
                        <td data-label="Nguồn" style={{ padding: '10px 8px' }}>
                          <span style={{ background: p.source === 'admin' ? 'rgba(59,130,246,0.1)' : 'rgba(16,185,129,0.1)', color: p.source === 'admin' ? '#3b82f6' : '#10b981', padding: '2px 8px', borderRadius: '999px', fontSize: '0.68rem', fontWeight: 'bold' }}>
                            {p.source === 'admin' ? 'Thủ công' : 'Webhook'}
                          </span>
                        </td>
                        <td data-label="Thời gian" style={{ padding: '10px 8px', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                          {p.createdAt ? new Date(p.createdAt).toLocaleString('vi-VN') : '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {!adminPaymentSearchQuery.trim() && adminPaymentsList.length >= adminPaymentsLimit && (
              <div style={{ textAlign: 'center', marginTop: '8px' }}>
                <button
                  onClick={() => setAdminPaymentsLimit(l => l + 10)}
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#ececf1', borderRadius: '10px', padding: '10px 24px', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer' }}
                >
                  ⏬ Tải thêm giao dịch (đang hiện {adminPaymentsList.length})
                </button>
              </div>
            )}
            {adminPaymentsList.length === 0 && (
              <div style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Các giao dịch webhook từ giờ sẽ được ghi lại ở đây.
              </div>
            )}
            </>)}
          </div>
        )}

        {/* Tasks Tab */}
        {adminTab === 'tasks' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '20px', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', margin: 0 }}>Quản lý Tasks</h2>
              <input
                type="text"
                placeholder="🔍 Tìm ID / user / prompt / trạng thái..."
                value={adminTaskSearchQuery}
                onChange={(e) => setAdminTaskSearchQuery(e.target.value)}
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

              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {[
                  { key: 'all', label: `Tất cả (${filteredTasks.length})` },
                  { key: 'pending', label: `Chờ (${filteredTasks.filter(t => t.status === 'pending').length})` },
                  { key: 'processing', label: `Đang xử lý (${filteredTasks.filter(t => t.status === 'generating' || t.status === 'processing').length})` },
                  { key: 'completed', label: `Thành công (${filteredTasks.filter(t => t.status === 'completed').length})` },
                  { key: 'failed', label: `Thất bại (${filteredTasks.filter(t => t.status === 'failed').length})` }
                ].map(f => (
                  <button
                    key={f.key}
                    onClick={() => setAdminTaskFilter(f.key)}
                    style={{
                      padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '0.72rem',
                      fontWeight: 'bold', border: '1px solid rgba(255,255,255,0.08)',
                      background: adminTaskFilter === f.key ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.03)',
                      color: adminTaskFilter === f.key ? '#3b82f6' : 'var(--text-secondary)'
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

            <div className="admin-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="admin-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '10px 8px' }}>Loại</th>
                    <th style={{ padding: '10px 8px' }}>ID</th>
                    <th style={{ padding: '10px 8px' }}>User</th>
                    <th style={{ padding: '10px 8px' }}>Prompt</th>
                    <th style={{ padding: '10px 8px' }}>Trạng thái</th>
                    <th style={{ padding: '10px 8px' }}>Thời gian</th>
                    <th style={{ padding: '10px 8px', textAlign: 'right' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.length === 0 ? (
                    <tr>
                      <td colSpan="7" style={{ padding: '40px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        {adminTasksList.length === 0 ? 'Chưa có task nào.' : 'Không tìm thấy task phù hợp.'}
                      </td>
                    </tr>
                  ) : (
                    filteredTasks
                      .filter(t => {
                        if (adminTaskFilter === 'all') return true;
                        if (adminTaskFilter === 'pending') return t.status === 'pending';
                        if (adminTaskFilter === 'processing') return t.status === 'generating' || t.status === 'processing';
                        if (adminTaskFilter === 'completed') return t.status === 'completed';
                        if (adminTaskFilter === 'failed') return t.status === 'failed';
                        return true;
                      })
                      .map(task => {
                        const statusColor = task.status === 'completed' ? '#10b981' : task.status === 'failed' ? '#ef4444' : task.status === 'pending' ? '#fbbf24' : '#3b82f6';
                        return (
                          <tr key={task.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                            <td data-label="Loại" style={{ padding: '10px 8px' }}>{task.type === 'video' ? '🎬' : '🖼️'}</td>
                            <td data-label="ID" style={{ padding: '10px 8px', fontFamily: 'monospace', fontSize: '0.72rem' }}>{task.id}</td>
                            <td data-label="User" style={{ padding: '10px 8px', fontSize: '0.72rem' }}>{task.userId || '-'}</td>
                            <td data-label="Prompt" data-full style={{ padding: '10px 8px', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                              {(task.prompt || '').slice(0, 60)}
                            </td>
                            <td data-label="Trạng thái" style={{ padding: '10px 8px' }}>
                              <span style={{ background: `${statusColor}1a`, color: statusColor, padding: '2px 8px', borderRadius: '999px', fontSize: '0.68rem', fontWeight: 'bold' }}>
                                {task.status}
                              </span>
                            </td>
                            <td data-label="Thời gian" style={{ padding: '10px 8px', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                              {task.createdAt ? new Date(task.createdAt).toLocaleString('vi-VN') : '-'}
                            </td>
                            <td data-label="Thao tác" data-actions style={{ padding: '10px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                              {task.error && task.status === 'failed' && (
                                <span title={task.error} style={{ cursor: 'help', color: '#ef4444', fontSize: '0.7rem', marginRight: '8px' }}>⚠️</span>
                              )}
                              <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '5px' }}>
                                <button
                                  onClick={() => handleDeleteTask(task.id)}
                                  style={{
                                    background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: '6px',
                                    padding: '5px 10px', fontSize: '0.7rem', fontWeight: 'bold', color: '#ef4444', cursor: 'pointer'
                                  }}
                                >
                                  Xóa
                                </button>
                                {canRetryTask(task) && task.userId === user.uid && (
                                  <button
                                    onClick={() => handleRetryTask(task.id)}
                                    disabled={retryingTaskId === task.id}
                                    style={{ background: 'rgba(59,130,246,0.12)', border: 'none', borderRadius: '6px', padding: '5px 10px', fontSize: '0.7rem', fontWeight: 'bold', color: '#60a5fa', cursor: retryingTaskId === task.id ? 'wait' : 'pointer' }}
                                  >
                                    {retryingTaskId === task.id ? 'Đang thử...' : 'Thử lại'}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
            {!adminTaskSearchQuery.trim() && adminTasksList.length >= adminTasksLimit && (
              <div style={{ textAlign: 'center', marginTop: '8px' }}>
                <button
                  onClick={() => setAdminTasksLimit(l => l + 10)}
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#ececf1', borderRadius: '10px', padding: '10px 24px', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer' }}
                >
                  ⏬ Tải thêm task (đang hiện {adminTasksList.length})
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    );
  };

  const updateAutoToolCharacter = (index, field, value) => {
    setAutoToolCharacters(current => current.map((character, characterIndex) => (
      characterIndex === index ? { ...character, [field]: value } : character
    )));
  };

  const updateAutoToolStyle = (field, value) => {
    setAutoToolStyle(current => ({ ...current, [field]: value }));
  };

  const updateAutoToolScene = (index, field, value) => {
    setAutoToolScenes(current => current.map((scene, sceneIndex) => (
      sceneIndex === index ? { ...scene, [field]: value } : scene
    )));
  };

  const handleAutoToolImageSelect = (index, event) => {
    const file = Array.from(event.target.files || []).find(selectedFile => selectedFile.type.startsWith('image/'));
    if (file) {
      setAutoToolCharacters(current => current.map((character, characterIndex) => {
        if (characterIndex !== index) return character;
        if (character.previewUrl) URL.revokeObjectURL(character.previewUrl);
        return { ...character, file, previewUrl: URL.createObjectURL(file) };
      }));
    }
    event.target.value = '';
  };

  const addAutoToolCharacter = () => {
    if (autoToolCharacters.length < 3) {
      setAutoToolCharacters(current => [...current, createEmptyAutoToolCharacter()]);
    }
  };

  const removeAutoToolCharacter = (index) => {
    if (autoToolCharacters.length <= 1) return;
    setAutoToolCharacters(current => {
      const character = current[index];
      if (character?.previewUrl) URL.revokeObjectURL(character.previewUrl);
      return current.filter((_, characterIndex) => characterIndex !== index);
    });
  };

  const addAutoToolScene = () => {
    if (autoToolScenes.length < 6) {
      setAutoToolScenes(current => [...current, createEmptyAutoToolScene()]);
    }
  };

  const removeAutoToolScene = (index) => {
    if (autoToolScenes.length <= 1) return;
    setAutoToolScenes(current => current.filter((_, sceneIndex) => sceneIndex !== index));
  };

  const openAutoToolProject = async (projectId) => {
    if (!user || autoToolSaving || autoToolCreating) return;
    setAutoToolProjectLoading(true);
    setAutoToolError(null);
    setAutoToolJobId(null);
    setAutoToolJob(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/autotool/projects/${projectId}`, {
        headers: authHeaders(token)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      if (!data.project) throw new Error('Máy chủ không trả về project.');
      const project = normalizeAutoToolProject(data.project);
      setAutoToolProject(project);
      applyAutoToolDraft(project);
      setAutoToolStep(1);
    } catch (error) {
      console.error('AutoTool project open failed:', error);
      setAutoToolError(error.message || 'Không thể mở project.');
    } finally {
      setAutoToolProjectLoading(false);
    }
  };

  const closeAutoToolProject = () => {
    if (autoToolSaving || autoToolCreating) return;
    setAutoToolProject(null);
    setAutoToolJobId(null);
    setAutoToolJob(null);
    setAutoToolError(null);
  };

  const createAutoToolProject = async () => {
    const name = autoToolTopic.trim();
    if (!name) {
      setAutoToolError('Vui lòng nhập tên project (chủ đề/series).');
      return;
    }
    if (autoToolSaving) return;
    setAutoToolSaving(true);
    setAutoToolError(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/autotool/projects`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      if (!data.project?.id) throw new Error('Máy chủ không trả về project mới.');
      setAutoToolTopic('');
      await openAutoToolProject(data.project.id);
    } catch (error) {
      console.error('AutoTool project creation failed:', error);
      setAutoToolError(error.message || 'Không thể tạo project.');
    } finally {
      setAutoToolSaving(false);
    }
  };

  const deleteAutoToolProject = async (projectId) => {
    if (autoToolSaving || autoToolCreating) return;
    if (!window.confirm('Xóa project này và toàn bộ cấu hình? Các tập đã tạo vẫn còn trên R2.')) return;
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/autotool/projects/${projectId}`, {
        method: 'DELETE',
        headers: authHeaders(token)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      setAutoToolProjects(current => current.filter(project => project.id !== projectId));
      if (autoToolProject?.id === projectId) setAutoToolProject(null);
    } catch (error) {
      console.error('AutoTool project delete failed:', error);
      setAutoToolError(error.message || 'Không thể xóa project.');
    }
  };

  const runAutoToolAi = async (action, { topic, characterIndex } = {}) => {
    if (!user || !autoToolProject || autoToolSaving || autoToolCreating) return;
    if (autoToolAiLoading) return;
    setAutoToolAiLoading(action);
    setAutoToolError(null);
    try {
      const token = await user.getIdToken();
      const body = topic !== undefined ? { topic } : (characterIndex !== undefined ? { characterIndex } : {});
      const response = await fetch(`${API_BASE}/api/autotool/projects/${autoToolProject.id}/ai/${action}`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);

      if (action === 'idea') {
        const draft = data.draft || {};
        const overview = draft.overview || autoToolTopic;
        setAutoToolTopic(overview);
        const characters = Array.isArray(draft.characters) && draft.characters.length
          ? draft.characters.map(character => ({
              name: character.name || '',
              age: character.age ?? '',
              description: character.description || '',
              imageUrl: '',
              file: null,
              previewUrl: ''
            }))
          : [createEmptyAutoToolCharacter()];
        autoToolCharactersRef.current = characters;
        setAutoToolCharacters(characters);
        setAutoToolStyle({ ...EMPTY_AUTO_TOOL_STYLE, ...(draft.style || {}) });
        setAutoToolProject(current => current ? { ...current, name: draft.name, overview: draft.overview, mode: draft.mode } : current);
      } else if (action === 'characters') {
        const characters = Array.isArray(data.characters) && data.characters.length
          ? data.characters.map(character => ({
              name: character.name || '',
              age: character.age ?? '',
              description: character.description || '',
              imageUrl: '',
              file: null,
              previewUrl: ''
            }))
          : [createEmptyAutoToolCharacter()];
        autoToolCharactersRef.current = characters;
        setAutoToolCharacters(characters);
      } else if (action === 'style') {
        setAutoToolStyle({ ...EMPTY_AUTO_TOOL_STYLE, ...(data.style || {}) });
      } else if (action === 'scenes') {
        const plan = data.plan || {};
        setAutoToolEpisodeTitle(plan.episodeTitle || '');
        setAutoToolScenes(Array.isArray(plan.scenes) && plan.scenes.length
          ? plan.scenes.map(scene => ({
              title: scene.title || '',
              imagePrompt: scene.imagePrompt || '',
              videoPrompt: scene.videoPrompt || ''
            }))
          : [createEmptyAutoToolScene()]);
      } else if (action === 'character-image') {
        if (data.imageUrl && Number.isInteger(characterIndex)) {
          setAutoToolCharacters(current => current.map((character, index) => (
            index === characterIndex ? { ...character, imageUrl: data.imageUrl } : character
          )));
          setAutoToolProject(current => current ? {
            ...current,
            characters: current.characters.map((character, index) => (
              index === characterIndex ? { ...character, imageUrl: data.imageUrl } : character
            )),
            characterImageUrls: current.characterImageUrls.map((url, index) => index === characterIndex ? data.imageUrl : url)
          } : current);
        }
      }
    } catch (error) {
      console.error(`AutoTool AI action "${action}" failed:`, error);
      setAutoToolError(error.message || 'Lỗi khi AI tạo bản nháp.');
    } finally {
      setAutoToolAiLoading(null);
    }
  };

  const handleAutoToolSave = async (fields) => {
    if (!user || !currentUserIsAdmin || autoToolSaving || autoToolCreating || !autoToolProject) return;

    if (fields.scenes) {
      const validScenes = autoToolScenes.length >= 1 && autoToolScenes.length <= 6 && autoToolScenes.every(scene => (
        scene.imagePrompt.trim() && scene.videoPrompt.trim()
      ));
      if (!validScenes) {
        setAutoToolError('Mỗi cảnh cần đủ imagePrompt và videoPrompt (1-6 cảnh).');
        return;
      }
    }

    setAutoToolSaving(true);
    setAutoToolError(null);
    try {
      const token = await user.getIdToken();
      const formData = new FormData();
      const characters = autoToolCharacters.map(character => ({
        name: character.name.trim(),
        age: String(character.age || '').trim(),
        description: character.description.trim(),
        imageUrl: character.imageUrl || ''
      }));
      const imageIndexes = [];

      formData.append('name', fields.name !== undefined ? fields.name : (autoToolProject.name || ''));
      formData.append('overview', fields.overview !== undefined ? fields.overview : (autoToolProject.overview || ''));
      formData.append('mode', fields.mode !== undefined ? fields.mode : (autoToolProject.mode || 'series'));
      formData.append('artStyle', fields.style !== undefined ? autoToolStyle.artStyle : (autoToolProject.style?.artStyle || ''));
      formData.append('colorPalette', fields.style !== undefined ? autoToolStyle.colorPalette : (autoToolProject.style?.colorPalette || ''));
      formData.append('mood', fields.style !== undefined ? autoToolStyle.mood : (autoToolProject.style?.mood || ''));
      formData.append('lighting', fields.style !== undefined ? autoToolStyle.lighting : (autoToolProject.style?.lighting || ''));
      formData.append('camera', fields.style !== undefined ? autoToolStyle.camera : (autoToolProject.style?.camera || ''));
      formData.append('characters', JSON.stringify(characters));
      autoToolCharacters.forEach((character, index) => {
        if (!character.file) return;
        imageIndexes.push(index);
        formData.append('characterImages', character.file);
      });
      formData.append('imageIndexes', JSON.stringify(imageIndexes));
      if (fields.scenes !== undefined) {
        formData.append('scenes', JSON.stringify(autoToolScenes.map(scene => ({
          title: scene.title.trim(),
          imagePrompt: scene.imagePrompt.trim(),
          videoPrompt: scene.videoPrompt.trim()
        }))));
      }

      const response = await fetch(`${API_BASE}/api/autotool/projects/${autoToolProject.id}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: formData
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      if (!data.project) throw new Error('Máy chủ không trả về project đã lưu.');

      const project = normalizeAutoToolProject({ ...data.project, id: autoToolProject.id });
      setAutoToolProject(project);
      applyAutoToolDraft(project);
      setAutoToolProjects(current => current.map(existing => existing.id === project.id ? project : existing));
      return project;
    } catch (error) {
      console.error('AutoTool project saving failed:', error);
      setAutoToolError(error.message || 'Không thể lưu project.');
    } finally {
      setAutoToolSaving(false);
    }
    return null;
  };

  const handleAutoToolCreateJob = async () => {
    if (!user || !currentUserIsAdmin || !autoToolProject || autoToolSaving || autoToolCreating) return;
    if (!autoToolScenes.length || !autoToolProject.characters.every(character => character.imageUrl)) {
      setAutoToolError('Cần đủ ảnh nhân vật và kịch bản cảnh trước khi tạo tập.');
      return;
    }

    setAutoToolCreating(true);
    setAutoToolError(null);
    setAutoToolJobId(null);
    setAutoToolJob(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/autotool/jobs`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: autoToolProject.id })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      if (!data.jobId) throw new Error('Máy chủ không trả về mã công việc.');

      setAutoToolJobId(data.jobId);
      setAutoToolJob({ status: data.status || 'Đang khởi tạo', episodeNumber: data.episodeNumber });
    } catch (error) {
      console.error('AutoTool job creation failed:', error);
      setAutoToolError(error.message || 'Không thể tạo tập mới. Vui lòng thử lại.');
    } finally {
      setAutoToolCreating(false);
    }
  };

  const createDramaScript = async () => {
    if (dramaSaving) return;
    setDramaSaving(true);
    setDramaError(null);
    try {
      const token = await user.getIdToken();
      const topic = dramaTopic.trim();
      const response = await fetch(`${API_BASE}/api/drama/scripts`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, channelType })
      });
      const data = await response.json();
      const normalized = normalizeDramaScript({ ...data.script, id: data.script.id });
      setDramaScript(normalized);
      setDramaScriptSavedState(normalized);
      setDramaScripts(current => [normalized, ...current]);
    } catch (error) {
      console.error('Drama script creation failed:', error);
      setDramaError(error.message || 'Không thể tạo kịch bản.');
    } finally {
      setDramaSaving(false);
    }
  };

  const generateDramaScript = async () => {
    if (!user || !dramaScript?.id || dramaAiLoading || dramaSaving) return;
    setDramaAiLoading(true);
    setDramaError(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/drama/scripts/${dramaScript.id}/ai/generate`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: dramaTopic || dramaScript.topic, channelType })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      if (!data.script) throw new Error('Máy chủ không trả về kịch bản.');
      const normalized = normalizeDramaScript({ ...data.script, id: dramaScript.id });
      setDramaScript(normalized);
      setDramaScriptSavedState(normalized);
      setDramaScripts(current => current.map(script => script.id === dramaScript.id ? normalized : script));
    } catch (error) {
      console.error('Drama AI script generation failed:', error);
      setDramaError(error.message || 'AI chưa tạo được kịch bản. Vui lòng thử lại.');
    } finally {
      setDramaAiLoading(false);
    }
  };

  const saveDramaScript = async (fields = {}) => {
    if (!user || !dramaScript?.id || dramaSaving) return;
    setDramaSaving(true);
    setDramaError(null);
    try {
      const payload = {
        ...fields,
        status: fields.status || 'draft'
      };
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/drama/scripts/${dramaScript.id}`, {
        method: 'PUT',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      const normalized = normalizeDramaScript({ ...data.script, id: dramaScript.id });
      setDramaScript(normalized);
      setDramaScriptSavedState(normalized);
      setDramaScripts(current => current.map(script => script.id === dramaScript.id ? normalized : script));
    } catch (error) {
      console.error('Drama script save failed:', error);
      setDramaError(error.message || 'Không thể lưu kịch bản.');
    } finally {
      setDramaSaving(false);
    }
  };

  const deleteDramaScript = async (scriptId) => {
    if (!user || dramaSaving) return;
    if (!window.confirm('Xóa kịch bản này? Các video đã tạo vẫn còn trên R2.')) return;
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/drama/scripts/${scriptId}`, {
        method: 'DELETE',
        headers: authHeaders(token)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      setDramaScripts(current => current.filter(script => script.id !== scriptId));
      if (dramaScript?.id === scriptId) setDramaScript(null);
    } catch (error) {
      console.error('Drama script delete failed:', error);
      setDramaError(error.message || 'Không thể xóa kịch bản.');
    }
  };

  const restoreDramaJob = async (scriptId) => {
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/drama/scripts/${scriptId}/jobs/latest`, {
        headers: authHeaders(token)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Server returned code ${response.status}`);
      if (data.job) {
        setDramaJobId(data.job.id);
        setDramaJob(data.job);
        if (data.job.status === 'completed' || data.job.status === 'failed') {
          setDramaJobId(null);
          setDramaJob(data.job);
        }
      }
    } catch (error) {
      console.error('Drama job restore failed:', error);
    }
  };

  const openDramaScript = async (scriptId) => {
    if (!user || dramaScriptLoading) return;
    setDramaScriptLoading(true);
    setDramaError(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/drama/scripts/${scriptId}`, {
        headers: authHeaders(token)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      const normalized = normalizeDramaScript({ ...data.script, id: scriptId });
      setDramaScript(normalized);
      setDramaScriptSavedState(normalized);
      setDramaTopic(normalized.topic || '');
      await restoreDramaJob(scriptId);
    } catch (error) {
      console.error('Drama script open failed:', error);
      setDramaError(error.message || 'Không thể mở kịch bản.');
    } finally {
      setDramaScriptLoading(false);
    }
  };

  const closeDramaScript = () => {
    setDramaScript(null);
    setDramaScriptSavedState(null);
    setDramaJobId(null);
    setDramaJob(null);
    setDramaError(null);
    setDramaTopic('');
  };

  const handleDramaCreateJob = async () => {
    if (!user || !dramaScript?.id || dramaCreating) return;
    if (!dramaScript.title || !dramaScript.scenes.length) {
      setDramaError('Cần có tiêu đề và kịch bản cảnh trước khi tạo video.');
      return;
    }
    setDramaCreating(true);
    setDramaError(null);
    setDramaJobId(null);
    setDramaJob(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/drama/scripts/${dramaScript.id}/jobs`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      if (!data.jobId) throw new Error('Máy chủ không trả về mã công việc.');
      setDramaJobId(data.jobId);
      setDramaJob({ status: data.status || 'Đang khởi tạo', episodeNumber: data.episodeNumber });
    } catch (error) {
      console.error('Drama job creation failed:', error);
      setDramaError(error.message || 'Không thể tạo video. Vui lòng thử lại.');
    } finally {
      setDramaCreating(false);
    }
  };

  const cancelDramaJob = async (jobId) => {
    if (!user || !jobId) return;
    if (window.confirm('Bạn có chắc chắn muốn dừng tác vụ này không?')) {
      try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/drama/jobs/${jobId}/cancel`, {
          method: 'POST',
          headers: authHeaders(token)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Server returned code ${response.status}`);
        
        setDramaJob(prev => prev ? { ...prev, status: 'failed', error: 'Đã dừng chạy.' } : null);
        setDramaJobId(null);
      } catch (error) {
        console.error('Cancel drama job failed:', error);
        setDramaError(error.message || 'Không thể dừng tác vụ.');
      }
    }
  };

  const handleDramaSceneMedia = async (sceneIndex, mediaType) => {
    if (!user || !dramaScript?.id || dramaSceneBusy[`${sceneIndex}:${mediaType}`]) return;
    setDramaSceneBusy(current => ({ ...current, [`${sceneIndex}:${mediaType}`]: true }));
    setDramaError(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/api/drama/scripts/${dramaScript.id}/scenes/${sceneIndex}/${mediaType}`, {
        method: 'POST',
        headers: authHeaders(token)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Server returned code ${response.status}`);
      setDramaScript(current => {
        const scenes = [...current.scenes];
        scenes[sceneIndex] = {
          ...scenes[sceneIndex],
          [`${mediaType}Status`]: 'processing',
          [`${mediaType}TaskId`]: data.taskId || scenes[sceneIndex][`${mediaType}TaskId`]
        };
        return { ...current, scenes };
      });
    } catch (error) {
      console.error('Drama scene media failed:', error);
      setDramaError(error.message || 'Không thể tạo media cho cảnh này.');
    } finally {
      setDramaSceneBusy(current => ({ ...current, [`${sceneIndex}:${mediaType}`]: false }));
    }
  };

  // Poll the script doc while any scene is processing, to surface media URLs.
  useEffect(() => {
    if (!user || !dramaScript?.id) return;
    const processingScenes = (dramaScript.scenes || []).some(scene =>
      scene.imageStatus === 'processing' || scene.videoStatus === 'processing'
    );
    if (!processingScenes) return;
    let cancelled = false;
    let interval = null;

    const fetchScript = async () => {
      try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/drama/scripts/${dramaScript.id}`, {
          headers: authHeaders(token)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Server returned code ${response.status}`);
        if (cancelled) return;
        const normalized = normalizeDramaScript({ ...data.script, id: dramaScript.id });
        setDramaScript(current => {
          if (!current) return normalized;
          const mergedScenes = (current.scenes || []).map((scene, index) => {
            const remoteScene = normalized.scenes[index];
            if (!remoteScene) return scene;
            return {
              ...scene,
              imageUrl: remoteScene.imageUrl || scene.imageUrl,
              videoUrl: remoteScene.videoUrl || scene.videoUrl,
              imageTaskId: remoteScene.imageTaskId || scene.imageTaskId,
              videoTaskId: remoteScene.videoTaskId || scene.videoTaskId,
              imageStatus: remoteScene.imageStatus || scene.imageStatus,
              videoStatus: remoteScene.videoStatus || scene.videoStatus
            };
          });
          return { ...current, scenes: mergedScenes, updatedAt: normalized.updatedAt };
        });
        const stillProcessing = (normalized.scenes || []).some(scene =>
          scene.imageStatus === 'processing' || scene.videoStatus === 'processing'
        );
        if (!stillProcessing && interval) {
          clearInterval(interval);
          interval = null;
        }
      } catch (error) {
        console.error('Drama scene media polling failed:', error);
        if (!cancelled) setDramaError(error.message || 'Không thể theo dõi tiến trình tạo media cảnh.');
      }
    };

    fetchScript();
    interval = setInterval(fetchScript, 4000);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [dramaScript?.id, dramaScript?.scenes, user]);

  const renderToolsView = () => {
    return (
      <div className="container" style={{ maxWidth: '1000px', margin: '0 auto', padding: '40px 20px', display: 'flex', flexDirection: 'column', gap: '32px', color: '#fff' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <LayoutGrid size={28} style={{ color: '#a78bfa' }} />
              <h1 style={{ fontSize: 'clamp(1.8rem, 5vw, 2.2rem)', fontWeight: '800', margin: 0, background: 'linear-gradient(135deg, #a78bfa 0%, #f472b6 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Danh sách công cụ AI
              </h1>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '6px', margin: 0 }}>
              Khám phá và sử dụng các công cụ AI chuyên nghiệp hỗ trợ sáng tạo nội dung.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { window.location.hash = ''; }}
            className="glass-button"
            style={{ width: '40px', height: '40px', padding: 0, borderRadius: '50%', flexShrink: 0 }}
            title="Quay lại Trang chủ"
          >
            <ArrowLeft size={18} />
          </button>
        </div>

        {/* Title: Công cụ chung */}
        <div style={{ marginTop: '10px' }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: '800', color: '#a78bfa', margin: '0 0 16px 0', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            🛠️ Công cụ chung
          </h2>
          <div className="common-tools-grid">
            {/* Simple Button 1: Audio Tool */}
            <div 
              className="glass-panel common-tool-card" 
              onClick={() => { window.location.hash = '#audio'; }}
              style={{
                border: '1px solid rgba(16, 185, 129, 0.2)',
                background: 'rgba(16, 185, 129, 0.02)'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-3px)';
                e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.6)';
                e.currentTarget.style.boxShadow = '0 8px 25px rgba(16, 185, 129, 0.15)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.2)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <div className="card-info" style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <span className="card-emoji" style={{ fontSize: '2rem' }}>🎙️</span>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <h3 className="card-title" style={{ fontSize: '1.1rem', fontWeight: '700', margin: 0, color: '#10b981' }}>Audio AI</h3>
                  <p className="card-desc" style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '4px 0 0 0' }}>Nhân bản giọng đọc AI tiếng Việt</p>
                </div>
              </div>
              <span className="card-arrow" style={{ fontSize: '1.2rem', color: '#10b981' }}>➔</span>
            </div>

            {/* Simple Button 2: Video Merge Tool */}
            <div 
              className="glass-panel common-tool-card" 
              onClick={() => { window.location.hash = '#merge-video'; }}
              style={{
                border: '1px solid rgba(139, 92, 246, 0.2)',
                background: 'rgba(139, 92, 246, 0.02)'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-3px)';
                e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.6)';
                e.currentTarget.style.boxShadow = '0 8px 25px rgba(139, 92, 246, 0.15)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.2)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <div className="card-info" style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <span className="card-emoji" style={{ fontSize: '2rem' }}>🎬</span>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <h3 className="card-title" style={{ fontSize: '1.1rem', fontWeight: '700', margin: 0, color: '#a78bfa' }}>Ghép Video</h3>
                  <p className="card-desc" style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '4px 0 0 0' }}>Ghép nối các thước phim từ Thư viện</p>
                </div>
              </div>
              <span className="card-arrow" style={{ fontSize: '1.2rem', color: '#a78bfa' }}>➔</span>
            </div>
          </div>
        </div>

        {/* Title: Các dạng kênh */}
        <div style={{ marginTop: '20px' }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: '800', color: '#f472b6', margin: '0 0 16px 0', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            📺 Các dạng kênh AI
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '24px'
          }}>
            {/* Card 2: Drama Tool */}
            <div 
              className="glass-panel" 
              onClick={() => { window.location.hash = '#drama'; }}
              style={{
                padding: 0,
                overflow: 'hidden',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                border: '1px solid rgba(236, 72, 153, 0.2)',
                position: 'relative'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-6px)';
                e.currentTarget.style.borderColor = 'rgba(236, 72, 153, 0.6)';
                e.currentTarget.style.boxShadow = '0 12px 30px rgba(236, 72, 153, 0.15)';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1.05)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'rgba(236, 72, 153, 0.2)';
                e.currentTarget.style.boxShadow = 'none';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1)';
              }}
            >
              <div style={{ width: '100%', aspectRatio: '16/9', overflow: 'hidden', borderBottom: '1px solid rgba(236, 72, 153, 0.15)' }}>
                <img 
                  src="/drama_tool_preview.jpg" 
                  alt="Drama Tool Preview" 
                  className="tool-img"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.4s ease' }} 
                />
              </div>
              <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Clapperboard size={20} style={{ color: '#ec4899' }} />
                  <h3 style={{ fontSize: '1.2rem', fontWeight: '700', margin: 0, color: '#ec4899' }}>Xây Kênh Mẹ Chồng Nàng Dâu</h3>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: '1.5', margin: 0, flex: 1 }}>
                  Công cụ tự động hóa xây kênh drama mẹ chồng nàng dâu bằng AI. Tạo kịch bản kịch tính, tự vẽ ảnh và dựng video 9:16 nhép miệng (Lip-Sync) giọng đọc cực hay.
                </p>
                <button 
                  type="button" 
                  className="glass-button"
                  style={{ 
                    width: '100%', 
                    padding: '12px', 
                    background: 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
                    border: 'none',
                    color: '#fff',
                    fontWeight: 'bold',
                    marginTop: '10px'
                  }}
                >
                  Trải nghiệm ngay
                </button>
              </div>
            </div>

            {/* Card 3: Sumo Deer Tool */}
            <div 
              className="glass-panel" 
              onClick={() => { window.location.hash = '#sumo'; }}
              style={{
                padding: 0,
                overflow: 'hidden',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                border: '1px solid rgba(245, 158, 11, 0.2)',
                position: 'relative'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-6px)';
                e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.6)';
                e.currentTarget.style.boxShadow = '0 12px 30px rgba(245, 158, 11, 0.15)';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1.05)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.2)';
                e.currentTarget.style.boxShadow = 'none';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1)';
              }}
            >
              <div style={{ width: '100%', aspectRatio: '16/9', overflow: 'hidden', borderBottom: '1px solid rgba(245, 158, 11, 0.15)' }}>
                <img 
                  src="/sumo_tool_preview.jpg" 
                  alt="Sumo Tool Preview" 
                  className="tool-img"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.4s ease' }} 
                />
              </div>
              <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.25rem' }}>🦌</span>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: '700', margin: 0, color: '#f59e0b' }}>Xây Kênh Gạc Hươu Sumo</h3>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: '1.5', margin: 0, flex: 1 }}>
                  Công cụ tự động hóa xây kênh chia sẻ kiến thức dinh dưỡng cho bé. Sử dụng nhân vật hươu Sumo thông thái và em bé để tạo kịch bản học tập vui nhộn.
                </p>
                <button 
                  type="button" 
                  className="glass-button"
                  style={{ 
                    width: '100%', 
                    padding: '12px', 
                    background: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
                    border: 'none',
                    color: '#fff',
                    fontWeight: 'bold',
                    marginTop: '10px'
                  }}
                >
                  Trải nghiệm ngay
                </button>
              </div>
            </div>

            {/* Card 4: Fashion Transformation (Thời trang Biến hình) - View Only */}
            <div 
              className="glass-panel" 
              style={{
                padding: 0,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                border: '1px solid rgba(168, 85, 247, 0.2)',
                position: 'relative'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-6px)';
                e.currentTarget.style.borderColor = 'rgba(168, 85, 247, 0.6)';
                e.currentTarget.style.boxShadow = '0 12px 30px rgba(168, 85, 247, 0.15)';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1.05)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'rgba(168, 85, 247, 0.2)';
                e.currentTarget.style.boxShadow = 'none';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1)';
              }}
            >
              <div style={{ width: '100%', aspectRatio: '16/9', overflow: 'hidden', borderBottom: '1px solid rgba(168, 85, 247, 0.15)' }}>
                <img 
                  src="/transform_preview.jpg" 
                  alt="Thời trang biến hình" 
                  className="tool-img"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.4s ease' }} 
                />
              </div>
              <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.25rem' }}>👗</span>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: '700', margin: 0, color: '#a855f7' }}>Thời Trang Biến Hình AI</h3>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: '1.5', margin: 0, flex: 1 }}>
                  Biến hình ảo diệu từ trang phục ngủ, mặc nhà sang các bộ đầm dạ tiệc lộng lẫy phong cách hoạt hình 3D Pixar, tạo clip Before/After triệu view.
                </p>
                <button 
                  type="button" 
                  disabled
                  className="glass-button"
                  style={{ 
                    width: '100%', 
                    padding: '12px', 
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px dashed rgba(168, 85, 247, 0.3)',
                    color: 'rgba(255, 255, 255, 0.4)',
                    fontWeight: 'bold',
                    marginTop: '10px',
                    cursor: 'not-allowed'
                  }}
                >
                  Sắp ra mắt
                </button>
              </div>
            </div>

            {/* Card 5: Accessories & Bags (Giày Dép - Túi Xách) - View Only */}
            <div 
              className="glass-panel" 
              style={{
                padding: 0,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                border: '1px solid rgba(249, 115, 22, 0.2)',
                position: 'relative'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-6px)';
                e.currentTarget.style.borderColor = 'rgba(249, 115, 22, 0.6)';
                e.currentTarget.style.boxShadow = '0 12px 30px rgba(249, 115, 22, 0.15)';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1.05)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'rgba(249, 115, 22, 0.2)';
                e.currentTarget.style.boxShadow = 'none';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1)';
              }}
            >
              <div style={{ width: '100%', aspectRatio: '16/9', overflow: 'hidden', borderBottom: '1px solid rgba(249, 115, 22, 0.15)' }}>
                <img 
                  src="/accessory_preview.jpg" 
                  alt="Giày dép túi xách" 
                  className="tool-img"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.4s ease' }} 
                />
              </div>
              <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.25rem' }}>👜</span>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: '700', margin: 0, color: '#f97316' }}>Giày Dép - Túi Xách AI</h3>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: '1.5', margin: 0, flex: 1 }}>
                  Chỉ cần cung cấp 1 ảnh sản phẩm túi xách, giày dép hoặc đồng hồ để tạo ra hàng loạt các video quảng bá POV 3D cận cảnh, lifestyle ấn tượng.
                </p>
                <button 
                  type="button" 
                  disabled
                  className="glass-button"
                  style={{ 
                    width: '100%', 
                    padding: '12px', 
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px dashed rgba(249, 115, 22, 0.3)',
                    color: 'rgba(255, 255, 255, 0.4)',
                    fontWeight: 'bold',
                    marginTop: '10px',
                    cursor: 'not-allowed'
                  }}
                >
                  Sắp ra mắt
                </button>
              </div>
            </div>

            {/* Card 6: Home Appliances Showroom (Gia dụng Kho Xưởng) - View Only */}
            <div 
              className="glass-panel" 
              style={{
                padding: 0,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                border: '1px solid rgba(59, 130, 246, 0.2)',
                position: 'relative'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-6px)';
                e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.6)';
                e.currentTarget.style.boxShadow = '0 12px 30px rgba(59, 130, 246, 0.15)';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1.05)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.2)';
                e.currentTarget.style.boxShadow = 'none';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1)';
              }}
            >
              <div style={{ width: '100%', aspectRatio: '16/9', overflow: 'hidden', borderBottom: '1px solid rgba(59, 130, 246, 0.15)' }}>
                <img 
                  src="/appliances_preview.jpg" 
                  alt="Gia dụng kho xưởng" 
                  className="tool-img"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.4s ease' }} 
                />
              </div>
              <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.25rem' }}>📺</span>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: '700', margin: 0, color: '#3b82f6' }}>Gia Dụng Kho Xưởng AI</h3>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: '1.5', margin: 0, flex: 1 }}>
                  Tự động lên kịch bản, lồng tiếng và sinh video giới thiệu review đồ gia dụng tại kho xưởng, cửa hàng, tủ bếp với bối cảnh chân thực 3D.
                </p>
                <button 
                  type="button" 
                  disabled
                  className="glass-button"
                  style={{ 
                    width: '100%', 
                    padding: '12px', 
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px dashed rgba(59, 130, 246, 0.3)',
                    color: 'rgba(255, 255, 255, 0.4)',
                    fontWeight: 'bold',
                    marginTop: '10px',
                    cursor: 'not-allowed'
                  }}
                >
                  Sắp ra mắt
                </button>
              </div>
            </div>

            {/* Card 7: Snacks & Drinks (Ăn vặt & Đồ uống) - View Only */}
            <div 
              className="glass-panel" 
              style={{
                padding: 0,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                border: '1px solid rgba(236, 72, 153, 0.2)',
                position: 'relative'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-6px)';
                e.currentTarget.style.borderColor = 'rgba(236, 72, 153, 0.6)';
                e.currentTarget.style.boxShadow = '0 12px 30px rgba(236, 72, 153, 0.15)';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1.05)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'rgba(236, 72, 153, 0.2)';
                e.currentTarget.style.boxShadow = 'none';
                const img = e.currentTarget.querySelector('.tool-img');
                if (img) img.style.transform = 'scale(1)';
              }}
            >
              <div style={{ width: '100%', aspectRatio: '16/9', overflow: 'hidden', borderBottom: '1px solid rgba(236, 72, 153, 0.15)' }}>
                <img 
                  src="/snacks_preview.jpg" 
                  alt="Ăn vặt đồ uống" 
                  className="tool-img"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.4s ease' }} 
                />
              </div>
              <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.25rem' }}>🧋</span>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: '700', margin: 0, color: '#ec4899' }}>Ăn Vặt & Đồ Uống AI</h3>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: '1.5', margin: 0, flex: 1 }}>
                  Tạo video review ẩm thực hấp dẫn từ POV cầm cốc trà sữa, mở hộp thức ăn vặt bốc khói, nhai giòn rụm kích thích giác quan.
                </p>
                <button 
                  type="button" 
                  disabled
                  className="glass-button"
                  style={{ 
                    width: '100%', 
                    padding: '12px', 
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px dashed rgba(236, 72, 153, 0.3)',
                    color: 'rgba(255, 255, 255, 0.4)',
                    fontWeight: 'bold',
                    marginTop: '10px',
                    cursor: 'not-allowed'
                  }}
                >
                  Sắp ra mắt
                </button>
              </div>
            </div>

          </div>

        </div>
      </div>
    );
  };

  const renderDramaView = () => {
    const progress = dramaJob?.progress;
    const numericProgress = typeof progress === 'number'
      ? Math.max(0, Math.min(100, progress <= 1 ? progress * 100 : progress))
      : null;
    const scenes = Array.isArray(dramaJob?.scenes) ? dramaJob.scenes : [];
    const jobError = dramaJob?.error;
    const errorText = typeof jobError === 'string'
      ? jobError
      : jobError ? JSON.stringify(jobError) : dramaError;

    const isJobRunning = dramaJob && dramaJob.status !== 'completed' && dramaJob.status !== 'failed';
    const isDramaChanged = JSON.stringify(dramaScript) !== JSON.stringify(dramaScriptSavedState);
    const hasDramaContent = dramaScript && String(dramaScript.title || '').trim() && Array.isArray(dramaScript.scenes) && dramaScript.scenes.length > 0;
    const isSaveEnabled = isDramaChanged && hasDramaContent && !dramaSaving;

    return (
      <div className="container" style={{ maxWidth: '920px', margin: '0 auto', padding: '24px 20px 140px 20px', display: 'flex', flexDirection: 'column', gap: '20px', color: '#fff' }}>
        
        {/* Sticky Header Panel */}
        <div style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'rgba(18,18,20,0.96)',
          backdropFilter: 'blur(16px)',
          margin: '0 -20px',
          padding: '20px 20px 14px 20px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Sparkles size={28} style={{ color: '#f472b6' }} />
                <h1 style={{ fontSize: 'clamp(1.6rem, 5vw, 2rem)', fontWeight: '800', margin: 0 }}>Drama Tool</h1>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '4px', margin: 0 }}>Tạo video drama gia đình bằng AI.</p>
            </div>
            <button
              type="button"
              onClick={() => { if (dramaScript) closeDramaScript(); else window.location.hash = ''; }}
              className="glass-button"
              style={{ width: '40px', height: '40px', padding: 0, borderRadius: '50%', flexShrink: 0 }}
              title={dramaScript ? "Quay lại danh sách kịch bản" : "Quay lại Workspace"}
            >
              <ArrowLeft size={18} />
            </button>
          </div>

          {/* Sticky Editor Actions Header when script is open */}
          {dramaScript && (
            <div className="glass-panel" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px', background: 'rgba(255,255,255,0.01)', border: 'none', margin: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                <div>
                  <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{dramaScript.title || '(Chưa có tiêu đề)'}</h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '3px 0 0' }}>
                    Chủ đề: {dramaScript.topic || (channelType === 'sumo' ? 'Gạc Hươu Sumo' : 'mẹ chồng nàng dâu')} · {dramaScript.scenes.length} cảnh · {dramaScript.characters.length} nhân vật
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button type="button" className="glass-button" onClick={generateDramaScript} disabled={dramaAiLoading || dramaSaving || isJobRunning} style={{ flex: 1, padding: '12px 18px', background: (dramaAiLoading || isJobRunning) ? undefined : (channelType === 'sumo' ? 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)' : 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)'), opacity: (dramaAiLoading || dramaSaving || isJobRunning) ? 0.4 : 1, fontSize: '0.82rem' }}>
                  {dramaAiLoading ? <Loader size={15} className="spin-loader" /> : <Sparkles size={15} />} {dramaScript.title ? 'Sinh lại kịch bản' : 'Sinh kịch bản bằng AI'}
                </button>
                <button type="button" className="glass-button" onClick={handleDramaCreateJob} disabled={dramaCreating || !dramaScript.title || !dramaScript.scenes.length || isJobRunning} style={{ flex: 1, padding: '12px 18px', background: (dramaCreating || isJobRunning) ? undefined : 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)', opacity: (dramaCreating || !dramaScript.title || !dramaScript.scenes.length || isJobRunning) ? 0.4 : 1, fontSize: '0.82rem' }}>
                  {dramaCreating ? <Loader size={15} className="spin-loader" /> : <Video size={15} />} Tạo video ({dramaScript.scenes.length} cảnh)
                </button>
              </div>

              {/* Active Progress panel stays sticky below action buttons */}
              {errorText && (
                <div className="glass-panel" style={{ padding: '10px 12px', borderColor: 'rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.06)', color: '#fca5a5', fontSize: '0.78rem', margin: 0 }}>
                  {errorText}
                </div>
              )}

              {dramaJob && (
                <div className="glass-panel" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', borderColor: 'rgba(167,139,250,0.35)', background: 'rgba(167,139,250,0.02)', margin: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Video size={16} style={{ color: '#a78bfa' }} />
                      <span style={{ fontWeight: 'bold', fontSize: '0.85rem' }}>
                        {dramaJob.status === 'completed' ? 'Hoàn thành' :
                         dramaJob.status === 'failed' ? 'Thất bại' : 'Đang tạo video...'} (Tập {dramaJob.episodeNumber || 1})
                      </span>
                      {dramaJob.status !== 'completed' && dramaJob.status !== 'failed' && dramaJobId && (
                        <button
                          type="button"
                          onClick={() => cancelDramaJob(dramaJobId)}
                          style={{
                            padding: '4px 10px',
                            fontSize: '0.72rem',
                            fontWeight: 'bold',
                            background: 'rgba(239, 68, 68, 0.18)',
                            color: '#fca5a5',
                            border: '1px solid rgba(239, 68, 68, 0.4)',
                            borderRadius: '20px',
                            cursor: 'pointer',
                            marginLeft: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            transition: 'all 0.2s ease-in-out',
                            boxShadow: '0 0 10px rgba(239, 68, 68, 0.1)'
                          }}
                          onMouseOver={(e) => {
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.3)';
                            e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.6)';
                            e.currentTarget.style.boxShadow = '0 0 14px rgba(239, 68, 68, 0.2)';
                          }}
                          onMouseOut={(e) => {
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.18)';
                            e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.4)';
                            e.currentTarget.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.1)';
                          }}
                        >
                          <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444', animation: 'pulse 1.5s infinite' }} />
                          Dừng chạy
                        </button>
                      )}
                    </div>
                    {numericProgress !== null && <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{Math.round(numericProgress)}%</span>}
                  </div>
                  {numericProgress !== null && (
                    <div style={{ height: '6px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: '4px', background: 'linear-gradient(90deg, #ec4899, #8b5cf6)', transition: 'width 0.4s', width: `${numericProgress}%` }} />
                    </div>
                  )}
                  {scenes.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '110px', overflowY: 'auto' }}>
                      {scenes.map((scene, index) => {
                        const sceneStatus = scene?.status || 'pending';
                        const isDone = sceneStatus === 'completed';
                        const isFailed = sceneStatus === 'failed';
                        return (
                          <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', fontSize: '0.75rem' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                              {isDone ? <Check size={13} style={{ color: '#34d399', flexShrink: 0 }} />
                                : isFailed ? <X size={13} style={{ color: '#f87171', flexShrink: 0 }} />
                                : <Loader size={13} className="spin-loader" style={{ flexShrink: 0 }} />}
                              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Cảnh {index + 1}: {scene?.title || ''}</span>
                            </span>
                            <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
                              {isDone ? 'xong' : isFailed ? 'lỗi' : scene?.imageUrl ? 'video...' : 'ảnh...'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {dramaScriptsLoading ? (
          <div className="glass-panel" style={{ minHeight: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--text-secondary)' }}>
            <Loader size={20} className="spin-loader" /> Đang tải danh sách kịch bản...
          </div>
        ) : !dramaScript ? (
          <section className="glass-panel" style={{ padding: 'clamp(18px, 4vw, 28px)', display: 'flex', flexDirection: 'column', gap: '22px' }}>
            <div>
              <h2 style={{ fontSize: '1.08rem', margin: 0 }}>
                {channelType === 'sumo' ? 'Danh sách kịch bản Gạc Hươu Sumo' : 'Danh sách kịch bản Mẹ Chồng Nàng Dâu'}
              </h2>
            </div>

            <div style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              gap: '10px', 
              padding: '15px', 
              borderRadius: '12px', 
              border: channelType === 'sumo' ? '1px solid rgba(245, 158, 11, 0.25)' : '1px solid rgba(244, 114, 182, 0.25)', 
              background: channelType === 'sumo' ? 'rgba(245, 158, 11, 0.04)' : 'rgba(244, 114, 182, 0.04)' 
            }}>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={dramaTopic}
                  onChange={(event) => setDramaTopic(event.target.value)}
                  placeholder={channelType === 'sumo' ? "Chủ đề hoạt hình Sumo, ví dụ: bé lười ăn rau" : "Chủ đề kịch bản, ví dụ: mẹ chồng nàng dâu"}
                  className="glass-input"
                  style={{ flex: 1, minWidth: '220px' }}
                  disabled={dramaSaving}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); createDramaScript(); } }}
                />
                <button 
                  type="button" 
                  className="glass-button" 
                  onClick={createDramaScript} 
                  disabled={dramaSaving} 
                  style={{ 
                    padding: '12px 18px', 
                    background: dramaSaving ? undefined : (channelType === 'sumo' ? 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)' : 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)'), 
                    opacity: dramaSaving ? 0.5 : 1 
                  }}
                >
                  {dramaSaving ? <Loader size={17} className="spin-loader" /> : <Plus size={17} />} {dramaSaving ? 'Đang tạo bằng AI...' : 'Tạo kịch bản'}
                </button>
              </div>
            </div>

            {(() => {
              const filteredScripts = dramaScripts.filter(s => {
                if (channelType === 'sumo') return s.channelType === 'sumo';
                return s.channelType !== 'sumo';
              });
              if (filteredScripts.length === 0) {
                return (
                  <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '26px 0' }}>
                    Chưa có kịch bản nào. Tạo kịch bản đầu tiên ở trên.
                  </div>
                );
              }
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {filteredScripts.map(script => (
                    <div key={script.id} className="glass-panel" style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 'bold', fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {script.title || '(Chưa có tiêu đề)'}
                        </div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '3px' }}>
                          {script.scenes.length} cảnh · {script.characters.length} nhân vật · {new Date(script.updatedAt || Date.now()).toLocaleDateString('vi-VN')}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                        <button type="button" className="glass-button" onClick={() => openDramaScript(script.id)} style={{ padding: '8px 14px', fontSize: '0.8rem' }}>
                          Mở
                        </button>
                        <button type="button" className="glass-button" onClick={() => deleteDramaScript(script.id)} style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#f87171' }}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </section>
        ) : (
          <section className="glass-panel" style={{ padding: 'clamp(18px, 4vw, 28px)', display: 'flex', flexDirection: 'column', gap: '22px' }}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Tiêu đề kịch bản</label>
              <input
                type="text"
                value={dramaScript.title}
                onChange={(event) => setDramaScript(current => ({ ...current, title: event.target.value }))}
                placeholder="Tiêu đề kịch bản"
                className="glass-input"
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Prompt ảnh gốc (phong cách hình ảnh chung)</label>
              <textarea
                value={dramaScript.baseImagePrompt}
                onChange={(event) => setDramaScript(current => ({ ...current, baseImagePrompt: event.target.value }))}
                placeholder="Ví dụ: A 3D Pixar-style modern Vietnamese house, cinematic lighting, vertical 9:16..."
                className="glass-input"
                rows={3}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Nhân vật</label>
              {dramaScript.characters.map((character, characterIndex) => (
                <div key={characterIndex} className="glass-panel" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={character.name}
                      onChange={(event) => setDramaScript(current => {
                        const characters = [...current.characters];
                        characters[characterIndex] = { ...characters[characterIndex], name: event.target.value };
                        return { ...current, characters };
                      })}
                      placeholder="Tên nhân vật"
                      className="glass-input"
                      style={{ flex: 1, minWidth: '140px' }}
                    />
                    <input
                      type="text"
                      value={character.role}
                      onChange={(event) => setDramaScript(current => {
                        const characters = [...current.characters];
                        characters[characterIndex] = { ...characters[characterIndex], role: event.target.value };
                        return { ...current, characters };
                      })}
                      placeholder="Vai trò (vd: mẹ chồng)"
                      className="glass-input"
                      style={{ flex: 1, minWidth: '140px' }}
                    />

                  </div>
                  <textarea
                    value={character.description}
                    onChange={(event) => setDramaScript(current => {
                      const characters = [...current.characters];
                      characters[characterIndex] = { ...characters[characterIndex], description: event.target.value };
                      return { ...current, characters };
                    })}
                    placeholder="Mô tả tính cách ngoại hình"
                    className="glass-input"
                    rows={2}
                  />
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Kịch bản cảnh ({dramaScript.scenes.length})</label>
              </div>
              {dramaScript.scenes.map((scene, sceneIndex) => (
                <div key={sceneIndex} className="glass-panel" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px', borderLeft: '3px solid #f472b6' }}>
                  <input
                    type="text"
                    value={scene.title}
                    onChange={(event) => setDramaScript(current => {
                      const scenes = [...current.scenes];
                      scenes[sceneIndex] = { ...scenes[sceneIndex], title: event.target.value };
                      return { ...current, scenes };
                    })}
                    placeholder={`Cảnh ${sceneIndex + 1}: Tiêu đề`}
                    className="glass-input"
                  />
                  <textarea
                    value={scene.description}
                    onChange={(event) => setDramaScript(current => {
                      const scenes = [...current.scenes];
                      scenes[sceneIndex] = { ...scenes[sceneIndex], description: event.target.value };
                      return { ...current, scenes };
                    })}
                    placeholder="Mô tả hình ảnh cảnh này (tiếng Anh để làm video)"
                    className="glass-input"
                    rows={3}
                  />
                  <textarea
                    value={scene.imagePrompt}
                    onChange={(event) => setDramaScript(current => {
                      const scenes = [...current.scenes];
                      scenes[sceneIndex] = { ...scenes[sceneIndex], imagePrompt: event.target.value };
                      return { ...current, scenes };
                    })}
                    placeholder="Prompt ảnh gốc của cảnh (tiếng Anh)"
                    className="glass-input"
                    rows={2}
                  />
                  <textarea
                    value={scene.videoPrompt}
                    onChange={(event) => setDramaScript(current => {
                      const scenes = [...current.scenes];
                      scenes[sceneIndex] = { ...scenes[sceneIndex], videoPrompt: event.target.value };
                      return { ...current, scenes };
                    })}
                    placeholder="Prompt video: mô tả chuyển động/hành động của clip 8 giây (tiếng Anh)"
                    className="glass-input"
                    rows={2}
                  />
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    {scene.imageUrl && (
                      <div style={{ flex: '1 1 160px', minWidth: '140px' }}>
                        <label style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>
                          Ảnh cảnh {scene.imageStatus === 'processing' ? '(đang tạo...)' : scene.imageStatus === 'failed' ? '(lỗi)' : ''}
                        </label>
                        <img src={scene.imageUrl} alt={`Cảnh ${sceneIndex + 1}`} style={{ width: '100%', borderRadius: '10px', marginTop: '4px', border: '1px solid rgba(255,255,255,0.08)', opacity: scene.imageStatus === 'processing' ? 0.55 : 1 }} />
                      </div>
                    )}
                    {scene.videoUrl && (
                      <div style={{ flex: '1 1 220px', minWidth: '180px' }}>
                        <label style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>
                          Clip cảnh {scene.videoStatus === 'processing' ? '(đang tạo...)' : scene.videoStatus === 'failed' ? '(lỗi)' : ''}
                        </label>
                        <video controls src={scene.videoUrl} style={{ width: '100%', borderRadius: '10px', marginTop: '4px', maxHeight: '240px', background: '#000' }} />
                      </div>
                    )}
                    {(scene.imageStatus === 'processing' || scene.videoStatus === 'processing') && (
                      <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: '8px', color: '#fbbf24', fontSize: '0.8rem' }}>
                        <Loader size={16} className="spin-loader" />
                        {scene.imageStatus === 'processing' ? 'Đang tạo ảnh cảnh...' : 'Đang tạo video cảnh...'}
                      </div>
                    )}
                    {scene.imageStatus === 'failed' && (
                      <div style={{ flex: '1 1 100%', color: '#f87171', fontSize: '0.78rem' }}>
                        Tạo ảnh thất bại. Vui lòng thử lại.
                      </div>
                    )}
                    {scene.videoStatus === 'failed' && (
                      <div style={{ flex: '1 1 100%', color: '#f87171', fontSize: '0.78rem' }}>
                        Tạo video thất bại. Vui lòng thử lại.
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label style={{ color: 'var(--text-secondary)', fontSize: '0.74rem' }}>Lời thoại</label>
                    {(Array.isArray(scene.dialogue) ? scene.dialogue : []).map((line, lineIndex) => (
                      <div key={lineIndex} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <input
                          type="text"
                          value={line.speaker}
                          onChange={(event) => setDramaScript(current => {
                            const scenes = [...current.scenes];
                            const dialogue = [...(scenes[sceneIndex].dialogue || [])];
                            dialogue[lineIndex] = { ...dialogue[lineIndex], speaker: event.target.value };
                            scenes[sceneIndex] = { ...scenes[sceneIndex], dialogue };
                            return { ...current, scenes };
                          })}
                          placeholder="Ai nói (tên nhân vật)"
                          className="glass-input"
                          style={{ flex: 0.3, minWidth: '120px' }}
                        />
                        <input
                          type="text"
                          value={line.text}
                          onChange={(event) => setDramaScript(current => {
                            const scenes = [...current.scenes];
                            const dialogue = [...(scenes[sceneIndex].dialogue || [])];
                            dialogue[lineIndex] = { ...dialogue[lineIndex], text: event.target.value };
                            scenes[sceneIndex] = { ...scenes[sceneIndex], dialogue };
                            return { ...current, scenes };
                          })}
                          placeholder="Lời thoại tiếng Việt"
                          className="glass-input"
                          style={{ flex: 1, minWidth: '220px' }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button 
                type="button" 
                className="glass-button" 
                onClick={() => saveDramaScript({ ...dramaScript, status: 'draft' })} 
                disabled={!isSaveEnabled} 
                style={{ 
                  flex: 1, 
                  padding: '14px 20px', 
                  background: isSaveEnabled ? 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)' : undefined, 
                  opacity: isSaveEnabled ? 1 : 0.4 
                }}
              >
                {dramaSaving ? <Loader size={17} className="spin-loader" /> : <Check size={17} />} {dramaSaving ? 'Đang lưu...' : 'Lưu kịch bản'}
              </button>
            </div>

            {Array.isArray(dramaScript.episodes) && dramaScript.episodes.length > 0 && (
              <div className="glass-panel" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px', borderColor: 'rgba(52,211,153,0.35)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Video size={18} style={{ color: '#34d399' }} />
                  <span style={{ fontWeight: 'bold', fontSize: '0.92rem' }}>Các tập đã hoàn thành</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {dramaScript.episodes.map(episode => (
                    <div key={episode.jobId || episode.number} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 'bold', fontSize: '0.85rem' }}>
                          Tập {episode.number || ''}{episode.title ? `: ${episode.title}` : ''}
                        </span>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>
                          {episode.completedAt ? new Date(episode.completedAt).toLocaleString('vi-VN') : ''}
                        </span>
                      </div>
                      {episode.finalUrl && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          <video controls src={episode.finalUrl} style={{ width: '100%', borderRadius: '12px', maxHeight: '420px', background: '#000' }} />
                          <button
                            type="button"
                            className="glass-button"
                            onClick={() => handleDownload(episode.finalUrl, `tap_${episode.number || 'hoan_chinh'}.mp4`)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '8px',
                              padding: '10px 14px',
                              background: 'rgba(52,211,153,0.12)',
                              border: '1px solid rgba(52,211,153,0.3)',
                              color: '#34d399',
                              borderRadius: '10px',
                              fontWeight: 'bold',
                              fontSize: '0.8rem',
                              cursor: 'pointer'
                            }}
                          >
                            <Download size={14} /> Tải video Tập {episode.number || ''}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {dramaJob?.finalUrl && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '16px' }}>
                <label style={{ color: channelType === 'sumo' ? '#f59e0b' : '#a78bfa', fontSize: '0.85rem', fontWeight: 'bold' }}>
                  Tác phẩm hoàn chỉnh (Full Video)
                </label>
                <video controls src={dramaJob.finalUrl} style={{ width: '100%', borderRadius: '12px', maxHeight: '420px', background: '#000' }} />
                <button
                  type="button"
                  className="glass-button"
                  onClick={() => handleDownload(dramaJob.finalUrl, `${channelType === 'sumo' ? 'sumo' : 'drama'}_tap_${dramaJob.episodeNumber || 1}.mp4`)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    padding: '12px 18px',
                    background: channelType === 'sumo' ? 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)' : 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
                    color: '#fff',
                    borderRadius: '10px',
                    fontWeight: 'bold',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    marginTop: '4px'
                  }}
                >
                  <Download size={16} /> Tải video hoàn chỉnh
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    );
  };

  const renderAutoToolView = () => {
    const progress = autoToolJob?.progress;
    const numericProgress = typeof progress === 'number'
      ? Math.max(0, Math.min(100, progress <= 1 ? progress * 100 : progress))
      : null;
    const scenes = Array.isArray(autoToolJob?.scenes) ? autoToolJob.scenes : [];
    const jobError = autoToolJob?.error;
    const errorText = typeof jobError === 'string'
      ? jobError
      : jobError ? JSON.stringify(jobError) : autoToolError;

    return (
      <div className="container" style={{ maxWidth: '920px', margin: '0 auto', padding: '40px 20px', gap: '24px', color: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Video size={28} style={{ color: '#a78bfa' }} />
              <h1 style={{ fontSize: 'clamp(1.6rem, 5vw, 2rem)', fontWeight: '800', margin: 0 }}>AutoTool</h1>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '6px' }}>Tạo video hoàn chỉnh từ chủ đề và hình ảnh nhân vật.</p>
          </div>
          <button
            type="button"
            onClick={() => { window.location.hash = ''; }}
            className="glass-button"
            style={{ width: '40px', height: '40px', padding: 0, borderRadius: '50%', flexShrink: 0 }}
            title="Quay lại Workspace"
          >
            <ArrowLeft size={18} />
          </button>
        </div>

        {autoToolProjectsLoading ? (
          <div className="glass-panel" style={{ minHeight: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--text-secondary)' }}>
            <Loader size={20} className="spin-loader" /> Đang tải danh sách project...
          </div>
        ) : !autoToolProject ? (
          <section className="glass-panel" style={{ padding: 'clamp(18px, 4vw, 28px)', display: 'flex', flexDirection: 'column', gap: '22px' }}>
            <div>
              <h2 style={{ fontSize: '1.08rem', margin: 0 }}>Danh sách project</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '5px 0 0' }}>Mỗi project là một series với cấu hình riêng (nhân vật, style, kịch bản). Các project có thể sinh tập song song.</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '15px', borderRadius: '12px', border: '1px solid rgba(167,139,250,0.35)', background: 'rgba(139,92,246,0.07)' }}>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={autoToolTopic}
                  onChange={(event) => setAutoToolTopic(event.target.value)}
                  placeholder="Tên project mới, ví dụ: Truyền thuyết Rồng Xanh"
                  className="glass-input"
                  style={{ flex: 1, minWidth: '220px' }}
                  disabled={autoToolSaving}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); createAutoToolProject(); } }}
                />
                <button type="button" className="glass-button" onClick={createAutoToolProject} disabled={autoToolSaving || !autoToolTopic.trim()} style={{ padding: '12px 18px', background: autoToolSaving ? undefined : 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)', opacity: autoToolTopic.trim() ? 1 : 0.5 }}>
                  {autoToolSaving ? <Loader size={17} className="spin-loader" /> : <Plus size={17} />} Tạo project
                </button>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', margin: 0 }}>Tạo project trước, sau đó vào trong để AI sinh ý tưởng, nhân vật, style và kịch bản.</p>
            </div>

            {autoToolProjects.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '26px 0' }}>
                Chưa có project nào. Tạo project đầu tiên để bắt đầu.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {autoToolProjects.map(project => (
                  <div key={project.id} style={{ padding: '15px 16px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', background: 'rgba(255,255,255,0.025)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: '0.92rem' }}>{project.name}</strong>
                        <span style={{ padding: '3px 8px', borderRadius: '999px', background: 'rgba(124,58,237,0.16)', color: '#c4b5fd', fontSize: '0.66rem', fontWeight: '700' }}>{project.mode === 'series' ? 'Series' : 'Tập độc lập'}</span>
                      </div>
                      {project.overview && <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.5, marginTop: '5px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{project.overview}</div>}
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginTop: '7px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                        <span><Users size={12} style={{ verticalAlign: '-2px' }} /> {project.characters.length} nhân vật</span>
                        <span><ImageIcon size={12} style={{ verticalAlign: '-2px' }} /> {project.scenes.length} cảnh</span>
                        <span><Video size={12} style={{ verticalAlign: '-2px' }} /> {project.episodeCount || 0} tập đã tạo</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                      <button type="button" className="glass-button" onClick={() => openAutoToolProject(project.id)} disabled={autoToolProjectLoading} style={{ padding: '9px 16px' }}>
                        {autoToolProjectLoading ? <Loader size={15} className="spin-loader" /> : <ArrowRight size={15} />} Mở
                      </button>
                      <button type="button" className="glass-button" onClick={() => deleteAutoToolProject(project.id)} disabled={autoToolProjectLoading} style={{ padding: '9px', color: '#f87171' }} aria-label={`Xóa project ${project.name}`}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="glass-panel" style={{ padding: 'clamp(18px, 4vw, 28px)', display: 'flex', flexDirection: 'column', gap: '22px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <h2 style={{ fontSize: '1.08rem', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{autoToolProject.name}</h2>
                  <span style={{ padding: '3px 8px', borderRadius: '999px', background: 'rgba(124,58,237,0.16)', color: '#c4b5fd', fontSize: '0.66rem', fontWeight: '700' }}>{autoToolProject.mode === 'series' ? 'Series' : 'Tập độc lập'}</span>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.76rem', margin: '5px 0 0' }}>Đã tạo {autoToolProject.episodeCount || 0} tập · {autoToolProject.characters.length} nhân vật · {autoToolProject.scenes.length} cảnh</p>
              </div>
              <button type="button" className="glass-button" onClick={closeAutoToolProject} disabled={autoToolSaving || autoToolCreating} style={{ padding: '8px 14px', fontSize: '0.78rem' }}><ArrowLeft size={15} /> Danh sách</button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', overflowX: 'auto', paddingBottom: '4px' }}>
              {[
                { step: 1, label: 'Tổng quan', icon: <Video size={15} /> },
                { step: 2, label: 'Nhân vật', icon: <Users size={15} /> },
                { step: 3, label: 'Style', icon: <Sparkles size={15} /> },
                { step: 4, label: 'Sinh cảnh', icon: <ImageIcon size={15} /> },
                { step: 5, label: 'Generate', icon: <Play size={15} /> }
              ].map(item => {
                const isActive = autoToolStep === item.step;
                const isDone = autoToolStep > item.step;
                return (
                  <React.Fragment key={item.step}>
                    {item.step > 1 && <div style={{ height: '1px', flex: 1, minWidth: '8px', background: isDone ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.1)' }} />}
                    <button
                      type="button"
                      onClick={() => setAutoToolStep(item.step)}
                      disabled={autoToolSaving || autoToolCreating}
                      style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '8px 14px', borderRadius: '999px', border: 'none', cursor: autoToolSaving || autoToolCreating ? 'default' : 'pointer', background: isActive ? 'rgba(124,58,237,0.18)' : 'rgba(255,255,255,0.04)', color: isActive ? '#c4b5fd' : isDone ? '#10b981' : 'var(--text-secondary)', fontSize: '0.78rem', fontWeight: '700', whiteSpace: 'nowrap' }}
                    >
                      {isDone ? <Check size={15} /> : item.icon}
                      {item.label}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>

            {autoToolStep === 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: '700' }}>Tổng quan series</span>
                  <button type="button" className="glass-button" onClick={() => runAutoToolAi('idea', { topic: autoToolTopic })} disabled={!!autoToolAiLoading || autoToolSaving || autoToolCreating} style={{ padding: '8px 13px', fontSize: '0.74rem' }}>
                    {autoToolAiLoading === 'idea' ? <Loader size={14} className="spin-loader" /> : <Sparkles size={14} />} AI sinh ý tưởng
                  </button>
                </div>
                <div>
                  <label htmlFor="autotool-name" style={{ display: 'block', fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Tên project</label>
                  <input
                    id="autotool-name"
                    type="text"
                    value={autoToolProject.name}
                    onChange={(event) => setAutoToolProject(current => current ? { ...current, name: event.target.value } : current)}
                    placeholder="Tên series / chủ đề"
                    className="glass-input"
                    disabled={autoToolSaving || autoToolCreating}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="autotool-overview" style={{ display: 'block', fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Mô tả / Ý tưởng chính</label>
                  <textarea id="autotool-overview" value={autoToolTopic} onChange={(event) => setAutoToolTopic(event.target.value)} rows={4} placeholder="Mô tả mạch nội dung, bối cảnh, ý tưởng xuyên suốt của series..." className="glass-input" style={{ resize: 'vertical', minHeight: '105px', fontFamily: 'inherit', lineHeight: 1.6 }} disabled={autoToolSaving || autoToolCreating} />
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', margin: '8px 0 0' }}>Bấm "AI sinh ý tưởng" để AI viết thử tổng quan, gợi ý nhân vật và style.</p>
                </div>
                <div>
                  <div style={{ fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Chế độ nội dung</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                    {[
                      { value: 'series', label: 'Series', description: 'Các tập nối tiếp cùng mạch nội dung.' },
                      { value: 'standalone', label: 'Tập độc lập', description: 'Mỗi tập là một câu chuyện riêng.' }
                    ].map(option => {
                      const selected = (autoToolProject.mode || 'series') === option.value;
                      return (
                        <button key={option.value} type="button" onClick={() => setAutoToolProject(current => current ? { ...current, mode: option.value } : current)} disabled={autoToolSaving || autoToolCreating} style={{ padding: '12px', textAlign: 'left', borderRadius: '10px', cursor: autoToolSaving || autoToolCreating ? 'default' : 'pointer', background: selected ? 'rgba(124,58,237,0.18)' : 'rgba(255,255,255,0.025)', border: selected ? '1px solid rgba(167,139,250,0.7)' : '1px solid rgba(255,255,255,0.09)', color: '#fff' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '0.84rem', fontWeight: '700' }}>{selected && <Check size={15} style={{ color: '#a78bfa' }} />}{option.label}</span>
                          <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.7rem', lineHeight: 1.45, marginTop: '5px' }}>{option.description}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button type="button" className="glass-button" onClick={handleAutoToolSave} disabled={autoToolSaving || autoToolCreating || !autoToolProject.name.trim()} style={{ flex: 1, padding: '13px 20px', background: autoToolSaving ? undefined : 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)', opacity: autoToolProject.name.trim() ? 1 : 0.5 }}>
                    {autoToolSaving ? <Loader size={18} className="spin-loader" /> : <Check size={18} />}{autoToolSaving ? 'Đang lưu...' : 'Lưu tổng quan'}
                  </button>
                  <button type="button" className="glass-button" onClick={() => setAutoToolStep(2)} disabled={autoToolSaving || autoToolCreating || !autoToolProject.name.trim()} style={{ padding: '13px 18px' }}>Tiếp tục <ArrowRight size={17} /></button>
                </div>
              </div>
            )}

            {autoToolStep === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: '700' }}>Nhân vật ({autoToolCharacters.length}/3)</span>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button type="button" className="glass-button" onClick={() => runAutoToolAi('characters')} disabled={!!autoToolAiLoading || autoToolSaving || autoToolCreating} style={{ padding: '8px 13px', fontSize: '0.74rem' }}>
                      {autoToolAiLoading === 'characters' ? <Loader size={14} className="spin-loader" /> : <Sparkles size={14} />} AI gợi ý
                    </button>
                    {autoToolCharacters.length < 3 && <button type="button" className="glass-button" onClick={addAutoToolCharacter} disabled={autoToolSaving || autoToolCreating} style={{ padding: '8px 13px', fontSize: '0.74rem' }}><Plus size={14} /> Thêm</button>}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {autoToolCharacters.map((character, index) => {
                    const imageSource = character.previewUrl || character.imageUrl;
                    return (
                      <div key={index} style={{ padding: '14px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', background: 'rgba(255,255,255,0.02)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                          <strong style={{ fontSize: '0.82rem' }}>Nhân vật {index + 1}</strong>
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            <button type="button" className="glass-button" onClick={() => runAutoToolAi('character-image', { characterIndex: index })} disabled={!!autoToolAiLoading || autoToolSaving || autoToolCreating || !character.name.trim()} style={{ padding: '6px 11px', fontSize: '0.7rem' }}>
                              {autoToolAiLoading === 'character-image' ? <Loader size={13} className="spin-loader" /> : <Sparkles size={13} />} AI sinh ảnh
                            </button>
                            {autoToolCharacters.length > 1 && <button type="button" onClick={() => removeAutoToolCharacter(index)} disabled={autoToolSaving || autoToolCreating} aria-label={`Xóa nhân vật ${index + 1}`} style={{ display: 'flex', alignItems: 'center', gap: '5px', border: 0, background: 'transparent', color: '#f87171', cursor: 'pointer', fontSize: '0.72rem' }}><Trash2 size={14} /> Xóa</button>}
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', gap: '14px' }}>
                          <label style={{ minHeight: '150px', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '7px', overflow: 'hidden', border: '1px dashed rgba(167,139,250,0.5)', borderRadius: '10px', background: 'rgba(139,92,246,0.06)', color: '#a78bfa', cursor: autoToolSaving || autoToolCreating ? 'default' : 'pointer', textAlign: 'center' }}>
                            {imageSource ? <img src={imageSource} alt={`Ảnh ${character.name || `nhân vật ${index + 1}`}`} style={{ width: '100%', height: '100%', position: 'absolute', inset: 0, objectFit: 'cover' }} /> : <><Upload size={22} /><span style={{ fontSize: '0.72rem', fontWeight: '700' }}>Chọn ảnh hoặc AI sinh</span></>}
                            {imageSource && <span style={{ position: 'absolute', left: '8px', right: '8px', bottom: '8px', padding: '6px', borderRadius: '7px', background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: '0.68rem', fontWeight: '700' }}>Thay ảnh</span>}
                            <input type="file" accept="image/*" onChange={(event) => handleAutoToolImageSelect(index, event)} disabled={autoToolSaving || autoToolCreating} style={{ display: 'none' }} />
                          </label>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <input type="text" value={character.name} onChange={(event) => updateAutoToolCharacter(index, 'name', event.target.value)} placeholder="Tên nhân vật *" className="glass-input" disabled={autoToolSaving || autoToolCreating} required />
                            <input type="text" value={character.age} onChange={(event) => updateAutoToolCharacter(index, 'age', event.target.value)} placeholder="Tuổi (không bắt buộc)" className="glass-input" disabled={autoToolSaving || autoToolCreating} />
                            <textarea value={character.description} onChange={(event) => updateAutoToolCharacter(index, 'description', event.target.value)} rows={3} placeholder="Mô tả ngoại hình, tính cách (không bắt buộc)" className="glass-input" disabled={autoToolSaving || autoToolCreating} style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button type="button" className="glass-button" onClick={() => setAutoToolStep(1)} disabled={autoToolSaving || autoToolCreating} style={{ padding: '13px 18px' }}><ArrowLeft size={17} /> Quay lại</button>
                  <button type="button" className="glass-button" onClick={handleAutoToolSave} disabled={autoToolSaving || autoToolCreating || !autoToolCharacters.every(character => character.name.trim())} style={{ flex: 1, padding: '13px 20px', background: autoToolSaving ? undefined : 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)', opacity: autoToolCharacters.every(character => character.name.trim()) ? 1 : 0.5 }}>
                    {autoToolSaving ? <Loader size={18} className="spin-loader" /> : <Check size={18} />}{autoToolSaving ? 'Đang lưu...' : 'Lưu nhân vật'}
                  </button>
                  <button type="button" className="glass-button" onClick={() => setAutoToolStep(3)} disabled={autoToolSaving || autoToolCreating || !autoToolCharacters.every(character => character.name.trim())} style={{ padding: '13px 18px' }}>Tiếp tục <ArrowRight size={17} /></button>
                </div>
              </div>
            )}

            {autoToolStep === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: '700' }}>Phong cách hình ảnh</span>
                  <button type="button" className="glass-button" onClick={() => runAutoToolAi('style')} disabled={!!autoToolAiLoading || autoToolSaving || autoToolCreating} style={{ padding: '8px 13px', fontSize: '0.74rem' }}>
                    {autoToolAiLoading === 'style' ? <Loader size={14} className="spin-loader" /> : <Sparkles size={14} />} AI gợi ý style
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
                  <div>
                    <label htmlFor="autotool-artstyle" style={{ display: 'block', fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Art style</label>
                    <input id="autotool-artstyle" type="text" value={autoToolStyle.artStyle} onChange={(event) => updateAutoToolStyle('artStyle', event.target.value)} placeholder="Ví dụ: Anime, Hoạt hình 3D..." className="glass-input" disabled={autoToolSaving || autoToolCreating} />
                  </div>
                  <div>
                    <label htmlFor="autotool-palette" style={{ display: 'block', fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Bảng màu</label>
                    <input id="autotool-palette" type="text" value={autoToolStyle.colorPalette} onChange={(event) => updateAutoToolStyle('colorPalette', event.target.value)} placeholder="Ví dụ: Xanh lam + vàng ấm" className="glass-input" disabled={autoToolSaving || autoToolCreating} />
                  </div>
                  <div>
                    <label htmlFor="autotool-mood" style={{ display: 'block', fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Mood</label>
                    <input id="autotool-mood" type="text" value={autoToolStyle.mood} onChange={(event) => updateAutoToolStyle('mood', event.target.value)} placeholder="Ví dụ: Huyền bí, ấm áp..." className="glass-input" disabled={autoToolSaving || autoToolCreating} />
                  </div>
                  <div>
                    <label htmlFor="autotool-lighting" style={{ display: 'block', fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Ánh sáng</label>
                    <input id="autotool-lighting" type="text" value={autoToolStyle.lighting} onChange={(event) => updateAutoToolStyle('lighting', event.target.value)} placeholder="Ví dụ: Hoàng hôn vàng cam" className="glass-input" disabled={autoToolSaving || autoToolCreating} />
                  </div>
                  <div>
                    <label htmlFor="autotool-camera" style={{ display: 'block', fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Camera</label>
                    <input id="autotool-camera" type="text" value={autoToolStyle.camera} onChange={(event) => updateAutoToolStyle('camera', event.target.value)} placeholder="Ví dụ: Cận cảnh, góc thấp..." className="glass-input" disabled={autoToolSaving || autoToolCreating} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button type="button" className="glass-button" onClick={() => setAutoToolStep(2)} disabled={autoToolSaving || autoToolCreating} style={{ padding: '13px 18px' }}><ArrowLeft size={17} /> Quay lại</button>
                  <button type="button" className="glass-button" onClick={() => handleAutoToolSave({ style: true })} disabled={autoToolSaving || autoToolCreating} style={{ flex: 1, padding: '13px 20px', background: autoToolSaving ? undefined : 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)' }}>
                    {autoToolSaving ? <Loader size={18} className="spin-loader" /> : <Check size={18} />}{autoToolSaving ? 'Đang lưu...' : 'Lưu style'}
                  </button>
                  <button type="button" className="glass-button" onClick={() => setAutoToolStep(4)} disabled={autoToolSaving || autoToolCreating} style={{ padding: '13px 18px' }}>Tiếp tục <ArrowRight size={17} /></button>
                </div>
              </div>
            )}

            {autoToolStep === 4 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: '700' }}>Kịch bản tập tiếp theo ({autoToolScenes.length}/6)</span>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button type="button" className="glass-button" onClick={() => runAutoToolAi('scenes')} disabled={!!autoToolAiLoading || autoToolSaving || autoToolCreating} style={{ padding: '8px 13px', fontSize: '0.74rem' }}>
                      {autoToolAiLoading === 'scenes' ? <Loader size={14} className="spin-loader" /> : <Sparkles size={14} />} AI sinh cảnh
                    </button>
                    {autoToolScenes.length < 6 && <button type="button" className="glass-button" onClick={addAutoToolScene} disabled={autoToolSaving || autoToolCreating} style={{ padding: '8px 13px', fontSize: '0.74rem' }}><Plus size={14} /> Thêm cảnh</button>}
                  </div>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', margin: 0 }}>
                  Bấm "AI sinh cảnh" để AI tạo kịch bản cho tập kế tiếp (dựa trên các tập trước). Bạn có thể chỉnh tay trước khi lưu.
                </p>
                {autoToolEpisodeTitle && (
                  <div>
                    <label htmlFor="autotool-episodetitle" style={{ display: 'block', fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Tên tập (đề xuất)</label>
                    <input id="autotool-episodetitle" type="text" value={autoToolEpisodeTitle} onChange={(event) => setAutoToolEpisodeTitle(event.target.value)} className="glass-input" disabled={autoToolSaving || autoToolCreating} />
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {autoToolScenes.map((scene, index) => (
                    <div key={index} style={{ padding: '14px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', background: 'rgba(255,255,255,0.02)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <strong style={{ fontSize: '0.82rem' }}>Cảnh {index + 1}</strong>
                        {autoToolScenes.length > 1 && <button type="button" onClick={() => removeAutoToolScene(index)} disabled={autoToolSaving || autoToolCreating} aria-label={`Xóa cảnh ${index + 1}`} style={{ display: 'flex', alignItems: 'center', gap: '5px', border: 0, background: 'transparent', color: '#f87171', cursor: 'pointer', fontSize: '0.72rem' }}><Trash2 size={14} /> Xóa</button>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <input type="text" value={scene.title} onChange={(event) => updateAutoToolScene(index, 'title', event.target.value)} placeholder="Tên cảnh (không bắt buộc)" className="glass-input" disabled={autoToolSaving || autoToolCreating} />
                        <div>
                          <label htmlFor={`scene-image-${index}`} style={{ display: 'block', fontSize: '0.72rem', fontWeight: '700', color: '#c4b5fd', marginBottom: '6px' }}>Image prompt *</label>
                          <textarea id={`scene-image-${index}`} value={scene.imagePrompt} onChange={(event) => updateAutoToolScene(index, 'imagePrompt', event.target.value)} rows={2} placeholder="Mô tả hình ảnh sẽ tạo cho cảnh này..." className="glass-input" disabled={autoToolSaving || autoToolCreating} style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} required />
                        </div>
                        <div>
                          <label htmlFor={`scene-video-${index}`} style={{ display: 'block', fontSize: '0.72rem', fontWeight: '700', color: '#93c5fd', marginBottom: '6px' }}>Video prompt *</label>
                          <textarea id={`scene-video-${index}`} value={scene.videoPrompt} onChange={(event) => updateAutoToolScene(index, 'videoPrompt', event.target.value)} rows={2} placeholder="Mô tả chuyển động, hành động trong cảnh..." className="glass-input" disabled={autoToolSaving || autoToolCreating} style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} required />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button type="button" className="glass-button" onClick={() => setAutoToolStep(3)} disabled={autoToolSaving || autoToolCreating} style={{ padding: '13px 18px' }}><ArrowLeft size={17} /> Quay lại</button>
                  <button type="button" className="glass-button" onClick={() => handleAutoToolSave({ scenes: true })} disabled={autoToolSaving || autoToolCreating || !autoToolScenes.length} style={{ flex: 1, padding: '13px 20px', background: autoToolSaving ? undefined : 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)', opacity: autoToolScenes.length ? 1 : 0.5 }}>
                    {autoToolSaving ? <Loader size={18} className="spin-loader" /> : <Check size={18} />}{autoToolSaving ? 'Đang lưu...' : 'Lưu kịch bản'}
                  </button>
                  <button type="button" className="glass-button" onClick={() => setAutoToolStep(5)} disabled={autoToolSaving || autoToolCreating || !autoToolScenes.length} style={{ padding: '13px 18px' }}>Tiếp tục <ArrowRight size={17} /></button>
                </div>
              </div>
            )}

            {autoToolStep === 5 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: '700' }}>Xác nhận trước khi tạo tập</span>
                </div>
                <div style={{ padding: '13px', borderRadius: '10px', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginBottom: '5px' }}>PROJECT</div>
                  <div style={{ fontSize: '0.86rem', fontWeight: '700' }}>{autoToolProject.name}</div>
                  {autoToolTopic && <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.5, marginTop: '5px', whiteSpace: 'pre-wrap' }}>{autoToolTopic}</div>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
                  {autoToolCharacters.map((character, index) => (
                    <div key={`${character.name}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, padding: '9px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)' }}>
                      <img src={character.imageUrl} alt={character.name} style={{ width: '48px', height: '48px', borderRadius: '9px', objectFit: 'cover', background: '#121214', flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}><div style={{ fontSize: '0.8rem', fontWeight: '700', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{character.name}</div>{character.age && <div style={{ color: 'var(--text-secondary)', fontSize: '0.68rem', marginTop: '3px' }}>{character.age} tuổi</div>}</div>
                    </div>
                  ))}
                </div>
                <div style={{ padding: '13px', borderRadius: '10px', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginBottom: '8px' }}>STYLE</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {[
                      autoToolStyle.artStyle && `Art style: ${autoToolStyle.artStyle}`,
                      autoToolStyle.colorPalette && `Màu: ${autoToolStyle.colorPalette}`,
                      autoToolStyle.mood && `Mood: ${autoToolStyle.mood}`,
                      autoToolStyle.lighting && `Ánh sáng: ${autoToolStyle.lighting}`,
                      autoToolStyle.camera && `Camera: ${autoToolStyle.camera}`
                    ].filter(Boolean).map((text, index) => (
                      <span key={index} style={{ padding: '5px 9px', borderRadius: '999px', background: 'rgba(124,58,237,0.14)', color: '#c4b5fd', fontSize: '0.7rem', fontWeight: '600' }}>{text}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.82rem', fontWeight: '700', marginBottom: '9px' }}>Kịch bản ({autoToolScenes.length} cảnh)</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {autoToolScenes.map((scene, index) => (
                      <div key={index} style={{ padding: '10px 12px', borderRadius: '9px', border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
                        <div style={{ fontSize: '0.78rem', fontWeight: '700' }}>{index + 1}. {scene.title || `Cảnh ${index + 1}`}</div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', lineHeight: 1.5, marginTop: '4px' }}>{scene.imagePrompt}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {!autoToolProject.characters.every(character => character.imageUrl) && (
                  <div style={{ display: 'flex', gap: '9px', padding: '12px', borderRadius: '10px', border: '1px solid rgba(245,158,11,0.25)', background: 'rgba(245,158,11,0.08)', color: '#fcd34d', fontSize: '0.8rem', lineHeight: 1.5 }}>
                    <AlertCircle size={17} style={{ flexShrink: 0, marginTop: '1px' }} />
                    <span>Một số nhân vật chưa có ảnh. Hãy quay lại bước Nhân vật để tạo ảnh trước khi generate.</span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button type="button" className="glass-button" onClick={() => setAutoToolStep(4)} disabled={autoToolSaving || autoToolCreating} style={{ padding: '13px 18px' }}><ArrowLeft size={17} /> Quay lại</button>
                  <button type="button" className="glass-button" onClick={handleAutoToolCreateJob} disabled={autoToolSaving || autoToolCreating || !autoToolProject.characters.every(character => character.imageUrl)} style={{ flex: 1, padding: '14px 20px', background: autoToolCreating ? undefined : 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)', opacity: autoToolProject.characters.every(character => character.imageUrl) ? 1 : 0.5 }}>
                    {autoToolCreating ? <Loader size={18} className="spin-loader" /> : <Play size={18} />}{autoToolCreating ? 'Đang tạo công việc...' : 'Generate tập tiếp theo'}
                  </button>
                </div>
              </div>
            )}

            {autoToolError && (
              <div style={{ display: 'flex', gap: '9px', padding: '12px', borderRadius: '10px', border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.08)', color: '#fca5a5', fontSize: '0.82rem', lineHeight: 1.5 }}>
                <AlertCircle size={17} style={{ flexShrink: 0, marginTop: '1px' }} />
                <span>{autoToolError}</span>
              </div>
            )}
          </section>
        )}

        {(autoToolJobId || errorText) && (
          <section className="glass-panel" style={{ padding: 'clamp(18px, 4vw, 28px)', display: 'flex', flexDirection: 'column', gap: '18px' }}>
            {(autoToolJob?.episodeTitle || autoToolJob?.episodeNumber) && (
              <div>
                {autoToolJob.episodeNumber && <div style={{ color: '#a78bfa', fontSize: '0.72rem', fontWeight: '700', marginBottom: '5px' }}>TẬP {autoToolJob.episodeNumber}</div>}
                {autoToolJob.episodeTitle && <h2 style={{ fontSize: '1.12rem', lineHeight: 1.4, margin: 0 }}>{autoToolJob.episodeTitle}</h2>}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', marginBottom: '4px' }}>TRẠNG THÁI</div>
                <div style={{ fontWeight: '700' }}>
                  {autoToolJob?.status || (autoToolJobId ? 'Đang khởi tạo' : 'Lỗi')}
                  {progress !== undefined && progress !== null && ` · ${numericProgress !== null ? `${Math.round(numericProgress)}%` : progress}`}
                </div>
              </div>
              {autoToolJobId && <code style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>{autoToolJobId}</code>}
            </div>

            {numericProgress !== null && (
              <div style={{ height: '7px', overflow: 'hidden', borderRadius: '999px', background: 'rgba(255,255,255,0.08)' }}>
                <div style={{ width: `${numericProgress}%`, height: '100%', borderRadius: 'inherit', background: 'linear-gradient(90deg, #7c3aed, #3b82f6)', transition: 'width 0.3s ease' }} />
              </div>
            )}

            {errorText && (
              <div style={{ display: 'flex', gap: '9px', padding: '12px', borderRadius: '10px', border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.08)', color: '#fca5a5', fontSize: '0.82rem', lineHeight: 1.5 }}>
                <AlertCircle size={17} style={{ flexShrink: 0, marginTop: '1px' }} />
                <span>{errorText}</span>
              </div>
            )}

            {scenes.length > 0 && (
              <div>
                <h2 style={{ fontSize: '1rem', marginBottom: '10px' }}>Các cảnh đã tạo</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {scenes.map((scene, index) => {
                    const attemptOf = (taskId) => {
                      const match = typeof taskId === 'string' ? taskId.match(/_r(\d+)$/) : null;
                      return match ? Number(match[1]) : (taskId ? 1 : null);
                    };
                    const imageAttempt = attemptOf(scene.imageTaskId);
                    const videoAttempt = attemptOf(scene.videoTaskId);
                    const stage = (taskType) => {
                      if (scene[`${taskType}Url`]) return { label: 'Hoàn thành', color: '#10b981', bg: 'rgba(16,185,129,0.14)' };
                      if (scene[`${taskType}TaskId`] && (scene.status === `${taskType}_processing` || scene.status === 'completed')) return { label: 'Đang xử lý', color: '#93c5fd', bg: 'rgba(59,130,246,0.14)' };
                      if (scene.status === 'failed') return { label: 'Lỗi', color: '#fca5a5', bg: 'rgba(239,68,68,0.12)' };
                      return { label: 'Chờ', color: 'var(--text-secondary)', bg: 'rgba(255,255,255,0.06)' };
                    };
                    const imageStage = stage('image');
                    const videoStage = stage('video');
                    return (
                      <div key={scene.id || index} style={{ padding: '13px 14px', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', background: 'rgba(255,255,255,0.025)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
                          <div style={{ fontSize: '0.84rem', fontWeight: '700' }}>{scene.title || `Cảnh ${index + 1}`}</div>
                          <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 9px', borderRadius: '999px', fontSize: '0.68rem', fontWeight: '700', background: imageStage.bg, color: imageStage.color }}>
                              <ImageIcon size={12} /> Ảnh {imageStage.label}{imageAttempt ? ` · lần ${imageAttempt}` : ''}
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 9px', borderRadius: '999px', fontSize: '0.68rem', fontWeight: '700', background: videoStage.bg, color: videoStage.color }}>
                              <Video size={12} /> Video {videoStage.label}{videoAttempt ? ` · lần ${videoAttempt}` : ''}
                            </span>
                          </div>
                        </div>
                        {(scene.prompt || scene.imagePrompt) && (
                          <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: '7px' }}>
                            {scene.imagePrompt && <strong style={{ color: '#c4b5fd' }}>Ảnh: </strong>}
                            {scene.prompt || scene.imagePrompt}
                          </p>
                        )}
                        {scene.videoPrompt && (
                          <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: '6px' }}>
                            <strong style={{ color: '#93c5fd' }}>Video: </strong>{scene.videoPrompt}
                          </p>
                        )}
                        {(scene.imageUrl || scene.videoUrl) && (
                          <div style={{ display: 'flex', gap: '10px', marginTop: '9px' }}>
                            {scene.imageUrl && <img src={scene.imageUrl} alt={`Cảnh ${index + 1}`} style={{ width: '64px', height: '114px', borderRadius: '8px', objectFit: 'cover', background: '#121214', flexShrink: 0 }} />}
                            {scene.videoUrl && <video src={scene.videoUrl} controls playsInline preload="metadata" style={{ width: '64px', height: '114px', borderRadius: '8px', objectFit: 'cover', background: '#000', flexShrink: 0 }} />}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {autoToolJob?.finalUrl && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <video src={autoToolJob.finalUrl} controls playsInline style={{ width: '100%', maxHeight: '560px', borderRadius: '12px', background: '#000' }} />
                <button type="button" className="glass-button" onClick={() => handleDownload(autoToolJob.finalUrl, `autotool_${autoToolJobId}.mp4`)}>
                  <Download size={17} /> Tải video
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    );
  };

  const tryonPersonInputRef = useRef(null);
  const tryonGarmentInputRef = useRef(null);

  const handleTryOnSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!tryonPersonFile) {
      alert("Bạn ơi, vui lòng chọn Ảnh gốc (người mẫu) trước nhé! 😊");
      return;
    }
    if (tryonToolType === 'tryon' && !tryonGarmentFile) {
      alert("Bạn ơi, vui lòng chọn Ảnh trang phục/quần áo muốn thay đổi nhé! 😊");
      return;
    }
    
    // Limits check
    const usage = getTodayUsage();
    const limits = {
      free: { videos: 0, images: 0 },
      hocvien: { videos: 0, images: 30 },
      basic_69k: { videos: 5, images: 10 },
      standard_99k: { videos: 20, images: 40 },
      premium_169k: { videos: Infinity, images: Infinity }
    };
    const currentLimits = limits[userTier] || limits.free;
    if (usage.images >= currentLimits.images) {
      setLimitError(`Bạn đã dùng hết hạn mức tạo ảnh trong ngày (${currentLimits.images} ảnh/ngày). Vui lòng nâng cấp gói cước!`);
      setShowPricingModal(true);
      return;
    }

    setTryonIsSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('personImage', tryonPersonFile);
      if (tryonGarmentFile) {
        formData.append('garmentImage', tryonGarmentFile);
      }
      formData.append('userId', user.uid);
      formData.append('description', tryonDescription);
      formData.append('model', tryonModel);
      formData.append('aspectRatio', tryonAspectRatio);
      formData.append('preserve', tryonPreserveBody);
      formData.append('toolType', tryonToolType);
      formData.append('bgPreset', tryonSelectedBgPreset);
      formData.append('bgCustom', tryonCustomBgDescription);

      const res = await fetch(`${API_BASE}/api/try-on`, {
        method: 'POST',
        headers: { 'X-API-Key': import.meta.env.VITE_TRY_ON_API_KEY || 'meo3_tryon_k7p2m4x9' },
        body: formData
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText || `Server returned code ${res.status}`);
      }

      const data = await res.json();
      console.log("VTON Task created:", data);
      trackTikTokEvent('generate_tryon', { toolType: tryonToolType });
      
      // Reset files & description
      setTryonPersonFile(null);
      setTryonGarmentFile(null);
      setTryonDescription('');
      setTryonCustomBgDescription('');

      // Redirect back to home to see task
      window.location.hash = '';
      setIsTryOnView(false);
    } catch (err) {
      console.error(err);
      alert(`Rất tiếc, hệ thống chưa thể bắt đầu thay đồ lúc này: ${err.message}. Cậu thử lại sau nhé! 🥺`);
    } finally {
      setTryonIsSubmitting(false);
    }
  };

  // ─── AUDIO (VOICE CLONE) TOOL ────────────────────────────────────────────
  const loadAudioVoices = async () => {
    setAudioLoadingVoices(true);
    try {
      const res = await fetch(`${API_BASE}/api/audio/voices`);
      const data = await res.json();
      if (data.voices) {
        setAudioVoices(data.voices);
        if (data.voices.length > 0) {
          setAudioSelectedVoice(prev => prev ?? data.voices[0].voiceIndex);
        }
      }
    } catch (e) {
      console.error('loadAudioVoices failed', e);
    } finally {
      setAudioLoadingVoices(false);
    }
  };

  const loadAudioJobs = async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/api/audio/jobs?userId=${encodeURIComponent(user.uid)}`);
      const data = await res.json();
      if (data.jobs) setAudioJobs(data.jobs);
      if (data.used !== undefined) {
        setAudioUsage(prev => ({ ...prev, used: data.used, limit: data.limit ?? prev.limit, tier: data.tier ?? prev.tier }));
      }
    } catch (e) {
      console.error('loadAudioJobs failed', e);
    }
  };

  const generateAudio = async () => {
    if (!user) return;
    if (!audioText.trim()) {
      setAudioMsg({ type: 'error', text: 'Vui lòng nhập nội dung cần đọc.' });
      return;
    }
    if (audioSelectedVoice === null || audioSelectedVoice === undefined) {
      setAudioMsg({ type: 'error', text: 'Vui lòng chọn một giọng đọc.' });
      return;
    }
    setAudioMsg(null);
    setAudioGenerating(true);
    try {
      const res = await fetch(`${API_BASE}/api/audio/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          userEmail: user.email,
          text: audioText,
          voiceIndex: audioSelectedVoice
        })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          setAudioMsg({ type: 'error', text: data.error });
          setAudioUsage(prev => ({ ...prev, used: data.used ?? prev.used, limit: data.limit ?? prev.limit, tier: data.tier ?? prev.tier }));
        } else {
          setAudioMsg({ type: 'error', text: data.error || 'Tạo âm thanh thất bại. Vui lòng thử lại.' });
        }
        return;
      }
      if (data.jobUid) {
        trackTikTokEvent('generate_audio');
        setAudioUsage(prev => ({ ...prev, used: data.used }));
        setAudioText('');
        await loadAudioJobs();
      }
    } catch (e) {
      console.error('generateAudio failed', e);
      setAudioMsg({ type: 'error', text: 'Không thể kết nối máy chủ. Vui lòng thử lại.' });
    } finally {
      setAudioGenerating(false);
    }
  };

  useEffect(() => {
    if (isAudioView) {
      loadAudioVoices();
      loadAudioJobs();
      const iv = setInterval(loadAudioJobs, 5000);
      return () => clearInterval(iv);
    }
  }, [isAudioView, user]);

  const renderAudioView = () => {
    const remaining = Math.max(0, (audioUsage.limit ?? 1) - (audioUsage.used ?? 0));

    return (
      <div className="container" style={{ maxWidth: '760px', margin: '0 auto', padding: '40px 20px', display: 'flex', flexDirection: 'column', gap: '24px', minHeight: '100vh', color: '#fff' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '1.6rem' }}>🎙️</span>
            <h1 style={{ fontSize: '1.6rem', fontWeight: '800', margin: 0 }}>Tạo giọng nói AI</h1>
          </div>
          <button
            onClick={() => {
              window.location.hash = '';
              setIsAudioView(false);
            }}
            className="glass-button"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '34px', height: '34px', padding: '0', fontSize: '0.8rem', borderRadius: '50%' }}
            title="Quay lại"
          >
            <ArrowLeft size={18} />
          </button>
        </div>

        {/* Text + voice form */}
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '20px' }}>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>Nội dung cần đọc</label>
          <textarea
            value={audioText}
            onChange={(e) => setAudioText(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="Nhập đoạn văn cần lồng tiếng…"
            style={{ width: '100%', background: '#16161a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', color: '#fff', padding: '12px', fontSize: '0.9rem', resize: 'vertical', outline: 'none' }}
          />

          <label style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'block', margin: '16px 0 8px' }}>Chọn giọng đọc ({audioLoadingVoices ? 'đang tải…' : `${audioVoices.length} giọng`})</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflowY: 'auto', paddingRight: '4px' }}>
            {audioVoices.map(v => (
              <div
                key={v.voiceIndex}
                onClick={() => setAudioSelectedVoice(v.voiceIndex)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '8px 12px',
                  background: audioSelectedVoice === v.voiceIndex ? 'rgba(16, 185, 129, 0.12)' : 'rgba(255,255,255,0.03)',
                  border: audioSelectedVoice === v.voiceIndex ? '1px solid #10b981' : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '8px',
                  color: audioSelectedVoice === v.voiceIndex ? '#10b981' : 'var(--text-secondary)',
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                  transition: 'all 0.15s'
                }}
              >
                <span style={{ fontSize: '0.85rem', flexShrink: 0 }}>{audioSelectedVoice === v.voiceIndex ? '●' : '○'}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                {v.url && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setAudioPreviewVoice(audioPreviewVoice === v.voiceIndex ? null : v.voiceIndex); }}
                    title="Nghe thử giọng"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '4px 10px',
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: '6px',
                      color: '#10b981',
                      fontSize: '0.75rem',
                      fontWeight: '600',
                      cursor: 'pointer',
                      flexShrink: 0,
                      transition: 'all 0.15s',
                      minWidth: '54px',
                      justifyContent: 'center'
                    }}
                    onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(16,185,129,0.15)'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                  >
                    {audioPreviewVoice === v.voiceIndex ? (
                      <>
                        <span className="spin" style={{ width: '10px', height: '10px', borderTopColor: '#10b981' }} /> Đang phát
                      </>
                    ) : (
                      <>▶ Nghe demo</>
                    )}
                  </button>
                )}
              </div>
            ))}
            {audioLoadingVoices && <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '8px' }}>Đang tải danh sách giọng…</div>}
          </div>

          {audioPreviewVoice !== null && (() => {
            const pv = audioVoices.find(v => v.voiceIndex === audioPreviewVoice);
            if (!pv || !pv.url) return null;
            return (
              <audio
                key={pv.voiceIndex}
                src={pv.url}
                autoPlay
                controls
                onEnded={() => setAudioPreviewVoice(null)}
                onPause={() => setAudioPreviewVoice(null)}
                onError={() => setAudioPreviewVoice(null)}
                style={{ width: '100%', marginTop: '10px', height: '36px' }}
              />
            );
          })()}

          {audioMsg && (
            <div style={{ marginTop: '14px', padding: '10px 14px', borderRadius: '8px', fontSize: '0.82rem', background: audioMsg.type === 'error' ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)', color: audioMsg.type === 'error' ? '#f87171' : '#34d399', border: `1px solid ${audioMsg.type === 'error' ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)'}` }}>
              {audioMsg.text}
            </div>
          )}

          <button
            onClick={generateAudio}
            disabled={audioGenerating || remaining <= 0}
            style={{
              marginTop: '16px',
              width: '100%',
              padding: '13px',
              background: (audioGenerating || remaining <= 0) ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              border: 'none',
              borderRadius: '10px',
              color: (audioGenerating || remaining <= 0) ? 'var(--text-secondary)' : '#fff',
              fontSize: '0.95rem',
              fontWeight: '700',
              cursor: (audioGenerating || remaining <= 0) ? 'default' : 'pointer'
            }}
          >
            {audioGenerating ? '⏳ Đang tạo…' : remaining === 0 ? 'Bạn đã dùng hết lượt hôm nay' : `Tạo giọng nói${remaining !== 0 ? ` (còn ${remaining} lượt)` : ''}`}
          </button>
        </div>

        {/* Results */}
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: '700', marginBottom: '12px' }}>Audio của bạn ({audioJobs.length})</h2>
          {audioJobs.length === 0 && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '20px', textAlign: 'center' }}>
              Chưa có bản ghi nào. Hãy tạo âm thanh đầu tiên của bạn!
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {audioJobs.map(j => {
              const isExpanded = expandedAudioJobId === j.id;
              const isCopied = copiedAudioJobId === j.id;
              return (
                <div key={j.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                    <div 
                      style={{ 
                        flex: 1, 
                        fontSize: '0.85rem', 
                        fontWeight: '600', 
                        cursor: 'pointer',
                        wordBreak: 'break-word',
                        whiteSpace: isExpanded ? 'pre-wrap' : 'nowrap',
                        overflow: isExpanded ? 'visible' : 'hidden',
                        textOverflow: isExpanded ? 'clip' : 'ellipsis'
                      }}
                      onClick={() => setExpandedAudioJobId(isExpanded ? null : j.id)}
                      title={isExpanded ? 'Bấm để thu gọn' : 'Bấm để xem chi tiết đầy đủ'}
                    >
                      {j.text}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(j.text);
                        setCopiedAudioJobId(j.id);
                        setTimeout(() => setCopiedAudioJobId(null), 1500);
                      }}
                      style={{
                        background: isCopied ? '#10b981' : 'rgba(255,255,255,0.06)',
                        color: '#fff',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '6px',
                        padding: '4px 10px',
                        fontSize: '0.7rem',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {isCopied ? 'Đã chép ✓' : '📋 Sao chép'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '8px' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      {new Date(j.createdAt).toLocaleString('vi-VN')} · {audioJobStatusLabel(j.status)}
                    </div>
                    <div>
                      {j.status === 'COMPLETED' && j.outputUrl ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <audio controls src={j.outputUrl} style={{ height: '36px', maxWidth: '200px' }} />
                          <button
                            onClick={() => handleDownload(j.outputUrl, `audio_${j.id}.mp3`)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: '#10b981',
                              fontSize: '0.75rem',
                              whiteSpace: 'nowrap',
                              cursor: 'pointer',
                              fontWeight: '600',
                              padding: '2px 6px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px'
                            }}
                          >
                            ⬇ Tải về
                          </button>
                        </div>
                      ) : j.status === 'FAILED' ? (
                        <span style={{ color: '#f87171', fontSize: '0.75rem' }}>Thất bại</span>
                      ) : (
                        <span className="badge proc" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem' }}>
                          <span className="spin" /> Đang xử lý…
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

        </div>
      </div>
    );
  };

  const renderMergeVideoView = () => {
    const handleSelectFromLibrary = (videoTask) => {
      const newItem = {
        id: Math.random().toString(36).substr(2, 9),
        type: 'remote',
        name: videoTask.prompt ? videoTask.prompt.substring(0, 30) + '...' : `Video #${videoTask.id.substring(0, 5)}`,
        url: videoTask.mediaUrl,
        previewUrl: videoTask.mediaUrl
      };
      setMergeVideoFiles(prev => {
        const next = [...prev, newItem];
        // Auto select the new video as the active preview if it's the first or second video
        if (next.length === 1) {
          setActivePreviewIndex(0);
        }
        return next;
      });
      setIsLibraryPopupOpen(false);
    };

    const handleMoveUp = (index) => {
      if (index === 0) return;
      setMergeVideoFiles(prev => {
        const copy = [...prev];
        const temp = copy[index];
        copy[index] = copy[index - 1];
        copy[index - 1] = temp;
        // Adjust active index accordingly
        if (activePreviewIndex === index) {
          setActivePreviewIndex(index - 1);
        } else if (activePreviewIndex === index - 1) {
          setActivePreviewIndex(index);
        }
        return copy;
      });
    };

    const handleMoveDown = (index) => {
      setMergeVideoFiles(prev => {
        if (index === prev.length - 1) return prev;
        const copy = [...prev];
        const temp = copy[index];
        copy[index] = copy[index + 1];
        copy[index + 1] = temp;
        // Adjust active index accordingly
        if (activePreviewIndex === index) {
          setActivePreviewIndex(index + 1);
        } else if (activePreviewIndex === index + 1) {
          setActivePreviewIndex(index);
        }
        return copy;
      });
    };

    const handleRemoveFile = (index) => {
      setMergeVideoFiles(prev => {
        const next = prev.filter((_, idx) => idx !== index);
        if (activePreviewIndex >= next.length && next.length > 0) {
          setActivePreviewIndex(next.length - 1);
        }
        return next;
      });
    };

    const handleMergeVideos = async () => {
      if (mergeVideoFiles.length < 2) {
        alert("Cậu vui lòng chọn tối thiểu 2 video để thực hiện ghép nhé! 🥺");
        return;
      }

      setIsMergingVideo(true);
      setMergeError(null);
      setMergedVideoUrl(null);

      try {
        const formData = new FormData();
        const itemsMetadata = mergeVideoFiles.map(item => ({
          type: 'remote',
          url: item.url
        }));

        formData.append('items', JSON.stringify(itemsMetadata));

        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE}/api/video/merge`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          },
          body: formData
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || data.message || `Lỗi server: ${response.status}`);
        }

        setMergedVideoUrl(data.url);
      } catch (err) {
        console.error(err);
        setMergeError("Ghép video không thành công: " + err.message);
      } finally {
        setIsMergingVideo(false);
      }
    };

    const handleReset = () => {
      setMergeVideoFiles([]);
      setMergedVideoUrl(null);
      setMergeError(null);
      setActivePreviewIndex(0);
      setIsPreviewPlaying(false);
    };

    const handlePreviewVideoEnded = () => {
      if (activePreviewIndex < mergeVideoFiles.length - 1) {
        setActivePreviewIndex(prev => prev + 1);
        setIsPreviewPlaying(true);
      } else {
        setActivePreviewIndex(0);
        setIsPreviewPlaying(false);
      }
    };

    const completedVideos = tasks.filter(t => t.type === 'video' && t.status === 'completed' && t.mediaUrl);
    const activeVideo = mergeVideoFiles[activePreviewIndex];

    return (
      <div className="container" style={{ maxWidth: '900px', margin: '0 auto', padding: '30px 20px', display: 'flex', flexDirection: 'column', gap: '24px', minHeight: '100vh', color: '#fff' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <img src="/logo.png" alt="meo3 logo" style={{ height: '32px', objectFit: 'contain' }} />
              <span className="logo-text" style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>meo3</span>
              <span style={{ fontSize: '1.2rem', margin: '0 8px', color: 'rgba(255,255,255,0.2)' }}>/</span>
              <span style={{ fontSize: '1.2rem' }}>🎬</span>
              <h1 style={{ fontSize: 'clamp(1.2rem, 4vw, 1.4rem)', fontWeight: '800', margin: 0, background: 'linear-gradient(135deg, #a78bfa 0%, #ec4899 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Ghép Video AI
              </h1>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '6px', margin: 0 }}>
              Ghép nối các thước phim ngắn từ Thư viện của bạn thành một video hoàn thiện.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { window.location.hash = '#tools'; }}
            className="glass-button"
            style={{ width: '40px', height: '40px', padding: 0, borderRadius: '50%', flexShrink: 0 }}
            title="Quay lại danh sách công cụ"
          >
            <ArrowLeft size={18} />
          </button>
        </div>

        {/* Main Work Area: Top Large Video Preview and Controls */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '20px' }}>
          
          {/* Large Video Preview Player */}
          <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', background: 'rgba(15, 15, 20, 0.6)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px' }}>
            <div style={{ width: '100%', aspectRatio: '16/9', borderRadius: '12px', overflow: 'hidden', background: '#000', position: 'relative', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {mergedVideoUrl ? (
                <video src={mergedVideoUrl} controls style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : activeVideo ? (
                <video 
                  key={activeVideo.id + "_" + isPreviewPlaying}
                  src={activeVideo.previewUrl} 
                  autoPlay={isPreviewPlaying}
                  playsInline
                  onEnded={handlePreviewVideoEnded}
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }} 
                />
              ) : (
                <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '20px' }}>
                  <span style={{ fontSize: '3rem', display: 'block', marginBottom: '10px' }}>🎬</span>
                  <div style={{ fontSize: '0.9rem', fontWeight: 'bold' }}>Chưa chọn video preview</div>
                  <div style={{ fontSize: '0.78rem', marginTop: '4px' }}>Bấm nút cộng (+) ở thanh timeline phía dưới để thêm cảnh</div>
                </div>
              )}

              {/* Status overlays */}
              {isMergingVideo && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', zIndex: 10 }}>
                  <span className="spin" style={{ width: '32px', height: '32px', border: '3px solid #8b5cf6', borderTopColor: 'transparent', borderRadius: '50%' }} />
                  <span style={{ fontSize: '0.9rem', fontWeight: 'bold', color: '#a78bfa' }}>Đang ghép & xuất video...</span>
                </div>
              )}
            </div>

            {/* Play/Pause controls and Stitch Video Trigger Button */}
            <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  disabled={!activeVideo || mergedVideoUrl}
                  onClick={() => setIsPreviewPlaying(prev => !prev)}
                  className="glass-button"
                  style={{ padding: '8px 16px', borderRadius: '8px', fontSize: '0.85rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px', cursor: (!activeVideo || mergedVideoUrl) ? 'not-allowed' : 'pointer', opacity: (!activeVideo || mergedVideoUrl) ? 0.4 : 1 }}
                >
                  {isPreviewPlaying ? (
                    <><span>⏸</span> Tạm dừng</>
                  ) : (
                    <><span>▶</span> Phát thử</>
                  )}
                </button>
                {activeVideo && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}>
                    Đang xem: {activeVideo.name}
                  </span>
                )}
              </div>

              {/* Export Video button, glowing purple when enabled */}
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                {mergedVideoUrl && (
                  <a 
                    href={`${API_BASE}/api/download?url=${encodeURIComponent(mergedVideoUrl)}&filename=video_ghep_hoan_chinh.mp4`}
                    download="video_ghep_hoan_chinh.mp4"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 20px',
                      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                      borderRadius: '8px',
                      color: '#fff',
                      fontWeight: 'bold',
                      textDecoration: 'none',
                      boxShadow: '0 4px 15px rgba(16, 185, 129, 0.3)',
                      fontSize: '0.85rem'
                    }}
                  >
                    <Download size={14} /> Tải video đã ghép
                  </a>
                )}

                <button
                  type="button"
                  onClick={handleMergeVideos}
                  disabled={mergeVideoFiles.length < 2 || isMergingVideo}
                  style={{
                    padding: '10px 20px',
                    background: mergeVideoFiles.length >= 2 
                      ? 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)' 
                      : 'rgba(255,255,255,0.05)',
                    border: 'none',
                    borderRadius: '8px',
                    color: mergeVideoFiles.length >= 2 ? '#fff' : 'rgba(255,255,255,0.3)',
                    fontSize: '0.85rem',
                    fontWeight: 'bold',
                    cursor: mergeVideoFiles.length >= 2 ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    boxShadow: mergeVideoFiles.length >= 2 ? '0 0 15px rgba(139, 92, 246, 0.4)' : 'none',
                    transition: 'all 0.2s',
                    opacity: isMergingVideo ? 0.7 : 1
                  }}
                >
                  <span>⚡</span> Xuất video
                </button>

                {mergeVideoFiles.length > 0 && (
                  <button 
                    onClick={handleReset} 
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', fontSize: '0.8rem', padding: '10px 14px', cursor: 'pointer' }}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* Error Message */}
            {mergeError && (
              <div style={{ width: '100%', padding: '10px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', color: '#f87171', fontSize: '0.8rem' }}>
                {mergeError}
              </div>
            )}
          </div>

          {/* Bottom Timeline: Horizontal Clips Sequencer */}
          <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px', background: 'rgba(15, 15, 20, 0.4)', borderRadius: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#fff' }}>Timeline: Cảnh phim ghép ({mergeVideoFiles.length})</span>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Nhấp chọn từng cảnh để xem thử preview ở trên</span>
            </div>

            {/* Timeline container */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', overflowX: 'auto', padding: '10px 4px 14px 4px', minHeight: '120px' }} className="custom-scrollbar">
              {mergeVideoFiles.map((item, index) => {
                const isActive = activePreviewIndex === index;
                return (
                  <div 
                    key={item.id} 
                    onClick={() => { setActivePreviewIndex(index); setIsPreviewPlaying(false); }}
                    style={{
                      flex: '0 0 160px',
                      width: '160px',
                      background: isActive ? 'rgba(139, 92, 246, 0.1)' : 'rgba(255,255,255,0.02)',
                      border: isActive ? '2px solid #8b5cf6' : '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '10px',
                      padding: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      cursor: 'pointer',
                      position: 'relative',
                      boxShadow: isActive ? '0 4px 15px rgba(139, 92, 246, 0.2)' : 'none',
                      transition: 'all 0.2s'
                    }}
                  >
                    <div style={{ position: 'absolute', top: '4px', left: '4px', background: 'rgba(0,0,0,0.7)', borderRadius: '4px', padding: '2px 6px', fontSize: '0.7rem', fontWeight: 'bold', color: '#a78bfa', zIndex: 2 }}>
                      #{index + 1}
                    </div>

                    <video src={item.previewUrl} style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: '6px', background: '#000' }} muted playsInline />
                    
                    <div style={{ fontSize: '0.72rem', color: '#fff', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: '1.2' }}>
                      {item.name}
                    </div>

                    {/* Timeline Controls (Move/Delete) */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', marginTop: '2px' }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: '2px' }}>
                        <button
                          type="button"
                          onClick={() => handleMoveUp(index)}
                          disabled={index === 0}
                          style={{ width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', color: '#fff', cursor: index === 0 ? 'not-allowed' : 'pointer', opacity: index === 0 ? 0.3 : 1 }}
                        >
                          <ArrowLeft size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveDown(index)}
                          disabled={index === mergeVideoFiles.length - 1}
                          style={{ width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', color: '#fff', cursor: index === mergeVideoFiles.length - 1 ? 'not-allowed' : 'pointer', opacity: index === mergeVideoFiles.length - 1 ? 0.3 : 1 }}
                        >
                          <ArrowRight size={12} />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveFile(index)}
                        style={{ width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '4px', color: '#ef4444', cursor: 'pointer' }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Add Clip (+) Trigger Button */}
              <button
                type="button"
                onClick={() => setIsLibraryPopupOpen(true)}
                style={{
                  flex: '0 0 100px',
                  height: '100px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  background: 'rgba(139, 92, 246, 0.05)',
                  border: '2px dashed rgba(139, 92, 246, 0.3)',
                  borderRadius: '10px',
                  color: '#a78bfa',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseOver={e => { e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.6)'; e.currentTarget.style.background = 'rgba(139, 92, 246, 0.1)'; }}
                onMouseOut={e => { e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.3)'; e.currentTarget.style.background = 'rgba(139, 92, 246, 0.05)'; }}
              >
                <Plus size={24} />
                <span style={{ fontSize: '0.72rem', fontWeight: 'bold' }}>Thêm cảnh</span>
              </button>
            </div>
          </div>
        </div>

        {/* Library Picker Popup Modal */}
        {isLibraryPopupOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div className="glass-panel" style={{ width: '90%', maxWidth: '650px', maxHeight: '80vh', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', border: '1px solid rgba(255,255,255,0.1)', background: '#121216', position: 'relative' }}>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '12px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: '700', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>🗂️</span> Thư viện video của bạn
                </h3>
                <button
                  type="button"
                  onClick={() => setIsLibraryPopupOpen(false)}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px' }}
                >
                  <X size={20} />
                </button>
              </div>

              {/* Scrollable list of user library items */}
              <div style={{ flex: 1, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '12px', paddingRight: '4px' }} className="custom-scrollbar">
                {completedVideos.length === 0 ? (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                    <span style={{ fontSize: '2.5rem', display: 'block', marginBottom: '8px' }}>📭</span>
                    <div style={{ fontSize: '0.85rem' }}>Thư viện của cậu đang trống rỗng.</div>
                    <div style={{ fontSize: '0.75rem', marginTop: '4px' }}>Hãy tạo video AI ở Trang chủ trước nhé!</div>
                  </div>
                ) : (
                  completedVideos.map(item => (
                    <div 
                      key={item.id} 
                      onClick={() => handleSelectFromLibrary(item)}
                      style={{
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        borderRadius: '8px',
                        padding: '6px',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        transition: 'all 0.2s'
                      }}
                      onMouseOver={e => { e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.4)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseOut={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'; e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; }}
                    >
                      <video 
                        src={item.mediaUrl} 
                        style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: '4px', background: '#000' }} 
                        muted 
                        playsInline 
                        onMouseEnter={e => {
                          e.currentTarget.muted = false;
                          e.currentTarget.play().catch(() => {});
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.pause();
                          e.currentTarget.currentTime = 0;
                          e.currentTarget.muted = true;
                        }}
                      />
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: '1.2' }} title={item.prompt}>
                        {item.prompt || "Video không tên"}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px' }}>
                <button
                  type="button"
                  className="glass-button"
                  onClick={() => setIsLibraryPopupOpen(false)}
                  style={{ padding: '8px 16px', borderRadius: '6px', fontSize: '0.8rem' }}
                >
                  Đóng
                </button>
              </div>

            </div>
          </div>
        )}

      </div>
    );
  };

  const renderTryOnView = () => {
    return (
      <div className="container" style={{ maxWidth: '800px', padding: '40px 20px', display: 'flex', flexDirection: 'column', gap: '28px', minHeight: '100vh', color: '#fff' }}>
        
        {/* Hidden inputs */}
        <input 
          type="file" 
          ref={tryonPersonInputRef} 
          style={{ display: 'none' }} 
          accept="image/*" 
          onChange={(e) => setTryonPersonFile(e.target.files[0] || null)}
        />
        <input 
          type="file" 
          ref={tryonGarmentInputRef} 
          style={{ display: 'none' }} 
          accept="image/*" 
          multiple
          onChange={(e) => setTryonGarmentFile(e.target.files[0] || null)}
        />

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ImageIcon size={28} style={{ color: '#3b82f6' }} />
              <h1 style={{ fontSize: '2rem', fontWeight: '800', margin: 0 }}>Công cụ Hình ảnh AI</h1>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '6px' }}>
              {tryonToolType === 'tryon' && <span>Thay trang phục chuyên nghiệp bằng trí tuệ nhân tạo</span>}
              {tryonToolType === 'clean_916' && <span>Tự động xóa vật thể thừa, logo và mở rộng ảnh sang dọc 9:16</span>}
              {tryonToolType === 'swap_face' && <span>Thay đổi khuôn mặt của người mẫu sang gương mặt mới</span>}
              {tryonToolType === 'change_bg' && <span>Thay đổi phông nền phía sau người mẫu, giữ nguyên người</span>}
              {tryonToolType === 'brighten_skin' && <span>Tự động nâng tone, làm trắng da mịn màng tự nhiên</span>}
            </p>
          </div>
          <button 
            onClick={() => {
              window.location.hash = '';
              setIsTryOnView(false);
            }}
            className="glass-button" 
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 20px', fontSize: '0.85rem' }}
          >
            <ArrowLeft size={16} />
            Quay lại
          </button>
        </div>

        {/* Tool Selector Tabs */}
        <div className="tab-selector" style={{ alignSelf: 'flex-start', background: 'rgba(255,255,255,0.02)', padding: '4px', borderRadius: '10px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          <button 
            type="button" 
            className={`tab-btn ${tryonToolType === 'tryon' ? 'active' : ''}`}
            onClick={() => {
              setTryonToolType('tryon');
            }}
            style={{ padding: '8px 16px', fontSize: '0.8rem', borderRadius: '6px', cursor: 'pointer', border: 'none', background: tryonToolType === 'tryon' ? 'rgba(59, 130, 246, 0.2)' : 'transparent', color: tryonToolType === 'tryon' ? '#3b82f6' : 'var(--text-secondary)' }}
          >
            1. Thay đồ AI
          </button>
          <button 
            type="button" 
            className={`tab-btn ${tryonToolType === 'clean_916' ? 'active' : ''}`}
            onClick={() => {
              setTryonToolType('clean_916');
              setTryonAspectRatio('9:16');
            }}
            style={{ padding: '8px 16px', fontSize: '0.8rem', borderRadius: '6px', cursor: 'pointer', border: 'none', background: tryonToolType === 'clean_916' ? 'rgba(59, 130, 246, 0.2)' : 'transparent', color: tryonToolType === 'clean_916' ? '#3b82f6' : 'var(--text-secondary)' }}
          >
            2. Xoá chi tiết & Đổi 9:16
          </button>
          <button 
            type="button" 
            className={`tab-btn ${tryonToolType === 'swap_face' ? 'active' : ''}`}
            onClick={() => {
              setTryonToolType('swap_face');
            }}
            style={{ padding: '8px 16px', fontSize: '0.8rem', borderRadius: '6px', cursor: 'pointer', border: 'none', background: tryonToolType === 'swap_face' ? 'rgba(59, 130, 246, 0.2)' : 'transparent', color: tryonToolType === 'swap_face' ? '#3b82f6' : 'var(--text-secondary)' }}
          >
            3. Đổi khuôn mặt AI
          </button>
          <button 
            type="button" 
            className={`tab-btn ${tryonToolType === 'change_bg' ? 'active' : ''}`}
            onClick={() => {
              setTryonToolType('change_bg');
            }}
            style={{ padding: '8px 16px', fontSize: '0.8rem', borderRadius: '6px', cursor: 'pointer', border: 'none', background: tryonToolType === 'change_bg' ? 'rgba(59, 130, 246, 0.2)' : 'transparent', color: tryonToolType === 'change_bg' ? '#3b82f6' : 'var(--text-secondary)' }}
          >
            4. Thay nền AI
          </button>
          <button 
            type="button" 
            className={`tab-btn ${tryonToolType === 'brighten_skin' ? 'active' : ''}`}
            onClick={() => {
              setTryonToolType('brighten_skin');
            }}
            style={{ padding: '8px 16px', fontSize: '0.8rem', borderRadius: '6px', cursor: 'pointer', border: 'none', background: tryonToolType === 'brighten_skin' ? 'rgba(59, 130, 246, 0.2)' : 'transparent', color: tryonToolType === 'brighten_skin' ? '#3b82f6' : 'var(--text-secondary)' }}
          >
            5. Làm trắng da AI
          </button>
        </div>

        {/* Tryon Container Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
          
          {/* Card 1: Person Image */}
          <div 
            onClick={() => tryonPersonInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = '#3b82f6'; }}
            onDragLeave={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
              const file = e.dataTransfer.files[0];
              if (file && file.type.startsWith('image/')) {
                setTryonPersonFile(file);
              }
            }}
            onPaste={(e) => {
              const items = e.clipboardData.items;
              for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                  const blob = items[i].getAsFile();
                  setTryonPersonFile(blob);
                  break;
                }
              }
            }}
            tabIndex={0}
            style={{ 
              background: 'rgba(255,255,255,0.02)', 
              border: '2px dashed rgba(255,255,255,0.1)', 
              borderRadius: '16px', 
              padding: '24px', 
              display: 'flex', 
              flexDirection: 'column', 
              alignItems: 'center', 
              justifyContent: 'center', 
              minHeight: '260px',
              cursor: 'pointer',
              transition: 'border-color 0.2s',
              textAlign: 'center',
              position: 'relative',
              overflow: 'hidden',
              outline: 'none'
            }}
            onMouseOver={(e) => e.currentTarget.style.borderColor = '#3b82f6'}
            onMouseOut={(e) => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'}
          >
            {tryonPersonFile ? (
              <>
                <img 
                  src={URL.createObjectURL(tryonPersonFile)} 
                  alt="Person Preview" 
                  style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, objectFit: 'contain', background: '#09090b' }} 
                />
                <button 
                  type="button" 
                  onClick={(e) => { e.stopPropagation(); setTryonPersonFile(null); }} 
                  style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(239, 68, 68, 0.9)', border: 'none', color: '#fff', width: '24px', height: '24px', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: 'bold', zIndex: 10 }}
                >
                  ×
                </button>
              </>
            ) : (
              <>
                <Upload size={36} style={{ color: 'var(--text-secondary)', marginBottom: '12px' }} />
                <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>1. Tải ảnh người mẫu / model</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '6px' }}>Hỗ trợ dán (Ctrl+V), Kéo thả hoặc Click để chọn ảnh</div>
              </>
            )}
          </div>

          {/* Card 2: Garment Image */}
          {tryonToolType === 'tryon' && (
            <div 
              onClick={() => tryonGarmentInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = '#10b981'; }}
              onDragLeave={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                const files = e.dataTransfer.files;
                const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
                if (imageFiles.length > 0) {
                  // Currently we support single image at backend, set the first one
                  setTryonGarmentFile(imageFiles[0]);
                  if (imageFiles.length > 1) {
                    console.log(`User uploaded ${imageFiles.length} garment files. Prepared for future bulk processing.`);
                  }
                }
              }}
              onPaste={(e) => {
                const items = e.clipboardData.items;
                for (let i = 0; i < items.length; i++) {
                  if (items[i].type.indexOf('image') !== -1) {
                    const blob = items[i].getAsFile();
                    setTryonGarmentFile(blob);
                    break;
                  }
                }
              }}
              tabIndex={0}
              style={{ 
                background: 'rgba(255,255,255,0.02)', 
                border: '2px dashed rgba(255,255,255,0.1)', 
                borderRadius: '16px', 
                padding: '24px', 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center', 
                justifyContent: 'center', 
                minHeight: '260px',
                cursor: 'pointer',
                transition: 'border-color 0.2s',
                textAlign: 'center',
                position: 'relative',
                overflow: 'hidden',
                outline: 'none'
              }}
              onMouseOver={(e) => e.currentTarget.style.borderColor = '#10b981'}
              onMouseOut={(e) => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'}
            >
              {tryonGarmentFile ? (
                <>
                  <img 
                    src={URL.createObjectURL(tryonGarmentFile)} 
                    alt="Garment Preview" 
                    style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, objectFit: 'contain', background: '#09090b' }} 
                  />
                  <button 
                    type="button" 
                    onClick={(e) => { e.stopPropagation(); setTryonGarmentFile(null); }} 
                    style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(239, 68, 68, 0.9)', border: 'none', color: '#fff', width: '24px', height: '24px', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: 'bold', zIndex: 10 }}
                  >
                    ×
                  </button>
                </>
              ) : (
                <>
                  <Upload size={36} style={{ color: 'var(--text-secondary)', marginBottom: '12px' }} />
                  <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>2. Tải ảnh trang phục / quần áo</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '6px' }}>Hỗ trợ dán (Ctrl+V), Kéo thả nhiều file hoặc Click để chọn</div>
                </>
              )}
            </div>
          )}

        </div>

        {/* Options Panel */}
        <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {tryonToolType === 'tryon' && (
            <div style={{ display: 'none', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '500' }}>Mô tả loại trang phục (ví dụ: "áo thun", "áo hoodie đen", "váy đỏ"):</span>
              <input 
                type="text" 
                placeholder="Nhập mô tả ngắn bằng tiếng Việt hoặc tiếng Anh..."
                value={tryonDescription}
                onChange={(e) => setTryonDescription(e.target.value)}
                style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '12px', color: '#fff', fontSize: '0.85rem', outline: 'none' }}
              />
            </div>
          )}

          {tryonToolType === 'change_bg' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', borderLeft: '3px solid #3b82f6', paddingLeft: '14px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '500' }}>Chọn phông nền mẫu:</span>
                <select
                  value={tryonSelectedBgPreset}
                  onChange={(e) => {
                    setTryonSelectedBgPreset(e.target.value);
                  }}
                  style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '12px', color: '#fff', fontSize: '0.85rem', outline: 'none' }}
                >
                  {BG_PRESETS.map((preset, index) => (
                    <option key={index} value={preset.prompt}>
                      {preset.name}
                    </option>
                  ))}
                  <option value="custom">-- Tự nhập mô tả nền riêng --</option>
                </select>
              </div>

              {(tryonSelectedBgPreset === 'custom' || true) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '500' }}>Mô tả nền tự do (nếu muốn tự ghi bằng tiếng Việt/tiếng Anh):</span>
                  <input 
                    type="text" 
                    placeholder="Ví dụ: bãi biển Phú Quốc hoàng hôn ấm áp, resort sang trọng..."
                    value={tryonCustomBgDescription}
                    onChange={(e) => setTryonCustomBgDescription(e.target.value)}
                    style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '12px', color: '#fff', fontSize: '0.85rem', outline: 'none' }}
                  />
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0 0' }}>
                    * Nếu chọn phông nền mẫu ở trên và nhập cả mô tả ở đây, hệ thống sẽ ưu tiên mô tả tự do này.
                  </p>
                </div>
              )}
            </div>
          )}

          {tryonToolType === 'tryon' && (
            <div style={{ display: 'none', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.02)', padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)' }}>
              <input 
                type="checkbox" 
                id="tryonPreserveBody"
                checked={tryonPreserveBody}
                onChange={(e) => setTryonPreserveBody(e.target.checked)}
                style={{ width: '16px', height: '16px', cursor: 'pointer' }}
              />
              <label htmlFor="tryonPreserveBody" style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.9)', cursor: 'pointer', fontWeight: '500', userSelect: 'none' }}>
                Giữ nguyên tư thế, khuôn mặt và nền của ảnh gốc (Preserve pose & background)
              </label>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '500' }}>Tỷ lệ ảnh đầu ra:</span>
              <select
                value={tryonAspectRatio}
                onChange={(e) => setTryonAspectRatio(e.target.value)}
                disabled={tryonToolType === 'clean_916'}
                style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '12px', color: '#fff', fontSize: '0.85rem', outline: 'none', opacity: tryonToolType === 'clean_916' ? 0.5 : 1 }}
              >
                <option value="1:1">1:1 (Ảnh vuông)</option>
                <option value="3:4">3:4 (Ảnh đứng vừa)</option>
                <option value="9:16">9:16 (Ảnh dọc TikTok/Story)</option>
                <option value="4:3">4:3 (Ảnh ngang vừa)</option>
                <option value="16:9">16:9 (Ảnh ngang HD)</option>
              </select>
            </div>

            <div style={{ display: 'none', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '500' }}>Model sinh ảnh:</span>
              <select
                value={tryonModel}
                onChange={(e) => setTryonModel(e.target.value)}
                style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '12px', color: '#fff', fontSize: '0.85rem', outline: 'none' }}
              >
                <option value="nano_banana_pro">Gemini Pix 2 (Imagen 3 Pro)</option>
                <option value="nano_banana_2">Narwhal (Imagen 3 Fast)</option>
              </select>
            </div>
          </div>

          <button
            onClick={handleTryOnSubmit}
            disabled={tryonIsSubmitting || !tryonPersonFile || (tryonToolType === 'tryon' && !tryonGarmentFile)}
            className="glass-button"
            style={{
              padding: '14px',
              background: (tryonIsSubmitting || !tryonPersonFile || (tryonToolType === 'tryon' && !tryonGarmentFile)) ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '0.95rem',
              fontWeight: 'bold',
              cursor: (tryonIsSubmitting || !tryonPersonFile || (tryonToolType === 'tryon' && !tryonGarmentFile)) ? 'default' : 'pointer',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '8px',
              marginTop: '10px'
            }}
          >
            {tryonIsSubmitting ? (
              <>
                <Loader size={16} className="spin-loader" />
                <span>Đang gửi yêu cầu...</span>
              </>
            ) : (
              <>
                <Play size={16} />
                {tryonToolType === 'tryon' && <span>Bắt đầu Thay đồ AI</span>}
                {tryonToolType === 'clean_916' && <span>Bắt đầu Xóa phần thừa</span>}
                {tryonToolType === 'swap_face' && <span>Bắt đầu Đổi khuôn mặt</span>}
                {tryonToolType === 'change_bg' && <span>Bắt đầu Thay nền</span>}
                {tryonToolType === 'brighten_skin' && <span>Bắt đầu Làm trắng da</span>}
              </>
            )}
          </button>

        </div>

      </div>
    );
  };

  // Hidden file inputs
  const startInputRef = useRef(null);
  const endInputRef = useRef(null);
  const refInputRef = useRef(null);
  const promptTextareaRef = useRef(null);
  const bottomControlsRef = useRef(null);
  const ratioMenuRef = useRef(null);
  const addMenuRef = useRef(null);
  const userDropdownRef = useRef(null);

  // Auto-resize prompt textarea: grow with content, cap at 70vh, then scroll
  const autosizePrompt = () => {
    const el = promptTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.7) + 'px';
    el.scrollTop = 0;
  };

  useEffect(() => {
    autosizePrompt();
  }, [prompt]);

  useEffect(() => {
    window.addEventListener('resize', autosizePrompt);
    return () => window.removeEventListener('resize', autosizePrompt);
  }, []);

  // Mobile keyboard: lift the fixed bottom controls above the on-screen keyboard
  // using visualViewport (iOS/Android Safari/Chrome). Without this, position:fixed
  // bottom stays hidden behind the keyboard.
  useEffect(() => {
    const wrap = bottomControlsRef.current;
    const vv = window.visualViewport;
    if (!wrap || !vv) return;

    const applyOffset = () => {
      const kbHeight = Math.max(0, window.innerHeight - vv.height);
      const isMobile = window.innerWidth <= 768;
      const baseBottom = isMobile ? 10 : 24;
      wrap.style.bottom = (kbHeight + baseBottom) + 'px';
    };

    applyOffset();
    vv.addEventListener('resize', applyOffset);
    vv.addEventListener('scroll', applyOffset);
    return () => {
      vv.removeEventListener('resize', applyOffset);
      vv.removeEventListener('scroll', applyOffset);
    };
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);

      if (currentUser && sessionStorage.getItem('is_from_tiktok') === 'true') {
        const trackKey = `tracked_login_${currentUser.uid}`;
        if (!sessionStorage.getItem(trackKey)) {
          sessionStorage.setItem(trackKey, 'true');
          fetch(`${API_BASE}/api/track/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              uid: currentUser.uid,
              email: currentUser.email || 'no-email',
              displayName: currentUser.displayName || 'no-name'
            })
          }).catch(err => console.error('Failed to send tracking login:', err));
        }
      }
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
    trackTikTokEvent('click_login');
    try {
      const result = await signInWithPopup(auth, googleProvider);
      // Init session on server (anti-account-sharing)
      if (result?.user) {
        initSessionOnServer(result.user);
      }
    } catch (error) {
      console.error("Login failed:", error);
      alert("Đăng nhập chưa thành công. Cậu vui lòng kiểm tra lại kết nối và thử lại nhé! 🔐");
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

  const handleRetryTask = async (taskId) => {
    if (!user || retryingTaskId) return;
    setRetryingTaskId(taskId);
    try {
      const response = await authFetch(user, `${API_BASE}/api/tasks/${taskId}/retry`, {
        method: 'POST'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Server returned code ${response.status}`);
    } catch (error) {
      console.error('Retry task failed:', error);
      alert(error.message || 'Không thể thử lại task lúc này.');
    } finally {
      setRetryingTaskId(null);
    }
  };

  const handleDownload = (url, filename) => {
    try {
      // Use backend proxy endpoint to enforce attachment headers for mobile download support (mechanics from ai_web3)
      const downloadUrl = `${API_BASE}/api/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e) {
      console.error("Download failed, opening URL in new tab as fallback:", e);
      window.open(url, '_blank');
    }
  };

  // Upload files locally to the backend (bypasses Firebase Storage upload issues)
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

  const uploadSingleFileToBackend = async (file) => {
    const paths = await uploadFilesLocally([file]);
    return paths[0] || null;
  };

  const handleStartFileSelect = (file) => {
    setStartFile(file);
    setStartLibraryUrl(null);
    if (!file) {
      setStartUploadState(null);
      startUploadPromiseRef.current = null;
      return;
    }
    setStartUploadState('uploading');
    startUploadPromiseRef.current = uploadSingleFileToBackend(file)
      .then(url => { setStartUploadState(url ? { url } : null); return url; })
      .catch(() => { setStartUploadState(null); return null; });
  };

  const handleEndFileSelect = (file) => {
    setEndFile(file);
    setEndLibraryUrl(null);
    if (!file) {
      setEndUploadState(null);
      endUploadPromiseRef.current = null;
      return;
    }
    setEndUploadState('uploading');
    endUploadPromiseRef.current = uploadSingleFileToBackend(file)
      .then(url => { setEndUploadState(url ? { url } : null); return url; })
      .catch(() => { setEndUploadState(null); return null; });
  };

  const addRefFiles = (newFiles) => {
    if (!newFiles || newFiles.length === 0) return;
    const startIdx = refFilesRef.current.length;
    setRefFiles(prev => [...prev, ...newFiles]);
    setRefUploadStates(prev => [...prev, ...newFiles.map(() => 'uploading')]);
    newFiles.forEach((file, offset) => {
      const idx = startIdx + offset;
      const p = uploadSingleFileToBackend(file).catch(() => null);
      refUploadPromisesRef.current.set(file, p);
      p.then(url => {
        if (!url) return;
        setRefUploadStates(prev => {
          if (refFilesRef.current[idx] !== file || prev[idx] !== 'uploading') return prev;
          const next = [...prev];
          next[idx] = { url };
          return next;
        });
      });
    });
  };

  // Clipboard Paste (Ctrl+V / Cmd+V) handler for images and image URLs
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    let pastedImageFile = null;

    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          pastedImageFile = items[i].getAsFile();
          break;
        }
      }
    }

    if (pastedImageFile) {
      e.preventDefault();
      if (isTryOnView) {
        if (!tryonPersonFile) {
          setTryonPersonFile(pastedImageFile);
        } else {
          setTryonGarmentFile(pastedImageFile);
        }
      } else if (activeTab === 'video') {
        if (!startFile && !startLibraryUrl) {
          handleStartFileSelect(pastedImageFile);
        } else if (!endFile && !endLibraryUrl) {
          handleEndFileSelect(pastedImageFile);
        } else {
          handleStartFileSelect(pastedImageFile);
        }
      } else {
        addRefFiles([pastedImageFile]);
      }
      return;
    }

    // Check if pasted text is an image URL
    const textData = e.clipboardData?.getData('text');
    if (textData && textData.trim().match(/^https?:\/\/.*\.(png|jpg|jpeg|webp|gif|svg)(\?.*)?$/i)) {
      e.preventDefault();
      const imageUrl = textData.trim();
      if (isTryOnView) {
        // Try-on view uses file inputs
      } else if (activeTab === 'video') {
        if (!startFile && !startLibraryUrl) {
          setStartLibraryUrl(imageUrl);
          setStartFile(null);
        } else if (!endFile && !endLibraryUrl) {
          setEndLibraryUrl(imageUrl);
          setEndFile(null);
        } else {
          setStartLibraryUrl(imageUrl);
          setStartFile(null);
        }
      } else {
        setSelectedRefUrls(prev => {
          if (prev.includes(imageUrl)) return prev;
          return [...prev, imageUrl];
        });
      }
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
    setRefUploadStates(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!prompt.trim() || !user || isSubmitting) return;

    // Limit checking
    const limits = {
      free: { videos: Infinity, images: Infinity },
      hocvien: { videos: 0, images: 30 },
      basic_69k: { videos: 5, images: 10 },
      standard_99k: { videos: 20, images: 40 },
      premium_169k: { videos: Infinity, images: Infinity }
    };

    const isExpired = userTier !== 'free' && userExpiryDate && userExpiryDate < Date.now();
    const activeUserTier = isExpired ? 'free' : userTier;
    const currentLimits = limits[activeUserTier] || limits.free;
    const usage = getTodayUsage();

    if (activeTab === 'video') {
      // Free tier: chỉ được làm 3 video duy nhất toàn đời (all-time)
      if (activeUserTier === 'free') {
        const allTimeVideos = getAllTimeVideoCount();
        if (allTimeVideos >= 3) {
          setLimitError({ type: 'video', limit: 3, current: allTimeVideos, isAllTime: true });
          return;
        }
      } else if (usage.videos >= currentLimits.videos) {
        setLimitError({ type: 'video', limit: currentLimits.videos, current: usage.videos });
        return;
      }
    }

    if (activeTab === 'image') {
      // Free tier: chỉ được làm 3 ảnh duy nhất toàn đời (all-time)
      if (activeUserTier === 'free') {
        const allTimeImages = getAllTimeImageCount();
        if (allTimeImages >= 3) {
          setLimitError({ type: 'image', limit: 3, current: allTimeImages, isAllTime: true });
          return;
        }
      } else if (usage.images >= currentLimits.images) {
        setLimitError({ type: 'image', limit: currentLimits.images, current: usage.images });
        return;
      }
    }
    
    setIsSubmitting(true);
    const currentPrompt = prompt;
    try {
      let startFrameUrl = startLibraryUrl || (startUploadState && startUploadState.url) || null;
      let endFrameUrl = endLibraryUrl || (endUploadState && endUploadState.url) || null;
      let referenceImagesUrls = [];

      console.log("Submitting task. ActiveTab:", activeTab);

      // 1. Upload/await start file locally (video tab)
      if (startFile && activeTab === 'video') {
        if (!startFrameUrl) {
          if (startUploadPromiseRef.current) {
            startFrameUrl = await startUploadPromiseRef.current;
          }
          if (!startFrameUrl) {
            const paths = await uploadFilesLocally([startFile]);
            startFrameUrl = paths[0] || null;
          }
        }
      }

      // 2. Upload/await end file locally (video tab)
      if (endFile && activeTab === 'video') {
        if (!endFrameUrl) {
          if (endUploadPromiseRef.current) {
            endFrameUrl = await endUploadPromiseRef.current;
          }
          if (!endFrameUrl) {
            const paths = await uploadFilesLocally([endFile]);
            endFrameUrl = paths[0] || null;
          }
        }
      }

      // 3. Upload/await reference images locally (image tab)
      referenceImagesUrls = [...selectedRefUrls];
      if (refFiles.length > 0 && activeTab === 'image') {
        for (let i = 0; i < refFiles.length; i++) {
          const file = refFiles[i];
          let url = refUploadStates[i] && refUploadStates[i].url ? refUploadStates[i].url : null;
          if (!url) {
            const p = refUploadPromisesRef.current.get(file);
            if (p) url = await p;
            if (!url) {
              const paths = await uploadFilesLocally([file]);
              url = paths[0] || null;
            }
          }
          if (url) referenceImagesUrls.push(url);
        }
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
        durationSeconds: activeTab === 'video' ? videoDuration : null,
        startImage: startFrameUrl,
        endImage: endFrameUrl,
        referenceImages: referenceImagesUrls,
        createdAt: Date.now()
      });
      console.log("Task successfully written to Firestore! Doc ID:", docRef.id);
      trackTikTokEvent(activeTab === 'video' ? 'generate_video' : 'generate_image', { prompt: currentPrompt.trim() });

      // Clear form (keep start/end frames so user can send again)
      setPrompt('');
      setRefFiles([]);
      setRefUploadStates([]);
      refUploadPromisesRef.current = new Map();
      setSelectedRefUrls([]);
    } catch (error) {
      console.error("Error adding task: ", error);
      alert("Rất tiếc, hệ thống gặp một chút sự cố khi gửi yêu cầu tạo: " + error.message + ". Cậu thử lại sau giây lát nhé! 🥺");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return <div className="container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'var(--text-secondary)' }}>Đang tải...</div>;
  }

  if (!user) {
    return (
      <div style={{ 
        position: 'fixed', 
        top: 0, 
        left: 0, 
        right: 0, 
        bottom: 0, 
        background: '#09090b', 
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        justifyContent: 'center', 
        overflow: 'hidden',
        zIndex: 99999
      }}>
        {/* Background Ambient Glows */}
        <div className="login-bg-glow-1" />
        <div className="login-bg-glow-2" />

        {/* Login Card */}
        <div style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '90%',
          maxWidth: '460px',
          padding: '48px 32px',
          background: 'rgba(255, 255, 255, 0.02)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          borderRadius: '32px',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
          textAlign: 'center'
        }}>
          {/* Pulsing Glowing Logo Container */}
          <div className="login-logo-container" style={{ 
            background: '#020204', 
            padding: '16px', 
            borderRadius: '24px', 
            border: '1px solid rgba(255,255,255,0.08)',
            marginBottom: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <img src="/logo.png" alt="meo3 logo" style={{ width: '80px', height: '80px', objectFit: 'contain' }} />
          </div>

          {/* Premium Title */}
          <h1 className="logo-text" style={{ 
            fontSize: 'clamp(2.5rem, 8vw, 3.2rem)', 
            marginBottom: '12px', 
            background: 'linear-gradient(135deg, #60a5fa 0%, #a78bfa 50%, #f472b6 100%)', 
            WebkitBackgroundClip: 'text', 
            WebkitTextFillColor: 'transparent', 
            fontWeight: '900',
            letterSpacing: '-0.02em',
            textShadow: '0 0 40px rgba(139, 92, 246, 0.2)'
          }}>
            meo3
          </h1>

          {/* Subtitle */}
          <p style={{ 
            color: 'var(--text-secondary)', 
            marginBottom: '40px', 
            fontSize: '1rem', 
            lineHeight: '1.6',
            maxWidth: '320px',
            fontWeight: '500'
          }}>
            Tạo ảnh và video AI chuyên nghiệp với nền tảng Cloud mạnh mẽ.
          </p>

          {/* In-app Browser warning for TikTok/Facebook ads */}
          {/FBAN|FBAV|Instagram|TikTok|Messenger|Line|Zalo/i.test(navigator.userAgent || navigator.vendor || window.opera) && (
            <div style={{
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              borderRadius: '16px',
              padding: '16px',
              marginBottom: '24px',
              textAlign: 'left',
              color: '#fde047',
              fontSize: '0.85rem',
              lineHeight: '1.5',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', color: '#fbbf24' }}>
                <span>⚠️ LƯU Ý KHI CHẠY TRÊN TIKTOK / FACEBOOK:</span>
              </div>
              <p style={{ margin: 0 }}>
                Trình duyệt mặc định của TikTok/Facebook bị Google chặn không cho đăng nhập Google.
              </p>
              <p style={{ margin: 0, fontWeight: 'bold', color: '#fff' }}>
                👉 Để đăng nhập và thanh toán thành công, vui lòng bấm vào nút ba chấm (...) ở góc trên cùng bên phải và chọn "Mở bằng trình duyệt" (hoặc "Open in Safari / Chrome") nhé!
              </p>
            </div>
          )}

          {/* Premium Google Button */}
          <button className="google-btn-premium" onClick={handleLogin} style={{ width: '100%', justifyContent: 'center' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22c-.87-2.6-2.86-4.53-5.84-4.53z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
            </svg>
            <span>Đăng nhập bằng Google</span>
          </button>
        </div>
      </div>
    );
  }

  const getSubView = () => {
    if (isAdminView) {
      return renderAdminView();
    }
    if (isAutoToolView) {
      if (userProfileLoaded && currentUserIsAdmin) return renderAutoToolView();
      return <div className="container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'var(--text-secondary)' }}>Đang xác thực quyền quản trị...</div>;
    }
    if (isTryOnView) {
      return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '32px', maxWidth: '1400px', margin: '0 auto' }}>
          <div style={{ flex: '1 1 0', minWidth: 0 }}>
            {renderTryOnView()}
          </div>
          <div className="tryon-ba-panel" style={{ display: 'none', flex: `0 0 ${tryonToolType === 'tryon' ? '540px' : '450px'}`, position: 'sticky', top: '40px', paddingTop: '40px' }}>
            <BeforeAfterPanel toolType={tryonToolType} />
          </div>
        </div>
      );
    }
    if (isToolsView) {
      return renderToolsView();
    }
    if (isAudioView) {
      return renderAudioView();
    }
    if (isDramaView) {
      return renderDramaView();
    }
    if (isMergeVideoView) {
      return renderMergeVideoView();
    }
    return null;
  };

  const subView = getSubView();
  if (subView) {
    return (
      <>
        {subView}
        {renderFloatingToolsButton()}
      </>
    );
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
        onChange={(e) => {
          handleStartFileSelect(e.target.files[0] || null);
          e.target.value = '';
        }}
      />
      <input 
        type="file" 
        ref={endInputRef} 
        style={{ display: 'none' }} 
        accept="image/*" 
        onChange={(e) => {
          handleEndFileSelect(e.target.files[0] || null);
          e.target.value = '';
        }}
      />
      <input 
        type="file" 
        ref={refInputRef} 
        style={{ display: 'none' }} 
        multiple 
        accept="image/*" 
        onChange={(e) => {
          addRefFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />

      {/* Top Header Bar */}
      <header className="header-container">
        <div className="logo-container">
          <img src="/logo.png" alt="meo3 logo" className="logo-image" />
          <span className="logo-text">meo3</span>
        </div>
        
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {/* Dynamic Subscription Badge & Upgrade Button */}
          <div 
            onClick={() => setShowPricingModal(true)}
            style={{ 
              cursor: 'pointer', 
              userSelect: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
            title="Bấm để nâng cấp / thay đổi gói"
          >
            {userTier === 'premium_169k' && (
              <span style={{ fontSize: '0.68rem', padding: '4px 8px', background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)', color: '#16161a', borderRadius: '6px', fontWeight: 'bold', boxShadow: '0 0 10px rgba(251, 191, 36, 0.3)' }}>Premium</span>
            )}
            
            {/* Highly visible pop-out upgrade button if not Premium */}
            {userTier !== 'premium_169k' && (
              <button 
                type="button"
                style={{
                  background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#fff',
                  padding: '5px 12px',
                  fontSize: '0.72rem',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  boxShadow: '0 0 12px rgba(139, 92, 246, 0.4)',
                  transition: 'transform 0.2s, box-shadow 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  animation: 'pulse 2s infinite'
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.transform = 'scale(1.05)';
                  e.currentTarget.style.boxShadow = '0 0 18px rgba(139, 92, 246, 0.6)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.transform = 'scale(1)';
                  e.currentTarget.style.boxShadow = '0 0 12px rgba(139, 92, 246, 0.4)';
                }}
              >
                <span style={{ display: 'inline-block', transform: 'scale(1.1)' }}>⚡</span> Nâng cấp
              </button>
            )}
          </div>

          {/* AI Tools Button in Header */}
          <button
            type="button"
            onClick={() => {
              window.location.hash = '#tools';
              setIsToolsView(true);
            }}
            title="Danh sách công cụ AI"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '6px 14px',
              background: 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
              border: 'none',
              borderRadius: '20px',
              color: '#fff',
              cursor: 'pointer',
              transition: 'all 0.2s ease-in-out',
              boxShadow: '0 0 14px rgba(139, 92, 246, 0.4)',
              fontWeight: 'bold',
              height: '32px'
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.transform = 'scale(1.05)';
              e.currentTarget.style.boxShadow = '0 0 20px rgba(236, 72, 153, 0.6)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 0 14px rgba(139, 92, 246, 0.4)';
            }}
          >
            <LayoutGrid size={14} />
            <span className="header-tool-btn-text" style={{ fontSize: '0.78rem', fontWeight: '800', letterSpacing: '0.3px' }}></span>
          </button>
          {/* Avatar Dropdown Container */}
          <div style={{ position: 'relative' }} ref={userDropdownRef}>
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

                  <button
                    type="button"
                    onClick={() => {
                      setShowUserDropdown(false);
                      window.location.hash = '#tryon';
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '8px 10px',
                      background: 'linear-gradient(135deg, rgba(124, 58, 237, 0.25) 0%, rgba(59, 130, 246, 0.25) 100%)',
                      border: '1px solid rgba(139, 92, 246, 0.4)',
                      borderRadius: '6px',
                      color: '#a78bfa',
                      fontSize: '0.75rem',
                      fontWeight: '700',
                      cursor: 'pointer',
                      textAlign: 'left',
                      marginTop: '4px',
                      boxShadow: '0 0 10px rgba(139, 92, 246, 0.2)',
                      animation: 'pulse 2s infinite'
                    }}
                  >
                    <span style={{ fontSize: '10px' }}>🎓</span>
                    Tool cho học viên
                  </button>

                {currentUserIsAdmin && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setShowUserDropdown(false);
                        window.location.hash = '#autotool';
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        width: '100%',
                        padding: '8px 10px',
                        background: 'rgba(139,92,246,0.12)',
                        border: 'none',
                        borderRadius: '6px',
                        color: '#a78bfa',
                        fontSize: '0.75rem',
                        fontWeight: '600',
                        cursor: 'pointer',
                        textAlign: 'left',
                        marginTop: '4px'
                      }}
                    >
                      <Video size={12} />
                      AutoTool
                    </button>

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
                  </>
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

                <div style={{
                  fontSize: '0.62rem',
                  color: 'rgba(255,255,255,0.28)',
                  textAlign: 'center',
                  padding: '4px 0 2px',
                  borderTop: '1px solid rgba(255,255,255,0.05)',
                  userSelect: 'none'
                }}>
                  {APP_VERSION}
                </div>
              </div>
            )}
          </div>


        </div>
      </header>

      {/* Retention Notice Banner */}
      <div style={{
        margin: '10px 10px 0 10px',
        padding: '8px 12px',
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
                        {getTaskErrorText(task)}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center' }}>
                        <button onClick={() => handleDeleteTask(task.id)} className="tab-btn" style={{ fontSize: '0.7rem', padding: '4px 10px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: '6px' }}>
                          Xóa
                        </button>
                        {canRetryTask(task) && (
                          <button
                            onClick={() => handleRetryTask(task.id)}
                            disabled={retryingTaskId === task.id}
                            className="tab-btn"
                            style={{ fontSize: '0.7rem', padding: '5px 10px', background: 'rgba(59,130,246,0.12)', color: '#60a5fa', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '5px', cursor: retryingTaskId === task.id ? 'wait' : 'pointer' }}
                          >
                            {retryingTaskId === task.id ? <Loader size={12} className="spin" /> : <RotateCcw size={12} />}
                            {retryingTaskId === task.id ? 'Đang thử...' : `Thử lại (${Number(task.retryCount) || 0}/${TASK_RETRY_LIMIT})`}
                          </button>
                        )}
                      </div>
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
                      onClick={() => setActiveLightboxMedia({ type: 'video', mediaUrl: task.mediaUrl, prompt: task.prompt })}
                      style={{ cursor: 'zoom-in' }}
                    />
                    <div className="video-play-overlay" onClick={() => setActiveLightboxMedia({ type: 'video', mediaUrl: task.mediaUrl, prompt: task.prompt })} style={{ cursor: 'zoom-in' }}>
                      <Play size={16} fill="currentColor" style={{ marginLeft: '2px' }} />
                    </div>
                  </>
                ) : (
                  <img 
                    src={task.mediaUrl} 
                    alt={task.prompt} 
                    loading="lazy" 
                    onClick={() => setActiveLightboxMedia({ type: 'image', mediaUrl: task.mediaUrl, prompt: task.prompt })}
                    style={{ cursor: 'zoom-in' }}
                  />
                )}
                
                {/* Floating Actions in Top-Right Corner */}
                <div className="item-actions-overlay">
                  {/* Add to prompt / start-end frame (Only for Image) */}
                  {task.type === 'image' && (
                    <button 
                      type="button"
                      onClick={() => {
                        if (isTryOnView) {
                          // If in tryon view, set as model image
                          setTryonPersonFile(null); // URL support would need setTryonPersonUrl but we only have File, so we can alert or skip.
                          alert("Cậu hãy tải ảnh trực tiếp từ máy/điện thoại lên để sử dụng công cụ AI nhé! 😉");
                        } else if (activeTab === 'video') {
                          if (!startFile && !startLibraryUrl) {
                            setStartLibraryUrl(task.mediaUrl);
                            setStartFile(null);
                          } else if (!endFile && !endLibraryUrl) {
                            setEndLibraryUrl(task.mediaUrl);
                            setEndFile(null);
                          } else {
                            setStartLibraryUrl(task.mediaUrl);
                            setStartFile(null);
                          }
                        } else {
                          setSelectedRefUrls(prev => {
                            if (prev.includes(task.mediaUrl)) return prev;
                            return [...prev, task.mediaUrl];
                          });
                        }
                      }}
                      className="action-circle-btn" 
                      data-tooltip={activeTab === 'video' ? "Sử dụng làm Start/End frame" : "Thêm vào ảnh tham khảo"}
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
        </div>

        {/* Empty State (outside masonry grid so it centers full-width) */}
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
      </main>

      {/* Floating Bottom Controls Wrapper */}
      <div className="bottom-controls-wrapper" ref={bottomControlsRef}>
        
        {/* Input Bar Pill */}
        <form 
          onSubmit={handleSubmit} 
          className="prompt-pill-bar"
          style={{ 
            flexDirection: 'column', 
            alignItems: 'stretch', 
            borderRadius: '20px', 
            padding: '10px 12px', 
            gap: '6px' 
          }}
        >
          {/* Row 1: Previews / Upload Placeholders */}
          {activeTab === 'video' ? (
            <div style={{ display: 'flex', gap: '6px', marginBottom: '2px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '6px' }}>
              {/* Start Image Box */}
              <div 
                onClick={() => {
                  if (!startFile && !startLibraryUrl) {
                    setAddFileContext('start');
                    setShowAddMenu(true);
                  }
                }}
                style={{ 
                  width: '28px', 
                  height: '28px', 
                  borderRadius: '6px', 
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
                    <button type="button" onClick={(e) => { e.stopPropagation(); setStartFile(null); setStartLibraryUrl(null); setStartUploadState(null); startUploadPromiseRef.current = null; }} className="remove-preview-btn">×</button>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '7px', textAlign: 'center', padding: '1px 0', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' }}>Start</div>
                    {startUploadState === 'uploading' && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px', borderRadius: '6px', zIndex: 2 }}>
                        <Loader size={10} className="spin-loader" style={{ color: '#fff' }} />
                        <span style={{ fontSize: '6px', color: '#fff', fontWeight: '700' }}>đang tải</span>
                      </div>
                    )}
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
                  width: '28px', 
                  height: '28px', 
                  borderRadius: '6px', 
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
                    <button type="button" onClick={(e) => { e.stopPropagation(); setEndFile(null); setEndLibraryUrl(null); setEndUploadState(null); endUploadPromiseRef.current = null; }} className="remove-preview-btn">×</button>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '7px', textAlign: 'center', padding: '1px 0', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' }}>End</div>
                    {endUploadState === 'uploading' && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px', borderRadius: '6px', zIndex: 2 }}>
                        <Loader size={10} className="spin-loader" style={{ color: '#fff' }} />
                        <span style={{ fontSize: '6px', color: '#fff', fontWeight: '700' }}>đang tải</span>
                      </div>
                    )}
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
                    {refUploadStates[idx] === 'uploading' && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px', borderRadius: '8px', zIndex: 2 }}>
                        <Loader size={12} className="spin-loader" style={{ color: '#fff' }} />
                        <span style={{ fontSize: '7px', color: '#fff', fontWeight: '700' }}>đang tải</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {/* Row 2: Prompt Text Input (Full Width) */}
          <textarea 
            ref={promptTextareaRef}
            rows={1}
            className="prompt-textarea"
            placeholder={activeTab === 'video' ? "Mô tả video bạn muốn tạo... (Nhấn Ctrl+V dán ảnh trực tiếp)" : "Mô tả hình ảnh bạn muốn tạo... (Nhấn Ctrl+V dán ảnh trực tiếp)"}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              autosizePrompt();
            }}
            onPaste={handlePaste}
            disabled={isSubmitting}
            style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: '2px 0', overflowY: 'auto' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />

          {/* Row 3: Action Toolbar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '2px', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <div style={{ position: 'relative' }} ref={addMenuRef}>
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

            <div className="tab-selector" style={{ flexShrink: 0 }}>
              <button 
                type="button"
                className={`tab-btn ${activeTab === 'video' ? 'active' : ''}`}
                onClick={() => setActiveTab('video')}
                disabled={isSubmitting}
                style={{ padding: '4px 8px', fontSize: '0.72rem' }}
              >
                <Video size={12} /> Video
              </button>
              <button 
                type="button"
                className={`tab-btn ${activeTab === 'image' ? 'active' : ''}`}
                onClick={() => setActiveTab('image')}
                disabled={isSubmitting}
                style={{ padding: '4px 8px', fontSize: '0.72rem' }}
              >
                <ImageIcon size={12} /> Ảnh
              </button>
            </div>

            <div style={{ position: 'relative', flexShrink: 0 }} ref={ratioMenuRef}>
              <button
                type="button"
                className={`ratio-chip ${showRatioMenu ? 'active' : ''}`}
                onClick={() => setShowRatioMenu(prev => !prev)}
                disabled={isSubmitting}
                title="Chọn tỷ lệ"
                style={{ width: '28px', height: '28px', padding: '4px' }}
              >
                <div className="ratio-box" style={{ width: `${RATIOS.find(r => r.value === aspectRatio)?.width || 14}px`, height: `${RATIOS.find(r => r.value === aspectRatio)?.height || 14}px` }} />
              </button>

              {showRatioMenu && (
                <div style={{
                  position: 'absolute',
                  bottom: '36px',
                  left: '0',
                  background: 'rgba(20, 20, 25, 0.96)',
                  backdropFilter: 'blur(16px)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '12px',
                  padding: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                  zIndex: 100
                }}>
                  {RATIOS.map(r => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => { setAspectRatio(r.value); setShowRatioMenu(false); }}
                      disabled={isSubmitting}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        background: aspectRatio === r.value ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                        border: 'none', borderRadius: '8px', padding: '6px 10px',
                        color: aspectRatio === r.value ? '#3b82f6' : 'var(--text-secondary)',
                        fontSize: '0.78rem', fontWeight: '600', cursor: 'pointer',
                        textAlign: 'left', whiteSpace: 'nowrap'
                      }}
                    >
                      <div className="ratio-box" style={{ width: `${r.width}px`, height: `${r.height}px` }} />
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            </div>

            <button 
              type="submit" 
              className="submit-arrow-btn"
              disabled={!prompt.trim() || isSubmitting}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '50%', background: prompt.trim() ? '#3b82f6' : 'rgba(255,255,255,0.04)', border: 'none', color: prompt.trim() ? '#fff' : 'rgba(255,255,255,0.2)', cursor: prompt.trim() ? 'pointer' : 'default', transition: 'all 0.2s', padding: 0, flexShrink: 0 }}
            >
              {isSubmitting ? <Loader size={16} className="spin-loader" /> : <ArrowRight size={16} />}
            </button>
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
          overflowY: 'auto',
          zIndex: 10000,
          padding: '20px'
        }}>
          <div style={{
            background: '#16161a',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '400px',
            margin: 'auto',
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
              {limitError.isAllTime
                ? <>Gói <strong>Free</strong> chỉ được tạo <strong>{limitError.limit} {limitError.type === 'video' ? 'video' : 'ảnh'}</strong> (trọn đời). Bạn đã dùng hết lượt thử miễn phí rồi. Nâng cấp để tiếp tục tạo {limitError.type === 'video' ? 'video' : 'ảnh'} nhé! 🎬</>
                : <>Bạn đã dùng hết {limitError.current}/{limitError.limit} lượt tạo {limitError.type === 'video' ? 'Video' : 'Ảnh'} hôm nay của gói <strong>{userTier === 'free' ? 'Free' : userTier === 'hocvien' ? 'Học viên' : userTier === 'basic_69k' ? 'Basic' : userTier === 'standard_99k' ? 'Standard' : 'Premium'}</strong>.</>
              }
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
          overflowY: 'auto',
          zIndex: 9999,
          padding: '20px'
        }}>
          <div style={{
            background: '#16161a',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '20px',
            width: '100%',
            maxWidth: '800px',
            maxHeight: 'calc(100vh - 40px)',
            margin: 'auto',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 25px 60px rgba(0, 0, 0, 0.7)'
          }}>
            {/* Header */}
            <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
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
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 5 lượt tạo giọng nói / ngày</li>
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
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#fbbf24', fontWeight: '600' }}>✓ Không giới hạn Video</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#fbbf24', fontWeight: '600' }}>✓ Không giới hạn Ảnh</li>
                  <li style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>✓ 50 lượt tạo giọng nói / ngày</li>
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
          overflowY: 'auto',
          zIndex: 10005,
          padding: '20px'
        }}>
          <div style={{
            background: '#16161a',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '20px',
            width: '100%',
            maxWidth: '580px',
            maxHeight: 'calc(100vh - 40px)',
            margin: 'auto',
            boxShadow: '0 25px 60px rgba(0, 0, 0, 0.7)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            {/* Header */}
            <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
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
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', alignItems: 'center', justifyContent: 'center' }}>
                {/* VietQR Code Image */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                  <div style={{ padding: '12px', background: '#fff', borderRadius: '16px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)', width: '200px', height: '200px', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {qrLoading && (
                      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', borderRadius: '16px' }}>
                        <Loader size={24} className="spin-loader" style={{ color: '#3b82f6' }} />
                      </div>
                    )}
                    <img 
                      src={`https://img.vietqr.io/image/OCB-CASS26030609-compact.png?amount=${getUpgradeCost(selectedTierForPay)}&addInfo=${encodeURIComponent(pendingPayment ? pendingPayment.code : 'VE')}&accountName=VAN%20THI%20HANG`} 
                      alt="VietQR Payment Code" 
                      onLoad={() => setQrLoading(false)}
                      style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: qrLoading ? 0 : 1, transition: 'opacity 0.2s' }} 
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
                      <span style={{ color: '#fff', fontWeight: 'bold', fontSize: '0.95rem' }}>CASS26030609</span>
                      <button type="button" onClick={() => handleCopyText('CASS26030609')} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px', padding: '2px 6px', fontSize: '0.65rem', color: '#3b82f6', cursor: 'pointer', fontWeight: 'bold' }}>Copy</button>
                    </div>
                  </div>
                  <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Tên người thụ hưởng:</span>
                    <span style={{ color: '#fff', fontWeight: '600' }}>VAN THI HANG</span>
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

      {/* Lightbox Media Overlay */}
      {activeLightboxMedia && (
        <div 
          onClick={() => setActiveLightboxMedia(null)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(5, 5, 8, 0.95)',
            backdropFilter: 'blur(20px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            overflowY: 'auto',
            zIndex: 20000,
            padding: '16px'
          }}
        >
          {/* Main Wrapper */}
          <div 
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              height: '100%',
              maxWidth: '900px',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative'
            }}
          >
            {/* Header / Actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', marginBottom: '12px' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Chi Tiết Tác Phẩm</span>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button 
                  onClick={() => handleDownload(activeLightboxMedia.mediaUrl, `${activeLightboxMedia.type}_detail.${activeLightboxMedia.type === 'video' ? 'mp4' : 'jpg'}`)}
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '8px 16px', fontSize: '0.78rem', color: '#fff', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <Download size={13} /> Tải Xuống
                </button>
                <button 
                  onClick={() => setActiveLightboxMedia(null)}
                  style={{ background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '50%', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px' }}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Media Render Container - Flex: 1 to maximize height */}
            <div style={{ 
              flex: '1', 
              minHeight: 0, 
              width: '100%',
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              background: '#020204',
              borderRadius: '16px',
              padding: '8px'
            }}>
              {activeLightboxMedia.type === 'video' ? (
                <video 
                  src={activeLightboxMedia.mediaUrl} 
                  controls 
                  autoPlay 
                  loop 
                  playsInline 
                  style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain', borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} 
                />
              ) : (
                <img 
                  src={activeLightboxMedia.mediaUrl} 
                  alt="" 
                  style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain', borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} 
                />
              )}
            </div>

            {/* Bottom Card for Prompts and Metadata */}
            <div style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              gap: '8px', 
              padding: '16px', 
              background: 'rgba(20, 20, 25, 0.6)', 
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.05)', 
              borderRadius: '16px',
              marginTop: '12px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mô tả đầy đủ (Prompt)</span>
                <button 
                  onClick={() => {
                    handleCopyText(activeLightboxMedia.prompt);
                    alert("Đã sao chép mô tả (Prompt) vào khay nhớ tạm thành công! 📋");
                  }}
                  style={{ background: 'rgba(59, 130, 246, 0.15)', border: 'none', borderRadius: '6px', color: '#3b82f6', fontSize: '0.72rem', fontWeight: 'bold', padding: '4px 8px', cursor: 'pointer' }}
                >
                  Sao Chép Prompt
                </button>
              </div>
              <div style={{ 
                fontSize: '0.8rem', 
                color: '#ececf1', 
                lineHeight: '1.4',
                maxHeight: '60px',
                overflowY: 'auto',
                fontStyle: 'italic',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}>
                "{activeLightboxMedia.prompt}"
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--text-secondary)', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '6px', marginTop: '2px' }}>
                <div>Định dạng: <span style={{ color: '#fff', fontWeight: '500' }}>{activeLightboxMedia.type === 'video' ? 'Video (MP4)' : 'Ảnh (JPG)'}</span></div>
                <div>Lưu trữ: <span style={{ color: '#ef4444', fontWeight: 'bold' }}>Dưới 24 giờ</span></div>
              </div>
            </div>

          </div>
        </div>
      )}
      {renderFloatingToolsButton()}
    </div>
  );
}

export default App;
