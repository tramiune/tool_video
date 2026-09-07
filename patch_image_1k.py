with open("flow-extension/background.js", "r") as f:
    bg = f.read()

# 1. Remove the custom image click bypass
bypass_start = bg.find('// NẾU LÀ ẢNH: Bấm thẳng vào chữ "Tải xuống" (vì không có submenu 720p)')
if bypass_start != -1:
    bypass_end = bg.find('} else {\n', bypass_start)
    if bypass_end != -1:
        bypass_end += len('} else {\n')
        bg = bg[:bypass_start] + bg[bypass_end:]

# 2. Remove the closing `} // end else image`
bg = bg.replace('    } // end else image\n', '')

# 3. Revert `if (mediaType !== 'image' && opt720)` to `if (opt720)`
bg = bg.replace("if (mediaType !== 'image' && opt720)", "if (opt720)")

# 4. Replace 720p checks with 1K checks
bg = bg.replace('t.includes("720p") || t.includes("Kích thước gốc")', 't.includes("720p") || t.includes("1K") || t.includes("Kích thước gốc")')

# Also handle `t.includes("720p") || t.includes("1080p")` in context menus (e.g. `270p|720p|1080p|4K`)
bg = bg.replace('t.includes("720p") || t.includes("1080p")', 't.includes("720p") || t.includes("1K") || t.includes("1080p")')

with open("flow-extension/background.js", "w") as f:
    f.write(bg)
print("done")
