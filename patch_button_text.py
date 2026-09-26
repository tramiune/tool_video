import re

file_path = '/Users/qtee/Documents/Tramiune/tool_video/veo3-web-app/src/App.jsx'
with open(file_path, 'r') as f:
    content = f.read()

# Replace for Mẹ Chồng Nàng Dâu card
target_drama = """                  Trải nghiệm ngay
                </button>
              </div>
            </div>

            {/* Card 3: Sumo Deer Tool */}"""

replacement_drama = """                  {currentUserHasDramaAccess ? 'Trải nghiệm ngay' : '🔒 Yêu cầu Gói Đặc Quyền'}
                </button>
              </div>
            </div>

            {/* Card 3: Sumo Deer Tool */}"""

content = content.replace(target_drama, replacement_drama)

# Replace for Sumo card
target_sumo = """                  Trải nghiệm ngay
                </button>
              </div>
            </div>

            {/* Card 4: Fashion Transformation (Thời trang Biến hình) - View Only */}"""

replacement_sumo = """                  {currentUserHasDramaAccess ? 'Trải nghiệm ngay' : '🔒 Yêu cầu Gói Đặc Quyền'}
                </button>
              </div>
            </div>

            {/* Card 4: Fashion Transformation (Thời trang Biến hình) - View Only */}"""

content = content.replace(target_sumo, replacement_sumo)

with open(file_path, 'w') as f:
    f.write(content)

print("Updated Card buttons.")
