const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { db } = require('./firebase_worker');
const { uploadToR2 } = require('./s3_uploader');
const { logger, sleep } = require('./utils');
const audioClient = require('./audio_client');

const {
  runChildTaskWithRetry,
  updateScene,
  waitForTask
} = require('./autotool');

const activeJobs = new Set();
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed']);
const TASK_POLL_INTERVAL_MS = Number(process.env.AUTOTOOL_POLL_INTERVAL_MS || 5000);
const IMAGE_TIMEOUT_MS = Number(process.env.AUTOTOOL_IMAGE_TIMEOUT_MS || 30 * 60 * 1000);
const VIDEO_TIMEOUT_MS = Number(process.env.AUTOTOOL_VIDEO_TIMEOUT_MS || 45 * 60 * 1000);
const AUDIO_TIMEOUT_MS = Number(process.env.DRAMA_AUDIO_TIMEOUT_MS || 10 * 60 * 1000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.AUTOTOOL_DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);
const FFMPEG_TIMEOUT_MS = Number(process.env.AUTOTOOL_FFMPEG_TIMEOUT_MS || 10 * 60 * 1000);

const DEFAULT_DRAMA_TOPIC = 'mẹ chồng nàng dâu';
const MAX_SCENES = 6;
const MAX_CHARACTERS = 3;

function extractJson(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`AI did not return valid JSON. Raw response: ${text.slice(0, 300)}`);
  }
}

async function callDramaAI({ system, user, temperature = 0.8, maxRetries = 3 }) {
  const baseUrl = (process.env.AUTOTOOL_AI_BASE_URL || 'http://127.0.0.1:8081').replace(/\/$/, '');
  const apiUrl = `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const apiKey = process.env.AUTOTOOL_AI_API_KEY;
  if (!apiKey) throw new Error('AUTOTOOL_AI_API_KEY is not configured');

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.AUTOTOOL_SCRIPT_TIMEOUT_MS || 180000));
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: process.env.AUTOTOOL_AI_MODEL || 'gemini-3.6-flash',
          temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Drama AI request failed (${response.status}): ${body.slice(0, 500)}`);
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      try {
        return extractJson(content);
      } catch (parseError) {
        lastError = parseError;
        logger.warn(`[Drama] AI returned non-JSON on attempt ${attempt}: ${String(content || '').slice(0, 200)}`);
        if (attempt >= maxRetries) throw lastError;
        user += '\n\nQUAN TRỌNG: Phản hồi trước của bạn KHÔNG phải JSON hợp lệ. Hãy chỉ trả về MỘT đối tượng JSON thuần túy đúng schema yêu cầu, không mở đầu, không giải thích, không markdown.';
        await sleep(1000 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Drama AI call failed');
}

// Produces: title, characters, baseImagePrompt, and scenes.
async function generateDramaScript({ topic, channelType = 'drama' }) {
  const inputTopic = String(topic || '').trim();
  
  let systemPrompt = '';
  let userPrompts = [];
  
  if (channelType === 'sumo') {
    const themePrompt = inputTopic 
      ? `Hãy sáng tạo một kịch bản phim hoạt hình 3D Pixar vui nhộn, giáo dục dinh dưỡng và quảng cáo sản phẩm Gạc Hươu Non Sumo về chủ đề cụ thể: "${inputTopic}".`
      : 'Hãy tự sáng tạo ra một chủ đề kịch bản hoạt hình dinh dưỡng trẻ em 3D Pixar vui nhộn ngẫu nhiên bất kỳ (lười ăn rau, tiêu hóa tốt, chất xơ, vitamin, ăn uống đa dạng...) để quảng cáo sản phẩm Gạc Hươu Non Sumo.';
      
    systemPrompt = 'Bạn là nhà biên kịch phim hoạt hình 3D Pixar xuất chúng, cực kỳ sáng tạo, chuyên viết các câu chuyện vui nhộn, bất ngờ, đầy trí tưởng tượng cho trẻ em Việt Nam kết hợp quảng cáo thương hiệu Gạc Hươu Non SUMO dạng dọc (9:16). '
      + 'Tuân thủ chính xác schema JSON được yêu cầu, không xuất thêm gì khác.';
      
    userPrompts = [
      themePrompt,
      'KỊCH BẢN PHẢI ĐẶC BIỆT SÁNG TẠO, DÍ DỎM, TRÁNH RẬP KHUÔN. Có đúng 3 nhân vật xuất hiện xuyên suốt kịch bản: bé Bin (5 tuổi đáng yêu, mặc áo thun kẻ sọc ngang xanh-cam-trắng và quần đùi xanh), chú hươu Sumo (chuyên gia dinh dưỡng thông thái, đi bằng 2 chân, luôn mặc áo choàng đỏ và thắt nơ đỏ ở cổ - red cape and red bowtie), và nhân vật phụ thứ 3 (Bạn học hoặc Mẹ bé Bin).',
      'YÊU CẦU SÁNG TẠO & PHONG CÁCH KỂ CHUYỆN:',
      '- Bối cảnh đa dạng (Settings): Hãy tự do lựa chọn các địa điểm ngộ nghĩnh khác nhau tùy thuộc vào chủ đề (ví dụ: căn bếp ma thuật rực rỡ, quầy nước trái cây đầy màu sắc, khu rừng rau củ khổng lồ, góc camping mini ngoài sân sau, thế giới tưởng tượng trong mơ của Bin...). ĐỪNG chỉ rập khuôn ở thảm picnic!',
      '- Lời thoại sinh động, ẩn dụ hài hước (Playful Analogies): Tránh thuyết giảng khô khan. Hãy dùng các ví von dễ thương của trẻ em (ví dụ: ví dạ dày như đoàn tàu cần nhiên liệu nhiều màu, ví vitamin như các siêu anh hùng bảo vệ cơ thể khỏi quái vật vi khuẩn...). Lời thoại hài hước, dí dỏm, tạo bất ngờ cho trẻ nhỏ.',
      '- Quảng cáo tự nhiên (Organic Ad placement): Lồng ghép sản phẩm Gạc Hươu Non Sumo một cách tự nhiên vào mạch truyện của cảnh 5 (ví dụ: như một bảo bối năng lượng bỏ túi của hươu Sumo, túi nước ép trái cây kỳ diệu giúp tiếp năng lượng nhanh...).',
      'CẤU TRÚC KỊCH BẢN BẮT BUỘC ĐÚNG 6 CẢNH (MAX_SCENES = 6):',
      '- Cảnh 1 (Hook): Bin có một hành động hoặc tuyên bố gây cười, ngộ nghĩnh hoặc lười ăn/uống lành mạnh. Mẹ hoặc bạn ngạc nhiên. Sumo xuất hiện bất ngờ với hiệu ứng dễ thương.',
      '- Cảnh 2 (Thắc mắc/Tranh luận): Bin hỏi Sumo bằng giọng ngây thơ/bắt bẻ đáng yêu. Sumo dùng hình ảnh ví von hoặc phép so sánh khoa học cực kỳ vui nhộn để trả lời.',
      '- Cảnh 3 (Hậu quả kịch tính nhẹ): Sumo mô tả hoặc mở ra một hình dung ngộ nghĩnh về hậu quả nếu Bin lười làm thói quen tốt (ví dụ: các bạn tế bào trong người đình công, bụng reo réo kêu cứu...). Bin bất ngờ lo lắng nhẹ.',
      '- Cảnh 4 (Giải pháp/Hoạt động vui vẻ): Sumo bày ra một trò chơi, thử thách hoặc phép thuật ngắn để giải quyết vấn đề (ví dụ: thử thách đĩa ăn cầu vồng, trò chơi phân loại siêu quả, thi xem ai uống nước nhanh...). Bin hào hứng tham gia.',
      '- Cảnh 5 (Quảng cáo sản phẩm): Bin tò mò làm sao để luôn đủ chất khi đi học/kén ăn. Sumo giới thiệu GẠC HƯƠU NON SUMO (nhung hươu cô đặc, Vitamin C, Kẽm, FOS, và 5 loại quả nhiệt đới: cam, xoài, ổi, chuối, chanh dây) như một bảo bối năng lượng tiện lợi, thơm ngon cho bé.',
      '- Cảnh 6 (Kết thúc & Tương tác): Bin thay đổi suy nghĩ, tạo dáng đáng yêu cùng Sumo. Bin hướng về camera đố khán giả một câu hỏi vui nhộn liên quan đến chủ đề để kích thích người xem bình luận dưới video.',
      'Trả về JSON đúng dạng, không markdown, không chú thích, đúng hình dạng sau:',
      '{"title":"...","characters":[{"name":"...","age":"...","role":"...","description":"..."}],"baseImagePrompt":"...","scenes":[{"title":"...","description":"...","imagePrompt":"...","endImagePrompt":"...","videoPrompt":"...","dialogue":[{"speaker":"...","text":"..."}]}]}',
      '- title: tiêu đề kịch bản hoạt hình, ngắn gọn, sáng tạo, thu hút trẻ em (tiếng Việt).',
      '- characters: đúng 3 nhân vật như yêu cầu, kèm vai trò và mô tả chi tiết ngoại hình.',
      '- baseImagePrompt: mô tả bối cảnh sáng tạo đã chọn + phong cách hoạt hình 3D Pixar, vertical 9:16.',
      `- scenes: đúng 6 cảnh theo cấu trúc trên. Mỗi cảnh có title, description (mô tả cảnh bằng tiếng Anh), imagePrompt (prompt vẽ ảnh tiếng Anh mô tả khung hình BẮT ĐẦU với bố cục điện ảnh tự nhiên), endImagePrompt (prompt vẽ ảnh tiếng Anh mô tả khung hình KẾT THÚC của cảnh sau 8s thoại, biểu cảm phản ứng và tư thế mới của các nhân vật, giữ nguyên góc máy và bối cảnh để làm frame đầu cho cảnh tiếp theo), videoPrompt (prompt tiếng Anh cho clip 8s mô tả chuyển động cơ thể mượt mà từ khung bắt đầu đến khung kết thúc và mấp máy miệng khi nói thoại), và dialogue (mảng thoại tiếng Việt, mỗi cảnh chỉ được chứa đúng 1 câu thoại duy nhất của nhân vật chính trong cảnh đó, dài từ 25-35 từ để khớp 8 giây).`,
      'YÊU CẦU QUAN TRỌNG VỀ BỐ CỤC ĐIỆN ẢNH & TƯ THẾ NHÂN VẬT (CINEMATIC STAGING & NATURAL POSING):',
      '- TUYỆT ĐỐI KHÔNG ĐỂ CÁC NHÂN VẬT ĐỨNG DÀN HÀNG NGANG (DO NOT POSE CHARACTERS IN A STIFF LINEUP LIKE A GROUP PHOTO):',
      '  * Phân bổ tư thế tự nhiên đa dạng tùy tình huống cảnh: Ví dụ bé Bin có thể ngồi khoanh chân trên thảm chơi đồ chơi, ngồi ở bàn ăn nhìn đĩa rau chán nản, hoặc ngồi trên ghế sofa ôm gối; Sumo đứng gần bên nhiệt tình làm cử chỉ vui nhộn; Mẹ đứng cạnh quầy bếp chuẩn bị đồ ăn hoặc ngồi cạnh Bin trên ghế.',
      '  * Tạo chiều sâu khung hình (Foreground / Midground / Background), nhân vật hướng mắt và tương tác sinh động với nhau hoặc tương tác với đồ vật trong phòng thay vì đứng đơ quay mặt ra trước camera.',
      '- Trong baseImagePrompt, imagePrompt, endImagePrompt và videoPrompt của TẤT CẢ các cảnh, mô tả rõ ràng tư thế tự nhiên cụ thể của từng nhân vật bằng tiếng Anh (ví dụ: "Bin is sitting cross-legged on the colorful playmat examining a toy, while Sumo stands naturally beside him gesturing playfully..."). Do not write or include any text, labels, subtitles, names as text, or words inside the visual outputs. The output must be completely clean and free of any text overlay.',
      '- TUYỆT ĐỐI KHÔNG ĐƯỢC chứa bất kỳ chữ viết, tên nhân vật hiển thị dưới dạng chữ, nhãn tên, phụ đề hay watermark nào trong toàn bộ baseImagePrompt, imagePrompt, endImagePrompt và videoPrompt. Toàn bộ prompt chỉ mô tả hình ảnh và hành động trực quan (No text, no subtitles, no names as labels, no written words on screen, no overlay text).',
      '- Khóa góc máy (Locked camera shot): mô tả camera tĩnh hoặc chuyển động cực kỳ nhẹ (static camera, locked medium shot), tuyệt đối không viết prompt dạng chuyển cảnh, cắt cảnh (no camera cuts, no camera angle changes) để đảm bảo video ghép lại không bị giật, nhảy hình.',
      '- KHUNG HÌNH ĐƠN (Single Shot Only): Toàn bộ imagePrompt và endImagePrompt chỉ mô tả một bức ảnh đơn lẻ duy nhất (single unified camera shot, full bleed 9:16). Tuyệt đối KHÔNG viết prompt dạng chuỗi khung hình, không phân chia frame (no split screen, no collage, no panels, no triptych, no sequence).'
    ];
  } else {
    const themePrompt = inputTopic 
      ? `Hãy sáng tạo một kịch bản phim ngắn drama về chủ đề cụ thể: "${inputTopic}".`
      : 'Hãy tự sáng tạo ra một chủ đề drama gia đình Việt Nam ngẫu nhiên bất kỳ (mâu thuẫn mẹ chồng nàng dâu, ngoại tình, phân chia tài sản, sự vô cảm,...) thật kịch tính và viết kịch bản dựa trên chủ đề tự nghĩ đó.';

    systemPrompt = 'Bạn là biên kịch phim ngắn drama gia đình Việt Nam dạng dọc (9:16). '
      + 'Tuân thủ chính xác schema JSON được yêu cầu, không xuất thêm gì khác.';

    userPrompts = [
      themePrompt,
      'Kịch bản phải đánh trúng cảm xúc, có kịch tính, nhiều mâu thuẫn và cao trào, kiểu nội dung "mẹ chồng nàng dâu" hoặc drama gia đình dễ gây tranh cãi.',
      'Trả về JSON đúng dạng, không markdown, không chú thích, đúng hình dạng sau:',
      '{"title":"...","characters":[{"name":"...","age":"...","role":"...","description":"..."}],"baseImagePrompt":"...","scenes":[{"title":"...","description":"...","imagePrompt":"...","endImagePrompt":"...","videoPrompt":"...","dialogue":[{"speaker":"...","text":"..."}]}]}',
      '- title: tiêu đề kịch bản, ngắn gọn, gây tò mò (tiếng Việt).',
      '- characters: 3 nhân vật, mỗi người có role (vd: "con dâu", "mẹ chồng", "chồng") và description ngắn.',
      '- baseImagePrompt: prompt tiếng Anh mô tả khung cảnh gốc + phong cách hình ảnh chung (vd: "A 3D Pixar-style modern Vietnamese house, cinematic lighting..."), vertical 9:16.',
      `- scenes: đúng ${MAX_SCENES} cảnh. Mỗi cảnh có title, description (tiếng Anh, mô tả hình ảnh khung hình), imagePrompt (prompt tiếng Anh cho khung hình BẮT ĐẦU của cảnh với bố cục điện ảnh sinh động), endImagePrompt (prompt tiếng Anh mô tả khung hình KẾT THÚC của cảnh sau 8s thoại, biểu cảm phản ứng và tư thế mới của các nhân vật, giữ nguyên góc máy và bối cảnh để làm frame đầu cho cảnh kế tiếp), videoPrompt (prompt tiếng Anh mô tả chuyển động/hành động của clip 8 giây nối từ start frame sang end frame), và dialogue (mảng các câu thoại tiếng Việt, mỗi câu có speaker trùng tên nhân vật trong characters và text lời thoại).`,
      '- YÊU CẦU QUAN TRỌNG VỀ THOẠI (DIALOGUE):',
      '  * Bắt buộc cảnh nào cũng phải có thoại. Mảng dialogue của mỗi cảnh chỉ được phép chứa đúng 1 câu thoại duy nhất của 1 nhân vật (1 người nói duy nhất mỗi cảnh, không có đối thoại qua lại trong cùng 1 cảnh).',
      '  * Mỗi câu thoại phải đủ dài để đọc/nói chậm rãi trong khoảng 7 đến 8 giây (độ dài kịch bản thoại khoảng 25-35 từ tiếng Việt), diễn đạt sâu sắc, kịch tính, tránh thoại ngắn cụt lủn.',
      'YÊU CẦU QUAN TRỌNG VỀ BỐ CỤC ĐIỆN ẢNH & TƯ THẾ NHÂN VẬT (CINEMATIC STAGING & NATURAL POSING):',
      '- TUYỆT ĐỐI KHÔNG ĐỂ CÁC NHÂN VẬT ĐỨNG DÀN HÀNG NGANG (DO NOT POSE CHARACTERS IN A STIFF LINEUP LIKE A MUGSHOT OR GROUP PHOTO).',
      '- ĐA DẠNG HÓA TƯ THẾ & TƯƠNG TÁC TỰ NHIÊN VỚI BỐI CẢNH (Contextual Posing & Natural Props):',
      '  * Phân chia tư thế thực tế theo cốt truyện từng cảnh: Có người NGỒI (sitting on the sofa watching TV, sitting at the dining table holding a teacup, looking down at a smartphone...), có người ĐỨNG hoặc TỰA LƯNG (standing or leaning by the kitchen counter, standing to plead or explain, holding a plate of fruit or glass of water...), có người làm việc nhà hoặc sinh hoạt đời thường.',
      '  * Tạo chiều sâu khung hình (Layering & Depth): Có người ở tiền cảnh (foreground, ví dụ ngồi trên ghế sofa gần camera hơn), người ở trung cảnh (midground) hoặc hậu cảnh (bên bàn ăn hoặc quầy bếp). Góc máy bao quát căn phòng với bố cục điện ảnh chân thực.',
      '  * Ngôn ngữ cơ thể & Ánh mắt: Các nhân vật hướng mắt, cử chỉ và tư thế về phía nhau để trò chuyện, thể hiện rõ cảm xúc kịch tính thay vì cùng quay mặt đơ về phía máy ảnh.',
      '- Giữ tính liên tục của bối cảnh & nhân vật (Spatial Continuity): Giữ nguyên căn phòng, đồ đạc nội thất, phong cách trang phục và diện mạo của các nhân vật qua các cảnh.',
      '- Trong baseImagePrompt, imagePrompt, endImagePrompt và videoPrompt của TẤT CẢ các cảnh, mô tả rõ tư thế tự nhiên cụ thể của từng người bằng tiếng Anh (ví dụ: "The mother is sitting sternly on the sofa holding a teacup, while Lan stands nervously near the dining table holding a plate, and Huy leans against the doorway looking conflicted"). Do not write or include any text, labels, subtitles, names as text, or words inside the visual outputs. The output must be completely clean and free of any text overlay.',
      '- TUYỆT ĐỐI KHÔNG ĐƯỢC chứa bất kỳ chữ viết, tên nhân vật hiển thị dưới dạng chữ, nhãn tên, phụ đề hay watermark nào trong toàn bộ baseImagePrompt, imagePrompt, endImagePrompt và videoPrompt. Toàn bộ prompt chỉ mô tả hình ảnh và hành động trực quan (No text, no subtitles, no names as labels, no written words on screen, no overlay text).',
      '- Khóa góc máy (Locked camera shot): mô tả camera tĩnh hoặc chuyển động cực kỳ nhẹ (static camera, locked medium shot), tuyệt đối không viết prompt dạng chuyển cảnh, cắt cảnh (no camera cuts, no camera angle changes) để đảm bảo video ghép lại không bị giật, nhảy hình.',
      '- KHUNG HÌNH ĐƠN (Single Shot Only): Toàn bộ imagePrompt và endImagePrompt chỉ mô tả một bức ảnh đơn lẻ duy nhất (single unified camera shot, full bleed 9:16). Tuyệt đối KHÔNG viết prompt dạng chuỗi khung hình, không phân chia frame (no split screen, no collage, no panels, no triptych, no sequence).'
    ];
  }

  const parsed = await callDramaAI({
    system: systemPrompt,
    user: userPrompts.join('\n'),
    temperature: 0.9
  });

  const title = String(parsed.title || '').trim().slice(0, 200);
  if (!title) throw new Error('Drama AI returned an empty title');

  const characters = Array.isArray(parsed.characters) ? parsed.characters.slice(0, MAX_CHARACTERS) : [];
  if (characters.length < 2) throw new Error('Drama AI must return at least 2 characters');

  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes.slice(0, MAX_SCENES) : [];
  if (scenes.length < 3) throw new Error('Drama AI must return at least 3 scenes');

  return {
    title,
    characters: characters.map((character, index) => ({
      name: String(character?.name || '').trim().slice(0, 120) || `Nhân vật ${index + 1}`,
      age: String(character?.age ?? '').trim().slice(0, 100),
      role: String(character?.role || '').trim().slice(0, 120),
      description: String(character?.description || '').trim().slice(0, 2000),
      voiceIndex: character?.voiceIndex !== undefined && character?.voiceIndex !== null ? Number(character.voiceIndex) : index
    })),
    baseImagePrompt: String(parsed.baseImagePrompt || '').trim().slice(0, 3000),
    scenes: scenes.map((scene, index) => ({
      index,
      title: String(scene?.title || `Cảnh ${index + 1}`).trim().slice(0, 160),
      description: String(scene?.description || '').trim().slice(0, 3000),
      imagePrompt: String(scene?.imagePrompt || '').trim().slice(0, 3000),
      endImagePrompt: String(scene?.endImagePrompt || '').trim().slice(0, 3000),
      videoPrompt: String(scene?.videoPrompt || '').trim().slice(0, 3000),
      dialogue: Array.isArray(scene?.dialogue) ? scene.dialogue.slice(0, 4).map(line => ({
        speaker: String(line?.speaker || '').trim().slice(0, 120),
        text: String(line?.text || '').trim().slice(0, 600)
      })).filter(line => line.text) : []
    }))
  };
}

function normalizeDramaScript(raw) {
  const script = (raw && typeof raw === 'object') ? raw : {};
  const characters = Array.isArray(script.characters) ? script.characters.slice(0, MAX_CHARACTERS) : [];
  return {
    topic: String(script.topic || '').trim().slice(0, 300),
    title: String(script.title || '').trim().slice(0, 200),
    characters: characters.map((character, index) => ({
      name: String(character?.name || '').trim().slice(0, 120) || `Nhân vật ${index + 1}`,
      age: String(character?.age ?? '').trim().slice(0, 100),
      role: String(character?.role || '').trim().slice(0, 120),
      description: String(character?.description || '').trim().slice(0, 2000),
      voiceIndex: character?.voiceIndex !== undefined && character?.voiceIndex !== null ? Number(character.voiceIndex) : index
    })),
    baseImagePrompt: String(script.baseImagePrompt || '').trim().slice(0, 3000),
    scenes: Array.isArray(script.scenes) ? script.scenes.slice(0, MAX_SCENES).map((scene, index) => ({
      index,
      title: String(scene?.title || `Cảnh ${index + 1}`).trim().slice(0, 160),
      description: String(scene?.description || '').trim().slice(0, 3000),
      imagePrompt: String(scene?.imagePrompt || '').trim().slice(0, 3000),
      endImagePrompt: String(scene?.endImagePrompt || '').trim().slice(0, 3000),
      videoPrompt: String(scene?.videoPrompt || '').trim().slice(0, 3000),
      imageUrl: scene?.imageUrl || scene?.startImageUrl || null,
      startImageUrl: scene?.startImageUrl || scene?.imageUrl || null,
      endImageUrl: scene?.endImageUrl || null,
      videoUrl: scene?.videoUrl || null,
      imageTaskId: scene?.imageTaskId || null,
      startImageTaskId: scene?.startImageTaskId || scene?.imageTaskId || null,
      endImageTaskId: scene?.endImageTaskId || null,
      videoTaskId: scene?.videoTaskId || null,
      imageStatus: scene?.imageStatus || null,
      startImageStatus: scene?.startImageStatus || scene?.imageStatus || null,
      endImageStatus: scene?.endImageStatus || null,
      videoStatus: scene?.videoStatus || null,
      dialogue: Array.isArray(scene?.dialogue) ? scene.dialogue.slice(0, 4).map(line => ({
        speaker: String(line?.speaker || '').trim().slice(0, 120),
        text: String(line?.text || '').trim().slice(0, 600)
      })).filter(line => line.text) : []
    })) : []
  };
}

// ─── STEP 2: video job ──────────────────────────────────────────────────────
// For each scene: image → 8s video, then generate Vietnamese TTS for the
// dialogue and overlay it on the clip, then concatenate all clips.

async function waitForAudioOutput(jobUid) {
  const deadline = Date.now() + AUDIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const jobs = await audioClient.listJobs().catch(() => []);
    const match = jobs.find(job => job.jobUid === jobUid);
    if (match) {
      const status = String(match.status || '');
      if (/FAIL|ERROR/i.test(status)) {
        throw new Error(`Audio generation failed (${status})`);
      }
      if (match.outputUrl) {
        return match.outputUrl.startsWith('http')
          ? match.outputUrl
          : `${audioClient.BASE_URL}${match.outputUrl}`;
      }
    }
    await sleep(TASK_POLL_INTERVAL_MS);
  }
  throw new Error(`Audio generation timed out for ${jobUid}`);
}

async function checkUrlExists(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.status !== 404;
  } catch (error) {
    logger.warn(`[Drama] Error checking URL existence for ${url}: ${error.message}`);
    return false;
  }
}

async function generateDialogueAudio(text, voiceIndex = 0) {
  const jobUid = await audioClient.createJob(text, 'vi', Number(voiceIndex));
  await audioClient.startJob(jobUid);
  logger.info(`[Drama] TTS job ${jobUid} started for ${String(text).slice(0, 40)}...`);
  return waitForAudioOutput(jobUid);
}

async function downloadFile(url, destination) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(destination, buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      childProcess.kill('SIGKILL');
      reject(new Error('ffmpeg concatenation timed out'));
    }, FFMPEG_TIMEOUT_MS);
    childProcess.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    childProcess.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    childProcess.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
}

// Overlay an audio file on top of a silent video clip (audio length matches clip).
async function muxAudioIntoTemp(clipPath, audioPath, outputPath) {
  try {
    await runFfmpeg([
      '-y', '-i', clipPath, '-i', audioPath,
      '-filter_complex', '[1:a]apad=pad_dur=1[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-movflags', '+faststart', outputPath
    ]);
  } catch (error) {
    logger.warn(`[Drama] Fast mux failed (${error.message}), retrying with transcode...`);
    await runFfmpeg([
      '-y', '-i', clipPath, '-i', audioPath,
      '-filter_complex', '[1:a]apad=pad_dur=1[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-movflags', '+faststart', outputPath
    ]);
  }
}

// If a scene has multiple dialogue lines, merge them into one audio track.
async function mergeDialogues(clipPath, dialogue, tempDir, sceneIndex) {
  if (!Array.isArray(dialogue) || dialogue.length === 0) return null;
  const audioPaths = [];
  for (let lineIndex = 0; lineIndex < dialogue.length; lineIndex++) {
    const line = dialogue[lineIndex];
    if (!line.text) continue;
    const audioPath = path.join(tempDir, `scene${sceneIndex}-line${lineIndex}.wav`);
    const url = await generateDialogueAudio(line.text, line.voiceIndex ?? 0);
    await downloadFile(url, audioPath);
    audioPaths.push(audioPath);
  }
  if (audioPaths.length === 0) return null;
  if (audioPaths.length === 1) return audioPaths[0];

  const mergedPath = path.join(tempDir, `scene${sceneIndex}-merged.m4a`);
  const listPath = path.join(tempDir, `scene${sceneIndex}-list.txt`);
  await fsp.writeFile(listPath, audioPaths.map(audioPath => `file '${audioPath}'`).join('\n'));
  try {
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'aac', '-b:a', '128k', mergedPath]);
  } catch (error) {
    logger.warn(`[Drama] Audio merge failed (${error.message}), retrying with resample...`);
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-ar', '24000', '-ac', '1',
      '-c:a', 'aac', '-b:a', '128k', mergedPath
    ]);
  }
  return mergedPath;
}

async function concatenateClips(jobId, clipPaths) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `drama-${jobId}-`));
  try {
    const concatPath = path.join(tempDir, 'concat.txt');
    const outputPath = path.join(tempDir, 'final.mp4');
    await fsp.writeFile(concatPath, clipPaths.map(clipPath => `file '${clipPath}'`).join('\n'));
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', '+faststart', outputPath]);
    } catch (error) {
      logger.warn(`[Drama] Stream-copy concat failed (${error.message}), retrying with transcoding...`);
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath
      ]);
    }
    const output = await fsp.readFile(outputPath);
    return uploadToR2(output, `meo3/drama/${jobId}.mp4`, 'video/mp4');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runDramaJob(jobId) {
  const jobRef = db.collection('drama_jobs').doc(jobId);
  let failedSceneIndex = null;
  try {
    let snapshot = await jobRef.get();
    if (!snapshot.exists || TERMINAL_JOB_STATUSES.has(snapshot.data().status)) return;
    let job = snapshot.data();

    const totalSteps = job.scenes.length * 3;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `drama-${jobId}-`));
    const clipPaths = [];

    try {
      // Process scenes sequentially with Start-to-End frame chaining:
      // - Scene 1 (index 0): startImage is generated via AI.
      // - Scene N (index > 0): startImage is the endImage of Scene N-1 (chained).
      // - Each scene's endImage is generated via Image-to-Image using its startImage as reference.
      // - Each scene's video is generated with startImage and endImage.
      for (let index = 0; index < job.scenes.length; index++) {
        failedSceneIndex = index;
        snapshot = await jobRef.get();
        job = snapshot.data();
        if (job.status === 'failed') {
          logger.info(`[Drama] Job ${jobId} aborted in scene ${index + 1} due to cancellation.`);
          return;
        }
        let scene = job.scenes[index];

        // 1. Get or generate the start image for this scene
        let startImageUrl = scene.startImageUrl || scene.imageUrl;
        const startImgExists = await checkUrlExists(startImageUrl);
        if (!startImageUrl || !startImgExists) {
          startImageUrl = null;
          if (index === 0) {
            // Scene 1: Generate initial still image
            const referenceImages = [];
            if (job.channelType === 'sumo') {
              referenceImages.push(
                'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/bin_character.jpg',
                'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/sumo_character.jpg'
              );
              const promptLower = String(scene.imagePrompt || '').toLowerCase();
              if (promptLower.includes('mother') || promptLower.includes('mom') || promptLower.includes('mẹ')) {
                referenceImages.push('https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/mother_character.jpg');
              }
              if (promptLower.includes('gac huou non sumo') || promptLower.includes('sumo non') || promptLower.includes('pouch') || promptLower.includes('product') || promptLower.includes('package')) {
                referenceImages.push('https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/sumo_product.png');
              }
            }

            const imageResult = await runChildTaskWithRetry({
              jobRef,
              job: { ...job, characters: job.characters || [] },
              sceneIndex: index,
              taskType: 'startImage',
              prompt: buildScenePrompt(job, scene, 'startImage', index),
              extraTaskData: {
                userId: job.userId,
                email: job.userEmail || null,
                type: 'image',
                status: 'pending',
                aspectRatio: '9:16',
                model: 'nano_banana_2',
                count: 1,
                referenceImages,
                dramaJobId: jobId,
                sceneIndex: index,
                createdAt: Date.now()
              },
              timeoutMs: IMAGE_TIMEOUT_MS,
              stageStatus: 'start_image_processing',
              progressUpdate: {
                status: 'generating',
                currentScene: index + 1,
                progress: Math.round(((index * 3) / totalSteps) * 100)
              }
            });
            startImageUrl = imageResult.url;
            scene.startImageUrl = startImageUrl;
            scene.imageUrl = startImageUrl;
            await updateScene(jobRef, index, {
              startImageUrl,
              imageUrl: startImageUrl,
              startImageStatus: 'completed',
              imageStatus: 'completed',
              status: 'start_image_completed'
            }, {
              progress: Math.round(((index * 3 + 0.8) / totalSteps) * 100)
            });
          } else {
            // Scene N (N > 0): Start image chained from endImage of previous scene!
            const prevScene = job.scenes[index - 1];
            startImageUrl = prevScene?.endImageUrl || prevScene?.imageUrl || null;
            if (!startImageUrl && prevScene?.videoUrl) {
              // Fallback: extract last frame from previous video if endImageUrl is missing
              logger.info(`[Drama] Extracting last frame from scene ${index} video: ${prevScene.videoUrl}`);
              const prevVideoPath = path.join(tempDir, `prev-clip-${index}.mp4`);
              const lastFramePath = path.join(tempDir, `last-frame-${index}.png`);
              await downloadFile(prevScene.videoUrl, prevVideoPath);
              await runFfmpeg([
                '-y',
                '-sseof', '-0.1',
                '-i', prevVideoPath,
                '-vframes', '1',
                '-q:v', '2',
                lastFramePath
              ]);
              const lastFrameBuffer = await fsp.readFile(lastFramePath);
              startImageUrl = await uploadToR2(lastFrameBuffer, `meo3/images/${jobId}_scene_${index + 1}_start_image.png`, 'image/png');
            }
            if (!startImageUrl) {
              throw new Error(`Cảnh ${index} chưa có ảnh kết thúc hoặc video để làm ảnh bắt đầu cho cảnh ${index + 1}`);
            }
            scene.startImageUrl = startImageUrl;
            scene.imageUrl = startImageUrl;
            await updateScene(jobRef, index, {
              startImageUrl,
              imageUrl: startImageUrl,
              startImageStatus: 'completed',
              imageStatus: 'completed',
              status: 'start_image_completed'
            }, {
              progress: Math.round(((index * 3 + 0.8) / totalSteps) * 100)
            });
            logger.success(`[Drama] Scene ${index + 1} startImage chained from Scene ${index}: ${startImageUrl}`);
          }
        }

        // 2. Generate End Image for this scene via I2I referencing startImageUrl
        snapshot = await jobRef.get();
        job = snapshot.data();
        if (job.status === 'failed') {
          logger.info(`[Drama] Job ${jobId} aborted before end image of scene ${index + 1} due to cancellation.`);
          return;
        }
        scene = job.scenes[index];
        let endImageUrl = scene.endImageUrl;
        const endImgExists = await checkUrlExists(endImageUrl);
        if (!endImageUrl || !endImgExists) {
          const endImageResult = await runChildTaskWithRetry({
            jobRef,
            job: { ...job, characters: job.characters || [] },
            sceneIndex: index,
            taskType: 'endImage',
            prompt: buildScenePrompt(job, scene, 'endImage', index),
            extraTaskData: {
              userId: job.userId,
              email: job.userEmail || null,
              type: 'image',
              status: 'pending',
              aspectRatio: '9:16',
              model: 'nano_banana_2',
              count: 1,
              referenceImages: [startImageUrl],
              dramaJobId: jobId,
              sceneIndex: index,
              createdAt: Date.now()
            },
            timeoutMs: IMAGE_TIMEOUT_MS,
            stageStatus: 'end_image_processing',
            progressUpdate: {
              status: 'generating',
              currentScene: index + 1,
              progress: Math.round(((index * 3 + 1) / totalSteps) * 100)
            }
          });
          endImageUrl = endImageResult.url;
          scene.endImageUrl = endImageUrl;
          await updateScene(jobRef, index, {
            endImageUrl,
            endImageStatus: 'completed',
            status: 'end_image_completed'
          }, {
            progress: Math.round(((index * 3 + 1.8) / totalSteps) * 100)
          });
          logger.success(`[Drama] Scene ${index + 1} endImage generated via I2I: ${endImageUrl}`);
        }

        // 3. Generate Video for this scene with startImage & endImage attached
        snapshot = await jobRef.get();
        job = snapshot.data();
        if (job.status === 'failed') {
          logger.info(`[Drama] Job ${jobId} aborted before video of scene ${index + 1} due to cancellation.`);
          return;
        }
        scene = job.scenes[index];
        let videoUrl = scene.videoUrl;
        const vidExists = await checkUrlExists(videoUrl);
        if (!videoUrl || !vidExists) {
          const videoResult = await runChildTaskWithRetry({
            jobRef,
            job: { ...job, characters: job.characters || [] },
            sceneIndex: index,
            taskType: 'video',
            prompt: buildScenePrompt(job, scene, 'video', index),
            extraTaskData: {
              userId: job.userId,
              email: job.userEmail || null,
              type: 'video',
              status: 'pending',
              aspectRatio: '9:16',
              model: 'veo_3_1_lite',
              count: 1,
              durationSeconds: 8,
              startImage: startImageUrl,
              endImage: endImageUrl,
              dramaJobId: jobId,
              sceneIndex: index,
              createdAt: Date.now()
            },
            timeoutMs: VIDEO_TIMEOUT_MS,
            stageStatus: 'video_processing',
            progressUpdate: {
              status: 'generating',
              currentScene: index + 1,
              progress: Math.round(((index * 3 + 2) / totalSteps) * 100)
            }
          });
          scene.videoUrl = videoResult.url;
          await updateScene(jobRef, index, {
            videoUrl: videoResult.url,
            videoStatus: 'completed',
            status: 'video_completed'
          }, {
            progress: Math.round(((index * 3 + 2.8) / totalSteps) * 100)
          });
          logger.success(`[Drama] Scene ${index + 1} video generated: ${videoResult.url}`);
        }
      }

      // Phase 3: dialogue TTS bypassed. Direct clip compilation using Veo3 native audio.
      for (let index = 0; index < job.scenes.length; index++) {
        failedSceneIndex = index;
        snapshot = await jobRef.get();
        job = snapshot.data();
        if (job.status === 'failed') {
          logger.info(`[Drama] Job ${jobId} aborted in Phase 3 scene ${index + 1} due to cancellation.`);
          return;
        }
        const scene = job.scenes[index];
        const clipPath = path.join(tempDir, `clip-${String(index).padStart(2, '0')}.mp4`);
        await downloadFile(scene.videoUrl, clipPath);
        clipPaths.push(clipPath);
        await updateScene(jobRef, index, { audioStatus: 'none', status: 'completed' });
      }

      snapshot = await jobRef.get();
      job = snapshot.data();
      if (job.finalUrl) {
        await jobRef.update({ status: 'completed', progress: 100, completedAt: Date.now(), updatedAt: Date.now() });
        await recordDramaEpisode(jobRef, job).catch(() => {});
        return;
      }
      if (clipPaths.some(clipPath => !clipPath)) throw new Error('Not all scenes have completed video clips');
      await jobRef.update({ status: 'concatenating', currentScene: null, updatedAt: Date.now() });
      const finalUrl = await concatenateClips(jobId, clipPaths);
      await jobRef.update({
        status: 'completed',
        progress: 100,
        finalUrl,
        error: null,
        completedAt: Date.now(),
        updatedAt: Date.now()
      });
      const completedJob = { ...job, status: 'completed', progress: 100, finalUrl, completedAt: Date.now() };
      await recordDramaEpisode(jobRef, completedJob).catch(() => {});
      logger.success(`[Drama] Job ${jobId} completed: ${finalUrl}`);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    logger.error(`[Drama] Job ${jobId} failed`, error);
    const update = { status: 'failed', error: error.message, failedAt: Date.now(), updatedAt: Date.now() };
    await jobRef.set(update, { merge: true }).catch(() => {});
    if (failedSceneIndex !== null) {
      await updateScene(jobRef, failedSceneIndex, { status: 'failed', error: error.message }).catch(() => {});
    }
  }
}

function resolveVoiceIndex(characters, speakerName) {
  const name = String(speakerName || '').trim().toLowerCase();
  const character = characters.find(character => String(character.name || '').trim().toLowerCase() === name);
  if (character && character.voiceIndex !== undefined && character.voiceIndex !== null) {
    return Number(character.voiceIndex);
  }
  const index = characters.findIndex(character => String(character.name || '').trim().toLowerCase() === name);
  return index >= 0 ? index : 0;
}

function getCharacterPositionLabel(job, scene, speakerName) {
  const name = String(speakerName || '').trim().toLowerCase();
  const characters = Array.isArray(job.characters) ? job.characters : [];
  const charObj = characters.find(c => String(c.name || '').trim().toLowerCase() === name);
  
  // 1. Determine descriptor (gender/age)
  let descriptor = 'person';
  if (charObj) {
    const role = String(charObj.role || '').toLowerCase();
    const desc = String(charObj.description || '').toLowerCase();
    const charName = String(charObj.name || '').toLowerCase();
    
    if (role.includes('mẹ') || role.includes('bà') || charName.includes('bà') || desc.includes('bà') || desc.includes('elderly woman') || desc.includes('old woman')) {
      descriptor = 'elderly woman';
    } else if (role.includes('con dâu') || role.includes('vợ') || charName.includes('lan') || role.includes('nữ') || desc.includes('young woman') || desc.includes('girl')) {
      descriptor = 'young woman';
    } else if (role.includes('chồng') || role.includes('con trai') || charName.includes('huy') || role.includes('nam') || desc.includes('young man') || desc.includes('boy')) {
      descriptor = 'young man';
    } else if (role.includes('bố') || role.includes('cha') || role.includes('ông') || desc.includes('elderly man') || desc.includes('old man')) {
      descriptor = 'elderly man';
    } else if (role.includes('nữ') || desc.includes('woman') || desc.includes('female')) {
      descriptor = 'woman';
    } else if (role.includes('nam') || desc.includes('man') || desc.includes('male')) {
      descriptor = 'man';
    }
  }

  // 2. Find position & posture from scene text
  const fullText = [
    scene.videoPrompt,
    scene.imagePrompt,
    scene.description,
    job.baseImagePrompt
  ].filter(Boolean).join(' ').toLowerCase();

  let position = '';
  const nameIdx = fullText.indexOf(name);
  if (nameIdx >= 0) {
    const windowText = fullText.slice(Math.max(0, nameIdx - 40), Math.min(fullText.length, nameIdx + 60));
    if (windowText.includes('left')) {
      position = 'on the left side';
    } else if (windowText.includes('right')) {
      position = 'on the right side';
    } else if (windowText.includes('sofa') || windowText.includes('couch')) {
      position = 'on the sofa';
    } else if (windowText.includes('table')) {
      position = 'by the table';
    } else if (windowText.includes('counter')) {
      position = 'by the counter';
    }
  }

  if (!position) {
    if (fullText.includes(`${name} on the left`) || fullText.includes('on the left')) {
      position = 'on the left side';
    } else if (fullText.includes(`${name} on the right`) || fullText.includes('on the right')) {
      position = 'on the right side';
    }
  }

  if (!position && charObj) {
    const charIdx = characters.indexOf(charObj);
    position = charIdx === 0 ? 'on the left' : 'on the right';
  }

  // Detect posture: sitting, leaning, kneeling, or standing
  let posture = 'standing';
  const charContext = nameIdx >= 0 
    ? fullText.slice(Math.max(0, nameIdx - 50), Math.min(fullText.length, nameIdx + 80))
    : fullText;
  if (charContext.includes('sit') || charContext.includes('seated') || charContext.includes('sofa') || charContext.includes('couch') || charContext.includes('chair') || charContext.includes('armchair')) {
    posture = 'sitting';
  } else if (charContext.includes('lean')) {
    posture = 'leaning';
  } else if (charContext.includes('kneel')) {
    posture = 'kneeling';
  }

  return `the ${descriptor} ${posture} ${position || 'in the scene'}`.replace(/\s+/g, ' ').trim();
}

function buildScenePrompt(job, scene, mediaType, sceneIndex = null) {
  const baseImagePrompt = String(job.baseImagePrompt || '').trim();
  const characters = Array.isArray(job.characters) ? job.characters.filter(c => String(c.name || '').trim()) : [];
  const characterNames = characters.map(c => c.name).join(', ');

  const dialogues = Array.isArray(scene.dialogue) ? scene.dialogue : [];
  const dialogueLines = dialogues.map(line => {
    const positionLabel = getCharacterPositionLabel(job, scene, line.speaker);
    return `- [${positionLabel}]: "${line.text}"`;
  }).join('\n');

  const parts = [];
  const normalizedType = String(mediaType || '').toLowerCase();
  const isImageTask = normalizedType === 'image' || normalizedType === 'startimage' || normalizedType === 'start_image';
  const isEndImageTask = normalizedType === 'endimage' || normalizedType === 'end_image';

  if (isImageTask) {
    parts.push(String(scene.imagePrompt || scene.description || '').trim());
    if (baseImagePrompt) {
      parts.push(`Environment: ${baseImagePrompt}`);
    }
    if (characterNames) {
      parts.push(`Characters in scene: ${characterNames}. All characters must appear together in this room.`);
    }
    parts.push('Cinematic staging: Characters have natural, varied postures with depth across the room (e.g. one seated comfortably, others standing or leaning naturally near furniture, interacting naturally). No stiff lineup.');
    if (job.channelType === 'sumo') {
      parts.push('3D Pixar animated film style, vibrant, expressive, cute.');
    } else {
      parts.push('Photorealistic cinematic Vietnamese family drama.');
    }
    // Anti-split, anti-collage, anti-triptych guard
    parts.push('Single unified vertical 9:16 shot. Full-bleed photograph. ABSOLUTELY NO split screen, NO multi-panel, NO collage, NO triptych, NO comic strip, NO storyboard sequence, NO duplicate characters, NO borders.');
  } else if (isEndImageTask) {
    const endPrompt = String(scene.endImagePrompt || '').trim() || String(scene.videoPrompt || scene.description || '').trim();
    parts.push(endPrompt);
    if (baseImagePrompt) {
      parts.push(`Environment: ${baseImagePrompt}`);
    }
    parts.push('Depict the updated emotional reaction, facial expressions, and natural body postures of the characters at this moment. Maintain identical faces, clothing, and room setting as the reference image.');
    if (job.channelType === 'sumo') {
      parts.push('3D Pixar animated film style, vibrant, expressive, cute.');
    } else {
      parts.push('Photorealistic cinematic Vietnamese family drama.');
    }
    // Anti-split, anti-collage, anti-triptych guard
    parts.push('Single unified vertical 9:16 shot. Full-bleed photograph. ABSOLUTELY NO split screen, NO multi-panel, NO collage, NO triptych, NO comic strip, NO storyboard sequence, NO duplicate characters, NO borders.');
  } else {
    // Video prompt
    parts.push(String(scene.videoPrompt || scene.description || '').trim());
    if (baseImagePrompt) {
      parts.push(`Environment: ${baseImagePrompt}`);
    }
    if (characterNames) {
      parts.push(`Characters: ${characterNames}`);
    }
    if (dialogueLines) {
      parts.push(`Character Dialogues (speaking with natural lip movement matching this line):\n${dialogueLines}`);
    }
    parts.push('Characters talk with expressive, natural facial emotions and subtle gestures.');
    parts.push('One coherent 8-second continuous vertical 9:16 video clip smoothly transitioning from start frame to end frame. Locked static camera, smooth cinematic depth, no camera cuts, no split screen.');
  }

  let finalPrompt = parts.join('\n');
  const actualIndex = (sceneIndex !== null && sceneIndex !== undefined)
    ? sceneIndex
    : (scene?.sceneIndex !== undefined ? scene.sceneIndex : (scene?.index !== undefined ? scene.index : null));
  if (actualIndex !== null && actualIndex !== undefined && !isNaN(Number(actualIndex))) {
    const seqStr = String(Number(actualIndex) + 1).padStart(3, '0') + '.';
    if (!finalPrompt.match(/^\d{1,4}[\.\-_:\s]/)) {
      finalPrompt = `${seqStr} ${finalPrompt}`;
    }
  }
  return finalPrompt;
}

// ─── SINGLE-SCENE MEDIA GENERATION ─────────────────────────────────────────
// Generate just one scene's still image or video independently, persisting the
// result (imageUrl/videoUrl) back onto the drama_scripts scene document.
function sceneTaskId(scriptId, sceneIndex, mediaType) {
  return `${scriptId}_scene_${sceneIndex + 1}_${mediaType}`;
}

// Validates the request, marks the scene as processing, then spawns the
// generation in the background. Returns immediately with the deterministic
// taskId so the frontend can poll the script doc / task for progress.
async function startSceneMedia({
  scriptRef, script, sceneIndex, mediaType, userId, userEmail
}) {
  const scene = script.scenes[sceneIndex];
  if (!scene) throw new Error(`Cảnh ${sceneIndex + 1} không tồn tại`);

  const rawType = String(mediaType || '').toLowerCase();
  const normalizedType = (rawType === 'startimage' || rawType === 'start_image')
    ? 'startImage'
    : (rawType === 'endimage' || rawType === 'end_image')
      ? 'endImage'
      : (rawType === 'video')
        ? 'video'
        : 'image';

  const taskId = sceneTaskId(scriptRef.id, sceneIndex, normalizedType);

  if (normalizedType === 'video' && !scene.imageUrl && !scene.startImageUrl) {
    throw new Error('Cảnh chưa có ảnh bắt đầu. Vui lòng tạo ảnh cho cảnh này trước.');
  }
  if (normalizedType === 'endImage' && !scene.imageUrl && !scene.startImageUrl) {
    throw new Error('Cảnh chưa có ảnh bắt đầu. Vui lòng tạo ảnh bắt đầu trước khi tạo ảnh kết thúc.');
  }

  const updateFields = {
    [`${normalizedType}TaskId`]: taskId,
    [`${normalizedType}Status`]: 'processing',
    status: `${normalizedType}_processing`,
    error: null
  };
  if (normalizedType === 'image' || normalizedType === 'startImage') {
    updateFields.imageTaskId = taskId;
    updateFields.imageStatus = 'processing';
  }

  await updateScene(scriptRef, sceneIndex, updateFields);

  generateSceneMedia({ scriptRef, script, sceneIndex, mediaType: normalizedType, userId, userEmail })
    .catch((error) => {
      logger.error(`[Drama] Scene ${sceneIndex + 1} ${normalizedType} failed: ${error.message}`);
    });

  return { taskId, mediaType: normalizedType, status: 'processing' };
}

async function generateSceneMedia({
  scriptRef, script, sceneIndex, mediaType, userId, userEmail
}) {
  const scene = script.scenes[sceneIndex];
  if (!scene) throw new Error(`Cảnh ${sceneIndex + 1} không tồn tại`);

  const job = {
    ...script,
    characters: script.characters || [],
    baseImagePrompt: script.baseImagePrompt || ''
  };

  const rawType = String(mediaType || '').toLowerCase();

  try {
    if (rawType === 'image' || rawType === 'startimage' || rawType === 'start_image') {
      const referenceImages = [];
      if (script.channelType === 'sumo') {
        referenceImages.push(
          'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/bin_character.jpg',
          'https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/sumo_character.jpg'
        );
        const promptLower = String(scene.imagePrompt || '').toLowerCase();
        if (promptLower.includes('mother') || promptLower.includes('mom') || promptLower.includes('mẹ')) {
          referenceImages.push('https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/mother_character.jpg');
        }
        if (promptLower.includes('gac huou non sumo') || promptLower.includes('sumo non') || promptLower.includes('pouch') || promptLower.includes('product') || promptLower.includes('package')) {
          referenceImages.push('https://pub-2b53cd37b4a44642afdbb8bb470bde66.r2.dev/meo3/assets/sumo_product.png');
        }
      }

      const imageResult = await runChildTaskWithRetry({
        jobRef: scriptRef,
        job,
        sceneIndex,
        taskType: 'startImage',
        prompt: buildScenePrompt(job, scene, 'startImage', sceneIndex),
        extraTaskData: {
          userId,
          email: userEmail || null,
          type: 'image',
          status: 'pending',
          aspectRatio: '9:16',
          model: 'nano_banana_2',
          count: 1,
          referenceImages,
          dramaScriptId: scriptRef.id,
          sceneIndex,
          createdAt: Date.now()
        },
        timeoutMs: IMAGE_TIMEOUT_MS,
        stageStatus: 'start_image_processing'
      });
      await updateScene(scriptRef, sceneIndex, {
        imageUrl: imageResult.url,
        startImageUrl: imageResult.url,
        imageStatus: 'completed',
        startImageStatus: 'completed',
        status: 'start_image_completed'
      });
      return { url: imageResult.url, taskId: imageResult.taskId, mediaType: 'startImage' };
    }

    if (rawType === 'endimage' || rawType === 'end_image') {
      const startImg = scene.startImageUrl || scene.imageUrl;
      if (!startImg) {
        throw new Error('Cần có ảnh bắt đầu trước khi tạo ảnh kết thúc.');
      }

      const endImageResult = await runChildTaskWithRetry({
        jobRef: scriptRef,
        job,
        sceneIndex,
        taskType: 'endImage',
        prompt: buildScenePrompt(job, scene, 'endImage', sceneIndex),
        extraTaskData: {
          userId,
          email: userEmail || null,
          type: 'image',
          status: 'pending',
          aspectRatio: '9:16',
          model: 'nano_banana_2',
          count: 1,
          referenceImages: [startImg],
          dramaScriptId: scriptRef.id,
          sceneIndex,
          createdAt: Date.now()
        },
        timeoutMs: IMAGE_TIMEOUT_MS,
        stageStatus: 'end_image_processing'
      });
      await updateScene(scriptRef, sceneIndex, {
        endImageUrl: endImageResult.url,
        endImageStatus: 'completed',
        status: 'end_image_completed'
      });
      return { url: endImageResult.url, taskId: endImageResult.taskId, mediaType: 'endImage' };
    }

    const videoResult = await runChildTaskWithRetry({
      jobRef: scriptRef,
      job,
      sceneIndex,
      taskType: 'video',
      prompt: buildScenePrompt(job, scene, 'video', sceneIndex),
      extraTaskData: {
        userId,
        email: userEmail || null,
        type: 'video',
        status: 'pending',
        aspectRatio: '9:16',
        model: 'veo_3_1_lite',
        count: 1,
        durationSeconds: 8,
        startImage: scene.startImageUrl || scene.imageUrl,
        endImage: scene.endImageUrl || null,
        dramaScriptId: scriptRef.id,
        sceneIndex,
        createdAt: Date.now()
      },
      timeoutMs: VIDEO_TIMEOUT_MS,
      stageStatus: 'video_processing'
    });
    await updateScene(scriptRef, sceneIndex, {
      videoUrl: videoResult.url,
      videoStatus: 'completed',
      status: 'completed'
    });
    return { url: videoResult.url, taskId: videoResult.taskId, mediaType: 'video' };
  } catch (error) {
    await updateScene(scriptRef, sceneIndex, {
      [`${mediaType}Status`]: 'failed',
      status: 'failed',
      error: error.message
    }).catch(() => {});
    throw error;
  }
}

async function recordDramaEpisode(jobRef, job) {
  const scriptId = job?.scriptId;
  if (!scriptId) return;
  const scriptRef = db.collection('drama_scripts').doc(scriptId);
  const snapshot = await scriptRef.get();
  if (!snapshot.exists) return;
  const episodes = Array.isArray(snapshot.data().episodes) ? snapshot.data().episodes : [];
  const record = {
    number: job.episodeNumber || episodes.length + 1,
    title: job.title || `Tập ${job.episodeNumber || episodes.length + 1}`,
    jobId: jobRef.id,
    finalUrl: job.finalUrl || null,
    completedAt: job.completedAt || Date.now()
  };
  const existingIndex = episodes.findIndex(episode => episode.jobId === jobRef.id);
  if (existingIndex !== -1) episodes[existingIndex] = record;
  else episodes.push(record);
  await scriptRef.update({ episodes, updatedAt: Date.now() });
  logger.success(`[Drama] Episode history recorded for script ${scriptId}`);
}

function processDramaJob(jobId) {
  if (activeJobs.has(jobId)) return false;
  activeJobs.add(jobId);
  runDramaJob(jobId).finally(() => activeJobs.delete(jobId));
  return true;
}

async function resumeDramaJobs() {
  const snapshot = await db.collection('drama_jobs').get();
  let resumed = 0;
  for (const document of snapshot.docs) {
    if (!TERMINAL_JOB_STATUSES.has(document.data().status) && processDramaJob(document.id)) resumed++;
  }
  logger.info(`[Drama] Resumed ${resumed} nonterminal job(s)`);
  return resumed;
}

module.exports = {
  generateDramaScript,
  normalizeDramaScript,
  processDramaJob,
  resumeDramaJobs,
  startSceneMedia,
  buildScenePrompt,
  sceneTaskId,
  MAX_SCENES,
  MAX_CHARACTERS
};
