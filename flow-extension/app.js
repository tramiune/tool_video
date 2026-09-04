
// CẤU TRÚC KỊCH BẢN DẪN DẮT CẢM XÚC LIÊN TỤC 5 CHƯƠNG (STORYTELLING ARCS)
// Hỗ trợ cả Tiếng Việt & Tiếng Anh, mặc định chuẩn phong cách Master Financial Literacy (2D Flat Motion Graphic)
function buildDynamicFlowStoryline(topic, totalScenes, lang = "vi", totalMinutes = 10) {
  const isEn = lang === "en";
  
  // Phong cách cố định 100% chuẩn video mẫu Alicia Invests
  const fixedStyle = "2D Flat Vector Infographic, Clean Financial Education Animation, Minimalist Modern Motion Graphic, Bold Colors, 8k crisp";
  const textDirective = isEn 
    ? "Clean English financial labels, english typography on infographic charts, NO Vietnamese text" 
    : "Infographic đồ họa tài chính có phụ đề nhãn chữ tiếng Việt sắc nét, Vietnamese text typography on charts, NO foreign text";

  const narrativeChapters = isEn ? [
    {
      act: "Act 1: The Reality Check & The Rat Race Trap",
      connectors: [
        "To begin with this dilemma,",
        "Looking closely at our daily grind,",
        "As the daily hamster wheel keeps turning,",
        "We often comfort ourselves thinking everything is fine,",
        "Yet deep down, a persistent financial anxiety remains,"
      ],
      scenes: [
        {
          core: "The bitter truth most people only realize after age 30 is that we spend our entire youth merely MAINTAINING our current existence.",
          expand: "Waking up exhausted every morning, fighting rush hour traffic just to trade 8 to 10 hours of life for a paycheck that barely covers monthly bills.",
          prompt: "A lone professional walking in a minimalist 2D flat modern city at dawn, stylized charts in background, clean financial infographic vector"
        },
        {
          core: "We believe we are moving forward, but in reality we are running on a treadmill with no finish line.",
          expand: "As income slightly increases, lifestyle inflation silently creeps in to consume every extra dollar, trapping your freedom forever.",
          prompt: "A person walking inside a clean 2D stylized golden hamster wheel surrounded by rising expense bar graphs, flat vector art"
        },
        {
          core: "The biggest paradox of traditional employment is that working blindly hard often takes away your right to control your future.",
          expand: "When your entire life depends on a single paycheck, any economic shock can instantly collapse your financial stability.",
          prompt: "A fragile tower of stylized financial blocks standing beside an office desk, storm clouds, clean 2D motion graphic design"
        }
      ]
    },
    {
      act: "Act 2: Uncovering The Root Flaw & Poor Mindset",
      connectors: [
        "To understand why this cycle repeats,",
        "The root cause is not how much money you earn,",
        "The complete lack of practical financial education is the real culprit,",
        "The poor view money through the lens of immediate consumption,",
        "While the wealthy treat every dollar as an automated working soldier,"
      ],
      scenes: [
        {
          core: "Most people fall into the trap of 'instant gratification' to soothe workplace burnout and stress.",
          expand: "Expensive gadgets, luxury dining, and overpriced vacations are often just expensive masks hiding an empty savings account.",
          prompt: "A stylish flat 2D vector comparison between impulsive credit card spending versus growing investment assets, modern infographic"
        },
        {
          core: "An asset puts money into your pocket, while a liability quietly drains money out of your pocket every single day.",
          expand: "If you spend your youth buying liabilities to impress people who don't even care, you pay with the freedom of your remaining years.",
          prompt: "A clean split-screen 2D vector diagram comparing a leaking cash wallet with an automated compound interest tree, infographic style"
        },
        {
          core: "The traditional school system taught us how to be great employees, but never taught us how money actually works.",
          expand: "We spend 16 years learning how to trade time for money, but zero hours learning how to make money work tirelessly for us.",
          prompt: "An open stylized 2D book with floating financial growth curves and investment formulas, clean vector aesthetic"
        }
      ]
    },
    {
      act: "Act 3: The Mindset Pivot & Wealth Leverage",
      connectors: [
        "And this is the exact moment you must wake up,",
        "Real breakthrough begins when you shift your mental paradigm,",
        "Instead of continuing to sell your precious time cheaply,",
        "Start shifting from a consumer mindset into a builder and investor mindset,",
        "Financial leverage and compounding knowledge are the ultimate keys,"
      ],
      scenes: [
        {
          core: "The wealthy do not work for money; they work to build and own automated systems of self-growing assets.",
          expand: "Human labor is strictly limited to 24 hours a day, but the leverage of capital, software, and compound interest is limitless.",
          prompt: "A modern visionary analyzing glowing 2D holographic financial portfolio charts at midnight, minimalist clean infographic"
        },
        {
          core: "The single greatest secret to lasting wealth is building continuous passive cash flow.",
          expand: "When passive income from diversified index funds and scalable assets exceeds your living expenses, you become truly free.",
          prompt: "Clean 2D vector streams of golden coins flowing automatically into investment buckets, financial education graphic"
        },
        {
          core: "Never let your cash sit idle in a savings account to be slowly eaten away by inflation every year.",
          expand: "Turn every single dollar into a disciplined worker deployed onto the market battlefield to generate more returns for you.",
          prompt: "A 2D vector graphic of golden investment chess pieces strategically advancing on a growth chart board, clean minimalist art"
        }
      ]
    },
    {
      act: "Act 4: The Strategic Blueprint & Daily Discipline",
      connectors: [
        "Yet dreams remain pure illusion without consistent practical execution,",
        "To turn this financial roadmap into real-world reality,",
        "You must start with the smallest daily disciplined habits,",
        "The hours after 6 PM are the exact battlefield where your destiny is forged,",
        "Execute step-by-step with relentless focus without seeking applause,"
      ],
      scenes: [
        {
          core: "The 8 PM Rule: Average people spend their evenings scrolling social media, while champions spend it building their secondary asset base.",
          expand: "Dedicating just 2 hours every evening to mastering high-income skills and investing will put you ahead of 99% of people within a year.",
          prompt: "A focused individual working on a laptop at a neat modern desk with stock charts on screen, 2D vector infographic style"
        },
        {
          core: "The Snowball Effect of compounding discipline creates an unstoppable financial momentum.",
          expand: "Do not be discouraged by slow initial progress; tree roots must grow deep into the soil in darkness before branches reach the sky.",
          prompt: "A dynamic 2D flat vector infographic showing exponential compound growth curve transforming from tiny snowball to giant asset mountain"
        },
        {
          core: "Master delayed gratification and reject short-term temptations to protect your long-term empire.",
          expand: "Your ability to delay gratification is the single greatest predictor of financial independence and lifelong freedom.",
          prompt: "A person ascending a clean 2D vector staircase of financial milestones toward a bright golden horizon, minimalist modern graphic"
        }
      ]
    },
    {
      act: "Act 5: Ultimate Freedom & The Awakening Call",
      connectors: [
        "And finally, when you stay consistent through the quiet years of discipline,",
        "The greatest prize is not merely the balance in your brokerage account,",
        "It is the sovereign right to live life entirely on your own terms,",
        "You gain the power to say NO to toxic environments without fear,",
        "Your future belongs entirely to the decisions you make right now,"
      ],
      scenes: [
        {
          core: "True financial freedom is not about lavish luxury; it is about absolute ownership of your time and destiny.",
          expand: "It is waking up every morning on your own schedule, spending time with loved ones, and pursuing what truly matters to your soul.",
          prompt: "A joyful person standing at the top of a scenic mountain looking at a radiant 2D sunrise with glowing financial freedom badge"
        },
        {
          core: "Do not wait for the perfect moment, because the only perfect moment to transform your life is RIGHT NOW.",
          expand: "Ten years from today, you will look back and thank yourself deeply for having the courage to start today. Take action now!",
          prompt: "A glowing 2D vector compass pointing toward a radiant golden future with financial freedom roadmaps, inspiring clean infographic"
        }
      ]
    }
  ] : [
    {
      act: "Hồi 1: Cú Sốc Thực Tại & Chiếc Bẫy Cuộc Sống",
      connectors: [
        "Mở đầu cho tất cả những bế tắc này,",
        "Hãy nhìn thẳng vào thực tế mỗi ngày,",
        "Và rồi, khi guồng quay công việc cuốn bạn đi,",
        "Chúng ta thường tự an ủi bản thân rằng mọi thứ vẫn ổn,",
        "Nhưng sâu thẳm bên trong, một nỗi bất an vô hình luôn thường trực,"
      ],
      scenes: [
        {
          core: "Có một sự thật cay đắng mà phần lớn chúng ta chỉ nhận ra khi đã bước qua tuổi 30, đó là chúng ta đang dùng toàn bộ thanh xuân chỉ để DUY TRÌ cuộc sống hiện tại.",
          expand: "Mỗi sáng thức dậy trong sự mệt mỏi, chen chúc giữa dòng xe cộ đông đúc để đến nơi làm việc, cống hiến 8 đến 10 tiếng mỗi ngày chỉ để nhận về một khoản lương vừa đủ chi trả các hóa đơn hàng tháng.",
          prompt: "A lone exhausted worker walking in a dark crowded city street during foggy rainy dawn, silhouette 2D flat vector storytelling style"
        },
        {
          core: "Chúng ta nghĩ rằng mình đang nỗ lực tiến về phía trước, nhưng thực chất chỉ đang chạy trên một chiếc máy chạy bộ không bao giờ có điểm dừng.",
          expand: "Thu nhập tăng lên một chút thì chi phí sinh hoạt cũng tự động leo thang tương ứng; chiếc bẫy lạm phát lối sống đã âm thầm giam cầm tự do của bạn từ lúc nào không hay.",
          prompt: "A person running inside a glowing golden hamster wheel floating in a modern city, 2D flat vector infographic aesthetic"
        },
        {
          core: "Nghịch lý lớn nhất của người làm công ăn lương là càng chăm chỉ một cách mù quáng, bạn lại càng đánh mất quyền tự quyết định tương lai của chính mình.",
          expand: "Khi toàn bộ nguồn sống chỉ phụ thuộc vào một nguồn thu nhập duy nhất, bất kỳ một biến động nhỏ nào từ nền kinh tế cũng có thể đẩy gia đình bạn vào thế bấp bênh.",
          prompt: "Dramatic close-up of a precarious house of cards standing tall on an office desk, storm clouds, clean 2D motion graphic design"
        }
      ]
    },
    {
      act: "Hồi 2: Bóc Trần Cội Rễ & Tư Duy Nghèo Bền Vững",
      connectors: [
        "Để hiểu được vì sao điều này lặp đi lặp lại,",
        "Nguyên nhân cốt lõi không nằm ở việc bạn kiếm được bao nhiêu tiền,",
        "Chính sự thiếu hụt kiến thức tài chính cơ bản đã tạo nên rào cản này,",
        "Người nghèo thường nhìn tiền bạc dưới góc độ tiêu dùng tức thì,",
        "Trong khi người giàu lại nhìn đồng tiền như những hạt giống sinh sôi,"
      ],
      scenes: [
        {
          core: "Hầu hết mọi người đều rơi vào cạm bẫy 'mua sự thoải mái tức thì' để xoa dịu những áp lực và mệt mỏi sau giờ làm việc.",
          expand: "Những món đồ công nghệ đắt đỏ, những bữa tiệc xa xỉ hay những chuyến du lịch vượt quá khả năng tài chính thực chất chỉ là chiếc mặt nạ che đậy sự trống rỗng bên trong.",
          prompt: "A lavish dimly lit room with glowing neon credit cards and shopping bags, 2D flat vector financial infographic"
        },
        {
          core: "Tài sản thực sự là thứ đẻ ra tiền cho bạn, còn tiêu sản là thứ âm thầm rút cạn từng đồng trong túi của bạn mỗi ngày.",
          expand: "Nếu bạn dành cả tuổi trẻ để mua sắm tiêu sản nhằm gây ấn tượng với những người thậm chí không hề quan tâm đến bạn, bạn sẽ phải trả giá bằng sự tự do trong nửa đời còn lại.",
          prompt: "A split scene comparing a leaking old leather wallet on the left and a radiant growing digital money tree on the right, clean 2D vector"
        },
        {
          core: "Lỗ hổng lớn nhất trong hệ thống giáo dục truyền thống là dạy chúng ta trở thành những người làm thuê xuất sắc nhưng không dạy cách làm chủ đồng tiền.",
          expand: "Chúng ta dành 16 năm trên ghế nhà trường để học cách đổi thời gian lấy tiền, nhưng không ai chỉ cho ta biết cách bắt đồng tiền phải làm việc cật lực cho mình.",
          prompt: "An open vintage book glowing with complex financial formulas inside a dark library, 2D flat motion graphic illustration"
        }
      ]
    },
    {
      act: "Hồi 3: Bước Ngoặt Tư Duy & Đòn Bẩy Tài Sản",
      connectors: [
        "Và đây chính là thời điểm bạn cần phải thức tỉnh,",
        "Bước ngoặt chỉ thực sự xảy ra khi bạn thay đổi góc nhìn,",
        "Thay vì tiếp tục bán rẻ thời gian quý báu của cuộc đời,",
        "Hãy bắt đầu chuyển dịch từ tư duy người tiêu dùng sang tư duy nhà kiến tạo,",
        "Đòn bẩy tài chính và tri thức chính là chiếc chìa khóa duy nhất,"
      ],
      scenes: [
        {
          core: "Người giàu không bao giờ làm việc vì tiền; họ làm việc để xây dựng và sở hữu những hệ thống tài sản tự vận hành.",
          expand: "Họ hiểu rằng sức lao động của một con người là hữu hạn, nhưng sức mạnh của đòn bẩy công nghệ, vốn và trí tuệ nhân loại là vô tận.",
          prompt: "A visionary architect analyzing glowing 3D holographic city blueprints at midnight, clean 2D vector flat style"
        },
        {
          core: "Bí mật vĩ đại nhất của sự giàu có bền vững nằm ở hai chữ: DÒNG TIỀN thụ động.",
          expand: "Khi dòng tiền thụ động từ các khoản đầu tư và dự án kinh doanh vượt qua chi phí sinh hoạt thiết yếu, bạn chính thức bước chân vào thế giới của những người tự do.",
          prompt: "Glowing golden liquid streams flowing smoothly into clear glass containers representing passive cash flow, 2D flat infographic"
        },
        {
          core: "Đừng bao giờ để tiền nằm yên trong tài khoản tiết kiệm để rồi bị lạm phát âm thầm bào mòn qua từng năm tháng.",
          expand: "Hãy biến mỗi đồng tiền bạn kiếm được trở thành một người lính dũng cảm, liên tục ra trận để mang về thêm nhiều chiến lợi phẩm cho bạn.",
          prompt: "A chessboard with glowing gold chess pieces marching forward decisively under spotlight, clean 2D vector graphic"
        }
      ]
    },
    {
      act: "Hồi 4: Kế Hoạch Hành Động & Kỷ Luật Khắc Kỷ",
      connectors: [
        "Nhưng ước mơ sẽ mãi chỉ là ảo tưởng nếu thiếu đi hành động thực tế,",
        "Để hiện thực hóa mục tiêu tự do này,",
        "Bạn phải bắt đầu từ những thói quen kỷ luật nhỏ nhất mỗi ngày,",
        "Khoảng thời gian sau 6 giờ tối chính là chiến trường định đoạt số phận,",
        "Hãy kiên trì thực hiện từng bước mà không cần sự tán thưởng của đám đông,"
      ],
      scenes: [
        {
          core: "Quy tắc 8 giờ tối: Người bình thường dùng thời gian này để lướt mạng xã hội vô bổ, còn người bứt phá dùng nó để xây dựng đế chế thứ hai.",
          expand: "Chỉ cần dành ra 2 tiếng mỗi tối để học hỏi kỹ năng mới, nghiên cứu thị trường và triển khai sản phẩm số, bạn sẽ bỏ xa 99% những người xung quanh chỉ sau 1 năm.",
          prompt: "A focused individual working on a laptop at a neat desk, coffee cup, deep concentration 2D flat motion graphic style"
        },
        {
          core: "Hiệu ứng hòn tuyết lăn của sự kỷ luật: Những nỗ lực nhỏ tích lũy đều đặn sẽ tạo nên một sức mạnh không thể cản phá.",
          expand: "Đừng nản lòng khi chưa nhìn thấy kết quả ngay lập tức; rễ cây phải cắm thật sâu vào lòng đất trong bóng tối trước khi tán cây có thể vươn cao đón ánh mặt trời.",
          prompt: "Extreme macro of a luminous snow crystal rolling down a slope growing into a glowing avalanche, 2D flat vector illustration"
        },
        {
          core: "Học cách sống khắc kỷ và từ chối những cám dỗ tầm thường để bảo vệ mục tiêu vĩ đại phía trước.",
          expand: "Khả năng trì hoãn sự thỏa mãn ngắn hạn chính là thước đo chính xác nhất cho sự trưởng thành và thành công tài chính của một con người.",
          prompt: "A solitary monk walking steadily along a high mountain ridge toward golden dawn, minimalist 2D vector"
        }
      ]
    },
    {
      act: "Hồi 5: Tự Do Đích Thực & Lời Kêu Gọi Thức Tỉnh",
      connectors: [
        "Và rồi, khi bạn đã kiên trì bước qua những tháng ngày gian khó,",
        "Phần thưởng lớn nhất không phải là số tiền trong tài khoản,",
        "Mà đó chính là quyền được sống một cuộc đời trọn vẹn theo cách bạn muốn,",
        "Bạn có quyền nói KHÔNG với những điều độc hại mà không còn sợ hãi,",
        "Tương lai của bạn hoàn toàn nằm trong tay những quyết định hôm nay,"
      ],
      scenes: [
        {
          core: "Tự do tài chính đích thực không phải là để sống xa hoa hưởng lạc, mà là để toàn quyền làm chủ thời gian và số phận của chính mình.",
          expand: "Đó là khi bạn có thể thức dậy mỗi sáng với nụ cười, dành thời gian cho những người thân yêu và theo đuổi những đam mê ý nghĩa nhất của cuộc đời.",
          prompt: "A free person standing on the edge of an ocean cliff watching golden sunrise, inspiring 2D flat vector graphic"
        },
        {
          core: "Đừng chờ đợi một thời điểm hoàn hảo, bởi vì thời điểm hoàn hảo nhất để thay đổi cuộc đời bạn chính là NGAY BÂY GIỜ.",
          expand: "10 năm nữa nhìn lại, bạn sẽ vô cùng biết ơn sự dũng cảm và kiên định của bản thân trong ngày hôm nay. Hãy bắt đầu hành trình tự do của bạn ngay từ phút giây này!",
          prompt: "A glowing golden compass resting on a world map at sunrise, inspiring 2D flat vector roadmap"
        }
      ]
    }
  ];

  let scenes = [];
  let voices = [];

  const totalSec = totalMinutes * 60;
  const avgDurationPerImage = Math.max(3, Math.round((totalSec / totalScenes) * 10) / 10);

  // Camera Shot Angles for multi-image illustration
  const shotAngles = [
    "Wide angle establishing shot",
    "Close-up detailed focus shot",
    "Isometric 3D perspective view",
    "Cinematic side profile angle",
    "Over-the-shoulder perspective view",
    "Dynamic low-angle view",
    "Top-down flatlay overview"
  ];

  // 1. Kho ý tưởng dẫn chuyện tài chính theo từng hồi
  const ideasByAct = {
    "vi": [
      {
        act: "Hồi 1: Cú Sốc Thực Tại & Chiếc Bẫy Cuộc Sống",
        prompts: [
          "Wide angle establishing shot, A lone exhausted worker walking in a dark crowded city street at foggy dawn, silhouette 2D flat vector",
          "Close-up detailed focus shot, A person running inside a glowing golden hamster wheel, 2D flat vector infographic",
          "Isometric 3D view, A precarious tower of stylized financial blocks standing beside an office desk, storm clouds, clean 2D vector"
        ],
        points: [
          "Phần lớn chúng ta chỉ nhận ra khi đã bước qua tuổi 30 rằng mình đang dùng toàn bộ thanh xuân chỉ để duy trì cuộc sống.",
          "Mỗi sáng thức dậy chen chúc trong dòng xe cộ để đến công ty đổi lấy đồng lương chi trả hóa đơn.",
          "Thu nhập vừa tăng lên thì chiếc bẫy lạm phát lối sống đã âm thầm giam cầm tự do của bạn.",
          "Nghịch lý là càng làm việc mù quáng thì bạn càng mất quyền tự quyết định tương lai của mình.",
          "Khi chỉ dựa vào một nguồn thu nhập duy nhất thì bất kỳ biến động nào cũng khiến bạn bấp bênh."
        ]
      },
      {
        act: "Hồi 2: Bóc Trần Cội Rễ & Tư Duy Nghèo Bền Vững",
        prompts: [
          "Cinematic side profile angle, A lavish dimly lit room with glowing neon credit cards and shopping bags, 2D flat vector",
          "Split screen comparison, A leaking old wallet on left and a growing digital money tree on right, 2D vector",
          "Isometric perspective, An open vintage book glowing with financial formulas inside a dark library, 2D vector"
        ],
        points: [
          "Chiếc bẫy chi tiêu cảm xúc để xoa dịu áp lực sau giờ làm chính là nguyên nhân rút cạn tài khoản.",
          "Những món đồ công nghệ đắt đỏ hay chuyến du lịch vượt khả năng chỉ là chiếc mặt nạ che đậy sự trống rỗng.",
          "Tài sản là thứ đẻ ra tiền cho bạn còn tiêu sản là thứ âm thầm lấy tiền ra khỏi túi mỗi ngày.",
          "Trường học dạy chúng ta trở thành người làm thuê giỏi chứ chưa từng dạy cách làm chủ đồng tiền.",
          "Chúng ta học cách đổi thời gian lấy tiền mà không biết cách bắt đồng tiền làm việc cho mình."
        ]
      },
      {
        act: "Hồi 3: Bước Ngoặt Tư Duy & Đòn Bẩy Tài Sản",
        prompts: [
          "Over-the-shoulder perspective, A visionary analyzing glowing 3D holographic city blueprints at midnight, 2D flat style",
          "Dynamic angle view, Glowing golden liquid streams flowing smoothly into clear glass containers representing cash flow, 2D vector",
          "Low-angle heroic view, A chessboard with glowing gold chess pieces marching forward decisively under spotlight, 2D vector"
        ],
        points: [
          "Người giàu không làm việc vì tiền mà họ xây dựng những hệ thống tài sản tự động vận hành.",
          "Sức lao động của con người có hạn nhưng sức mạnh của công nghệ vốn và lãi kép là vô tận.",
          "Bí mật lớn nhất của sự giàu có bền vững chính là tạo ra dòng tiền thụ động đều đặn.",
          "Khi thu nhập thụ động vượt qua chi phí sinh hoạt bạn chính thức bước chân vào thế giới tự do.",
          "Đừng để tiền nằm yên trong tài khoản mà hãy biến mỗi đồng tiền thành một người lính ra trận sinh lời."
        ]
      },
      {
        act: "Hồi 4: Kế Hoạch Hành Động & Kỷ Luật Khắc Kỷ",
        prompts: [
          "Top-down flatlay view, A focused individual working on a laptop at a neat desk, coffee cup, 2D vector style",
          "Macro view, Extreme macro of a luminous snow crystal rolling down a slope growing into a glowing avalanche, 2D vector",
          "Minimalist 2D view, A solitary monk walking steadily along a high mountain ridge toward golden dawn, 2D vector"
        ],
        points: [
          "Quy tắc 8 giờ tối là người bình thường lướt mạng còn người bứt phá dùng nó để xây dựng đế chế thứ hai.",
          "Dành ra hai tiếng mỗi tối để rèn luyện kỹ năng sinh lời cao sẽ giúp bạn bỏ xa số đông sau một năm.",
          "Hiệu ứng hòn tuyết lăn của sự kỷ luật sẽ tích lũy những nỗ lực nhỏ thành thành quả vĩ đại.",
          "Đừng nản lòng khi chưa thấy kết quả ngay vì rễ cây phải cắm sâu vào lòng đất trước khi đơm hoa.",
          "Khả năng trì hoãn sự thỏa mãn ngắn hạn chính là thước đo chính xác nhất cho thành công tài chính."
        ]
      },
      {
        act: "Hồi 5: Tự Do Đích Thực & Lời Kêu Gọi Thức Tỉnh",
        prompts: [
          "Inspiring perspective, A free person standing on the edge of an ocean cliff watching golden sunrise, 2D vector",
          "Roadmap concept, A glowing golden compass resting on a world map at sunrise, inspiring 2D flat vector",
          "Visionary angle, Golden sunrise breaking over horizon illuminating modern clean metropolis, 2D flat vector"
        ],
        points: [
          "Tự do tài chính đích thực là quyền được toàn quyền làm chủ thời gian và số phận của chính mình.",
          "Đó là khi bạn thức dậy mỗi sáng với niềm vui và toàn tâm dành thời gian cho những điều ý nghĩa.",
          "Đừng chờ đợi thời điểm hoàn hảo vì thời điểm hoàn hảo nhất để thay đổi chính là ngay bây giờ.",
          "Mười năm nữa nhìn lại bạn sẽ vô cùng biết ơn sự dũng cảm và kiên định của bản thân ngày hôm nay.",
          "Hãy bắt đầu hành trình làm chủ tài chính và kiến tạo cuộc đời tự do của bạn ngay từ giây phút này."
        ]
      }
    ],
    "en": [
      {
        act: "Act 1: The Reality Check & The Rat Race Trap",
        prompts: [
          "Wide angle establishing shot, A lone professional walking in a minimalist 2D flat modern city at dawn, clean vector",
          "Close-up detailed focus shot, A person walking inside a clean 2D stylized golden hamster wheel, flat vector art",
          "Isometric view, A fragile tower of stylized financial blocks standing beside an office desk, clean 2D vector"
        ],
        points: [
          "Most people realize after age thirty that they spend their entire youth merely maintaining daily existence.",
          "Waking up exhausted each morning to trade your life hours for a paycheck that barely covers bills.",
          "Lifestyle inflation quietly rises alongside your income, keeping you permanently trapped in the rat race.",
          "Working blindly hard without financial leverage strips away your power to control your own future.",
          "Relying solely on a single paycheck leaves your family vulnerable to any sudden economic shock."
        ]
      },
      {
        act: "Act 2: Uncovering The Root Flaw & Poor Mindset",
        prompts: [
          "Cinematic side angle, A stylish flat 2D vector comparison between impulsive credit spending versus investing, infographic",
          "Split-screen view, A clean 2D diagram comparing a leaking cash wallet with compound interest tree, vector",
          "Isometric aesthetic, An open stylized 2D book with floating financial growth curves and formulas, clean vector"
        ],
        points: [
          "Instant gratification spending to soothe workplace burnout is the primary trap draining your savings.",
          "Expensive gadgets and luxury meals are often just costly masks hiding underlying financial anxiety.",
          "An asset puts money into your pocket while a liability quietly drains it every single day.",
          "Traditional schools teach us to be obedient employees but never teach us how money actually works.",
          "We spend decades trading time for money without learning how to make money work tirelessly for us."
        ]
      },
      {
        act: "Act 3: The Mindset Pivot & Wealth Leverage",
        prompts: [
          "Over-the-shoulder angle, A visionary analyzing glowing 2D holographic financial portfolio charts at midnight, clean vector",
          "Dynamic view, Clean 2D vector streams of golden coins flowing automatically into investment buckets, infographic",
          "Heroic low-angle, A 2D vector graphic of golden investment chess pieces strategically advancing on growth chart, vector"
        ],
        points: [
          "The wealthy do not trade time for money; they build and own automated systems of self-growing assets.",
          "Human labor is limited to 24 hours but the leverage of code, capital and compounding is infinite.",
          "The single greatest secret to lasting wealth is creating continuous automated passive cash flow.",
          "When your passive investment returns exceed your living expenses, you become genuinely free.",
          "Never leave cash idle; turn every single dollar into a disciplined worker generating higher returns."
        ]
      },
      {
        act: "Act 4: The Strategic Blueprint & Daily Discipline",
        prompts: [
          "Top-down flatlay, A focused individual working on a laptop at a neat modern desk with growth charts, 2D vector",
          "Macro view, Extreme macro of a luminous snow crystal rolling down a slope into a glowing avalanche, 2D vector",
          "Minimalist view, A disciplined individual walking along a high mountain ridge toward golden dawn, 2D vector"
        ],
        points: [
          "Average people spend evenings scrolling social feeds, while achievers spend it building secondary asset income.",
          "Investing two focused hours every night into high-income skills puts you ahead of ninety-nine percent within a year.",
          "The compounding snowball effect of daily discipline turns small consistent actions into massive breakthroughs.",
          "Never get discouraged early; roots must grow deep in the dark before branches reach into sunlight.",
          "The ability to delay short-term gratification is the ultimate predictor of long-term financial freedom."
        ]
      },
      {
        act: "Act 5: True Freedom & The Awakening Call",
        prompts: [
          "Inspiring perspective, A free individual standing atop an ocean cliff watching golden sunrise, clean 2D vector",
          "Roadmap view, A glowing golden compass resting on a world map at sunrise, inspiring 2D vector",
          "Visionary angle, Golden sunrise breaking over horizon illuminating modern clean metropolis, 2D flat vector"
        ],
        points: [
          "True financial freedom is having complete sovereign command over your precious time and life destiny.",
          "It is waking up every morning energized to pursue meaningful passions with the people you love.",
          "Never wait for a perfect timing because the single best moment to transform your life is right now.",
          "Ten years from today, you will look back with immense gratitude for the courageous decision you make today.",
          "Begin your journey toward financial mastery and lifelong freedom starting from this very moment."
        ]
      }
    ]
  };

  const acts = ideasByAct[isEn ? "en" : "vi"] || ideasByAct["vi"];

  for (let i = 0; i < totalScenes; i++) {
    const actIdx = Math.min(Math.floor((i / totalScenes) * acts.length), acts.length - 1);
    const actData = acts[actIdx];
    const basePoint = actData.points[i % actData.points.length];
    const nextPoint = actData.points[(i + 1) % actData.points.length];
    const promptText = actData.prompts[i % actData.prompts.length];
    const shotAngle = shotAngles[i % shotAngles.length];

    // Thời lượng thực tế cho ảnh này (VD: 10 phút / 40 ảnh = 15 giây)
    const duration = Math.max(3, Math.round(avgDurationPerImage));

    // Xây dựng câu thoại dài tương ứng với thời lượng:
    // Tốc độ nói chuẩn: ~2.4 từ/giây. 
    // Nếu duration = 15s -> Cần đoạn thoại dài khoảng 30 - 35 từ (đọc ~13 - 14s)
    let fullStorySentence = basePoint;
    if (duration >= 12) {
      if (isEn) {
        fullStorySentence = `${basePoint} Furthermore, ${nextPoint.toLowerCase()}`;
      } else {
        fullStorySentence = `${basePoint} Hơn thế nữa, ${nextPoint.charAt(0).toLowerCase() + nextPoint.slice(1)}`;
      }
    } else if (duration >= 8) {
      if (isEn) {
        fullStorySentence = `${basePoint} This is the core principle that changes everything.`;
      } else {
        fullStorySentence = `${basePoint} Đây chính là quy luật cốt lõi tạo nên sự khác biệt.`;
      }
    }

    const wordCount = fullStorySentence.split(/\s+/).filter(Boolean).length;
    const speechSec = Math.max(1, Math.round(wordCount / 2.4));

    const charInputVal = (document.getElementById("finCharInput")?.value || "").trim();
    const charDirective = charInputVal ? ", featuring the consistent main character persona, same face and clothing from reference image" : "";

    const promptFinal = `${shotAngle}, ${promptText}${charDirective}, theme of ${topic}, style of ${fixedStyle}, ${textDirective}, 8k wallpaper aspect 16:9, masterpiece educational infographic`;

    scenes.push({
      sceneIndex: i + 1,
      title: `${actData.act} (#${i + 1})`,
      durationSec: duration,
      speechSec: speechSec,
      wordCount: wordCount,
      voiceText: fullStorySentence,
      imagePrompt: promptFinal,
      status: "pending",
      imageUrl: null
    });

    voices.push(`[Cảnh ${i + 1} | Ảnh hiện ${duration}s | Đọc ${speechSec}s]: "${fullStorySentence}"`);
  }

  return { scenes, voices };
}


// Hàm render thẻ Scene chuẩn đẹp: Có ảnh Preview trực tiếp, nút tải ảnh riêng lẻ, và trạng thái
function renderSceneCardHTML(sc, idx) {
  const isDone = sc.status === 'done' && sc.imageUrl;
  return `
    <div style="background:var(--surface2); border:1px solid var(--border); border-radius:12px; padding:14px; margin-bottom:10px; transition:border-color 0.2s;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-weight:800; font-size:12px; color:var(--text); display:flex; align-items:center; gap:6px;">
          <span style="background:var(--accent); color:white; border-radius:6px; padding:2px 7px; font-size:11px;">#${sc.sceneIndex}</span>
          ${sc.title}
        </span>
        <div style="display:flex; gap:6px;">
          <span style="background:var(--surface3); color:var(--accent2); font-size:10px; font-weight:700; padding:3px 8px; border-radius:6px; border:1px solid rgba(56,189,248,0.2);">⏱️ Hiện: ${sc.durationSec}s</span>
          <span style="background:var(--green-bg); color:var(--green); font-size:10px; font-weight:700; padding:3px 8px; border-radius:6px; border:1px solid rgba(16,185,129,0.2);">🎙️ Đọc: ${sc.speechSec}s (~${sc.wordCount} từ)</span>
        </div>
      </div>

      <div style="font-size:12px; color:#93c5fd; font-style:italic; margin-bottom:8px; line-height:1.5; background:rgba(15,23,42,0.6); padding:8px 10px; border-radius:8px;">
        🎙️ <b>Script Âm thanh:</b> "${sc.voiceText}"
      </div>

      <div style="font-size:11px; background:var(--bg); padding:8px 10px; border-radius:8px; border:1px solid var(--border); color:var(--text2); margin-bottom:8px; line-height:1.4;">
        🎨 <b>Prompt Hình ảnh:</b> ${sc.imagePrompt}
      </div>

      <!-- Ảnh preview trực tiếp nếu đã vẽ xong -->
      <div id="finScenePreview_${idx}" style="${isDone ? 'display:flex;' : 'display:none;'} gap:12px; align-items:center; margin-top:8px; background:var(--bg); padding:8px 12px; border-radius:8px; border:1px solid rgba(16,185,129,0.3);">
        <img id="finSceneImg_${idx}" src="${sc.imageUrl || ''}" style="height:70px; width:120px; border-radius:6px; object-fit:cover; cursor:pointer; box-shadow:0 4px 10px rgba(0,0,0,0.3);" class="btn-view-scene-img" data-idx="${idx}" title="Bấm để xem ảnh phóng to">
        <div style="flex:1;">
          <div style="font-size:11px; color:var(--green); font-weight:800; margin-bottom:4px;">✅ Ảnh đã sẵn sàng 100%</div>
          <button class="btn btn-sm btn-green btn-download-scene-img" data-idx="${idx}" style="font-size:11px; padding:4px 10px; font-weight:700;">⬇️ Tải Ảnh Về Máy</button>
        </div>
      </div>

      <div id="finSceneState_${idx}" style="font-size:11px; font-weight:700; color:${isDone ? 'var(--green)' : 'var(--yellow)'}; margin-top:8px;">
        ${isDone ? '✅ Đã vẽ xong!' : '⏳ Trạng thái: Chưa vẽ'}
      </div>
    </div>
  `;
}

// Cập nhật trạng thái hiển thị của các nút (Tự động hiện nút Ghép Video nếu đã có ảnh)
function updateFinanceActionButtons() {
  const btnGenAll = document.getElementById("btnGenAllFinVideos");
  const btnDl = document.getElementById("btnDownloadAllFinClips");
  if (!currentFinanceScenes || !currentFinanceScenes.length) return;

  const doneCount = currentFinanceScenes.filter(s => s.status === 'done' && s.imageUrl).length;
  const total = currentFinanceScenes.length;

  if (doneCount > 0) {
    if (btnDl) btnDl.style.display = "inline-flex";
    if (doneCount === total) {
      if (btnGenAll) {
        btnGenAll.textContent = "🔄 Bấm để Vẽ lại toàn bộ ảnh";
        btnGenAll.style.background = "var(--surface2)";
        btnGenAll.style.border = "1px solid var(--border)";
      }
    } else {
      if (btnGenAll) {
        btnGenAll.textContent = `🎨 Vẽ tiếp các ảnh còn lại (${doneCount}/${total} đã xong)`;
        btnGenAll.style.background = "var(--accent)";
      }
    }
  } else {
    if (btnDl) btnDl.style.display = "none";
    if (btnGenAll) {
      btnGenAll.textContent = "🎨 1-Click Tự Động Vẽ Hàng Loạt Tất Cả Ảnh";
      btnGenAll.style.background = "var(--accent)";
    }
  }
}

// Flow Studio Pro v4.0 - Clean Standalone Logic (No Inline Script CSP Issues)
"use strict";

const EXT_ID = chrome.runtime.id;

// Helper: Call Background Service Worker
function callExt(action, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ── Tab Switching ──
function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + tabName));
  
  const id1 = document.getElementById("projectId")?.value;
  const id2 = document.getElementById("projectId2")?.value;
  const id3 = document.getElementById("batchProjectId")?.value;
  const id4 = document.getElementById("imageProjectId")?.value;
  const id5 = document.getElementById("batchImageProjectId")?.value;
  const currentId = id1 || id2 || id3 || id4 || id5;
  
  if (document.getElementById("projectId")) document.getElementById("projectId").value = currentId;
  if (document.getElementById("projectId2")) document.getElementById("projectId2").value = currentId;
  if (document.getElementById("batchProjectId")) document.getElementById("batchProjectId").value = currentId;
  if (document.getElementById("imageProjectId")) document.getElementById("imageProjectId").value = currentId;
  if (document.getElementById("batchImageProjectId")) document.getElementById("batchImageProjectId").value = currentId;
  
  if (tabName === "library") fetchVideos();
}

// ── Toast Notification ──
function toast(msg, type = "info") {
  const c = document.getElementById("toasts");
  if (!c) return;
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 3500);
}

// ── Auto Sync Project ID from Active Google Flow Tab ──
async function autoSyncProject() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://labs.google/*" });
    if (tabs.length && tabs[0].url) {
      const m = tabs[0].url.match(/project\/([a-f0-9\-]{36})/i);
      if (m && m[1]) {
        const pid = m[1];
        ["finProjectId", "projectId", "projectId2", "batchProjectId", "imageProjectId", "batchImageProjectId"].forEach(id => {
          const el = document.getElementById(id);
          if (el && (!el.value || el.value.startsWith("9eda0c71"))) el.value = pid;
        });
      }
    }
  } catch (_) {}
}

// ── Create Single Video ──
async function createVideo() {
  const prompt = document.getElementById("promptInput").value.trim();
  const projectId = document.getElementById("projectId").value.trim();
  const model = document.getElementById("videoModel").value;
  const aspectRatio = document.getElementById("aspectRatio").value;
  const startImage = document.getElementById("startImage")?.value?.trim() || null;
  const endImage = document.getElementById("endImage")?.value?.trim() || null;
  const btn = document.getElementById("btnCreate");
  const st = document.getElementById("createStatus");

  if (!prompt && !startImage) { toast("Vui lòng nhập prompt hoặc ảnh bắt đầu!", "error"); return; }
  if (!projectId) { toast("Thiếu Project ID!", "error"); return; }

  btn.disabled = true;
  btn.textContent = "⏳ Đang gửi yêu cầu tạo video...";
  st.className = "status-msg loading";
  st.textContent = "🚀 Đang gửi yêu cầu qua Veo 3.1...";

  try {
    const res = await callExt("CREATE_VIDEO", { prompt, projectId, model, aspectRatio, startImage, endImage });
    if (res?.success) {
      st.className = "status-msg ok";
      st.textContent = res.message || "✅ Đã tạo video thành công! Chờ Google render...";
      toast("Đã gửi tạo video thành công!", "success");
      document.getElementById("promptInput").value = "";
    } else {
      st.className = "status-msg err";
      st.textContent = "❌ " + (res?.error || "Lỗi tạo video") + (res?.detail ? ` (${res.detail})` : "");
      toast(res?.error || "Lỗi tạo video", "error");
    }
  } catch (e) {
    st.className = "status-msg err";
    st.textContent = "❌ Lỗi: " + e.message;
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🚀 Gửi Tạo Video";
  }
}

// ── Create Single Image ──
async function createImage() {
  const prompt = document.getElementById("imagePromptInput").value.trim();
  const projectId = document.getElementById("imageProjectId").value.trim();
  const model = document.getElementById("imageModel").value;
  const aspectRatio = document.getElementById("imageAspect").value;
  const referenceImage = document.getElementById("refImage")?.value?.trim() || null;
  const btn = document.getElementById("btnCreateImage");
  const st = document.getElementById("imageCreateStatus");
  const resDiv = document.getElementById("imageResult");

  if (!prompt && !referenceImage) { toast("Vui lòng nhập prompt hoặc ảnh mẫu!", "error"); return; }
  if (!projectId) { toast("Thiếu Project ID!", "error"); return; }

  btn.disabled = true;
  btn.textContent = "⏳ Đang vẽ ảnh...";
  st.className = "status-msg loading";
  st.textContent = "🎨 Đang gọi mô hình Imagen vẽ ảnh...";

  try {
    const res = await callExt("CREATE_IMAGE", { prompt, projectId, model, aspectRatio, referenceImage });
    if (res?.success) {
      st.className = "status-msg ok";
      st.textContent = "✅ Đã tạo ảnh thành công!";
      toast("Đã tạo ảnh thành công!", "success");
      if (res.mediaId) {
        resDiv.innerHTML = `<div style="font-size:12px; color:var(--green); margin-top:8px;">Media ID: <code>${res.mediaId}</code></div>`;
      }
    } else {
      st.className = "status-msg err";
      st.textContent = "❌ " + (res?.error || "Lỗi tạo ảnh");
      toast(res?.error || "Lỗi tạo ảnh", "error");
    }
  } catch (e) {
    st.className = "status-msg err";
    st.textContent = "❌ Lỗi: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🎨 Tạo Ảnh";
  }
}

// ── Batch Video Queue Engine ──
let batchQueue = [];
let isBatchRunning = false;
let isBatchPaused = false;

function parseBatchInput(text) {
  return text.split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map((line, idx) => {
      const parts = line.split("|").map(p => p.trim());
      if (parts.length === 1) {
        return { id: "task_" + Date.now() + "_" + idx, prompt: parts[0], startImage: null, endImage: null, status: "pending" };
      } else if (parts.length === 2) {
        if (parts[0].startsWith("http") || parts[0].startsWith("data:")) {
          return { id: "task_" + Date.now() + "_" + idx, prompt: parts[1], startImage: parts[0], endImage: null, status: "pending" };
        } else {
          return { id: "task_" + Date.now() + "_" + idx, prompt: parts[0], startImage: null, endImage: parts[1], status: "pending" };
        }
      } else {
        return { id: "task_" + Date.now() + "_" + idx, prompt: parts[1], startImage: parts[0], endImage: parts[2], status: "pending" };
      }
    });
}

function renderBatchList() {
  const list = document.getElementById("batchList");
  if (!list) return;
  if (!batchQueue.length) {
    list.innerHTML = `<div class="empty-state" style="padding:20px;"><div class="icon">⏳</div>Chưa có task nào trong hàng đợi.</div>`;
    return;
  }
  list.innerHTML = batchQueue.map((item, idx) => `
    <div class="queue-item ${item.status}">
      <div style="flex:1;">
        <div style="font-weight:600; font-size:12px; margin-bottom:2px;">#${idx+1}. ${item.prompt || "(Không có prompt)"}</div>
        <div style="font-size:10px; color:var(--text2);">
          ${item.startImage ? "🖼️ Có Start Image " : ""}${item.endImage ? "🏁 Có End Image" : ""}
        </div>
      </div>
      <div class="worker-tag" style="background:var(--surface2); color:var(--text2);">
        ${item.status === 'pending' ? '⏳ Chờ' : item.status === 'running' ? '🚀 Đang gửi' : item.status === 'success' ? '✅ Xong' : '❌ Lỗi'}
      </div>
    </div>
  `).join("");

  const doneCount = batchQueue.filter(t => t.status === "success").length;
  const total = batchQueue.length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const fill = document.getElementById("queueProgressFill");
  if (fill) fill.style.width = pct + "%";
  const statTotal = document.getElementById("statTotal");
  if (statTotal) statTotal.textContent = total;
  const statSuccess = document.getElementById("statSuccess");
  if (statSuccess) statSuccess.textContent = doneCount;
  const statFailed = document.getElementById("statFailed");
  if (statFailed) statFailed.textContent = batchQueue.filter(t => t.status === "error").length;
}

async function startBatchQueue() {
  if (isBatchRunning) return;
  const text = document.getElementById("batchInput").value.trim();
  const projectId = document.getElementById("batchProjectId").value.trim();
  const model = document.getElementById("batchModel").value;
  const aspectRatio = document.getElementById("batchAspectRatio").value;
  const concurrency = parseInt(document.getElementById("batchConcurrency").value || "2");
  const delay = parseInt(document.getElementById("batchDelay").value || "2000");

  if (!projectId) { toast("Thiếu Project ID!", "error"); return; }
  
  batchQueue = parseBatchInput(text);
  if (!batchQueue.length) { toast("Vui lòng nhập ít nhất 1 dòng prompt!", "error"); return; }

  isBatchRunning = true;
  isBatchPaused = false;
  document.getElementById("btnStartBatch").disabled = true;
  renderBatchList();
  toast(`Bắt đầu chạy ${batchQueue.length} task (${concurrency} luồng)...`, "info");

  let currentIndex = 0;
  async function worker(wId) {
    while (currentIndex < batchQueue.length) {
      if (isBatchPaused) { await new Promise(r => setTimeout(r, 500)); continue; }
      const item = batchQueue[currentIndex++];
      if (!item || item.status === "success") continue;

      item.status = "running";
      renderBatchList();

      try {
        const res = await callExt("CREATE_VIDEO", {
          prompt: item.prompt,
          projectId,
          model,
          aspectRatio,
          startImage: item.startImage,
          endImage: item.endImage
        });
        if (res?.success) item.status = "success";
        else item.status = "error";
      } catch (e) {
        item.status = "error";
      }

      renderBatchList();
      await new Promise(r => setTimeout(r, delay));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, batchQueue.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  isBatchRunning = false;
  document.getElementById("btnStartBatch").disabled = false;
  toast("🎉 Đã hoàn tất toàn bộ hàng đợi!", "success");
}

// ── Library Fetching ──
async function fetchVideos() {
  const projectId = document.getElementById("projectId")?.value || document.getElementById("batchProjectId")?.value;
  if (!projectId) return;
  const grid = document.getElementById("videoGrid");
  if (!grid) return;
  grid.innerHTML = `<div class="empty-state"><div class="spinner"></div> Đang tải danh sách video...</div>`;

  try {
    const res = await callExt("GET_PROJECT_VIDEOS", { projectId });
    if (res?.success && res.videos?.length) {
      grid.innerHTML = res.videos.map(v => `
        <div class="video-card">
          <div class="v-prompt">${v.prompt || "(Không có prompt)"}</div>
          <div class="v-tags">
            <span class="v-tag ${v.status === 'MEDIA_GENERATION_STATE_SUCCESS' ? 'done' : 'pending'}">
              ${v.status === 'MEDIA_GENERATION_STATE_SUCCESS' ? 'HOÀN THÀNH' : 'ĐANG RENDER'}
            </span>
          </div>
          <div class="v-actions">
            ${v.downloadUrl ? `<button class="btn btn-sm btn-green" onclick="window.open('${v.downloadUrl}', '_blank')">⬇ Tải Về</button>` : ''}
          </div>
        </div>
      `).join("");
    } else {
      grid.innerHTML = `<div class="empty-state"><div class="icon">🎬</div>Chưa có video nào trong Project này.</div>`;
    }
  } catch (e) {
    grid.innerHTML = `<div class="empty-state" style="color:var(--red);">Lỗi tải video: ${e.message}</div>`;
  }
}

// ── DOM Event Listeners Binding ──
document.addEventListener("DOMContentLoaded", () => {
  // Bind tabs
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Bind Top Header Buttons
  document.getElementById("btnOpenFullTab")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
  });

  // Bind Form Action Buttons
  document.getElementById("btnCreate")?.addEventListener("click", createVideo);
  document.getElementById("btnCreateImage")?.addEventListener("click", createImage);
  document.getElementById("btnStartBatch")?.addEventListener("click", startBatchQueue);
  document.getElementById("btnRefresh")?.addEventListener("click", fetchVideos);

  autoSyncProject();
  setInterval(autoSyncProject, 10000);
  toast("⚡ Flow Studio Pro v4.0 sẵn sàng!", "success");
});


// ══════════════════════════════════════
// STUDIO VIDEO DÀI TÀI CHÍNH (10-20 PHÚT - ẢNH + AUDIO TIMELINE)
// ══════════════════════════════════════
let currentFinanceScenes = [];
let isGeneratingImages = false;

// Danh mục các chủ đề triệu view tự động
const VIRAL_FINANCE_TOPICS = {
  financial_freedom: [
    "Nếu bạn hiểu điều này trước tuổi 35, cuộc đời bạn sẽ rất khác",
    "5 Chiếc bẫy chi tiêu khiến người làm công ăn lương nghèo bền vững",
    "Quy tắc 72 và bí mật lãi kép giúp người bình thường tạo ra tài sản lớn",
    "Tại sao kiếm nhiều tiền hơn không giúp bạn giàu lên nếu thiếu tư duy này",
    "Lối thoát duy nhất khỏi cuộc đua chuột (Rat Race) trong kỷ nguyên AI",
    "Cách người giàu bảo vệ tài sản và xây dựng cỗ máy kiếm tiền thụ động"
  ],
  life_philosophy: [
    "Khủng hoảng tuổi 30: Khi nhận ra mình chỉ đang tồn tại chứ không hề sống",
    "Nghịch lý của sự bận rộn: Càng chăm chỉ mù quáng, càng xa rời tự do",
    "3 Bài học đắt giá về đồng tiền mà trường học không bao giờ dạy bạn",
    "Sự cô đơn của người bứt phá: Tại sao bạn phải chấp nhận đi một mình",
    "Đừng chết ở tuổi 25 và chờ đến năm 75 tuổi mới được đem đi chôn"
  ],
  habits_discipline: [
    "Kỷ luật thép: 1 Giờ mỗi tối quyết định số phận 10 năm sau của bạn",
    "Hiệu ứng hòn tuyết lăn: Thói quen nhỏ tạo ra bước ngoặt tài chính khổng lồ",
    "Cách cai nghiện sự thoải mái tức thì để tập trung xây dựng tương lai",
    "Ngừng đổi thời gian lấy tiền: Hãy bắt đầu xây dựng đòn bẩy ngay hôm nay"
  ],
  business_startup: [
    "Bài học kinh doanh từ những người bắt đầu với 0 đồng vốn trong kỷ nguyên số",
    "Mô hình kinh doanh Solopreneur: 1 Người vận hành cỗ máy doanh thu tự động",
    "Tại sao 95% người khởi nghiệp thất bại và cách nằm trong 5% còn lại",
    "Giá trị vô hình: Biến kiến thức và kỹ năng của bạn thành tài sản số"
  ]
};

function getRandomViralTopic() {
  const pool = [];
  Object.values(VIRAL_FINANCE_TOPICS).forEach(arr => pool.push(...arr));
  return pool[Math.floor(Math.random() * pool.length)];
}

function handleRandomTopicClick() {
  const topic = getRandomViralTopic();
  const input = document.getElementById("finTopic");
  if (input) {
    input.value = topic;
    toast(`🎲 Đã chọn: "${topic.slice(0, 35)}..."`, "info");
  }
}

let savedEpisodes = [];
let stopGenerationRequested = false;

// 1. Tải danh sách các tập đã lưu từ bộ nhớ Chrome
async function loadSavedEpisodes() {
  try {
    const data = await chrome.storage.local.get("fin_saved_episodes");
    savedEpisodes = data.fin_saved_episodes || [];
    renderEpisodesDropdown();
    if (savedEpisodes.length > 0) {
      loadSelectedEpisode(savedEpisodes[0].id);
    }
  } catch (e) {
    console.error("Lỗi load episodes:", e);
  }
}

// 2. Render danh sách dropdown chọn tập
function renderEpisodesDropdown() {
  const sel = document.getElementById("finHistorySelect");
  if (!sel) return;
  
  if (!savedEpisodes.length) {
    sel.innerHTML = `<option value="">(Chưa có tập nào được lưu - Hãy tạo tập mới)</option>`;
    return;
  }

  sel.innerHTML = `<option value="">-- Chọn tập cũ (${savedEpisodes.length} tập đã lưu) --</option>` + 
    savedEpisodes.map((ep, idx) => `
      <option value="${ep.id}">Tập ${idx + 1}: ${ep.topic.slice(0, 30)}... (${ep.scenes.length} ảnh - ${new Date(ep.createdAt).toLocaleDateString("vi-VN")})</option>
    `).join("");
}

// 3. Tự động lưu tập hiện tại vào bộ nhớ
async function autoSaveCurrentEpisode(topic, scenes, fullVoice, minutes, style) {
  if (!scenes || !scenes.length) return;
  const epId = "ep_" + (topic.replace(/[^a-z0-9]/gi, "_").slice(0, 20) || Date.now());
  
  const existingIdx = savedEpisodes.findIndex(e => e.id === epId || e.topic === topic);
  const epData = {
    id: epId,
    topic,
    minutes,
    style,
    scenes,
    fullVoice,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  if (existingIdx >= 0) {
    savedEpisodes[existingIdx] = epData;
  } else {
    savedEpisodes.unshift(epData);
  }

  if (savedEpisodes.length > 50) savedEpisodes = savedEpisodes.slice(0, 50);

  await chrome.storage.local.set({ "fin_saved_episodes": savedEpisodes });
  renderEpisodesDropdown();
}

// 4. Mở lại một tập đã lưu trong quá khứ
function loadSelectedEpisode(epId) {
  if (!epId) return;
  const ep = savedEpisodes.find(e => e.id === epId);
  if (!ep) return;

  const topicInput = document.getElementById("finTopic");
  const durationSel = document.getElementById("finDurationSelect");
  const langSel = document.getElementById("finLangSelect");
  const fullVoiceText = document.getElementById("finFullVoiceText");
  const scriptBox = document.getElementById("finScriptBox");
  const scenesBox = document.getElementById("finScenesBox");
  const scenesList = document.getElementById("finScenesList");
  const badge = document.getElementById("finTotalDurationBadge");

  if (topicInput) topicInput.value = ep.topic;
  if (durationSel && ep.minutes) durationSel.value = ep.minutes;
  if (langSel && ep.lang) langSel.value = ep.lang;
  if (fullVoiceText) fullVoiceText.value = ep.fullVoice;
  if (scriptBox) scriptBox.style.display = "block";

  currentFinanceScenes = ep.scenes || [];

  if (scenesList) {
    scenesList.innerHTML = currentFinanceScenes.map((sc, idx) => renderSceneCardHTML(sc, idx)).join("");
    updateFinanceActionButtons();
  }

  if (badge) badge.textContent = `Tổng: ~${ep.minutes || 10} Phút (${currentFinanceScenes.length} Ảnh)`;
  if (scenesBox) scenesBox.style.display = "block";

  toast(`📂 Đã mở lại: "${ep.topic.slice(0, 30)}..."`, "info");
}

// 5. Reset để soạn tập mới
function startNewEpisode() {
  const topicInput = document.getElementById("finTopic");
  const scriptBox = document.getElementById("finScriptBox");
  const scenesBox = document.getElementById("finScenesBox");
  const historySelect = document.getElementById("finHistorySelect");

  if (topicInput) topicInput.value = "";
  if (scriptBox) scriptBox.style.display = "none";
  if (scenesBox) scenesBox.style.display = "none";
  if (historySelect) historySelect.value = "";
  currentFinanceScenes = [];
  toast("✨ Đã chuyển sang chế độ soạn tập mới!", "info");
}

// ── Character Consistency Functions with Local Storage Persistence ──
async function initCharacterConsistencyHandlers() {
  const btnBrowse = document.getElementById("btnBrowseCharFile");
  const fileInput = document.getElementById("finCharFile");
  const charInput = document.getElementById("finCharInput");
  const imgEl = document.getElementById("finCharImg");
  const noImgEl = document.getElementById("finCharNoImg");
  const previewBox = document.getElementById("finCharPreviewBox");
  const btnStyle = document.getElementById("btnStyleChar");
  const btnConfirm = document.getElementById("btnConfirmChar");
  const saveBadge = document.getElementById("finCharSaveBadge");

  // 1. Tải nhân vật đã lưu từ trước (Persistent across reloads)
  try {
    const stor = await chrome.storage.local.get(["fin_saved_character", "fin_saved_character_url"]);
    if (stor.fin_saved_character) {
      if (charInput) charInput.value = stor.fin_saved_character;
      const displaySrc = stor.fin_saved_character_url || stor.fin_saved_character;
      if (imgEl && noImgEl && displaySrc && (displaySrc.startsWith("http") || displaySrc.startsWith("data:"))) {
        imgEl.src = displaySrc;
        imgEl.style.display = "block";
        noImgEl.style.display = "none";
      }
      if (saveBadge) {
        saveBadge.textContent = "✅ Đã lưu mediaId trên Flow";
        saveBadge.style.color = "var(--green)";
        saveBadge.style.background = "var(--green-bg)";
      }
    }
  } catch (e) {
    console.error("Lỗi tải saved character:", e);
  }

  // 2. Chọn file ảnh từ máy
  if (btnBrowse && fileInput) {
    btnBrowse.addEventListener("click", () => fileInput.click());
    if (previewBox) previewBox.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        if (charInput) charInput.value = dataUrl;
        if (imgEl && noImgEl) {
          imgEl.src = dataUrl;
          imgEl.style.display = "block";
          noImgEl.style.display = "none";
        }
        if (saveBadge) {
          saveBadge.textContent = "⚠️ Chưa bấm xác nhận";
          saveBadge.style.color = "var(--yellow)";
          saveBadge.style.background = "var(--yellow-bg)";
        }
        toast("📁 Đã nạp ảnh nhân vật từ máy!", "info");
      };
      reader.readAsDataURL(file);
    });
  }

  // 3. Khi người dùng tự nhập / dán link ảnh
  if (charInput) {
    charInput.addEventListener("input", (e) => {
      const url = e.target.value.trim();
      if (url && imgEl && noImgEl) {
        imgEl.src = url;
        imgEl.style.display = "block";
        noImgEl.style.display = "none";
        if (saveBadge) {
          saveBadge.textContent = "⚠️ Chưa bấm xác nhận";
          saveBadge.style.color = "var(--yellow)";
          saveBadge.style.background = "var(--yellow-bg)";
        }
      } else if (imgEl && noImgEl) {
        imgEl.style.display = "none";
        noImgEl.style.display = "block";
        if (saveBadge) {
          saveBadge.textContent = "Chưa chọn nhân vật";
          saveBadge.style.color = "var(--text2)";
          saveBadge.style.background = "var(--bg)";
        }
      }
    });
  }

  // 4. NÚT 1: Chuyển đổi sang Style 2D Infographic
  if (btnStyle) {
    btnStyle.addEventListener("click", async () => {
      const inputImg = (document.getElementById("finCharInput")?.value || "").trim();
      if (!inputImg) {
        toast("Vui lòng chọn ảnh từ máy hoặc dán link trước!", "error");
        return;
      }

      let projectId = document.getElementById("finProjectId")?.value || "9eda0c71-c26d-4d90-b337-98499e68c69c";
      btnStyle.disabled = true;
      btnStyle.textContent = "⏳ Đang đẩy lên Flow & đổi sang 2D...";

      try {
        const charPrompt = "Clean 2D Flat Vector character portrait, financial educator persona, minimalist modern motion graphic animation style, 8k crisp avatar";
        
        const res = await callExt("CREATE_IMAGE", {
          prompt: charPrompt,
          projectId,
          model: "NARWHAL",
          aspectRatio: "IMAGE_ASPECT_RATIO_SQUARE",
          referenceImage: inputImg
        });

        if (res?.success && (res.mediaId || res.imageUrl)) {
          const storedValue = res.mediaId || res.imageUrl;
          if (charInput) charInput.value = storedValue;
          if (imgEl && noImgEl && res.imageUrl) {
            imgEl.src = res.imageUrl;
            imgEl.style.display = "block";
            noImgEl.style.display = "none";
          }
          // Tự động lưu mediaId/imageUrl của nhân vật mới tạo
          await chrome.storage.local.set({ 
            "fin_saved_character": storedValue,
            "fin_saved_character_url": res.imageUrl || storedValue
          });
          if (saveBadge) {
            saveBadge.textContent = "✅ Đã lưu mediaId trên Flow";
            saveBadge.style.color = "var(--green)";
            saveBadge.style.background = "var(--green-bg)";
          }
          toast("✨ Đã đẩy lên Flow & tạo mediaId thành công!", "success");
        } else {
          toast("Lỗi tạo style: " + (res?.error || "Không nhận được ảnh"), "error");
        }
      } catch (err) {
        toast("Lỗi: " + err.message, "error");
      } finally {
        btnStyle.disabled = false;
        btnStyle.textContent = "✨ 1. Đổi Sang Style Video (2D Infographic)";
      }
    });
  }

  // 5. NÚT 2: Xác nhận & Đẩy ảnh lên Google Flow lấy mediaId lưu vĩnh viễn
  if (btnConfirm) {
    btnConfirm.addEventListener("click", async () => {
      const finalImg = (document.getElementById("finCharInput")?.value || "").trim();
      if (!finalImg) {
        toast("Chưa có ảnh nhân vật để xác nhận!", "error");
        return;
      }

      let projectId = document.getElementById("finProjectId")?.value || "9eda0c71-c26d-4d90-b337-98499e68c69c";
      btnConfirm.disabled = true;
      btnConfirm.textContent = "⏳ Đang tải lên Google Flow...";

      try {
        let mediaIdToSave = finalImg;
        let previewUrl = finalImg;

        // Nếu là ảnh tải từ máy (Data URL base64) hoặc link HTTP, đẩy thẳng lên Flow lấy mediaId
        if (finalImg.startsWith("data:image") || finalImg.startsWith("http://") || finalImg.startsWith("https://")) {
          const upRes = await callExt("UPLOAD_IMAGE", {
            projectId,
            imageUrl: finalImg.startsWith("http") ? finalImg : null,
            imageBase64: finalImg.startsWith("data:") ? finalImg : null
          });

          if (upRes?.success && upRes.mediaId) {
            mediaIdToSave = upRes.mediaId;
            toast(`✅ Đã tải ảnh lên Flow thành công (mediaId: ${mediaIdToSave.slice(0, 18)}...)`, "info");
          }
        }

        if (charInput) charInput.value = mediaIdToSave;

        await chrome.storage.local.set({ 
          "fin_saved_character": mediaIdToSave,
          "fin_saved_character_url": previewUrl
        });

        if (saveBadge) {
          saveBadge.textContent = "✅ Đã lưu mediaId trên Flow";
          saveBadge.style.color = "var(--green)";
          saveBadge.style.background = "var(--green-bg)";
        }
        toast("💾 Đã lưu mediaId nhân vật trên Flow vĩnh viễn!", "success");
      } catch (err) {
        toast("Lỗi upload: " + err.message, "error");
      } finally {
        btnConfirm.disabled = false;
        btnConfirm.textContent = "💾 2. Xác Nhận & Lưu Nhân Vật Này";
      }
    });
  }
}

function initFinanceStudio() {
  const btnGen = document.getElementById("btnGenFinScript");
  const btnCopy = document.getElementById("btnCopyFinVoice");
  const btnGenAll = document.getElementById("btnGenAllFinVideos");
  const btnStop = document.getElementById("btnStopFinRender");
  const btnDownloadAll = document.getElementById("btnDownloadAllFinClips");
  const btnRandom = document.getElementById("btnRandomFinTopic");
  const btnNewEp = document.getElementById("btnNewEpisode");
  const historySelect = document.getElementById("finHistorySelect");

  if (btnRandom) btnRandom.addEventListener("click", handleRandomTopicClick);
  if (btnGen) btnGen.addEventListener("click", generateMultiBatchFinanceScript);
  if (btnCopy) btnCopy.addEventListener("click", copyFinanceVoiceScript);
  if (btnGenAll) btnGenAll.addEventListener("click", generateAllFinanceImages);
  if (btnStop) btnStop.addEventListener("click", () => {
    stopGenerationRequested = true;
    toast("🛑 Đã gửi lệnh dừng quá trình vẽ ảnh!", "error");
  });
  if (btnDownloadAll) btnDownloadAll.addEventListener("click", renderAndDownloadFullVideo);
  if (btnNewEp) btnNewEp.addEventListener("click", startNewEpisode);
  if (historySelect) historySelect.addEventListener("change", (e) => loadSelectedEpisode(e.target.value));

  // Delegated click handler for Scene Image View and Download buttons (MV3 CSP Compliant)
  const scenesList = document.getElementById("finScenesList");
  if (scenesList) {
    scenesList.addEventListener("click", async (e) => {
      const btnDl = e.target.closest(".btn-download-scene-img");
      const imgView = e.target.closest(".btn-view-scene-img");

      if (btnDl) {
        const idx = parseInt(btnDl.dataset.idx);
        const sc = currentFinanceScenes[idx];
        if (!sc || !sc.imageUrl) {
          toast("Ảnh chưa sẵn sàng để tải!", "error");
          return;
        }
        btnDl.textContent = "⏳ Đang tải...";
        try {
          // Download directly using anchor or chrome downloads
          const a = document.createElement("a");
          a.href = sc.imageUrl;
          a.download = `Canh_${sc.sceneIndex}_${sc.title.slice(0, 15)}.png`;
          a.target = "_blank";
          document.body.appendChild(a);
          a.click();
          setTimeout(() => document.body.removeChild(a), 1500);
          toast(`⬇️ Đã gửi lệnh tải ảnh Cảnh #${sc.sceneIndex}!`, "success");
        } catch (err) {
          toast("Lỗi tải ảnh: " + err.message, "error");
        } finally {
          btnDl.textContent = "⬇️ Tải Ảnh Về Máy";
        }
      }

      if (imgView) {
        const idx = parseInt(imgView.dataset.idx);
        const sc = currentFinanceScenes[idx];
        if (sc && sc.imageUrl) {
          chrome.tabs.create({ url: sc.imageUrl });
        }
      }
    });
  }

  // Lắng nghe thay đổi Số Phút & Số Ảnh để cập nhật tính toán nhịp thời gian trực tiếp
  const durationInput = document.getElementById("finDurationMinutes");
  const imgCountInput = document.getElementById("finImageCountInput");
  const calcHint = document.getElementById("finCalcHint");
  const geminiKeyInput = document.getElementById("finGeminiApiKey");

  // Load saved Gemini API Key
  chrome.storage.local.get(["fin_gemini_api_key"], (r) => {
    if (r?.fin_gemini_api_key && geminiKeyInput) {
      geminiKeyInput.value = r.fin_gemini_api_key;
    }
  });

  if (geminiKeyInput) {
    geminiKeyInput.addEventListener("input", (e) => {
      chrome.storage.local.set({ "fin_gemini_api_key": e.target.value.trim() });
    });
  }

  function updateCalcHint() {
    const mins = Math.max(1, parseInt(durationInput?.value || "10"));
    const imgs = Math.max(1, parseInt(imgCountInput?.value || "40"));
    const totalSec = mins * 60;
    const avgSec = (totalSec / imgs).toFixed(1);
    if (calcHint) {
      calcHint.innerHTML = `<span>📊 <b>Tính toán nhịp:</b> Trung bình <b>${avgSec}s / 1 ảnh</b> (${imgs} ảnh cho video ${mins} phút)</span><span style="font-size:10px; color:var(--text3);">1 câu có thể minh họa bằng nhiều ảnh đổi góc quay</span>`;
    }
  }

  if (durationInput) durationInput.addEventListener("input", updateCalcHint);
  if (imgCountInput) imgCountInput.addEventListener("input", updateCalcHint);

  initCharacterConsistencyHandlers();
  loadSavedEpisodes();
  loadAIDancingVoices();
}

// Tự động tải toàn bộ 50+ Giọng đọc chính thức từ AIDancing
async function loadAIDancingVoices() {
  const select = document.getElementById("finTtsVoiceSelect");
  if (!select) return;

  try {
    const res = await callExt("GET_TTS_VOICES", { lang: "vi" });
    if (res?.success && Array.isArray(res.voices) && res.voices.length > 0) {
      select.innerHTML = res.voices.map((v, i) => {
        const isSelected = i === 0 ? "selected" : "";
        return `<option value="${v.voiceIndex}" ${isSelected}>🎙️ [${v.voiceIndex + 1}] ${v.name}</option>`;
      }).join("");
      console.log(`✅ Đã tải thành công ${res.voices.length} giọng đọc từ AIDancing!`);
    }
  } catch (e) {
    console.warn("Lỗi tải giọng AIDancing:", e);
  }
}

// 1. Phân Đợt Sinh Kịch Bản Dài (Multi-Batch Generation with % Progress Bar)
async function generateMultiBatchFinanceScript() {
  let topic = (document.getElementById("finTopic")?.value || "").trim();
  const cat = document.getElementById("finCategorySelect")?.value || "all";
  
  // Nếu người dùng không nhập gì, tự động chọn 1 chủ đề triệu view!
  if (!topic) {
    topic = getRandomViralTopic(cat);
    const input = document.getElementById("finTopic");
    if (input) input.value = topic;
    toast(`✨ AI tự động chọn chủ đề: "${topic.slice(0, 35)}..."`, "info");
  }

  const minutes = Math.max(1, parseInt(document.getElementById("finDurationMinutes")?.value || "10"));
  const totalScenes = Math.max(1, parseInt(document.getElementById("finImageCountInput")?.value || String(minutes * 4)));
  const lang = document.getElementById("finLangSelect")?.value || "vi";
  
  const st = document.getElementById("finGenStatus");
  const progressBox = document.getElementById("finScriptProgressContainer");
  const progressText = document.getElementById("finScriptProgressText");
  const progressPct = document.getElementById("finScriptProgressPct");
  const progressFill = document.getElementById("finScriptProgressFill");
  
  const scriptBox = document.getElementById("finScriptBox");
  const scenesBox = document.getElementById("finScenesBox");
  const fullVoiceText = document.getElementById("finFullVoiceText");
  const scenesList = document.getElementById("finScenesList");
  const badge = document.getElementById("finTotalDurationBadge");

  const batchCount = 4; // Chia làm 4 đợt sinh kịch bản

  st.style.display = "block";
  st.className = "status-msg loading";
  st.textContent = `🧠 Đang tự động phát triển kịch bản (${lang === 'en' ? 'English' : 'Tiếng Việt'}) cho chủ đề: "${topic}" (${minutes} phút, ${totalScenes} Cảnh/Ảnh)...`;
  
  progressBox.style.display = "block";
  progressFill.style.width = "5%";
  progressPct.textContent = "5%";
  progressText.textContent = "Đang khởi tạo cấu trúc kịch bản...";

  // BẮT BUỘC DÙNG GEMINI AI 100% (KHÔNG DÙNG MẪU NỘI TẠI)
  const geminiApiKey = (document.getElementById("finGeminiApiKey")?.value || "").trim();
  if (!geminiApiKey) {
    st.className = "status-msg error";
    st.innerHTML = `⚠️ <b>Chưa nhập Gemini API Key!</b> Vui lòng lấy mã miễn phí tại <a href="https://aistudio.google.com/apikey" target="_blank" style="color:var(--accent2); text-decoration:underline;">Google AI Studio</a> và dán vào ô <b>"✨ GEMINI API KEY"</b> ở trên.`;
    progressBox.style.display = "none";
    toast("Vui lòng nhập Gemini API Key để AI viết kịch bản!", "error");
    return;
  }

  try {
    progressText.textContent = `Đang gửi prompt đến Google Gemini AI (${minutes} phút, ${totalScenes} ảnh, nhịp ${Math.round((minutes*60)/totalScenes)}s/ảnh)...`;
    progressFill.style.width = "40%";
    progressPct.textContent = "40%";

    const aiRes = await callExt("GENERATE_AI_SCRIPT", {
      topic,
      totalScenes,
      totalMinutes: minutes,
      lang,
      geminiApiKey
    });

    if (aiRes?.success && Array.isArray(aiRes.scenes) && aiRes.scenes.length > 0) {
      aiSourceUsed = aiRes.source || "gemini_api_direct";
      const charInputVal = (document.getElementById("finCharInput")?.value || "").trim();
      const charDirective = charInputVal ? ", featuring the consistent main character persona, same face and clothing from reference image" : "";
      const fixedStyle = "2D Flat Vector Infographic, Clean Financial Education Animation, Minimalist Modern Motion Graphic, Bold Colors, 8k crisp";
      const isEn = lang === "en";
      const textDirective = isEn 
        ? "Clean English financial labels, english typography on infographic charts, NO Vietnamese text" 
        : "Infographic đồ họa tài chính có phụ đề nhãn chữ tiếng Việt sắc nét, Vietnamese text typography on charts, NO foreign text";

      const avgSec = Math.max(3, Math.round(((minutes * 60) / totalScenes) * 10) / 10);
      const durationPerScene = Math.round(avgSec);

      const parsedScenes = aiRes.scenes.map((s, idx) => {
        const wordCount = (s.voiceText || "").split(/\s+/).filter(Boolean).length;
        const speechSec = Math.max(1, Math.round(wordCount / 2.4));
        const finalPrompt = `${s.imagePrompt || ''}${charDirective}, theme of ${topic}, style of ${fixedStyle}, ${textDirective}, 8k wallpaper aspect 16:9, masterpiece educational infographic`;
        return {
          sceneIndex: idx + 1,
          title: s.title || `Cảnh #${idx + 1}`,
          durationSec: durationPerScene,
          speechSec: speechSec,
          wordCount: wordCount,
          voiceText: s.voiceText || "",
          imagePrompt: finalPrompt,
          status: "pending",
          imageUrl: null
        };
      });

      const parsedVoices = parsedScenes.map(sc => `[Cảnh ${sc.sceneIndex} | Hiện ${sc.durationSec}s | Đọc ${sc.speechSec}s]: "${sc.voiceText}"`);
      generatedFlow = { scenes: parsedScenes, voices: parsedVoices };
    } else {
      aiResError = aiRes?.error || "Không nhận được phản hồi từ Gemini AI";
    }
  } catch (err) {
    aiResError = err.message;
  }

  // Nếu Gemini AI báo lỗi, hiển thị lỗi trực tiếp và KHÔNG dùng mẫu cũ
  if (!generatedFlow || !generatedFlow.scenes.length) {
    st.className = "status-msg error";
    st.innerHTML = `❌ <b>Lỗi gọi Gemini AI:</b> ${aiResError || "Vui lòng kiểm tra lại API Key hoặc kết nối mạng."}`;
    progressBox.style.display = "none";
    toast("Lỗi gọi Gemini AI: " + (aiResError || "Thất bại"), "error");
    return;
  }

  currentFinanceScenes = generatedFlow.scenes;
  generatedVoiceList = generatedFlow.voices;

  const fullVoiceString = generatedVoiceList.join("\n\n");

  // Hiển thị Voice Script tổng
  if (fullVoiceText) fullVoiceText.value = fullVoiceString;
  if (scriptBox) scriptBox.style.display = "block";

  // Auto save episode to storage
  await autoSaveCurrentEpisode(topic, currentFinanceScenes, fullVoiceString, minutes, lang);

  // Render danh sách Scenes kèm thời gian hiển thị (Duration 10s - 20s/ảnh)
  if (scenesList) {
    scenesList.innerHTML = currentFinanceScenes.map((sc, idx) => renderSceneCardHTML(sc, idx)).join("");
    updateFinanceActionButtons();
  }

  // Hoàn tất Progress Bar lên 100% và ẩn mượt mà
  progressFill.style.width = "100%";
  progressPct.textContent = "100%";
  progressText.textContent = "🎉 Gemini AI đã hoàn tất kịch bản!";
  setTimeout(() => {
    if (progressBox) progressBox.style.display = "none";
  }, 1000);

  const actualTotalSec = currentFinanceScenes.reduce((acc, s) => acc + (s.durationSec || 0), 0);
  const actualMinutes = (actualTotalSec / 60).toFixed(1);
  const avgSec = (actualTotalSec / currentFinanceScenes.length).toFixed(1);

  if (badge) badge.textContent = `Tổng: ~${actualMinutes} Phút (${totalScenes} Ảnh | ~${avgSec}s/ảnh)`;
  if (scenesBox) scenesBox.style.display = "block";

  st.className = "status-msg ok";
  st.textContent = `✨ [Google Gemini AI] Đã sáng tạo xong 100% kịch bản & prompt độc nhất (${minutes} phút, ${totalScenes} Cảnh)!`;
  toast(`✨ Gemini AI đã tạo kịch bản mới 100%!`, "success");
}

// 2. Thuật Toán Sinh Storyline Triết Lý & Tài Chính Dài (Phong Cách Góc Nhìn Tài Chính)
// 2. Thuật Toán Sinh Storyline Chuẩn Tốc Độ Nói: Lời Thoại Nói Đúng = (Thời lượng - 1s)
function buildLongFinanceStoryline(topic, startIndex, count, total, style) {
  const storyChapters = [
    {
      title: "Chương 1: Chiếc Bẫy Cơm Áo Gạo Tiền",
      concepts: [
        {
          core: "Có một sự thật cay đắng mà phần lớn chúng ta chỉ nhận ra khi đã bước qua tuổi 30, đó là chúng ta đang dùng gần như toàn bộ sức lực của mình chỉ để DUY TRÌ cuộc sống hiện tại.",
          expand: "Mỗi sáng thức dậy, vội vã lao vào dòng xe cộ đông đúc để đến nơi làm việc, cống hiến 8 đến 10 tiếng mỗi ngày, rồi trở về nhà trong trạng thái cạn kiệt năng lượng. Chúng ta kiếm tiền để chi trả tiền nhà, tiền ăn uống, tiền hóa đơn, rồi lại tiếp tục đi làm để có tiền trang trải cho tháng tiếp theo.",
          reflect: "Nhìn bề ngoài, bạn có vẻ rất chăm chỉ và trách nhiệm, nhưng nếu nhìn sâu vào bức tranh 5 năm qua, bạn sẽ thấy mình hầu như không hề XÂY DỰNG được bất kỳ nền tảng tài sản vững chắc nào cho tương lai của chính mình.",
          prompt: "A stressed office worker sitting alone in a dim cubicle at late night with glowing computer screen, moody cinematic shadows, 8k flat vector art"
        },
        {
          core: "Nghịch lý lớn nhất của những người làm công ăn lương là chiếc bẫy tiêu tiền để giải tỏa cảm xúc sau chuỗi ngày áp lực.",
          expand: "Sau những ngày làm việc căng thẳng và chịu đựng mệt mỏi, chúng ta thường tự thưởng cho mình những bữa ăn đắt đỏ, những món đồ mới hay những chuyến đi ngắn ngày với suy nghĩ rằng mình xứng đáng được bù đắp.",
          reflect: "Nhưng cảm giác thỏa mãn đó chỉ kéo dài trong vài giờ ngắn ngủi, để rồi khi số dư tài khoản báo về, bạn lại rơi vào nỗi lo âu vô hình và buộc phải tiếp tục quay cuồng trong guồng quay công việc không hồi kết.",
          prompt: "A silhouette of a man walking on a giant spinning hamster wheel made of gold coins and calendar dates, dark atmosphere, surreal symbolic art"
        },
        {
          core: "Sự bận rộn mù quáng là kẻ thù số một của sự tự do tài chính và sự phát triển bản thân.",
          expand: "Có rất nhiều người bận rộn từ sáng sớm đến đêm muộn nhưng tài chính vẫn dậm chân tại chỗ qua từng năm tháng, bởi vì họ chỉ đang giải quyết những việc khẩn cấp của người khác thay vì tập trung vào những việc quan trọng của cuộc đời mình.",
          reflect: "Nếu bạn không chủ động dành thời gian để xây dựng ước mơ của chính mình, người khác sẽ thuê bạn với mức giá rẻ mạt để xây dựng ước mơ cho họ suốt phần đời còn lại.",
          prompt: "Top down view of an empty luxury wallet with falling receipts on a wet dark wooden table, dramatic low-key lighting"
        },
        {
          core: "Đừng bao giờ để sự an toàn giả tạo của một mức lương cố định kìm hãm tiềm năng vô hạn của bạn.",
          expand: "Lương hàng tháng giống như một liều thuốc giảm đau, nó đủ để xoa dịu những lo toan tức thời nhưng lại từ từ giết chết khát vọng bứt phá và khả năng thích nghi trước những biến động lớn của nền kinh tế.",
          reflect: "Khi bạn dám bước ra khỏi vùng an toàn và bắt đầu tìm kiếm những nguồn thu nhập mới, bạn mới nhận ra thế giới bên ngoài có vô vàn cơ hội đang chờ đón người có sự chuẩn bị.",
          prompt: "A person standing frozen in the middle of a fast-moving blurred crowd in a dark modern subway station, slow shutter speed concept"
        }
      ]
    },
    {
      title: "Chương 2: Sự Khác Biệt Giữa Tiền Lương & Đòn Bẩy",
      concepts: [
        {
          core: "Sự khác biệt lớn nhất giữa người bình thường và những người đạt được tự do tài chính không nằm ở số giờ làm việc, mà nằm ở việc sở hữu ĐÒN BẨY.",
          expand: "Nếu thu nhập của bạn chỉ phụ thuộc vào thời gian và sức lao động trực tiếp, bạn sẽ có một mức trần thu nhập không thể vượt qua, bởi vì một ngày ai cũng chỉ có 24 giờ như nhau. Người giàu hiểu rằng họ phải xây dựng những hệ thống có thể vận hành và tạo ra doanh thu ngay cả khi họ đang ngủ.",
          reflect: "Trong thời đại công nghệ số ngày nay, đòn bẩy không còn là đặc quyền của giới siêu giàu; nó chính là các đoạn mã phần mềm, các nội dung số truyền thông, các kênh phân phối tự động và các kỹ năng chuyên sâu không thể thay thế.",
          prompt: "An old mechanical brass balance scale comparing a pocket watch with a golden seed sprouting into a money tree, dark moody background"
        },
        {
          core: "Một dòng code hay một sản phẩm số có thể phục vụ hàng triệu người trên toàn cầu mà không tốn thêm chi phí sản xuất.",
          expand: "Đó chính là vẻ đẹp của kỷ nguyên kinh tế số: Khi bạn tạo ra một sản phẩm giá trị một lần, bạn có thể phân phối nó vô số lần đến với khách hàng ở khắp mọi nơi mà không bị giới hạn bởi không gian hay thời gian.",
          reflect: "Khi thu nhập của bạn không còn bị trói buộc bởi số giờ làm việc hành chính mỗi ngày, đó là lúc cánh cửa dẫn đến sự tự do thực sự bắt đầu mở ra trước mắt bạn.",
          prompt: "A young creator operating multiple glowing holographic floating screens with charts, matrix code and digital assets, cyber dark aesthetic"
        },
        {
          core: "Hãy chuyển đổi tư duy từ người tiêu thụ nội dung thành người sáng tạo và sở hữu tài sản giá trị.",
          expand: "Mỗi ngày chúng ta dành hàng giờ lướt mạng xã hội, xem video của người khác và làm giàu cho các nền tảng công nghệ, trong khi chúng ta hoàn toàn có thể dùng chính chiếc máy tính đó để xây dựng kênh thông tin, viết phần mềm hay chia sẻ kiến thức hữu ích.",
          reflect: "Sự thay đổi nhỏ trong cách sử dụng thời gian rảnh mỗi ngày sẽ tạo nên một khoảng cách không thể san lấp giữa bạn và những người chỉ biết thụ động tiếp nhận thông tin.",
          prompt: "A serene futuristic bedroom with glowing digital network connections flowing through the window into the glowing night sky"
        },
        {
          core: "Đừng bao giờ đánh giá thấp sức mạnh của việc tích lũy các tài sản tạo ra dòng tiền thụ động dài hạn.",
          expand: "Dòng tiền giống như dòng máu nuôi dưỡng sự độc lập tài chính; khi bạn có các nguồn thu nhập phụ đủ để trang trải các chi phí cơ bản, bạn sẽ không bao giờ phải đưa ra những quyết định tuyệt vọng vì áp lực tiền bạc.",
          reflect: "Sự thanh thản trong tâm trí và quyền tự do lựa chọn chính là tài sản quý giá nhất mà không có bất kỳ món đồ xa xỉ nào có thể so sánh được.",
          prompt: "A glowing golden door slowly opening in a dark stone corridor leading to a radiant sunrise over endless horizons"
        }
      ]
    },
    {
      title: "Chương 3: Chiến Lược Tích Lũy & Tự Do Trước Tuổi 35",
      concepts: [
        {
          core: "Hiệu ứng lãi kép không chỉ áp dụng cho tiền bạc, mà nó áp dụng cho tất cả những thói quen và kiến thức bạn tích lũy hàng ngày.",
          expand: "Một thói quen kỷ luật nhỏ, một kiến thức mới nạp vào đầu mỗi ngày có vẻ không tạo ra sự khác biệt ngay lập tức, nhưng khi được nhân lên theo cấp số nhân qua một nghìn ngày, nó sẽ tạo ra một bước nhảy vọt khổng lồ trong sự nghiệp và tài chính.",
          reflect: "Hãy nhớ rằng thành công bền vững là một cuộc chạy marathon đường dài, không phải là trò may rủi chớp nhoáng; người kiên định xây dựng hệ thống từng bước một sẽ luôn là người chiến thắng sau cùng.",
          prompt: "Extreme macro close-up of a small glowing gold coin dropping into clear water creating beautiful concentric ripple waves"
        },
        {
          core: "Dành ra 2 tiếng mỗi tối sau giờ làm để xây dựng cỗ máy thu nhập thứ hai thay vì lãng phí vào những thú vui vô bổ.",
          expand: "Khoảng thời gian từ 8 giờ tối đến 10 giờ đêm chính là chiếc chìa khóa định hình tương lai của bạn; người thành công sử dụng thời gian này để nâng cấp kỹ năng, nghiên cứu thị trường và triển khai các dự án tiềm năng.",
          reflect: "Chỉ cần 1 đến 2 năm tập trung cao độ, bạn sẽ xây dựng được một nền tảng vững chắc giúp bạn hoàn toàn chủ động trước mọi biến động trong cuộc sống.",
          prompt: "A minimalist desk with an open laptop, a cup of coffee, and warm desk lamp lighting in a dark cozy room, late night focus"
        },
        {
          core: "Tự do tài chính đích thực là quyền được nói KHÔNG với những điều bạn không thích và toàn quyền làm chủ số phận của mình.",
          expand: "Đó là khi bạn có đủ khoản dự phòng tài chính để tự tin từ chối một công việc độc hại, một môi trường làm việc tiêu cực mà không phải lo sợ về cơm áo gạo tiền ngày mai.",
          reflect: "Khi bạn không còn bị đồng tiền trói buộc hay điều khiển mọi quyết định, bạn mới thực sự được sống một cuộc đời trọn vẹn, tự do theo đuổi những giá trị ý nghĩa nhất của bản thân.",
          prompt: "A free person standing on the cliff edge gazing at majestic sunrise over ocean mountains, atmospheric inspiring cinematic"
        }
      ]
    }
  ];

  let scenes = [];
  let voices = [];

  for (let i = 0; i < count; i++) {
    const globalIdx = startIndex + i;
    const chapterIdx = Math.floor((globalIdx / total) * storyChapters.length) % storyChapters.length;
    const chapter = storyChapters[chapterIdx];
    const concept = chapter.concepts[i % chapter.concepts.length];

    // Thời lượng ảnh hiển thị (từ 12s đến 18s)
    const duration = Math.floor(12 + (globalIdx % 7)); // 12s -> 18s
    
    // Quy tắc: Thời gian đọc = (Thời lượng - 1s)
    const targetSpeechSec = duration - 1; // Ví dụ: 15s - 1s = 14s đọc
    const wordsNeeded = Math.round(targetSpeechSec * 2.6); // Chuẩn 2.6 từ / giây tiếng Việt
    
    // Tạo lời thoại theo từng câu trọn vẹn (không cắt ngang xương từ)
    let selectedSentences = [];
    let currentWords = 0;
    
    // Ghép câu hoàn chỉnh (core -> expand -> reflect) cho đến khi đạt thời lượng
    const sentencePool = [concept.core, concept.expand, concept.reflect];
    for (const sent of sentencePool) {
      if (!sent) continue;
      const sentWordCount = sent.split(/\s+/).filter(Boolean).length;
      if (selectedSentences.length === 0 || currentWords + (sentWordCount * 0.7) <= wordsNeeded + 4) {
        selectedSentences.push(sent.trim());
        currentWords += sentWordCount;
      }
      if (currentWords >= wordsNeeded - 3) break;
    }

    const voiceFinal = selectedSentences.join(" ");
    const actualWords = voiceFinal.split(/\s+/).filter(Boolean).length;
    const actualSpeechSec = Math.round(actualWords / 2.6);

    const promptFinal = `${concept.prompt}, style of ${style}, ultra detailed, masterpiece, 16:9 wallpaper aspect`;

    scenes.push({
      sceneIndex: globalIdx + 1,
      title: chapter.title,
      durationSec: duration,
      speechSec: actualSpeechSec,
      wordCount: actualWords,
      voiceText: voiceFinal,
      imagePrompt: promptFinal,
      status: "pending",
      imageUrl: null
    });

    voices.push(`[Ảnh ${globalIdx + 1} - Hiện ${duration}s (Đọc ${actualSpeechSec}s / ~${actualWords} từ)]:\n"${voiceFinal}"`);
  }

  return { scenes, voices };
}

// 3. Copy Toàn Bộ Voice Script Sang Clipboard
function copyFinanceVoiceScript() {
  const fullText = document.getElementById("finFullVoiceText");
  if (!fullText || !fullText.value) return;
  navigator.clipboard.writeText(fullText.value).then(() => {
    toast("📋 Đã copy toàn bộ Script Âm thanh! Hãy dán sang ElevenLabs/Vbee/CapCut để xuất audio .mp3.", "success");
  });
}

// 4. 1-Click Tự Động Vẽ Toàn Bộ Ảnh Hàng Loạt (Nano Banana 2 / Imagen)
async function generateAllFinanceImages() {
  if (isGeneratingImages) return;
  const btn = document.getElementById("btnGenAllFinVideos");
  const btnDl = document.getElementById("btnDownloadAllFinClips");
  const st = document.getElementById("finRunStatus");
  const progressBox = document.getElementById("finRenderProgressContainer");
  const progressText = document.getElementById("finRenderProgressText");
  const progressPct = document.getElementById("finRenderProgressPct");
  const progressFill = document.getElementById("finRenderProgressFill");

  // Tự động tìm projectId từ URL tab Google Flow hoặc Storage nếu chưa có
  let projectId = document.getElementById("projectId")?.value || document.getElementById("batchProjectId")?.value || document.getElementById("finProjectId")?.value;
  
  if (!projectId) {
    try {
      const tabs = await chrome.tabs.query({ url: "https://labs.google/*" });
      if (tabs.length && tabs[0].url) {
        const m = tabs[0].url.match(/project\/([a-f0-9\-]{36})/i);
        if (m && m[1]) projectId = m[1];
      }
    } catch (_) {}
  }

  if (!projectId) {
    const stor = await chrome.storage.local.get("lastProjectId");
    projectId = stor.lastProjectId || "9eda0c71-c26d-4d90-b337-98499e68c69c";
  }

  const model = document.getElementById("finImageModel")?.value || "NARWHAL";

  if (!currentFinanceScenes || !currentFinanceScenes.length) { toast("Vui lòng sinh kịch bản trước!", "error"); return; }

  stopGenerationRequested = false;
  isGeneratingImages = true;
  btn.disabled = true;
  btn.textContent = "⏳ Đang tự động vẽ hàng loạt ảnh...";
  const btnStop = document.getElementById("btnStopFinRender");
  if (btnStop) btnStop.style.display = "inline-flex";

  st.style.display = "block";
  st.className = "status-msg loading";
  st.textContent = `🎨 Đang kết nối Nano Banana 2 vẽ ${currentFinanceScenes.length} ảnh chất lượng cao...`;
  
  progressBox.style.display = "block";

  let successCount = 0;
  for (let i = 0; i < currentFinanceScenes.length; i++) {
    if (stopGenerationRequested) {
      toast("🛑 Đã tạm dừng vẽ ảnh theo yêu cầu!", "info");
      break;
    }

    const sc = currentFinanceScenes[i];
    // Skip if already done
    if (sc.status === "done") {
      successCount++;
      continue;
    }

    const pct = Math.round(((i + 1) / currentFinanceScenes.length) * 100);
    progressText.textContent = `Đang vẽ ảnh #${sc.sceneIndex}/${currentFinanceScenes.length}...`;
    progressFill.style.width = pct + "%";
    progressPct.textContent = pct + "%";

    const stateEl = document.getElementById(`finSceneState_${i}`);
    if (stateEl) {
      stateEl.style.color = "var(--blue)";
      stateEl.textContent = "🎨 Đang vẽ ảnh...";
    }

    try {
      const activeModel = document.getElementById("finImageModel")?.value || "NARWHAL";
      const charRefImg = (document.getElementById("finCharInput")?.value || "").trim() || null;
      const lang = document.getElementById("finLangSelect")?.value || "vi";
      const voiceIdx = document.getElementById("finTtsVoiceSelect")?.value || 0;

      // 1. Tạo Ảnh và Sinh Audio Giọng Đọc Song Song
      const imgPromise = callExt("CREATE_IMAGE", {
        prompt: sc.imagePrompt,
        projectId,
        model: activeModel,
        aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
        referenceImage: charRefImg
      });

      // Nếu chưa có audio cho cảnh này, tạo audio luôn
      const ttsPromise = (!sc.audioUrl && sc.voiceText) ? callExt("GENERATE_TTS", {
        text: sc.voiceText,
        lang: lang,
        voiceIndex: voiceIdx
      }) : Promise.resolve({ success: true, audioUrl: sc.audioUrl });

      const [imgRes, ttsRes] = await Promise.allSettled([imgPromise, ttsPromise]);
      const res = imgRes.status === "fulfilled" ? imgRes.value : null;
      const tts = ttsRes.status === "fulfilled" ? ttsRes.value : null;

      if (tts?.success && tts.audioUrl) {
        sc.audioUrl = tts.audioUrl;
      }

      if (res?.success) {
        successCount++;
        sc.status = "done";
        sc.imageUrl = res.imageUrl || null;
        if (stateEl) {
          stateEl.style.color = "var(--green)";
          stateEl.textContent = sc.audioUrl ? "✅ Đã vẽ xong ảnh & có Audio giọng đọc!" : "✅ Đã vẽ xong!";
        }
        const prevBox = document.getElementById(`finScenePreview_${i}`);
        const prevImg = document.getElementById(`finSceneImg_${i}`);
        if (prevBox && sc.imageUrl) {
          if (prevImg) prevImg.src = sc.imageUrl;
          prevBox.style.display = "flex";
        }
        updateFinanceActionButtons();
      } else {
        sc.status = "error";
        if (stateEl) {
          stateEl.style.color = "var(--red)";
          stateEl.textContent = "❌ " + (res?.error || "Lỗi vẽ ảnh");
        }
      }
      // Nghỉ 1s giữa các ảnh (Nano Banana 2 vẽ siêu nhanh)
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      if (stateEl) {
        stateEl.style.color = "var(--red)";
        stateEl.textContent = "❌ " + e.message;
      }
    }
  }

  isGeneratingImages = false;
  btn.disabled = false;
  btn.textContent = "🔄 Bấm để Vẽ tiếp các ảnh chưa vẽ/lỗi";
  if (btnStop) btnStop.style.display = "none";
  if (btnDl) btnDl.style.display = "inline-flex";

  // Cập nhật lại tập trong bộ nhớ
  const topic = (document.getElementById("finTopic")?.value || "").trim();
  const minutes = parseInt(document.getElementById("finDurationSelect")?.value || "10");
  const style = document.getElementById("finStyleSelect")?.value || "";
  const fullVoice = document.getElementById("finFullVoiceText")?.value || "";
  await autoSaveCurrentEpisode(topic, currentFinanceScenes, fullVoice, minutes, style);

  if (stopGenerationRequested) {
    st.className = "status-msg";
    st.textContent = `🛑 Đã dừng lại. Hiện có ${successCount}/${currentFinanceScenes.length} ảnh đã hoàn thành. Bạn có thể bấm "Vẽ tiếp" bất kỳ lúc nào.`;
  } else {
    st.className = "status-msg ok";
    st.textContent = `🎉 Đã hoàn tất vẽ ${successCount}/${currentFinanceScenes.length} ảnh! Đã lưu tập vào lịch sử.`;
    toast(`Đã vẽ xong ${successCount} ảnh!`, "success");
  }
}

// 5. TRÌNH GHÉP VIDEO TỰ ĐỘNG (CANVAS 1080P + MEDIARECORDER EXPORT .MP4/WEBM)
// 5. TRÌNH GHÉP VIDEO TỰ ĐỘNG (CANVAS 1080P + WEB AUDIO API SYNC + MEDIARECORDER)
async function renderAndDownloadFullVideo() {
  const st = document.getElementById("finRunStatus");
  const btnDl = document.getElementById("btnDownloadAllFinClips");
  const progressBox = document.getElementById("finRenderProgressContainer");
  const progressText = document.getElementById("finRenderProgressText");
  const progressPct = document.getElementById("finRenderProgressPct");
  const progressFill = document.getElementById("finRenderProgressFill");

  if (!currentFinanceScenes || !currentFinanceScenes.length) {
    toast("Vui lòng tạo kịch bản trước khi ghép video!", "error");
    return;
  }

  st.style.display = "block";
  st.className = "status-msg loading";
  st.textContent = "🎬 Đang khởi tạo Render Engine 1080p và chuẩn bị các cảnh...";
  if (progressBox) progressBox.style.display = "block";
  btnDl.disabled = true;
  btnDl.textContent = "⏳ Đang render video...";

  try {
    const totalScenes = currentFinanceScenes.length;
    const canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d");

    // Setup AudioContext
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextClass();
    const audioDest = audioCtx.createMediaStreamDestination();

    // 1. Tải trước tài nguyên ảnh & audio của toàn bộ các cảnh
    st.textContent = "📥 Đang tải tài nguyên hình ảnh và âm thanh của toàn bộ các cảnh...";
    const loadedAssets = [];

    for (let i = 0; i < totalScenes; i++) {
      const sc = currentFinanceScenes[i];
      let imgObj = null;
      let audioBuffer = null;

      // Load Image
      if (sc.imageUrl) {
        try {
          const img = new Image();
          img.crossOrigin = "anonymous";
          await new Promise((resolve) => {
            img.onload = () => { imgObj = img; resolve(); };
            img.onerror = () => resolve();
            img.src = sc.imageUrl;
          });
        } catch (_) {}
      }

      // Load & Decode Audio
      if (sc.audioUrl) {
        try {
          const audioFetch = await fetch(sc.audioUrl);
          if (audioFetch.ok) {
            const arrayBuf = await audioFetch.arrayBuffer();
            audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
          }
        } catch (e) {
          console.warn(`Lỗi decode audio cảnh #${i + 1}:`, e);
        }
      }

      loadedAssets.push({
        scene: sc,
        img: imgObj,
        audioBuffer: audioBuffer,
        durationSec: Math.max(3, sc.durationSec || 12)
      });
    }

    // 2. Setup MediaRecorder
    const canvasStream = canvas.captureStream(25);
    const combinedTracks = [...canvasStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()];
    const stream = new MediaStream(combinedTracks);
    const recordedChunks = [];

    let mimeType = "video/webm;codecs=vp9,opus";
    if (MediaRecorder.isTypeSupported("video/mp4;codecs=avc1,mp4a.40.2")) {
      mimeType = "video/mp4;codecs=avc1,mp4a.40.2";
    } else if (MediaRecorder.isTypeSupported("video/mp4")) {
      mimeType = "video/mp4";
    } else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) {
      mimeType = "video/webm;codecs=vp8,opus";
    } else if (MediaRecorder.isTypeSupported("video/webm")) {
      mimeType = "video/webm";
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8000000
    });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    recorder.start(1000);

    // 3. Render từng phân cảnh kèm hiệu ứng Ken Burns và đồng bộ Audio
    const fps = 25;
    for (let i = 0; i < loadedAssets.length; i++) {
      const asset = loadedAssets[i];
      const sc = asset.scene;
      const durationSec = asset.durationSec;
      const totalFrames = Math.round(durationSec * fps);

      st.textContent = `🎬 Đang ghép cảnh #${sc.sceneIndex}/${totalScenes} (${durationSec}s) + Audio thuyết minh vào video...`;
      const overallPct = Math.round(((i) / totalScenes) * 100);
      if (progressFill) progressFill.style.width = overallPct + "%";
      if (progressPct) progressPct.textContent = overallPct + "%";
      if (progressText) progressText.textContent = `Đang render cảnh #${sc.sceneIndex}/${totalScenes} (${durationSec}s)...`;

      // Play audio buffer
      if (asset.audioBuffer) {
        try {
          const source = audioCtx.createBufferSource();
          source.buffer = asset.audioBuffer;
          source.connect(audioDest);
          source.start(0);
        } catch (e) {
          console.warn("Lỗi play audio buffer:", e);
        }
      }

      for (let f = 0; f < totalFrames; f++) {
        const zoom = 1.0 + (f / totalFrames) * 0.06;

        ctx.fillStyle = "#090d16";
        ctx.fillRect(0, 0, 1920, 1080);

        if (asset.img) {
          ctx.save();
          ctx.translate(960, 540);
          ctx.scale(zoom, zoom);
          ctx.translate(-960, -540);

          const scale = Math.max(1920 / asset.img.width, 1080 / asset.img.height);
          const nw = asset.img.width * scale;
          const nh = asset.img.height * scale;
          const nx = (1920 - nw) / 2;
          const ny = (1080 - nh) / 2;
          ctx.drawImage(asset.img, nx, ny, nw, nh);
          ctx.restore();
        } else {
          ctx.fillStyle = "#111827";
          ctx.fillRect(0, 0, 1920, 1080);

          ctx.fillStyle = "#38bdf8";
          ctx.font = "bold 44px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(`Cảnh #${sc.sceneIndex}: ${sc.title}`, 960, 480);

          ctx.font = "28px sans-serif";
          ctx.fillStyle = "#cbd5e1";
          ctx.fillText(`"${sc.voiceText ? sc.voiceText.slice(0, 75) + '...' : ''}"`, 960, 560);
        }

        await new Promise((r) => setTimeout(r, 40));
      }
    }

    if (progressFill) progressFill.style.width = "100%";
    if (progressPct) progressPct.textContent = "100%";
    st.textContent = "💾 Đang đóng gói file video 1080p và xuất file...";

    recorder.stop();
    await new Promise((resolve) => { recorder.onstop = resolve; });
    try { audioCtx.close(); } catch (_) {}

    // 4. Download file
    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(recordedChunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeTopicName = (document.getElementById("finTopic")?.value || "Video_Tai_Chinh").replace(/[^a-zA-Z0-9à-ỹÀ-Ỹ_]/g, "_").slice(0, 30);
    a.href = url;
    a.download = `${safeTopicName}_Hoan_Chinh.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);

    st.className = "status-msg ok";
    st.innerHTML = `🎉 <b>Xuất Video Thành Công!</b> Đã tải file <b>${safeTopicName}_${ext.toUpperCase()}.${ext}</b> về máy. <a href="${url}" target="_blank" download="${safeTopicName}_${ext.toUpperCase()}.${ext}" style="color:var(--accent2); font-weight:800; text-decoration:underline; margin-left:8px;">📥 Bấm vào đây nếu chưa tải</a>`;
    toast("🎉 Đã xuất và tải video hoàn chỉnh kèm âm thanh thành công!", "success");
  } catch (err) {
    console.error("Lỗi ghép video:", err);
    st.className = "status-msg error";
    st.textContent = "❌ Lỗi ghép video: " + err.message;
    toast("Lỗi ghép video: " + err.message, "error");
  } finally {
    btnDl.disabled = false;
    btnDl.textContent = "🎬 Ghép Video Hoàn Chỉnh (.mp4)";
    setTimeout(() => {
      if (progressBox) progressBox.style.display = "none";
    }, 4000);
  }
}

// Bind when DOM ready
document.addEventListener("DOMContentLoaded", () => {
  initFinanceStudio();
});
