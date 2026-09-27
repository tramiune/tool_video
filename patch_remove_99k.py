import re

file_path = '/Users/qtee/Documents/Tramiune/tool_video/veo3-web-app/src/App.jsx'
with open(file_path, 'r') as f:
    content = f.read()

# Delete Standard Plan UI block
start_marker = "{/* Standard Plan */}"
end_marker = "{/* Premium Plan */}"
start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx != -1 and end_idx != -1:
    content = content[:start_idx] + content[end_idx:]

# Remove standard_99k from userTier logic strings
content = content.replace("userTier === 'standard_99k' || ", "")

with open(file_path, 'w') as f:
    f.write(content)

print("Patch applied.")
